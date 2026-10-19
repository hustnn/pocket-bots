// Codex through `codex app-server` (JSON-RPC over stdio), on the CLI's own ChatGPT login.
// The protocol is still marked experimental by Codex; we opt into its experimental API for
// dynamic tools. Steers use turn/steer, which lands at Codex's next model step.
import { randomUUID } from "node:crypto";
import { cleanEnv, findBinary, runQuiet } from "../env.ts";
import { JsonRpcProcess } from "../jsonrpc.ts";
import { callMcpTool, isTrusted, listMcpTools } from "../mcp-client.ts";
import { codexAnswers, codexQuestion } from "../questions.ts";
import { SessionBase } from "../session-base.ts";
import { toolDetail } from "../tool-detail.ts";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ContextUsage,
  McpServerConfig,
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
  ToolCallStatus,
  UserInput,
} from "../types.ts";
import { clip, errorMessage, isRecord, parseSlash, processAlive, resultText } from "../util.ts";

const COMPACT: SlashCommand = { name: "compact", description: "Summarize the conversation to free up context", argumentHint: "", kind: "command" };

const MODES: (ModeDef & { sandbox: string; approvalPolicy: string })[] = [
  { id: "auto", label: "Auto", description: "Works in its folder; asks before going outside it", sandbox: "workspace-write", approvalPolicy: "on-request" },
  { id: "read-only", label: "Read only", description: "Reads only; asks before changing anything", sandbox: "read-only", approvalPolicy: "on-request" },
  { id: "untrusted", label: "Always Ask", description: "Asks before every command that isn't known to be safe", sandbox: "workspace-write", approvalPolicy: "untrusted" },
  { id: "full-access", label: "Full access", description: "Never asks", sandbox: "danger-full-access", approvalPolicy: "never" },
];

const CLIENT_INFO = { name: "pocket-bots", title: "pocket-bots", version: "0.1.0" };

async function connect(binary: string, cwd: string, env: Record<string, string>): Promise<JsonRpcProcess> {
  const rpc = new JsonRpcProcess(binary, ["app-server"], { cwd, env, jsonrpcField: false });
  await rpc.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true, requestAttestation: false } }, 30_000);
  rpc.notify("initialized", {});
  return rpc;
}

export class CodexAdapter implements RuntimeAdapter {
  readonly id = "codex" as const;
  readonly label = "Codex";
  // Sub-agents: spawn_agent, from Codex's multi_agent feature (stable, on by default). No questionTool:
  // request_user_input is only offered in plan mode (default_mode_request_user_input is under development).
  readonly capabilities: RuntimeCapabilities = { steer: true, steerLands: "next_step", steerAcceptance: "delivered", images: true, subAgents: true, keepsPromptOnResume: true, reportsCompaction: true };
  private readonly options: { binary?: string };
  private modelCache: { at: number; models: ModelDef[] } | null = null;

  constructor(options: { binary?: string } = {}) {
    this.options = options;
  }

  private async binary(): Promise<string | null> {
    return this.options.binary ?? (await findBinary("codex"));
  }

  async probe(): Promise<ProbeResult> {
    const binary = await this.binary();
    if (!binary) return { installed: false, auth: "unknown", diagnostic: "The codex CLI isn't on PATH." };
    const version = (await runQuiet(binary, ["--version"]))?.trim().split(/\s+/).pop();
    const status = (await runQuiet(binary, ["login", "status"])) ?? "";
    const auth = /logged in/i.test(status) ? "ok" : /not logged in/i.test(status) ? "logged_out" : "unknown";
    return { installed: true, ...(version ? { version } : {}), auth, ...(auth === "logged_out" ? { diagnostic: "Run `codex login`." } : {}) };
  }

