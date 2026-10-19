// Pi through `pi --mode rpc`, on Pi's own logins and providers, with an extension of ours that
//  - registers the session's MCP servers (pi.registerMcpServer, Pi 1.x), and
//  - asks before bash/edit/write through ctx.ui.select, which RPC mode turns into an
//    extension_ui_request this adapter answers, so Pi gets the same approvals as every runtime.
// Steers use the RPC `steer` command and land after the running tool calls.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv, findBinary, runQuiet } from "../env.ts";
import { SessionBase } from "../session-base.ts";
import { toolDetail } from "../tool-detail.ts";
import type { ContextUsage, ModeDef, ModelDef, ProbeResult, RuntimeAdapter, RuntimeCapabilities, RuntimeSession, SendOptions, SendResult, SessionSpec, SlashCommand, TimelineItem, UserInput } from "../types.ts";
import { errorMessage, isRecord, parseSlash, processAlive, resultText } from "../util.ts";

const MODES: ModeDef[] = [
  { id: "ask", label: "Always Ask", description: "Asks before running commands and changing files" },
  { id: "ask-commands", label: "Ask for commands", description: "Changes files without asking; asks before commands" },
  { id: "never", label: "Never ask", description: "Runs everything without asking" },
];

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id, ...(id === "medium" ? { isDefault: true } : {}) }));
const APPROVAL_PREFIX = "pocket-bots-approval:";

const EXTENSION = `// Written by pocket-bots: MCP servers and approvals for this Pi session.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const servers = JSON.parse(process.env.BOTS_PI_MCP ?? "{}");
  const trusted: string[] = JSON.parse(process.env.BOTS_PI_TRUSTED ?? "[]");
  const mode = process.env.BOTS_PI_MODE ?? "ask";
  const always = new Set<string>();
  const register = (pi as any).registerMcpServer;
  if (typeof register === "function") {
    for (const [name, config] of Object.entries(servers)) register.call(pi, name, { ...(config as object), exposure: "direct" });
  }
  pi.on("tool_call", async (event: any, ctx: any) => {
    const name = String(event.toolName);
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    if (mcp) {
      if (trusted.includes(mcp[1]) || trusted.includes(mcp[1] + "/" + mcp[2])) return undefined;
    } else {
      if (mode === "never") return undefined;
      const changes = name === "edit" || name === "write";
      if (name !== "bash" && !changes) return undefined;
      if (changes && mode === "ask-commands") return undefined;
    }
    const key = name + ":" + JSON.stringify(event.input ?? {});
    if (always.has(key)) return undefined;
    const answer = await ctx.ui.select("${APPROVAL_PREFIX}" + JSON.stringify({ id: event.toolCallId, tool: name, input: event.input ?? {} }), ["Allow", "Allow always", "Deny"]);
    if (answer === "Allow always") always.add(key);
    if (answer === "Allow" || answer === "Allow always") return undefined;
    return { block: true, reason: "The user declined this." };
  });
}
`;

const COMPACT: SlashCommand = { name: "compact", description: "Summarize the conversation to free up context", argumentHint: "[what to focus on]", kind: "command" };

function extensionPath(): string {
  const dir = join(tmpdir(), "pocket-bots-pi");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "pocket-bots.ts");
  writeFileSync(path, EXTENSION);
  return path;
}

export class PiAdapter implements RuntimeAdapter {
  readonly id = "pi" as const;
  readonly label = "Pi";
  // Pi has no sub-agent tool of its own (pi-subagents is an extension a user may or may not load).
  readonly capabilities: RuntimeCapabilities = { steer: true, steerLands: "after_tool", steerAcceptance: "delivered", images: true, subAgents: false, keepsPromptOnResume: false, reportsCompaction: true };
  private readonly options: { binary?: string };

  constructor(options: { binary?: string } = {}) {
    this.options = options;
  }

  private async binary(): Promise<string | null> {
    return this.options.binary ?? (await findBinary("pi"));
  }

