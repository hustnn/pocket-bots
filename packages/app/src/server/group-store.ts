import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import {
  DRAFT_TTL_MS,
  FRESHNESS_EXEMPT_SUBTYPES,
  GROUP_TASK_DESCRIPTION_MAX,
  GROUP_TASK_TITLE_MAX,
  GROUP_USER_ID,
  TASK_LEASE_GRACE_MS,
  TASK_LEASE_MS,
  TASK_TRANSITIONS,
  deliveryReason,
  fromLead,
  isSkipSubtype,
  unreadEligible,
  type GroupAttachment,
  type GroupMessage,
  type GroupQuestion,
  type GroupSender,
  type GroupTask,
  type PendingMessage,
  type SystemSubtype,
  type DeliveryFailure,
  type TaskAssignee,
  type TaskEvent,
  type TaskStatus,
  type UnreadPlace,
  type WakeMode,
  type WakeReason,
} from "../shared/group-chat";
import type { Db } from "./db";
import { RequestError } from "./errors";
import { ftsFilter, type GroupSearchHit } from "./search";
import { computeNextFire, type Recurrence, type Reminder, type ReminderEvent, type ReminderStatus } from "./reminders";

// A group chat's storage and its message management, all in SQLite. A
// conversation (conv) is the top level (0) or a thread (its top message's number).
// - messages, numbered per group, with an FTS index and per-sender idempotency keys;
// - delivery records: one per message per receiver it reaches,
//   written in the message's own transaction. Each says whether the message is unread for that
//   receiver and, for a bot, whether it went into its inbox (and why); the inbox's pending
//   records are what notices count and what the bot hasn't read yet;
// - read positions per receiver per conversation: what counts
//   as read. The user is a receiver too;
// - each bot's model-seen ledger per conversation: a boundary up to which its model has seen
//   everything, and the messages after it seen one by one. The check before a post reads it;
// - held drafts per bot per conversation, tasks with every change to them, reactions, thread
//   follows, reminders, and each message's @mentions of members.
// Every write is one transaction, so a crash leaves the group consistent.

export interface GroupRow {
  id: string;
  name: string;
  wake_mode: WakeMode;
  /** The member that hands out the work; the others take only what it or the user aims at them. */
  leader_id: string | null;
  /** The folder its seats work in; null: each bot's own. */
  cwd: string | null;
  /** JSON list of the extra folders its seats may use besides the working folder. */
  extra_folders: string;
  /** off | full. A leader still takes precedence. */
  workbench_mode: "off" | "full";
  last_seq: number;
  created_at: string;
  updated_at: string;
}

export interface MemberRow {
  group_id: string;
  bot_id: string;
  seat_chat_id: string | null;
  active: number;
  joined_seq: number;
  muted_from_seq: number | null;
  /** In a group with a leader, the piece of work the member's seat session is for: its top-level message. */
  seat_task: number | null;
}

interface MessageRow {
  group_id: string;
  seq: number;
  id: string;
  sender_kind: "user" | "bot" | "system";
  sender_id: string | null;
  sender_name: string | null;
  text: string;
  reply_to: number | null;
  thread_seq: number | null;
  everyone: number;
  mentions: string;
  attachments: string;
  question: string | null;
  system_subtype: string | null;
  causal_actor_id: string | null;
  /** How many bot replies deep this message is; full mode stops waking a reply chain at WAKE_HOPS_MAX. */
  wake_depth: number;
  created_at: string;
}

export interface DraftRow {
  conv: number;
  text: string;
  reply_to: number | null;
  /** The send's idempotency key: sending the draft twice posts it once. */
  draft_key: string;
  hold_count: number;
  expires_at: string;
  /** The files the post attaches: paths on the bot's computer, read when it's sent. */
  files: string[];
}

/** A bot's model-seen state in one conversation. */
export interface Ledger {
  /** Everything up to here was seen; null when nothing contiguous was. */
  boundary: number | null;
  /** Seen one by one after the boundary. */
  exact: Set<number>;
  /** When it last read this conversation, against its other reads. */
  readOrder: number | null;
}

export const isSeen = (ledger: Ledger, seq: number): boolean => (ledger.boundary !== null && seq <= ledger.boundary) || ledger.exact.has(seq);

const now = () => new Date().toISOString();

/** Why a member follows a thread. */
export type FollowReason = "replied" | "authored" | "mentioned" | "manual";

interface TaskRow {
  group_id: string;
  number: number;
  seq: number;
  status: TaskStatus;
  assignee_kind: "bot" | "user" | null;
  assignee_id: string | null;
  assignee_name: string | null;
  revision: number;
  title: string;
  description: string | null;
  created_by: string;
  updated_at: string;
  /** The latest amendment's (TASK_SELECT joins it). */
  amended_at: string | null;
  amended_kind: TaskEvent["actor"]["kind"] | null;
  amended_by_id: string | null;
  amended_by: string | null;
}

/** A task with its latest amendment. */
const TASK_SELECT =
  "SELECT t.*, a.created_at AS amended_at, a.actor_kind AS amended_kind, a.actor_id AS amended_by_id, a.actor_name AS amended_by FROM group_tasks t LEFT JOIN group_task_events a ON a.id = (SELECT MAX(e.id) FROM group_task_events e WHERE e.group_id = t.group_id AND e.number = t.number AND e.event = 'amended')";

function taskOf(row: TaskRow): GroupTask {
  const stale = row.status === "in_progress" && row.assignee_kind === "bot" && !!row.assignee_id && Date.parse(row.updated_at) <= Date.now() - (TASK_LEASE_MS + TASK_LEASE_GRACE_MS);
  return {
    number: Number(row.number),
    seq: Number(row.seq),
    status: row.status,
    assignee: row.assignee_id ? { kind: row.assignee_kind ?? "bot", id: row.assignee_id, name: row.assignee_name ?? row.assignee_id } : null,
    revision: Number(row.revision ?? 0),
    title: row.title ?? "",
    description: row.description ?? null,
    createdBy: row.created_by ?? "",
    updatedAt: row.updated_at,
    stale,
    amended: row.amended_at ? { at: row.amended_at, by: row.amended_kind === "user" ? "the user" : (row.amended_by ?? row.amended_by_id ?? "?"), byId: row.amended_by_id } : null,
  };
}

/** Who changed a task: the user, a bot, or pocket-bots itself (null). */
type TaskActor = TaskAssignee | null;

/** A task's fields a change may set: its card's title and description. */
export interface TaskAmendment {
  title?: string;
  /** null clears it. */
  description?: string | null;
}

interface ReminderRow {
  id: string;
  group_id: string;
  owner_id: string;
  anchor_seq: number;
  anchor_thread: number | null;
  title: string;
  fire_at: string;
  recurrence: string | null;
  status: ReminderStatus;
  version: number;
  fired_at: string | null;
  wake_catchup: number;
}

function reminderOf(row: ReminderRow): Reminder {
  return {
    id: row.id,
    groupId: row.group_id,
    ownerId: row.owner_id,
    anchor: Number(row.anchor_seq),
    anchorThread: row.anchor_thread === null ? null : Number(row.anchor_thread),
    title: row.title,
    fireAt: row.fire_at,
    recurrence: row.recurrence ? (JSON.parse(row.recurrence) as Recurrence) : null,
    status: row.status,
    version: Number(row.version),
    firedAt: row.fired_at,
  };
}

const REMINDER_SELECT = "SELECT r.*, m.thread_seq AS anchor_thread FROM group_reminders r LEFT JOIN group_messages m ON m.group_id = r.group_id AND m.seq = r.anchor_seq";

/** Resume catch-up bounds: places, messages per place, messages in all. */
const CATCH_UP_MAX_PLACES = 8;
const CATCH_UP_PER_PLACE = 5;
const CATCH_UP_MAX_MESSAGES = 20;

/** Exact seen messages kept per conversation, newest first (2,500). */
const MAX_EXACT_SEEN = 2_500;

/** Messages a member takes part in: the top level and the threads it follows. */
const RELEVANT = "(thread_seq IS NULL OR thread_seq IN (SELECT thread_seq FROM group_thread_follows WHERE group_id = ? AND follower_id = ? AND unfollowed_at IS NULL))";
const IN_CONV = (conv: number) => (conv ? "thread_seq = ?" : "thread_seq IS NULL");
const convArgs = (conv: number) => (conv ? [conv] : []);
const EXEMPT = `(${FRESHNESS_EXEMPT_SUBTYPES.map((subtype) => `'${subtype}'`).join(", ")})`;

export interface AppendInput {
  text: string;
  replyTo?: number | null;
  thread?: number | null;
  /** Members @mentioned; for a note, whom it's for personally (a task's assignee). */
  mentions?: string[];
  everyone?: boolean;
  attachments?: GroupAttachment[];
  /** A bot's question to the user (subtype bot.question). */
  question?: GroupQuestion | null;
  idempotencyKey?: string | null;
  subtype?: SystemSubtype | null;
  /** Who caused a note: "user" or a bot's id. */
  causalActor?: string | null;
  /** Each @mentioned member's token as written, by id. */
  mentionHandles?: Record<string, string>;
}

export type GroupMetricField = "wake_calls" | "woken_bots" | "notices" | "read_bytes" | "bot_messages" | "user_messages" | "claims";

export interface GroupMetricRow {
  wake_calls: number;
  woken_bots: number;
  notices: number;
  read_bytes: number;
  bot_messages: number;
  user_messages: number;
  claims: number;
}

const METRIC_ZERO: GroupMetricRow = { wake_calls: 0, woken_bots: 0, notices: 0, read_bytes: 0, bot_messages: 0, user_messages: 0, claims: 0 };

export class GroupStore {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- experiment metrics

