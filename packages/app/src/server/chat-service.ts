import { createHash, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { ApprovalDecision, ApprovalRequest, ContextUsage, ProviderId, ResumeHandle, RuntimeAdapter, RuntimeEvent, RuntimeSession, SendResult, SessionSpec, SlashCommand, TimelineItem } from "@pocket-bots/runtime";
import type { ChatSnapshot, ChatStatus, TimelineCursor, TimelineEntry, TimelinePage } from "../shared/chat-types";
import { TIMELINE_INDEX_CHARS, type Db } from "./db";
import { RequestError } from "./errors";
import { ftsFilter } from "./search";
import {
  BUSY_STALE_MS,
  COMPACTION_LEDGER_RUNTIMES,
  COMPACTION_STALE_MS,
  countCompactionFailure,
  PROGRESS_CHECK_MS,
  RUNTIME_PROGRESS_STALE_MS,
  RUNTIME_START_TIMEOUT_MS,
  sessionNeedsReset,
  sessionResetText,
  StartCoordinator,
  stallText,
  STALLED_RECOVERY_SIGTERM_TIMEOUT_MS,
  startTimeoutText,
  TURN_START_OBSERVATION_MS,
  type CompactionFailures,
} from "./supervision";

// pocket-bots's chats. Each chat is a row in SQLite
// with its timeline; its runtime session is opened when a message goes out and resumed from the
// stored handle after it was closed (idle, crash, restart). Every runtime event is committed
// before the UI hears about it.
//
// The features built on the chats (daily log, journal, routines, queue, ask_bot answers,
// groups) listen to its events.
//
// It also watches over the runtimes (supervision.ts): starts wait their turn
// and carry what arrives meanwhile, a start that shows nothing fails, a turn the runtime never
// shows is given up, a stalled run whose process is gone is restarted, and a session whose
// compaction keeps failing isn't resumed.

/** A chat whose turn is in progress. */
export function isBusy(status: ChatSnapshot["status"]): boolean {
  return status === "running" || status === "initializing";
}

export type TurnOutcome = { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };

export interface TurnEndedEvent {
  agent: ChatSnapshot;
  outcome: TurnOutcome;
  /** The chat's latest timeline items, oldest first. */
  timeline: TimelineItem[];
  /** True when the turn ended while pocket-bots wasn't running. */
  missed: boolean;
  /**
   * Ended by pocket-bots's supervision, not the runtime: its start never showed a runtime event
   * (`start_failed`, also told as start.failed), or the run stalled and was restarted (`stalled`;
   * what it hadn't taken in goes out again).
   */
  supervision?: "start_failed" | "stalled";
}

export interface ChatEvents {
  "turn.started": { agent: ChatSnapshot };
  "turn.ended": TurnEndedEvent;
  "permission.requested": { agent: ChatSnapshot; request: ApprovalRequest };
  /**
   * An approval stopped waiting: the user answered it (`answered`, wherever they did), its turn
   * ended (`ended`), or its chat closed (`closed`). Comes after its permission.requested.
   */
  "permission.resolved": { chatId: string; requestId: string; decision: ApprovalDecision; reason: "answered" | "ended" | "closed" };
  /** Any change, for live UI updates. */
  "agent.updated": ChatSnapshot;
  /** The same change once its turn and permission events were handled. */
  "agent.settled": ChatSnapshot;
  "agent.removed": { agentId: string };
  /** The chat's timeline changed. */
  timeline: { chatId: string };
  /** A message reached the model's context (a steer: the running turn). */
  "input.accepted": { chatId: string; clientMessageId: string; as: "turn" | "steer" };
  /**
   * The chat's runtime session was opened: a new one, or `resumed` from its stored handle.
   * `reportsCompaction`: the runtime shows its context compactions.
   */
  "session.opened": { chatId: string; resumed: boolean; reportsCompaction: boolean };
  /** The chat's model context was compacted (a new `compaction` item). */
  compaction: { chatId: string };
  /** A start showed its first runtime event: it's ready. */
  "start.ready": { chatId: string };
  /** A start failed: the runtime didn't open, didn't take the first input, or showed nothing within RUNTIME_START_TIMEOUT_MS. */
  "start.failed": { chatId: string; error: string };
  /** The stored session wasn't resumed: its compaction failed `failures` times in a row; a new one started. */
  "session.reset": { chatId: string; failures: number };
}

type Handler<K extends keyof ChatEvents> = (event: ChatEvents[K]) => void | Promise<void>;

export interface NewChat {
  id?: string;
  botId: string | null;
  provider: ProviderId;
  model?: string | null;
  thinking?: string | null;
  mode?: string | null;
  cwd: string;
  title?: string | null;
  labels?: Record<string, string>;
}

export interface OutgoingMessage {
  text: string;
  images?: { data: string; mimeType: string }[];
  clientMessageId?: string;
}

/** A message a search found: where it is (its chat and its timeline item's first seq) and its text. */
export interface ChatSearchHit {
  chatId: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface ChatRecord {
  id: string;
  botId: string | null;
  provider: ProviderId;
  model: string | null;
  thinking: string | null;
  mode: string | null;
  cwd: string;
  title: string | null;
  labels: Record<string, string>;
}

/**
 * What the app adds to a chat's session each time it opens: prompt, tools, approvals it trusts.
 * `standingPrompt` is the prompt without what changes from day to day (memory, recent work): on
 * a runtime that keeps a resumed session's first prompt, a change to it is delivered with the
 * first input after the resume (see standingPromptUpdate).
 */
export type SpecBuilder = (chat: ChatRecord) => Promise<Pick<SessionSpec, "systemPrompt" | "mcpServers" | "trustedTools"> & Partial<Pick<SessionSpec, "env" | "extraDirectories" | "hostedMcpServers">> & { standingPrompt?: string }>;
/** Answers an approval without the user (a saved command), or null to ask them. */
export type ApprovalPolicy = (chat: ChatSnapshot, request: ApprovalRequest) => Promise<ApprovalDecision | null>;

export interface ChatServiceOptions {
  /** The start queue's limits (supervision.ts has the defaults); tests set their own. */
  maxConcurrentStarts?: number;
  startIntervalMs?: number;
}

type WhenBusy = "steer" | "interrupt" | "queue" | "reject";

interface ChatRow {
  id: string;
  bot_id: string | null;
  provider: string;
  model: string | null;
  thinking: string | null;
  mode: string | null;
  cwd: string;
  title: string | null;
  labels: string;
  resume: string | null;
  status: string;
  last_error: string | null;
  last_usage: string | null;
  attention: string | null;
  attention_at: string | null;
  seq: number;
  created_at: string;
  updated_at: string;
  last_user_message_at: string | null;
  archived_at: string | null;
  standing_prompt: string | null;
  compaction_failures: string | null;
}

interface TimelineRow {
  key: string;
  seq_start: number;
  seq_end: number;
  turn_id: string | null;
  ts: string;
  item: string;
}

/** A message on its way to a chat's runtime; `aliases` are the messages carried in with it under its id. */
interface Outgoing {
  message: OutgoingMessage;
  clientMessageId: string;
  whenBusy: WhenBusy;
  aliases: string[];
}

/** What a start ends with for every message it carried: the first input's result, or why it failed. */
interface StartDone {
  session: RuntimeSession | null;
  result: SendResult | null;
  error: string | null;
}

/**
 * One start of a chat's runtime, from the queue to its readiness: queued for a
 * slot, opening the session, writing the first input, then waiting for the first runtime event.
 * What's sent while it's queued or opening is carried into the first input.
 */
interface Start {
  chatId: string;
  carried: Outgoing[];
  phase: "queued" | "opening" | "writing" | "waiting" | "done";
  failed: string | null;
  deadline: ReturnType<typeof setTimeout> | null;
  expired: Promise<null>;
  expire: () => void;
  done: Promise<StartDone>;
}

interface Live {
  session: RuntimeSession;
  off: () => void;
  lastActive: number;
  /** Runtime progress: the last runtime event (not our own turn_started or session_ready), and when the running turn started. */
  lastEventAt: number;
  turnStartedAt: number | null;
  /** The start this session belongs to, until it shows a runtime event. */
  start: Start | null;
  /** Written and not yet taken in by the runtime: what a stalled run's restart sends again. */
  unaccepted: Map<string, Outgoing & { as: "turn" | "steer" | "queued" }>;
  /** Messages carried in under another's id: told as accepted with it. */
  aliases: Map<string, string[]>;
  /** This quiet stretch was already recorded (a live, silent runtime is recorded once). */
  stallNoted: boolean;
  /** The compaction whose finish hasn't been seen, and the timer that says so (COMPACTION_STALE_MS). */
  compaction: { key: string; timer: ReturnType<typeof setTimeout> } | null;
}

const EPOCH = "1";
const TITLE_MAX = 200;
const IDLE_CLOSE_MS = 15 * 60_000;
const TURN_TAIL = 120;
const STREAM_FLUSH_MS = 120;

const now = () => new Date().toISOString();
/** The JSON path of a label in a chat's labels. */
const labelPath = (key: string) => `$."${key.replace(/"/g, "")}"`;

/** The standing prompt's hash: what a chat's session runs on, recorded per session. */
export const standingPromptHash = (prompt: string) => createHash("sha256").update(prompt).digest("hex").slice(0, 32);

/**
 * The standing-prompt update: the current standing prompt in front of a resumed session's first input, replacing the one the session
 * started with. Nothing earlier in the conversation changes, so the prompt cache stays valid.
 */
export function standingPromptUpdate(standingPrompt: string): string {
  return [
    "<pocket-bots-standing-prompt-update>",
    "pocket-bots updated your standing instructions since this session started. The instructions below replace the earlier standing instructions (system or developer prompt) for the rest of this session; where they differ, follow these.",
    "",
    standingPrompt,
    "</pocket-bots-standing-prompt-update>",
    "",
    "",
  ].join("\n");
}

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "New chat";
}

export class ChatService {
  private readonly handlers: { [K in keyof ChatEvents]: Handler<K>[] } = {
    "turn.started": [],
    "turn.ended": [],
    "permission.requested": [],
    "permission.resolved": [],
    "agent.updated": [],
    "agent.settled": [],
    "agent.removed": [],
    timeline: [],
    "input.accepted": [],
    "session.opened": [],
    compaction: [],
    "start.ready": [],
    "start.failed": [],
    "session.reset": [],
  };
  private readonly live = new Map<string, Live>();
  /** Starts queued, opening or writing their first input, by chat. */
  private readonly starts = new Map<string, Start>();
  /** The start queue, for every chat in the process. */
  private readonly coordinator: StartCoordinator;
  private readonly approvals = new Map<string, Map<string, { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void }>>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly streamBuffer = new Map<string, Map<string, { item: TimelineItem; turnId: string | null }>>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per open session: the standing prompt hash to record once the runtime names its session, and the update its first input owes. */
  private readonly standing = new Map<string, { hash: string; update: string | null; resumed: string | null }>();
  private reaper: ReturnType<typeof setInterval> | null = null;
  private progressCheck: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly runtimes: ReadonlyMap<ProviderId, RuntimeAdapter>,
    private readonly specFor: SpecBuilder,
    private readonly policy: ApprovalPolicy,
    options: ChatServiceOptions = {},
  ) {
    this.coordinator = new StartCoordinator(options.maxConcurrentStarts, options.startIntervalMs);
  }

  /** Adds a handler; returns a function that removes it. */
  on<K extends keyof ChatEvents>(name: K, handler: Handler<K>): () => void {
    this.handlers[name].push(handler);
    return () => {
      const list = this.handlers[name];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  }

  /** Marks turns that were running when the last process stopped, and starts closing idle sessions. */
  start(): void {
    const stuck = this.db.all<ChatRow>("SELECT * FROM chats WHERE status IN ('running', 'initializing')");
    for (const row of stuck) {
      this.db.tx(() => {
        this.db.run("UPDATE turns SET ended_at = ?, outcome = 'failed', error = ? WHERE chat_id = ? AND ended_at IS NULL", now(), "pocket-bots stopped during this turn.", row.id);
        this.writeItem(row.id, `notice:${randomUUID()}`, null, { type: "notification", level: "warning", message: "pocket-bots stopped while this turn was running." });
        this.db.run("UPDATE chats SET status = 'idle', updated_at = ? WHERE id = ?", now(), row.id);
      });
    }
    this.reaper = setInterval(() => void this.closeIdle(), 60_000);
    this.reaper.unref();
    // The activity heartbeat, which looks for stalled runs (checkProgress).
    this.progressCheck = setInterval(() => this.checkProgress(), PROGRESS_CHECK_MS);
    this.progressCheck.unref();
  }

  async stop(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    if (this.progressCheck) clearInterval(this.progressCheck);
    for (const start of [...this.starts.values()]) this.cancelStart(start, "pocket-bots stopped.");
    this.coordinator.cancelAll("pocket-bots stopped.");
    await Promise.all([...this.live.keys()].map((chatId) => this.closeSession(chatId)));
  }

  // ---------------------------------------------------------------- reading

  get(chatId: string): ChatSnapshot | null {
    const row = this.db.get<ChatRow>("SELECT * FROM chats WHERE id = ?", chatId);
    return row ? this.snapshot(row) : null;
  }

  record(chatId: string): ChatRecord | null {
    const row = this.db.get<ChatRow>("SELECT * FROM chats WHERE id = ?", chatId);
    return row ? this.recordOf(row) : null;
  }

  /**
   * The user's and the bot's messages that contain every term, newest first: in one chat, or in
   * the chats (archived ones too) with all of `labels` and none of `withoutLabels`. What changed
   * since the last search is indexed first.
   */
  search(terms: readonly string[], scope: { chatId?: string; labels?: Record<string, string>; withoutLabels?: readonly string[]; limit?: number }): ChatSearchHit[] {
    if (terms.length === 0) return [];
    this.indexChanges(scope.chatId);
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    const full = ftsFilter(terms, "timeline_fts", "f.text");
    where.push(...full.where);
    params.push(...full.params);
    if (scope.chatId) {
      where.push("f.chat_id = ?");
      params.push(scope.chatId);
    }
    for (const [key, value] of Object.entries(scope.labels ?? {})) {
      where.push("json_extract(c.labels, ?) = ?");
      params.push(labelPath(key), value);
    }
    for (const key of scope.withoutLabels ?? []) {
      where.push("json_extract(c.labels, ?) IS NULL");
      params.push(labelPath(key));
    }
    const limit = Math.max(1, Math.min(scope.limit ?? 50, 500));
    const rows = this.db.all<{ chat_id: string; seq: number; text: string; ts: string; item: string }>(
      `SELECT f.chat_id, f.seq, f.text, t.ts, t.item FROM timeline_fts f JOIN timeline t ON t.rowid = f.rowid JOIN chats c ON c.id = f.chat_id WHERE ${where.join(" AND ")} ORDER BY t.ts DESC, t.seq_start DESC LIMIT ?`,
      ...params,
      limit,
    );
    return rows.map((row) => ({ chatId: row.chat_id, seq: Number(row.seq), role: (JSON.parse(row.item) as TimelineItem).type === "assistant_message" ? "assistant" : "user", text: row.text, at: row.ts }));
  }

  /**
   * Brings the search index up to the chats' timelines: every message written since a chat's
   * indexed_seq. A reply still streaming is indexed as far as it's stored; what's still in the
   * stream buffer comes in with the next search.
   */
  private indexChanges(chatId?: string): void {
    const stale = this.db.all<{ id: string }>(`SELECT id FROM chats WHERE seq > indexed_seq${chatId ? " AND id = ?" : ""}`, ...(chatId ? [chatId] : []));
    for (const { id } of stale) {
      this.db.tx(() => {
        const chat = this.db.get<{ seq: number; indexed_seq: number }>("SELECT seq, indexed_seq FROM chats WHERE id = ?", id);
        if (!chat) return;
        const rows = this.db.all<{ rowid: number; seq_start: number; item: string }>("SELECT rowid, seq_start, item FROM timeline WHERE chat_id = ? AND seq_end > ?", id, chat.indexed_seq);
        for (const row of rows) {
          this.db.run("DELETE FROM timeline_fts WHERE rowid = ?", row.rowid);
          const item = JSON.parse(row.item) as TimelineItem;
          if ((item.type === "user_message" || item.type === "assistant_message") && item.text) {
            this.db.run("INSERT INTO timeline_fts (rowid, text, chat_id, seq) VALUES (?, ?, ?, ?)", row.rowid, item.text.slice(0, TIMELINE_INDEX_CHARS), id, row.seq_start);
          }
        }
        this.db.run("UPDATE chats SET indexed_seq = ? WHERE id = ?", chat.seq, id);
      });
    }
  }

  /** Chats whose labels include every given one, newest activity first. */
  list(filter: { labels?: Record<string, string>; includeArchived?: boolean; limit?: number } = {}): ChatSnapshot[] {
    const where: string[] = [];
    const params: string[] = [];
    for (const [key, value] of Object.entries(filter.labels ?? {})) {
      where.push("json_extract(labels, ?) = ?");
      params.push(labelPath(key), value);
    }
    if (!filter.includeArchived) where.push("archived_at IS NULL");
    const sql = `SELECT * FROM chats ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(filter.limit ?? 2000, 5000))}`;
    return this.db.all<ChatRow>(sql, ...params).map((row) => this.snapshot(row));
  }

  /** The chat's latest timeline items, oldest first. */
  items(chatId: string, limit = TURN_TAIL): TimelineItem[] {
    this.flush(chatId);
    return this.db
      .all<TimelineRow>("SELECT item FROM timeline WHERE chat_id = ? ORDER BY seq_start DESC LIMIT ?", chatId, limit)
      .reverse()
      .map((row) => JSON.parse(row.item) as TimelineItem);
  }

  timeline(chatId: string, input: { direction: "tail" | "before" | "after"; cursor?: TimelineCursor; limit?: number }): TimelinePage {
    this.flush(chatId);
    const row = this.db.get<ChatRow>("SELECT * FROM chats WHERE id = ?", chatId);
    if (!row) return { entries: [], startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, agent: null, error: "This chat doesn't exist." };
    const limit = Math.max(1, Math.min(input.limit ?? 80, 500));
    const agent = this.snapshot(row);
    if (input.cursor && input.cursor.epoch !== EPOCH) return { entries: [], startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, staleCursor: true, agent };
    let rows: TimelineRow[];
    if (input.direction === "after" && input.cursor) {
      rows = this.db.all<TimelineRow>("SELECT * FROM timeline WHERE chat_id = ? AND seq_end > ? ORDER BY seq_end ASC LIMIT ?", chatId, input.cursor.seq, limit);
      const end = rows.length ? rows[rows.length - 1]!.seq_end : input.cursor.seq;
      const newer = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM timeline WHERE chat_id = ? AND seq_end > ?", chatId, end)!.n > 0;
      rows.sort((a, b) => a.seq_start - b.seq_start);
      return { entries: rows.map((r) => this.entry(row.provider as ProviderId, r)), startCursor: rows.length ? { epoch: EPOCH, seq: rows[0]!.seq_start } : null, endCursor: { epoch: EPOCH, seq: end }, hasOlder: false, hasNewer: newer, agent };
    }
    if (input.direction === "before" && input.cursor) {
      rows = this.db.all<TimelineRow>("SELECT * FROM timeline WHERE chat_id = ? AND seq_start < ? ORDER BY seq_start DESC LIMIT ?", chatId, input.cursor.seq, limit).reverse();
    } else {
      rows = this.db.all<TimelineRow>("SELECT * FROM timeline WHERE chat_id = ? ORDER BY seq_start DESC LIMIT ?", chatId, limit).reverse();
    }
    const first = rows[0]?.seq_start;
    const older = first !== undefined && this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM timeline WHERE chat_id = ? AND seq_start < ?", chatId, first)!.n > 0;
    return {
      entries: rows.map((r) => this.entry(row.provider as ProviderId, r)),
      startCursor: first !== undefined ? { epoch: EPOCH, seq: first } : null,
      endCursor: { epoch: EPOCH, seq: row.seq },
      hasOlder: older,
      hasNewer: false,
      agent,
    };
  }

  // ---------------------------------------------------------------- writing

  /** Creates a chat and, when given one, sends its first message. */
  async create(input: NewChat, first?: OutgoingMessage): Promise<string> {
    if (!this.runtimes.has(input.provider)) throw new RequestError(`${input.provider} isn't available here.`);
    const id = input.id ?? randomUUID();
    const at = now();
    const title = (input.title ?? (first ? titleFrom(first.text) : null))?.slice(0, TITLE_MAX) ?? null;
    this.db.run(
      `INSERT INTO chats (id, bot_id, provider, model, thinking, mode, cwd, title, labels, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
      id,
      input.botId,
      input.provider,
      input.model ?? null,
      input.thinking ?? null,
      input.mode ?? null,
      input.cwd,
      title,
      JSON.stringify(input.labels ?? {}),
      at,
      at,
    );
    this.updated(id);
    if (first) {
      const result = await this.send(id, first, "reject");
      if (!result.ok) throw new Error(`The chat couldn't start: ${result.detail ?? result.reason}`);
    }
    return id;
  }

  /**
   * Sends a message; while a turn runs it steers (default), interrupts, queues or is rejected. A
   * chat without a running session starts one (startSession); a message sent while that start is
   * queued or opening goes in with its first input.
   */
  async send(chatId: string, message: OutgoingMessage, whenBusy: WhenBusy = "steer"): Promise<SendResult> {
    const row = this.db.get<ChatRow>("SELECT * FROM chats WHERE id = ?", chatId);
    if (!row) return { ok: false, reason: "closed", detail: "This chat doesn't exist." };
    if (row.archived_at) this.db.run("UPDATE chats SET archived_at = NULL WHERE id = ?", chatId);
    const outgoing: Outgoing = { message, clientMessageId: message.clientMessageId ?? randomUUID(), whenBusy, aliases: [] };
    let result: SendResult;
    const start = this.starts.get(chatId);
    if (start && (start.phase === "queued" || start.phase === "opening")) {
      start.carried.push(outgoing);
      result = startResult(await start.done);
    } else {
      // A start writing its first input goes first; what follows goes to its session.
      if (start) await start.done;
      const live = this.live.get(chatId);
      if (live && live.session.state !== "closed") result = await this.write(chatId, live.session, outgoing, false);
      else if (start) result = startResult(await start.done);
      else result = startResult(await this.startSession(row, [outgoing]).done);
    }
    if (result.ok) {
      this.db.run("UPDATE chats SET last_user_message_at = ?, attention = NULL, last_error = CASE WHEN status = 'error' THEN NULL ELSE last_error END, updated_at = ? WHERE id = ?", now(), now(), chatId);
      this.touch(chatId);
      this.updated(chatId);
    }
    return result;
  }

  /** The slash commands the chat's agent offers; opens (or resumes) its session to ask. */
  async commands(chatId: string): Promise<SlashCommand[]> {
    const row = this.db.get<ChatRow>("SELECT * FROM chats WHERE id = ?", chatId);
    if (!row) throw new RequestError("This chat doesn't exist.");
    const session = await this.session(row);
    this.touch(chatId);
    return session.commands();
  }

  async interrupt(chatId: string): Promise<boolean> {
    const live = this.live.get(chatId);
    if (!live?.session.activeTurnId) return false;
    await live.session.interrupt();
    return true;
  }

  async respond(chatId: string, requestId: string, decision: ApprovalDecision): Promise<boolean> {
    const pending = this.approvals.get(chatId)?.get(requestId);
    if (!pending) return false;
    this.approvals.get(chatId)!.delete(requestId);
    pending.resolve(decision);
    this.db.run("UPDATE chats SET attention = NULL WHERE id = ? AND attention = 'permission'", chatId);
    this.updated(chatId);
    void this.emitSerial(chatId, "permission.resolved", { chatId, requestId, decision, reason: "answered" });
    return true;
  }

  /**
   * Answers the approvals still waiting that the policy allows now (the user just trusted a folder
   * or saved a command), as it would have had the rule been there when they were asked.
   */
  async reapprove(): Promise<number> {
    let answered = 0;
    for (const [chatId, waiting] of this.approvals) {
      const agent = this.get(chatId);
      if (!agent) continue;
      for (const [requestId, { request }] of [...waiting]) {
        const automatic = await this.policy(agent, request).catch(() => null);
        if (automatic && (await this.respond(chatId, requestId, automatic))) answered++;
      }
    }
    return answered;
  }

  async archive(chatId: string): Promise<void> {
    await this.closeSession(chatId);
    this.db.run("UPDATE chats SET archived_at = ?, updated_at = ? WHERE id = ?", now(), now(), chatId);
    this.updated(chatId);
  }

  async remove(chatId: string): Promise<void> {
    await this.closeSession(chatId);
    this.db.tx(() => {
      this.db.run("DELETE FROM timeline WHERE chat_id = ?", chatId);
      this.db.run("DELETE FROM turns WHERE chat_id = ?", chatId);
      this.db.run("DELETE FROM chats WHERE id = ?", chatId);
    });
    void this.emitSerial(chatId, "agent.removed", { agentId: chatId });
  }

  setTitle(chatId: string, title: string): void {
    this.db.run("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?", title.slice(0, TITLE_MAX), now(), chatId);
    this.updated(chatId);
  }

  /** The user looked at the chat. */
  clearAttention(chatId: string): void {
    this.db.run("UPDATE chats SET attention = NULL WHERE id = ? AND attention IN ('finished', 'error')", chatId);
    this.updated(chatId);
  }

  /** Resolves once the chat's running turn ends, or after `timeoutMs`. */
  waitForFinish(chatId: string, timeoutMs: number): Promise<ChatSnapshot | null> {
    const current = this.get(chatId);
    if (!current || current.status !== "running") return Promise.resolve(current);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        done();
        resolve(this.get(chatId));
      }, timeoutMs);
      const handler: Handler<"agent.settled"> = (agent) => {
        if (agent.id !== chatId || agent.status === "running") return;
        clearTimeout(timer);
        done();
        resolve(agent);
      };
      const done = () => {
        const list = this.handlers["agent.settled"];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
      this.handlers["agent.settled"].push(handler);
    });
  }

  // ---------------------------------------------------------------- sessions

  private recordOf(row: ChatRow): ChatRecord {
    return { id: row.id, botId: row.bot_id, provider: row.provider as ProviderId, model: row.model, thinking: row.thinking, mode: row.mode, cwd: row.cwd, title: row.title, labels: JSON.parse(row.labels) };
  }

  /** The chat's running session, or the one a start (its own, if none is under way) opens. */
  private async session(row: ChatRow): Promise<RuntimeSession> {
    const live = this.live.get(row.id);
    const start = this.starts.get(row.id);
    if (!start && live && live.session.state !== "closed") return live.session;
    const done = await (start ?? this.startSession(row, [])).done;
    if (!done.session) throw new Error(done.error ?? "The chat couldn't start.");
    return done.session;
  }

  /** Starts the chat's runtime with these messages as its first input (none: just open it). */
  private startSession(row: ChatRow, carried: Outgoing[]): Start {
    let expire!: () => void;
    const expired = new Promise<null>((resolve) => (expire = () => resolve(null)));
    const start: Start = { chatId: row.id, carried, phase: "queued", failed: null, deadline: null, expired, expire, done: null as never };
    this.starts.set(row.id, start);
    start.done = this.runStart(row, start).finally(() => {
      if (this.starts.get(row.id) === start) this.starts.delete(row.id);
    });
    return start;
  }

  /**
   * A start, from the queue to the first runtime event: wait for a slot (StartCoordinator),
   * open the session and write the first input before RUNTIME_START_TIMEOUT_MS has passed since
   * the slot was claimed, then hold the slot no longer; the first runtime event settles it
   * (onEvent), or the deadline fails it.
   */
  private async runStart(row: ChatRow, start: Start): Promise<StartDone> {
    let release: (() => void) | null = null;
    try {
      release = await this.coordinator.acquire(row.id);
    } catch (error) {
      return this.failStart(start, errorText(error));
    }
    try {
      if (start.failed) return { session: null, result: null, error: start.failed };
      start.phase = "opening";
      start.deadline = setTimeout(() => this.startExpired(start), RUNTIME_START_TIMEOUT_MS);
      start.deadline.unref?.();
      const label = this.label(row.provider);
      let session: RuntimeSession | null;
      try {
        session = await Promise.race([this.open(row, start), start.expired]);
      } catch (error) {
        return this.failStart(start, errorText(error));
      }
      if (!session) return this.failStart(start, startTimeoutText(label));
      if (start.failed) return { session: null, result: null, error: start.failed };
      start.phase = "writing";
      const input = carriedInput(start.carried);
      if (!input) {
        // Opened to ask it something (its commands): there's no input whose start to wait for.
        this.startReady(start);
        return { session, result: null, error: null };
      }
      let result: SendResult | null;
      try {
        result = await Promise.race([this.write(row.id, session, input, true), start.expired]);
      } catch (error) {
        return this.failStart(start, errorText(error));
      }
      if (start.failed) return { session: null, result: null, error: start.failed };
      if (!result) return this.failStart(start, startTimeoutText(label));
      if (!result.ok && (result.reason === "error" || result.reason === "closed")) return this.failStart(start, result.detail ?? `${label} didn't take the first message (${result.reason}).`);
      if (start.phase === "writing") start.phase = "waiting";
      // Nothing running means nothing more to show (a turn that ended already, or a message that started none).
      if (!session.activeTurnId) this.startReady(start);
      return { session, result, error: null };
    } finally {
      release?.();
    }
  }

  /** The start's runtime showed an event: it started. */
  private startReady(start: Start): void {
    if (start.phase === "done") return;
    start.phase = "done";
    if (start.deadline) clearTimeout(start.deadline);
    start.deadline = null;
    const live = this.live.get(start.chatId);
    if (live?.start === start) live.start = null;
    this.emitNow("start.ready", { chatId: start.chatId });
  }

  /** RUNTIME_START_TIMEOUT_MS since the slot was claimed, and no runtime event. */
  private startExpired(start: Start): void {
    start.deadline = null;
    if (start.phase === "done") return;
    const row = this.db.get<{ provider: string }>("SELECT provider FROM chats WHERE id = ?", start.chatId);
    // Opening or writing: runStart is waiting on `expired`, and fails the start itself.
    if (start.phase === "waiting") this.failStart(start, startTimeoutText(this.label(row?.provider ?? "")));
    start.expire();
  }

  /**
   * A start that failed: its runtime didn't open, didn't take the first input, or showed nothing
   * in time, or the chat closed first. A session it opened is ended (SIGTERM), and the turn
   * its first input started is failed here; the chat shows the error, and start.failed tells the
   * rest (a group routes it as a seat that couldn't start).
   */
  private failStart(start: Start, error: string): StartDone {
    if (start.phase === "done") return { session: null, result: null, error: start.failed ?? error };
    start.phase = "done";
    start.failed = error;
    if (start.deadline) clearTimeout(start.deadline);
    start.deadline = null;
    start.expire();
    this.coordinator.cancel(start.chatId, error);
    if (this.starts.get(start.chatId) === start) this.starts.delete(start.chatId);
    const live = this.live.get(start.chatId);
    let turnId: string | null = null;
    if (live?.start === start) {
      turnId = live.session.activeTurnId;
      this.drop(start.chatId, live);
      live.session.kill("SIGTERM");
      void live.session.close().catch(() => undefined);
    }
    if (this.db.get("SELECT 1 AS found FROM chats WHERE id = ?", start.chatId)) {
      this.writeItem(start.chatId, `notice:${randomUUID()}`, null, { type: "error", message: error });
      this.pingTimeline(start.chatId);
      if (turnId) this.turnEnded(start.chatId, { type: "turn_ended", turnId, outcome: "failed", error }, "start_failed");
      else {
        this.db.run("UPDATE chats SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?", error, now(), start.chatId);
        this.updated(start.chatId);
      }
    }
    this.emitNow("start.failed", { chatId: start.chatId, error });
    return { session: null, result: null, error };
  }

  /** Forgets a chat's session without closing it: its events stop reaching the chat. */
  private drop(chatId: string, live: Live): void {
    if (this.live.get(chatId) === live) this.live.delete(chatId);
    live.off();
    if (live.compaction) clearTimeout(live.compaction.timer);
    live.compaction = null;
    this.standing.delete(chatId);
  }

  private label(provider: string): string {
    return this.runtimes.get(provider as ProviderId)?.label ?? provider;
  }

  /** The stored session can't be resumed: its compaction failed SESSION_NEEDS_RESET_THRESHOLD times in a row. */
  sessionNeedsReset(chatId: string): boolean {
    const row = this.db.get<ChatRow>("SELECT * FROM chats WHERE id = ?", chatId);
    return !!row && this.resetFailures(row) !== null;
  }

  private resetFailures(row: ChatRow): number | null {
    if (!row.resume || !COMPACTION_LEDGER_RUNTIMES.has(row.provider)) return null;
    const resume = JSON.parse(row.resume) as ResumeHandle;
    return sessionNeedsReset(compactionFailures(row.compaction_failures), resume.sessionId, row.model);
  }

  private async open(row: ChatRow, start: Start): Promise<RuntimeSession> {
    const adapter = this.runtimes.get(row.provider as ProviderId);
    if (!adapter) throw new Error(`${row.provider} isn't available here.`);
    const record = this.recordOf(row);
    const { standingPrompt, ...extra } = await this.specFor(record);
    let resume = row.resume ? (JSON.parse(row.resume) as ResumeHandle) : undefined;
    // A session whose compaction keeps failing isn't resumed (every resume would fail the same
    // way): a new one starts instead, and the chat says so.
    const reset = this.resetFailures(row);
    if (reset !== null) {
      resume = undefined;
      this.db.run("UPDATE chats SET compaction_failures = NULL WHERE id = ?", row.id);
      this.writeItem(row.id, `notice:${randomUUID()}`, null, { type: "notification", level: "warning", message: sessionResetText(adapter.label, reset) });
      this.pingTimeline(row.id);
    }
    const spec: SessionSpec = {
      key: row.id,
      cwd: row.cwd,
      ...(row.model ? { model: row.model } : {}),
      ...(row.thinking ? { thinking: row.thinking } : {}),
      ...(row.mode ? { mode: row.mode } : {}),
      ...extra,
      approvals: (request, signal) => this.approval(row.id, request, signal),
    };
    let session: RuntimeSession;
    try {
      session = await adapter.open(resume ? { ...spec, resume } : spec);
    } catch (error) {
      if (!resume || start.failed) throw error;
      // A session the runtime can't resume any more (gone, or from another version) starts over
      // rather than leaving the chat stuck; the chat says so.
      console.error(`pocket-bots: resuming chat ${row.id} failed; starting a new session`, error);
      resume = undefined;
      session = await adapter.open(spec);
      this.writeItem(row.id, `notice:${randomUUID()}`, null, { type: "notification", level: "warning", message: `The previous session couldn't be resumed (${error instanceof Error ? error.message : String(error)}), so this chat started a new one.` });
      this.pingTimeline(row.id);
    }
    // A start that failed (timed out, or its chat closed) while this opened: it's not wanted.
    if (start.failed) {
      void session.close().catch(() => undefined);
      throw new Error(start.failed);
    }
    const off = session.on((event) => this.onEvent(row.id, event));
    this.live.set(row.id, { session, off, lastActive: Date.now(), lastEventAt: Date.now(), turnStartedAt: null, start, unaccepted: new Map(), aliases: new Map(), stallNoted: false, compaction: null });
    this.standing.delete(row.id);
    if (standingPrompt !== undefined && adapter.capabilities.keepsPromptOnResume) this.planStanding(row, standingPrompt, resume?.sessionId ?? null);
    // Codex, Grok, OpenCode and Pi name their session while opening, before anyone listens: its
    // handle is taken from the session, or the chat could never be resumed.
    if (session.handle) this.handleEvent(row.id, { type: "session_ready", handle: session.handle });
    this.emitNow("session.opened", { chatId: row.id, resumed: !!resume, reportsCompaction: adapter.capabilities.reportsCompaction });
    if (reset !== null) this.emitNow("session.reset", { chatId: row.id, failures: reset });
    return session;
  }

  /**
   * The standing-prompt plan for a session just opened on a runtime that keeps a resumed
   * session's first prompt: a new session runs on the current standing prompt (recorded once the
   * runtime names it); a resumed one with no record of its own is recorded as it is (so
   * existing chats aren't all sent their prompt at once); one recorded on
   * another prompt owes the current one with its first input.
   */
  private planStanding(row: ChatRow, standingPrompt: string, resumed: string | null): void {
    const hash = standingPromptHash(standingPrompt);
    if (!resumed) {
      this.standing.set(row.id, { hash, update: null, resumed: null });
      return;
    }
    let recorded: { sessionId?: string; hash?: string } | null = null;
    try {
      recorded = row.standing_prompt ? JSON.parse(row.standing_prompt) : null;
    } catch {
      recorded = null;
    }
    if (!recorded || recorded.sessionId !== resumed) this.recordStanding(row.id, resumed, hash);
    else if (recorded.hash !== hash) this.standing.set(row.id, { hash, update: standingPromptUpdate(standingPrompt), resumed });
  }

  private recordStanding(chatId: string, sessionId: string, hash: string): void {
    this.db.run("UPDATE chats SET standing_prompt = ? WHERE id = ?", JSON.stringify({ sessionId, hash, recordedAt: now() }), chatId);
  }

  private touch(chatId: string): void {
    const live = this.live.get(chatId);
    if (live) live.lastActive = Date.now();
  }

  private async closeSession(chatId: string): Promise<void> {
    // A start still under way isn't wanted any more.
    const start = this.starts.get(chatId);
    if (start) this.cancelStart(start, "The chat was closed.");
    const live = this.live.get(chatId);
    if (!live) return;
    if (live.start) this.cancelStart(live.start, "The chat was closed.");
    this.live.delete(chatId);
    this.standing.delete(chatId);
    if (live.compaction) clearTimeout(live.compaction.timer);
    live.compaction = null;
    for (const [requestId, pending] of this.approvals.get(chatId) ?? []) {
      const decision: ApprovalDecision = { behavior: "deny", message: "The chat was closed." };
      pending.resolve(decision);
      void this.emitSerial(chatId, "permission.resolved", { chatId, requestId, decision, reason: "closed" });
    }
    this.approvals.delete(chatId);
    await live.session.close().catch(() => undefined);
    live.off();
  }

  /** A start given up without a failure of its runtime (its chat closed): it says nothing, and what it carried is told why. */
  private cancelStart(start: Start, reason: string): void {
    if (start.phase === "done") return;
    start.phase = "done";
    start.failed = reason;
    if (start.deadline) clearTimeout(start.deadline);
    start.deadline = null;
    start.expire();
    this.coordinator.cancel(start.chatId, reason);
    if (this.starts.get(start.chatId) === start) this.starts.delete(start.chatId);
    const live = this.live.get(start.chatId);
    if (live?.start === start) live.start = null;
  }

  private async closeIdle(): Promise<void> {
    const cutoff = Date.now() - IDLE_CLOSE_MS;
    for (const [chatId, live] of this.live) {
      if (live.session.state === "idle" && live.lastActive < cutoff && !live.start && !this.approvals.get(chatId)?.size) await this.closeSession(chatId);
    }
  }

  // ---------------------------------------------------------------- writing to a runtime

  /**
   * Writes one input to the chat's session. A resumed session still on an older standing prompt
   * gets the current one with its first input. An idle write to a runtime that shows its own
   * turns is watched (watchTurnStart); the start's first input has its own deadline instead.
   */
  private async write(chatId: string, session: RuntimeSession, input: Outgoing, inStart: boolean): Promise<SendResult> {
    const live = this.live.get(chatId);
    const owed = this.standing.get(chatId);
    const text = owed?.update ? `${owed.update}${input.message.text}` : input.message.text;
    const watch = !inStart && live && !session.activeTurnId && session.liveTurn !== undefined ? this.watchTurnStart(chatId, live) : null;
    // Recorded before the send: a runtime may take the input in before send() returns.
    const pending = { ...input, as: "turn" as "turn" | "steer" | "queued" };
    if (live) {
      if (input.aliases.length) live.aliases.set(input.clientMessageId, input.aliases);
      live.unaccepted.set(input.clientMessageId, pending);
    }
    const sending = session.send({ text, ...(input.message.images?.length ? { images: input.message.images } : {}) }, { whenBusy: input.whenBusy, clientMessageId: input.clientMessageId });
    const result = watch ? await Promise.race([sending, watch.idle]) : await sending;
    if (watch) {
      if (result.ok && result.as === "turn") watch.turnId = result.turnId;
      else watch.cancel();
    }
    if (result.ok && owed?.update) {
      this.recordStanding(chatId, session.handle?.sessionId ?? owed.resumed!, owed.hash);
      this.standing.delete(chatId);
    }
    if (live) {
      if (!result.ok) {
        if (live.unaccepted.get(input.clientMessageId) === pending) live.unaccepted.delete(input.clientMessageId);
        live.aliases.delete(input.clientMessageId);
      } else pending.as = result.as;
    }
    return result;
  }

  /**
   * The turn-start watch: "written" is not "running". After an idle write, a runtime that shows
   * its own turns (session.liveTurn) must show this one within TURN_START_OBSERVATION_MS, or the
   * chat returns to idle instead of waiting for a turn end that never comes. A send still waiting
   * on the runtime then fails (`idle`).
   */
  private watchTurnStart(chatId: string, live: Live): { idle: Promise<SendResult>; cancel: () => void; turnId: string | null } {
    const writtenAt = Date.now();
    let resolve!: (result: SendResult) => void;
    const watch = { idle: new Promise<SendResult>((done) => (resolve = done)), cancel: () => clearTimeout(timer), turnId: null as string | null };
    const timer = setTimeout(() => {
      const session = live.session;
      if (this.live.get(chatId) !== live || !session.activeTurnId) return;
      if (watch.turnId && session.activeTurnId !== watch.turnId) return;
      if (session.liveTurn !== false || live.lastEventAt > writtenAt) return;
      const row = this.db.get<{ provider: string }>("SELECT provider FROM chats WHERE id = ?", chatId);
      const detail = `${this.label(row?.provider ?? "")} didn't show this turn within ${TURN_START_OBSERVATION_MS / 1000} seconds, so the chat is idle again.`;
      console.warn(`pocket-bots: chat ${chatId}: turn start not observed`);
      this.writeItem(chatId, `notice:${randomUUID()}`, null, { type: "notification", level: "warning", message: detail });
      this.pingTimeline(chatId);
      resolve({ ok: false, reason: "error", detail });
      session.abandonTurn();
    }, TURN_START_OBSERVATION_MS);
    timer.unref?.();
    return watch;
  }

  // ---------------------------------------------------------------- stalled runs

  /**
   * The activity heartbeat, every PROGRESS_CHECK_MS: a
   * running turn with no runtime event for RUNTIME_PROGRESS_STALE_MS is looked at. Its process
   * gone, the run stalled and is restarted (recoverStalled). Alive (or the adapter can't tell),
   * it's only recorded, once; and a busy chat whose runtime shows no live turn missed its turn's
   * end, so it's idle again (clearStaleBusy). A turn waiting on the user's approval isn't stalled.
   */
  private checkProgress(): void {
    const at = Date.now();
    for (const [chatId, live] of [...this.live]) {
      if (!live.session.activeTurnId || live.start || this.approvals.get(chatId)?.size) {
        live.stallNoted = false;
        continue;
      }
      const quiet = at - Math.max(live.lastEventAt, live.turnStartedAt ?? 0);
      if (quiet < RUNTIME_PROGRESS_STALE_MS) {
        live.stallNoted = false;
        continue;
      }
      const alive = live.session.alive();
      if (alive === false) {
        this.recoverStalled(chatId, live, quiet);
        continue;
      }
      if (!live.stallNoted) {
        live.stallNoted = true;
        console.warn(`pocket-bots: chat ${chatId}: no runtime events for ${Math.floor(quiet / 60_000)}m; its process is ${alive ? "alive" : "of unknown state"}, so it's left running`);
      }
      if (live.session.liveTurn === false && quiet >= BUSY_STALE_MS) {
        const row = this.db.get<{ provider: string }>("SELECT provider FROM chats WHERE id = ?", chatId);
        this.writeItem(chatId, `notice:${randomUUID()}`, null, { type: "notification", level: "warning", message: `${this.label(row?.provider ?? "")} shows no turn running and nothing happened for ${Math.floor(quiet / 60_000)} minutes, so the chat is idle again.` });
        this.pingTimeline(chatId);
        live.session.abandonTurn();
      }
    }
  }

  /**
   * Stalled-run recovery: the run is ended (SIGTERM, then SIGKILL after
   * STALLED_RECOVERY_SIGTERM_TIMEOUT_MS), its turn fails with the stall detail, and what it was
   * sent and hadn't taken in goes out again in a new start (queued_stalled_recovery).
   */
  private recoverStalled(chatId: string, live: Live, quiet: number): void {
    const row = this.db.get<ChatRow>("SELECT * FROM chats WHERE id = ?", chatId);
    if (!row) return;
    const session = live.session;
    const turnId = session.activeTurnId;
    const waiting = [...live.unaccepted.values()].map(({ as: _as, ...input }) => input);
    const minutes = Math.max(1, Math.floor(quiet / 60_000));
    const error = stallText(minutes, waiting.length);
    console.warn(`pocket-bots: chat ${chatId}: ${error}; its process is gone, restarting it`);
    this.drop(chatId, live);
    session.kill("SIGTERM");
    const escalate = setTimeout(() => {
      if (session.alive() !== false) session.kill("SIGKILL");
    }, STALLED_RECOVERY_SIGTERM_TIMEOUT_MS);
    escalate.unref?.();
    void session.close().catch(() => undefined);
    this.writeItem(chatId, `notice:${randomUUID()}`, null, {
      type: "notification",
      level: "warning",
      message: `${this.label(row.provider)} showed nothing for ${minutes} minutes and its process is gone, so pocket-bots restarted it${waiting.length ? `; what it hadn't taken in yet goes to it again` : ""}.`,
    });
    this.pingTimeline(chatId);
    if (turnId) this.turnEnded(chatId, { type: "turn_ended", turnId, outcome: "failed", error }, "stalled");
    if (waiting.length) void this.startSession(row, waiting).done;
  }

  private async approval(chatId: string, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const agent = this.get(chatId);
    if (agent) {
      const automatic = await this.policy(agent, request).catch(() => null);
      if (automatic) return automatic;
    }
    return new Promise<ApprovalDecision>((resolve) => {
      const map = this.approvals.get(chatId) ?? new Map();
      this.approvals.set(chatId, map);
      map.set(request.id, { request, resolve });
      signal.addEventListener(
        "abort",
        () => {
          if (map.delete(request.id)) {
            const decision: ApprovalDecision = { behavior: "deny", message: "The turn ended." };
            resolve(decision);
            this.updated(chatId);
            void this.emitSerial(chatId, "permission.resolved", { chatId, requestId: request.id, decision, reason: "ended" });
          }
        },
        { once: true },
      );
      this.db.run("UPDATE chats SET attention = 'permission', attention_at = ?, updated_at = ? WHERE id = ?", now(), now(), chatId);
      const snapshot = this.updated(chatId);
      if (snapshot) void this.emitSerial(chatId, "permission.requested", { agent: snapshot, request });
    });
  }

  // ---------------------------------------------------------------- runtime events

  private onEvent(chatId: string, event: RuntimeEvent): void {
    try {
      const live = this.live.get(chatId);
      if (live && showsRuntime(event, this.runtimes.get(live.session.provider)?.capabilities.steerAcceptance ?? "delivered")) {
        live.lastEventAt = Date.now();
        live.stallNoted = false;
        // The start's first runtime event: it started.
        if (live.start && live.start.phase !== "done") this.startReady(live.start);
      }
      this.handleEvent(chatId, event);
    } catch (error) {
      console.error(`pocket-bots: handling ${event.type} for chat ${chatId} failed`, error);
    }
  }

  private handleEvent(chatId: string, event: RuntimeEvent): void {
    switch (event.type) {
      case "session_ready": {
        this.db.run("UPDATE chats SET resume = ? WHERE id = ?", JSON.stringify(event.handle), chatId);
        // A new session (or a resume that came back as another session) runs on the prompt it was opened with.
        const standing = this.standing.get(chatId);
        if (standing && (!standing.resumed || standing.resumed !== event.handle.sessionId)) {
          this.recordStanding(chatId, event.handle.sessionId, standing.hash);
          this.standing.delete(chatId);
        }
        return;
      }
      case "turn_started": {
        this.touch(chatId);
        const live = this.live.get(chatId);
        if (live) live.turnStartedAt = Date.now();
        this.db.tx(() => {
          this.db.run("INSERT OR IGNORE INTO turns (chat_id, turn_id, started_at) VALUES (?, ?, ?)", chatId, event.turnId, now());
          this.db.run("UPDATE chats SET status = 'running', updated_at = ? WHERE id = ?", now(), chatId);
        });
        const agent = this.updated(chatId);
        if (agent) void this.emitSerial(chatId, "turn.started", { agent });
        return;
      }
      case "input_accepted": {
        // What was carried in with this message was taken in with it.
        const live = this.live.get(chatId);
        const aliases = live?.aliases.get(event.clientMessageId) ?? [];
        live?.unaccepted.delete(event.clientMessageId);
        live?.aliases.delete(event.clientMessageId);
        for (const clientMessageId of [event.clientMessageId, ...aliases]) this.emitNow("input.accepted", { chatId, clientMessageId, as: event.as });
        return;
      }
      case "item":
        this.touch(chatId);
        if (event.item.type === "assistant_message" || event.item.type === "reasoning") this.buffer(chatId, event.key, event.turnId, event.item);
        else {
          // A compaction is told once, when its item first shows (a new model context starts there).
          const before = event.item.type === "compaction" ? this.db.get<{ item: string }>("SELECT item FROM timeline WHERE chat_id = ? AND key = ?", chatId, event.key) : undefined;
          this.flush(chatId);
          this.writeItem(chatId, event.key, event.turnId, event.item);
          this.pingTimeline(chatId);
          if (event.item.type === "compaction") {
            if (!before) this.emitNow("compaction", { chatId });
            this.compactionProgress(chatId, event.key, event.item, before ? (JSON.parse(before.item) as TimelineItem) : null);
          }
        }
        return;
      case "usage":
        this.db.run("UPDATE chats SET last_usage = ? WHERE id = ?", JSON.stringify(event.usage), chatId);
        return;
      case "turn_ended":
        return this.turnEnded(chatId, event);
      case "exited": {
        // A runtime that stopped before its start showed anything didn't start.
        const starting = this.live.get(chatId)?.start;
        if (starting && starting.phase !== "done") this.failStart(starting, event.error ?? `${this.label(this.live.get(chatId)!.session.provider)} stopped while starting.`);
        const live = this.live.get(chatId);
        if (live) {
          live.off();
          this.live.delete(chatId);
        }
        if (event.error) {
          this.db.run("UPDATE chats SET status = CASE WHEN status = 'running' THEN 'error' ELSE status END, last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ?", event.error, now(), chatId);
          this.updated(chatId);
        }
        return;
      }
    }
  }

  /**
   * The failure count and watchdog of a compaction item. One still loading after COMPACTION_STALE_MS is said; on a
   * runtime in COMPACTION_LEDGER_RUNTIMES (Pi), a failure is counted against the session and the
   * model, and a success clears the count.
   */
  private compactionProgress(chatId: string, key: string, item: Extract<TimelineItem, { type: "compaction" }>, before: TimelineItem | null): void {
    const live = this.live.get(chatId);
    if (item.status === "loading") {
      if (live && !live.compaction) {
        const timer = setTimeout(() => {
          if (live.compaction?.key !== key) return;
          live.compaction = null;
          this.writeItem(chatId, `notice:${randomUUID()}`, null, { type: "notification", level: "warning", message: "Context compaction is still running; no finish was seen." });
          this.pingTimeline(chatId);
        }, COMPACTION_STALE_MS);
        timer.unref?.();
        live.compaction = { key, timer };
      }
      return;
    }
    if (live?.compaction?.key === key) {
      clearTimeout(live.compaction.timer);
      live.compaction = null;
    }
    const row = this.db.get<ChatRow>("SELECT * FROM chats WHERE id = ?", chatId);
    if (!row || !COMPACTION_LEDGER_RUNTIMES.has(row.provider)) return;
    if (item.status === "completed") {
      if (row.compaction_failures) this.db.run("UPDATE chats SET compaction_failures = NULL WHERE id = ?", chatId);
      return;
    }
    if (item.status !== "failed" || (before?.type === "compaction" && before.status === "failed")) return;
    const sessionId = live?.session.handle?.sessionId ?? (row.resume ? (JSON.parse(row.resume) as ResumeHandle).sessionId : null);
    if (!sessionId) return;
    const next = countCompactionFailure(compactionFailures(row.compaction_failures), sessionId, row.model, now());
    this.db.run("UPDATE chats SET compaction_failures = ? WHERE id = ?", JSON.stringify(next), chatId);
  }

  private turnEnded(chatId: string, event: Extract<RuntimeEvent, { type: "turn_ended" }>, supervision?: TurnEndedEvent["supervision"]): void {
    this.flush(chatId);
    const live = this.live.get(chatId);
    if (live) {
      live.turnStartedAt = null;
      // A turn's own input and its steers were taken in, or never will be; a queued one is still to come.
      for (const [clientMessageId, input] of live.unaccepted) if (input.as !== "queued") live.unaccepted.delete(clientMessageId);
    }
    const failed = event.outcome === "failed";
    this.db.tx(() => {
      this.db.run("UPDATE turns SET ended_at = ?, outcome = ?, error = ?, usage = ? WHERE chat_id = ? AND turn_id = ?", now(), event.outcome, event.error ?? null, event.usage ? JSON.stringify(event.usage) : null, chatId, event.turnId);
      const usage = event.usage ? this.mergedUsage(chatId, event.usage) : null;
      this.db.run(
        "UPDATE chats SET status = ?, last_error = ?, attention = ?, attention_at = ?, updated_at = ?, last_usage = COALESCE(?, last_usage) WHERE id = ?",
        failed ? "error" : "idle",
        failed ? (event.error ?? "The turn failed.") : null,
        event.outcome === "canceled" ? null : failed ? "error" : "finished",
        now(),
        now(),
        usage ? JSON.stringify(usage) : null,
        chatId,
      );
    });
    this.pingTimeline(chatId);
    const agent = this.updated(chatId);
    if (!agent) return;
    const outcome: TurnOutcome = event.outcome === "completed" ? { kind: "completed" } : event.outcome === "canceled" ? { kind: "canceled", reason: "Stopped." } : { kind: "failed", error: { message: event.error ?? "The turn failed." } };
    void this.emitSerial(chatId, "turn.ended", { agent, outcome, timeline: this.items(chatId), missed: false, ...(supervision ? { supervision } : {}) });
    void this.emitSerial(chatId, "agent.settled", agent);
  }

  private mergedUsage(chatId: string, usage: ContextUsage): ContextUsage {
    const row = this.db.get<{ last_usage: string | null }>("SELECT last_usage FROM chats WHERE id = ?", chatId);
    return { ...(row?.last_usage ? JSON.parse(row.last_usage) : {}), ...usage };
  }

  // ---------------------------------------------------------------- timeline storage

  private buffer(chatId: string, key: string, turnId: string | null, item: TimelineItem): void {
    const map = this.streamBuffer.get(chatId) ?? new Map();
    this.streamBuffer.set(chatId, map);
    map.set(key, { item, turnId });
    if (!this.flushTimers.has(chatId)) {
      this.flushTimers.set(
        chatId,
        setTimeout(() => {
          this.flush(chatId);
          this.pingTimeline(chatId);
        }, STREAM_FLUSH_MS),
      );
    }
  }

  private flush(chatId: string): void {
    const timer = this.flushTimers.get(chatId);
    if (timer) clearTimeout(timer);
    this.flushTimers.delete(chatId);
    const map = this.streamBuffer.get(chatId);
    if (!map?.size) return;
    this.streamBuffer.delete(chatId);
    this.db.tx(() => {
      for (const [key, { item, turnId }] of map) this.writeItem(chatId, key, turnId, item);
    });
  }

  private writeItem(chatId: string, key: string, turnId: string | null, item: TimelineItem): void {
    this.db.tx(() => {
      const seq = this.db.get<{ seq: number }>("UPDATE chats SET seq = seq + 1 WHERE id = ? RETURNING seq", chatId)?.seq;
      if (seq === undefined) return;
      const existing = this.db.get<{ seq_start: number }>("SELECT seq_start FROM timeline WHERE chat_id = ? AND key = ?", chatId, key);
      if (existing) this.db.run("UPDATE timeline SET seq_end = ?, item = ?, turn_id = COALESCE(?, turn_id) WHERE chat_id = ? AND key = ?", seq, JSON.stringify(item), turnId, chatId, key);
      else this.db.run("INSERT INTO timeline (chat_id, key, seq_start, seq_end, turn_id, ts, item) VALUES (?, ?, ?, ?, ?, ?, ?)", chatId, key, seq, seq, turnId, now(), JSON.stringify(item));
    });
  }

  private entry(provider: ProviderId, row: TimelineRow): TimelineEntry {
    return { provider, item: JSON.parse(row.item), ...(row.turn_id ? { turnId: row.turn_id } : {}), timestamp: row.ts, seqStart: row.seq_start, seqEnd: row.seq_end };
  }

  private pingTimeline(chatId: string): void {
    for (const handler of [...this.handlers.timeline]) {
      try {
        void handler({ chatId });
      } catch (error) {
        console.error("pocket-bots: a timeline listener failed", error);
      }
    }
  }

  // ---------------------------------------------------------------- snapshots and events

  private snapshot(row: ChatRow): ChatSnapshot {
    const pending = [...(this.approvals.get(row.id)?.values() ?? [])].map((entry) => entry.request);
    const live = this.live.get(row.id);
    const status = (live?.session.activeTurnId ? "running" : row.status) as ChatStatus;
    const attention = (pending.length ? "permission" : row.attention) as ChatSnapshot["attentionReason"];
    const turn = status === "running" ? this.db.get<{ turn_id: string; started_at: string }>("SELECT turn_id, started_at FROM turns WHERE chat_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1", row.id) : undefined;
    return {
      id: row.id,
      provider: row.provider as ProviderId,
      model: row.model,
      cwd: row.cwd,
      title: row.title,
      labels: JSON.parse(row.labels),
      status,
      pendingPermissions: pending,
      lastError: row.last_error,
      lastUsage: row.last_usage ? JSON.parse(row.last_usage) : null,
      attentionReason: attention ?? null,
      requiresAttention: !!attention,
      attentionTimestamp: attention ? (row.attention_at ?? row.updated_at) : null,
      activeTurn: turn ? { id: turn.turn_id, startedAt: turn.started_at } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUserMessageAt: row.last_user_message_at,
      archivedAt: row.archived_at,
    };
  }

  /** Publishes the chat's current snapshot to live listeners and returns it. */
  private updated(chatId: string): ChatSnapshot | null {
    const agent = this.get(chatId);
    if (!agent) return null;
    for (const handler of [...this.handlers["agent.updated"]]) {
      try {
        void handler(agent);
      } catch (error) {
        console.error("pocket-bots: an update listener failed", error);
      }
    }
    return agent;
  }

  /** Tells the handlers at once, in the order they were added. */
  private emitNow<K extends "input.accepted" | "session.opened" | "compaction" | "start.ready" | "start.failed" | "session.reset">(name: K, event: ChatEvents[K]): void {
    for (const handler of [...this.handlers[name]]) {
      try {
        void (handler as Handler<K>)(event);
      } catch (error) {
        console.error(`pocket-bots: a ${name} listener failed`, error);
      }
    }
  }

  /** Runs a chat's handlers one event at a time, so a turn's end is handled before what follows it. */
  private emitSerial<K extends keyof ChatEvents>(chatId: string, name: K, event: ChatEvents[K]): Promise<unknown> {
    const previous = this.chains.get(chatId) ?? Promise.resolve();
    const next = previous.then(async () => {
      for (const handler of [...this.handlers[name]]) {
        try {
          await handler(event);
        } catch (error) {
          console.error(`pocket-bots: a ${name} handler failed`, error);
        }
      }
    });
    this.chains.set(chatId, next);
    void next.finally(() => {
      if (this.chains.get(chatId) === next) this.chains.delete(chatId);
    });
    return next;
  }
}