  async probe(): Promise<ProbeResult> {
    const binary = await this.binary();
    if (!binary) return { installed: false, auth: "unknown", diagnostic: "The pi CLI isn't on PATH." };
    const version = (await runQuiet(binary, ["--version"]))?.trim().split(/\s+/).pop();
    const models = await this.models();
    return {
      installed: true,
      ...(version ? { version } : {}),
      auth: models.length ? "unknown" : "logged_out",
      ...(models.length ? {} : { diagnostic: "Pi lists no models. Run `pi` and use /login, or set up a provider." }),
    };
  }

  async models(): Promise<ModelDef[]> {
    const binary = await this.binary();
    if (!binary) return [];
    const output = (await runQuiet(binary, ["--list-models"], 20_000)) ?? "";
    const models: ModelDef[] = [];
    for (const line of output.split("\n").slice(1)) {
      const [provider, model] = line.trim().split(/\s+/);
      if (!provider || !model || provider === "provider") continue;
      models.push({ id: `${provider}/${model}`, label: `${model} (${provider})`, thinkingOptions: THINKING });
    }
    if (models[0]) models[0].isDefault = true;
    return models;
  }

  modes(): ModeDef[] {
    return MODES;
  }

  async open(spec: SessionSpec): Promise<RuntimeSession> {
    const binary = await this.binary();
    if (!binary) throw new Error("The pi CLI isn't on PATH.");
    const session = new PiSession(spec, binary);
    await session.ready();
    return session;
  }
}

class PiSession extends SessionBase implements RuntimeSession {
  readonly provider = "pi" as const;
  private readonly spec: SessionSpec;
  private readonly child: ChildProcess;
  private buffer = "";
  private readonly waiters = new Map<string, (response: any) => void>();
  private readonly steers: { clientMessageId: string; text: string }[] = [];
  private assistantKey: string | null = null;
  private assistantText = "";
  private reasoningText = "";
  private readonly tools = new Map<string, { name: string; args: unknown }>();
  private interruptRequested = false;
  private turnError: string | null = null;
  private closing = false;
  private readonly approvalAborts = new Set<AbortController>();
  /** Pi answered our prompt (or compact) or started a run: it has the turn. */
  private runtimeTurn = false;