  /** Adds to one of the day's counters. Observation only: no wake or delivery reads it. */
  bumpMetric(groupId: string, field: GroupMetricField, amount = 1): void {
    if (amount <= 0) return;
    const day = new Date().toISOString().slice(0, 10);
    this.db.run(
      `INSERT INTO group_metrics (group_id, day, ${field}) VALUES (?, ?, ?)
       ON CONFLICT (group_id, day) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
      groupId,
      day,
      amount,
    );
  }

  /** The day's counters for a group; a group with no activity reads as zeroes. */
  metrics(groupId: string, day = new Date().toISOString().slice(0, 10)): GroupMetricRow {
    return this.db.get<GroupMetricRow>("SELECT wake_calls, woken_bots, notices, read_bytes, bot_messages, user_messages, claims FROM group_metrics WHERE group_id = ? AND day = ?", groupId, day) ?? { ...METRIC_ZERO };
  }

  // ---------------------------------------------------------------- groups

  groups(): GroupRow[] {
    return this.db.all<GroupRow>("SELECT * FROM groups ORDER BY updated_at DESC");
  }

  group(groupId: string): GroupRow | null {
    return this.db.get<GroupRow>("SELECT * FROM groups WHERE id = ?", groupId) ?? null;
  }

  createGroup(input: { id: string; name: string; memberIds: string[]; leaderId?: string | null; cwd?: string | null; extraFolders?: string[] }): void {
    const at = now();
    this.db.tx(() => {
      this.db.run("INSERT INTO groups (id, name, wake_mode, leader_id, cwd, extra_folders, created_at, updated_at) VALUES (?, ?, 'everyone', ?, ?, ?, ?, ?)", input.id, input.name, input.leaderId ?? null, input.cwd ?? null, JSON.stringify(input.extraFolders ?? []), at, at);
      for (const botId of input.memberIds) this.db.run("INSERT INTO group_members (group_id, bot_id) VALUES (?, ?)", input.id, botId);
    });
  }

  updateGroup(groupId: string, patch: { name?: string; wakeMode?: WakeMode; workbenchMode?: GroupRow["workbench_mode"]; leaderId?: string | null; cwd?: string | null; extraFolders?: string[] }): void {
    if (patch.name !== undefined) this.db.run("UPDATE groups SET name = ?, updated_at = ? WHERE id = ?", patch.name, now(), groupId);
    if (patch.wakeMode !== undefined) this.db.run("UPDATE groups SET wake_mode = ? WHERE id = ?", patch.wakeMode, groupId);
    if (patch.workbenchMode !== undefined) this.db.run("UPDATE groups SET workbench_mode = ? WHERE id = ?", patch.workbenchMode, groupId);
    if (patch.leaderId !== undefined) this.db.run("UPDATE groups SET leader_id = ? WHERE id = ?", patch.leaderId, groupId);
    if (patch.cwd !== undefined) this.db.run("UPDATE groups SET cwd = ? WHERE id = ?", patch.cwd, groupId);
    if (patch.extraFolders !== undefined) this.db.run("UPDATE groups SET extra_folders = ? WHERE id = ?", JSON.stringify(patch.extraFolders), groupId);
  }

  /** The group's leader while it's a member, or null. */
  leader(groupId: string): string | null {
    const leaderId = this.group(groupId)?.leader_id ?? null;
    return leaderId && this.member(groupId, leaderId)?.active ? leaderId : null;
  }

  deleteGroup(groupId: string): void {
    this.db.tx(() => {
      for (const table of ["group_members", "group_messages", "group_tasks", "group_task_events", "group_mentions", "group_reactions", "group_drafts", "group_thread_follows", "group_inbox", "group_read_cursors", "group_seen", "group_reminders", "group_reminder_events", "group_messages_fts"]) this.db.run(`DELETE FROM ${table} WHERE group_id = ?`, groupId);
      this.db.run("DELETE FROM groups WHERE id = ?", groupId);
    });
  }

  // ---------------------------------------------------------------- members

  members(groupId: string, includeInactive = false): MemberRow[] {
    return this.db.all<MemberRow>(`SELECT * FROM group_members WHERE group_id = ? ${includeInactive ? "" : "AND active = 1"} ORDER BY rowid`, groupId);
  }

  member(groupId: string, botId: string): MemberRow | null {
    return this.db.get<MemberRow>("SELECT * FROM group_members WHERE group_id = ? AND bot_id = ?", groupId, botId) ?? null;
  }

  memberBySeat(chatId: string): MemberRow | null {
    return this.db.get<MemberRow>("SELECT * FROM group_members WHERE seat_chat_id = ?", chatId) ?? null;
  }

  /**
   * Adds or re-activates a member. What came before it joined isn't unread for it (it can read the
   * history with group_read), so its top-level read position starts at the group's latest message.
   */
  addMember(groupId: string, botId: string): void {
    const group = this.group(groupId);
    const last = group?.last_seq ?? 0;
    this.db.tx(() => {
      this.db.run(
        "INSERT INTO group_members (group_id, bot_id, joined_seq) VALUES (?, ?, ?) ON CONFLICT (group_id, bot_id) DO UPDATE SET active = 1, joined_seq = excluded.joined_seq",
        groupId,
        botId,
        last,
      );
      this.markRead(groupId, botId, 0, last);
    });
  }

  removeMember(groupId: string, botId: string): void {
    this.db.run("UPDATE group_members SET active = 0 WHERE group_id = ? AND bot_id = ?", groupId, botId);
  }

  /** A new seat (or none) is for no piece of work yet. */
  setSeat(groupId: string, botId: string, chatId: string | null): void {
    this.db.run("UPDATE group_members SET seat_chat_id = ?, seat_task = CASE WHEN seat_chat_id IS ? THEN seat_task END WHERE group_id = ? AND bot_id = ?", chatId, chatId, groupId, botId);
  }

  setSeatTask(groupId: string, botId: string, task: number | null): void {
    this.db.run("UPDATE group_members SET seat_task = ? WHERE group_id = ? AND bot_id = ?", task, groupId, botId);
  }

  /** Mute: from the next message on, ordinary top-level messages don't reach the bot. */
  setMuted(groupId: string, botId: string, muted: boolean): void {
    const group = this.group(groupId);
    this.db.run("UPDATE group_members SET muted_from_seq = ? WHERE group_id = ? AND bot_id = ?", muted ? (group?.last_seq ?? 0) + 1 : null, groupId, botId);
  }

  // ---------------------------------------------------------------- messages and their delivery

  /**
   * Appends a message and, in the same transaction, its delivery records, the thread follows it
   * causes and its sender's read position. With an idempotency key a retry
   * returns the message already stored. Returns the bots whose inbox it went into.
   */
  append(groupId: string, from: GroupSender, input: AppendInput): { message: GroupMessage; duplicate: boolean; woken: string[] } {
    return this.db.tx(() => {
      const senderId = from.kind === "bot" ? from.botId : from.kind;
      if (input.idempotencyKey) {
        const existing = this.db.get<MessageRow>("SELECT * FROM group_messages WHERE group_id = ? AND sender_id = ? AND idempotency_key = ?", groupId, senderId, input.idempotencyKey);
        if (existing) return { message: this.message(existing), duplicate: true, woken: [] };
      }
      const seq = this.db.get<{ last_seq: number }>("UPDATE groups SET last_seq = last_seq + 1, updated_at = ? WHERE id = ? RETURNING last_seq", now(), groupId)?.last_seq;
      if (seq === undefined) throw new RequestError("That group no longer exists.");
      // A bot reply to a bot is one hop deeper; a message to the user or a fresh topic is 0.
      const parentDepth = input.replyTo ? (this.db.get<{ wake_depth: number }>("SELECT wake_depth FROM group_messages WHERE group_id = ? AND seq = ?", groupId, input.replyTo)?.wake_depth ?? 0) : 0;
      const wakeDepth = from.kind === "bot" ? parentDepth + 1 : 0;
      this.db.run(
        `INSERT INTO group_messages (group_id, seq, id, sender_kind, sender_id, sender_name, text, reply_to, thread_seq, everyone, mentions, attachments, question, idempotency_key, system_subtype, causal_actor_id, wake_depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        groupId,
        seq,
        randomUUID(),
        from.kind,
        senderId,
        from.kind === "bot" ? from.name : null,
        input.text,
        input.replyTo ?? null,
        input.thread ?? null,
        input.everyone ? 1 : 0,
        JSON.stringify(input.mentions ?? []),
        JSON.stringify(input.attachments ?? []),
        input.question ? JSON.stringify(input.question) : null,
        input.idempotencyKey ?? null,
        input.subtype ?? null,
        input.causalActor ?? null,
        wakeDepth,
        now(),
      );
      if (input.text.trim()) this.db.run("INSERT INTO group_messages_fts (text, group_id, seq) VALUES (?, ?, ?)", input.text, groupId, seq);
      if (from.kind === "bot") this.bumpMetric(groupId, "bot_messages");
      else if (from.kind === "user") this.bumpMetric(groupId, "user_messages");
      if (from.kind !== "system") this.recordMentions(groupId, seq, input);
      const row = this.db.get<MessageRow>("SELECT * FROM group_messages WHERE group_id = ? AND seq = ?", groupId, seq)!;
      const message = this.message(row);
      const woken = this.deliver(row, message);
      const conv = message.thread ?? 0;
      if (from.kind === "user") this.markRead(groupId, GROUP_USER_ID, conv, seq);
      if (from.kind === "bot") {
        this.markOwnSendRead(groupId, from.botId, conv, seq);
        this.recordSeen(groupId, from.botId, conv, { exact: [seq] });
      }
      return { message, duplicate: false, woken };
    });
  }

  /**
   * Who a message reaches. A top-level message reaches every member and the
   * user, its sender too (not unread for it); a muted member gets no record unless it's
   * @mentioned or the leader changed. A thread message reaches its followers and, for the same
   * send, its sender, the top message's author and whoever it @mentions; one who stopped following gets no record
   * unless @mentioned (which makes it follow again). Then the follows.
   * In a group with a leader, the other members are reached only by what the leader or the user
   * aims at them (fromLead): anything else reaches them as it would a muted bot (no record at the
   * top level) and wakes none of them in a thread; one member's @mention of another reaches nobody.
   */
  private deliver(row: MessageRow, message: GroupMessage): string[] {
    const groupId = row.group_id;
    if (isSkipSubtype(row.system_subtype)) return [];
    const group = this.group(groupId)!;
    const members = this.members(groupId);
    const memberIds = new Set(members.map((member) => member.bot_id));
    const valid = (id: string) => id === GROUP_USER_ID || memberIds.has(id);
    const conv = message.thread ?? 0;
    const senderId = row.sender_id ?? row.sender_kind;
    const leaderId = group.leader_id && memberIds.has(group.leader_id) ? group.leader_id : null;
    // A leader group keeps its existing rules even if a stale mode says full.
    const full = group.workbench_mode === "full" && leaderId === null;
    const lead = !leaderId || fromLead(leaderId, { kind: row.sender_kind, senderId, causalActor: row.causal_actor_id });
    /** A member the leader leads, which this message may only reach as work. */
    const led = (id: string) => leaderId !== null && id !== leaderId && id !== GROUP_USER_ID && id !== senderId;
    const mentioned = new Set(message.mentions.filter((id) => memberIds.has(id) && (lead || !led(id))));
    const receivers = new Map<string, { suppressed: boolean }>();
    const add = (id: string, suppressed = false) => {
      if (!valid(id)) return;
      const existing = receivers.get(id);
      if (existing) existing.suppressed ||= suppressed;
      else receivers.set(id, { suppressed });
    };
    let unfollowed = new Set<string>();
    let parent: GroupMessage | null = null;
    if (conv === 0) {
      for (const member of members) add(member.bot_id);
      add(GROUP_USER_ID);
    } else {
      for (const follower of this.followers(groupId, conv)) add(follower);
      if (row.sender_kind !== "system") add(senderId);
      unfollowed = new Set(this.unfollowers(groupId, conv));
      parent = this.messageAt(groupId, conv);
      const author = parent ? senderOf(parent) : null;
      if (author && (row.sender_kind === "system" || author !== senderId) && !unfollowed.has(author)) add(author);
      for (const id of mentioned) add(id);
      if (message.everyone) for (const member of members) if (lead || !led(member.bot_id)) add(member.bot_id);
      for (const id of unfollowed) add(id, true);
    }

    const replied = message.replyTo ? this.messageAt(groupId, message.replyTo) : null;
    const repliedBot = replied?.from.kind === "bot" ? replied.from.botId : null;
    // A reply to a member addresses that member, so it isn't a message for anyone who's around.
    const repliedMember = repliedBot && memberIds.has(repliedBot) ? repliedBot : null;
    const muted = new Map(members.map((member) => [member.bot_id, member.muted_from_seq]));
    // A change of leader changes every member's rules, so it reaches a muted member as well.
    const pastMute = row.system_subtype === "group.leader";
    const subject = { senderId, system: row.sender_kind === "system", subtype: row.system_subtype, causalActor: row.causal_actor_id };
    const woken: string[] = [];
    for (const [id, { suppressed }] of receivers) {
      const personal = mentioned.has(id);
      if (suppressed && !personal) continue;
      const mutedFrom = muted.get(id);
      if (conv === 0 && !personal && !pastMute && mutedFrom !== null && mutedFrom !== undefined && row.seq >= mutedFrom) continue;
      // Work from the leader or the user aimed at a led member reaches it; nothing else wakes it.
      const asWork = !led(id) || (lead && (personal || repliedBot === id || message.everyone));
      if (conv === 0 && !asWork) continue;
      // A personal @mention is unread even for the one who caused it (the mention is checked first,
      // and live delivery uses the same rule): "📌 @Ada started task #3" reaches Ada.
      const eligible = unreadEligible(subject, id, personal);
      const reason =
        id === GROUP_USER_ID || !asWork
          ? null
          : deliveryReason({
              mode: group.wake_mode,
              full,
              depth: Number(row.wake_depth ?? 0),
              receiverId: id,
              conv,
              message: { senderId, kind: row.sender_kind, everyone: message.everyone, mentions: message.mentions, repliesTo: repliedMember, subtype: row.system_subtype },
              personal,
              repliedTo: repliedBot === id,
              eligible,
            });
      // Full mode delivers only to those with an obligation: a bot's ordinary chatter doesn't
      // grow every other bot's unread inbox. The sender and the user keep their records.
      if (full && id !== GROUP_USER_ID && id !== senderId && reason === null) continue;
      this.db.run(
        "INSERT OR IGNORE INTO group_inbox (group_id, receiver_id, seq, conv, personal_mention, unread_eligible, wake_reason, reactivated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        groupId,
        id,
        row.seq,
        conv,
        personal ? 1 : 0,
        eligible ? 1 : 0,
        reason,
        personal && unfollowed.has(id) ? 1 : 0,
        row.created_at,
      );
      if (reason) woken.push(id);
    }

    if (conv) {
      if (row.sender_kind !== "system") this.follow(groupId, conv, senderId, "replied", true);
      const author = parent ? senderOf(parent) : null;
      if (author && valid(author)) this.follow(groupId, conv, author, "authored", false);
      for (const id of message.everyone ? [...memberIds].filter((id) => lead || !led(id)) : mentioned) this.follow(groupId, conv, id, "mentioned", true);
    }
    return woken;
  }

  /** The bot's inbox: delivered to it, not read yet, oldest first, with why each was delivered and whether a notice told it. */
  pending(groupId: string, botId: string, conv?: number): (PendingMessage & { noticed: boolean })[] {
    const rows = this.db.all<{ seq: number; wake_reason: WakeReason; reactivated: number; noticed: number }>(
      `SELECT seq, wake_reason, reactivated, noticed FROM group_inbox WHERE group_id = ? AND receiver_id = ? AND wake_reason IS NOT NULL AND drained_at IS NULL ${conv === undefined ? "" : "AND conv = ?"} ORDER BY seq`,
      groupId,
      botId,
      ...(conv === undefined ? [] : [conv]),
    );
    const bySeq = new Map(rows.map((row) => [Number(row.seq), row]));
    return this.messagesAt(groupId, [...bySeq.keys()]).map((message) => {
      const row = bySeq.get(message.seq)!;
      return { message, reason: row.wake_reason, noticed: !!row.noticed, ...(row.reactivated ? { reactivated: true } : {}) };
    });
  }

  /**
   * A notice is about to tell the bot about these inbox messages: they're tied to it, not taken in
   * yet. Telling them again clears a failure; one this notice meets (its turn fails) is recorded after.
   */
  tieToNotice(groupId: string, botId: string, seqs: readonly number[], noticeId: string): void {
    if (seqs.length === 0) return;
    this.db.run(`UPDATE group_inbox SET notice_id = ?, notice_accepted = 0, delivery_failure = NULL WHERE group_id = ? AND receiver_id = ? AND seq IN (${seqs.map(() => "?").join(",")})`, noticeId, groupId, botId, ...seqs);
  }

  /** These inbox messages have been in a notice (each contributes to one notice at most). */
  markNoticed(groupId: string, botId: string, seqs: readonly number[]): void {
    if (seqs.length === 0) return;
    this.db.run(`UPDATE group_inbox SET noticed = 1 WHERE group_id = ? AND receiver_id = ? AND seq IN (${seqs.map(() => "?").join(",")})`, groupId, botId, ...seqs);
  }

  /**
   * The bot's runtime didn't start, so no notice reached it: what's in its inbox and its runtime
   * didn't take in is to be told again. Returns those messages.
   */
  retellUntaken(groupId: string, botId: string): number[] {
    return this.db
      .all<{ seq: number }>(
        "UPDATE group_inbox SET noticed = 0 WHERE group_id = ? AND receiver_id = ? AND notice_accepted = 0 AND drained_at IS NULL AND wake_reason IS NOT NULL RETURNING seq",
        groupId,
        botId,
      )
      .map((row) => Number(row.seq));
  }

  /** A seat took this notice in (its runtime accepted the input). */
  markNoticeAccepted(noticeId: string): void {
    this.db.run("UPDATE group_inbox SET notice_accepted = 1 WHERE notice_id = ?", noticeId);
  }

  /**
   * Telling the bot failed: `seqs` when its seat couldn't start;
   * otherwise its turn failed, which fails everything it was told and hasn't read.
   */
  markDeliveryFailed(groupId: string, botId: string, failure: DeliveryFailure, seqs?: readonly number[]): void {
    if (seqs) {
      if (seqs.length === 0) return;
      this.db.run(`UPDATE group_inbox SET delivery_failure = ? WHERE group_id = ? AND receiver_id = ? AND drained_at IS NULL AND seq IN (${seqs.map(() => "?").join(",")})`, failure, groupId, botId, ...seqs);
      return;
    }
    // Told: in a notice that went out, or one its runtime already took in (a turn can fail before the send returns).
    this.db.run("UPDATE group_inbox SET delivery_failure = ? WHERE group_id = ? AND receiver_id = ? AND (noticed = 1 OR notice_accepted = 1) AND drained_at IS NULL AND wake_reason IS NOT NULL", failure, groupId, botId);
  }

  /** Takes these messages out of the bot's inbox (drained once handed to the model). */
  private drain(groupId: string, botId: string, seqs: readonly number[]): void {
    if (seqs.length === 0) return;
    this.db.run(`UPDATE group_inbox SET drained_at = ? WHERE group_id = ? AND receiver_id = ? AND drained_at IS NULL AND seq IN (${seqs.map(() => "?").join(",")})`, now(), groupId, botId, ...seqs);
  }

  private drainUpTo(groupId: string, botId: string, conv: number, seq: number): void {
    this.db.run("UPDATE group_inbox SET drained_at = ? WHERE group_id = ? AND receiver_id = ? AND conv = ? AND seq <= ? AND drained_at IS NULL", now(), groupId, botId, conv, seq);
  }

  /**
   * A hold showed the bot everything it counted: its read position moves
   * to the latest of them, and they leave its inbox.
   */
  markHeldRead(groupId: string, botId: string, conv: number, seq: number): void {
    this.db.tx(() => {
      this.markRead(groupId, botId, conv, seq);
      this.drainUpTo(groupId, botId, conv, seq);
    });
  }

  /** Where the receiver has unread messages: unread records after its read position. */
  unreadPlaces(groupId: string, receiverId: string): UnreadPlace[] {
    const rows = this.db.all<{ conv: number; n: number; first: number; last: number; mention: number; mentions: number; last_mention: number | null }>(
      `SELECT f.conv, COUNT(*) AS n, MIN(f.seq) AS first, MAX(f.seq) AS last, MAX(f.personal_mention) AS mention, SUM(f.personal_mention) AS mentions, MAX(CASE WHEN f.personal_mention = 1 THEN f.seq END) AS last_mention FROM group_inbox f
       LEFT JOIN group_read_cursors c ON c.group_id = f.group_id AND c.receiver_id = f.receiver_id AND c.conv = f.conv
       WHERE f.group_id = ? AND f.receiver_id = ? AND f.unread_eligible = 1 AND f.seq > COALESCE(c.last_read_seq, 0)
       GROUP BY f.conv`,
      groupId,
      receiverId,
    );
    const latest = new Map(this.messagesAt(groupId, rows.map((row) => Number(row.last))).map((message) => [message.seq, message]));
    return rows.flatMap((row) => {
      const message = latest.get(Number(row.last));
      return message ? [{ conv: Number(row.conv), count: Number(row.n), first: Number(row.first), latest: message, mention: !!row.mention, mentions: Number(row.mentions ?? 0), latestMention: row.last_mention === null ? null : Number(row.last_mention) }] : [];
    });
  }

  /**
   * The resume catch-up batch: the oldest unread
   * messages after the read position in the places with unread, those that @mention the bot
   * first, then the most recently active; at most 5 per place, 8 places and 20 messages. Also
   * every unread place, and which ones the batch didn't cover in full.
   */
  catchUpBatch(groupId: string, botId: string): { messages: GroupMessage[]; places: UnreadPlace[]; truncated: Set<number> } {
    const places = this.unreadPlaces(groupId, botId).sort(
      (a, b) => (b.latestMention ?? 0) - (a.latestMention ?? 0) || b.latest.seq - a.latest.seq || b.first - a.first,
    );
    const seqs: number[] = [];
    const truncated = new Set<number>();
    let contributing = 0;
    for (const place of places) {
      if (seqs.length >= CATCH_UP_MAX_MESSAGES || contributing >= CATCH_UP_MAX_PLACES) {
        truncated.add(place.conv);
        continue;
      }
      const limit = Math.min(CATCH_UP_PER_PLACE, CATCH_UP_MAX_MESSAGES - seqs.length);
      const rows = this.db.all<{ seq: number }>(
        "SELECT seq FROM group_inbox WHERE group_id = ? AND receiver_id = ? AND conv = ? AND unread_eligible = 1 AND seq > ? ORDER BY seq LIMIT ?",
        groupId,
        botId,
        place.conv,
        this.cursor(groupId, botId, place.conv),
        limit + 1,
      );
      if (rows.length > limit) truncated.add(place.conv);
      if (rows.length) contributing++;
      seqs.push(...rows.slice(0, limit).map((row) => Number(row.seq)));
    }
    return { messages: this.messagesAt(groupId, seqs), places, truncated };
  }

  // ---------------------------------------------------------------- mentions and who a message reached

  /** The @mention rows for a sent message: each @mentioned member, with its token as written. */
  private recordMentions(groupId: string, seq: number, input: AppendInput): void {
    for (const id of input.mentions ?? []) this.db.run("INSERT OR IGNORE INTO group_mentions (group_id, seq, target_id, handle) VALUES (?, ?, ?, ?)", groupId, seq, id, input.mentionHandles?.[id] ?? "");
  }

  /** The members a message @mentioned, in the order written. */
  mentionsOf(groupId: string, seq: number): { targetId: string; handle: string }[] {
    return this.db
      .all<{ target_id: string; handle: string }>("SELECT target_id, handle FROM group_mentions WHERE group_id = ? AND seq = ? ORDER BY rowid", groupId, seq)
      .map((row) => ({ targetId: row.target_id, handle: row.handle }));
  }

  /**
   * Every receiver's delivery record for a message: whether it went into the inbox, a notice told
   * it, its seat took that notice, it was handed to the model, and why telling it failed.
   */
  receivers(groupId: string, seq: number): { receiverId: string; inbox: boolean; noticed: boolean; accepted: boolean; drained: boolean; failure: DeliveryFailure | null }[] {
    return this.db
      .all<{ receiver_id: string; wake_reason: string | null; noticed: number; notice_accepted: number; drained_at: string | null; delivery_failure: DeliveryFailure | null }>(
        "SELECT receiver_id, wake_reason, noticed, notice_accepted, drained_at, delivery_failure FROM group_inbox WHERE group_id = ? AND seq = ? ORDER BY rowid",
        groupId,
        seq,
      )
      .map((row) => ({ receiverId: row.receiver_id, inbox: row.wake_reason !== null, noticed: !!row.noticed, accepted: !!row.notice_accepted, drained: row.drained_at !== null, failure: row.delivery_failure }));
  }

  // ---------------------------------------------------------------- read positions

  cursor(groupId: string, receiverId: string, conv: number): number {
    return Number(this.db.get<{ last_read_seq: number }>("SELECT last_read_seq FROM group_read_cursors WHERE group_id = ? AND receiver_id = ? AND conv = ?", groupId, receiverId, conv)?.last_read_seq ?? 0);
  }

  /** Moves a read position forward (never back). */
  markRead(groupId: string, receiverId: string, conv: number, seq: number): void {
    this.db.run(
      "INSERT INTO group_read_cursors (group_id, receiver_id, conv, last_read_seq) VALUES (?, ?, ?, ?) ON CONFLICT (group_id, receiver_id, conv) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)",
      groupId,
      receiverId,
      conv,
      seq,
    );
  }

  /**
   * A bot's own post moves its read position to the post only when
   * nothing from others it hasn't been handed lies in between; otherwise those stay unread.
   */
  private markOwnSendRead(groupId: string, botId: string, conv: number, seq: number): void {
    const cursor = this.cursor(groupId, botId, conv);
    const between = this.db.get(
      `SELECT 1 AS x FROM group_messages WHERE group_id = ? AND ${IN_CONV(conv)} AND seq > ? AND seq < ?
        AND NOT (sender_kind = 'bot' AND sender_id = ?)
        AND NOT (sender_kind = 'system' AND causal_actor_id IS ?)
        AND (system_subtype IS NULL OR system_subtype NOT IN ('task.deleted_summary', 'seat.turn_failed', 'bot.question')) LIMIT 1`,
      groupId,
      ...convArgs(conv),
      cursor,
      seq,
      botId,
      botId,
    );
    if (!between) this.markRead(groupId, botId, conv, seq);
  }

  /**
   * The read position moves along the conversation's messages as long as
   * the model has seen each one (its own don't count as a gap); the first unseen one stops it.
   */
  private advanceReadToSeen(groupId: string, botId: string, conv: number, ledger: Ledger): void {
    const prior = this.cursor(groupId, botId, conv);
    const top = Math.max(ledger.boundary ?? 0, ...ledger.exact);
    if (top <= prior) return;
    // `counted`: it's unread for the bot. One it never received (muted, or not aimed at a member
    // the leader leads) isn't, so the position passes it without the model having seen it.
    const rows = this.db.all<{ seq: number; counted: number }>(
      `SELECT m.seq, EXISTS (SELECT 1 FROM group_inbox i WHERE i.group_id = m.group_id AND i.seq = m.seq AND i.receiver_id = ? AND i.unread_eligible = 1) AS counted FROM group_messages m WHERE m.group_id = ? AND ${IN_CONV(conv)} AND m.seq > ? AND m.seq <= ? AND NOT (m.sender_kind = 'bot' AND m.sender_id = ?) ORDER BY m.seq`,
      botId,
      groupId,
      ...convArgs(conv),
      prior,
      top,
      botId,
    );
    let upTo = prior;
    for (const row of rows) {
      if (!isSeen(ledger, Number(row.seq)) && row.counted) break;
      upTo = Number(row.seq);
    }
    if (upTo > prior) this.markRead(groupId, botId, conv, upTo);
  }

  // ---------------------------------------------------------------- the model-seen ledger

  ledger(groupId: string, botId: string, conv: number): Ledger {
    const row = this.db.get<{ boundary_seq: number | null; exact_seqs: string; read_order: number | null }>("SELECT boundary_seq, exact_seqs, read_order FROM group_seen WHERE group_id = ? AND bot_id = ? AND conv = ?", groupId, botId, conv);
    return {
      boundary: row?.boundary_seq === null || row?.boundary_seq === undefined ? null : Number(row.boundary_seq),
      exact: new Set((JSON.parse(row?.exact_seqs ?? "[]") as number[]).map(Number)),
      readOrder: row?.read_order === null || row?.read_order === undefined ? null : Number(row.read_order),
    };
  }

  /** The thread the bot read most recently, if it read one after the top level (for the top-level confirm). */
  latestReadThread(groupId: string, botId: string): number | null {
    const top = this.ledger(groupId, botId, 0).readOrder ?? 0;
    const row = this.db.get<{ conv: number }>("SELECT conv FROM group_seen WHERE group_id = ? AND bot_id = ? AND conv != 0 AND read_order > ? ORDER BY read_order DESC LIMIT 1", groupId, botId, top);
    return row ? Number(row.conv) : null;
  }

  /**
   * Records what the bot's model has seen in one conversation: `boundary` for a contiguous read
   * (everything up to it), `exact` for messages seen one by one. `read` books it as the bot's
   * latest read of this place. What's now seen leaves its inbox, and its read position follows.
   */
  recordSeen(groupId: string, botId: string, conv: number, input: { boundary?: number | null; exact?: readonly number[]; read?: boolean }): void {
    if (!input.boundary && !input.exact?.length && !input.read) return;
    this.db.tx(() => {
      const ledger = this.ledger(groupId, botId, conv);
      if (input.boundary) ledger.boundary = Math.max(ledger.boundary ?? 0, input.boundary);
      for (const seq of input.exact ?? []) ledger.exact.add(seq);
      const exact = [...ledger.exact].filter((seq) => seq > (ledger.boundary ?? 0)).sort((a, b) => a - b).slice(-MAX_EXACT_SEEN);
      ledger.exact = new Set(exact);
      const readOrder = input.read ? Number(this.db.get<{ n: number | null }>("SELECT MAX(read_order) AS n FROM group_seen WHERE group_id = ? AND bot_id = ?", groupId, botId)?.n ?? 0) + 1 : ledger.readOrder;
      this.db.run(
        "INSERT INTO group_seen (group_id, bot_id, conv, boundary_seq, exact_seqs, read_order, visible_boundary) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (group_id, bot_id, conv) DO UPDATE SET boundary_seq = excluded.boundary_seq, exact_seqs = excluded.exact_seqs, read_order = excluded.read_order, visible_boundary = NULLIF(MAX(COALESCE(visible_boundary, 0), COALESCE(excluded.visible_boundary, 0)), 0)",
        groupId,
        botId,
        conv,
        ledger.boundary,
        JSON.stringify(exact),
        readOrder,
        ledger.boundary,
      );
      if (ledger.boundary) this.drainUpTo(groupId, botId, conv, ledger.boundary);
      this.drain(groupId, botId, input.exact ?? []);
      this.advanceReadToSeen(groupId, botId, conv, ledger);
    });
  }

  /** Records these messages as seen one by one, each in its own conversation. */
  recordSeenMessages(groupId: string, botId: string, messages: readonly Pick<GroupMessage, "seq" | "thread">[]): void {
    const byConv = new Map<number, number[]>();
    for (const message of messages) byConv.set(message.thread ?? 0, [...(byConv.get(message.thread ?? 0) ?? []), message.seq]);
    this.db.tx(() => {
      for (const [conv, seqs] of byConv) this.recordSeen(groupId, botId, conv, { exact: seqs });
    });
  }

  /** A new seat is a new model context: nothing in the ledger is true of it. */
  resetSeen(groupId: string, botId: string): void {
    this.db.run("DELETE FROM group_seen WHERE group_id = ? AND bot_id = ?", groupId, botId);
  }

  /**
   * The seat's model context started over (a compaction, or a fresh session on the same seat):
   * what it saw before is no evidence now, so its boundaries, its one-by-one
   * records and its latest read are dropped. Where it was shown up to stays, so a thread it was already brought into isn't
   * introduced again.
   */
  newSeenContext(groupId: string, botId: string): void {
    this.db.run("UPDATE group_seen SET boundary_seq = NULL, exact_seqs = '[]', read_order = NULL WHERE group_id = ? AND bot_id = ?", groupId, botId);
  }

  /** The newest boundary the seat was shown up to at this place since it started, in any model context (null: never). */
  visibleBoundary(groupId: string, botId: string, conv: number): number | null {
    const row = this.db.get<{ visible_boundary: number | null }>("SELECT visible_boundary FROM group_seen WHERE group_id = ? AND bot_id = ? AND conv = ?", groupId, botId, conv);
    return row?.visible_boundary === null || row?.visible_boundary === undefined ? null : Number(row.visible_boundary);
  }

  /**
   * The freshness rows after `after`: at the top level the bot's own delivery
   * records, in a thread all its messages; minus the bot's own and the notes it caused that
   * don't hold it. Newest last.
   */
  freshnessRows(groupId: string, botId: string, conv: number, after: number): number[] {
    const notMine = `NOT (m.sender_kind = 'bot' AND m.sender_id = ?) AND NOT (m.sender_kind = 'system' AND m.causal_actor_id IS ? AND m.system_subtype IN ${EXEMPT})`;
    const rows = conv
      ? this.db.all<{ seq: number }>(`SELECT m.seq FROM group_messages m WHERE m.group_id = ? AND m.thread_seq = ? AND m.seq > ? AND ${notMine} ORDER BY m.seq`, groupId, conv, after, botId, botId)
      : this.db.all<{ seq: number }>(
          `SELECT m.seq FROM group_inbox f JOIN group_messages m ON m.group_id = f.group_id AND m.seq = f.seq WHERE f.group_id = ? AND f.receiver_id = ? AND f.conv = 0 AND f.seq > ? AND ${notMine} ORDER BY m.seq`,
          groupId,
          botId,
          after,
          botId,
          botId,
        );
    return rows.map((row) => Number(row.seq));
  }

  // ---------------------------------------------------------------- threads

  /** Adds a follower; `reactivate` also brings back one that unfollowed (a reply, a mention, a manual follow). */
  follow(groupId: string, thread: number, followerId: string, reason: FollowReason, reactivate: boolean): void {
    const at = now();
    if (reactivate) {
      this.db.run(
        "INSERT INTO group_thread_follows (group_id, thread_seq, follower_id, reason, followed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (group_id, thread_seq, follower_id) DO UPDATE SET unfollowed_at = NULL, followed_at = CASE WHEN unfollowed_at IS NULL THEN followed_at ELSE excluded.followed_at END",
        groupId,
        thread,
        followerId,
        reason,
        at,
      );
    } else {
      this.db.run("INSERT OR IGNORE INTO group_thread_follows (group_id, thread_seq, follower_id, reason, followed_at) VALUES (?, ?, ?, ?, ?)", groupId, thread, followerId, reason, at);
    }
  }

  /** Stops a thread's ordinary delivery; the row stays, so ordinary activity doesn't bring it back. */
  unfollow(groupId: string, thread: number, followerId: string): void {
    this.db.run(
      "INSERT INTO group_thread_follows (group_id, thread_seq, follower_id, reason, followed_at, unfollowed_at) VALUES (?, ?, ?, 'manual', ?, ?) ON CONFLICT (group_id, thread_seq, follower_id) DO UPDATE SET unfollowed_at = excluded.unfollowed_at",
      groupId,
      thread,
      followerId,
      now(),
      now(),
    );
  }

  followers(groupId: string, thread: number): string[] {
    return this.db.all<{ follower_id: string }>("SELECT follower_id FROM group_thread_follows WHERE group_id = ? AND thread_seq = ? AND unfollowed_at IS NULL ORDER BY followed_at", groupId, thread).map((row) => row.follower_id);
  }

  private unfollowers(groupId: string, thread: number): string[] {
    return this.db.all<{ follower_id: string }>("SELECT follower_id FROM group_thread_follows WHERE group_id = ? AND thread_seq = ? AND unfollowed_at IS NOT NULL", groupId, thread).map((row) => row.follower_id);
  }

  /** The threads a member follows, with why and since when. */
  follows(groupId: string, followerId: string): { thread: number; reason: FollowReason; followedAt: string }[] {
    return this.db
      .all<{ thread_seq: number; reason: FollowReason; followed_at: string }>("SELECT thread_seq, reason, followed_at FROM group_thread_follows WHERE group_id = ? AND follower_id = ? AND unfollowed_at IS NULL ORDER BY followed_at", groupId, followerId)
      .map((row) => ({ thread: Number(row.thread_seq), reason: row.reason, followedAt: row.followed_at }));
  }

  followedThreads(groupId: string, followerId: string): number[] {
    return this.db.all<{ thread_seq: number }>("SELECT thread_seq FROM group_thread_follows WHERE group_id = ? AND follower_id = ? AND unfollowed_at IS NULL ORDER BY thread_seq", groupId, followerId).map((row) => Number(row.thread_seq));
  }

  /** A thread's latest message as stored: for a note, its subtype and who caused it. Null for a thread with no replies. */
  threadTail(groupId: string, thread: number): { seq: number; subtype: string | null; causalActor: string | null } | null {
    const row = this.db.get<{ seq: number; system_subtype: string | null; causal_actor_id: string | null }>(
      "SELECT seq, system_subtype, causal_actor_id FROM group_messages WHERE group_id = ? AND thread_seq = ? ORDER BY seq DESC LIMIT 1",
      groupId,
      thread,
    );
    return row ? { seq: Number(row.seq), subtype: row.system_subtype, causalActor: row.causal_actor_id } : null;
  }

  /** A thread's latest `limit` replies before `seq`, oldest first, and how many earlier ones there are. */
  threadBefore(groupId: string, thread: number, seq: number, limit: number): { messages: GroupMessage[]; earlier: number } {
    const rows = this.db.all<MessageRow>("SELECT * FROM group_messages WHERE group_id = ? AND thread_seq = ? AND seq < ? ORDER BY seq DESC LIMIT ?", groupId, thread, seq, limit);
    const total = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ? AND thread_seq = ? AND seq < ?", groupId, thread, seq)?.n ?? 0);
    return { messages: rows.reverse().map((row) => this.message(row)), earlier: Math.max(0, total - rows.length) };
  }

  /** A thread: its top message and its latest `limit` replies (or those before `before`), oldest first. */
  threadPage(groupId: string, thread: number, input: { before?: number | null; limit?: number } = {}): { parent: GroupMessage | null; messages: GroupMessage[]; hasOlder: boolean } {
    const page = this.convPage(groupId, thread, { before: input.before ?? null, limit: input.limit ?? 50 });
    return { parent: this.messageAt(groupId, thread), messages: page.messages, hasOlder: page.hasOlder };
  }

  /**
   * One conversation's messages (a thread's replies, without its top message), oldest first: the
   * latest `limit`, those before `before`, or the first `limit` after `after`.
   */
  convPage(groupId: string, conv: number, input: { before?: number | null; after?: number | null; limit?: number }): { messages: GroupMessage[]; hasOlder: boolean; hasNewer: boolean } {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
    if (input.after !== null && input.after !== undefined) {
      const rows = this.db.all<MessageRow>(`SELECT * FROM group_messages WHERE group_id = ? AND ${IN_CONV(conv)} AND seq > ? ORDER BY seq LIMIT ?`, groupId, ...convArgs(conv), input.after, limit + 1);
      const shown = rows.slice(0, limit);
      const older = shown.length ? this.db.get(`SELECT 1 AS x FROM group_messages WHERE group_id = ? AND ${IN_CONV(conv)} AND seq < ? LIMIT 1`, groupId, ...convArgs(conv), shown[0]!.seq) : null;
      return { messages: shown.map((row) => this.message(row)), hasOlder: !!older, hasNewer: rows.length > limit };
    }
    const rows = input.before
      ? this.db.all<MessageRow>(`SELECT * FROM group_messages WHERE group_id = ? AND ${IN_CONV(conv)} AND seq < ? ORDER BY seq DESC LIMIT ?`, groupId, ...convArgs(conv), input.before, limit + 1)
      : this.db.all<MessageRow>(`SELECT * FROM group_messages WHERE group_id = ? AND ${IN_CONV(conv)} ORDER BY seq DESC LIMIT ?`, groupId, ...convArgs(conv), limit + 1);
    const shown = rows.slice(0, limit).reverse();
    const newer = input.before && shown.length ? this.db.get(`SELECT 1 AS x FROM group_messages WHERE group_id = ? AND ${IN_CONV(conv)} AND seq > ? LIMIT 1`, groupId, ...convArgs(conv), shown.at(-1)!.seq) : null;
    return { messages: shown.map((row) => this.message(row)), hasOlder: rows.length > limit, hasNewer: !!newer };
  }

  /**
   * The messages around one in its conversation: about half before it and half
   * after, oldest first.
   */
  convAround(groupId: string, conv: number, seq: number, limit: number): { messages: GroupMessage[]; hasOlder: boolean; hasNewer: boolean } {
    const before = Math.floor((limit - 1) / 2);
    const after = limit - before - 1;
    const older = this.db.all<MessageRow>(`SELECT * FROM group_messages WHERE group_id = ? AND ${IN_CONV(conv)} AND seq < ? ORDER BY seq DESC LIMIT ?`, groupId, ...convArgs(conv), seq, before + 1);
    const newer = this.db.all<MessageRow>(`SELECT * FROM group_messages WHERE group_id = ? AND ${IN_CONV(conv)} AND seq > ? ORDER BY seq LIMIT ?`, groupId, ...convArgs(conv), seq, after + 1);
    const anchor = this.db.get<MessageRow>("SELECT * FROM group_messages WHERE group_id = ? AND seq = ?", groupId, seq);
    const rows = [...older.slice(0, before).reverse(), ...(anchor ? [anchor] : []), ...newer.slice(0, after)];
    return { messages: rows.map((row) => this.message(row)), hasOlder: older.length > before, hasNewer: newer.length > after };
  }

  /** What a member takes part in, latest `limit` (a renewed seat's briefing): the top level and its threads. */
  history(groupId: string, botId: string, limit: number): GroupMessage[] {
    const rows = this.db.all<MessageRow>(`SELECT * FROM group_messages WHERE group_id = ? AND ${RELEVANT} ORDER BY seq DESC LIMIT ?`, groupId, groupId, botId, limit);
    return rows.reverse().map((row) => this.message(row));
  }

  /** The latest messages anywhere in the group, threads included (for the group's preview). */
  latest(groupId: string, limit: number): GroupMessage[] {
    return this.db.all<MessageRow>("SELECT * FROM group_messages WHERE group_id = ? ORDER BY seq DESC LIMIT ?", groupId, limit).reverse().map((row) => this.message(row));
  }

  // ---------------------------------------------------------------- messages

  messageAt(groupId: string, seq: number): GroupMessage | null {
    const row = this.db.get<MessageRow>("SELECT * FROM group_messages WHERE group_id = ? AND seq = ?", groupId, seq);
    return row ? this.message(row) : null;
  }

  /** The latest `limit` top-level messages, or those before `before`, oldest first (threads show as their reply counts). */
  page(groupId: string, input: { before?: number | null; limit?: number } = {}): { messages: GroupMessage[]; hasOlder: boolean } {
    const { messages, hasOlder } = this.convPage(groupId, 0, { before: input.before ?? null, limit: input.limit ?? 50 });
    return { messages, hasOlder };
  }

  /** Messages with these numbers, oldest first. */
  messagesAt(groupId: string, seqs: readonly number[]): GroupMessage[] {
    if (seqs.length === 0) return [];
    const rows = this.db.all<MessageRow>(`SELECT * FROM group_messages WHERE group_id = ? AND seq IN (${seqs.map(() => "?").join(",")}) ORDER BY seq`, groupId, ...seqs);
    return rows.map((row) => this.message(row));
  }

  search(groupId: string, query: string, limit = 20): GroupMessage[] {
    const words = query.trim();
    if (!words) return [];
    const rows =
      [...words].length >= 3
        ? this.db.all<{ seq: number }>("SELECT seq FROM group_messages_fts WHERE group_messages_fts MATCH ? AND group_id = ? ORDER BY rank LIMIT ?", `"${words.replace(/"/g, '""')}"`, groupId, limit)
        : this.db.all<{ seq: number }>("SELECT seq FROM group_messages WHERE group_id = ? AND text LIKE ? ORDER BY seq DESC LIMIT ?", groupId, `%${words}%`, limit);
    // Best match first.
    const bySeq = new Map(this.messagesAt(groupId, rows.map((row) => Number(row.seq))).map((message) => [message.seq, message]));
    return rows.flatMap((row) => bySeq.get(Number(row.seq)) ?? []);
  }

  /** Search across groups: the user's and the bots' messages, in every group (or one), that contain every term, newest first. */
  searchAll(terms: readonly string[], scope: { groupId?: string; limit?: number } = {}): GroupSearchHit[] {
    if (terms.length === 0) return [];
    const full = ftsFilter(terms, "group_messages_fts", "f.text");
    const where = [...full.where, "m.sender_kind IN ('user', 'bot')"];
    const params: SQLInputValue[] = [...full.params];
    if (scope.groupId) {
      where.push("f.group_id = ?");
      params.push(scope.groupId);
    }
    const rows = this.db.all<MessageRow>(
      `SELECT m.* FROM group_messages_fts f JOIN group_messages m ON m.group_id = f.group_id AND m.seq = f.seq WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC, m.seq DESC LIMIT ?`,
      ...params,
      Math.max(1, Math.min(scope.limit ?? 50, 500)),
    );
    return rows.map((row) => ({
      groupId: row.group_id,
      seq: Number(row.seq),
      thread: row.thread_seq === null ? null : Number(row.thread_seq),
      from: row.sender_kind === "bot" ? { kind: "bot" as const, botId: row.sender_id!, name: row.sender_name ?? row.sender_id! } : { kind: "user" as const },
      text: row.text,
      at: row.created_at,
    }));
  }

  private message(row: MessageRow): GroupMessage {
    const from: GroupSender = row.sender_kind === "bot" ? { kind: "bot", botId: row.sender_id!, name: row.sender_name ?? row.sender_id! } : { kind: row.sender_kind };
    const task = this.db.get<TaskRow>(`${TASK_SELECT} WHERE t.group_id = ? AND t.seq = ?`, row.group_id, row.seq);
    const reactions = this.db.all<{ emoji: string; actor_id: string; actor_name: string }>("SELECT emoji, actor_id, actor_name FROM group_reactions WHERE group_id = ? AND seq = ? ORDER BY created_at", row.group_id, row.seq);
    const byEmoji = new Map<string, { names: string[]; ids: string[] }>();
    for (const reaction of reactions) {
      const entry = byEmoji.get(reaction.emoji) ?? { names: [], ids: [] };
      entry.names.push(reaction.actor_name);
      entry.ids.push(reaction.actor_id);
      byEmoji.set(reaction.emoji, entry);
    }
    return {
      seq: row.seq,
      at: row.created_at,
      from,
      text: row.text,
      replyTo: row.reply_to,
      thread: row.thread_seq ?? null,
      ...this.replies(row),
      mentions: JSON.parse(row.mentions),
      everyone: !!row.everyone,
      attachments: JSON.parse(row.attachments),
      question: row.question ? (JSON.parse(row.question) as GroupQuestion) : null,
      task: task ? (({ seq: _seq, ...rest }) => rest)(taskOf(task)) : null,
      reactions: [...byEmoji].map(([emoji, entry]) => ({ emoji, ...entry })),
    };
  }

  private replies(row: MessageRow): { replies: number; lastReplyAt: string | null } {
    if (row.thread_seq !== null && row.thread_seq !== undefined) return { replies: 0, lastReplyAt: null };
    const thread = this.db.get<{ n: number; last: string | null }>("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM group_messages WHERE group_id = ? AND thread_seq = ?", row.group_id, row.seq);
    return { replies: Number(thread?.n ?? 0), lastReplyAt: thread?.last ?? null };
  }

  // ---------------------------------------------------------------- bots' questions

  /** A bot's question by the seat approval it shows, or null. */
  questionFor(chatId: string, requestId: string): { groupId: string; seq: number; question: GroupQuestion } | null {
    const row = this.db.get<{ group_id: string; seq: number; question: string }>(
      "SELECT group_id, seq, question FROM group_messages WHERE question IS NOT NULL AND json_extract(question, '$.chatId') = ? AND json_extract(question, '$.requestId') = ? ORDER BY seq DESC LIMIT 1",
      chatId,
      requestId,
    );
    return row ? { groupId: row.group_id, seq: Number(row.seq), question: JSON.parse(row.question) as GroupQuestion } : null;
  }

  /** The questions still waiting for the user, in every group. */
  pendingQuestions(): { groupId: string; seq: number; question: GroupQuestion }[] {
    return this.db
      .all<{ group_id: string; seq: number; question: string }>("SELECT group_id, seq, question FROM group_messages WHERE question IS NOT NULL AND json_extract(question, '$.status') = 'pending'")
      .map((row) => ({ groupId: row.group_id, seq: Number(row.seq), question: JSON.parse(row.question) as GroupQuestion }));
  }

  /** Settles a pending question (answered, dismissed or closed); false when it wasn't pending. */
  settleQuestion(groupId: string, seq: number, settled: Pick<GroupQuestion, "status" | "answers">): boolean {
    return this.db.tx(() => {
      const row = this.db.get<{ question: string | null }>("SELECT question FROM group_messages WHERE group_id = ? AND seq = ?", groupId, seq);
      const question = row?.question ? (JSON.parse(row.question) as GroupQuestion) : null;
      if (!question || question.status !== "pending") return false;
      this.db.run("UPDATE group_messages SET question = ? WHERE group_id = ? AND seq = ?", JSON.stringify({ ...question, ...settled, settledAt: now() }), groupId, seq);
      return true;
    });
  }

  // ---------------------------------------------------------------- drafts

  draft(groupId: string, botId: string, conv: number): DraftRow | null {
    const row = this.db.get<Omit<DraftRow, "files"> & { files: string }>("SELECT conv, text, reply_to, draft_key, hold_count, expires_at, files FROM group_drafts WHERE group_id = ? AND bot_id = ? AND conv = ?", groupId, botId, conv);
    if (!row) return null;
    if (Date.parse(row.expires_at) < Date.now()) {
      this.dropDraft(groupId, botId, conv);
      return null;
    }
    return { ...row, conv: Number(row.conv), files: JSON.parse(row.files) as string[] };
  }

  /** The bot's live drafts, newest first. */
  drafts(groupId: string, botId: string): DraftRow[] {
    const convs = this.db.all<{ conv: number }>("SELECT conv FROM group_drafts WHERE group_id = ? AND bot_id = ? ORDER BY held_at DESC", groupId, botId);
    return convs.flatMap((row) => this.draft(groupId, botId, Number(row.conv)) ?? []);
  }

  /**
   * Keeps a post as the draft for its conversation (one per bot per conversation, 10
   * minutes). The same text keeps its key and, when `held`, counts one more hold; new text
   * replaces it with a new key.
   */
  saveDraft(groupId: string, botId: string, conv: number, input: { text: string; replyTo: number | null; held: boolean; files?: readonly string[] }): DraftRow {
    return this.db.tx(() => {
      const existing = this.draft(groupId, botId, conv);
      const files = [...(input.files ?? [])];
      const same = existing && existing.text === input.text && JSON.stringify(existing.files) === JSON.stringify(files);
      const key = same ? existing.draft_key : randomUUID();
      const holds = (same ? existing.hold_count : 0) + (input.held ? 1 : 0);
      const at = Date.now();
      this.db.run(
        "INSERT INTO group_drafts (group_id, bot_id, conv, text, reply_to, draft_key, hold_count, held_at, expires_at, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (group_id, bot_id, conv) DO UPDATE SET text = excluded.text, reply_to = excluded.reply_to, draft_key = excluded.draft_key, hold_count = excluded.hold_count, held_at = excluded.held_at, expires_at = excluded.expires_at, files = excluded.files",
        groupId,
        botId,
        conv,
        input.text,
        input.replyTo,
        key,
        holds,
        new Date(at).toISOString(),
        new Date(at + DRAFT_TTL_MS).toISOString(),
        JSON.stringify(files),
      );
      return this.draft(groupId, botId, conv)!;
    });
  }

  dropDraft(groupId: string, botId: string, conv: number): void {
    this.db.run("DELETE FROM group_drafts WHERE group_id = ? AND bot_id = ? AND conv = ?", groupId, botId, conv);
  }

  // ---------------------------------------------------------------- tasks, reactions

  task(groupId: string, ref: { number?: number | null; seq?: number | null }): GroupTask | null {
    const row = ref.number
      ? this.db.get<TaskRow>(`${TASK_SELECT} WHERE t.group_id = ? AND t.number = ?`, groupId, ref.number)
      : ref.seq
        ? this.db.get<TaskRow>(`${TASK_SELECT} WHERE t.group_id = ? AND t.seq = ?`, groupId, ref.seq)
        : undefined;
    return row ? taskOf(row) : null;
  }

  /** The group's tasks by number, optionally only these statuses or this assignee's. */
  tasks(groupId: string, filter: { statuses?: readonly TaskStatus[]; assigneeId?: string } = {}): GroupTask[] {
    return this.db
      .all<TaskRow>(`${TASK_SELECT} WHERE t.group_id = ? ORDER BY t.number`, groupId)
      .map(taskOf)
      .filter((task) => (!filter.statuses || filter.statuses.includes(task.status)) && (!filter.assigneeId || task.assignee?.id === filter.assigneeId));
  }

  /**
   * Makes a message a task, or returns the task it already is. A task keeps its message's number
   * (task #12 is message #12): with separate small numbers for both, bots mix them up. Its card's
   * title starts as the message's text. A conversion is todo and unassigned; `create` is a task
   * create, whose message was just posted for it: with an assignee it's reserved for them, and
   * `start` (assigning yourself) makes it in_progress at once.
   */
  convertToTask(groupId: string, seq: number, by: TaskAssignee, create?: { assignee: TaskAssignee | null; start: boolean }): { task: GroupTask; created: boolean } {
    return this.db.tx(() => {
      const existing = this.task(groupId, { seq });
      if (existing) return { task: existing, created: false };
      const at = now();
      const text = this.db.get<{ text: string }>("SELECT text FROM group_messages WHERE group_id = ? AND seq = ?", groupId, seq)?.text ?? "";
      const assignee = create?.assignee ?? null;
      const status: TaskStatus = assignee && create?.start ? "in_progress" : "todo";
      this.db.run(
        "INSERT INTO group_tasks (group_id, number, seq, status, assignee_kind, assignee_id, assignee_name, title, created_by, created_at, updated_at, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        groupId,
        seq,
        seq,
        status,
        assignee?.kind ?? null,
        assignee?.id ?? null,
        assignee?.name ?? null,
        text.slice(0, GROUP_TASK_TITLE_MAX),
        by.id,
        at,
        at,
        status === "in_progress" ? at : null,
      );
      this.taskEvent(groupId, seq, "created", by, create ? { taskNumber: seq, status } : { taskNumber: seq, status, convertedFromMessage: true });
      if (assignee) this.taskEvent(groupId, seq, "assignee_changed", by, { assigneeType: assignee.kind, assigneeId: assignee.id });
      return { task: this.task(groupId, { seq })!, created: true };
    });
  }

  /**
   * Claim: the first claim wins, and a claimed task is in_progress. A message that isn't a
   * task yet becomes one. Refused for a task someone else holds, one already the claimant's, and
   * a done or closed one.
   */
  claimTask(groupId: string, ref: { number?: number | null; seq?: number | null }, claimant: TaskAssignee): { ok: true; task: GroupTask; created: boolean } | { ok: false; reason: string; task: GroupTask | null } {
    return this.db.tx(() => {
      let task = this.task(groupId, ref);
      let created = false;
      if (!task) {
        if (!ref.seq) return { ok: false as const, reason: `there's no task #${ref.number}`, task: null };
        ({ task, created } = this.convertToTask(groupId, ref.seq, claimant));
      }
      if (task.status === "closed") return { ok: false as const, reason: "task is closed; reopen it before claiming", task };
      if (task.status === "done") return { ok: false as const, reason: "task is done", task };
      const group = this.group(groupId);
      const full = group?.workbench_mode === "full" && !group.leader_id;
      if (task.assignee && task.assignee.id !== claimant.id && !(full && task.stale)) return { ok: false as const, reason: `already assigned to ${task.assignee.name}`, task };
      if (task.assignee?.id === claimant.id && task.status !== "todo") return { ok: false as const, reason: "already claimed by you", task };
      const at = now();
      const next: TaskStatus = task.status === "todo" ? "in_progress" : task.status;
      this.db.run(
        "UPDATE group_tasks SET assignee_kind = ?, assignee_id = ?, assignee_name = ?, status = ?, claimed_at = ?, updated_at = ?, revision = revision + 1 WHERE group_id = ? AND number = ?",
        claimant.kind,
        claimant.id,
        claimant.name,
        next,
        at,
        at,
        groupId,
        task.number,
      );
      this.taskEvent(groupId, task.number, "assignee_changed", claimant, { assigneeType: claimant.kind, assigneeId: claimant.id });
      if (next !== task.status) this.taskEvent(groupId, task.number, "status_changed", claimant, { from: task.status, to: next });
      this.bumpMetric(groupId, "claims");
      return { ok: true as const, task: this.task(groupId, { number: task.number })!, created };
    });
  }

  /**
   * Puts a task down: no assignee, and its status stays (assignee and status are
   * independent). Refused once it's done, and when nobody holds it. Anyone may unclaim; the event
   * names who took it off whom.
   */
  unclaimTask(groupId: string, number: number, by: TaskActor): { ok: true; task: GroupTask } | { ok: false; reason: string } {
    return this.db.tx(() => {
      const task = this.task(groupId, { number });
      if (!task) return { ok: false as const, reason: `there's no task #${number}` };
      if (task.status === "done") return { ok: false as const, reason: "task is done" };
      if (!task.assignee) return { ok: false as const, reason: "task is not assigned" };
      this.db.run("UPDATE group_tasks SET assignee_kind = NULL, assignee_id = NULL, assignee_name = NULL, claimed_at = NULL, updated_at = ?, revision = revision + 1 WHERE group_id = ? AND number = ?", now(), groupId, number);
      this.taskEvent(groupId, number, "assignee_changed", by, { assigneeType: null, assigneeId: null, previousAssigneeType: task.assignee.kind, previousAssigneeId: task.assignee.id });
      return { ok: true as const, task: this.task(groupId, { number })! };
    });
  }

  /**
   * Hands a task to someone (or nobody); unlike a claim, its status stays. A
   * done task can't be reassigned. With `expectedRevision`, a task that changed since is refused
   * instead of overwritten. Assigning the current assignee again changes nothing.
   */
  assignTask(groupId: string, number: number, assignee: TaskAssignee | null, by: TaskActor, expectedRevision?: number | null): { ok: true; task: GroupTask } | { ok: false; reason: string; task: GroupTask | null } {
    return this.db.tx(() => {
      const task = this.task(groupId, { number });
      if (!task) return { ok: false as const, reason: `there's no task #${number}`, task: null };
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== task.revision) return { ok: false as const, reason: "task state changed concurrently", task };
      if (task.status === "done") return { ok: false as const, reason: "task is done", task };
      if ((task.assignee?.id ?? null) === (assignee?.id ?? null)) return { ok: true as const, task };
      this.db.run(
        "UPDATE group_tasks SET assignee_kind = ?, assignee_id = ?, assignee_name = ?, claimed_at = NULL, updated_at = ?, revision = revision + 1 WHERE group_id = ? AND number = ?",
        assignee?.kind ?? null,
        assignee?.id ?? null,
        assignee?.name ?? null,
        now(),
        groupId,
        number,
      );
      this.taskEvent(groupId, number, "assignee_changed", by, { assigneeType: assignee?.kind ?? null, assigneeId: assignee?.id ?? null, previousAssigneeType: task.assignee?.kind ?? null, previousAssigneeId: task.assignee?.id ?? null });
      return { ok: true as const, task: this.task(groupId, { number })! };
    });
  }

  /**
   * Moves a task's status along the allowed transitions; `anyMove` (the user) may set any
   * status. It keeps when the task was done
   * and when and by whom it was closed, stamps the start of work moving to in_progress, and records
   * a close, a reopen or a status change.
   */
  setTaskStatus(groupId: string, number: number, to: TaskStatus, by: TaskActor, anyMove = false): { ok: true; task: GroupTask; from: TaskStatus } | { ok: false; reason: string } {
    return this.db.tx(() => {
      const task = this.task(groupId, { number });
      if (!task) return { ok: false as const, reason: `there's no task #${number}` };
      if (task.status === to) return { ok: false as const, reason: `task #${number} is already ${to}` };
      if (!anyMove && !TASK_TRANSITIONS[task.status].includes(to)) return { ok: false as const, reason: `task #${number} can't go from ${task.status} to ${to} (from ${task.status}: ${TASK_TRANSITIONS[task.status].join(", ")})` };
      if (to === "in_progress" && !task.assignee) return { ok: false as const, reason: `task #${number} has no assignee; unassigned work starts with a claim` };
      const from = task.status;
      const at = now();
      const claimedAt = (from === "todo" || from === "closed") && to === "in_progress" ? "?" : from === "in_progress" && to === "todo" ? "NULL" : "claimed_at";
      const completedAt = to === "done" ? "?" : from === "done" ? "NULL" : "completed_at";
      const closed = to === "closed" ? "closed_at = ?, closed_by = ?" : from === "closed" ? "closed_at = NULL, closed_by = NULL" : "closed_at = closed_at";
      this.db.run(
        `UPDATE group_tasks SET status = ?, claimed_at = ${claimedAt}, completed_at = ${completedAt}, ${closed}, updated_at = ?, revision = revision + 1 WHERE group_id = ? AND number = ?`,
        to,
        ...(claimedAt === "?" ? [at] : []),
        ...(completedAt === "?" ? [at] : []),
        ...(to === "closed" ? [at, by?.id ?? "system"] : []),
        at,
        groupId,
        number,
      );
      this.taskEvent(groupId, number, to === "closed" ? "closed" : from === "closed" ? "reopened" : "status_changed", by, { from, to, forced: anyMove });
      return { ok: true as const, task: this.task(groupId, { number })!, from };
    });
  }

  /**
   * Changes the card's current title or description, keeping the message's own
   * text, and appends the exact before and after to the task's history in the same transaction.
   * A change that changes nothing is refused.
   */
  amendTask(groupId: string, number: number, patch: TaskAmendment, by: TaskAssignee): { ok: true; task: GroupTask; eventSeq: number } | { ok: false; reason: string } {
    return this.db.tx(() => {
      const task = this.task(groupId, { number });
      if (!task) return { ok: false as const, reason: `there's no task #${number}` };
      if (patch.title !== undefined && patch.title.length > GROUP_TASK_TITLE_MAX) return { ok: false as const, reason: `the title is longer than ${GROUP_TASK_TITLE_MAX} characters` };
      if (patch.description !== undefined && patch.description !== null && patch.description.length > GROUP_TASK_DESCRIPTION_MAX) return { ok: false as const, reason: `the description is longer than ${GROUP_TASK_DESCRIPTION_MAX} characters` };
      const changes: Partial<Record<"title" | "description", { from: string | null; to: string | null }>> = {};
      if (patch.title !== undefined && patch.title !== task.title) changes.title = { from: task.title, to: patch.title };
      if (patch.description !== undefined && patch.description !== task.description) changes.description = { from: task.description, to: patch.description };
      if (!changes.title && !changes.description) return { ok: false as const, reason: "task amendment makes no changes" };
      this.db.run(
        "UPDATE group_tasks SET title = ?, description = ?, updated_at = ?, revision = revision + 1 WHERE group_id = ? AND number = ?",
        changes.title ? changes.title.to : task.title,
        changes.description ? changes.description.to : task.description,
        now(),
        groupId,
        number,
      );
      const eventSeq = this.taskEvent(groupId, number, "amended", by, { revision: task.revision + 1, changes });
      return { ok: true as const, task: this.task(groupId, { number })!, eventSeq };
    });
  }

  /** Every change to a task, in order. */
  taskEvents(groupId: string, number: number): TaskEvent[] {
    return this.db
      .all<{ id: number; event: TaskEvent["event"]; actor_kind: TaskEvent["actor"]["kind"]; actor_id: string | null; actor_name: string | null; payload: string; created_at: string }>(
        "SELECT id, event, actor_kind, actor_id, actor_name, payload, created_at FROM group_task_events WHERE group_id = ? AND number = ? ORDER BY id",
        groupId,
        number,
      )
      .map((row) => ({ seq: Number(row.id), event: row.event, actor: { kind: row.actor_kind, id: row.actor_id, name: row.actor_name }, payload: JSON.parse(row.payload) as Record<string, unknown>, at: row.created_at }));
  }

  /** Appends to a task's history; returns the event's place in the order of all of them. */
  private taskEvent(groupId: string, number: number, event: TaskEvent["event"], by: TaskActor, payload: Record<string, unknown>): number {
    const row = this.db.get<{ id: number }>(
      "INSERT INTO group_task_events (group_id, number, event, actor_kind, actor_id, actor_name, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      groupId,
      number,
      event,
      by?.kind ?? "system",
      by?.id ?? null,
      by?.name ?? null,
      JSON.stringify(payload),
      now(),
    );
    return Number(row!.id);
  }

  /** Takes the task off a message, with its history; the message stays. */
  deleteTask(groupId: string, number: number): void {
    this.db.tx(() => {
      this.db.run("DELETE FROM group_tasks WHERE group_id = ? AND number = ?", groupId, number);
      this.db.run("DELETE FROM group_task_events WHERE group_id = ? AND number = ?", groupId, number);
    });
  }

  /** Adds a reaction, or removes it when the actor already reacted with that emoji. */
  toggleReaction(groupId: string, seq: number, actor: { id: string; name: string }, emoji: string): void {
    this.db.tx(() => {
      const existing = this.db.get("SELECT 1 AS x FROM group_reactions WHERE group_id = ? AND seq = ? AND actor_id = ? AND emoji = ?", groupId, seq, actor.id, emoji);
      if (existing) this.db.run("DELETE FROM group_reactions WHERE group_id = ? AND seq = ? AND actor_id = ? AND emoji = ?", groupId, seq, actor.id, emoji);
      else this.react(groupId, seq, actor, emoji);
    });
  }

  react(groupId: string, seq: number, actor: { id: string; name: string }, emoji: string): void {
    this.db.run("INSERT OR IGNORE INTO group_reactions (group_id, seq, actor_id, actor_name, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?)", groupId, seq, actor.id, actor.name, emoji, now());
  }

  // ---------------------------------------------------------------- reminders

  /**
   * A bot's reminder by id or id prefix, among its own in this group
   * with these statuses (all of them when none are given).
   */
  findReminder(groupId: string, ownerId: string, id: string, statuses?: readonly ReminderStatus[]): { ok: true; reminder: Reminder } | { ok: false; error: string } {
    const prefix = id.trim().replace(/^#/, "").toLowerCase();
    if (!prefix) return { ok: false, error: "id is required" };
    const matches = this.reminders(groupId, { ownerId, statuses }).filter((reminder) => reminder.id.startsWith(prefix));
    const scope = statuses ? `${statuses.join("/")} reminder` : "reminder";
    if (matches.length === 0) return { ok: false, error: `No ${scope} of yours matches id prefix '${prefix}'.` };
    if (matches.length > 1) return { ok: false, error: `Ambiguous id prefix '${prefix}' matches ${matches.length} reminders; pass a longer id.` };
    return { ok: true, reminder: matches[0]! };
  }

  reminderById(id: string): Reminder | null {
    const row = this.db.get<ReminderRow>(`${REMINDER_SELECT} WHERE r.id = ?`, id);
    return row ? reminderOf(row) : null;
  }

  /** A group's reminders, soonest first, optionally one owner's and these statuses. */
  reminders(groupId: string, filter: { ownerId?: string; statuses?: readonly ReminderStatus[] } = {}): Reminder[] {
    return this.db
      .all<ReminderRow>(`${REMINDER_SELECT} WHERE r.group_id = ? ORDER BY r.fire_at, r.created_at DESC`, groupId)
      .map(reminderOf)
      .filter((reminder) => (!filter.ownerId || reminder.ownerId === filter.ownerId) && (!filter.statuses || filter.statuses.includes(reminder.status)));
  }

  scheduleReminder(input: { groupId: string; ownerId: string; anchor: number; title: string; fireAt: Date; recurrence: Recurrence | null; actor: string }): Reminder {
    const id = randomUUID();
    const at = now();
    this.db.tx(() => {
      this.db.run(
        "INSERT INTO group_reminders (id, group_id, owner_id, anchor_seq, title, fire_at, recurrence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        input.groupId,
        input.ownerId,
        input.anchor,
        input.title,
        input.fireAt.toISOString(),
        input.recurrence ? JSON.stringify(input.recurrence) : null,
        at,
        at,
      );
      this.reminderEvent(id, input.groupId, "scheduled", input.actor, input.fireAt.toISOString());
    });
    return this.reminderById(id)!;
  }

  /** Snooze: a scheduled or fired reminder fires again this long from now. */
  snoozeReminder(id: string, seconds: number, actor: string): Reminder | null {
    return this.db.tx(() => {
      const current = this.reminderById(id);
      if (!current || current.status === "canceled") return null;
      const fireAt = new Date(Date.now() + seconds * 1000).toISOString();
      this.db.run("UPDATE group_reminders SET status = 'scheduled', fire_at = ?, wake_pending = 0, updated_at = ?, version = version + 1 WHERE id = ?", fireAt, now(), id);
      this.reminderEvent(id, current.groupId, "snoozed", actor, fireAt);
      return this.reminderById(id);
    });
  }

  /** Update: one field of a scheduled reminder; a new cadence fires next by its own rule. */
  updateReminder(id: string, patch: { title: string } | { fireAt: Date } | { recurrence: Recurrence }, actor: string): Reminder | null {
    return this.db.tx(() => {
      const current = this.reminderById(id);
      if (!current || current.status !== "scheduled") return null;
      const at = now();
      if ("title" in patch) this.db.run("UPDATE group_reminders SET title = ?, updated_at = ?, version = version + 1 WHERE id = ?", patch.title, at, id);
      else if ("fireAt" in patch) this.db.run("UPDATE group_reminders SET fire_at = ?, updated_at = ?, version = version + 1 WHERE id = ?", patch.fireAt.toISOString(), at, id);
      else this.db.run("UPDATE group_reminders SET recurrence = ?, fire_at = ?, updated_at = ?, version = version + 1 WHERE id = ?", JSON.stringify(patch.recurrence), computeNextFire(patch.recurrence, new Date()).toISOString(), at, id);
      const updated = this.reminderById(id)!;
      this.reminderEvent(id, current.groupId, "updated", actor, updated.fireAt);
      return updated;
    });
  }

  /** Cancel: a scheduled or fired reminder won't fire again. */
  cancelReminder(id: string, actor: string): Reminder | null {
    return this.db.tx(() => {
      const current = this.reminderById(id);
      if (!current || current.status === "canceled") return null;
      const at = now();
      this.db.run("UPDATE group_reminders SET status = 'canceled', canceled_at = ?, wake_pending = 0, updated_at = ?, version = version + 1 WHERE id = ?", at, at, id);
      this.reminderEvent(id, current.groupId, "canceled", actor, null);
      return this.reminderById(id);
    });
  }

  /** The scheduled reminders due by `at`, in every group. */
  dueReminders(at: Date): Reminder[] {
    return this.db.all<ReminderRow>(`${REMINDER_SELECT} WHERE r.status = 'scheduled' AND r.fire_at <= ? ORDER BY r.fire_at`, at.toISOString()).map(reminderOf);
  }

  /** When the next scheduled reminder is due, in any group. */
  nextReminderAt(): string | null {
    return this.db.get<{ fire_at: string | null }>("SELECT MIN(fire_at) AS fire_at FROM group_reminders WHERE status = 'scheduled'")?.fire_at ?? null;
  }

  /**
   * Fires a reminder, guarded by the version the caller read: a one-time reminder is fired; a
   * recurring one stays scheduled for its next time, counted from the slot it just used or from
   * now when that's later (missed slots are skipped, not replayed). Its owner's wake is pending
   * until a seat takes it.
   */
  fireReminder(id: string, version: number, catchup: boolean, at: Date = new Date()): Reminder | null {
    return this.db.tx(() => {
      const current = this.reminderById(id);
      if (!current || current.status !== "scheduled" || current.version !== version || Date.parse(current.fireAt) > at.getTime()) return null;
      const iso = at.toISOString();
      if (current.recurrence) {
        const slot = new Date(Math.max(Date.parse(current.fireAt), at.getTime()));
        const next = computeNextFire(current.recurrence, slot).toISOString();
        this.db.run("UPDATE group_reminders SET fire_at = ?, fired_at = ?, wake_pending = 1, wake_catchup = ?, updated_at = ?, version = version + 1 WHERE id = ?", next, iso, catchup ? 1 : 0, iso, id);
        this.reminderEvent(id, current.groupId, "fired", "system", next);
      } else {
        this.db.run("UPDATE group_reminders SET status = 'fired', fired_at = ?, wake_pending = 1, wake_catchup = ?, updated_at = ?, version = version + 1 WHERE id = ?", iso, catchup ? 1 : 0, iso, id);
        this.reminderEvent(id, current.groupId, "fired", "system", null);
      }
      return this.reminderById(id);
    });
  }

  /** A bot's fired reminders whose wake hasn't reached its seat yet. */
  pendingReminderWakes(groupId: string, ownerId: string): (Reminder & { catchup: boolean })[] {
    return this.db
      .all<ReminderRow>(`${REMINDER_SELECT} WHERE r.group_id = ? AND r.owner_id = ? AND r.wake_pending = 1 ORDER BY r.fired_at`, groupId, ownerId)
      .map((row) => ({ ...reminderOf(row), catchup: row.wake_catchup === 1 }));
  }

  markRemindersWoken(ids: readonly string[]): void {
    for (const id of ids) this.db.run("UPDATE group_reminders SET wake_pending = 0 WHERE id = ?", id);
  }

  /** A reminder's history, newest first. */
  reminderEvents(id: string): ReminderEvent[] {
    return this.db.all<{ at: string; event: ReminderEvent["event"]; actor: string; next_fire_at: string | null }>("SELECT at, event, actor, next_fire_at FROM group_reminder_events WHERE reminder_id = ? ORDER BY id DESC", id).map((row) => ({ at: row.at, event: row.event, actor: row.actor, nextFireAt: row.next_fire_at }));
  }

  private reminderEvent(id: string, groupId: string, event: ReminderEvent["event"], actor: string, nextFireAt: string | null): void {
    this.db.run("INSERT INTO group_reminder_events (reminder_id, group_id, at, event, actor, next_fire_at) VALUES (?, ?, ?, ?, ?, ?)", id, groupId, now(), event, actor, nextFireAt);
  }
}

/** Who wrote a message, as a receiver: "user" or a bot's id; null for a note. */
function senderOf(message: GroupMessage): string | null {
  return message.from.kind === "bot" ? message.from.botId : message.from.kind === "user" ? GROUP_USER_ID : null;
}