  async models(): Promise<ModelDef[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.models;
    const binary = await this.binary();
    if (!binary) return [];
    let rpc: JsonRpcProcess | null = null;
    try {
      rpc = await connect(binary, process.cwd(), cleanEnv());
      const result = await rpc.request("model/list", { limit: 100 }, 30_000);
      const models: ModelDef[] = (result?.data ?? [])
        .filter((model: any) => !model.hidden)
        .map((model: any, index: number) => ({
          id: String(model.model ?? model.id),
          label: String(model.displayName ?? model.model),
          ...(model.isDefault || index === 0 ? { isDefault: index === 0 } : {}),
          thinkingOptions: (model.supportedReasoningEfforts ?? []).map((option: any) => ({ id: String(option.reasoningEffort), label: String(option.reasoningEffort), ...(option.reasoningEffort === model.defaultReasoningEffort ? { isDefault: true } : {}) })),
        }));
      this.modelCache = { at: Date.now(), models };
      return models;
    } catch {
      return [];
    } finally {
      rpc?.kill();
    }
  }

  modes(): ModeDef[] {
    return MODES.map(({ id, label, description }) => ({ id, label, ...(description ? { description } : {}) }));
  }

  async open(spec: SessionSpec): Promise<RuntimeSession> {
    const binary = await this.binary();
    if (!binary) throw new Error("The codex CLI isn't on PATH.");
    const session = new CodexSession(spec);
    await session.start(binary);
    return session;
  }
}

interface DynamicTool {
  server: string;
  tool: string;
}

class CodexSession extends SessionBase implements RuntimeSession {
  readonly provider = "codex" as const;
  private readonly spec: SessionSpec;
  private rpc!: JsonRpcProcess;
  private threadId = "";
  /** Codex's id for the running turn (ours is SessionBase.turnId). */
  private codexTurnId: string | null = null;
  /** Codex answered our turn/start (or thread/compact/start): it has the turn. */
  private turnAccepted = false;
  private turnStartedWaiters: ((codexTurnId: string) => void)[] = [];
  private readonly dynamic = new Map<string, DynamicTool>();
  private readonly pendingInputs = new Map<string, { clientMessageId: string; text: string; as: "turn" | "steer" }>();
  private readonly texts = new Map<string, string>();
  private interruptRequested = false;
  private closing = false;
  /** Enabled skills by name, from the last skills/list. */
  private skills = new Map<string, string>();
  /** The turn a /compact is running in. */
  private compactTurn: string | null = null;

  constructor(spec: SessionSpec) {
    super();
    this.spec = spec;
  }

  /** liveTurn for Codex: a turn it accepted, or one it says started. */
  get liveTurn(): boolean {
    return this.turnAccepted || this.codexTurnId !== null;
  }

  alive(): boolean | undefined {
    return this.rpc ? processAlive(this.rpc.child) : undefined;
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    if (this.rpc && !this.rpc.exited) this.rpc.child.kill(signal);
  }

  protected override endTurn(outcome: "completed" | "failed" | "canceled", extra: { usage?: ContextUsage; error?: string } = {}): void {
    this.turnAccepted = false;
    super.endTurn(outcome, extra);
  }

  /** /compact, and the skills Codex finds for this folder (run as `$name`, with the skill attached). */
  async commands(): Promise<SlashCommand[]> {
    const response: any = await this.rpc.request("skills/list", { cwds: [this.spec.cwd] }).catch(() => null);
    const skills: any[] = (response?.data ?? []).flatMap((entry: any) => (Array.isArray(entry?.skills) ? entry.skills : []));
    this.skills = new Map(skills.filter((skill) => skill?.enabled !== false && skill?.name && skill?.path).map((skill) => [String(skill.name), String(skill.path)]));
    const listed = skills.filter((skill) => this.skills.has(String(skill?.name)));
    return [COMPACT, ...listed.map((skill): SlashCommand => ({ name: String(skill.name), description: String(skill.description ?? skill.shortDescription ?? ""), argumentHint: "", kind: "skill" }))];
  }