  constructor(spec: SessionSpec, binary: string) {
    super();
    this.spec = spec;
    // `--session-id` opens the session with that id if it exists: a new session needs an id of its
    // own, or a chat that starts over (its session can't be resumed) would load the old one again.
    const sessionId = spec.resume?.sessionId ?? `bots-${spec.key}-${randomUUID().slice(0, 8)}`;
    const promptDir = join(tmpdir(), "pocket-bots-pi", "prompts");
    mkdirSync(promptDir, { recursive: true });
    const promptFile = join(promptDir, `${sessionId}.md`);
    writeFileSync(promptFile, spec.systemPrompt);
    const mcp: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(spec.mcpServers)) {
      mcp[name] = server.type === "stdio" ? { command: server.command, args: server.args ?? [], env: server.env ?? {} } : { url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
    }
    const args = ["--mode", "rpc", "--session-id", sessionId, "-e", extensionPath(), "--append-system-prompt", promptFile, "--no-context-files"];
    // Extra extensions (tests use this to add a scripted model provider).
    for (const extra of (spec.env?.BOTS_PI_EXTENSIONS ?? "").split(",").filter(Boolean)) args.push("-e", extra);
    if (spec.model && spec.model !== "default") args.push("--model", spec.model);
    if (spec.thinking) args.push("--thinking", spec.thinking);
    this.child = spawn(binary, args, {
      cwd: spec.cwd,
      env: cleanEnv({ ...spec.env, BOTS_PI_MCP: JSON.stringify(mcp), BOTS_PI_TRUSTED: JSON.stringify(spec.trustedTools), BOTS_PI_MODE: spec.mode ?? "ask" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr!.on("data", () => {});
    this.child.on("exit", (code) => {
      for (const waiter of this.waiters.values()) waiter({ success: false, error: "Pi stopped." });
      this.waiters.clear();
      if (this.closing) return;
      if (this.turnId) this.endTurn(this.interruptRequested ? "canceled" : "failed", { error: `Pi stopped (exit ${code}).` });
      this.currentState = "closed";
      this.emit({ type: "exited", error: `Pi stopped (exit ${code}).` });
    });
    this.resumeHandle = { provider: "pi", sessionId };
  }

  /** Whether Pi shows a turn, from its RPC: a prompt it took, or a run it started. */
  get liveTurn(): boolean {
    return this.runtimeTurn;
  }

  alive(): boolean | undefined {
    return processAlive(this.child);
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.child.kill(signal);
  }

  protected override endTurn(outcome: "completed" | "failed" | "canceled", extra: { usage?: ContextUsage; error?: string } = {}): void {
    this.runtimeTurn = false;
    super.endTurn(outcome, extra);
  }

  async ready(): Promise<void> {
    const state = await this.command({ type: "get_state" }, 30_000);
    if (!state?.success) throw new Error(`Pi didn't start: ${state?.error ?? "no answer"}`);
    this.currentState = "idle";
    this.emit({ type: "session_ready", handle: this.resumeHandle! });
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type === "response" && record.id && this.waiters.has(record.id)) {
        this.waiters.get(record.id)!(record);
        this.waiters.delete(record.id);
      } else {
        try {
          this.event(record);
        } catch (error) {
          console.error("runtime(pi): handling an event failed", error);
        }
      }
    }
  }

  private write(record: Record<string, unknown>): void {
    if (this.child.stdin?.writable) this.child.stdin.write(JSON.stringify(record) + "\n");
  }

  private command(command: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
    const id = randomUUID();
    this.write({ id, ...command });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve({ success: false, error: "timed out" });
      }, timeoutMs);
      this.waiters.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  async send(input: UserInput, options: SendOptions): Promise<SendResult> {
    if (this.currentState === "closed") return { ok: false, reason: "closed" };
    const images = (input.images ?? []).map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
    if (this.turnId) {
      const busy = await this.busySend(input, options);
      if (busy === "steer") {
        const response = await this.command({ type: "steer", message: input.text, ...(images.length ? { images } : {}) });
        if (!response?.success) return { ok: false, reason: "steer_unavailable", detail: response?.error };
        this.steers.push({ clientMessageId: options.clientMessageId, text: input.text });
        return { ok: true, as: "steer", turnId: this.turnId };
      }
      if (busy !== "start") return busy;
    }
    const turnId = this.beginTurn();
    this.turnError = null;
    this.runtimeTurn = false;
    const slash = parseSlash(input.text);
    if (slash?.name === "compact") return this.compact(turnId, slash.args, input.text, options);
    const response = await this.command({ type: "prompt", message: input.text, ...(images.length ? { images } : {}) });
    if (!response?.success) {
      // A turn given up meanwhile (abandonTurn) isn't this one to end.
      if (this.turnId === turnId) this.endTurn("failed", { error: response?.error ?? "Pi didn't take the message." });
      return { ok: false, reason: "error", detail: response?.error };
    }
    if (this.turnId === turnId) this.runtimeTurn = true;
    this.emit({ type: "item", turnId, key: `user:${options.clientMessageId}`, item: { type: "user_message", text: input.text, clientMessageId: options.clientMessageId } });
    this.emit({ type: "input_accepted", clientMessageId: options.clientMessageId, turnId, as: "turn" });
    if (response.data?.disposition === "handled" && this.turnId === turnId) this.endTurn("completed");
    return { ok: true, as: "turn", turnId };
  }

  /** Pi's extension commands, prompt templates and skills (all run through `prompt`), plus /compact. */
  async commands(): Promise<SlashCommand[]> {
    const response = await this.command({ type: "get_commands" }, 10_000);
    const list: any[] = response?.success && Array.isArray(response.data?.commands) ? response.data.commands : [];
    return [
      COMPACT,
      ...list
        .filter((entry) => entry?.name && !String(entry.sourceInfo?.path ?? "").includes("pocket-bots-pi"))
        .map((entry): SlashCommand => ({ name: String(entry.name), description: String(entry.description ?? ""), argumentHint: "", kind: entry.source === "skill" ? "skill" : "command" })),
    ];
  }

  /** /compact is an RPC of its own; the turn lasts until the summary is written. */
  private compact(turnId: string, focus: string, text: string, options: SendOptions): SendResult {
    this.runtimeTurn = true;
    this.emit({ type: "item", turnId, key: `user:${options.clientMessageId}`, item: { type: "user_message", text, clientMessageId: options.clientMessageId } });
    this.emit({ type: "input_accepted", clientMessageId: options.clientMessageId, turnId, as: "turn" });
    void this.command({ type: "compact", ...(focus ? { customInstructions: focus } : {}) }, 30 * 60_000).then((response) => {
      if (this.turnId !== turnId) return;
      if (response?.success) this.endTurn("completed");
      else {
        const error = String(response?.error ?? "Pi couldn't compact the conversation.");
        this.item(`error:${randomUUID()}`, { type: "error", message: error });
        this.endTurn("failed", { error });
      }
    });
    return { ok: true, as: "turn", turnId };
  }

  async interrupt(): Promise<{ canceledTurnId: string | null }> {
    if (!this.turnId) return { canceledTurnId: null };
    this.interruptRequested = true;
    for (const controller of this.approvalAborts) controller.abort();
    const ended = this.turnEnded(15_000);
    await this.command({ type: "abort" }, 15_000);
    const canceled = await ended;
    if (!canceled && this.turnId) this.endTurn("canceled");
    return { canceledTurnId: canceled };
  }

  async close(): Promise<void> {
    if (this.currentState === "closed") return;
    this.closing = true;
    if (this.turnId) await this.interrupt();
    this.child.stdin?.end();
    setTimeout(() => this.child.kill("SIGTERM"), 3_000).unref();
    this.currentState = "closed";
  }

  private item(key: string, item: TimelineItem): void {
    this.emit({ type: "item", turnId: this.turnId, key, item });
  }

  private event(e: any): void {
    switch (e.type) {
      case "agent_start":
        if (!this.turnId && this.currentState !== "closed") this.beginTurn();
        if (this.turnId) this.runtimeTurn = true;
        return;
      case "message_start": {
        const role = e.message?.role;
        if (role === "user") {
          const text = textOf(e.message.content);
          const index = this.steers.findIndex((steer) => text.includes(steer.text) || steer.text.includes(text));
          if (index >= 0 && this.turnId) {
            const [steer] = this.steers.splice(index, 1);
            this.item(`user:${steer!.clientMessageId}`, { type: "user_message", text: steer!.text, clientMessageId: steer!.clientMessageId });
            this.emit({ type: "input_accepted", clientMessageId: steer!.clientMessageId, turnId: this.turnId, as: "steer" });
          }
        } else if (role === "assistant") {
          this.assistantKey = `assistant:${randomUUID()}`;
          this.assistantText = "";
          this.reasoningText = "";
        }
        return;
      }
      case "message_update": {
        const update = e.assistantMessageEvent ?? {};
        if (!this.assistantKey) this.assistantKey = `assistant:${randomUUID()}`;
        if (update.type === "text_delta" && update.delta) {
          this.assistantText += update.delta;
          this.item(`${this.assistantKey}:text`, { type: "assistant_message", text: this.assistantText });
        } else if (update.type === "thinking_delta" && update.delta) {
          this.reasoningText += update.delta;
          this.item(`${this.assistantKey}:thinking`, { type: "reasoning", text: this.reasoningText });
        }
        return;
      }
      case "message_end": {
        const message = e.message ?? {};
        if (message.role !== "assistant") return;
        const key = this.assistantKey ?? `assistant:${randomUUID()}`;
        const text = textOf(message.content);
        const thinking = (Array.isArray(message.content) ? message.content : []).filter((block: any) => block?.type === "thinking").map((block: any) => block.thinking ?? "").join("\n");
        if (thinking) this.item(`${key}:thinking`, { type: "reasoning", text: thinking });
        if (text) this.item(`${key}:text`, { type: "assistant_message", text });
        if (isRecord(message.usage)) {
          const usage = message.usage;
          const next: ContextUsage = { inputTokens: Number(usage.input ?? 0), outputTokens: Number(usage.output ?? 0), cachedInputTokens: Number(usage.cacheRead ?? 0), contextWindowUsedTokens: Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.output ?? 0) };
          this.lastUsage = { ...this.lastUsage, ...next };
          this.emit({ type: "usage", usage: this.lastUsage });
        }
        if (message.stopReason === "error" && !this.interruptRequested) this.turnError = String(message.errorMessage ?? "The model request failed.");
        this.assistantKey = null;
        return;
      }
      case "tool_execution_start":
        this.tools.set(e.toolCallId, { name: e.toolName, args: e.args });
        this.item(`tool:${e.toolCallId}`, { type: "tool_call", callId: e.toolCallId, name: e.toolName, status: "running", error: null, detail: toolDetail(e.toolName, e.args) });
        return;
      case "tool_execution_end": {
        const call = this.tools.get(e.toolCallId) ?? { name: e.toolName, args: undefined };
        this.tools.delete(e.toolCallId);
        const text = resultText(e.result?.content ?? e.result);
        const canceled = e.isError && this.interruptRequested;
        this.item(`tool:${e.toolCallId}`, { type: "tool_call", callId: e.toolCallId, name: call.name, status: canceled ? "canceled" : e.isError ? "failed" : "completed", error: e.isError && !canceled ? text : null, detail: toolDetail(call.name, call.args, { text }) });
        return;
      }
      case "compaction_start":
        this.item(`compaction:${this.turnId}`, { type: "compaction", status: "loading", trigger: e.reason === "manual" ? "manual" : "auto" });
        return;
      case "compaction_end": {
        // A result is a success; no result and not aborted is a
        // failure (the summary request didn't fit the model, or failed), which ends the turn failed.
        const trigger = e.reason === "manual" ? "manual" : "auto";
        if (e.result !== undefined && e.result !== null) this.item(`compaction:${this.turnId}`, { type: "compaction", status: "completed", trigger });
        else if (e.aborted) this.item(`compaction:${this.turnId}`, { type: "compaction", status: "canceled", trigger });
        else {
          const error = String(e.errorMessage ?? "").trim() || "Context compaction failed.";
          this.item(`compaction:${this.turnId}`, { type: "compaction", status: "failed", trigger, error });
          if (!this.interruptRequested) this.turnError ??= `Context compaction failed: ${error}`;
        }
        return;
      }
      case "agent_settled": {
        if (!this.turnId) return;
        const canceled = this.interruptRequested;
        this.interruptRequested = false;
        for (const [callId, call] of this.tools) this.item(`tool:${callId}`, { type: "tool_call", callId, name: call.name, status: "canceled", error: null, detail: toolDetail(call.name, call.args) });
        this.tools.clear();
        if (canceled) this.endTurn("canceled", { usage: this.lastUsage ?? {} });
        else if (this.turnError) {
          this.item(`error:${randomUUID()}`, { type: "error", message: this.turnError });
          this.endTurn("failed", { error: this.turnError, usage: this.lastUsage ?? {} });
        } else this.endTurn("completed", { usage: this.lastUsage ?? {} });
        this.turnError = null;
        return;
      }
      case "extension_ui_request":
        void this.uiRequest(e);
        return;
      default:
        return;
    }
  }

