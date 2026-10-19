// OpenCode through its v2 server (`opencode serve` + @opencode/client), on OpenCode's own
// providers and logins. Each session gets its own server process, so the session's MCP servers
// (which OpenCode scopes to a folder, not a session) and their tokens never mix with another
// chat's. Steers are prompts with delivery "steer"; the inbox events say when they reach the turn.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { OpenCode } from "@opencode/client";
import { cleanEnv, findBinary, runQuiet } from "../env.ts";
import { isTrusted, listMcpTools } from "../mcp-client.ts";
import { opencodeFormAnswer, opencodeQuestion } from "../questions.ts";
import { SessionBase } from "../session-base.ts";
import { toolDetail } from "../tool-detail.ts";
import type { ContextUsage, ModeDef, ModelDef, ProbeResult, RuntimeAdapter, RuntimeCapabilities, RuntimeSession, SendOptions, SendResult, SessionSpec, SlashCommand, TimelineItem, UserInput } from "../types.ts";
import { errorMessage, parseSlash, processAlive, resultText } from "../util.ts";

type Client = ReturnType<typeof OpenCode.make>;

const MODES: ModeDef[] = [
  { id: "ask", label: "Always Ask", description: "Asks before running commands and changing files" },
  { id: "ask-commands", label: "Ask for commands", description: "Changes files without asking; asks before commands" },
  { id: "never", label: "Never ask", description: "Runs everything without asking" },
];

interface Server {
  child: ChildProcess;
  client: Client;
  exited: Promise<void>;
}

