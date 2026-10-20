// Grok Build over ACP (`grok agent stdio`), on the CLI's own grok.com login. Mid-turn input goes
// through xAI's `_x.ai/interject` extension, which queues it into the running turn (Grok reports
// "queued", not when it reached the model). ACP has no system prompt field, and Grok's only
// option replaces its own prompt, so the bot's instructions open the first message of each
// session instead.
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanEnv, findBinary, runQuiet } from "../env.ts";
import { JsonRpcProcess } from "../jsonrpc.ts";
import { isTrusted } from "../mcp-client.ts";
import { grokAnswers, grokQuestion } from "../questions.ts";
import { SessionBase } from "../session-base.ts";
import { toolDetail } from "../tool-detail.ts";
import type { ContextUsage, ModeDef, ModelDef, ProbeResult, RuntimeAdapter, RuntimeCapabilities, RuntimeSession, SendOptions, SendResult, SessionSpec, SlashCommand, TimelineItem, ToolCallDetail, UserInput } from "../types.ts";
import { errorMessage, isRecord, parseSlash, processAlive, resultText } from "../util.ts";

const MODES: ModeDef[] = [
  { id: "ask", label: "Always Ask", description: "Asks before tools Grok wants approved" },
  { id: "always-approve", label: "Never ask", description: "Runs everything without asking" },
];

const INITIALIZE = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  _meta: { startupHints: { nonInteractive: true, skipGitStatus: true, skipProjectLayout: true }, clientType: "pocket-bots", clientVersion: "0.1.0" },
};

export class GrokAdapter implements RuntimeAdapter {
  readonly id = "grok" as const;
  readonly label = "Grok Build";
  // Sub-agents: Grok's task tool (spawn_subagent), on unless GROK_SUBAGENTS=0 or [subagents] enabled = false.
  readonly capabilities: RuntimeCapabilities = { steer: true, steerLands: "after_tool", steerAcceptance: "queued", images: false, subAgents: true, keepsPromptOnResume: false, additionalDirectories: false, liveDirectories: false, reportsCompaction: false, questionTool: "ask_user_question" };
  private readonly options: { binary?: string };
  private modelCache: { at: number; models: ModelDef[] } | null = null;

  constructor(options: { binary?: string } = {}) {
    this.options = options;
  }

  private async binary(): Promise<string | null> {
    return this.options.binary ?? (await findBinary("grok"));
  }

  async probe(): Promise<ProbeResult> {
    const binary = await this.binary();
    if (!binary) return { installed: false, auth: "unknown", diagnostic: "The grok CLI isn't on PATH." };
    const version = (await runQuiet(binary, ["--version"]))?.trim().split(/\s+/)[1];
    const loggedIn = await access(join(homedir(), ".grok", "auth.json")).then(() => true, () => false);
    return { installed: true, ...(version ? { version } : {}), auth: loggedIn ? "ok" : "logged_out", ...(loggedIn ? {} : { diagnostic: "Run `grok` once and sign in." }) };
  }

  async models(): Promise<ModelDef[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.models;
    const binary = await this.binary();
    if (!binary) return [];
    const rpc = new JsonRpcProcess(binary, ["agent", "--no-leader", "stdio"], { cwd: process.cwd(), env: cleanEnv(), jsonrpcField: true });
    try {
      const result = await rpc.request("initialize", INITIALIZE, 30_000);
      const state = result?._meta?.modelState;
      const models: ModelDef[] = (state?.availableModels ?? []).map((model: any) => ({
        id: String(model.modelId),
        label: String(model.name ?? model.modelId),
        ...(model.modelId === state?.currentModelId ? { isDefault: true } : {}),
        thinkingOptions: (model._meta?.reasoningEfforts ?? []).map((effort: any) => ({ id: String(effort.id), label: String(effort.label ?? effort.id), ...(effort.default ? { isDefault: true } : {}) })),
      }));
      this.modelCache = { at: Date.now(), models };
      return models;
    } catch {
      return [];
    } finally {
      rpc.kill();
    }
  }

  modes(): ModeDef[] {
    return MODES;
  }

  async open(spec: SessionSpec): Promise<RuntimeSession> {
    const binary = await this.binary();
    if (!binary) throw new Error("The grok CLI isn't on PATH.");
    const session = new GrokSession(spec);
    await session.start(binary);
    return session;
  }
}

