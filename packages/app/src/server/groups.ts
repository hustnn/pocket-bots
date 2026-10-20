import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { answersInOrder, questionsOf } from "@pocket-bots/runtime/questions";
import { mimeTypeFor, newAttachmentId, preflightFile, type ComposerAttachment, type WireAttachment } from "../shared/attachments";
import type { Bot } from "../shared/bot";
import { foldText } from "../shared/activity";
import type { ApprovalDecision, ApprovalRequest, ChatSnapshot } from "../shared/chat-types";
import {
  BOT_FILES_MAX,
  BOT_TEXT_MAX,
  defaultGroupName,
  DELIVERY_MAX,
  deliveryFailureOf,
  GROUP_LABEL,
  GROUP_USER,
  GROUP_USER_ID,
  groupQuestion,
  HELD_SHOWN,
  heldText,
  historyText,
  inboxText,
  membersProblem,
  mentionDeliveryText,
  messagePreview,
  newGroupChatId,
  parseMentions,
  placeName,
  questionText,
  searchText,
  taskAmendedText,
  taskHistoryText,
  taskLabel,
  taskShowText,
  TaskStatusSchema,
  threadMismatchText,
  undeliveredMentionsText,
  wakeText,
  fromLead,
  pieceFor,
  type GroupAttachment,
  type GroupLead,
  type GroupMessage,
  type GroupQuestion,
  type GroupSender,
  type GroupSummary,
  type GroupTask,
  type HeldInput,
  type Member,
  type MentionDeliveryRow,
  type Mentions,
  type PendingMessage,
  type ReceiverRow,
  type RosterEntry,
  type SystemSubtype,
  type TaskAssignee,
  type TaskStatus,
  type ThreadJoin,
  type WakeMode,
} from "../shared/group-chat";
import { dataPath } from "./bot-home";
import { briefingPanel } from "./briefing";
import { isBusy } from "./chat-service";
import type { StartChatInput } from "./chats";
import { botWorkingFolder, sendToChat, workFolder } from "./chats";
import { RequestError } from "./errors";
import type { PocketHost } from "./host";
import {
  computeNextFire,
  formatRecurrence,
  localTimeZone,
  parseDuration,
  parseRecurrence,
  reminderCanceled,
  reminderFiredText,
  reminderLine,
  reminderLog,
  reminderReceipt,
  REMINDER_TITLE_MAX,
  resolveFireAt,
  validTimeZone,
  type Recurrence,
  type ReminderStatus,
} from "./reminders";
import { isSeen, type AppendInput, type GroupRow, type GroupStore, type TaskAmendment } from "./group-store";
import {
  claimAutomaticStart,
  freshBreaker,
  freshCrashLoop,
  liftBreaker,
  noteExit,
  noteSpawned,
  noteSpawnError,
  noteTerminalFailure,
  noteTurnCompleted,
  pausedText,
  spawnErrorRetryJitterMs,
  spawnRetryDue,
  type CrashLoop,
  type TerminalBreaker,
} from "./breakers";
import { runtimeErrorPolicy, type RuntimeErrorPolicy } from "./runtime-errors";
import type { GroupSearchHit } from "./search";

// Group chats (docs/group-chats.md walks through them). This class runs the
// group's flows: the bots' tools, the check before a post, notices and seats. The group's state,
// with each receiver's delivery records, read positions and model-seen ledger, lives in SQLite
// (group-store.ts); each bot takes part through its seat, an ordinary chat of its own.

/** Starts a bot's seat chat for a group. */
export type SeatStarter = (bot: Bot, input: StartChatInput & { group: { id: string; name: string } }) => Promise<string>;

/** What a turn of a seat ended with. */
export interface SeatTurnEnd {
  outcome: "completed" | "failed" | "canceled";
  error: string | null;
  /** Ended by ChatService's supervision, not the runtime (TurnEndedEvent.supervision). */
  supervision?: "start_failed" | "stalled";
}

/** A post the check may hold as a draft: its text, what it answers, and the files it attaches (paths). */
type HeldDraft = { text: string; replyTo: number | null; files?: readonly string[] };

/** The files a delivery carries at most (newest kept). */
const DELIVERY_FILES = 8;
const groupsPath = () => join(dataPath(), "groups");
export const groupFilesPath = (groupId: string) => join(groupsPath(), groupId, "files");
const GROUP_ID = /^group-[a-z0-9]+$/;
/** Replies before the @mention that a thread-join context shows (6). */
const THREAD_JOIN_RECENT = 6;
/** Messages of its piece of work a led member's wake shows in full (8); more stay in its inbox to read. */
const HANDED_MAX = 8;
/** Messages a renewed seat's briefing shows. */
const BRIEFING_MESSAGES = 25;
const USER_ID = GROUP_USER_ID;
/** Tasks still being worked on. */
const OPEN_TASKS: TaskStatus[] = ["todo", "in_progress"];
/** Task lifecycle notes: an emoji and a label per status. */
const STATUS_EMOJI: Record<TaskStatus, string> = { todo: "📝", in_progress: "🔄", done: "✅", closed: "🚫" };
const STATUS_LABEL: Record<TaskStatus, string> = { todo: "Todo", in_progress: "In Progress", done: "Done", closed: "Closed" };
/** The same failure of the same bot is noted once in this long. */
const FAILURE_NOTE_MS = 10 * 60_000;
/** A reminder that fires this late was missed (pocket-bots was stopped): its wake says catch-up. */
const REMINDER_CATCHUP_MS = 60_000;
/** The reminder timer is re-armed at least this often (a timer can't wait longer than ~24 days). */
const REMINDER_TIMER_MAX_MS = 6 * 3600_000;
/**
 * Runtime-error delivery backoff: after a recoverable failure, 10 s doubling per failure in a row up to 5 min, plus up to 10%.
 */
export const RUNTIME_ERROR_BACKOFF_BASE_MS = 10_000;
export const RUNTIME_ERROR_BACKOFF_MAX_MS = 5 * 60_000;
const RUNTIME_ERROR_BACKOFF_JITTER = 0.1;
/** Failures in a row with the same fingerprint that stop waking a bot. */
export const FENCE_THRESHOLD = 3;
/**
 * Spawn-fail backoff: a seat that couldn't start is tried again after
 * 1 s, doubling up to 30 s; after 5 failed starts in a row (SPAWN_FAIL_MAX_ATTEMPTS) it isn't tried
 * again by itself.
 */
export const SPAWN_FAIL_BACKOFF_BASE_MS = 1_000;
export const SPAWN_FAIL_BACKOFF_MAX_MS = 30_000;
export const SPAWN_FAIL_MAX_ATTEMPTS = 5;
/** A busy seat's notice waits this long, so a burst is one notice. */
export const BUSY_NOTICE_DELAY_MS = 3_000;
/** A busy seat that didn't take its notice is tried again after this. */
export const BUSY_NOTICE_RETRY_MS = 15_000;

/** A seat's wait before it's told again: its runtime failed, or its seat couldn't start (spawn-fail backoff). */
interface Backoff {
  attempts: number;
  until: number;
  reason: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Runtime-error fingerprint fence: failures in a row with the same fingerprint. It trips
 * at the third and at every one after it, until a completed turn or a restart clears it.
 */
interface Fence {
  fingerprint: string;
  attempts: number;
}

/** What group_reminder takes. */
export interface ReminderInput {
  action: "schedule" | "list" | "snooze" | "update" | "cancel" | "log";
  id?: string | null;
  title?: string | null;
  message?: number | null;
  delaySeconds?: number | null;
  fireAt?: string | null;
  repeat?: string | null;
  tz?: string | null;
  by?: string | null;
  in?: string | null;
  all?: boolean;
}

export interface GroupOptions {
  /**
   * A seat idle this long with this much context starts over as a new seat with the group's
   * history: resuming a big, cold context costs more than a fresh one.
   */
  recycleAfterMs?: number;
  recycleTokens?: number;
  /** The backoff's jitter, a number in [0, 1). */
  random?: () => number;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
}

/** How a question settles: the user answered or dismissed it, or it stopped waiting without them. */
function settledQuestion(question: GroupQuestion, decision: ApprovalDecision, reason: "answered" | "ended" | "closed"): Pick<GroupQuestion, "status" | "answers"> {
  if (reason !== "answered") return { status: "closed", answers: null };
  if (decision.behavior !== "allow") return { status: "dismissed", answers: null };
  return { status: "answered", answers: answersInOrder(questionsOf(question.input) ?? [], decision) };
}

export function groupFilePath(groupId: string, name: string): string | null {
  if (!GROUP_ID.test(groupId) || name !== basename(name) || name.startsWith(".")) return null;
  return join(groupFilesPath(groupId), name);
}

/** Amend limits: a title of 1 to 10,000 characters, a description up to 50,000. */
const TASK_TITLE_MAX = 10_000;
const TASK_DESCRIPTION_MAX = 50_000;

/** A task amendment from a new title and/or description (null clears it), within the amend limits. */
function amendment(title: string | undefined, description: string | null | undefined): TaskAmendment {
  if (title === undefined && description === undefined) throw new RequestError("At least one amendment is required: title, description, or clear_description.");
  const patch: TaskAmendment = {};
  if (title !== undefined) {
    const trimmed = title.trim();
    if (!trimmed) throw new RequestError("A task's title can't be empty.");
    if (trimmed.length > TASK_TITLE_MAX) throw new RequestError(`A task's title can be at most ${TASK_TITLE_MAX} characters.`);
    patch.title = trimmed;
  }
  if (description !== undefined) {
    if (description !== null && description.length > TASK_DESCRIPTION_MAX) throw new RequestError(`A task's description can be at most ${TASK_DESCRIPTION_MAX} characters.`);
    patch.description = description;
  }
  return patch;
}

export class GroupChats {
  /** Notices in flight: the messages a notice carries (a thread-join context, a catch-up batch), credited as seen once its seat accepts it. */
  /** What a notice showed, recorded as seen once its seat takes it in; `piece`: the led member's piece of work, whose thread it was shown from its top. */
  private readonly deliveries = new Map<string, { groupId: string; botId: string; joins: { thread: number; parent: number; upTo: number }[]; seen: Pick<GroupMessage, "seq" | "thread">[]; piece?: number }>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly failures = new Map<string, { error: string; at: number }>();
  /** Per seat (group:bot), in memory: delivery backoffs, spawn-fail backoffs, fences, busy notices waiting. */
  private readonly errorBackoffs = new Map<string, Backoff>();
  /** `serverStart`: the local retries stopped, and the next start is the one a wake allowed. */
  private readonly spawnBackoffs = new Map<string, Backoff & { stopped: boolean; serverStart?: boolean }>();
  private readonly fences = new Map<string, Fence>();
  /**
   * Seats whose runtime a terminal failure stopped (a sign-in or plan problem, billing, an
   * unsupported model, input too large, or the fence). Its next wake, a message or a reminder,
   * starts it again unless a breaker refuses; the seat stays, and that wake is what lets it be
   * told again.
   */
  private readonly stopped = new Set<string>();
  /** Per seat: the terminal-failure breaker (with its spawn-error backoff) and the crash-loop breaker. */
  private readonly breakers = new Map<string, TerminalBreaker>();
  private readonly crashLoops = new Map<string, CrashLoop>();
  /** The spawn-error retry sweep, one timer per seat a spawn error paused. */
  private readonly sweepTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly noticeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly random: () => number;
  private readonly recycleAfterMs: number;
  private readonly recycleTokens: number;
  private reminderTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly host: PocketHost,
    private readonly store: GroupStore,
    private readonly startSeat: SeatStarter,
    private readonly changed: (groupId: string) => void = () => {},
    options: GroupOptions = {},
  ) {
    this.recycleAfterMs = options.recycleAfterMs ?? 60 * 60_000;
    this.recycleTokens = options.recycleTokens ?? 128_000;
    this.random = options.random ?? Math.random;
  }

  // ---------------------------------------------------------------- the user's side

  async list(): Promise<GroupSummary[]> {
    return this.store.groups().map((group) => this.summary(group));
  }

  groupName(groupId: string): string | null {
    return this.store.group(groupId)?.name ?? null;
  }

  /**
   * What a seat's prompt says about its group: the name, and with a leader, the seat's part: the
   * leader, with what each member it hands work to does and runs on, or a member, with its leader.
   */
  async seatGroup(groupId: string, botId: string | null): Promise<{ name: string; lead?: GroupLead } | null> {
    const group = this.store.group(groupId);
    if (!group) return null;
    const leaderId = this.store.leader(groupId);
    if (!leaderId || !botId) return { name: group.name };
    const bots = await this.liveBots();
    if (botId !== leaderId) return { name: group.name, lead: { role: "member", leader: bots.get(leaderId)?.name ?? "the leader" } };
    const members = this.store.members(groupId).flatMap((member) => {
      const bot = member.bot_id === leaderId ? null : bots.get(member.bot_id);
      if (!bot) return [];
      const runtime = this.host.runtimes.get(bot.provider as never)?.label ?? bot.provider;
      const about = [bot.title.trim(), bot.description.trim() ? foldText(bot.description, 200) : "", `runs on ${runtime}${bot.model ? ` with ${bot.model}` : ""}`].filter(Boolean).join(" · ");
      return [{ name: bot.name, about }];
    });
    return { name: group.name, lead: { role: "leader", members } };
  }

  private summary(group: GroupRow): GroupSummary {
    const members = this.store.members(group.id);
    const last = this.store.latest(group.id, 1).at(-1);
    const unread = this.store.unreadPlaces(group.id, USER_ID);
    return {
      id: group.id,
      name: group.name,
      memberIds: members.map((member) => member.bot_id),
      updatedAt: group.updated_at,
      lastSeq: group.last_seq,
      readSeq: this.store.cursor(group.id, USER_ID, 0),
      wakeMode: group.wake_mode,
      leaderId: this.store.leader(group.id),
      cwd: group.cwd,
      muted: members.filter((member) => member.muted_from_seq !== null).map((member) => member.bot_id),
      unread: unread.length > 0,
      unreadThreads: unread.filter((place) => place.conv).map((place) => place.conv),
      last: last ? { from: last.from, text: last.text, at: last.at } : null,
      seats: Object.fromEntries(members.map((member) => [member.bot_id, member.seat_chat_id])),
    };
  }

  /** A new group; with `leaderId`, that member plans and hands out the work; with `cwd`, every seat works in that folder. */
  async create(input: { name?: string | null; memberIds: string[]; leaderId?: string | null; cwd?: string | null }): Promise<{ id: string }> {
    const memberIds = [...new Set(input.memberIds)];
    const problem = membersProblem(memberIds);
    if (problem) throw new RequestError(problem);
    const bots = await this.liveBots();
    const missing = memberIds.find((id) => !bots.has(id));
    if (missing) throw new RequestError(`There's no bot with the id ${missing}.`);
    if (input.leaderId && !memberIds.includes(input.leaderId)) throw new RequestError("The leader must be one of the group's bots.");
    const cwd = input.cwd?.trim() ? await workFolder(input.cwd) : null;
    const id = newGroupChatId();
    this.store.createGroup({ id, name: input.name?.trim() || defaultGroupName(memberIds.map((botId) => bots.get(botId)!.name)), memberIds, leaderId: input.leaderId ?? null, cwd });
    this.changed(id);
    return { id };
  }

