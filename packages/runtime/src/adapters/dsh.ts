// DeepSeek Harness over ACP (`dsh --profile acp`), on DSH's own credentials.
//
// DSH is a Cordis plugin tree booted from a profile, so the bot's instructions and the approval
// mode are both decided before the process starts: a per-chat `--patch` file overrides the acp
// profile's `system-prompt` entry (personaSuffix renders after DSH's own guidance, and DSH puts it
// in the system message, not the chat), and DSH_PERMISSION_MODE picks the sandbox and whether DSH
// asks at all. ACP can't change either later: the protocol has session/set_mode, DSH doesn't
// implement it.
//
// Its model catalog comes from a throwaway session (ACP has no way to ask), so it's cached and
// every real session refreshes it from the configOptions it returns. ACP has no steer: a prompt
// while one is in flight is rejected, so mid-turn input reports steer_unavailable.
import { randomUUID } from "node:crypto";
import { access, constants, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { cleanEnv, findBinary, runQuiet } from "../env.ts";
import { JsonRpcProcess } from "../jsonrpc.ts";
import { isTrusted } from "../mcp-client.ts";
import { SessionBase } from "../session-base.ts";
import { toolDetail } from "../tool-detail.ts";
import type { ContextUsage, McpServerConfig, ModeDef, ModelDef, ProbeResult, RuntimeAdapter, RuntimeCapabilities, RuntimeSession, SendOptions, SendResult, SessionSpec, TimelineItem, ToolCallDetail, UserInput } from "../types.ts";
import { errorMessage, isRecord, processAlive, resultText } from "../util.ts";

const PROFILE = "acp";
/** The persona line the acp profile ships; a patch replaces the whole config, so it's restated. */
const PERSONA_PREFIX = "You are a coding agent powered by the {{model}} model.";
/** ACP only reveals models (and a model's reasoning levels) one session at a time, so keep them. */
const MODEL_TTL = 12 * 60 * 60_000;
/** Enough for any real provider list; each one costs a round trip in the probe. */
const MAX_PROBED_MODELS = 16;

const MODES: ModeDef[] = [
  { id: "read-only", label: "Read only", description: "Reads and searches; asks before anything that writes" },
  { id: "workspace-write", label: "Workspace write", description: "Writes inside the session folder; asks before the rest" },
  { id: "danger-full-access", label: "Full access", description: "Runs everything without asking" },
];

const INITIALIZE = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  _meta: { clientType: "pocket-bots", clientVersion: "0.1.0" },
};

/** Where the Desktop app carries its own CLI (the npm package is the same program). */
const DESKTOP_BINARIES = ["/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh", join(homedir(), "Applications", "DeepSeek Harness.app", "Contents", "Resources", "runtime", "cli", "bin", "dsh")];