  async start(binary: string): Promise<void> {
    const { spec } = this;
    this.rpc = await connect(binary, spec.cwd, cleanEnv(spec.env));
    this.rpc.onNotification((method, params) => this.notification(method, params));
    this.rpc.onRequest("item/commandExecution/requestApproval", (params) => this.approveCommand(params));
    this.rpc.onRequest("item/fileChange/requestApproval", (params) => this.approveFileChange(params));
    this.rpc.onRequest("item/permissions/requestApproval", (params) => this.approveOther("permissions", params));
    this.rpc.onRequest("mcpServer/elicitation/request", (params) => this.approveElicitation(params));
    this.rpc.onRequest("item/tool/call", (params) => this.callDynamic(params));
    // request_user_input (plan mode): a question for the user.
    this.rpc.onRequest("item/tool/requestUserInput", async (params) => codexAnswers(params, await this.ask(codexQuestion(params))));
    this.rpc.onRequest("*", () => ({}));
    this.rpc.onExit((error) => {
      if (this.closing) return;
      if (this.turnId) this.endTurn(this.interruptRequested ? "canceled" : "failed", { error: error ?? "Codex stopped." });
      this.currentState = "closed";
      this.emit({ type: "exited", ...(error ? { error } : {}) });
    });

    const mode = MODES.find((candidate) => candidate.id === spec.mode) ?? MODES[0]!;
    const mcpServers: Record<string, unknown> = {};
    const dynamicTools: unknown[] = [];
    for (const [name, server] of Object.entries(spec.mcpServers)) {
      if (spec.hostedMcpServers?.includes(name)) {
        const tools = await listMcpTools(server).catch(() => []);
        for (const tool of tools) {
          const toolName = `${name}_${tool.name}`;
          this.dynamic.set(toolName, { server: name, tool: tool.name });
          dynamicTools.push({ type: "function", name: toolName, description: tool.description, inputSchema: tool.inputSchema });
        }
        continue;
      }
      mcpServers[name] = codexMcpConfig(server);
    }
    const common = {
      cwd: spec.cwd,
      ...(spec.model && spec.model !== "default" ? { model: spec.model } : {}),
      approvalPolicy: mode.approvalPolicy,
      sandbox: mode.sandbox,
      developerInstructions: spec.systemPrompt,
      config: { mcp_servers: mcpServers },
    };
    let response: any;
    if (spec.resume) {
      response = await this.rpc.request("thread/resume", { threadId: spec.resume.sessionId, ...common });
    } else {
      response = await this.rpc.request("thread/start", { ...common, dynamicTools });
    }
    this.threadId = String(response?.thread?.id ?? spec.resume?.sessionId);
    this.currentState = "idle";
    this.setHandle({ provider: "codex", sessionId: this.threadId });
  }