  /**
   * `leaderId`: a member to lead the group, null for no leader; left out, the leader stays.
   * `cwd`: the folder its seats work in, null (or empty) for each bot's own; left out, it stays.
   */
  async update(groupId: string, input: { name?: string | null; memberIds?: string[] | null; wakeMode?: WakeMode | null; leaderId?: string | null; cwd?: string | null }): Promise<void> {
    const group = this.require(groupId);
    // Checked before anything changes, so a folder that isn't there changes nothing.
    const cwd = input.cwd === undefined ? undefined : input.cwd?.trim() ? await workFolder(input.cwd) : null;
    if (input.name !== undefined && input.name !== null && input.name.trim()) this.store.updateGroup(groupId, { name: input.name.trim() });
    if (input.wakeMode) this.store.updateGroup(groupId, { wakeMode: input.wakeMode });
    const before = this.store.leader(groupId);
    if (input.leaderId && !(input.memberIds ?? this.store.members(groupId).map((member) => member.bot_id)).includes(input.leaderId)) throw new RequestError("The leader must be one of the group's bots.");
    if (input.memberIds) {
      const next = [...new Set(input.memberIds)];
      const problem = membersProblem(next);
      if (problem) throw new RequestError(problem);
      const bots = await this.allBots();
      const current = this.store.members(groupId).map((member) => member.bot_id);
      for (const botId of next.filter((id) => !current.includes(id))) {
        this.store.addMember(groupId, botId);
        this.note(groupId, `${bots.get(botId)?.name ?? "A bot"} joined the group.`, "group.membership", USER_ID);
      }
      for (const botId of current.filter((id) => !next.includes(id))) {
        const member = this.store.member(groupId, botId);
        this.forgetSeat(groupId, botId);
        this.store.removeMember(groupId, botId);
        if (member?.seat_chat_id) await this.host.chats.archive(member.seat_chat_id).catch(() => undefined);
        this.store.setSeat(groupId, botId, null);
        this.note(groupId, `${bots.get(botId)?.name ?? "A bot"} left the group.`, "group.membership", USER_ID);
      }
    }
    if (input.leaderId !== undefined) this.store.updateGroup(groupId, { leaderId: input.leaderId });
    const after = this.store.leader(groupId);
    if (after !== before) await this.leaderNote(groupId, after);
    if (cwd !== undefined && cwd !== group.cwd) {
      this.store.updateGroup(groupId, { cwd });
      // A session can't change folders: each seat moves the next time it starts a turn (pump).
      this.note(groupId, cwd ? `📁 the user set the group's working folder to ${cwd}: each bot's next turn here runs there.` : "📁 the user removed the group's working folder: each bot's next turn here runs in its own folder.", "group.folder", USER_ID);
    }
    this.changed(groupId);
  }

  /** The folder a member's seat works in: the group's, or the bot's own. */
  private seatFolder(group: GroupRow, bot: Bot): string {
    return group.cwd ?? botWorkingFolder(bot);
  }

  /**
   * Tells every member the group's leader changed: the seats already open keep the prompt they
   * started with until they reopen, so the note says the new rule itself.
   */
  private async leaderNote(groupId: string, leaderId: string | null): Promise<void> {
    const name = leaderId ? ((await this.allBots()).get(leaderId)?.name ?? "A bot") : null;
    const text = name
      ? `👑 the user made @${name} the group's leader: from now on the other bots work only on what ${name} or the user hands them (an @mention, a reply or an assigned task), and report back to ${name}.`
      : "the user removed the group's leader: every bot hears the group's messages again and decides for itself whether to take part.";
    const { woken } = this.store.append(groupId, { kind: "system" } as GroupSender, { text, everyone: true, mentions: leaderId ? [leaderId] : [], subtype: "group.leader", causalActor: USER_ID });
    this.wake(groupId, woken);
  }

  async remove(groupId: string): Promise<void> {
    this.require(groupId);
    for (const member of this.store.members(groupId, true)) {
      this.forgetSeat(groupId, member.bot_id);
      if (member.seat_chat_id) await this.host.chats.archive(member.seat_chat_id).catch(() => undefined);
    }
    this.store.deleteGroup(groupId);
    this.changed(groupId);
  }

  /** The top level, or with `thread` that thread's top message followed by its replies. */
  async messages(groupId: string, input: { before?: number | null; limit?: number; thread?: number | null } = {}): Promise<{ messages: GroupMessage[]; hasOlder: boolean }> {
    this.require(groupId);
    if (!input.thread) return this.store.page(groupId, input);
    const page = this.store.threadPage(groupId, input.thread, input);
    if (!page.parent) throw new RequestError(`There's no message #${input.thread}.`);
    return { messages: [...(page.hasOlder ? [] : [page.parent]), ...page.messages], hasOlder: page.hasOlder };
  }

  /** The user read the top level (or a thread) up to `seq`. */
  async markRead(groupId: string, seq: number, thread: number | null = null): Promise<void> {
    this.store.markRead(groupId, USER_ID, thread ?? 0, seq);
    this.changed(groupId);
  }

  async setMuted(groupId: string, botId: string, muted: boolean): Promise<void> {
    this.store.setMuted(groupId, botId, muted);
    this.changed(groupId);
  }

  /**
   * The user's message: it reaches its receivers, and the bots it's delivered to hear about it.
   * `asTask` sends it as a task (todo, unassigned) with no note ("As task").
   */
  async postFromUser(groupId: string, input: { text: string; replyTo?: number | null; thread?: number | null; attachments?: ComposerAttachment[]; asTask?: boolean }): Promise<number> {
    this.require(groupId);
    const members = await this.liveMembers(groupId);
    const thread = this.venue(groupId, input.thread ?? null, input.replyTo ?? null);
    if (input.asTask && thread) throw new RequestError("Only top-level messages can be tasks; a message in a thread is discussion.");
    const attachments = await this.keepAttachments(groupId, input.attachments ?? []);
    const mentions = parseMentions(input.text, members, await this.outsiders(groupId));
    const { message, woken } = this.store.append(groupId, { kind: "user" }, { text: input.text, replyTo: input.replyTo ?? null, thread, attachments, ...this.mentionFields(mentions) });
    // The task exists before any bot reads the message, so it reads as one.
    if (input.asTask) this.store.convertToTask(groupId, message.seq, GROUP_USER);
    // The user @mentioning a bot that was stopped or paused is its manual start.
    for (const botId of mentions.botIds) this.restart(groupId, botId);
    this.wake(groupId, woken);
    return message.seq;
  }

  /**
   * The user's task actions. The user owns the group, so any status may be set directly and
   * any task taken over. A claim, a release,
   * an assignment and a status change are noted in the task's thread; making one a task is noted
   * at the top level, and removing one is noted for nobody's unread. Amending a card isn't noted;
   * its history keeps the change.
   */
  async userTask(
    groupId: string,
    input: { action: "claim" | "convert" | "unclaim" | "status" | "assign" | "delete" | "amend"; seq?: number | null; number?: number | null; status?: TaskStatus | null; assignee?: string | null; title?: string | null; description?: string | null },
  ): Promise<void> {
    this.require(groupId);
    const me = GROUP_USER;
    if (input.action === "claim" || input.action === "convert" || (input.action === "assign" && !input.number)) {
      if (!input.seq) throw new RequestError("Which message?");
      this.taskable(groupId, input.seq);
    }
    const number = (): number => {
      const task = this.store.task(groupId, { number: input.number ?? null, seq: input.seq ?? null });
      if (!task) throw new RequestError("That isn't a task.");
      return task.number;
    };
    switch (input.action) {
      case "claim": {
        const result = this.store.claimTask(groupId, { seq: input.seq! }, me);
        if (!result.ok) throw new RequestError(`Claim refused: ${result.reason}.`);
        if (result.created) this.convertedNote(groupId, result.task, "the user", USER_ID);
        this.lifecycleNote(groupId, result.task, `📌 the user claimed ${this.taskRef(groupId, result.task)}`, USER_ID);
        break;
      }
      case "convert": {
        const { task, created } = this.store.convertToTask(groupId, input.seq!, me);
        if (created) this.convertedNote(groupId, task, "the user", USER_ID);
        break;
      }
      case "unclaim": {
        const result = this.store.unclaimTask(groupId, number(), me);
        if (!result.ok) throw new RequestError(`Not unclaimed: ${result.reason}.`);
        this.lifecycleNote(groupId, result.task, `🔓 the user released ${this.taskRef(groupId, result.task)}`, USER_ID);
        break;
      }
      case "status": {
        if (!input.status) throw new RequestError("Which status?");
        const result = this.store.setTaskStatus(groupId, number(), input.status, me, true);
        if (!result.ok) throw new RequestError(result.reason);
        this.lifecycleNote(groupId, result.task, this.statusNote("the user", groupId, result.task), USER_ID);
        break;
      }
      case "assign": {
        let target: number;
        if (input.number) target = number();
        else {
          const converted = this.store.convertToTask(groupId, input.seq!, me);
          if (converted.created) this.convertedNote(groupId, converted.task, "the user", USER_ID);
          target = converted.task.number;
        }
        const assignee = await this.assignee(groupId, input.assignee ?? null);
        const before = this.store.task(groupId, { number: target })!;
        const result = this.store.assignTask(groupId, target, assignee, me);
        if (!result.ok) throw new RequestError(`Not assigned: ${result.reason}.`);
        if (result.task.revision !== before.revision) {
          this.lifecycleNote(groupId, result.task, assignee ? `📌 the user assigned ${this.taskRef(groupId, result.task)} to ${assignee.name}` : `🔓 the user unassigned ${this.taskRef(groupId, result.task)}`, USER_ID);
        }
        break;
      }
      case "delete": {
        const task = this.store.task(groupId, { number: number() })!;
        const ref = this.taskRef(groupId, task);
        this.store.deleteTask(groupId, task.number);
        this.note(groupId, `🗑 the user deleted ${ref}`, "task.deleted_summary", USER_ID);
        break;
      }
      case "amend": {
        const result = this.store.amendTask(groupId, number(), amendment(input.title ?? undefined, input.description === undefined ? undefined : input.description?.trim() ? input.description : null), me);
        if (!result.ok) throw new RequestError(`Not amended: ${result.reason}.`);
        break;
      }
    }
    this.changed(groupId);
  }

  /** The group's tasks for the task board, each with its message's first line and thread size. */
  async listTasks(groupId: string): Promise<(GroupTask & { preview: string; replies: number })[]> {
    this.require(groupId);
    const tasks = this.store.tasks(groupId);
    const messages = new Map(this.store.messagesAt(groupId, tasks.map((task) => task.seq)).map((message) => [message.seq, message]));
    return tasks.map((task) => {
      const message = messages.get(task.seq);
      return { ...task, preview: messagePreview({ text: task.title, attachments: message?.attachments ?? [] }, 140), replies: message?.replies ?? 0 };
    });
  }

  /** The bots' pending reminders in the group, soonest first, for the user to look at. */
  async listReminders(groupId: string): Promise<{ id: string; owner: string; title: string; anchor: number; anchorThread: number | null; fireAt: string; firedAt: string | null; status: ReminderStatus; repeat: string | null }[]> {
    this.require(groupId);
    const bots = await this.allBots();
    return this.store.reminders(groupId, { statuses: ["scheduled"] }).map((reminder) => ({
      id: reminder.id,
      owner: bots.get(reminder.ownerId)?.name ?? reminder.ownerId,
      title: reminder.title,
      anchor: reminder.anchor,
      anchorThread: reminder.anchorThread,
      fireAt: reminder.fireAt,
      firedAt: reminder.firedAt,
      status: reminder.status,
      repeat: reminder.recurrence ? formatRecurrence(reminder.recurrence) : null,
    }));
  }

  /** The user's reaction; a second one with the same emoji takes it back. */
  async userReact(groupId: string, seq: number, emoji: string): Promise<void> {
    this.require(groupId);
    if (!this.store.messageAt(groupId, seq)) throw new RequestError(`There's no message #${seq}.`);
    this.store.toggleReaction(groupId, seq, { id: USER_ID, name: "the user" }, emoji.trim().slice(0, 16) || "👍");
    this.changed(groupId);
  }

  async searchMessages(groupId: string, query: string): Promise<GroupMessage[]> {
    this.require(groupId);
    return this.store.search(groupId, query, 50);
  }

  /** The user's search across groups (search.ts): messages with every term, newest first. */
  searchAll(terms: readonly string[], scope: { groupId?: string; limit?: number }): GroupSearchHit[] {
    return this.store.searchAll(terms, scope);
  }

  // ---------------------------------------------------------------- the bots' tools

  /**
   * group_send: posts at the top level or in a thread, after the check (see preflight). A reply
   * to a message in a thread goes in that thread. A top-level post right after reading a thread
   * is asked about once.
   */
  async send(bot: Bot, groupId: string, input: { text: string; replyTo?: number | null; thread?: number | null; idempotencyKey?: string | null; files?: readonly string[] }): Promise<string> {
    this.requireMember(groupId, bot.id);
    const text = input.text.slice(0, BOT_TEXT_MAX);
    // Text first: files go with a message, never instead of one.
    if (!text.trim()) throw new RequestError(input.files?.length ? "Write the message too: its text says what the files are and what you need." : "There's nothing to send.");
    const files = await this.botFiles(groupId, bot.id, input.files ?? []);
    const replyTo = input.replyTo ?? null;
    const conv = this.venue(groupId, input.thread ?? null, replyTo) ?? 0;
    const members = await this.liveMembers(groupId);
    if (conv === 0) {
      const thread = this.store.latestReadThread(groupId, bot.id);
      if (thread) {
        this.store.saveDraft(groupId, bot.id, 0, { text, replyTo, held: false, files });
        return threadMismatchText(thread);
      }
    }
    const held = this.preflight(bot, groupId, conv, "send", { text, replyTo, files });
    if (held) return held;
    return this.post(bot, groupId, conv, text, replyTo, input.idempotencyKey ?? null, members, files);
  }

  /** group_send_draft: sends a held draft unchanged (checked again unless `anyway`), or drops it. */
  async sendDraft(bot: Bot, groupId: string, input: { thread?: number | null; anyway?: boolean; discard?: boolean }): Promise<string> {
    this.requireMember(groupId, bot.id);
    const conv = input.thread ? (this.venue(groupId, input.thread, null) ?? 0) : (this.store.drafts(groupId, bot.id)[0]?.conv ?? 0);
    const draft = this.store.draft(groupId, bot.id, conv);
    if (!draft) return `There's no draft for ${placeName(conv)} (drafts are kept for 10 minutes). If it's still needed, send it again with group_send.`;
    if (input.discard) {
      this.store.dropDraft(groupId, bot.id, conv);
      return `Dropped your draft for ${placeName(conv)}.`;
    }
    const members = await this.liveMembers(groupId);
    if (!input.anyway) {
      const held = this.preflight(bot, groupId, conv, "send", { text: draft.text, replyTo: draft.reply_to, files: draft.files });
      if (held) return held;
    }
    return this.post(bot, groupId, conv, draft.text, draft.reply_to, draft.draft_key, members, draft.files);
  }