/** The CLI to run: POCKET_BOTS_DSH_BINARY, then PATH, then the Desktop app's bundled copy. */
async function findDsh(binary?: string): Promise<string | null> {
  const candidates = [binary, process.env.POCKET_BOTS_DSH_BINARY, await findBinary("dsh"), ...DESKTOP_BINARIES];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** DSH_HOME as the child will see it: what the bot sets, else the default ~/.dsh. */
function dshHome(env: Record<string, string | undefined> = process.env): string {
  const custom = env.DSH_HOME?.trim();
  return custom ? custom : join(homedir(), ".dsh");
}

/** A profile exists once its directory does; booting a missing one installs plugins for minutes. */
async function profileInstalled(home: string): Promise<boolean> {
  return access(join(home, "profiles", PROFILE), constants.R_OK).then(() => true, () => false);
}

export class DshAdapter implements RuntimeAdapter {
  readonly id = "dsh" as const;
  readonly label = "DeepSeek Harness";
  readonly capabilities: RuntimeCapabilities = { steer: false, steerLands: "after_tool", steerAcceptance: "queued", images: false, subAgents: true, keepsPromptOnResume: false, additionalDirectories: false, liveDirectories: false, reportsCompaction: false };
  private readonly options: { binary?: string };
  private modelCache: { at: number; models: ModelDef[] } | null = null;

  constructor(options: { binary?: string } = {}) {
    this.options = options;
  }

  private binary(): Promise<string | null> {
    return findDsh(this.options.binary);
  }

  async probe(): Promise<ProbeResult> {
    const binary = await this.binary();
    if (!binary) return { installed: false, auth: "unknown", diagnostic: "DeepSeek Harness isn't installed. Install the Desktop app, or run `npm install -g @deepseek-ai/dsh`." };
    const version = (await runQuiet(binary, ["--version"]))?.trim().split(/\s+/).at(-1);
    // DSH keeps its keys in ~/.dsh/.credentials.yaml, shared by every profile; without it a model
    // may still come from the environment, so this is only ever "ok" or "unknown".
    const stored = await access(join(homedir(), ".dsh", ".credentials.yaml")).then(() => true, () => false);
    return { installed: true, ...(version ? { version } : {}), auth: stored ? "ok" : "unknown" };
  }

  async models(): Promise<ModelDef[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < MODEL_TTL) return this.modelCache.models;
    const binary = await this.binary();
    if (!binary || !(await profileInstalled(dshHome()))) return [];
    const cwd = join(tmpdir(), "pocket-bots-dsh", randomUUID());
    await mkdir(cwd, { recursive: true });
    const rpc = new JsonRpcProcess(binary, ["--profile", PROFILE], { cwd, env: cleanEnv(), jsonrpcField: true });
    try {
      await rpc.request("initialize", INITIALIZE, 30_000);
      const created = await rpc.request("session/new", { cwd, mcpServers: [] }, 120_000);
      const sessionId = String(created?.sessionId ?? "");
      const models = modelsFrom(created?.configOptions ?? []);
      // A model's reasoning levels only appear once it is selected, so ask each model in turn.
      for (const model of models.slice(0, MAX_PROBED_MODELS)) {
        const pair = splitModel(model.id);
        if (!pair || !sessionId) continue;
        const switched = await rpc.request("session/set_config_option", { sessionId, configId: "model", value: JSON.stringify(pair) }, 30_000).catch(() => null);
        const thinking = thinkingFrom(switched?.configOptions ?? []);
        if (thinking.length > 0) model.thinkingOptions = thinking;
      }
      if (sessionId) await rpc.request("session/close", { sessionId }, 10_000).catch(() => undefined);
      this.modelCache = { at: Date.now(), models };
      return models;
    } catch {
      return this.modelCache?.models ?? [];
    } finally {
      rpc.kill();
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  modes(): ModeDef[] {
    return MODES;
  }

  async open(spec: SessionSpec): Promise<RuntimeSession> {
    const binary = await this.binary();
    if (!binary) throw new Error("DeepSeek Harness isn't installed, and its CLI isn't on PATH.");
    const session = new DshSession(spec);
    try {
      await session.start(binary);
    } catch (error) {
      // A profile with no model, or a boot that never came up: don't leave the process behind.
      await session.close().catch(() => undefined);
      throw error;
    }
    return session;
  }
}

class DshSession extends SessionBase implements RuntimeSession {
  readonly provider = "dsh" as const;
  private readonly spec: SessionSpec;
  private rpc!: JsonRpcProcess;
  private sessionId = "";
  private patchFile: string | null = null;
  private assistantKey: string | null = null;
  private assistantText = "";
  private reasoningKey: string | null = null;
  private reasoningText = "";
  private readonly tools = new Map<string, { name: string; detail: ToolCallDetail; input: unknown }>();
  private interruptRequested = false;
  private closing = false;
  private patchWarned = false;
  private stderrTail = "";
  /** Anything worth saying that happened while opening: nobody listens to events until open() returns. */
  private readonly notices: { level: "info" | "warning" | "error"; message: string }[] = [];
  private readonly approvalAborts = new Set<AbortController>();

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
    // A profile that was never booted installs its plugins on first use, which outlasts the app's
    // start timeout: say what to run instead of leaving the chat on "starting" for two minutes.
    const home = dshHome({ ...process.env, ...spec.env });
    if (!(await profileInstalled(home))) {
      throw new Error(`DeepSeek Harness isn't set up for pocket-bots yet: there's no "${PROFILE}" profile in ${join(home, "profiles")}. Run \`dsh --profile ${PROFILE}\` once in a terminal (its first boot installs the profile), give it a model in ${join(home, "profiles", PROFILE, "cordis.patch.yml")} (see docs/USAGE.md), then try again.`);
    }
    this.patchFile = await writePromptPatch(spec.key, spec.systemPrompt);
    const args = ["--profile", PROFILE, ...(this.patchFile ? ["--patch", this.patchFile] : [])];
    const mode = MODES.some((def) => def.id === spec.mode) ? spec.mode! : "workspace-write";
    this.rpc = new JsonRpcProcess(binary, args, { cwd: spec.cwd, env: cleanEnv({ ...spec.env, DSH_PERMISSION_MODE: mode }), jsonrpcField: true, onStderr: (text) => this.stderr(text) });
    this.rpc.onNotification((method, params) => {
      if (method === "session/update" && params?.sessionId === this.sessionId) this.update(params.update ?? {});
    });
    // ACP asks with just the tool call id: the tool_call update that named it came first.
    this.rpc.onRequest("session/request_permission", (params) => this.permission(params));
    this.rpc.onRequest("*", () => ({}));
    this.rpc.onExit((error) => {
      void this.removePatch();
      if (this.closing) return;
      if (this.turnId) this.endTurn(this.interruptRequested ? "canceled" : "failed", { error: error ?? "DeepSeek Harness stopped." });
      this.currentState = "closed";
      this.emit({ type: "exited", error: error ?? "DeepSeek Harness stopped." });
    });
    await this.rpc.request("initialize", INITIALIZE, 60_000);
    const mcpServers = await acpMcpServers(spec.mcpServers, (message) => this.notices.push({ level: "warning", message }));
    let options = await this.openSession(mcpServers);
    options = await this.selectModel(options);
    this.currentState = "idle";
    this.setHandle({ provider: "dsh", sessionId: this.sessionId });
  }

  /** New, or resumed with a new one as the fallback: ACP's resume is the only way back into a session. */
  private async openSession(mcpServers: unknown[]): Promise<any[]> {
    const { spec } = this;
    if (spec.resume) {
      try {
        const resumed = await this.rpc.request("session/resume", { sessionId: spec.resume.sessionId, cwd: spec.cwd, mcpServers }, 120_000);
        this.sessionId = spec.resume.sessionId;
        return resumed?.configOptions ?? [];
      } catch (error) {
        this.notices.push({ level: "warning", message: `This chat's session couldn't be resumed (${errorMessage(error)}), so it started a new one.` });
      }
    }
    const created = await this.rpc.request("session/new", { cwd: spec.cwd, mcpServers }, 120_000);
    this.sessionId = String(created?.sessionId ?? "");
    const options: any[] = created?.configOptions ?? [];
    if (!options.some((option) => (option?.id ?? option?.category) === "model" && option?.currentValue)) {
      throw new Error("DeepSeek Harness has no model configured for its acp profile. Set one in ~/.dsh/profiles/acp/cordis.patch.yml (see docs/USAGE.md).");
    }
    return options;
  }

  /** The model and its reasoning level are config options; the bot's choices win, and a model DSH no longer offers only warns. */
  private async selectModel(options: any[]): Promise<any[]> {
    const pair = this.spec.model ? splitModel(this.spec.model) : null;
    if (pair) {
      const switched = await this.rpc.request("session/set_config_option", { sessionId: this.sessionId, configId: "model", value: JSON.stringify(pair) }, 30_000).then(
        (result) => (result?.configOptions as any[] | undefined) ?? null,
        () => null,
      );
      if (switched) options = switched;
      else this.notices.push({ level: "warning", message: `DeepSeek Harness doesn't offer the model ${this.spec.model}; this chat runs on the one it has selected.` });
    }
    const thinking = thinkingFrom(options).map((option) => option.id);
    if (this.spec.thinking && thinking.includes(this.spec.thinking)) {
      await this.rpc.request("session/set_config_option", { sessionId: this.sessionId, configId: "reasoning_effort", value: this.spec.thinking }, 30_000).catch(() => undefined);
    }
    return options;
  }

  async send(input: UserInput, options: SendOptions): Promise<SendResult> {
    if (this.currentState === "closed") return { ok: false, reason: "closed" };
    if (this.turnId) {
      const busy = await this.busySend(input, options);
      if (busy === "steer") return { ok: false, reason: "steer_unavailable", detail: "DeepSeek Harness takes one prompt at a time." };
      if (busy !== "start") return busy;
    }
    for (const notice of this.notices.splice(0)) this.notice(notice.level, notice.message);
    const turnId = this.beginTurn();
    this.emit({ type: "item", turnId, key: `user:${options.clientMessageId}`, item: { type: "user_message", text: input.text, clientMessageId: options.clientMessageId } });
    this.emit({ type: "input_accepted", clientMessageId: options.clientMessageId, turnId, as: "turn" });
    void this.rpc
      .request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: input.text }] }, 6 * 60 * 60_000)
      .then((result) => this.promptEnded(String(result?.stopReason ?? "end_turn"), null))
      .catch((error) => this.promptEnded("error", errorMessage(error)));
    return { ok: true, as: "turn", turnId };
  }

  private promptEnded(stopReason: string, error: string | null): void {
    if (!this.turnId) return;
    const canceled = this.interruptRequested || stopReason === "cancelled" || stopReason === "canceled";
    this.interruptRequested = false;
    for (const [callId, call] of this.tools) this.item(`tool:${callId}`, { type: "tool_call", callId, name: call.name, status: "canceled", error: null, detail: call.detail });
    this.tools.clear();
    this.assistantKey = null;
    this.assistantText = "";
    this.reasoningKey = null;
    this.reasoningText = "";
    if (canceled) this.endTurn("canceled", { usage: this.lastUsage ?? {} });
    else if (error || stopReason === "refusal") {
      const message = error ?? "DeepSeek Harness refused this request.";
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
    // DSH keeps the session's own record: close it before the process goes, or it stays "active".
    if (this.sessionId && !this.rpc.exited) await this.rpc.request("session/close", { sessionId: this.sessionId }, 10_000).catch(() => undefined);
    this.rpc.kill();
    this.currentState = "closed";
    await this.removePatch();
  }

  private item(key: string, item: TimelineItem): void {
    this.emit({ type: "item", turnId: this.turnId, key, item });
  }

  private notice(level: "info" | "warning" | "error", message: string): void {
    this.emit({ type: "item", turnId: null, key: `notice:${randomUUID()}`, item: { type: "notification", level, message } });
  }

  /** DSH writes its own log lines to stdout (skipped by the JSON-RPC reader) and boot warnings to stderr. */
  private stderr(text: string): void {
    this.stderrTail = (this.stderrTail + text).slice(-4_000);
    // A patch DSH couldn't apply (an entry renamed by an upgrade) fails silently otherwise.
    if (!this.patchWarned && /patch: (entry .+ not found|name mismatch)/.test(this.stderrTail)) {
      this.patchWarned = true;
      this.notices.push({ level: "warning", message: "DeepSeek Harness didn't apply this chat's instructions: its system-prompt entry was not found (see the dsh output)." });
    }
  }

  private async removePatch(): Promise<void> {
    const file = this.patchFile;
    this.patchFile = null;
    if (file) await rm(file, { force: true }).catch(() => undefined);
  }

  private update(u: any): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = u.content?.type === "text" ? String(u.content.text ?? "") : "";
        if (!text) return;
        if (!this.turnId && this.currentState !== "closed") this.beginTurn();
        if (!this.assistantKey) {
          this.assistantKey = `assistant:${String(u.messageId ?? randomUUID())}`;
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
          this.reasoningKey = `reasoning:${String(u.messageId ?? randomUUID())}`;
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
        const used = Number(u.used ?? 0);
        const size = Number(u.size ?? 0);
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
    // DSH's title is the tool's own name (bash, edit, mcp__bots__list_bots); updates carry none.
    const name = String(u.title ?? "").trim() || known?.name || "tool";
    const input = u.rawInput ?? known?.input;
    const status: string = u.status ?? (known ? "in_progress" : "pending");
    const output = contentText(u.content);
    const done = status === "completed" || status === "failed";
    const detail = done ? toolDetail(name, input, { text: output }) : (known?.detail ?? toolDetail(name, input));
    this.tools.set(callId, { name, detail, input });
    const canceled = status === "failed" && this.interruptRequested;
    this.item(`tool:${callId}`, { type: "tool_call", callId, name, status: canceled ? "canceled" : status === "completed" ? "completed" : status === "failed" ? "failed" : "running", error: status === "failed" && !canceled ? output || "The tool failed." : null, detail });
    if (done) this.tools.delete(callId);
  }

  private async permission(params: any): Promise<unknown> {
    const callId = String(params?.toolCall?.toolCallId ?? "");
    const options: { optionId: string; kind: string }[] = Array.isArray(params?.options) ? params.options : [];
    const pick = (kinds: string[]) => options.find((option) => kinds.includes(option.kind)) ?? null;
    const allow = pick(["allow_once", "allow_always"]);
    const deny = pick(["reject_once", "reject_always"]);
    const known = this.tools.get(callId);
    const name = known?.name ?? "tool";
    const mcp = /^(?:mcp__)?([\w-]+)__([\w-]+)$/.exec(name);
    if (mcp && isTrusted(this.spec.trustedTools, mcp[1]!, mcp[2]!)) return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
    const controller = new AbortController();
    this.approvalAborts.add(controller);
    try {
      const input = isRecord(known?.input) ? known.input : undefined;
      const decision = await this.spec.approvals({ id: callId || randomUUID(), provider: "dsh", name, kind: "tool", ...(input ? { input } : {}), ...(known?.detail ? { detail: known.detail } : {}) }, controller.signal);
      const chosen = decision.behavior === "allow" ? allow : deny;
      return chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId } } : { outcome: { outcome: "cancelled" } };
    } catch {
      return { outcome: { outcome: "cancelled" } };
    } finally {
      this.approvalAborts.delete(controller);
    }
  }
}