class GrokSession extends SessionBase implements RuntimeSession {
  readonly provider = "grok" as const;
  private readonly spec: SessionSpec;
  private rpc!: JsonRpcProcess;
  private sessionId = "";
  private instructionsSent = false;
  private assistantKey: string | null = null;
  private assistantText = "";
  private reasoningKey: string | null = null;
  private reasoningText = "";
  private readonly tools = new Map<string, { name: string; detail: ToolCallDetail; input: unknown }>();
  private interruptRequested = false;
  private closing = false;
  private readonly approvalAborts = new Set<AbortController>();
  /** From ACP's available_commands_update, which Grok sends soon after the session opens. */
  private available: SlashCommand[] | null = null;
  private availableWaiters: (() => void)[] = [];

  constructor(spec: SessionSpec) {
    super();
    this.spec = spec;
  }

  alive(): boolean | undefined {
    return this.rpc ? processAlive(this.rpc.child) : undefined;
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    if (this.rpc && !this.rpc.exited) this.rpc.child.kill(signal);
  }

  async start(binary: string): Promise<void> {
    const { spec } = this;
    const args = ["agent", "--no-leader", ...(spec.mode === "always-approve" ? ["--always-approve"] : []), "stdio"];
    this.rpc = new JsonRpcProcess(binary, args, { cwd: spec.cwd, env: cleanEnv(spec.env), jsonrpcField: true });
    this.rpc.onNotification((method, params) => {
      if (method === "session/update" && params?.sessionId === this.sessionId) this.update(params.update ?? {});
    });
    this.rpc.onRequest("session/request_permission", (params) => this.permission(params));
    // Its ask_user_question tool asks the client through an ACP extension request.
    this.rpc.onRequest("_x.ai/ask_user_question", (params) => this.question(params));
    this.rpc.onRequest("*", () => ({}));
    this.rpc.onExit((error) => {
      if (this.closing) return;
      if (this.turnId) this.endTurn(this.interruptRequested ? "canceled" : "failed", { error: error ?? "Grok stopped." });
      this.currentState = "closed";
      this.emit({ type: "exited", error: error ?? "Grok stopped." });
    });
    await this.rpc.request("initialize", INITIALIZE, 30_000);
    const mcpServers = Object.entries(spec.mcpServers).map(([name, server]) =>
      server.type === "stdio"
        ? { name, command: server.command, args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value })) }
        : { type: server.type, name, url: server.url, headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ name: key, value })) },
    );
    const model = spec.model && spec.model !== "default" ? spec.model : null;
    const meta = { ...(model ? { modelId: model } : {}) };
    if (spec.resume) {
      try {
        await this.rpc.request("session/resume", { sessionId: spec.resume.sessionId, cwd: spec.cwd, mcpServers, _meta: meta });
      } catch {
        await this.rpc.request("session/load", { sessionId: spec.resume.sessionId, cwd: spec.cwd, mcpServers, _meta: meta });
      }
      this.sessionId = spec.resume.sessionId;
    } else {
      const created = await this.rpc.request("session/new", { cwd: spec.cwd, mcpServers, _meta: meta });
      this.sessionId = String(created.sessionId);
    }
    if (model || spec.thinking) {
      await this.rpc.request("session/set_model", { sessionId: this.sessionId, modelId: model ?? undefined, ...(spec.thinking ? { _meta: { reasoningEffort: spec.thinking } } : {}) }).catch(() => undefined);
    }
    this.currentState = "idle";
    this.setHandle({ provider: "grok", sessionId: this.sessionId });
  }

  async send(input: UserInput, options: SendOptions): Promise<SendResult> {
    if (this.currentState === "closed") return { ok: false, reason: "closed" };
    if (this.turnId) {
      const busy = await this.busySend(input, options);
      if (busy === "steer") {
        try {
          await this.rpc.request("_x.ai/interject", { sessionId: this.sessionId, text: input.text, interjectionId: options.clientMessageId });
        } catch (error) {
          return { ok: false, reason: "steer_unavailable", detail: errorMessage(error) };
        }
        const turnId = this.turnId!;
        this.emit({ type: "item", turnId, key: `user:${options.clientMessageId}`, item: { type: "user_message", text: input.text, clientMessageId: options.clientMessageId } });
        this.emit({ type: "input_accepted", clientMessageId: options.clientMessageId, turnId, as: "steer" });
        return { ok: true, as: "steer", turnId };
      }
      if (busy !== "start") return busy;
    }
    // A command goes as typed; the bot's instructions wait for the next prompt. Grok lists its
    // commands just after the session opens, so a command that is a fresh process's first
    // prompt waits for that list, or it would go out as text with the instructions in front.
    const slash = parseSlash(input.text);
    if (slash !== null && !this.available) await this.commands();
    const turnId = this.beginTurn();
    const command = slash !== null && (this.available ?? []).some((entry) => entry.name === slash.name);
    const text = command || this.instructionsSent || !this.spec.systemPrompt.trim() ? input.text : `<instructions>\n${this.spec.systemPrompt}\n</instructions>\n\n${input.text}`;
    if (!command) this.instructionsSent = true;
    this.emit({ type: "item", turnId, key: `user:${options.clientMessageId}`, item: { type: "user_message", text: input.text, clientMessageId: options.clientMessageId } });
    this.emit({ type: "input_accepted", clientMessageId: options.clientMessageId, turnId, as: "turn" });
    void this.rpc
      .request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }, 6 * 60 * 60_000)
      .then((result) => this.promptEnded(String(result?.stopReason ?? "end_turn"), null))
      .catch((error) => this.promptEnded("error", errorMessage(error)));
    return { ok: true, as: "turn", turnId };
  }

  private promptEnded(stopReason: string, error: string | null): void {
    if (!this.turnId) return;
    const canceled = this.interruptRequested || stopReason === "cancelled";
    this.interruptRequested = false;
    for (const [callId, call] of this.tools) this.item(`tool:${callId}`, { type: "tool_call", callId, name: call.name, status: "canceled", error: null, detail: call.detail });
    this.tools.clear();
    this.assistantKey = null;
    this.reasoningKey = null;
    if (canceled) this.endTurn("canceled", { usage: this.lastUsage ?? {} });
    else if (error || stopReason === "refusal") {
      const message = error ?? "Grok refused this request.";
      this.item(`error:${randomUUID()}`, { type: "error", message });
      this.endTurn("failed", { error: message, usage: this.lastUsage ?? {} });
    } else this.endTurn("completed", { usage: this.lastUsage ?? {} });
  }

  async interrupt(): Promise<{ canceledTurnId: string | null }> {
    if (!this.turnId) return { canceledTurnId: null };
    this.interruptRequested = true;
    for (const controller of this.approvalAborts) controller.abort();
    const ended = this.turnEnded(15_000);
    this.rpc.notify("session/cancel", { sessionId: this.sessionId });
    const canceled = await ended;
    if (!canceled && this.turnId) this.endTurn("canceled");
    return { canceledTurnId: canceled };
  }

  async close(): Promise<void> {
    if (this.currentState === "closed") return;
    this.closing = true;
    if (this.turnId) await this.interrupt();
    this.rpc.kill();
    this.currentState = "closed";
  }

  async commands(): Promise<SlashCommand[]> {
    if (!this.available) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        this.availableWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.available ?? [];
  }

  private item(key: string, item: TimelineItem): void {
    this.emit({ type: "item", turnId: this.turnId, key, item });
  }

  private update(u: any): void {
    switch (u.sessionUpdate) {
      case "available_commands_update": {
        const list: any[] = Array.isArray(u.availableCommands) ? u.availableCommands : [];
        this.available = list.map((entry) => ({ name: String(entry.name ?? ""), description: String(entry.description ?? ""), argumentHint: String(entry.input?.hint ?? ""), kind: "command" as const })).filter((entry) => entry.name);
        for (const waiter of this.availableWaiters.splice(0)) waiter();
        return;
      }
      case "agent_message_chunk": {
        const text = u.content?.type === "text" ? String(u.content.text ?? "") : "";
        if (!text) return;
        if (!this.turnId && this.currentState !== "closed") this.beginTurn();
        if (!this.assistantKey) {
          this.assistantKey = `assistant:${randomUUID()}`;
          this.assistantText = "";
        }
        this.assistantText += text;
        this.item(this.assistantKey, { type: "assistant_message", text: this.assistantText });
        return;
      }
      case "agent_thought_chunk": {
        const text = u.content?.type === "text" ? String(u.content.text ?? "") : "";
        if (!text) return;
        if (!this.reasoningKey) {
          this.reasoningKey = `reasoning:${randomUUID()}`;
          this.reasoningText = "";
        }
        this.reasoningText += text;
        this.item(this.reasoningKey, { type: "reasoning", text: this.reasoningText });
        return;
      }
      case "tool_call":
      case "tool_call_update":
        return this.toolCall(u);
      case "usage_update": {
        const used = Number(u.used ?? u.usedTokens ?? 0);
        const size = Number(u.size ?? u.contextWindow ?? 0);
        if (used || size) {
          this.lastUsage = { ...this.lastUsage, ...(used ? { contextWindowUsedTokens: used } : {}), ...(size ? { contextWindowMaxTokens: size } : {}) } as ContextUsage;
          this.emit({ type: "usage", usage: this.lastUsage });
        }
        return;
      }
      default:
        return;
    }
  }

  private toolCall(u: any): void {
    const callId = String(u.toolCallId ?? randomUUID());
    // Text after a tool call is a new message.
    this.assistantKey = null;
    this.assistantText = "";
    this.reasoningKey = null;
    const known = this.tools.get(callId);
    // The first event often has a generic title (use_tool); updates name the real tool.
    const fresh = toolName(u);
    const specific = /^[\w-]+__[\w-]+$/.test(String(u.title ?? "")) || (u.kind && u.kind !== "other");
    const name = specific || !known ? fresh : known.name;
    const input = u.rawInput ?? known?.input;
    const status: string = u.status ?? (known ? "in_progress" : "pending");
    const output = u.rawOutput !== undefined ? resultText(isRecord(u.rawOutput) && "content" in u.rawOutput ? u.rawOutput.content : u.rawOutput) : contentText(u.content);
    const done = status === "completed" || status === "failed";
    const detail = done ? toolDetail(name, input ?? locationInput(u), { text: output }) : (known?.detail ?? toolDetail(name, input ?? locationInput(u)));
    this.tools.set(callId, { name, detail, input });
    const canceled = status === "failed" && this.interruptRequested;
    this.item(`tool:${callId}`, { type: "tool_call", callId, name, status: canceled ? "canceled" : status === "completed" ? "completed" : status === "failed" ? "failed" : "running", error: status === "failed" && !canceled ? output || "The tool failed." : null, detail });
    if (done) this.tools.delete(callId);
  }

  private async permission(params: any): Promise<unknown> {
    const call = params.toolCall ?? {};
    const options: { optionId: string; kind: string }[] = params.options ?? [];
    const pick = (kinds: string[]) => options.find((option) => kinds.includes(option.kind)) ?? null;
    const name = toolName(call);
    const mcp = /^(?:mcp__)?(.+?)__(.+)$/.exec(String(call.title ?? ""));
    if (mcp && isTrusted(this.spec.trustedTools, mcp[1]!, mcp[2]!)) {
      const allow = pick(["allow_once", "allow_always"]);
      return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    const controller = new AbortController();
    this.approvalAborts.add(controller);
    try {
      const input = call.rawInput ?? locationInput(call);
      const decision = await this.spec.approvals({ id: String(call.toolCallId ?? randomUUID()), provider: "grok", name, kind: "tool", ...(call.title ? { title: String(call.title) } : {}), input: isRecord(input) ? input : {}, detail: toolDetail(name, input) }, controller.signal);
      const option = decision.behavior === "allow" ? pick(decision.remember ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"]) : pick(["reject_once", "reject_always"]);
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    } catch {
      return { outcome: { outcome: "cancelled" } };
    } finally {
      this.approvalAborts.delete(controller);
    }
  }

  private async question(params: any): Promise<unknown> {
    if (params?.sessionId && params.sessionId !== this.sessionId) return { outcome: "cancelled" };
    const controller = new AbortController();
    this.approvalAborts.add(controller);
    try {
      return grokAnswers(params, await this.spec.approvals(grokQuestion(params), controller.signal));
    } catch {
      return { outcome: "cancelled" };
    } finally {
      this.approvalAborts.delete(controller);
    }
  }
}

/** A tool's name from an ACP tool call: an MCP tool's title, or its kind. */
function toolName(call: any): string {
  const title = String(call.title ?? "");
  if (/^[\w-]+__[\w-]+$/.test(title)) return title;
  switch (call.kind) {
    case "execute":
      return "shell";
    case "read":
      return "read";
    case "edit":
      return "edit";
    case "delete":
      return "delete";
    case "search":
      return "grep";
    case "fetch":
      return "fetch";
    default: {
      const first = title.split(/[\s(`]/)[0] || "tool";
      return first === "run_terminal_command" ? "shell" : first;
    }
  }
}

function locationInput(call: any): Record<string, unknown> | undefined {
  const path = call.locations?.[0]?.path;
  return path ? { path } : undefined;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "content" ? resultText([part.content]) : part?.type === "diff" ? `--- ${part.path}\n${part.newText ?? ""}` : ""))
    .filter(Boolean)
    .join("\n");
}
