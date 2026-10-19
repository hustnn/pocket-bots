// Claude through the Claude Agent SDK, pointed at the installed `claude` so it runs on that CLI's
// own claude.ai login (personal use only; see docs/design.md §1.4). Steering pushes a user message
// with priority "next"; Claude Code absorbs it once the running tool call returns, and reports
// that through command_lifecycle frames, which become input_accepted.
import { randomUUID } from "node:crypto";
import { query, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { cleanEnv, findBinary, runQuiet } from "../env.ts";
import { claudeAnswered } from "../questions.ts";
import { SessionBase } from "../session-base.ts";
import { toolDetail } from "../tool-detail.ts";
import type {
  ApprovalRequest,
  ContextUsage,
  ModeDef,
  ModelDef,
  ProbeResult,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeSession,
  SendOptions,
  SendResult,
  SessionSpec,
  SlashCommand,
  TimelineItem,
  UserInput,
} from "../types.ts";
import { AsyncQueue, errorMessage, isRecord, resultText, str } from "../util.ts";

const MODES: ModeDef[] = [
  { id: "default", label: "Always Ask", description: "Asks before running commands and editing files" },
  { id: "acceptEdits", label: "Accept File Edits", description: "Edits files without asking; asks before commands" },
  { id: "auto", label: "Auto", description: "Claude decides what needs asking" },
  { id: "plan", label: "Plan", description: "Plans first and asks before making changes" },
  { id: "bypassPermissions", label: "Bypass", description: "Never asks" },
];

const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High", isDefault: true },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];

const MODELS: ModelDef[] = [
  { id: "default", label: "Default", isDefault: true, thinkingOptions: EFFORTS },
  { id: "claude-fable-5-1", label: "Fable 5.1", thinkingOptions: EFFORTS },
  { id: "claude-opus-5-5", label: "Opus 5.5", thinkingOptions: EFFORTS },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", thinkingOptions: EFFORTS },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", thinkingOptions: EFFORTS },
];

export class ClaudeAdapter implements RuntimeAdapter {
  readonly id = "claude" as const;
  readonly label = "Claude";
  readonly capabilities: RuntimeCapabilities = { steer: true, steerLands: "after_tool", steerAcceptance: "delivered", images: true, subAgents: true, keepsPromptOnResume: true, reportsCompaction: true, questionTool: "AskUserQuestion" };

  private readonly options: { binary?: string };

  constructor(options: { binary?: string } = {}) {
    this.options = options;
  }

  private async binary(): Promise<string | null> {
    return this.options.binary ?? (await findBinary("claude"));
  }

  async probe(): Promise<ProbeResult> {
    const binary = await this.binary();
    if (!binary) return { installed: false, auth: "unknown", diagnostic: "The claude CLI isn't on PATH." };
    const version = (await runQuiet(binary, ["--version"]))?.trim().split(/\s+/)[0];
    const status = await runQuiet(binary, ["auth", "status"]);
    let auth: ProbeResult["auth"] = "unknown";
    try {
      auth = status ? (JSON.parse(status.slice(status.indexOf("{"), status.lastIndexOf("}") + 1)).loggedIn ? "ok" : "logged_out") : "unknown";
    } catch {
      auth = "unknown";
    }
    return { installed: true, ...(version ? { version } : {}), auth, ...(auth === "logged_out" ? { diagnostic: "Run `claude` once and log in." } : {}) };
  }

  async models(): Promise<ModelDef[]> {
    return MODELS;
  }

  modes(): ModeDef[] {
    return MODES;
  }

  async open(spec: SessionSpec): Promise<RuntimeSession> {
    const binary = await this.binary();
    if (!binary) throw new Error("The claude CLI isn't on PATH.");
    return new ClaudeSession(spec, binary);
  }
}

interface Pending {
  clientMessageId: string;
  text: string;
  /** Whether this message opened its turn (a prompt) or joined one (a steer). */
  as: "turn" | "steer";
}

interface StreamBlock {
  type: "text" | "thinking";
  text: string;
  key: string;
  matched: boolean;
}

class ClaudeSession extends SessionBase implements RuntimeSession {
  readonly provider = "claude" as const;
  private input = new AsyncQueue<SDKUserMessage>();
  private query: Query;
  private pending = new Map<string, Pending>();
  private streams = new Map<string, StreamBlock[]>();
  private tools = new Map<string, { name: string; input: unknown }>();
  private interruptRequested = false;
  private closing = false;
  private loop: Promise<void>;

  private readonly spec: SessionSpec;