// ------------------------------------------------------------------ ACP mapping

/** `["provider","model"]` as a flat id, since ACP's own value is opaque. */
function splitModel(id: string): [string, string] | null {
  const cut = id.indexOf("/");
  return cut > 0 && cut < id.length - 1 ? [id.slice(0, cut), id.slice(cut + 1)] : null;
}

function modelValue(value: unknown): [string, string] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === "string") ? [String(parsed[0]), String(parsed[1])] : null;
  } catch {
    return null;
  }
}

/** The model select's options, which DSH groups by provider; flat lists work too. */
function modelsFrom(configOptions: any[]): ModelDef[] {
  const option = configOptions.find((entry) => (entry?.id ?? entry?.category) === "model");
  const groups: any[] = Array.isArray(option?.options) ? option.options : [];
  const models = new Map<string, ModelDef>();
  for (const group of groups) {
    for (const entry of Array.isArray(group?.options) ? group.options : [group]) {
      const pair = modelValue(entry?.value);
      if (!pair) continue;
      const id = `${pair[0]}/${pair[1]}`;
      if (models.has(id)) continue;
      models.set(id, { id, label: String(entry?.name ?? pair[1]), ...(entry.value === option.currentValue ? { isDefault: true } : {}) });
    }
  }
  return [...models.values()];
}