  /**
   * group_read, four kinds of read:
   * - unread and no place: everything in the bot's inbox, oldest first. Sparse, so each message
   *   is recorded as seen one by one;
   * - unread at a place: that place's messages after the bot's read position;
   * - a place's latest messages or those before a number, or the messages around one (`around`,
   *   an anchored lookup: each message is recorded one by one).
   * A place's read that joins up with the bot's read position moves its model-seen boundary (and
   * read position) to the newest message read; one that leaves a gap records each
   * message instead.
   */
  async read(bot: Bot, groupId: string, input: { unread?: boolean; before?: number | null; around?: number | null; limit?: number; thread?: number | null; topLevel?: boolean }): Promise<string> {
    this.requireMember(groupId, bot.id);
    const limit = Math.max(1, Math.min(input.limit ?? (input.unread ? DELIVERY_MAX : 20), DELIVERY_MAX));
    if (input.unread && !input.thread && !input.topLevel) {
      const pending = this.store.pending(groupId, bot.id);
      if (pending.length === 0) return "Your inbox is empty: nothing new was delivered to you. group_inbox lists any place with unread messages.";
      const shown = pending.slice(0, limit).map((entry) => entry.message);
      this.store.recordSeenMessages(groupId, bot.id, shown);
      const rest = pending.length - shown.length;
      return historyText(shown, false, bot.id, { parents: this.parents(groupId, shown) }) + (rest > 0 ? `\n\n(${rest} more in your inbox: group_read with unread: true again.)` : "");
    }
    if (input.around) {
      const anchor = this.store.messageAt(groupId, input.around);
      if (!anchor) throw new RequestError(`There's no message #${input.around}.`);
      const conv = anchor.thread ?? 0;
      const page = this.store.convAround(groupId, conv, anchor.seq, limit);
      this.store.recordSeen(groupId, bot.id, conv, { exact: page.messages.map((message) => message.seq) });
      const parents = this.parents(groupId, page.messages);
      const lines = [`Around #${anchor.seq} at ${placeName(conv)}, oldest first:`];
      if (page.hasOlder) lines.push(`(Earlier messages exist: group_read with ${conv ? `thread: ${conv}, ` : ""}before: ${page.messages[0]!.seq}.)`);
      lines.push(historyText(page.messages, false, bot.id, { parents }));
      if (page.hasNewer) lines.push(`(Later messages exist: group_read with around: ${page.messages.at(-1)!.seq}.)`);
      return lines.join("\n\n");
    }
    const conv = input.thread ? this.threadOf(groupId, input.thread) : 0;
    const prior = this.store.cursor(groupId, bot.id, conv);
    if (input.unread) {
      const page = this.store.convPage(groupId, conv, { after: prior, limit });
      const before = this.store.ledger(groupId, bot.id, conv);
      this.consumeRead(bot.id, groupId, conv, page.messages, true);
      // Its own messages are never unread for it: they move the position but aren't shown. What it
      // was already shown (a hold, a notice's thread context) is folded into one line.
      const mine = (message: GroupMessage) => message.from.kind === "bot" && message.from.botId === bot.id;
      const others = page.messages.filter((message) => !mine(message));
      const folded = others.filter((message) => isSeen(before, message.seq));
      const shown = others.filter((message) => !isSeen(before, message.seq));
      const more = page.hasNewer ? this.store.convPage(groupId, conv, { after: page.messages.at(-1)!.seq, limit: DELIVERY_MAX }).messages.filter((message) => !mine(message)).length : 0;
      if (others.length === 0) return `No unread messages at ${placeName(conv)}.`;
      const notes: string[] = [];
      if (folded.length) notes.push(`${folded.length} message${folded.length === 1 ? "" : "s"} you were already shown (${folded.length === 1 ? `#${folded[0]!.seq}` : `#${folded[0]!.seq} to #${folded.at(-1)!.seq}`}) ${folded.length === 1 ? "isn't" : "aren't"} repeated; group_read with around: ${folded[0]!.seq} shows ${folded.length === 1 ? "it" : "them"} again.`);
      const now = this.store.cursor(groupId, bot.id, conv);
      if (now > prior) notes.push(`Read position at ${placeName(conv)}: #${prior} → #${now}.`);
      if (more > 0) notes.push(`More unread at ${placeName(conv)}: group_read with unread: true and ${conv ? `thread: ${conv}` : "top_level: true"} again.`);
      const body = shown.length ? historyText(shown, false, bot.id, { parents: this.parents(groupId, shown) }) : `No new unread messages at ${placeName(conv)}.`;
      return [body, ...notes.map((note) => `(${note})`)].join("\n\n");
    }
    const page = this.store.convPage(groupId, conv, { before: input.before ?? null, limit });
    this.consumeRead(bot.id, groupId, conv, page.messages, !page.hasOlder || (page.messages[0]?.seq ?? Infinity) <= prior);
    if (!conv) return historyText(page.messages, page.hasOlder, bot.id);
    const parent = this.store.messageAt(groupId, conv)!;
    // The top message is shown with the thread's first page; it's the top level's, seen one by one there.
    if (!page.hasOlder) this.store.recordSeen(groupId, bot.id, 0, { exact: [parent.seq] });
    const messages = page.hasOlder ? page.messages : [parent, ...page.messages];
    return historyText(messages, page.hasOlder, bot.id, { thread: conv }) + (page.messages.length === 0 ? "\n\n(No replies in its thread yet.)" : "");
  }

  /**
   * Records a place's read: its boundary, booked as the bot's latest read
   * of the place, when the read joins up with the read position; each message, unbooked, when it
   * leaves a gap. An empty read moves nothing but is still booked as a read of the place.
   */
  private consumeRead(botId: string, groupId: string, conv: number, messages: readonly GroupMessage[], joins: boolean): void {
    const seqs = messages.map((message) => message.seq);
    if (seqs.length === 0) this.store.recordSeen(groupId, botId, conv, { read: true });
    else if (joins) this.store.recordSeen(groupId, botId, conv, { boundary: Math.max(...seqs), read: true });
    else this.store.recordSeen(groupId, botId, conv, { exact: seqs });
  }

  /** group_inbox: where the bot has unread messages, without reading them. */
  async inbox(bot: Bot, groupId: string, input: { mentions?: boolean } = {}): Promise<string> {
    this.requireMember(groupId, bot.id);
    const notNoticed = new Map<number, number>();
    for (const entry of this.store.pending(groupId, bot.id)) {
      if (!entry.noticed) notNoticed.set(entry.message.thread ?? 0, (notNoticed.get(entry.message.thread ?? 0) ?? 0) + 1);
    }
    return inboxText(this.store.unreadPlaces(groupId, bot.id), bot.id, { mentionsOnly: input.mentions ?? false, notNoticed });
  }

  /** group_search: previews around the match, which don't count as seen. */
  async search(bot: Bot, groupId: string, query: string): Promise<string> {
    this.requireMember(groupId, bot.id);
    const hits = this.store.search(groupId, query);
    return searchText(query, hits, bot.id, this.parents(groupId, hits));
  }

  /**
   * group_follow: follow a thread, stop following one (a note in the thread says why, for
   * nobody's unread), or list the threads followed.
   */
  async follow(bot: Bot, groupId: string, input: { thread?: number | null; follow?: boolean; reason?: string | null; list?: boolean }): Promise<string> {
    this.requireMember(groupId, bot.id);
    if (input.list) {
      const follows = this.store.follows(groupId, bot.id);
      if (follows.length === 0) return "No followed threads.";
      const parents = new Map(this.store.messagesAt(groupId, follows.map((follow) => follow.thread)).map((message) => [message.seq, message]));
      return [
        `Followed threads (${follows.length}):`,
        ...follows.map((follow) => {
          const parent = parents.get(follow.thread);
          const on = parent ? ` on ${parent.from.kind === "bot" ? (parent.from.botId === bot.id ? "you" : parent.from.name) : parent.from.kind === "user" ? "the user" : "pocket-bots"}: "${messagePreview(parent, 60)}"` : "";
          return `- thread #${follow.thread}${on} (followed since ${follow.followedAt.slice(0, 16).replace("T", " ")}Z, reason=${follow.reason})`;
        }),
      ].join("\n");
    }
    if (!input.thread) throw new RequestError("Which thread? Give its top message's number (thread: N), or list: true.");
    const thread = this.threadOf(groupId, input.thread);
    if (input.follow !== false) {
      this.store.follow(groupId, thread, bot.id, "manual", true);
      return `Following thread #${thread}: its replies reach you.`;
    }
    this.store.unfollow(groupId, thread, bot.id);
    const reason = input.reason?.trim() || "no longer following";
    this.note(groupId, `@${bot.name} stopped following this thread: ${messagePreview({ text: reason, attachments: [] }, 200)}`, "thread.self_unfollow", bot.id, thread);
    return [
      `Unfollowed thread #${thread}. Ordinary delivery for this thread has stopped.`,
      "A later personal @mention there reaches you and re-follows you; that delivery says how to stop again.",
      "Posting in this thread re-follows you automatically.",
    ].join("\n");
  }

  /**
   * group_claim: a message's number makes it a task and claims it, a task's
   * number claims that task. The first claim wins. Checked like a post, and
   * noted nowhere, not even when it made the message a task: the task's label shows it.
   */
  async claim(bot: Bot, groupId: string, seq: number): Promise<string> {
    this.requireMember(groupId, bot.id);
    const message = this.taskable(groupId, seq);
    const refused = await this.notHandedTo(bot, groupId, message);
    if (refused) return refused;
    const held = this.preflight(bot, groupId, 0, "claim");
    if (held) return held;
    const result = this.store.claimTask(groupId, { seq }, { kind: "bot", id: bot.id, name: bot.name });
    if (!result.ok) return `Claim refused for task #${seq}: ${result.reason}. This is a lock on that work, not a ruling on who should do it: don't start the same work. If you think it's misrouted, say so in the task's thread (thread #${seq}).`;
    this.changed(groupId);
    const leaderId = this.store.leader(groupId);
    if (leaderId && leaderId !== bot.id) {
      const leader = (await this.allBots()).get(leaderId)?.name ?? "the leader";
      return `You've claimed task #${seq}; it's ${result.task.status}. When it's done, answer in its thread (thread: ${seq}) @mentioning ${leader}; ${leader} sets its status.`;
    }
    return `You've claimed task #${seq}; it's ${result.task.status}. Read its thread first if it has one. When the work is done, set it to done with group_task (action update) and say in the group what you did.`;
  }

  /**
   * group_task: create, convert, update a status, unclaim, assign, amend, show, history, delete, or
   * list. Only a status change is checked like a post (as a send and a claim are); amend, delete
   * and the rest aren't.
   */
  async task(
    bot: Bot,
    groupId: string,
    input: {
      action: "create" | "convert" | "update" | "unclaim" | "assign" | "amend" | "show" | "history" | "delete" | "list";
      task?: number | null;
      status?: TaskStatus | null;
      titles?: string[] | null;
      assignee?: string | null;
      filter?: string | null;
      mine?: boolean | null;
      expectedRevision?: number | null;
      title?: string | null;
      description?: string | null;
      clearDescription?: boolean | null;
    },
  ): Promise<string> {
    this.requireMember(groupId, bot.id);
    const me: TaskAssignee = { kind: "bot", id: bot.id, name: bot.name };
    const number = (): number => {
      if (!input.task) throw new RequestError("Which task? Give its number (task: N).");
      if (!this.store.task(groupId, { number: input.task })) throw new RequestError(`There's no task #${input.task}.`);
      return input.task;
    };
    switch (input.action) {
      case "list": {
        const filter = input.filter ?? "open";
        const statuses: TaskStatus[] | undefined = filter === "all" ? undefined : filter === "open" ? OPEN_TASKS : [TaskStatusSchema.parse(filter)];
        const tasks = this.store.tasks(groupId, { ...(statuses ? { statuses } : {}), ...(input.mine ? { assigneeId: bot.id } : {}) });
        if (tasks.length === 0) return `No ${filter === "all" ? "" : `${filter} `}tasks${input.mine ? " assigned to you" : ""}.`;
        const messages = new Map(this.store.messagesAt(groupId, tasks.map((task) => task.seq)).map((message) => [message.seq, message]));
        return tasks
          .map((task) => {
            const replies = messages.get(task.seq)?.replies ?? 0;
            const description = task.description !== null ? `\n  Current description: ${messagePreview({ text: task.description, attachments: [] }, 200)}` : "";
            return `- ${taskLabel(task, bot.id)} · rev=${task.revision}: ${this.titleOf(groupId, task, 90)}${replies ? ` (${replies} replies in its thread)` : ""}${description}`;
          })
          .join("\n");
      }
      case "create":
        return this.createTasks(bot, groupId, input.titles ?? [], input.assignee ?? null);
      case "convert": {
        if (!input.task) throw new RequestError("Which message? (task: its number)");
        this.taskable(groupId, input.task);
        const { task, created } = this.store.convertToTask(groupId, input.task, me);
        if (!created) return `#${input.task} is already ${taskLabel(task, bot.id)}.`;
        this.convertedNote(groupId, task, bot.name, bot.id);
        this.changed(groupId);
        return `#${input.task} is now task #${task.number}, todo and unassigned.`;
      }
      case "update": {
        if (!input.status) throw new RequestError("Which status? One of todo, in_progress, done, closed.");
        const target = number();
        const held = this.preflight(bot, groupId, 0, "task");
        if (held) return held;
        const result = this.store.setTaskStatus(groupId, target, input.status, me);
        if (!result.ok) return `Not changed: ${result.reason}.`;
        this.lifecycleNote(groupId, result.task, this.statusNote(bot.name, groupId, result.task), bot.id);
        this.changed(groupId);
        // With a leader, the leader sets done after checking a member's work it didn't do itself.
        const report = result.task.status === "done" && !this.store.leader(groupId);
        return `Task #${target} is now ${result.task.status}.${report ? " Say in the group what you did." : ""}`;
      }
      case "unclaim": {
        const result = this.store.unclaimTask(groupId, number(), me);
        if (!result.ok) return `Not unclaimed: ${result.reason}.`;
        this.changed(groupId);
        return `Task #${result.task.number} unclaimed — now open (still ${result.task.status}); anyone can claim it.`;
      }
      case "assign": {
        // Task assign: ownership moves, the status stays (claim is what starts the work).
        const target = number();
        const assignee = await this.assignee(groupId, input.assignee ?? null, bot);
        await this.assignable(bot, groupId, assignee);
        const result = this.store.assignTask(groupId, target, assignee, me, input.expectedRevision ?? null);
        if (!result.ok) {
          return result.reason === "task state changed concurrently"
            ? `Not assigned: task #${target} changed since you read it; it's now ${result.task ? `${taskLabel(result.task, bot.id)}, rev=${result.task.revision}` : "gone"}. Look at it again before deciding.`
            : `Not assigned: ${result.reason}.`;
        }
        this.changed(groupId);
        if (!assignee) return `Task #${target} unassigned — now open (rev=${result.task.revision}).`;
        if (assignee.id === bot.id) return `Task #${target} is assigned to you, still ${result.task.status} (rev=${result.task.revision}); claim it with group_claim when you start.`;
        return `Task #${target} assigned to ${assignee.name}, still ${result.task.status} (rev=${result.task.revision}). Nobody is told: if ${assignee.name} should start, @mention them with what you need.`;
      }
      case "amend": {
        // Task amend: any member may; the message keeps its words, the history keeps the change.
        const target = number();
        if (input.description != null && input.clearDescription) throw new RequestError("Use either description or clear_description, not both.");
        const patch = amendment(input.title ?? undefined, input.clearDescription ? null : (input.description ?? undefined));
        const result = this.store.amendTask(groupId, target, patch, me);
        if (!result.ok) return `Not amended: ${result.reason}.`;
        this.changed(groupId);
        return taskAmendedText(result.task, result.eventSeq);
      }
      case "show": {
        const task = this.store.task(groupId, { number: number() })!;
        return taskShowText(task, bot.id, await this.creatorName(task.createdBy, bot.id));
      }
      case "history": {
        const target = number();
        return taskHistoryText(this.store.task(groupId, { number: target })!, this.store.taskEvents(groupId, target), bot.id);
      }
      case "delete": {
        // Task delete: only its creator (or an admin; here, the user). Closing is the alternative.
        const task = this.store.task(groupId, { number: number() })!;
        if (task.createdBy !== bot.id) {
          return `Not deleted: only the task's creator (${await this.creatorName(task.createdBy, bot.id)}) or the user can delete task #${task.number}. Ask one of them, or close it instead (action update, status closed).`;
        }
        const ref = this.taskRef(groupId, task);
        this.store.deleteTask(groupId, task.number);
        this.note(groupId, `🗑 ${bot.name} deleted ${ref}`, "task.deleted_summary", bot.id);
        this.changed(groupId);
        return `#${task.number} deleted. Its message stays.`;
      }
    }
  }

  /** Who made a task a task, by name ("you" for the asking bot). */
  private async creatorName(createdBy: string, meId: string): Promise<string> {
    if (createdBy === USER_ID) return "the user";
    if (createdBy === meId) return "you";
    return (await this.allBots()).get(createdBy)?.name ?? (createdBy || "unknown");
  }

  /**
   * Task create: each title is posted as the bot's own message and becomes a task. With an
   * assignee, the task is reserved for them, and one receipt @mentions them (they're told even
   * when muted); "me" starts them at once, in_progress. Otherwise a summary notes the new tasks.
   */
  private async createTasks(bot: Bot, groupId: string, rawTitles: readonly string[], who: string | null): Promise<string> {
    const titles = rawTitles.map((title) => title.trim()).filter(Boolean).slice(0, 10);
    if (titles.length === 0) throw new RequestError("Give the tasks' titles (titles: [...]).");
    const me: TaskAssignee = { kind: "bot", id: bot.id, name: bot.name };
    const self = !!who && ["me", bot.id.toLowerCase(), bot.name.toLowerCase()].includes(who.trim().replace(/^@/, "").toLowerCase());
    const assignee: TaskAssignee | null = self ? me : await this.assignee(groupId, who);
    await this.assignable(bot, groupId, assignee);
    const members = await this.liveMembers(groupId);
    const outsiders = await this.outsiders(groupId);
    const tasks: GroupTask[] = [];
    for (const title of titles) {
      const { message, woken } = this.store.append(groupId, { kind: "bot", botId: bot.id, name: bot.name }, { text: title, ...this.mentionFields(parseMentions(title, members, outsiders)) });
      this.wake(groupId, woken);
      tasks.push(this.store.convertToTask(groupId, message.seq, me, { assignee, start: self }).task);
    }
    const list = tasks.map((task) => `task #${task.number} "${this.titleOf(groupId, task)}"`).join(", ");
    const many = tasks.length === 1 ? list : `${tasks.length} new tasks: ${list}`;
    if (assignee) {
      const text = self ? `📌 @${bot.name} started ${many}` : `📌 Assigned ${assignee.kind === "bot" ? "@" : ""}${assignee.name} to ${many}`;
      this.note(groupId, text, "task.assignment_receipt", bot.id, null, assignee.kind === "bot" ? [assignee.id] : []);
    } else {
      this.note(groupId, `📋 ${tasks.length} new task${tasks.length === 1 ? "" : "s"} created: ${tasks.map((task) => `#${task.number} "${this.titleOf(groupId, task)}"`).join(", ")}`, "task.created_summary", bot.id);
    }
    this.changed(groupId);
    return tasks.map((task) => `Created task #${task.number}, ${task.status}, ${task.assignee ? (task.assignee.id === bot.id ? "yours" : `assigned to ${task.assignee.name}`) : "unassigned"}.`).join("\n");
  }

  /**
   * In a group with a leader, why a member may not claim a message: it takes only what the leader
   * or the user handed it (a message of theirs that @mentions it, or a task assigned to it). Null
   * when it may.
   */
  private async notHandedTo(bot: Bot, groupId: string, message: GroupMessage): Promise<string | null> {
    const leaderId = this.store.leader(groupId);
    if (!leaderId || leaderId === bot.id) return null;
    const task = this.store.task(groupId, { seq: message.seq });
    if (task?.assignee?.id === bot.id) return null;
    const senderId = message.from.kind === "bot" ? message.from.botId : message.from.kind;
    if (!task?.assignee && message.mentions.includes(bot.id) && fromLead(leaderId, { kind: message.from.kind, senderId, causalActor: null })) return null;
    const leader = (await this.allBots()).get(leaderId)?.name ?? "the leader";
    return `Claim refused for #${message.seq}: in this group ${leader} hands out the work, and you take only what ${leader} or the user hands you (a message of theirs that @mentions you, or a task assigned to you). Don't start this work. If you think it should be yours, ask @${leader}.`;
  }

  /** The group has a leader, and it isn't this bot. */
  ledBy(groupId: string, botId: string): boolean {
    const leaderId = this.store.leader(groupId);
    return leaderId !== null && leaderId !== botId;
  }

  /** In a group with a leader, a member can't hand work to another member: only the leader hands it out. */
  private async assignable(bot: Bot, groupId: string, assignee: TaskAssignee | null): Promise<void> {
    const leaderId = this.store.leader(groupId);
    if (!leaderId || leaderId === bot.id || assignee?.kind !== "bot" || assignee.id === bot.id) return;
    const leader = (await this.allBots()).get(leaderId)?.name ?? "the leader";
    throw new RequestError(`In this group ${leader} hands out the work: you can't assign tasks to other members. Tell @${leader} what ${assignee.name} should do and why.`);
  }

  /** Who a task goes to by name: a member bot ("me" is the asking bot), the user, or nobody. */
  private async assignee(groupId: string, who: string | null, me?: Bot): Promise<TaskAssignee | null> {
    const target = who?.trim().replace(/^@/, "") ?? "";
    if (!target || target.toLowerCase() === "nobody") return null;
    if (me && target.toLowerCase() === "me") return { kind: "bot", id: me.id, name: me.name };
    if (["user", "the user", "you"].includes(target.toLowerCase())) return { kind: "user", id: USER_ID, name: "the user" };
    const members = await this.liveMembers(groupId);
    const bot = members.find((member) => member.id === target) ?? members.find((member) => member.name.toLowerCase() === target.toLowerCase());
    if (!bot) throw new RequestError(`${target} isn't assignable in this group. Assign a member bot by name, "the user", or nobody.`);
    return { kind: "bot", id: bot.id, name: bot.name };
  }

  /** A message that can be a task: a top-level message, not a note. */
  private taskable(groupId: string, seq: number): GroupMessage {
    const message = this.store.messageAt(groupId, seq);
    if (!message) throw new RequestError(`There's no message #${seq}.`);
    if (message.from.kind === "system") throw new RequestError(`#${seq} is a note from pocket-bots, not a request.`);
    if (message.thread) throw new RequestError(`Only top-level messages can be tasks; #${seq} is discussion in thread #${message.thread}. Make #${message.thread} the task, or post the work as a new top-level message.`);
    return message;
  }

  async react(bot: Bot, groupId: string, seq: number, emoji: string): Promise<string> {
    this.requireMember(groupId, bot.id);
    if (!this.store.messageAt(groupId, seq)) throw new RequestError(`There's no message #${seq}.`);
    this.store.react(groupId, seq, { id: bot.id, name: bot.name }, emoji.trim().slice(0, 16) || "👍");
    this.changed(groupId);
    return `Reacted to #${seq}.`;
  }

  async mute(bot: Bot, groupId: string, muted: boolean): Promise<string> {
    this.requireMember(groupId, bot.id);
    this.store.setMuted(groupId, bot.id, muted);
    this.changed(groupId);
    return muted
      ? "Muted: ordinary top-level messages no longer reach you here. An @mention, a task assigned to you and the threads you follow still do."
      : "Unmuted: every message reaches you again.";
  }

  /**
   * group_reminder: a bot's own wake-up later, anchored to a message in
   * the group. When it fires, only its owner hears (a notice to its seat); to tell someone else,
   * the owner @mentions them then. A bot sees and changes only its own reminders.
   */
  async reminder(bot: Bot, groupId: string, input: ReminderInput): Promise<string> {
    this.requireMember(groupId, bot.id);
    const now = new Date();
    if (input.action === "list") {
      const statuses: ReminderStatus[] = input.all ? ["scheduled", "fired", "canceled"] : ["scheduled", "fired"];
      const reminders = this.store.reminders(groupId, { ownerId: bot.id, statuses });
      return reminders.length ? reminders.map((reminder) => reminderLine(reminder, now)).join("\n") : "No reminders.";
    }
    if (input.action === "schedule") {
      const title = input.title?.trim() ?? "";
      if (!title) throw new RequestError("title is required");
      if (title.length > REMINDER_TITLE_MAX) throw new RequestError(`title must be at most ${REMINDER_TITLE_MAX} characters`);
      if (!input.message) throw new RequestError("message is required: the number of the message this reminder is about");
      if (!this.store.messageAt(groupId, input.message)) throw new RequestError(`There's no message #${input.message}.`);
      if (input.tz && !input.repeat) throw new RequestError("tz requires repeat");
      const recurrence = this.recurrenceOf(input.repeat ?? null, input.tz ?? null);
      let fireAt: Date;
      let warning: string | undefined;
      if (input.delaySeconds != null || input.fireAt) {
        const resolved = resolveFireAt({ delaySeconds: input.delaySeconds, fireAt: input.fireAt }, now.getTime());
        if (!resolved.ok) throw new RequestError(resolved.error);
        ({ fireAt, warning } = resolved);
      } else if (recurrence) {
        fireAt = computeNextFire(recurrence, now);
      } else {
        throw new RequestError("Give delay_seconds, fire_at or repeat");
      }
      const reminder = this.store.scheduleReminder({ groupId, ownerId: bot.id, anchor: input.message, title, fireAt, recurrence, actor: bot.name });
      this.armReminders();
      this.changed(groupId);
      return reminderReceipt("scheduled", reminder, warning);
    }
    if (!input.id) throw new RequestError("id is required (from group_reminder list, the 8 characters after #)");
    if (input.action === "log") {
      const found = this.store.findReminder(groupId, bot.id, input.id);
      if (!found.ok) throw new RequestError(found.error);
      return reminderLog(this.store.reminderEvents(found.reminder.id));
    }
    const found = this.store.findReminder(groupId, bot.id, input.id, ["scheduled", "fired"]);
    if (!found.ok) throw new RequestError(found.error);
    const current = found.reminder;
    let result: string;
    if (input.action === "snooze") {
      const seconds = input.by ? parseDuration(input.by) : null;
      if (!seconds) throw new RequestError("by must be a positive duration like 30m, 2h, or 1d");
      const snoozed = this.store.snoozeReminder(current.id, seconds, bot.name);
      if (!snoozed) throw new RequestError("Reminder state changed; list your reminders and retry");
      result = reminderReceipt("snoozed", snoozed);
    } else if (input.action === "cancel") {
      const canceled = this.store.cancelReminder(current.id, bot.name);
      if (!canceled) throw new RequestError("Reminder state changed; list your reminders and retry");
      result = reminderCanceled(canceled);
    } else {
      if (current.status === "fired") throw new RequestError(`Reminder #${current.id.slice(0, 8)} is fired; snooze it back to scheduled before updating, or schedule a new reminder`);
      const given = [input.title != null, input.fireAt != null, input.in != null, input.repeat != null].filter(Boolean).length;
      if (given !== 1) throw new RequestError("update takes exactly one of title, fire_at, in, or repeat");
      let patch: { title: string } | { fireAt: Date } | { recurrence: Recurrence };
      let warning: string | undefined;
      if (input.title != null) {
        const title = input.title.trim();
        if (!title) throw new RequestError("title must not be empty");
        if (title.length > REMINDER_TITLE_MAX) throw new RequestError(`title must be at most ${REMINDER_TITLE_MAX} characters`);
        patch = { title };
      } else if (input.repeat != null) {
        patch = { recurrence: this.recurrenceOf(input.repeat, input.tz ?? null)! };
      } else {
        const seconds = input.in != null ? parseDuration(input.in) : null;
        if (input.in != null && !seconds) throw new RequestError("in must be a positive duration like 30m, 2h, or 1d");
        const resolved = resolveFireAt(seconds ? { delaySeconds: seconds } : { fireAt: input.fireAt }, now.getTime());
        if (!resolved.ok) throw new RequestError(resolved.error);
        patch = { fireAt: resolved.fireAt };
        warning = resolved.warning;
      }
      const updated = this.store.updateReminder(current.id, patch, bot.name);
      if (!updated) throw new RequestError("Reminder state changed; list your reminders and retry");
      result = reminderReceipt("updated", updated, warning);
    }
    this.armReminders();
    this.changed(groupId);
    return result;
  }

  /** A repeat rule; daily and weekly ones keep the time zone they were set in (this computer's unless given). */
  private recurrenceOf(repeat: string | null, tz: string | null): Recurrence | null {
    if (!repeat) return null;
    const zone = tz?.trim() || localTimeZone();
    if (!validTimeZone(zone)) throw new RequestError(`tz must be a valid IANA time zone; got ${zone}`);
    const parsed = parseRecurrence(repeat, zone);
    if (!parsed.ok) throw new RequestError(`repeat: ${parsed.error}`);
    return parsed.recurrence;
  }

  /**
   * group_mention_delivery: what happened to each member a message
   * of the bot's @mentioned. delivered once its model has read it; still in flight
   * while it waits in its inbox; lost when telling it failed (its seat couldn't start, or the turn
   * it was told in failed: rate or quota limited, or another error) or it left the group or was
   * archived first; unknown without a record. Then who else the message reached, and who
   * that was there didn't get it.
   */
  async mentionDelivery(bot: Bot, groupId: string, seq: number): Promise<string> {
    this.requireMember(groupId, bot.id);
    const message = this.store.messageAt(groupId, seq);
    // Someone else's message reads the same as one that doesn't exist.
    if (!message || message.from.kind !== "bot" || message.from.botId !== bot.id) throw new RequestError(`#${seq} isn't a message you sent; group_mention_delivery is for your own messages.`);
    const bots = await this.allBots();
    const conv = message.thread ?? 0;
    const records = new Map(this.store.receivers(groupId, seq).map((row) => [row.receiverId, row]));
    const read = (id: string) => !!records.get(id)?.drained || this.store.cursor(groupId, id, conv) >= seq || (id !== USER_ID && isSeen(this.store.ledger(groupId, id, conv), seq));
    const members = this.store.members(groupId);
    const active = new Set(members.map((member) => member.bot_id));
    const mentioned = this.store.mentionsOf(groupId, seq);
    const rows: MentionDeliveryRow[] = mentioned.map((row) => {
      const handle = row.handle || `@${bots.get(row.targetId)?.name ?? row.targetId}`;
      const record = records.get(row.targetId);
      const target = bots.get(row.targetId);
      if (!record) return { handle, outcome: "unknown" };
      if (read(row.targetId)) return { handle, outcome: "delivered" };
      if (record.failure) return { handle, outcome: "lost", category: record.failure };
      if (!target || target.archived) return { handle, outcome: "lost", category: "not_launched" };
      if (!active.has(row.targetId)) return { handle, outcome: "lost", category: "unclassified" };
      return { handle, outcome: "pending", told: record.noticed, accepted: record.accepted };
    });
    const mentionedIds = new Set(mentioned.map((row) => row.targetId));
    const name = (id: string) => (id === USER_ID ? "the user" : (bots.get(id)?.name ?? id));
    const others: ReceiverRow[] = [...records.values()]
      .filter((row) => row.receiverId !== bot.id && !mentionedIds.has(row.receiverId))
      .map((row) => ({ name: name(row.receiverId), state: read(row.receiverId) ? "read" : row.inbox ? "inbox" : "unread" }));
    // Who was there when it was sent and got no record: muted at the top level, or outside its thread.
    const missed = [...members.filter((member) => member.joined_seq < seq).map((member) => member.bot_id), USER_ID].filter((id) => id !== bot.id && !records.has(id)).map(name);
    return mentionDeliveryText(seq, rows, others, missed);
  }

  async membersText(bot: Bot, groupId: string): Promise<string> {
    this.requireMember(groupId, bot.id);
    const bots = await this.allBots();
    const leaderId = this.store.leader(groupId);
    const lines = this.store.members(groupId).map((member) => {
      const entry = bots.get(member.bot_id);
      const chat = member.seat_chat_id ? this.host.chats.get(member.seat_chat_id) : null;
      const tasks = this.store.tasks(groupId, { statuses: OPEN_TASKS, assigneeId: member.bot_id });
      const parts = [`${entry?.name ?? member.bot_id}${member.bot_id === bot.id ? " (you)" : ""}`];
      if (member.bot_id === leaderId) parts.push("leader: plans and hands out the work");
      if (entry?.title.trim()) parts.push(entry.title.trim());
      parts.push(chat && isBusy(chat.status) ? "working" : "idle");
      if (member.muted_from_seq !== null) parts.push("muted");
      if (tasks.length) parts.push(`tasks: ${tasks.map((task) => `#${task.number} (${task.status})`).join(", ")}`);
      return `- ${parts.join(" · ")}`;
    });
    return [...lines, "- the user"].join("\n");
  }

  // ---------------------------------------------------------------- the check before a post

  /**
   * The freshness check before a post, a claim or a status change at a place (`conv`),
   * returning the hold's text, or null to go ahead. Its stages, in order:
   * 1. the inbox: messages delivered there and not read. If the model
   *    hasn't seen some, hold and show the newest three;
   * 2. no inbox and no boundary yet (first touch): the place's latest three, held for if unseen;
   * 3. for a post: what came in after the boundary the model has seen, minus
   *    what it saw one by one and its own: at the top level its delivery records, in a thread all
   *    of the thread's messages. A thread it never read counts from the top message.
   * Whatever a hold shows is recorded as seen. A held post is kept as the place's draft.
   */
  private preflight(bot: Bot, groupId: string, conv: number, action: HeldInput["action"], draft?: HeldDraft): string | null {
    const me = bot.id;
    const ledger = this.store.ledger(groupId, me, conv);
    const seen = (message: GroupMessage) => (message.from.kind === "bot" && message.from.botId === me) || isSeen(ledger, message.seq);
    const seqs = (messages: readonly GroupMessage[]) => messages.map((message) => message.seq);
    let forward: number | null = null;
    const pending = this.store.pending(groupId, me, conv).map((entry) => entry.message);
    if (pending.length) {
      const unseen = pending.filter((message) => !seen(message));
      if (unseen.length) {
        const shown = unseen.slice(-HELD_SHOWN);
        this.store.recordSeen(groupId, me, conv, { exact: seqs([...pending.filter(seen), ...shown]) });
        return this.hold(bot, groupId, action, draft, { conv, shown, count: unseen.length, omitted: unseen.length - shown.length, firstTouch: false });
      }
      this.store.recordSeen(groupId, me, conv, { exact: seqs(pending) });
      const max = Math.max(...seqs(pending));
      if ((ledger.boundary ?? 0) >= max) forward = max;
    } else if ((ledger.boundary ?? 0) > 0) {
      forward = ledger.boundary;
    } else if (conv !== 0 || !this.ledBy(groupId, me)) {
      // A member the leader leads isn't part of the top level's conversation: only what's handed to it reaches it there.
      const recent = this.store.convPage(groupId, conv, { limit: HELD_SHOWN }).messages;
      if (recent.length) {
        const unseen = recent.filter((message) => !seen(message));
        this.store.recordSeen(groupId, me, conv, { exact: seqs(recent) });
        if (unseen.length) return this.hold(bot, groupId, action, draft, { conv, shown: unseen, count: unseen.length, omitted: 0, firstTouch: true });
        forward = Math.max(...seqs(recent));
      }
    }
    if (action !== "send") return null;

    const boundary = forward ?? ledger.boundary;
    const after = boundary ?? (conv || 0);
    const exact = this.store.ledger(groupId, me, conv).exact;
    const rows = this.store.freshnessRows(groupId, me, conv, after);
    const counted = rows.filter((seq) => !exact.has(seq));
    if (counted.length === 0) return null;
    const latest = rows.at(-1)!;
    const shown = this.store.messagesAt(groupId, counted.slice(-HELD_SHOWN));
    const proof = boundary !== null || [...exact].some((seq) => seq > after && seq <= latest);
    // Showing everything it counted is as good as reading it there; otherwise only what's shown leaves the inbox.
    if (shown.length >= counted.length) this.store.markHeldRead(groupId, me, conv, latest);
    this.store.recordSeen(groupId, me, conv, { exact: seqs(shown) });
    return this.hold(bot, groupId, action, draft, {
      conv,
      shown,
      count: proof ? counted.length : shown.length,
      omitted: proof ? counted.length - shown.length : 0,
      firstTouch: !proof,
      parent: conv ? this.store.messageAt(groupId, conv) : null,
    });
  }

  private hold(bot: Bot, groupId: string, action: HeldInput["action"], draft: HeldDraft | undefined, held: Omit<HeldInput, "action" | "meId" | "holds">): string {
    const holds = draft ? this.store.saveDraft(groupId, bot.id, held.conv, { text: draft.text, replyTo: draft.replyTo, held: true, ...(draft.files ? { files: draft.files } : {}) }).hold_count : 1;
    return heldText({ ...held, action, meId: bot.id, holds });
  }

  // ---------------------------------------------------------------- events from the chats

  /**
   * pocket-bots started: a seat with unread messages gets them in a bounded
   * catch-up batch; a member without a seat gets the ordinary notice for its inbox.
   */
  resume(): void {
    // A question still pending from before is waiting for nobody now: its approval went with the old process.
    for (const { groupId, seq, question } of this.store.pendingQuestions()) {
      if (!this.waiting(question)) this.store.settleQuestion(groupId, seq, { status: "closed", answers: null });
    }
    for (const group of this.store.groups()) {
      for (const member of this.store.members(group.id)) {
        const seat = member.seat_chat_id ? this.host.chats.get(member.seat_chat_id) : null;
        // A member the leader leads gets only its pieces of work, not a catch-up of the group: what
        // it was told and didn't take in is told again, one piece at a time.
        if (this.ledBy(group.id, member.bot_id)) {
          this.store.retellUntaken(group.id, member.bot_id);
          if (this.store.pending(group.id, member.bot_id).length || this.store.pendingReminderWakes(group.id, member.bot_id).length) void this.serial(group.id, () => this.pump(group.id, member.bot_id));
          continue;
        }
        const catchUp = !!seat && !seat.archivedAt && this.store.unreadPlaces(group.id, member.bot_id).length > 0;
        if (catchUp) void this.serial(group.id, () => this.catchUp(group.id, member.bot_id));
        // A reminder's wake that hadn't reached the seat is still owed; pump skips what the catch-up told.
        if ((!catchUp && this.store.pending(group.id, member.bot_id).length) || this.store.pendingReminderWakes(group.id, member.bot_id).length) void this.serial(group.id, () => this.pump(group.id, member.bot_id));
      }
    }
    // Reminders that came due while pocket-bots was stopped fire now, as catch-ups.
    this.closed = false;
    this.fireReminders(true);
  }

  /** Stops the reminder timer and every seat's waits (pocket-bots is shutting down). */
  close(): void {
    this.closed = true;
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.reminderTimer = null;
    for (const backoff of [...this.errorBackoffs.values(), ...this.spawnBackoffs.values()]) if (backoff.timer) clearTimeout(backoff.timer);
    for (const timer of [...this.noticeTimers.values(), ...this.sweepTimers.values()]) clearTimeout(timer);
    this.noticeTimers.clear();
    this.sweepTimers.clear();
  }

  // ---------------------------------------------------------------- reminders firing

  /**
   * One timer for the soonest scheduled reminder in any group, armed again whenever reminders
   * change.
   */
  private armReminders(): void {
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.reminderTimer = null;
    if (this.closed) return;
    const next = this.store.nextReminderAt();
    if (!next) return;
    const delay = Math.max(0, Math.min(REMINDER_TIMER_MAX_MS, Date.parse(next) - Date.now()));
    this.reminderTimer = setTimeout(() => {
      this.reminderTimer = null;
      this.fireReminders(false);
    }, delay);
    this.reminderTimer.unref?.();
  }

  /** Fires every reminder that's due (each once, by its version) and tells its owner. */
  private fireReminders(catchup: boolean): void {
    if (this.closed) return;
    const at = new Date();
    for (const due of this.store.dueReminders(at)) {
      const late = catchup || at.getTime() - Date.parse(due.fireAt) > REMINDER_CATCHUP_MS;
      const fired = this.store.fireReminder(due.id, due.version, late, at);
      if (!fired) continue;
      this.changed(fired.groupId);
      // A wake like a message's: a stopped bot is started again unless a breaker refuses, and then
      // the reminder's wake is dropped (a reminder isn't kept for a bot that can't start).
      if (!this.automaticStart(fired.groupId, fired.ownerId)) {
        this.store.markRemindersWoken([fired.id]);
        continue;
      }
      void this.serial(fired.groupId, () => this.pump(fired.groupId, fired.ownerId));
    }
    this.armReminders();
  }

  /** A seat's message reached its model: the thread-join context it carried is now seen. */
  onInputAccepted(input: { chatId: string; clientMessageId: string }): void {
    // The inbox messages a notice told are now in front of the seat's runtime (not read yet).
    this.store.markNoticeAccepted(input.clientMessageId);
    const delivery = this.deliveries.get(input.clientMessageId);
    if (!delivery) return;
    this.deliveries.delete(input.clientMessageId);
    for (const join of delivery.joins) {
      // The thread context was shown: the replies are contiguous in the thread; the top message is the top level's.
      this.store.recordSeen(delivery.groupId, delivery.botId, join.thread, { boundary: join.upTo });
      this.store.recordSeen(delivery.groupId, delivery.botId, 0, { exact: [join.parent] });
    }
    // A catch-up batch's messages, each seen one by one.
    this.store.recordSeenMessages(delivery.groupId, delivery.botId, delivery.seen);
    // The session has its piece from the top: a follow-up in its thread needn't bring the thread again.
    if (delivery.piece) this.store.recordSeen(delivery.groupId, delivery.botId, delivery.piece, { boundary: delivery.piece });
  }

  /** A seat's turn is over (its end handled): anything still in its inbox may need a notice now. */
  onAgent(agent: ChatSnapshot): void {
    const groupId = agent.labels[GROUP_LABEL];
    if (!groupId || isBusy(agent.status)) return;
    const member = this.store.memberBySeat(agent.id);
    if (!member || member.group_id !== groupId) return;
    void this.serial(groupId, () => this.pump(groupId, member.bot_id));
  }

  /**
   * A seat's failed turn is noted in its group (for nobody's unread), and what it was told and
   * hadn't read counts as lost, until a later notice
   * tells it again. Then the rules for a runtime error: a recoverable one (rate limited, a
   * provider's server, connection or stream, a usage limit) holds the bot's notices back for a
   * while (noteBackoff); the same failure three times in a row (noteFence), or one only the user
   * can fix, stops its runtime, and its next wake starts it again through the breakers
   * (automaticStart). A completed turn is progress: the waits, the
   * counts and the breakers start over.
   */
  async onTurnEnded(agent: ChatSnapshot, end: SeatTurnEnd): Promise<void> {
    const member = this.store.memberBySeat(agent.id);
    if (!member) return;
    const key = this.key(member.group_id, member.bot_id);
    // A start that showed nothing is a seat that couldn't start (onStartFailed has it).
    if (end.supervision === "start_failed") return;
    if (end.supervision === "stalled") {
      // Stalled recovery is a termination it meant: not a runtime error to back off from or
      // count. ChatService sends what the run hadn't taken in to its new start.
      const bot = await this.host.bot(member.bot_id);
      this.note(member.group_id, `${bot?.name ?? "A bot"}'s run stalled (${end.error ?? "no runtime events"}) and its process was gone, so pocket-bots restarted it.`, "seat.turn_failed", member.bot_id);
      return;
    }
    if (end.outcome !== "failed") {
      if (end.outcome === "completed") {
        this.failures.delete(key);
        this.clearBackoff(key);
        this.fences.delete(key);
        this.stopped.delete(key);
        // A completed turn: the terminal-failure breaker's counts start over, and a probe's success closes it.
        const breaker = this.breakers.get(key);
        if (breaker) noteTurnCompleted(breaker, Date.now());
        this.clearSweep(key);
      }
      return;
    }
    const error = end.error ?? "";
    this.store.markDeliveryFailed(member.group_id, member.bot_id, deliveryFailureOf(error));
    const policy = runtimeErrorPolicy(error, agent.provider);
    const bot = await this.host.bot(member.bot_id);
    const name = bot?.name ?? "A bot";
    const now = Date.now();
    const fenced = this.noteFence(key, policy);
    if (fenced !== null) {
      // Fence: the runtime stops, the group is told, and the terminal-failure breaker counts it
      // (fingerprint_fence).
      this.stop(key);
      this.note(
        member.group_id,
        `${name} stopped after ${fenced} repeated runtime errors with the same fingerprint (${policy.fingerprint}). Last error: ${error || "(none given)"} Restart after the runtime/tooling issue is fixed: @mention ${name} to restart it, or its next message starts it again.`,
        "seat.turn_failed",
        member.bot_id,
      );
      if (noteTerminalFailure(this.breaker(key), { kind: "fingerprint_fence", fingerprint: policy.fingerprint }, now)) this.notePaused(member.group_id, member.bot_id, name);
      return;
    }
    if (policy.sticky) {
      // The runtime stops, and the next wake starts it again unless a breaker refuses. A sign-in
      // or plan problem isn't the terminal-failure breaker's evidence, but a runtime that ends this
      // way within a minute of its start exited early (the crash-loop breaker); the rest is.
      this.stop(key);
    } else if (policy.backoff) this.noteBackoff(member.group_id, member.bot_id, policy.backoff);
    // A bot that keeps failing the same way (rate limited, say) is noted once, not every turn.
    const last = this.failures.get(key);
    if (!last || last.error !== error || now - last.at >= FAILURE_NOTE_MS) {
      this.failures.set(key, { error, at: now });
      this.note(member.group_id, `${name}'s turn failed${error ? `: ${error}` : "."}`, "seat.turn_failed", member.bot_id);
    }
    if (!policy.sticky) return;
    if (policy.actionRequired) {
      const loop = this.crashLoop(key);
      // Text for the crash-loop block, and how to start it by hand here.
      if (noteExit(loop, now)) this.note(member.group_id, `${name}: Automatic wake paused after ${loop.earlyExits} early exits. @mention ${name} to start it again.`, "seat.turn_failed", member.bot_id);
    } else if (noteTerminalFailure(this.breaker(key), { kind: "sticky_runtime_error", fingerprint: policy.fingerprint }, now)) {
      this.notePaused(member.group_id, member.bot_id, name);
    }
  }

  /**
   * A seat's context was compacted: a new model context, so what it saw before no longer counts
   * as seen. A thread it was brought into isn't introduced again: where it was shown up to stays.
   * (Every message names its sender in full, so nothing else needs showing again.)
   */
  onCompaction(chatId: string): void {
    const member = this.store.memberBySeat(chatId);
    if (member) this.store.newSeenContext(member.group_id, member.bot_id);
  }

  /**
   * A seat's runtime session was opened. A resume keeps its model context; a new session starts
   * one, and so does every session of a runtime that never reports its compactions (an unchanged
   * context id would prove nothing for those).
   */
  onSessionOpened(event: { chatId: string; resumed: boolean; reportsCompaction: boolean }): void {
    if (event.resumed && event.reportsCompaction) return;
    const member = this.store.memberBySeat(event.chatId);
    if (member) this.store.newSeenContext(member.group_id, member.bot_id);
  }

  /**
   * A seat's runtime didn't start (ChatService's start.failed: its session didn't open, didn't
   * take the first input, or showed nothing within the start timeout). It goes the way of a
   * spawn failure (startFailed), and what it was told and never took in is told again when it's
   * tried again. A new seat that couldn't be created is handled where it was started (pump).
   */
  onStartFailed(event: { chatId: string; error: string }): void {
    const member = this.store.memberBySeat(event.chatId);
    if (!member) return;
    const told = this.store.retellUntaken(member.group_id, member.bot_id);
    // The backoff is in place before anything else looks at the seat; the note follows.
    const noted = this.startFailed(member.group_id, member.bot_id, event.error, told);
    void this.host.bot(member.bot_id).then((bot) => this.noteStartFailure(member.group_id, member.bot_id, bot?.name ?? "A bot", event.error, noted, false));
    this.changed(member.group_id);
  }

  /** A seat's runtime started (its first runtime event): the spawn-fail backoff is over, and so is a run of spawn errors. */
  onStartReady(event: { chatId: string }): void {
    const member = this.store.memberBySeat(event.chatId);
    if (!member) return;
    const key = this.key(member.group_id, member.bot_id);
    const spawn = this.spawnBackoffs.get(key);
    if (spawn?.timer) clearTimeout(spawn.timer);
    this.spawnBackoffs.delete(key);
    const breaker = this.breakers.get(key);
    if (breaker) noteSpawned(breaker);
  }

  /** A seat's stored session wasn't resumed (its compaction kept failing) and a new one started: the group hears why. */
  onSessionReset(event: { chatId: string; failures: number }): void {
    const member = this.store.memberBySeat(event.chatId);
    if (!member) return;
    void this.host.bot(member.bot_id).then((bot) => {
      const name = bot?.name ?? "A bot";
      this.note(member.group_id, `${name}'s session failed context compaction ${event.failures} times in a row, so it started a new session; it doesn't have the conversation from before.`, "seat.turn_failed", member.bot_id);
    });
  }

  /**
   * A seat's approval. A question for the user (a bot's replies in a group can include questions,
   * and the answer goes back to the bot that asked) is posted as the bot's message,
   * which reaches no inbox (bot.question): the user answers it in place. Other approvals, secret
   * questions and sign-ins stay in the seat, where the group points at them.
   */
  async onPermission(event: { agent: ChatSnapshot; request: ApprovalRequest }): Promise<void> {
    const groupId = event.agent.labels?.[GROUP_LABEL];
    const questions = groupId ? groupQuestion(event.request) : null;
    if (!groupId || !questions) return;
    const member = this.store.memberBySeat(event.agent.id);
    if (!member?.active || member.group_id !== groupId) return;
    const bot = await this.host.bot(member.bot_id);
    if (!bot || !this.store.group(groupId)) return;
    const question: GroupQuestion = { chatId: event.agent.id, requestId: event.request.id, input: event.request.input ?? {}, status: "pending", answers: null, settledAt: null };
    this.store.append(groupId, { kind: "bot", botId: bot.id, name: bot.name }, { text: questionText(questions), subtype: "bot.question", causalActor: bot.id, question });
    this.changed(groupId);
  }

  /** A seat's approval stopped waiting: its question in the group, if it has one, is answered, dismissed or closed. */
  onPermissionResolved(event: { chatId: string; requestId: string; decision: ApprovalDecision; reason: "answered" | "ended" | "closed" }): void {
    const found = this.store.questionFor(event.chatId, event.requestId);
    if (!found || found.question.status !== "pending") return;
    if (this.store.settleQuestion(found.groupId, found.seq, settledQuestion(found.question, event.decision, event.reason))) this.changed(found.groupId);
  }

  /** The user's answer to a bot's question, from the group: it goes to the seat that asked, as the answer to its waiting question. */
  async answer(groupId: string, seq: number, decision: ApprovalDecision): Promise<void> {
    this.require(groupId);
    const message = this.store.messageAt(groupId, seq);
    const question = message?.question;
    if (!message || !question) throw new RequestError(`#${seq} isn't a question.`);
    if (question.status !== "pending") throw new RequestError(question.status === "closed" ? "That question is no longer waiting for an answer." : "That question was already answered.");
    const who = message.from.kind === "bot" ? message.from.name : "The bot";
    if (!(await this.host.chats.respond(question.chatId, question.requestId, decision))) {
      // Its approval ended without the user (its turn ended, say).
      if (this.store.settleQuestion(groupId, seq, { status: "closed", answers: null })) this.changed(groupId);
      throw new RequestError(`${who} isn't waiting for this answer anymore.`);
    }
    if (this.store.settleQuestion(groupId, seq, settledQuestion(question, decision, "answered"))) this.changed(groupId);
  }

  /** Whether the seat's approval for this question is still waiting. */
  private waiting(question: GroupQuestion): boolean {
    return !!this.host.chats.get(question.chatId)?.pendingPermissions.some((request) => request.id === question.requestId);
  }

  onRemoved(chatId: string): void {
    const member = this.store.memberBySeat(chatId);
    if (!member) return;
    this.store.setSeat(member.group_id, member.bot_id, null);
    // Delivery backoff and waiting notices go with the process.
    this.clearBackoff(this.key(member.group_id, member.bot_id));
    this.clearNotice(this.key(member.group_id, member.bot_id));
  }

  // ---------------------------------------------------------------- waits, fences and restarts

  private key(groupId: string, botId: string): string {
    return `${groupId}:${botId}`;
  }

  /**
   * The delivery backoff: the seat isn't told again for 10 s, doubling with each failure in a
   * row up to 5 min, plus up to 10%.
   * What arrives meanwhile waits in its inbox and goes out in one notice when the wait is over.
   */
  private noteBackoff(groupId: string, botId: string, reason: NonNullable<RuntimeErrorPolicy["backoff"]>): void {
    const key = this.key(groupId, botId);
    const attempts = (this.errorBackoffs.get(key)?.attempts ?? 0) + 1;
    const capped = Math.min(RUNTIME_ERROR_BACKOFF_MAX_MS, RUNTIME_ERROR_BACKOFF_BASE_MS * 2 ** (attempts - 1));
    const unit = this.random();
    const jitter = Math.floor(capped * RUNTIME_ERROR_BACKOFF_JITTER * (Number.isFinite(unit) ? Math.max(0, Math.min(1, unit)) : 0));
    this.clearBackoff(key);
    this.errorBackoffs.set(key, { attempts, until: Date.now() + Math.min(RUNTIME_ERROR_BACKOFF_MAX_MS, capped + jitter), reason, timer: null });
    this.armBackoff(this.errorBackoffs, groupId, botId);
  }

  /** When a wait is over, the seat's inbox is looked at again. */
  private armBackoff(backoffs: Map<string, Backoff>, groupId: string, botId: string): void {
    const backoff = backoffs.get(this.key(groupId, botId));
    if (!backoff || backoff.timer || this.closed) return;
    backoff.timer = setTimeout(() => {
      backoff.timer = null;
      void this.serial(groupId, () => this.pump(groupId, botId));
    }, Math.max(1, backoff.until - Date.now()));
    backoff.timer.unref?.();
  }

  private clearBackoff(key: string): void {
    const backoff = this.errorBackoffs.get(key);
    if (backoff?.timer) clearTimeout(backoff.timer);
    this.errorBackoffs.delete(key);
  }

  /**
   * The fingerprint fence: failures in a row with the same fingerprint are
   * counted (one that needs the user, like a sign-in, isn't); the third trips the fence, and so
   * does each one after it (the count outlives the stop). Returns the count when this failure tripped it.
   */
  private noteFence(key: string, policy: RuntimeErrorPolicy): number | null {
    if (policy.sticky) return null;
    let fence = this.fences.get(key);
    if (!fence || fence.fingerprint !== policy.fingerprint) {
      fence = { fingerprint: policy.fingerprint, attempts: 0 };
      this.fences.set(key, fence);
    }
    fence.attempts++;
    return fence.attempts >= FENCE_THRESHOLD ? fence.attempts : null;
  }

  /** A terminal failure ended the seat's runtime: its waits go with it, and only a wake starts it again. */
  private stop(key: string): void {
    this.stopped.add(key);
    this.clearBackoff(key);
    this.clearNotice(key);
  }

  private breaker(key: string): TerminalBreaker {
    let breaker = this.breakers.get(key);
    if (!breaker) this.breakers.set(key, (breaker = freshBreaker()));
    return breaker;
  }

  private crashLoop(key: string): CrashLoop {
    let loop = this.crashLoops.get(key);
    if (!loop) this.crashLoops.set(key, (loop = freshCrashLoop()));
    return loop;
  }

  /**
   * A wake (a message delivered to the bot, or its reminder) of a bot whose runtime was stopped is
   * an automatic start: refused while the crash-loop breaker blocks it, or the terminal-failure
   * breaker is paused or has a probe in flight; passed otherwise (the one probe, when the pause is
   * over). Returns whether the bot may be told now.
   */
  private automaticStart(groupId: string, botId: string): boolean {
    const key = this.key(groupId, botId);
    const spawn = this.spawnBackoffs.get(key);
    if (!this.stopped.has(key) && !spawn?.stopped) return true;
    if (this.crashLoops.get(key)?.blocked) return false;
    const breaker = this.breaker(key);
    if (claimAutomaticStart(breaker, Date.now())) {
      // A lease that lapsed is a new pause, shown once.
      void this.host.bot(botId).then((bot) => this.notePaused(groupId, botId, bot?.name ?? "A bot"));
      return false;
    }
    this.stopped.delete(key);
    this.crashLoop(key).startedAt = Date.now();
    if (spawn?.stopped) spawn.serverStart = true;
    return true;
  }

  /** Why automatic wakes are paused, in the group, once per pause. `lead` opens the note. */
  private notePaused(groupId: string, botId: string, name: string, lead = `${name}:`): void {
    const breaker = this.breakers.get(this.key(groupId, botId));
    const text = breaker ? pausedText(breaker, Date.now()) : null;
    if (!breaker || !text || breaker.shown === `paused:${breaker.blockedUntil}`) return;
    breaker.shown = `paused:${breaker.blockedUntil}`;
    this.note(groupId, `${lead} ${text} @mention ${name} to start it now.`, "seat.turn_failed", botId);
  }

  /** The spawn-error retry sweep: when only spawn errors paused a seat and a wake is owed, it's started again once the pause and the seat's jitter are over. */
  private armSweep(groupId: string, botId: string): void {
    const key = this.key(groupId, botId);
    const breaker = this.breakers.get(key);
    this.clearSweep(key);
    if (!breaker?.blockedUntil || this.closed) return;
    const jitter = spawnErrorRetryJitterMs(key);
    const timer = setTimeout(() => {
      this.sweepTimers.delete(key);
      if (!spawnRetryDue(breaker, Date.now(), jitter) || !this.automaticStart(groupId, botId)) return;
      void this.serial(groupId, () => this.pump(groupId, botId));
    }, Math.max(1, breaker.blockedUntil + jitter - Date.now()));
    timer.unref?.();
    this.sweepTimers.set(key, timer);
  }

  private clearSweep(key: string): void {
    const timer = this.sweepTimers.get(key);
    if (timer) clearTimeout(timer);
    this.sweepTimers.delete(key);
  }

  /**
   * A seat that couldn't start is tried
   * again after 1 s, 2 s, 4 s and so on (up to 30 s); after 5 failures in a row, or at once when
   * the failure needs the user (a sign-in, say), it isn't tried again by itself, and what it was
   * to be told is left to the next wake. One that needs the user is a reason retrying can't fix,
   * which blocks automatic wakes until a manual start.
   */
  private noteSpawnFailure(groupId: string, botId: string, error: string): { attempts: number; stopped: boolean; blocked: boolean } {
    const key = this.key(groupId, botId);
    const previous = this.spawnBackoffs.get(key);
    if (previous?.timer) clearTimeout(previous.timer);
    const attempts = (previous?.attempts ?? 0) + 1;
    const blocked = runtimeErrorPolicy(error, "").sticky;
    const stopped = attempts >= SPAWN_FAIL_MAX_ATTEMPTS || blocked;
    const delay = Math.min(SPAWN_FAIL_BACKOFF_MAX_MS, SPAWN_FAIL_BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 10));
    this.spawnBackoffs.set(key, { attempts, until: stopped ? 0 : Date.now() + delay, reason: "spawn_error", timer: null, stopped });
    if (!stopped) this.armBackoff(this.spawnBackoffs, groupId, botId);
    if (blocked) this.crashLoop(key).blocked = true;
    return { attempts, stopped, blocked };
  }

  /**
   * A seat's runtime didn't start: a new seat that couldn't be created
   * (`joining`), or a seat whose session didn't open, didn't take its first input, or showed no
   * runtime event within the start timeout. What it was to be told is lost (not launched) until
   * it's tried again: after a spawn-fail backoff, or, once the local retries stopped, when a wake
   * allows it, whose failure the spawn-error backoff pauses.
   */
  private startFailed(groupId: string, botId: string, detail: string, told: readonly number[]): { paused: true } | { paused: false; attempts: number; stopped: boolean; blocked: boolean } {
    const key = this.key(groupId, botId);
    this.store.markDeliveryFailed(groupId, botId, "not_launched", told);
    const spawn = this.spawnBackoffs.get(key);
    if (spawn?.stopped) {
      // A start a wake allowed after the local retries stopped that never
      // created a runtime: the spawn-error backoff pauses it, and its sweep tries again.
      spawn.serverStart = false;
      noteSpawnError(this.breaker(key), Date.now());
      this.armSweep(groupId, botId);
      return { paused: true };
    }
    // Tried again after a spawn-fail backoff.
    return { paused: false, ...this.noteSpawnFailure(groupId, botId, detail) };
  }

  /** What startFailed did, in the group: a pause once, a seat's first failure and its last. */
  private noteStartFailure(groupId: string, botId: string, name: string, detail: string, outcome: ReturnType<GroupChats["startFailed"]>, joining: boolean): void {
    const verb = joining ? "couldn't join" : "couldn't start";
    if (outcome.paused) return this.notePaused(groupId, botId, name, `${name} ${verb}: ${detail}`);
    const { attempts, stopped, blocked } = outcome;
    const tries = attempts > 1 ? ` after ${attempts} tries` : "";
    if (blocked) this.note(groupId, `${name} ${verb}${tries}: ${detail} Fix that, then @mention ${name} to try again.`, "seat.turn_failed", botId);
    else if (stopped) this.note(groupId, `${name} ${verb}${tries}: ${detail} Its next message or reminder tries again; @mention ${name} to try now.`, "seat.turn_failed", botId);
    else if (attempts === 1) this.note(groupId, `${name} ${verb}: ${detail}`, "seat.turn_failed", botId);
  }

  /**
   * The user's manual start of a bot (by @mentioning it): a stopped runtime, a fence and a
   * stopped seat start over, so do its delivery backoff (it went with the process the fence
   * stopped) and the crash-loop breaker (a new episode), and the
   * terminal-failure breaker is lifted. A bot that's only waiting out a backoff keeps waiting.
   */
  private restart(groupId: string, botId: string): void {
    const key = this.key(groupId, botId);
    const spawn = this.spawnBackoffs.get(key);
    const breaker = this.breakers.get(key);
    if (!this.stopped.has(key) && !spawn?.stopped && (!breaker || breaker.state === "closed") && !this.crashLoops.get(key)?.blocked) return;
    this.stopped.delete(key);
    this.fences.delete(key);
    this.clearBackoff(key);
    if (spawn?.timer) clearTimeout(spawn.timer);
    this.spawnBackoffs.delete(key);
    this.failures.delete(key);
    if (breaker) liftBreaker(breaker);
    this.clearSweep(key);
    this.crashLoops.set(key, { ...freshCrashLoop(), startedAt: Date.now() });
  }

  /** A member left (or its group was deleted): nothing of its seat's waits stays. */
  private forgetSeat(groupId: string, botId: string): void {
    const key = this.key(groupId, botId);
    this.clearBackoff(key);
    this.clearNotice(key);
    const spawn = this.spawnBackoffs.get(key);
    if (spawn?.timer) clearTimeout(spawn.timer);
    this.spawnBackoffs.delete(key);
    this.fences.delete(key);
    this.stopped.delete(key);
    this.breakers.delete(key);
    this.crashLoops.delete(key);
    this.clearSweep(key);
    this.failures.delete(key);
  }

  /** A busy seat's notice goes out after `delay`, carrying whatever came in by then. */
  private armNotice(groupId: string, botId: string, delay: number): void {
    const key = this.key(groupId, botId);
    if (this.noticeTimers.has(key) || this.closed) return;
    const timer = setTimeout(() => {
      this.noticeTimers.delete(key);
      void this.serial(groupId, () => this.pump(groupId, botId, true));
    }, delay);
    timer.unref?.();
    this.noticeTimers.set(key, timer);
  }

  private clearNotice(key: string): void {
    const timer = this.noticeTimers.get(key);
    if (timer) clearTimeout(timer);
    this.noticeTimers.delete(key);
  }

  // ---------------------------------------------------------------- delivery

  /**
   * Posts, then says which @mentions reached nobody: a bot of the
   * user's outside the group, or a name that's no bot's.
   */
  private async post(bot: Bot, groupId: string, conv: number, text: string, replyTo: number | null, idempotencyKey: string | null, members: readonly Member[], files: readonly string[] = []): Promise<string> {
    const mentions = parseMentions(text, members, await this.outsiders(groupId));
    // The files are kept as they are now, with the group's other attachments.
    const attachments = await this.keepBotFiles(groupId, files);
    const { message, duplicate, woken } = this.store.append(groupId, { kind: "bot", botId: bot.id, name: bot.name }, { text, replyTo, thread: conv || null, idempotencyKey, attachments, ...this.mentionFields(mentions) });
    this.store.dropDraft(groupId, bot.id, conv);
    if (duplicate) {
      await Promise.all(attachments.map((file) => rm(file.path, { force: true })));
      return `Already sent as #${message.seq}.`;
    }
    this.wake(groupId, woken);
    const undelivered = undeliveredMentionsText({ outside: mentions.outside, unknown: mentions.unknown, askBot: bot.contactBots !== "off" && !this.ledBy(groupId, bot.id), ...(await this.ledMentions(bot, groupId, mentions)) });
    const attached = attachments.length ? ` with ${attachments.map((file) => file.name).join(", ")} attached` : "";
    return `Sent as #${message.seq}${conv ? ` in thread #${conv}` : ""}${attached}.${undelivered ? `\n\n${undelivered}` : ""}`;
  }

  /** In a group with a leader, the members another member's @mentions didn't reach: only the leader hands them work. */
  private async ledMentions(bot: Bot, groupId: string, mentions: Mentions): Promise<{ led?: { leader: string; members: { name: string; handle: string }[] } }> {
    const leaderId = this.store.leader(groupId);
    if (!leaderId || leaderId === bot.id) return {};
    const bots = await this.allBots();
    const members = mentions.botIds.filter((id) => id !== leaderId && id !== bot.id).map((id) => ({ name: bots.get(id)?.name ?? id, handle: mentions.handles[id] ?? `@${bots.get(id)?.name ?? id}` }));
    return members.length ? { led: { leader: bots.get(leaderId)?.name ?? "the leader", members } } : {};
  }

  /** What a message's @mentions add to it in the store: the members, @everyone, and each token as written. */
  private mentionFields(mentions: Mentions): Pick<AppendInput, "mentions" | "everyone" | "mentionHandles"> {
    return { mentions: mentions.botIds, everyone: mentions.everyone, mentionHandles: mentions.handles };
  }

  /**
   * Where a message goes: the top level (null) or a thread, by its top message's number. A
   * thread message's number means its thread (threads don't nest), and a reply to a message in a
   * thread goes in that thread.
   */
  private venue(groupId: string, thread: number | null, replyTo: number | null): number | null {
    if (thread) {
      const top = this.store.messageAt(groupId, thread);
      if (!top) throw new RequestError(`There's no message #${thread} to start a thread on.`);
      if (top.from.kind === "system") throw new RequestError(`#${thread} is a note from pocket-bots; start the thread on a message.`);
      return top.thread ?? top.seq;
    }
    if (replyTo) {
      const replied = this.store.messageAt(groupId, replyTo);
      if (!replied) throw new RequestError(`There's no message #${replyTo}.`);
      return replied.thread;
    }
    return null;
  }

  /** The thread a number names: its top message's, or the thread a reply is in. */
  private threadOf(groupId: string, seq: number): number {
    const message = this.store.messageAt(groupId, seq);
    if (!message) throw new RequestError(`There's no message #${seq}.`);
    return message.thread ?? message.seq;
  }

  /** The top messages of the threads these messages are in, for labelling them. */
  private parents(groupId: string, messages: readonly GroupMessage[]): Map<number, GroupMessage> {
    const threads = [...new Set(messages.flatMap((message) => (message.thread ? [message.thread] : [])))];
    return new Map(this.store.messagesAt(groupId, threads).map((message) => [message.seq, message]));
  }

  /**
   * The bots a new message went to hear about it. Any message is a wake, whoever sent it (a task
   * note included): a stopped bot is started again unless a breaker refuses (automaticStart).
   */
  private wake(groupId: string, botIds: readonly string[]): void {
    this.changed(groupId);
    for (const botId of botIds) {
      this.automaticStart(groupId, botId);
      void this.serial(groupId, () => this.pump(groupId, botId));
    }
  }

  /**
   * Brings one member up to date: a content-free notice of what's in its inbox and
   * where (it starts a turn when the seat is idle, and joins the running one when it's busy), and
   * the bot reads the messages itself. Only a thread it was just pulled into comes with its text,
   * and a renewed seat with a briefing. A notice goes out only when something in the inbox hasn't
   * been in one yet (each message contributes to one notice).
   *
   * It waits instead while its runtime is stopped or its seat stopped starting (until a wake starts
   * it again), during a delivery or spawn-fail backoff (the wait's end looks again), and for a busy
   * seat until BUSY_NOTICE_DELAY_MS has passed (`flush`: that wait is over), so a burst is one
   * notice.
   */
  private async pump(groupId: string, botId: string, flush = false): Promise<void> {
    const group = this.store.group(groupId);
    const member = this.store.member(groupId, botId);
    if (!group || !member?.active) return;
    const bot = await this.host.bot(botId);
    if (!bot || bot.archived) return;
    const all = this.store.pending(groupId, botId);
    // Its fired reminders whose wake hasn't reached it: they go in the same notice.
    const reminders = this.store.pendingReminderWakes(groupId, botId);
    if (all.length === 0 && reminders.length === 0) return;
    let seat = member.seat_chat_id ? this.host.chats.get(member.seat_chat_id) : null;
    if (seat?.archivedAt) seat = null;
    const busy = !!seat && isBusy(seat.status);
    // A member the leader leads is told about one piece of work at a time (pieceFor).
    const leaderId = this.store.leader(groupId);
    const piece = leaderId && leaderId !== botId ? pieceFor(leaderId, botId, all, seat ? member.seat_task : null) : null;
    const pending = piece ? piece.now : all;
    // Its session is for another piece: the new one waits for the turn to end, then starts a session of its own.
    if (busy && piece?.switching) return;
    const fresh = pending.some((entry) => !entry.noticed);
    if (seat && !fresh && reminders.length === 0) return;
    const key = this.key(groupId, botId);
    const untold = pending.filter((entry) => !entry.noticed).map((entry) => entry.message.seq);
    // Its runtime stopped, or its seat stopped starting: its inbox waits for a wake that starts it.
    const spawn = this.spawnBackoffs.get(key);
    if (this.stopped.has(key) || (spawn?.stopped && !spawn.serverStart)) {
      this.store.markDeliveryFailed(groupId, botId, spawn?.stopped ? "not_launched" : "runtime_error", untold);
      return;
    }
    // In a backoff: what came in waits for its end, and a mention arriving now counts as lost
    // (rate limited, or rejected by the runtime) until then.
    const backoff = this.errorBackoffs.get(key);
    if (backoff && backoff.until > Date.now()) {
      this.store.markDeliveryFailed(groupId, botId, backoff.reason === "rate_limited" ? "quota" : "runtime_error", untold);
      this.armBackoff(this.errorBackoffs, groupId, botId);
      return;
    }
    if (spawn && spawn.until > Date.now()) {
      this.armBackoff(this.spawnBackoffs, groupId, botId);
      return;
    }
    // A busy seat's notice waits a moment, so what comes in meanwhile joins it; an idle seat starts at once.
    if (busy && !flush) {
      this.armNotice(groupId, botId, BUSY_NOTICE_DELAY_MS);
      return;
    }
    this.clearNotice(key);
    if (seat && piece?.switching) {
      // Another piece of work: a fresh session, without a briefing. A piece it comes back to brings
      // its thread along (threadJoins), since a new seat has been shown nothing.
      await this.host.chats.archive(seat.id).catch(() => undefined);
      this.store.setSeat(groupId, botId, null);
      this.clearBackoff(key);
      seat = null;
    }
    let briefing = "";
    // A session whose compaction failed SESSION_NEEDS_RESET_THRESHOLD times in a row can't be
    // resumed: the seat starts over now, with a briefing, as a stale one does.
    const reset = !!seat && !busy && !!this.host.chats.sessionNeedsReset?.(seat.id);
    if (reset) this.note(groupId, `${bot.name}'s session failed context compaction too many times in a row to be resumed, so ${bot.name} starts over in a new session with a briefing of the group.`, "seat.turn_failed", botId);
    // The group's folder (or the bot's own) changed since the seat started: it starts over there, with a briefing.
    const folder = this.seatFolder(group, bot);
    const moved = !!seat && !busy && !reset && seat.cwd !== folder;
    if (seat && !busy && (reset || moved || this.stale(seat))) {
      // Cheaper to start over than to resume a big context whose cache has gone cold; the new
      // seat starts with a briefing built from the old one.
      const entries = this.host.chats.timeline(seat.id, { direction: "tail", limit: 500 }).entries;
      const inbox = new Set(pending.map((entry) => entry.message.seq));
      const seen = this.store.history(groupId, botId, BRIEFING_MESSAGES).filter((message) => !inbox.has(message.seq));
      briefing = await briefingPanel({ messages: seen, entries, cwd: seat.cwd, meId: bot.id, parents: this.parents(groupId, seen), ...(reset ? { reason: "reset" as const } : moved ? { reason: "moved" as const, folder } : {}) });
      await this.host.chats.archive(seat.id).catch(() => undefined);
      this.store.setSeat(groupId, botId, null);
      this.clearBackoff(key);
      seat = null;
      // A fresh spawn of the same seat: a new model context, but threads it was shown stay shown.
      this.store.newSeenContext(groupId, botId);
    } else if (!seat) {
      // A new seat is a new model context: it has seen nothing yet, the briefing included.
      this.store.resetSeen(groupId, botId);
    }
    const joins = this.threadJoins(groupId, botId, pending, !!piece);
    const shown = new Set(joins.flatMap((join) => [...join.recent.map((message) => message.seq), join.trigger.seq]));
    // A led member gets its piece's messages in full, so it needn't read its inbox for them.
    const handed = piece ? pending.filter((entry) => !shown.has(entry.message.seq)).slice(-HANDED_MAX).map((entry) => entry.message) : [];
    for (const message of handed) shown.add(message.seq);

    const text = wakeText({
      groupName: group.name,
      me: { id: bot.id, name: bot.name },
      roster: await this.roster(groupId),
      // A notice for a reminder alone doesn't tell the inbox again (each message is in one notice).
      pending: seat && !fresh ? [] : pending.filter((entry) => !shown.has(entry.message.seq)),
      joins,
      briefing,
      reminders: reminders.map((reminder) => reminderFiredText(reminder, reminder.catchup)),
      ...(handed.length ? { handed: { messages: handed, parents: this.parents(groupId, handed) } } : {}),
      // A led member's session is for one piece: its other tasks come back with their threads.
      owed: seat || piece ? [] : this.store.tasks(groupId, { statuses: OPEN_TASKS, assigneeId: botId }),
    });
    const files = await this.deliveryFiles([...joins.flatMap((join) => [join.parent, ...join.recent, join.trigger]), ...handed], botId);
    const clientMessageId = randomUUID();
    const told = pending.map((entry) => entry.message.seq);
    this.store.tieToNotice(groupId, botId, told, clientMessageId);
    if (joins.length || handed.length) {
      this.deliveries.set(clientMessageId, {
        groupId,
        botId,
        joins: joins.map((join) => ({ thread: join.thread, parent: join.parent.seq, upTo: Math.max(join.trigger.seq, ...join.recent.map((message) => message.seq)) })),
        seen: handed.map((message) => ({ seq: message.seq, thread: message.thread })),
        ...(piece?.work !== null && piece?.work !== undefined ? { piece: piece.work } : {}),
      });
    }
    try {
      if (!seat) {
        const chatId = await this.startSeat(bot, {
          prompt: text,
          title: `Group · ${group.name}`,
          cwd: folder,
          labels: { [GROUP_LABEL]: groupId },
          group: { id: groupId, name: group.name },
          clientMessageId,
          ...(files.images.length ? { images: files.images } : {}),
          ...(files.attachments.length ? { attachments: files.attachments } : {}),
        });
        this.store.setSeat(groupId, botId, chatId);
        // It started: the spawn-fail backoff is over, and so is a run of spawn errors; a
        // crash-loop window opens.
        const started = this.spawnBackoffs.get(key);
        if (started?.timer) clearTimeout(started.timer);
        this.spawnBackoffs.delete(key);
        const breaker = this.breakers.get(key);
        if (breaker) noteSpawned(breaker);
        this.crashLoop(key).startedAt = Date.now();
      } else {
        await sendToChat(this.host, seat.id, {
          text,
          activeTurnBehavior: "steer",
          messageId: clientMessageId,
          ...(files.images.length ? { images: files.images } : {}),
          ...(files.attachments.length ? { attachments: files.attachments } : {}),
        });
      }
      this.store.markNoticed(groupId, botId, told);
      this.store.markRemindersWoken(reminders.map((reminder) => reminder.id));
      if (piece && piece.work !== null) this.store.setSeatTask(groupId, botId, piece.work);
    } catch (error) {
      this.deliveries.delete(clientMessageId);
      const detail = error instanceof Error ? error.message : String(error);
      if (!seat) {
        // A new seat that couldn't start. (A seat that exists and couldn't start is told by
        // ChatService's start.failed: onStartFailed.)
        this.noteStartFailure(groupId, botId, bot.name, detail, this.startFailed(groupId, botId, detail, told), true);
      } else if (busy) {
        // A busy seat that didn't take its notice is tried again;
        // an idle one that couldn't take it now (compacting, say) gets it when its turn ends.
        this.armNotice(groupId, botId, BUSY_NOTICE_RETRY_MS);
      }
    }
    this.changed(groupId);
  }

  /**
   * Resume catch-up after pocket-bots restarts: the seat (resuming its own session) gets
   * the unread messages themselves in a bounded batch, those that @mention it first, with the
   * places the batch didn't cover in full; with no batch, the unread places and a
   * constrained instruction (read each once, then stop unless something there is for it). Unlike
   * an ordinary notice, it isn't skipped for messages a notice already told: that notice may
   * have been lost with the old process.
   */
  private async catchUp(groupId: string, botId: string): Promise<void> {
    const group = this.store.group(groupId);
    const member = this.store.member(groupId, botId);
    if (!group || !member?.active || !member.seat_chat_id) return;
    const bot = await this.host.bot(botId);
    const seat = this.host.chats.get(member.seat_chat_id);
    if (!bot || bot.archived || !seat || seat.archivedAt) return;
    const batch = this.store.catchUpBatch(groupId, botId);
    if (batch.places.length === 0) return;
    const covered = new Set(batch.messages.map((message) => message.thread ?? 0));
    const uncovered = batch.places.filter((place) => batch.truncated.has(place.conv) || !covered.has(place.conv));
    const text = wakeText({
      groupName: group.name,
      me: { id: bot.id, name: bot.name },
      roster: await this.roster(groupId),
      pending: [],
      catchUp: { messages: batch.messages, places: batch.places, uncovered, parents: this.parents(groupId, batch.messages) },
      owed: this.store.tasks(groupId, { statuses: OPEN_TASKS, assigneeId: botId }),
    });
    const files = await this.deliveryFiles(batch.messages, botId);
    const clientMessageId = randomUUID();
    const told = this.store.pending(groupId, botId).map((entry) => entry.message.seq);
    this.store.tieToNotice(groupId, botId, told, clientMessageId);
    if (batch.messages.length) this.deliveries.set(clientMessageId, { groupId, botId, joins: [], seen: batch.messages.map((message) => ({ seq: message.seq, thread: message.thread })) });
    try {
      await sendToChat(this.host, seat.id, {
        text,
        activeTurnBehavior: "steer",
        messageId: clientMessageId,
        ...(files.images.length ? { images: files.images } : {}),
        ...(files.attachments.length ? { attachments: files.attachments } : {}),
      });
      this.store.markNoticed(groupId, botId, told);
    } catch {
      this.deliveries.delete(clientMessageId);
    }
    this.changed(groupId);
  }

  /**
   * Threads the bot was just pulled into with an @mention while it was never shown up to a point
   * there since its seat started: their top message, the six replies
   * before and the mention.
   */
  private threadJoins(groupId: string, botId: string, pending: readonly PendingMessage[], replies = false): ThreadJoin[] {
    const triggers = new Map<number, GroupMessage>();
    for (const entry of pending) {
      const thread = entry.message.thread;
      // Decided by where it was shown up to, which a compaction keeps. `replies`: a reply to it brings the thread too (a led member's follow-up).
      const pulled = entry.reason === "mention" || entry.reason === "handoff" || (replies && entry.reason === "reply");
      if (thread && pulled && this.store.visibleBoundary(groupId, botId, thread) === null) triggers.set(thread, entry.message);
    }
    return [...triggers].flatMap(([thread, trigger]) => {
      const parent = this.store.messageAt(groupId, thread);
      if (!parent) return [];
      const { messages, earlier } = this.store.threadBefore(groupId, thread, trigger.seq, THREAD_JOIN_RECENT);
      return [{ thread, parent, recent: messages, earlier, trigger }];
    });
  }

  /** A seat to start over: idle long enough that its prompt cache is gone, with a large context. */
  private stale(seat: ChatSnapshot): boolean {
    const used = seat.lastUsage?.contextWindowUsedTokens ?? 0;
    return used >= this.recycleTokens && Date.now() - Date.parse(seat.updatedAt) >= this.recycleAfterMs;
  }

  /** A note from pocket-bots, at the top level or in a thread; `mentions` are whom it's for personally. */
  private note(groupId: string, text: string, subtype: SystemSubtype, causalActor: string, thread: number | null = null, mentions: string[] = []): void {
    const { woken } = this.store.append(groupId, { kind: "system" } as GroupSender, { text, thread, mentions, subtype, causalActor });
    this.wake(groupId, woken);
  }

  /** A task's claim, release, assignment or status, noted in its own thread. */
  private lifecycleNote(groupId: string, task: GroupTask, text: string, causalActor: string): void {
    this.note(groupId, text, "task.lifecycle_thread", causalActor, task.seq);
  }

  private convertedNote(groupId: string, task: GroupTask, by: string, causalActor: string): void {
    this.note(groupId, `📋 ${by} converted a message to task #${task.number} "${this.titleOf(groupId, task)}"`, "task.converted_summary", causalActor);
  }

  private statusNote(by: string, groupId: string, task: GroupTask): string {
    return `${STATUS_EMOJI[task.status]} ${by} moved ${this.taskRef(groupId, task)} to ${STATUS_LABEL[task.status]}`;
  }

  /** A task's current title in a line, or what its message attached. */
  private titleOf(groupId: string, task: GroupTask, max = 60): string {
    return messagePreview({ text: task.title, attachments: this.store.messageAt(groupId, task.seq)?.attachments ?? [] }, max);
  }

  private taskRef(groupId: string, task: GroupTask): string {
    return `#${task.number} "${this.titleOf(groupId, task)}"`;
  }

  /** The files in the messages a delivery shows (the user's and other bots'), newest kept and limited. */
  private async deliveryFiles(messages: readonly GroupMessage[], receiverId: string): Promise<{ images: { data: string; mimeType: string }[]; attachments: WireAttachment[] }> {
    const images: { data: string; mimeType: string }[] = [];
    const attachments: WireAttachment[] = [];
    // A bot's own files are on its computer already.
    const files = messages.filter((message) => message.from.kind === "user" || (message.from.kind === "bot" && message.from.botId !== receiverId)).flatMap((message) => message.attachments);
    for (const file of files.slice(-DELIVERY_FILES)) {
      try {
        if (file.kind === "image") images.push({ data: (await readFile(file.path)).toString("base64"), mimeType: file.mimeType });
        else if (file.kind === "text") attachments.push({ type: "text", mimeType: "text/plain", title: file.name, text: await readFile(file.path, "utf8") });
        else attachments.push({ type: "uploaded_file", id: newAttachmentId(), fileName: file.name, mimeType: file.mimeType, size: file.size, path: file.path });
      } catch {
        // A file that's gone stays named in the message text.
      }
    }
    return { images, attachments };
  }

  private async keepAttachments(groupId: string, attachments: readonly ComposerAttachment[]): Promise<GroupAttachment[]> {
    if (attachments.length === 0) return [];
    const dir = groupFilesPath(groupId);
    await mkdir(dir, { recursive: true });
    const kept: GroupAttachment[] = [];
    for (const attachment of attachments) {
      if (attachment.kind === "file") {
        kept.push({ kind: "file", name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, path: attachment.path });
        continue;
      }
      const path = join(dir, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}-${safeName(attachment.name)}`);
      if (attachment.kind === "image") {
        await writeFile(path, Buffer.from(attachment.data, "base64"));
        kept.push({ kind: "image", name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, path });
      } else {
        await writeFile(path, attachment.text, "utf8");
        kept.push({ kind: "text", name: attachment.name, mimeType: "text/plain", size: attachment.size, path });
      }
    }
    return kept;
  }

  /**
   * The files a bot attaches to a post, checked before it's held or sent: paths on this computer
   * (a relative one is in its seat's folder), each a file within the composer's limits.
   */
  private async botFiles(groupId: string, botId: string, paths: readonly string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    if (paths.length > BOT_FILES_MAX) throw new RequestError(`Attach at most ${BOT_FILES_MAX} files to one message.`);
    const seat = this.store.member(groupId, botId)?.seat_chat_id;
    const cwd = (seat ? this.host.chats.get(seat)?.cwd : null) ?? homedir();
    const checked: string[] = [];
    for (const given of paths) {
      const path = given.startsWith("~/") ? join(homedir(), given.slice(2)) : isAbsolute(given) ? given : resolve(cwd, given);
      const info = await stat(path).catch(() => null);
      if (!info) throw new RequestError(`There's no file at ${given}.`);
      if (!info.isFile()) throw new RequestError(`${given} isn't a file.`);
      const name = basename(path);
      const { reason } = preflightFile(name, mimeTypeFor(name), info.size, true);
      if (reason) throw new RequestError(`${name}: ${reason}`);
      if (!checked.includes(path)) checked.push(path);
    }
    return checked;
  }

  /** A bot's files copied into the group's files folder, as the user's attachments are kept. */
  private async keepBotFiles(groupId: string, paths: readonly string[]): Promise<GroupAttachment[]> {
    if (paths.length === 0) return [];
    const dir = groupFilesPath(groupId);
    await mkdir(dir, { recursive: true });
    const kept: GroupAttachment[] = [];
    for (const source of paths) {
      const name = basename(source);
      const info = await stat(source).catch(() => null);
      if (!info?.isFile()) throw new RequestError(`${source} is gone. Send it again with the file's current path, or without it.`);
      const mimeType = mimeTypeFor(name);
      const { kind, reason } = preflightFile(name, mimeType, info.size, true);
      if (reason) throw new RequestError(`${name}: ${reason}`);
      const path = join(dir, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}-${safeName(name)}`);
      await copyFile(source, path);
      kept.push({ kind, name, mimeType, size: info.size, path });
    }
    return kept;
  }

  // ---------------------------------------------------------------- helpers

  private require(groupId: string): GroupRow {
    const group = this.store.group(groupId);
    if (!group) throw new RequestError("That group chat no longer exists.");
    return group;
  }

  private requireMember(groupId: string, botId: string): void {
    this.require(groupId);
    if (!this.store.member(groupId, botId)?.active) throw new RequestError("You're not a member of this group chat.");
  }

  private async allBots(): Promise<Map<string, Bot>> {
    return new Map((await this.host.bots()).map((bot) => [bot.id, bot]));
  }

  private async liveBots(): Promise<Map<string, Bot>> {
    return new Map((await this.host.bots()).filter((bot) => !bot.archived).map((bot) => [bot.id, bot]));
  }

  private async liveMembers(groupId: string): Promise<Member[]> {
    const bots = await this.liveBots();
    return this.store.members(groupId).flatMap((member) => {
      const bot = bots.get(member.bot_id);
      return bot ? [{ id: bot.id, name: bot.name }] : [];
    });
  }

  /** The user's live bots that aren't in the group: an @mention of one reaches nobody. */
  private async outsiders(groupId: string): Promise<Member[]> {
    const members = new Set(this.store.members(groupId).map((member) => member.bot_id));
    return [...(await this.liveBots()).values()].filter((bot) => !members.has(bot.id)).map((bot) => ({ id: bot.id, name: bot.name }));
  }

  private async roster(groupId: string): Promise<RosterEntry[]> {
    const bots = await this.liveBots();
    const leaderId = this.store.leader(groupId);
    return this.store.members(groupId).flatMap((member) => {
      const bot = bots.get(member.bot_id);
      return bot ? [{ id: bot.id, name: bot.name, title: bot.title, ...(bot.id === leaderId ? { leader: true } : {}) }] : [];
    });
  }

  /** One group's deliveries go out one at a time, in order. */
  private serial(groupId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(groupId) ?? Promise.resolve();
    const next = previous.then(work).catch((error: unknown) => console.error("pocket-bots: a group delivery failed", error));
    this.chains.set(groupId, next);
    return next;
  }
}