  constructor(spec: SessionSpec, binary: string) {
    super();
    this.spec = spec;
    if (spec.resume) this.resumeHandle = spec.resume;
    this.query = query({ prompt: this.input, options: this.options(binary) });
    this.currentState = "idle";
    this.loop = this.consume();
  }

  private options(binary: string): Options {
    const { spec } = this;
    const mcpServers: NonNullable<Options["mcpServers"]> = {};
    for (const [name, server] of Object.entries(spec.mcpServers)) {
      const trusted = spec.trustedTools.some((entry) => entry === name || entry.startsWith(`${name}/`));
      mcpServers[name] =
        server.type === "stdio"
          ? { type: "stdio", command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}) }
          : { type: server.type, url: server.url, ...(server.headers ? { headers: server.headers } : {}), ...(trusted ? { alwaysLoad: true } : {}) };
    }
    const effort = spec.thinking && EFFORTS.some((e) => e.id === spec.thinking) ? (spec.thinking as Options["effort"]) : undefined;
    return {
      pathToClaudeCodeExecutable: binary,
      cwd: spec.cwd,
      env: cleanEnv({ ...spec.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false", DISABLE_AUTOUPDATER: "1" }),
      ...(spec.model && spec.model !== "default" ? { model: spec.model } : {}),
      ...(effort ? { effort } : {}),
      permissionMode: (spec.mode ?? "default") as Options["permissionMode"],
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: spec.systemPrompt },
      settingSources: [],
      includePartialMessages: true,
      mcpServers,
      allowedTools: spec.trustedTools.map((entry) => `mcp__${entry.replace("/", "__")}`),
      ...(spec.extraDirectories?.length ? { additionalDirectories: spec.extraDirectories } : {}),
      ...(spec.resume ? { resume: spec.resume.sessionId } : {}),
      canUseTool: (name, input, context) => this.approve(name, input, context),
      stderr: () => {},
    };
  }

  private async approve(name: string, input: Record<string, unknown>, context: { signal: AbortSignal; toolUseID?: string; title?: string; description?: string; suggestions?: unknown[] }) {
    const kind: ApprovalRequest["kind"] = name === "ExitPlanMode" ? "plan" : name === "AskUserQuestion" ? "question" : "tool";
    const request: ApprovalRequest = {
      id: context.toolUseID ?? randomUUID(),
      provider: "claude",
      name,
      kind,
      ...(context.title ? { title: context.title } : {}),
      ...(context.description ? { description: context.description } : {}),
      input,
      detail: toolDetail(name, input),
    };
    try {
      const decision = await this.spec.approvals(request, context.signal);
      if (decision.behavior === "allow") {
        return {
          behavior: "allow" as const,
          // AskUserQuestion reads its answers keyed by question text.
          updatedInput: kind === "question" ? claudeAnswered(input, decision) : (decision.updatedInput ?? input),
          ...(decision.remember && context.suggestions ? { updatedPermissions: context.suggestions as never } : {}),
        };
      }
      return { behavior: "deny" as const, message: decision.message ?? "The user declined this.", ...(decision.interrupt ? { interrupt: true } : {}) };
    } catch (error) {
      return { behavior: "deny" as const, message: errorMessage(error) };
    }
  }

  async send(input: UserInput, options: SendOptions): Promise<SendResult> {
    if (this.currentState === "closed") return { ok: false, reason: "closed" };
    let as: "turn" | "steer" = "turn";
    if (this.turnId) {
      const busy = await this.busySend(input, options);
      if (busy === "steer") as = "steer";
      else if (busy !== "start") return busy;
    }
    const uuid = randomUUID();
    this.pending.set(uuid, { clientMessageId: options.clientMessageId, text: input.text, as });
    const content = input.images?.length
      ? [...input.images.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mimeType as "image/png", data: image.data } })), { type: "text" as const, text: input.text }]
      : input.text;
    const message = { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid, ...(as === "steer" ? { priority: "next" } : {}) } as unknown as SDKUserMessage;
    const turnId = as === "turn" ? this.beginTurn() : this.turnId!;
    this.input.push(message);
    return { ok: true, as, turnId };
  }

  /** The Agent SDK runs Claude Code's process and keeps it to itself: its liveness is unknown (its exit ends the session through the SDK), and closing the query is how it's stopped. */
  kill(_signal: "SIGTERM" | "SIGKILL"): void {
    try {
      this.query.close();
    } catch {
      // already gone
    }
  }

  /** Claude Code's own commands, custom commands and skills; sent as text, Claude Code runs them. */
  async commands(): Promise<SlashCommand[]> {
    const commands = await this.query.supportedCommands();
    return commands.filter((command) => !command.name.startsWith("__")).map((command) => ({ name: command.name, description: command.description, argumentHint: command.argumentHint, kind: "command" }));
  }

  async interrupt(): Promise<{ canceledTurnId: string | null }> {
    if (!this.turnId) return { canceledTurnId: null };
    this.interruptRequested = true;
    const ended = this.turnEnded(15_000);
    try {
      await this.query.interrupt();
    } catch {
      // A process that already exited ends the turn through the loop.
    }
    const canceledTurnId = await ended;
    if (canceledTurnId === null && this.turnId) this.endTurn("canceled");
    return { canceledTurnId: canceledTurnId ?? null };
  }

  async close(): Promise<void> {
    if (this.currentState === "closed") return;
    this.closing = true;
    if (this.turnId) await this.interrupt();
    this.input.end();
    try {
      this.query.close();
    } catch {
      // already gone
    }
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    this.currentState = "closed";
  }

  private item(key: string, item: TimelineItem): void {
    this.emit({ type: "item", turnId: this.turnId, key, item });
  }

  /** Output that arrives with no turn running is Claude continuing on its own (a background task finished). */
  private ensureTurn(): void {
    if (!this.turnId && this.currentState !== "closed") this.beginTurn();
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query) this.dispatch(message as unknown as Record<string, any>);
      if (!this.closing) this.fail("Claude Code stopped.");
    } catch (error) {
      if (!this.closing) this.fail(errorMessage(error));
    } finally {
      this.currentState = "closed";
    }
  }

  private fail(error: string): void {
    if (this.turnId) this.endTurn(this.interruptRequested ? "canceled" : "failed", { error });
    this.interruptRequested = false;
    this.currentState = "closed";
    this.emit({ type: "exited", error });
  }

  private dispatch(m: Record<string, any>): void {
    switch (m.type) {
      case "system":
        if (m.subtype === "init" && typeof m.session_id === "string") this.setHandle({ provider: "claude", sessionId: m.session_id });
        else if (m.subtype === "compact_boundary") {
          this.ensureTurn();
          this.item(`compaction:${m.uuid ?? randomUUID()}`, { type: "compaction", status: "completed", trigger: m.compact_metadata?.trigger === "manual" ? "manual" : "auto", ...(typeof m.compact_metadata?.pre_tokens === "number" ? { preTokens: m.compact_metadata.pre_tokens } : {}) });
        }
        return;
      case "command_lifecycle":
        return this.lifecycle(String(m.command_uuid), String(m.state));
      case "stream_event":
        return this.streamEvent(m);
      case "assistant":
        return this.assistant(m);
      case "user":
        return this.toolResults(m);
      case "result":
        return this.result(m);
      default:
        return;
    }
  }

  private lifecycle(uuid: string, state: string): void {
    const pending = this.pending.get(uuid);
    if (!pending) return;
    if (state === "started") {
      // A steer Claude only reached after the turn ended starts a turn of its own.
      let as = pending.as;
      if (!this.turnId) {
        this.beginTurn();
        as = "turn";
      }
      this.item(`user:${pending.clientMessageId}`, { type: "user_message", text: pending.text, clientMessageId: pending.clientMessageId });
      this.emit({ type: "input_accepted", clientMessageId: pending.clientMessageId, turnId: this.turnId!, as });
    }
    if (state === "completed" || state === "cancelled") this.pending.delete(uuid);
  }

  private streamEvent(m: Record<string, any>): void {
    if (m.parent_tool_use_id) return;
    const event = m.event ?? {};
    const messageId: string | undefined = m.message_id ?? event.message?.id ?? this.lastStreamMessage;
    if (event.type === "message_start" && event.message?.id) {
      this.lastStreamMessage = event.message.id;
      return;
    }
    if (!messageId) return;
    if (event.type === "content_block_start" && (event.content_block?.type === "text" || event.content_block?.type === "thinking")) {
      this.ensureTurn();
      const blocks = this.streams.get(messageId) ?? [];
      blocks[event.index] = { type: event.content_block.type, text: "", key: `${messageId}:${event.index}`, matched: false };
      this.streams.set(messageId, blocks);
    } else if (event.type === "content_block_delta") {
      const block = this.streams.get(messageId)?.[event.index];
      if (!block) return;
      const delta = event.delta?.type === "text_delta" ? event.delta.text : event.delta?.type === "thinking_delta" ? event.delta.thinking : null;
      if (typeof delta !== "string" || !delta) return;
      block.text += delta;
      this.item(block.key, block.type === "text" ? { type: "assistant_message", text: block.text, messageId } : { type: "reasoning", text: block.text });
    }
  }

  private lastStreamMessage: string | undefined;

  /** The streamed block a final block continues, so its timeline item keeps one key. */
  private keyFor(messageId: string, type: "text" | "thinking", index: number): string {
    const block = this.streams.get(messageId)?.find((candidate) => candidate && candidate.type === type && !candidate.matched);
    if (block) {
      block.matched = true;
      return block.key;
    }
    return `${messageId}:final:${index}:${randomUUID().slice(0, 8)}`;
  }

  private assistant(m: Record<string, any>): void {
    if (m.parent_tool_use_id) return;
    this.ensureTurn();
    const message = m.message ?? {};
    const messageId: string = message.id ?? randomUUID();
    const content: any[] = Array.isArray(message.content) ? message.content : [];
    content.forEach((block, index) => {
      if (block.type === "text" && block.text) this.item(this.keyFor(messageId, "text", index), { type: "assistant_message", text: block.text, messageId });
      else if (block.type === "thinking" && block.thinking) this.item(this.keyFor(messageId, "thinking", index), { type: "reasoning", text: block.thinking });
      else if (block.type === "tool_use") {
        this.tools.set(block.id, { name: block.name, input: block.input });
        this.item(`tool:${block.id}`, { type: "tool_call", callId: block.id, name: block.name, status: "running", error: null, detail: toolDetail(block.name, block.input) });
      }
    });
    const usage = message.usage;
    if (isRecord(usage)) {
      const used = Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
      if (used > 0) {
        this.lastUsage = { ...this.lastUsage, contextWindowUsedTokens: used };
        this.emit({ type: "usage", usage: this.lastUsage });
      }
    }
  }

  private toolResults(m: Record<string, any>): void {
    if (m.parent_tool_use_id) return;
    const content: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      const call = this.tools.get(block.tool_use_id);
      if (!call) continue;
      const text = resultText(block.content);
      const failed = block.is_error === true;
      // A call cut off by Stop comes back as an error; it was canceled, not broken.
      const canceled = failed && this.interruptRequested;
      const exitCode = isRecord(m.tool_use_result) && typeof m.tool_use_result.exitCode === "number" ? m.tool_use_result.exitCode : undefined;
      this.item(`tool:${block.tool_use_id}`, {
        type: "tool_call",
        callId: block.tool_use_id,
        name: call.name,
        status: canceled ? "canceled" : failed ? "failed" : "completed",
        error: failed && !canceled ? text : null,
        detail: toolDetail(call.name, call.input, { text, ...(exitCode !== undefined ? { exitCode } : {}) }),
      });
      this.tools.delete(block.tool_use_id);
    }
  }

  private result(m: Record<string, any>): void {
    const usage: ContextUsage = {};
    if (isRecord(m.usage)) {
      usage.inputTokens = Number(m.usage.input_tokens ?? 0);
      usage.outputTokens = Number(m.usage.output_tokens ?? 0);
      usage.cachedInputTokens = Number(m.usage.cache_read_input_tokens ?? 0);
    }
    if (typeof m.total_cost_usd === "number") usage.totalCostUsd = m.total_cost_usd;
    if (isRecord(m.modelUsage)) {
      const windows = Object.values(m.modelUsage).map((entry) => (isRecord(entry) ? Number(entry.contextWindow ?? 0) : 0));
      const max = Math.max(0, ...windows);
      if (max > 0) usage.contextWindowMaxTokens = max;
    }
    if (this.lastUsage?.contextWindowUsedTokens) usage.contextWindowUsedTokens = this.lastUsage.contextWindowUsedTokens;
    // Calls still open when the turn ends were cut off.
    for (const [callId, call] of this.tools) {
      this.item(`tool:${callId}`, { type: "tool_call", callId, name: call.name, status: "canceled", error: null, detail: toolDetail(call.name, call.input) });
    }
    this.tools.clear();
    this.streams.clear();
    const canceled = this.interruptRequested;
    this.interruptRequested = false;
    if (!this.turnId) return;
    if (canceled) this.endTurn("canceled", { usage });
    else if (m.subtype === "success" && !m.is_error) this.endTurn("completed", { usage });
    else {
      const error = str(m.result) || (Array.isArray(m.errors) ? m.errors.join("; ") : "") || String(m.subtype ?? "Claude reported an error");
      this.item(`error:${randomUUID()}`, { type: "error", message: error });
      this.endTurn("failed", { usage, error });
    }
  }
}
