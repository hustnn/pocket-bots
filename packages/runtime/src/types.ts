// The runtime layer's contract: drive one coding-agent CLI session (Claude Code, Codex, OpenCode,
// Pi, Grok Build) on that CLI's own login. It knows nothing about bots or groups.
//
// Every runtime's events become the same timeline items and tool-call details, which the store
// keeps and the web UI renders. (Adapted from Apache-2.0 code; see NOTICE.)

export type ProviderId = "claude" | "codex" | "opencode" | "pi" | "grok" | "fake";

// ------------------------------------------------------------------ timeline

export type ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: "edit"; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: "write"; filePath: string; content?: string }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search";
      content?: string;
      filePaths?: string[];
      webResults?: { title: string; url: string }[];
      annotations?: string[];
    }
  | { type: "fetch"; url: string; prompt?: string; result?: string; code?: number; codeText?: string }
  | { type: "sub_agent"; subAgentType?: string; description?: string; childSessionId?: string; log: string }
  | { type: "plain_text"; label?: string; text?: string; icon?: string }
  | { type: "plan"; text: string }
  | { type: "unknown"; input: unknown; output: unknown };

export type ToolCallStatus = "running" | "completed" | "failed" | "canceled";

export interface TaskItem {
  text: string;
  completed: boolean;
}

export type TimelineItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; callId: string; name: string; status: ToolCallStatus; error: unknown; detail: ToolCallDetail; metadata?: Record<string, unknown> }
  | { type: "todo"; items: TaskItem[] }
  | { type: "error"; message: string }
  | { type: "notification"; level: "info" | "warning" | "error"; message: string }
  /** A compaction that `failed` didn't fit the model or the request failed (`error`); one `canceled` was stopped. */
  | { type: "compaction"; status: "loading" | "completed" | "failed" | "canceled"; trigger?: "auto" | "manual"; preTokens?: number; error?: string };

// ------------------------------------------------------------------ approvals

export interface ApprovalAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
  intent?: string;
}

export interface ApprovalRequest {
  id: string;
  provider: ProviderId;
  /** The tool or operation, as the runtime names it (Bash, shell, mcp__bots__ask_bot, …). */
  name: string;
  /** "question": the agent asks the user (input.questions; see questions.ts for how it's answered). */
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: ToolCallDetail;
  actions?: ApprovalAction[];
  metadata?: Record<string, unknown>;
}

export type ApprovalDecision =
  | { behavior: "allow"; selectedActionId?: string; updatedInput?: Record<string, unknown>; remember?: boolean }
  | { behavior: "deny"; selectedActionId?: string; message?: string; interrupt?: boolean };

/**
 * Every approval a runtime asks for comes here. The caller answers at once (its own tools, an
 * allowlisted command) or later (a card the user answers); `signal` aborts when the turn ends.
 */
export type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;

// ------------------------------------------------------------------ sessions

export type McpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> };

export interface ResumeHandle {
  provider: ProviderId;
  /** The runtime's own session / thread id. */
  sessionId: string;
  /** Anything else the adapter needs to resume (a session folder, a server location). */
  extra?: Record<string, unknown>;
}

export interface SessionSpec {
  /** The caller's id for this chat; used for logging and tool routing. */
  key: string;
  cwd: string;
  model?: string;
  thinking?: string;
  /** The runtime's approval mode (Claude permission mode, Codex approval policy, …). */
  mode?: string;
  /** Appended to the runtime's own system prompt. */
  systemPrompt: string;
  mcpServers: Record<string, McpServerConfig>;
  /** Tools that run without an approval: "server" (all its tools) or "server/tool". */
  trustedTools: string[];
  /**
   * Servers the caller hosts itself as stateless HTTP MCP (its own tools). Adapters may list and
   * call their tools directly to offer them natively (Codex dynamic tools, an OpenCode plugin).
   */
  hostedMcpServers?: string[];
  /** Folders besides `cwd` the agent may use without asking (memory, skills, the chat's extra folders); Claude only (see RuntimeCapabilities.additionalDirectories). */
  extraDirectories?: string[];
  approvals: ApprovalHandler;
  env?: Record<string, string>;
  resume?: ResumeHandle;
}

export interface UserInput {
  text: string;
  images?: { data: string; mimeType: string }[];
}

export interface SendOptions {
  /** What to do when a turn is already running. */
  whenBusy: "steer" | "queue" | "interrupt" | "reject";
  /** Only join this turn; if it already ended, the send fails with `turn_mismatch`. */
  expectedTurnId?: string;
  clientMessageId: string;
}

