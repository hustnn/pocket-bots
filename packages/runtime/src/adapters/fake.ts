// A scripted runtime for tests: no CLI, no model. A script turns each turn's input into steps:
// say something, call a tool on one of the session's MCP servers, wait (steers that arrive during
// a wait join the turn and are passed to the rest of the script), emit any timeline item (a
// compaction, say), or ask for an approval (a question, say: its decision, as JSON, is the step's
// result). A script that throws fails the turn with its message.
import { randomUUID } from "node:crypto";
import { SessionBase } from "../session-base.ts";
import type { ApprovalRequest, ModeDef, ModelDef, ProbeResult, RuntimeAdapter, RuntimeCapabilities, RuntimeSession, SendOptions, SendResult, SessionSpec, SlashCommand, TimelineItem, UserInput } from "../types.ts";
import { errorMessage } from "../util.ts";

export type FakeStep =
  | { say: string }
  | { tool: string; server?: string; args: Record<string, unknown> }
  | { wait: number }
  | { emit: TimelineItem }
  | { ask: Omit<ApprovalRequest, "id" | "provider"> & { id?: string } };

export interface FakeTurn {
  /** The text of the message that started the turn. */
  text: string;
  /** Steers that have joined the turn so far. */
  steers: string[];
  spec: SessionSpec;
  /** Results of this turn's tool calls so far, in order. */
  results: string[];
}

/** Returns the turn's next step, or null to end the turn. */
export type FakeScript = (turn: FakeTurn, step: number) => FakeStep | null;

export const echoScript: FakeScript = (turn, step) => (step === 0 ? { say: `echo: ${turn.text}` } : null);

export class FakeAdapter implements RuntimeAdapter {
  readonly id = "fake" as const;
  readonly label = "Test runtime";
  readonly capabilities: RuntimeCapabilities = { steer: true, steerLands: "after_tool", steerAcceptance: "delivered", images: false, subAgents: false, keepsPromptOnResume: false, additionalDirectories: false, liveDirectories: false, reportsCompaction: true };
  readonly sessions: FakeSession[] = [];

  script: FakeScript;
  /** What its sessions list as slash commands. */
  commandList: SlashCommand[] = [];
  /** Awaited before each session opens: a slow start, or one that never finishes. */
  beforeOpen: ((spec: SessionSpec) => Promise<void>) | null = null;
  /** What new sessions start with (see FakeSession's test seams). */
  sessionDefaults: Partial<Pick<FakeSession, "silent" | "reportsTurns" | "processAlive">> = {};

  constructor(script: FakeScript = echoScript) {
    this.script = script;
  }

  async probe(): Promise<ProbeResult> {
    return { installed: true, version: "0", auth: "ok" };
  }
  async models(): Promise<ModelDef[]> {
    return [{ id: "fake-1", label: "Fake", isDefault: true }];
  }
  modes(): ModeDef[] {
    return [{ id: "default", label: "Default" }];
  }
  async open(spec: SessionSpec): Promise<RuntimeSession> {
    if (this.beforeOpen) await this.beforeOpen(spec);
    const session = new FakeSession(spec, (turn, step) => this.script(turn, step), () => this.commandList);
    Object.assign(session, this.sessionDefaults);
    this.sessions.push(session);
    return session;
  }
}

export class FakeSession extends SessionBase implements RuntimeSession {
  readonly provider = "fake" as const;
  private steers: { text: string; clientMessageId: string }[] = [];
  private canceled = false;
  private wake: (() => void) | null = null;
  /** Ends a waiting approval: the turn was interrupted. */
  private abortAsk: (() => void) | null = null;

  readonly spec: SessionSpec;
  private readonly script: FakeScript;
  private readonly listCommands: () => SlashCommand[];

  // Test seams for supervision.
  /** A send starts a turn the runtime shows nothing of (a CLI stuck on a login prompt, or a turn it never started). */
  silent = false;
  /** Shows its turns as the runtime's own (liveTurn, as Codex and Pi do); a silent session never takes one. */
  reportsTurns = false;
  /** What alive() says. */
  processAlive: boolean | undefined = undefined;
  /** The signals kill() got; a kill ends the "process" (unless it's already gone). */
  readonly kills: string[] = [];
  private runtimeTurn = false;
  /** SessionSpec.extraDirectories, until setExtraDirectories replaces them (a test turns liveDirectories on to have it called). */
  directories: string[];

  constructor(spec: SessionSpec, script: FakeScript, listCommands: () => SlashCommand[] = () => []) {
    super();
    this.spec = spec;
    this.script = script;
    this.listCommands = listCommands;
    this.directories = spec.extraDirectories ?? [];
    this.currentState = "idle";
    queueMicrotask(() => this.setHandle(spec.resume ?? { provider: "fake", sessionId: randomUUID() }));
  }

  async commands(): Promise<SlashCommand[]> {
    return this.listCommands();
  }

  setExtraDirectories(directories: string[]): void {
    this.directories = [...directories];
  }

  get liveTurn(): boolean | undefined {
    return this.reportsTurns ? this.runtimeTurn : undefined;
  }

  /** The runtime stops showing its turn, which goes on for us (a turn end it never sent). */
  forgetTurn(): void {
    this.runtimeTurn = false;
  }