  async send(input: UserInput, options: SendOptions): Promise<SendResult> {
    if (this.currentState === "closed") return { ok: false, reason: "closed" };
    const slash = parseSlash(input.text);
    const skillPath = slash ? this.skills.get(slash.name) : undefined;
    const content = [
      ...(slash && skillPath ? [{ type: "skill", name: slash.name, path: skillPath }] : []),
      { type: "text", text: slash && skillPath ? `$${slash.name}${slash.args ? ` ${slash.args}` : ""}` : input.text, text_elements: [] },
      ...(input.images ?? []).map((image) => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` })),
    ];
    if (this.turnId) {
      const busy = await this.busySend(input, options);
      if (busy === "steer") {
        const codexTurnId = this.codexTurnId ?? (await this.codexTurnStarted(10_000));
        if (!codexTurnId) return { ok: false, reason: "steer_unavailable", detail: "Codex hasn't started the turn yet." };
        try {
          await this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: codexTurnId, clientUserMessageId: options.clientMessageId, input: content });
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
    const turnId = this.beginTurn();
    this.codexTurnId = null;
    this.turnAccepted = false;
    if (slash?.name === "compact") return this.compact(turnId, input.text, options);
    this.pendingInputs.set(options.clientMessageId, { clientMessageId: options.clientMessageId, text: input.text, as: "turn" });
    try {
      await this.rpc.request("turn/start", { threadId: this.threadId, clientUserMessageId: options.clientMessageId, input: content, ...(this.spec.thinking ? { effort: this.spec.thinking } : {}) });
    } catch (error) {
      // A turn given up meanwhile (abandonTurn) isn't this one to end.
      if (this.turnId === turnId) this.endTurn("failed", { error: errorMessage(error) });
      return { ok: false, reason: "error", detail: errorMessage(error) };
    }
    if (this.turnId === turnId) this.turnAccepted = true;
    return { ok: true, as: "turn", turnId };
  }

  /** Compaction runs as a turn of Codex's own; it's accepted once Codex starts it. */
  private async compact(turnId: string, text: string, options: SendOptions): Promise<SendResult> {
    this.compactTurn = turnId;
    try {
      await this.rpc.request("thread/compact/start", { threadId: this.threadId });
    } catch (error) {
      this.compactTurn = null;
      if (this.turnId === turnId) this.endTurn("failed", { error: errorMessage(error) });
      return { ok: false, reason: "error", detail: errorMessage(error) };
    }
    if (this.turnId === turnId) this.turnAccepted = true;
    this.item(`user:${options.clientMessageId}`, { type: "user_message", text, clientMessageId: options.clientMessageId });
    this.emit({ type: "input_accepted", clientMessageId: options.clientMessageId, turnId, as: "turn" });
    return { ok: true, as: "turn", turnId };
  }

  private codexTurnStarted(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.turnStartedWaiters.push((id) => {
        clearTimeout(timer);
        resolve(id);
      });
    });
  }

  async interrupt(): Promise<{ canceledTurnId: string | null }> {
    if (!this.turnId) return { canceledTurnId: null };
    this.interruptRequested = true;
    const ended = this.turnEnded(15_000);
    const codexTurnId = this.codexTurnId ?? (await this.codexTurnStarted(5_000));
    if (codexTurnId) await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: codexTurnId }).catch(() => undefined);
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

  // ---------------------------------------------------------------- notifications

  private item(key: string, item: TimelineItem): void {
    this.emit({ type: "item", turnId: this.turnId, key, item });
  }

  private notification(method: string, params: any): void {
    switch (method) {
      case "turn/started": {
        this.codexTurnId = params.turn?.id ?? null;
        if (!this.turnId) this.beginTurn();
        if (this.codexTurnId) for (const waiter of this.turnStartedWaiters.splice(0)) waiter(this.codexTurnId);
        return;
      }
      case "turn/completed": {
        const status = params.turn?.status;
        const canceled = this.interruptRequested || status === "interrupted";
        this.interruptRequested = false;
        this.codexTurnId = null;
        this.texts.clear();
        if (canceled) this.endTurn("canceled", { usage: this.lastUsage ?? {} });
        else if (status === "failed") {
          const error = params.turn?.error?.message ?? "Codex reported an error.";
          this.item(`error:${randomUUID()}`, { type: "error", message: error });
          this.endTurn("failed", { error, usage: this.lastUsage ?? {} });
        } else this.endTurn("completed", { usage: this.lastUsage ?? {} });
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage;
        const last = usage?.last;
        const next: ContextUsage = {
          inputTokens: usage?.total?.inputTokens,
          outputTokens: usage?.total?.outputTokens,
          cachedInputTokens: usage?.total?.cachedInputTokens,
          ...(last ? { contextWindowUsedTokens: Number(last.inputTokens ?? 0) + Number(last.outputTokens ?? 0) } : {}),
          ...(usage?.modelContextWindow ? { contextWindowMaxTokens: usage.modelContextWindow } : {}),
        };
        this.lastUsage = { ...this.lastUsage, ...next };
        this.emit({ type: "usage", usage: this.lastUsage });
        return;
      }
      case "item/agentMessage/delta": {
        const text = (this.texts.get(params.itemId) ?? "") + String(params.delta ?? "");
        this.texts.set(params.itemId, text);
        this.item(`msg:${params.itemId}`, { type: "assistant_message", text, messageId: params.itemId });
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const key = `reasoning:${params.itemId}`;
        const text = (this.texts.get(key) ?? "") + String(params.delta ?? "");
        this.texts.set(key, text);
        this.item(key, { type: "reasoning", text });
        return;
      }
      case "item/started":
      case "item/completed":
        return this.threadItem(params.item ?? {}, method === "item/completed");
      case "thread/compacted": {
        const manual = this.compactTurn !== null && this.compactTurn === this.turnId;
        this.item(`compaction:${randomUUID()}`, { type: "compaction", status: "completed", trigger: manual ? "manual" : "auto" });
        // Without a turn of its own, the compaction is the whole of the /compact turn.
        if (manual && !this.codexTurnId) {
          this.compactTurn = null;
          this.endTurn("completed", { usage: this.lastUsage ?? {} });
        }
        return;
      }
      case "error":
        if (params?.error?.message && !params?.willRetry) this.item(`error:${randomUUID()}`, { type: "error", message: String(params.error.message) });
        return;
      default:
        return;
    }
  }

  private threadItem(item: any, done: boolean): void {
    const id = String(item.id ?? randomUUID());
    const status = (raw: unknown, failed = false): ToolCallStatus => (failed ? "failed" : !done ? "running" : raw === "failed" || raw === "declined" ? "failed" : "completed");
    switch (item.type) {
      case "userMessage": {
        const pending = (item.clientId ? this.pendingInputs.get(item.clientId) : undefined) ?? (done ? undefined : [...this.pendingInputs.values()][0]);
        if (pending && this.turnId) {
          this.pendingInputs.delete(pending.clientMessageId);
          this.item(`user:${pending.clientMessageId}`, { type: "user_message", text: pending.text, clientMessageId: pending.clientMessageId });
          this.emit({ type: "input_accepted", clientMessageId: pending.clientMessageId, turnId: this.turnId, as: pending.as });
        }
        return;
      }
      case "agentMessage":
        if (done && item.text) this.item(`msg:${id}`, { type: "assistant_message", text: String(item.text), messageId: id });
        return;
      case "reasoning": {
        const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n\n");
        if (done && text) this.item(`reasoning:${id}`, { type: "reasoning", text });
        return;
      }
      case "commandExecution": {
        const failed = done && typeof item.exitCode === "number" && item.exitCode !== 0;
        const detail = toolDetail("shell", { command: item.command, cwd: item.cwd }, done ? { text: String(item.aggregatedOutput ?? ""), exitCode: item.exitCode ?? null } : undefined);
        const canceled = done && this.interruptRequested && item.status !== "completed";
        this.item(`tool:${id}`, { type: "tool_call", callId: id, name: "shell", status: canceled ? "canceled" : status(item.status, failed), error: failed ? clip(String(item.aggregatedOutput ?? ""), 2_000) : null, detail });
        return;
      }
      case "fileChange": {
        const changes: any[] = item.changes ?? [];
        const first = changes[0];
        const detail = first
          ? first.kind?.type === "add"
            ? { type: "write" as const, filePath: String(first.path) }
            : { type: "edit" as const, filePath: String(first.path), ...(first.diff ? { unifiedDiff: String(first.diff) } : {}) }
          : { type: "unknown" as const, input: null, output: null };
        this.item(`tool:${id}`, { type: "tool_call", callId: id, name: changes.length > 1 ? `apply_patch (${changes.length} files)` : "apply_patch", status: status(item.status), error: null, detail });
        return;
      }
      case "mcpToolCall": {
        const output = item.result ? resultText(item.result.content) : item.error?.message;
        this.item(`tool:${id}`, {
          type: "tool_call",
          callId: id,
          name: `mcp__${item.server}__${item.tool}`,
          status: status(item.status, done && !!item.error),
          error: item.error?.message ?? null,
          detail: { type: "unknown", input: item.arguments ?? null, output: output ?? null },
        });
        return;
      }
      case "dynamicToolCall": {
        const output = (item.contentItems ?? []).map((part: any) => part.text ?? "").join("\n");
        this.item(`tool:${id}`, { type: "tool_call", callId: id, name: String(item.tool), status: status(item.status, done && item.success === false), error: done && item.success === false ? output : null, detail: { type: "unknown", input: item.arguments ?? null, output: done ? output : null } });
        return;
      }
      case "webSearch":
        this.item(`tool:${id}`, { type: "tool_call", callId: id, name: "web_search", status: status(item.status), error: null, detail: { type: "search", query: String(item.query ?? ""), toolName: "web_search" } });
        return;
      case "plan":
        if (done && item.text) this.item(`plan:${id}`, { type: "assistant_message", text: String(item.text), messageId: id });
        return;
      case "contextCompaction":
        this.item(`compaction:${id}`, { type: "compaction", status: done ? "completed" : "loading", trigger: "auto" });
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- requests from Codex

  private async ask(request: ApprovalRequest): Promise<ApprovalDecision> {
    const controller = new AbortController();
    const off = this.on((event) => {
      if (event.type === "turn_ended") controller.abort();
    });
    try {
      return await this.spec.approvals(request, controller.signal);
    } finally {
      off();
    }
  }

  private async approveCommand(params: any): Promise<unknown> {
    const command = Array.isArray(params.command) ? params.command.join(" ") : String(params.command ?? "");
    const decision = await this.ask({
      id: String(params.approvalId ?? params.itemId ?? randomUUID()),
      provider: "codex",
      name: "shell",
      kind: "tool",
      ...(params.reason ? { description: String(params.reason) } : {}),
      input: { command, cwd: params.cwd },
      detail: { type: "shell", command, ...(params.cwd ? { cwd: String(params.cwd) } : {}) },
    });
    return { decision: decision.behavior === "allow" ? (decision.remember ? "acceptForSession" : "accept") : "decline" };
  }

  private async approveFileChange(params: any): Promise<unknown> {
    const decision = await this.ask({ id: String(params.itemId ?? randomUUID()), provider: "codex", name: "apply_patch", kind: "tool", ...(params.reason ? { description: String(params.reason) } : {}) });
    return { decision: decision.behavior === "allow" ? (decision.remember ? "acceptForSession" : "accept") : "decline" };
  }

  private async approveOther(name: string, params: any): Promise<unknown> {
    const decision = await this.ask({ id: randomUUID(), provider: "codex", name, kind: "other", input: isRecord(params) ? params : {} });
    return { decision: decision.behavior === "allow" ? "accept" : "decline" };
  }

  /** Codex asks before an MCP tool call through an elicitation. */
  private async approveElicitation(params: any): Promise<unknown> {
    const server = String(params.serverName ?? "");
    const meta = isRecord(params._meta) ? params._meta : {};
    const tool = String(meta.tool_name ?? meta.toolName ?? "");
    if (tool && isTrusted(this.spec.trustedTools, server, tool)) return { action: "accept", content: null, _meta: null };
    const decision = await this.ask({
      id: randomUUID(),
      provider: "codex",
      name: tool ? `mcp__${server}__${tool}` : `mcp__${server}`,
      kind: "tool",
      description: String(params.message ?? params.description ?? `Use a tool from ${server}`),
      input: isRecord(meta) ? meta : {},
    });
    return { action: decision.behavior === "allow" ? "accept" : "decline", content: null, _meta: null };
  }

  /** Our own tools, offered as dynamic tools: approved by our policy, run against our server. */
  private async callDynamic(params: any): Promise<unknown> {
    const entry = this.dynamic.get(String(params.tool));
    if (!entry) return { contentItems: [{ type: "inputText", text: `Unknown tool ${params.tool}` }], success: false };
    if (!isTrusted(this.spec.trustedTools, entry.server, entry.tool)) {
      const decision = await this.ask({ id: String(params.callId ?? randomUUID()), provider: "codex", name: `mcp__${entry.server}__${entry.tool}`, kind: "tool", input: isRecord(params.arguments) ? params.arguments : {}, detail: { type: "unknown", input: params.arguments ?? null, output: null } });
      if (decision.behavior !== "allow") return { contentItems: [{ type: "inputText", text: decision.message ?? "The user declined this tool call." }], success: false };
    }
    try {
      const result = await callMcpTool(this.spec.mcpServers[entry.server]!, entry.tool, params.arguments);
      return { contentItems: [{ type: "inputText", text: result.text }], success: !result.isError };
    } catch (error) {
      return { contentItems: [{ type: "inputText", text: errorMessage(error) }], success: false };
    }
  }
}

function codexMcpConfig(server: McpServerConfig): Record<string, unknown> {
  if (server.type === "stdio") return { command: server.command, args: server.args ?? [], env: server.env ?? {} };
  return { url: server.url, ...(server.headers && Object.keys(server.headers).length ? { http_headers: server.headers } : {}) };
}