/** A runtime event that shows the runtime at work, not our own bookkeeping (a turn we began, an input a runtime takes at queue time): what a start's readiness and a run's progress go by. */
function showsRuntime(event: RuntimeEvent, acceptance: "delivered" | "queued"): boolean {
  switch (event.type) {
    case "session_ready":
    case "turn_started":
      return false;
    case "input_accepted":
      return acceptance === "delivered";
    case "item":
      return event.item.type !== "user_message";
    default:
      return true;
  }
}

/** What a send that went through a start gets: the first input's result, or the start's failure. */
function startResult(done: StartDone): SendResult {
  if (done.error !== null || !done.session) return { ok: false, reason: "error", detail: done.error ?? "The chat couldn't start." };
  return done.result ?? { ok: false, reason: "error", detail: "Nothing was sent." };
}

/** What arrived while the start waited, as one first input under the first message's id. */
function carriedInput(carried: readonly Outgoing[]): Outgoing | null {
  const [first, ...rest] = carried;
  if (!first) return null;
  if (rest.length === 0) return first;
  const images = carried.flatMap((input) => input.message.images ?? []);
  return {
    message: { text: carried.map((input) => input.message.text).join("\n\n"), ...(images.length ? { images } : {}), clientMessageId: first.clientMessageId },
    clientMessageId: first.clientMessageId,
    whenBusy: first.whenBusy,
    aliases: carried.flatMap((input, index) => (index === 0 ? input.aliases : [input.clientMessageId, ...input.aliases])),
  };
}

function compactionFailures(value: string | null): CompactionFailures | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CompactionFailures>;
    return typeof parsed.sessionId === "string" && typeof parsed.count === "number" ? { sessionId: parsed.sessionId, model: parsed.model ?? null, count: parsed.count, updatedAt: parsed.updatedAt ?? "" } : null;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