export type SendResult =
  | { ok: true; as: "turn" | "steer" | "queued"; turnId: string | null }
  | { ok: false; reason: "busy" | "steer_unavailable" | "turn_mismatch" | "compacting" | "closed" | "error"; detail?: string };

export interface ContextUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  contextWindowUsedTokens?: number;
  contextWindowMaxTokens?: number;
  totalCostUsd?: number;
}

export type SessionState = "starting" | "idle" | "running" | "closed";

export type RuntimeEvent =
  | { type: "session_ready"; handle: ResumeHandle }
  | { type: "turn_started"; turnId: string }
  /** The message is now in the model's context (for a steer: it reached the running turn). */
  | { type: "input_accepted"; clientMessageId: string; turnId: string; as: "turn" | "steer" }
  /** A timeline item, new or updated; `key` is stable for the item within the session. */
  | { type: "item"; turnId: string | null; key: string; item: TimelineItem }
  | { type: "usage"; usage: ContextUsage }
  | { type: "turn_ended"; turnId: string; outcome: "completed" | "failed" | "canceled"; usage?: ContextUsage; error?: string }
  | { type: "exited"; error?: string };

/**
 * A slash command the agent offers: one of its own (/compact), a custom command or prompt
 * template, or a skill. Send it as the text "/name args"; the session runs it the agent's way.
 */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind: "command" | "skill";
}

export interface RuntimeSession {
  readonly provider: ProviderId;
  readonly handle: ResumeHandle | null;
  readonly state: SessionState;
  readonly activeTurnId: string | null;
  /**
   * Whether the runtime itself shows a turn as accepted or running, apart from
   * our write. Only an adapter that sees the runtime's own turn lifecycle has it (Codex's
   * turn/start answer and turn/started, Pi's prompt answer and agent_start); undefined otherwise.
   */
  readonly liveTurn?: boolean;
  /** Whether the runtime's process is still running; undefined when the adapter can't tell. */
  alive(): boolean | undefined;
  /** Signals the runtime's process at once, without waiting for its turn. */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  /**
   * Gives up the running turn without asking the runtime, which never showed it: it ends as
   * canceled, and the next input starts a new one.
   */
  abandonTurn(): void;
  /** The slash commands this session's agent runs when sent "/name args". */
  commands(): Promise<SlashCommand[]>;
  send(input: UserInput, options: SendOptions): Promise<SendResult>;
  /** Stops the running turn; resolves once it has ended (null when nothing was running). */
  interrupt(): Promise<{ canceledTurnId: string | null }>;
  usage(): ContextUsage | null;
  close(): Promise<void>;
  on(listener: (event: RuntimeEvent) => void): () => void;
}

// ------------------------------------------------------------------ adapters

export interface ModelDef {
  id: string;
  label: string;
  isDefault?: boolean;
  thinkingOptions?: { id: string; label: string; isDefault?: boolean }[];
}

export interface ModeDef {
  id: string;
  label: string;
  description?: string;
}

export interface ProbeResult {
  installed: boolean;
  version?: string;
  /** Whether the CLI has a usable login of its own. */
  auth: "ok" | "logged_out" | "unknown";
  diagnostic?: string;
}

export interface RuntimeCapabilities {
  /** Mid-turn input that joins the running turn. */
  steer: boolean;
  /** Where a steer lands: right away, or after the running tool call(s). */
  steerLands: "next_step" | "after_tool";
  /** Whether input_accepted is a real signal for steers (otherwise it fires at queue time). */
  steerAcceptance: "delivered" | "queued";
  images: boolean;
  /** The agent has a tool to start sub-agents of its own. */
  subAgents: boolean;
  /**
   * A resumed session keeps the system prompt it started with and ignores the one passed at
   * resume (Claude Code, Codex). The others take it again on every open.
   */
  keepsPromptOnResume: boolean;
  /** The adapter hands `SessionSpec.extraDirectories` to the CLI (Claude's additionalDirectories); the others ignore it, and their agents reach those folders by path. */
  additionalDirectories: boolean;
  /** Context compaction shows up as a `compaction` item. */
  reportsCompaction: boolean;
  /** The agent's own tool for asking the user a question, which comes as an approval of kind "question" (questions.ts). */
  questionTool?: string;
}

export interface RuntimeAdapter {
  readonly id: ProviderId;
  readonly label: string;
  readonly capabilities: RuntimeCapabilities;
  probe(): Promise<ProbeResult>;
  models(): Promise<ModelDef[]>;
  modes(): ModeDef[];
  /** Opens a new session, or resumes `spec.resume`. */
  open(spec: SessionSpec): Promise<RuntimeSession>;
}