  private async uiRequest(e: any): Promise<void> {
    const dialog = ["select", "confirm", "input", "editor"].includes(e.method);
    if (!dialog) return;
    const title = String(e.title ?? "");
    if (e.method !== "select" || !title.startsWith(APPROVAL_PREFIX)) {
      this.write({ type: "extension_ui_response", id: e.id, cancelled: true });
      return;
    }
    let payload: { id?: string; tool?: string; input?: Record<string, unknown> } = {};
    try {
      payload = JSON.parse(title.slice(APPROVAL_PREFIX.length));
    } catch {
      payload = {};
    }
    const tool = String(payload.tool ?? "tool");
    const controller = new AbortController();
    this.approvalAborts.add(controller);
    try {
      const decision = await this.spec.approvals(
        { id: String(payload.id ?? e.id), provider: "pi", name: tool, kind: "tool", input: payload.input ?? {}, detail: toolDetail(tool, payload.input) },
        controller.signal,
      );
      this.write({ type: "extension_ui_response", id: e.id, value: decision.behavior === "allow" ? (decision.remember ? "Allow always" : "Allow") : "Deny" });
    } catch (error) {
      this.write({ type: "extension_ui_response", id: e.id, value: "Deny" });
      console.error("runtime(pi): approval failed", errorMessage(error));
    } finally {
      this.approvalAborts.delete(controller);
    }
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text ?? "")
    .join("");
}