/** The reasoning-level select, once a model that has one is selected. */
function thinkingFrom(configOptions: any[]): { id: string; label: string; isDefault?: boolean }[] {
  const option = configOptions.find((entry) => (entry?.id ?? entry?.category) === "reasoning_effort" || entry?.category === "thought_level");
  const entries: any[] = Array.isArray(option?.options) ? option.options : [];
  return entries.flatMap((entry) => (typeof entry?.value === "string" ? [{ id: entry.value, label: String(entry.name ?? entry.value), ...(entry.value === option.currentValue ? { isDefault: true } : {}) }] : []));
}

/** ACP's tool result content as text: the same shape the other ACP agents send. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "content" ? resultText([part.content]) : part?.type === "diff" ? `--- ${part.path}\n${part.newText ?? ""}` : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * The bot's instructions as an overlay on the acp profile's system prompt. DSH replaces a patched
 * entry's whole config, so the persona line is restated; its own `{{…}}` template would fail on
 * any variable it doesn't know, so the bot's text has them defused.
 */
async function writePromptPatch(key: string, prompt: string): Promise<string | null> {
  const text = prompt.trim();
  if (!text) return null;
  const dir = join(tmpdir(), "pocket-bots-dsh");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${key.replace(/[^\w-]/g, "_")}-${randomUUID()}.json`);
  const patch = [{ id: "system-prompt", name: "@deepseek-ai/dsh-system-prompt", config: { personaPrefix: PERSONA_PREFIX, personaSuffix: text.replace(/\{\{/g, "{\u200B{") } }];
  await writeFile(file, JSON.stringify(patch, null, 2), "utf8");
  return file;
}

/** DSH mcp fields: stdio needs an absolute command, HTTP is passed through, SSE isn't supported. */
async function acpMcpServers(servers: Record<string, McpServerConfig>, warn: (message: string) => void): Promise<unknown[]> {
  const out: unknown[] = [];
  const names = new Set<string>();
  for (const [raw, server] of Object.entries(servers)) {
    let name = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "mcp";
    for (let n = 2; names.has(name); n += 1) name = `${name.slice(0, 28)}_${n}`;
    if (server.type === "sse") {
      warn(`The "${raw}" MCP server speaks SSE, which DeepSeek Harness doesn't support; it isn't connected.`);
      continue;
    }
    if (server.type === "stdio") {
      const command = isAbsolute(server.command) ? server.command : await findBinary(server.command);
      const usable = command && (await access(command, constants.X_OK).then(() => true, () => false)) ? command : null;
      if (!usable) {
        warn(`The "${raw}" MCP server's command (${server.command}) wasn't found; it isn't connected.`);
        continue;
      }
      names.add(name);
      out.push({ name, command: usable, args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value })) });
      continue;
    }
    names.add(name);
    out.push({ type: "http", name, url: server.url, headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ name: key, value })) });
  }
  return out;
}