  alive(): boolean | undefined {
    return this.processAlive;
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.kills.push(signal);
    if (this.currentState === "closed") return;
    if (this.processAlive !== false) this.processAlive = false;
    this.wake?.();
    if (this.turnId) this.endTurn("failed", { error: "The test runtime stopped." });
    this.currentState = "closed";
    this.emit({ type: "exited", error: "The test runtime stopped." });
  }

  protected override endTurn(outcome: "completed" | "failed" | "canceled", extra: { usage?: { inputTokens?: number; outputTokens?: number }; error?: string } = {}): void {
    this.runtimeTurn = false;
    super.endTurn(outcome, extra);
  }

  async send(input: UserInput, options: SendOptions): Promise<SendResult> {
    if (this.currentState === "closed") return { ok: false, reason: "closed" };
    if (this.turnId) {
      const busy = await this.busySend(input, options);
      if (busy === "steer") {
        this.steers.push({ text: input.text, clientMessageId: options.clientMessageId });
        return { ok: true, as: "steer", turnId: this.turnId };
      }
      if (busy !== "start") return busy;
    }
    const turnId = this.beginTurn();
    if (this.silent) return { ok: true, as: "turn", turnId };
    this.runtimeTurn = true;
    void this.run(turnId, input.text, options.clientMessageId);
    return { ok: true, as: "turn", turnId };
  }

  async interrupt(): Promise<{ canceledTurnId: string | null }> {
    const turnId = this.turnId;
    if (!turnId) return { canceledTurnId: null };
    // Nothing runs a silent session's turn: it just ends.
    if (this.silent) {
      this.endTurn("canceled");
      return { canceledTurnId: turnId };
    }
    this.canceled = true;
    this.wake?.();
    this.abortAsk?.();
    await this.turnEnded(5_000);
    return { canceledTurnId: turnId };
  }

  async close(): Promise<void> {
    if (this.turnId) await this.interrupt();
    this.currentState = "closed";
  }

  private takeSteers(turn: FakeTurn, turnId: string): void {
    for (const steer of this.steers.splice(0)) {
      turn.steers.push(steer.text);
      this.emit({ type: "item", turnId, key: `user:${steer.clientMessageId}`, item: { type: "user_message", text: steer.text, clientMessageId: steer.clientMessageId } });
      this.emit({ type: "input_accepted", clientMessageId: steer.clientMessageId, turnId, as: "steer" });
    }
  }

  private async run(turnId: string, text: string, clientMessageId: string): Promise<void> {
    this.canceled = false;
    this.emit({ type: "item", turnId, key: `user:${clientMessageId}`, item: { type: "user_message", text, clientMessageId } });
    this.emit({ type: "input_accepted", clientMessageId, turnId, as: "turn" });
    const turn: FakeTurn = { text, steers: [], spec: this.spec, results: [] };
    try {
      for (let index = 0; ; index++) {
        if (this.canceled) return this.endTurn("canceled");
        this.takeSteers(turn, turnId);
        const step = this.script(turn, index);
        if (!step) break;
        if ("say" in step) {
          this.emit({ type: "item", turnId, key: `say:${turnId}:${index}`, item: { type: "assistant_message", text: step.say } });
        } else if ("emit" in step) {
          this.emit({ type: "item", turnId, key: `${step.emit.type}:${turnId}:${index}`, item: step.emit });
        } else if ("ask" in step) {
          const controller = new AbortController();
          this.abortAsk = () => controller.abort();
          const { id, ...request } = step.ask;
          const decision = await this.spec.approvals({ id: id ?? `ask-${turnId}-${index}`, provider: "fake", ...request }, controller.signal);
          this.abortAsk = null;
          turn.results.push(JSON.stringify(decision));
        } else if ("wait" in step) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, step.wait);
            this.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          this.wake = null;
        } else {
          const callId = `call-${turnId}-${index}`;
          const name = `mcp__${step.server ?? "bots"}__${step.tool}`;
          this.emit({ type: "item", turnId, key: `tool:${callId}`, item: { type: "tool_call", callId, name, status: "running", error: null, detail: { type: "unknown", input: step.args, output: null } } });
          let output: string;
          let failed = false;
          try {
            output = await this.callTool(step.server ?? "bots", step.tool, step.args);
          } catch (error) {
            output = errorMessage(error);
            failed = true;
          }
          turn.results.push(output);
          this.emit({ type: "item", turnId, key: `tool:${callId}`, item: { type: "tool_call", callId, name, status: failed ? "failed" : "completed", error: failed ? output : null, detail: { type: "unknown", input: step.args, output } } });
        }
      }
      this.takeSteers(turn, turnId);
      this.endTurn(this.canceled ? "canceled" : "completed", { usage: { inputTokens: 1, outputTokens: 1 } });
    } catch (error) {
      this.endTurn("failed", { error: errorMessage(error) });
    }
  }

  /** Calls a tool on one of the session's http MCP servers (stateless JSON-RPC). */
  private async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const config = this.spec.mcpServers[server];
    if (!config || config.type !== "http") throw new Error(`No http MCP server "${server}"`);
    const response = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(config.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
    const body = (await response.json()) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    const text = (body.result?.content ?? []).map((part) => part.text ?? "").join("\n");
    if (body.result?.isError) throw new Error(text);
    return text;
  }
}