async function startServer(binary: string, cwd: string, env: Record<string, string>): Promise<Server> {
  const password = randomBytes(16).toString("hex");
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd, env: cleanEnv({ ...env, OPENCODE_PASSWORD: password }), stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stderr!.on("data", () => {});
  const url = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("OpenCode's server didn't start within 30 seconds.")), 30_000);
    child.stdout!.on("data", (chunk) => {
      buffer = (buffer + String(chunk)).slice(-8192);
      const match = buffer.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`OpenCode's server exited during startup (${code}).`));
    });
  });
  const client = OpenCode.make({ baseUrl: url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
  return { child, client, exited };
}

const COMPACT: SlashCommand = { name: "compact", description: "Summarize the conversation to free up context", argumentHint: "", kind: "command" };

export class OpenCodeAdapter implements RuntimeAdapter {
  readonly id = "opencode" as const;
  readonly label = "OpenCode";
  readonly capabilities: RuntimeCapabilities = { steer: true, steerLands: "after_tool", steerAcceptance: "delivered", images: false, subAgents: true, keepsPromptOnResume: false, reportsCompaction: true, questionTool: "question" };
  private readonly options: { binary?: string };
  private modelCache: { at: number; models: ModelDef[] } | null = null;

  constructor(options: { binary?: string } = {}) {
    this.options = options;
  }

  private async binary(): Promise<string | null> {
    return this.options.binary ?? (await findBinary("opencode"));
  }

  async probe(): Promise<ProbeResult> {
    const binary = await this.binary();
    if (!binary) return { installed: false, auth: "unknown", diagnostic: "The opencode CLI isn't on PATH." };
    const version = (await runQuiet(binary, ["--version"]))?.trim().split(/\s+/).pop()?.replace(/^v/, "");
    return { installed: true, ...(version ? { version } : {}), auth: "unknown" };
  }

  async models(): Promise<ModelDef[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.models;
    const binary = await this.binary();
    if (!binary) return [];
    let server: Server | null = null;
    try {
      server = await startServer(binary, process.cwd(), {});
      const location = { directory: process.cwd() };
      const [list, preferred] = await Promise.all([server.client.model.list({ location } as never), server.client.model.default({ location } as never).catch(() => null)]);
      const fallback = (preferred as { data?: { id?: string; providerID?: string } } | null)?.data;
      const models: ModelDef[] = ((list as { data?: { id: string; modelID: string; providerID: string; name: string }[] }).data ?? []).map((model) => ({
        id: `${model.providerID}/${model.modelID ?? model.id}`,
        label: `${model.name} (${model.providerID})`,
        ...(fallback && fallback.providerID === model.providerID && fallback.id === (model.modelID ?? model.id) ? { isDefault: true } : {}),
      }));
      this.modelCache = { at: Date.now(), models };
      return models;
    } catch {
      return [];
    } finally {
      server?.child.kill("SIGTERM");
    }
  }

  modes(): ModeDef[] {
    return MODES;
  }

  async open(spec: SessionSpec): Promise<RuntimeSession> {
    const binary = await this.binary();
    if (!binary) throw new Error("The opencode CLI isn't on PATH.");
    const session = new OpenCodeSession(spec);
    await session.start(binary);
    return session;
  }
}

class OpenCodeSession extends SessionBase implements RuntimeSession {
  readonly provider = "opencode" as const;
  private readonly spec: SessionSpec;
  private server!: Server;
  private sessionID = "";
  private readonly abort = new AbortController();
  /** inbox id → the message it carries */
  private readonly inbox = new Map<string, { clientMessageId: string; text: string; as: "turn" | "steer" }>();
  private readonly toolNames = new Map<string, string>();
  private readonly toolInputs = new Map<string, unknown>();
  private readonly texts = new Map<string, string>();
  private interruptRequested = false;
  private turnError: string | null = null;
  private closing = false;
  private readonly approvalAborts = new Set<AbortController>();
  /** Question forms waiting for the user, by form id. */
  private readonly forms = new Map<string, AbortController>();
  /** The commands and skills last listed, so "/name" in a message can be told apart from text. */
  private listed: SlashCommand[] = [];
  private skillIds = new Map<string, string>();

  constructor(spec: SessionSpec) {
    super();
    this.spec = spec;
  }

  alive(): boolean | undefined {
    return this.server ? processAlive(this.server.child) : undefined;
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.server?.child.kill(signal);
  }

  async start(binary: string): Promise<void> {
    const { spec } = this;
    this.server = await startServer(binary, spec.cwd, spec.env ?? {});
    void this.server.exited.then(() => {
      if (this.closing) return;
      if (this.turnId) this.endTurn(this.interruptRequested ? "canceled" : "failed", { error: "OpenCode stopped." });
      this.currentState = "closed";
      this.emit({ type: "exited", error: "OpenCode stopped." });
    });
    const client = this.server.client;
    const location = { directory: spec.cwd };
    const rules: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[] = [];
    for (const [name, server] of Object.entries(spec.mcpServers)) {
      await client.mcp.add({
        server: name,
        location,
        config:
          server.type === "stdio"
            ? { type: "local", command: [server.command, ...(server.args ?? [])], environment: server.env ?? {}, codemode: false }
            : { type: "remote", url: server.url, headers: server.headers ?? {}, oauth: false, codemode: false },
      } as never);
      // Our own tools: allowed when trusted, asked otherwise.
      if (spec.hostedMcpServers?.includes(name)) {
        for (const tool of await listMcpTools(server).catch(() => [])) {
          rules.push({ action: `${name}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"), resource: "*", effect: isTrusted(spec.trustedTools, name, tool.name) ? "allow" : "ask" });
        }
      } else {
        for (const entry of spec.trustedTools.filter((grant) => grant.startsWith(`${name}/`))) {
          rules.push({ action: `${name}_${entry.slice(name.length + 1)}`.replace(/[^a-zA-Z0-9_-]/g, "_"), resource: "*", effect: "allow" });
        }
      }
    }
    // Its question tool asks the user through a form; asking needs no approval of its own.
    rules.push({ action: "question", resource: "*", effect: "allow" });
    const mode = spec.mode ?? "ask";
    if (mode !== "never") rules.push({ action: "shell", resource: "*", effect: "ask" });
    if (mode === "ask") for (const action of ["edit", "write", "patch"]) rules.push({ action, resource: "*", effect: "ask" });

    if (spec.resume) {
      this.sessionID = spec.resume.sessionId;
    } else {
      const [providerID, ...rest] = (spec.model && spec.model !== "default" ? spec.model : "").split("/");
      const info = (await client.session.create({ location, ...(providerID && rest.length ? { model: { providerID, id: rest.join("/") } } : {}), permissions: rules } as never)) as { id: string };
      this.sessionID = info.id;
    }
    await client.session.instructions.entry.put({ sessionID: this.sessionID, key: "pocket-bots", value: spec.systemPrompt } as never).catch(() => undefined);
    void this.consume();
    this.currentState = "idle";
    this.setHandle({ provider: "opencode", sessionId: this.sessionID });
  }

  async send(input: UserInput, options: SendOptions): Promise<SendResult> {
    if (this.currentState === "closed") return { ok: false, reason: "closed" };
    let as: "turn" | "steer" = "turn";
    if (this.turnId) {
      const busy = await this.busySend(input, options);
      if (busy === "steer") as = "steer";
      else if (busy !== "start") return busy;
    }
    const turnId = as === "turn" ? this.beginTurn() : this.turnId!;
    if (as === "turn") this.turnError = null;
    const slash = parseSlash(input.text);
    const listed = slash ? this.listed.find((entry) => entry.name === slash.name) : undefined;
    if (as === "turn" && slash && listed?.kind === "command") return this.runCommand(turnId, slash, input.text, options);
    const skill = listed?.kind === "skill" ? this.skillIds.get(listed.name) : undefined;
    try {
      const entry = (await this.server.client.session.prompt({
        sessionID: this.sessionID,
        text: input.text,
        ...(skill ? { skills: [{ id: skill }] } : {}),
        ...(as === "steer" ? { delivery: "steer" } : {}),
      } as never)) as { id: string };
      this.inbox.set(entry.id, { clientMessageId: options.clientMessageId, text: input.text, as });
    } catch (error) {
      if (as === "turn") this.endTurn("failed", { error: errorMessage(error) });
      return { ok: false, reason: as === "steer" ? "steer_unavailable" : "error", detail: errorMessage(error) };
    }
    return { ok: true, as, turnId };
  }

  /** OpenCode's commands (and /compact) and its skills, listed for this session's folder. */
  async commands(): Promise<SlashCommand[]> {
    const location = { directory: this.spec.cwd };
    const [commands, skills] = await Promise.all([
      (this.server.client.command.list({ location } as never) as Promise<{ data: { name: string; description?: string }[] }>).catch(() => null),
      (this.server.client.skill.list({ location } as never) as Promise<{ data: { id: string; name: string; description?: string }[] }>).catch(() => null),
    ]);
    this.skillIds = new Map((skills?.data ?? []).map((skill) => [skill.name, skill.id]));
    const byName = new Map<string, SlashCommand>([["compact", COMPACT]]);
    for (const command of commands?.data ?? []) byName.set(command.name, { name: command.name, description: command.description ?? "", argumentHint: "", kind: "command" });
    for (const skill of skills?.data ?? []) if (!byName.has(skill.name)) byName.set(skill.name, { name: skill.name, description: skill.description ?? "", argumentHint: "", kind: "skill" });
    this.listed = [...byName.values()];
    return this.listed;
  }

  /**
   * A command runs through its own endpoint, and /compact is an inbox entry of its own; either way the
   * execution events end the turn, and it's accepted once OpenCode takes it.
   */
  private async runCommand(turnId: string, slash: { name: string; args: string }, text: string, options: SendOptions): Promise<SendResult> {
    try {
      if (slash.name === "compact") await this.server.client.session.compact({ sessionID: this.sessionID } as never);
      else await this.server.client.session.command({ sessionID: this.sessionID, name: slash.name, text: slash.args } as never);
    } catch (error) {
      this.endTurn("failed", { error: errorMessage(error) });
      return { ok: false, reason: "error", detail: errorMessage(error) };
    }
    this.item(`user:${options.clientMessageId}`, { type: "user_message", text, clientMessageId: options.clientMessageId });
    this.emit({ type: "input_accepted", clientMessageId: options.clientMessageId, turnId, as: "turn" });
    return { ok: true, as: "turn", turnId };
  }

  async interrupt(): Promise<{ canceledTurnId: string | null }> {
    if (!this.turnId) return { canceledTurnId: null };
    this.interruptRequested = true;
    for (const controller of this.approvalAborts) controller.abort();
    const ended = this.turnEnded(15_000);
    await this.server.client.session.interrupt({ sessionID: this.sessionID } as never).catch(() => undefined);
    const canceled = await ended;
    if (!canceled && this.turnId) this.endTurn("canceled");
    return { canceledTurnId: canceled };
  }

  async close(): Promise<void> {
    if (this.currentState === "closed") return;
    this.closing = true;
    if (this.turnId) await this.interrupt();
    this.abort.abort();
    this.server.child.kill("SIGTERM");
    this.currentState = "closed";
  }

  private item(key: string, item: TimelineItem): void {
    this.emit({ type: "item", turnId: this.turnId, key, item });
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.server.client.event.subscribe({ signal: this.abort.signal } as never) as AsyncIterable<any>) {
        const sessionID = event?.data?.sessionID ?? event?.data?.form?.sessionID;
        if (sessionID && sessionID !== this.sessionID) continue;
        try {
          this.event(event);
        } catch (error) {
          console.error("runtime(opencode): handling an event failed", error);
        }
      }
    } catch {
      // The stream ends when the server stops or the session closes.
    }
  }

  private event(e: any): void {
    const data = e.data ?? {};
    switch (e.type) {
      case "session.inbox.delivered": {
        const entry = this.inbox.get(data.inboxID);
        if (!entry) return;
        this.inbox.delete(data.inboxID);
        if (!this.turnId) this.beginTurn();
        const as = entry.as;
        this.item(`user:${entry.clientMessageId}`, { type: "user_message", text: entry.text, clientMessageId: entry.clientMessageId });
        this.emit({ type: "input_accepted", clientMessageId: entry.clientMessageId, turnId: this.turnId!, as });
        return;
      }
      case "session.execution.started":
        if (!this.turnId && this.currentState !== "closed") this.beginTurn();
        return;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        if (!this.turnId) return;
        const canceled = this.interruptRequested || e.type === "session.execution.interrupted";
        this.interruptRequested = false;
        this.texts.clear();
        if (canceled) this.endTurn("canceled", { usage: this.lastUsage ?? {} });
        else if (e.type === "session.execution.failed" || this.turnError) {
          const error = this.turnError ?? structuredError(data.error) ?? "OpenCode reported an error.";
          this.item(`error:${randomUUID()}`, { type: "error", message: error });
          this.endTurn("failed", { error, usage: this.lastUsage ?? {} });
        } else this.endTurn("completed", { usage: this.lastUsage ?? {} });
        this.turnError = null;
        return;
      }
      case "session.text.delta":
      case "session.reasoning.delta": {
        const kind = e.type === "session.text.delta" ? "text" : "reasoning";
        const key = `${kind}:${data.assistantMessageID}:${data.ordinal}`;
        const text = (this.texts.get(key) ?? "") + String(data.delta ?? "");
        this.texts.set(key, text);
        this.item(key, kind === "text" ? { type: "assistant_message", text, messageId: data.assistantMessageID } : { type: "reasoning", text });
        return;
      }
      case "session.text.ended":
        this.item(`text:${data.assistantMessageID}:${data.ordinal}`, { type: "assistant_message", text: String(data.text ?? ""), messageId: data.assistantMessageID });
        return;
      case "session.tool.input.started":
        this.toolNames.set(data.id, String(data.name));
        return;
      case "session.tool.called": {
        const name = this.toolNames.get(data.id) ?? "tool";
        this.toolInputs.set(data.id, data.input);
        this.item(`tool:${data.id}`, { type: "tool_call", callId: data.id, name, status: "running", error: null, detail: toolDetail(name, data.input) });
        return;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const name = this.toolNames.get(data.id) ?? "tool";
        const input = this.toolInputs.get(data.id);
        const failed = e.type === "session.tool.failed";
        const text = resultText((data.content ?? []).map((part: any) => (part?.type === "text" ? { text: part.text } : part)));
        const canceled = failed && this.interruptRequested;
        const error = failed ? (structuredError(data.error) ?? text) : null;
        this.item(`tool:${data.id}`, { type: "tool_call", callId: data.id, name, status: canceled ? "canceled" : failed ? "failed" : "completed", error: canceled ? null : error, detail: toolDetail(name, input, { text }) });
        return;
      }
      case "session.usage.updated": {
        const tokens = data.tokens ?? {};
        const next: ContextUsage = {
          inputTokens: Number(tokens.input ?? 0),
          outputTokens: Number(tokens.output ?? 0),
          cachedInputTokens: Number(tokens.cache?.read ?? 0),
          contextWindowUsedTokens: Number(tokens.input ?? 0) + Number(tokens.cache?.read ?? 0) + Number(tokens.output ?? 0),
          ...(typeof data.cost === "number" ? { totalCostUsd: data.cost } : {}),
        };
        this.lastUsage = { ...this.lastUsage, ...next };
        this.emit({ type: "usage", usage: this.lastUsage });
        return;
      }
      case "session.step.ended":
        if (data.finish === "error") this.turnError = "The model request failed.";
        return;
      case "session.compaction.started":
        this.item(`compaction:${this.turnId}`, { type: "compaction", status: "loading", trigger: data.reason === "manual" ? "manual" : "auto" });
        return;
      case "session.compaction.ended":
        this.item(`compaction:${this.turnId}`, { type: "compaction", status: "completed", trigger: data.reason === "manual" ? "manual" : "auto" });
        return;
      case "session.compaction.failed":
        this.turnError = structuredError(data.error) ?? "OpenCode couldn't compact the conversation.";
        return;
      case "permission.asked":
        void this.permission(data);
        return;
      case "form.created":
        void this.form(data.form);
        return;
      case "form.replied":
      case "form.cancelled":
        // Answered elsewhere (OpenCode's own UI): the question is no longer waiting here.
        this.forms.get(String(data.id))?.abort();
        return;
      default:
        return;
    }
  }

  private async permission(data: any): Promise<void> {
    // The gate before its question tool's form (a session made before the rule allowing it): the form is the question.
    if (data.action === "question") {
      await this.server.client.permission.reply({ sessionID: this.sessionID, requestID: data.id, decision: "once" } as never).catch(() => undefined);
      return;
    }
    const controller = new AbortController();
    this.approvalAborts.add(controller);
    const action = String(data.action ?? "tool");
    const resources: string[] = Array.isArray(data.resources) ? data.resources : [];
    const input = action === "shell" ? { command: resources.join(" && ") } : { resources };
    try {
      const decision = await this.spec.approvals(
        { id: String(data.id), provider: "opencode", name: action, kind: "tool", ...(data.message ? { description: String(data.message) } : {}), input, detail: toolDetail(action, input) },
        controller.signal,
      );
      await this.server.client.permission.reply({ sessionID: this.sessionID, requestID: data.id, decision: decision.behavior === "allow" ? (decision.remember ? "always" : "once") : "reject", ...(decision.behavior === "deny" && decision.message ? { message: decision.message } : {}) } as never);
    } catch (error) {
      await this.server.client.permission.reply({ sessionID: this.sessionID, requestID: data.id, decision: "reject" } as never).catch(() => undefined);
      console.error("runtime(opencode): approval failed", errorMessage(error));
    } finally {
      this.approvalAborts.delete(controller);
    }
  }

  /** A form from its question tool goes to the user as a question; another kind of form is cancelled (pocket-bots shows none). */
  private async form(form: any): Promise<void> {
    const formID = String(form?.id ?? "");
    const request = opencodeQuestion(form);
    if (!request) {
      await this.server.client.session.form.cancel({ sessionID: this.sessionID, formID } as never).catch(() => undefined);
      return;
    }
    const controller = new AbortController();
    this.approvalAborts.add(controller);
    this.forms.set(formID, controller);
    try {
      const decision = await this.spec.approvals(request, controller.signal);
      if (controller.signal.aborted) return;
      if (decision.behavior === "allow") await this.server.client.session.form.reply({ sessionID: this.sessionID, formID, answer: opencodeFormAnswer(form, decision) } as never);
      else await this.server.client.session.form.cancel({ sessionID: this.sessionID, formID } as never);
    } catch (error) {
      await this.server.client.session.form.cancel({ sessionID: this.sessionID, formID } as never).catch(() => undefined);
      console.error("runtime(opencode): question failed", errorMessage(error));
    } finally {
      this.approvalAborts.delete(controller);
      this.forms.delete(formID);
    }
  }
}

function structuredError(error: unknown): string | null {
  if (!error || typeof error !== "object") return typeof error === "string" ? error : null;
  const record = error as Record<string, unknown>;
  return typeof record.message === "string" ? record.message : typeof record.data === "object" && record.data && typeof (record.data as { message?: unknown }).message === "string" ? String((record.data as { message: string }).message) : JSON.stringify(error);
}
