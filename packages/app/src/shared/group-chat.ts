import type { ApprovalRequest } from "@pocket-bots/runtime/types";
import { questionsOf, type QuestionSpec } from "@pocket-bots/runtime/questions";
import { z } from "zod";
import { foldText } from "./activity";

// Group chats: two to six bots and the user in one long-lived conversation. Each bot takes part
// through a seat: a chat of its own, with its own model, approvals and tools, that speaks in the
// group only through group tools. docs/group-chats.md walks through it with an example.
// - Every message gets a delivery record for each receiver it reaches (group-store.ts): unread or not
//   by one rule (unreadEligible), and in the bot's inbox when it should hear about it
//   (deliveryReason). A muted bot has no record for ordinary top-level messages, and in a group
//   with a leader the other bots get only what the leader or the user aims at them (fromLead).
// - A bot is woken with a content-free notice and reads the messages itself; reading moves its
//   read position and records what its model has seen.
// - Before a bot posts or claims, what its model has seen is checked against what came in. If
//   it missed something, the post is held as a draft and the bot is shown the newest of it.
// - Work is tracked as tasks: a top-level message promoted to a numbered task with a
//   status and at most one assignee. The first claim wins, so one bot owns each piece.

/** Label on a seat's chat, carrying its group's id. */
export const GROUP_LABEL = "pocket-bots.group";
export const GROUP_MIN_BOTS = 2;
export const GROUP_MAX_BOTS = 6;
/** The user's id in tasks and reactions. */
export const GROUP_USER_ID = "user";

/** How long a held draft is kept (10 minutes). */
export const DRAFT_TTL_MS = 10 * 60_000;
/** Held drafts after which sending anyway is suggested (3). */
export const ANYWAY_AFTER_HOLDS = 3;
/** New messages a held post shows (3). */
export const HELD_SHOWN = 3;
/** Messages a delivery or a read shows at most; earlier ones are counted, and the bot can read them. */
export const DELIVERY_MAX = 40;
export const GROUP_NAME_MAX = 80;
export const USER_TEXT_MAX = 200_000;
export const BOT_TEXT_MAX = 20_000;
/** A group_read page: one rendered message, and the whole page, stay under these. */
export const GROUP_READ_MESSAGE_MAX = 4_000;
export const GROUP_READ_TOTAL_MAX = 32_000;
/** group_read full: one message, rendered. */
export const GROUP_READ_FULL_MAX = 20_000;
/** Task cards: the title and details a bot sees in a list, and how many a list returns. */
export const GROUP_TASK_TITLE_MAX = 200;
export const GROUP_TASK_DESCRIPTION_MAX = 8_000;
export const GROUP_TASK_LIST_MAX = 20;
/** The quiet board: notes are small, bounded, and never wake anyone by themselves. */
export const NOTE_KINDS = ["finding", "decision", "dead_end", "answer", "plan", "review"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_TITLE_MAX = 120;
export const NOTE_BODY_MAX = 4_000;
export const NOTE_REFS_MAX = 16;
export const NOTE_SEARCH_K = 8;
export const NOTE_VISIT_MAX = 8;
export const NOTE_CAPACITY = 2_000;
export const NOTE_DIGEST_MAX = 5;
export const NOTE_CITED_BY_MAX = 8;
/** Full mode: a reply chain this deep stops waking the bot it answers (a handoff still does). */
export const WAKE_HOPS_MAX = 3;
/** A bot's task lease: no task change for this long, plus a grace period, makes it stale. */
export const TASK_LEASE_MS = 20 * 60_000;
export const TASK_LEASE_GRACE_MS = 5 * 60_000;

export const GroupAttachmentSchema = z.object({
  kind: z.enum(["image", "text", "file"]),
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  /** Where the file is kept on this host. */
  path: z.string(),
});
export type GroupAttachment = z.infer<typeof GroupAttachmentSchema>;

/** Files a bot attaches to one group message at most (as many as the user's composer takes). */
export const BOT_FILES_MAX = 6;

/**
 * A bot's question to the user in the group (a bot's replies there can include questions, and
 * the answer goes back to the bot that asked). It's the seat's own question
 * approval, shown as the bot's message; answering it answers that approval.
 */
export const GroupQuestionSchema = z.object({
  /** The seat chat that asked, and its approval waiting for the answer. */
  chatId: z.string(),
  requestId: z.string(),
  /** The approval's input as asked: its questions, for the answer form. */
  input: z.record(z.string(), z.unknown()),
  /**
   * pending: waiting for the user; answered or dismissed by the user (in the group or in the
   * seat); closed: it stopped waiting without them (the bot's turn ended, pocket-bots restarted).
   */
  status: z.enum(["pending", "answered", "dismissed", "closed"]),
  /** Each question's answer in order, once answered (null: left unanswered). */
  answers: z.array(z.string().nullable()).nullable().default(null),
  settledAt: z.string().nullable().default(null),
});
export type GroupQuestion = z.infer<typeof GroupQuestionSchema>;

/**
 * The questions of a seat's approval that the group shows as the bot's question, or null: only a
 * question, and not a secret one. Other approvals, secrets and sign-ins stay in the seat.
 */
export function groupQuestion(request: Pick<ApprovalRequest, "kind" | "input" | "metadata">): QuestionSpec[] | null {
  if (request.kind !== "question" || request.metadata?.secret === true) return null;
  const questions = questionsOf(request.input);
  return questions && !questions.some((question) => question.isSecret) ? questions : null;
}

/** A question's text as its group message keeps it (previews, search, bots reading the group). */
export function questionText(questions: readonly QuestionSpec[]): string {
  const line = (question: QuestionSpec) => {
    const options = question.options.map((option) => option.label);
    const choose = options.length ? ` (${question.multiSelect ? "any of" : "one of"}: ${options.join(" / ")})` : "";
    return `${question.question}${choose}`;
  };
  return questions.length === 1 ? line(questions[0]!) : questions.map((question, index) => `${index + 1}. ${line(question)}`).join("\n");
}

export const GroupSenderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  /** `name` is the bot's name when it posted, for bots deleted since. */
  z.object({ kind: z.literal("bot"), botId: z.string(), name: z.string() }),
  /** pocket-bots's own notes: members joining or leaving, a bot failing. */
  z.object({ kind: z.literal("system") }),
]);
export type GroupSender = z.infer<typeof GroupSenderSchema>;

/** Task statuses: the ordinary path is todo → in_progress → done; closed is "won't do". */
export const TaskStatusSchema = z.enum(["todo", "in_progress", "done", "closed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Allowed moves between statuses (the user, who owns the group, may set any). */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ["in_progress", "closed"],
  in_progress: ["done", "closed"],
  done: ["todo", "in_progress", "closed"],
  closed: ["todo", "in_progress"],
};

export const TaskAssigneeSchema = z.object({ kind: z.enum(["bot", "user"]), id: z.string(), name: z.string() });
export type TaskAssignee = z.infer<typeof TaskAssigneeSchema>;
/** The user, as a task's assignee or as the one who changed it. */
export const GROUP_USER: TaskAssignee = { kind: "user", id: GROUP_USER_ID, name: "the user" };

export const GroupTaskSchema = z.object({
  /** The task's number: its message's (task #12 is message #12). */
  number: z.number().int().positive(),
  /** The message that is the task (the same number). */
  seq: z.number().int().positive(),
  status: TaskStatusSchema,
  assignee: TaskAssigneeSchema.nullable(),
  /** Bumped by every change, for assigning without overwriting a newer change. */
  revision: z.number().int().nonnegative().default(0),
  /** The card's current title: its message's text when it became a task, until amended. */
  title: z.string().default(""),
  /** The card's details or acceptance criteria; null when none are set. */
  description: z.string().nullable().default(null),
  /** Who made it a task: "user" or a bot's id. Only they or the user may delete it. */
  createdBy: z.string().default(""),
  /** The last change; a task with a bot assignee and no change for the lease is stale. */
  updatedAt: z.string().default(""),
  stale: z.boolean().default(false),
  /** The card's latest amendment: its title and description now supersede the message's text, which never changes. */
  amended: z.object({ at: z.string(), by: z.string(), byId: z.string().nullable() }).nullable().default(null),
});
export type GroupTask = z.infer<typeof GroupTaskSchema>;

/** How a task reads in text: "task #3 · in_progress · Ada". */
export function taskLabel(task: Pick<GroupTask, "number" | "status" | "assignee"> & { stale?: boolean }, meId?: string): string {
  const who = task.assignee ? (task.assignee.id === meId ? "you" : task.assignee.name) : "unassigned";
  return `task #${task.number} · ${task.status} · ${who}${task.stale ? " · stale" : ""}`;
}

export const GroupMessageSchema = z.object({
  /** The message's number in its group, from 1. */
  seq: z.number().int().positive(),
  at: z.string(),
  from: GroupSenderSchema,
  text: z.string(),
  replyTo: z.number().int().positive().nullable().default(null),
  /** The top-level message whose thread this one is in; null for a top-level message. Threads don't nest. */
  thread: z.number().int().positive().nullable().default(null),
  /** A top-level message's thread: how many replies, and when the latest came. */
  replies: z.number().int().nonnegative().default(0),
  lastReplyAt: z.string().nullable().default(null),
  /** Bots the text @mentions. */
  mentions: z.array(z.string()).default([]),
  everyone: z.boolean().default(false),
  attachments: z.array(GroupAttachmentSchema).default([]),
  /** A bot's question to the user, with its answer once there is one. */
  question: GroupQuestionSchema.nullable().default(null),
  /** Who has taken on the work this message asks for. */
  /** The task this message is, if it was made one. */
  task: GroupTaskSchema.omit({ seq: true }).nullable().default(null),
  reactions: z.array(z.object({ emoji: z.string(), names: z.array(z.string()), ids: z.array(z.string()).default([]) })).default([]),
});
export type GroupMessage = z.infer<typeof GroupMessageSchema>;

/** One thing a note builds on: another note, or a group message. */
export const GroupNoteRefSchema = z.object({
  note: z.number().int().positive().optional(),
  message: z.number().int().positive().optional(),
});
export type GroupNoteRef = z.infer<typeof GroupNoteRefSchema>;

export const GroupNoteSchema = z.object({
  id: z.number().int().positive(),
  authorId: z.string(),
  authorName: z.string(),
  kind: z.enum(NOTE_KINDS),
  title: z.string(),
  body: z.string(),
  refs: z.array(GroupNoteRefSchema).default([]),
  task: z.number().int().positive().nullable().default(null),
  thread: z.number().int().positive().nullable().default(null),
  supersedes: z.number().int().positive().nullable().default(null),
  supersededBy: z.number().int().positive().nullable().default(null),
  pinned: z.boolean().default(false),
  createdAt: z.string(),
});
export type GroupNote = z.infer<typeof GroupNoteSchema>;

/** What a board list or search shows: no body, no weight. */
export const GroupNoteSummarySchema = GroupNoteSchema.pick({ id: true, authorName: true, kind: true, title: true, refs: true, task: true, thread: true, supersedes: true, pinned: true, createdAt: true }).extend({
  snippet: z.string(),
});
export type GroupNoteSummary = z.infer<typeof GroupNoteSummarySchema>;

/** The token a body writes to name a ref: "note #4" or "#12". */
export function noteRefToken(ref: GroupNoteRef): string {
  return ref.note ? `note #${ref.note}` : `#${ref.message}`;
}

/** Whether a note's body names a ref, as the publish rule requires. */
export function noteNamesRef(body: string, ref: GroupNoteRef): boolean {
  if (ref.note) return new RegExp(`(?:^|[^\\p{L}\\p{N}_])note\\s*#${ref.note}(?!\\d)`, "iu").test(body);
  if (!ref.message) return false;
  // "note #12" also contains "#12"; a message ref must be a bare #12.
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_#])#${ref.message}(?!\\d)`, "u").test(body.replace(/note\s*#\d+/giu, ""));
}

export const WakeReasonSchema = z.enum(["mention", "reply", "everyone", "open", "group", "handoff", "thread", "assigned"]);
/** Why a message wakes a bot. */
export type WakeReason = z.infer<typeof WakeReasonSchema>;

export const WakeModeSchema = z.enum(["everyone", "addressed"]);
/** everyone: every message wakes every unmuted bot. addressed: bots wake only for messages aimed at them. */
export type WakeMode = z.infer<typeof WakeModeSchema>;

export const WorkbenchModeSchema = z.enum(["off", "board", "full"]);
/**
 * off: the existing group chat. board: notes/tools are on, wake rules are unchanged. full: the
 * obligation wake matrix is on as well (Stage 3); a leader still takes precedence.
 */
export type WorkbenchMode = z.infer<typeof WorkbenchModeSchema>;

/** A group as the web UI lists it. */
export const GroupSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  memberIds: z.array(z.string()),
  updatedAt: z.string(),
  lastSeq: z.number(),
  /** The user's read position at the top level. */
  readSeq: z.number(),
  wakeMode: WakeModeSchema,
  /** off, board only, or board plus obligation wakes. */
  workbenchMode: WorkbenchModeSchema.default("off"),
  /** The member that plans and hands out the work; the others take only what it (or the user) hands them. */
  leaderId: z.string().nullable().default(null),
  /** The folder every member's session for the group works in; null: each works in its own. */
  cwd: z.string().nullable().default(null),
  /** Folders besides the working folder every member's session may use. */
  extraFolders: z.array(z.string()).default([]),
  /** Members that only wake when addressed. */
  muted: z.array(z.string()),
  /** Something the user hasn't read: at the top level or in a thread they follow. */
  unread: z.boolean(),
  /** The threads with something the user hasn't read. */
  unreadThreads: z.array(z.number()).default([]),
  last: z.object({ from: GroupSenderSchema, text: z.string(), at: z.string() }).nullable(),
  /** Each member's seat chat, once it has one. */
  seats: z.record(z.string(), z.string().nullable()),
});
export type GroupSummary = z.infer<typeof GroupSummarySchema>;

export function newGroupChatId(): string {
  return "group-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** "Researcher, Writer & Reviewer", or "Researcher, Writer, Reviewer +2", the name a new group starts with. */
export function defaultGroupName(names: readonly string[]): string {
  const clean = names.map((name) => name.trim()).filter(Boolean);
  if (clean.length === 0) return "Group chat";
  if (clean.length === 1) return clean[0]!;
  if (clean.length <= 3) return `${clean.slice(0, -1).join(", ")} & ${clean.at(-1)}`;
  return `${clean.slice(0, 3).join(", ")} +${clean.length - 3}`;
}

/** Why a group can't be saved with these members, or null. */
export function membersProblem(memberIds: readonly string[]): string | null {
  const count = new Set(memberIds).size;
  if (count < GROUP_MIN_BOTS) return `A group chat needs at least ${GROUP_MIN_BOTS} bots.`;
  if (count > GROUP_MAX_BOTS) return `A group chat can have at most ${GROUP_MAX_BOTS} bots.`;
  return null;
}

// ---------------------------------------------------------------- mentions

export interface Member {
  id: string;
  name: string;
}

const ASCII_WORD = /[A-Za-z0-9_]/;
/** A character that can't come right before an @mention (an email address's local part, say). */
const BEFORE_MENTION = /[A-Za-z0-9._%+-]/;

/**
 * Where `name` (any case) is mentioned at `at`, the index of the "@": the length
 * matched, or 0. A name ending in a letter or digit must end there, so @Ann
 * isn't found in @Anna; one followed by CJK still counts, as Chinese writers
 * often leave out the space (@Writer请看).
 */
function matchAt(text: string, at: number, name: string): number {
  const candidate = text.slice(at + 1, at + 1 + name.length);
  if (candidate.toLowerCase() !== name.toLowerCase()) return 0;
  const next = text[at + 1 + name.length];
  if (next !== undefined && ASCII_WORD.test(name.at(-1) ?? "") && ASCII_WORD.test(next)) return 0;
  return name.length;
}

export interface MentionSpan {
  start: number;
  end: number;
  /** The member mentioned; null for @everyone. */
  botId: string | null;
}

/**
 * The parts of a text that are code, as [start, end) ranges: a run of backticks up to the next run
 * of the same length, so `inline code` and ``` fenced blocks alike. A run with no match is
 * literal backticks, as in Markdown.
 */
function codeRanges(text: string): [number, number][] {
  const runs = [...text.matchAll(/`+/g)].map((match) => ({ start: match.index ?? 0, length: match[0].length }));
  const ranges: [number, number][] = [];
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]!;
    const close = runs.findIndex((run, j) => j > i && run.length === open.length);
    if (close < 0) continue;
    ranges.push([open.start, runs[close]!.start + open.length]);
    i = close;
  }
  return ranges;
}

/**
 * Where a text @mentions members by name (longest names first, so "@Ann Lee"
 * beats "@Ann") or @everyone, and the @words that name nobody in the group.
 * An @word inside code is literal, so a name can be written without mentioning it.
 * The web UI highlights with the same spans the server wakes bots by.
 */
export function mentionSpans(text: string, members: readonly Member[]): { spans: MentionSpan[]; unknown: string[] } {
  const byLength = members.filter((member) => member.name.trim()).sort((a, b) => b.name.trim().length - a.name.trim().length);
  const code = codeRanges(text);
  const spans: MentionSpan[] = [];
  const unknown: string[] = [];
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at > 0 && BEFORE_MENTION.test(text[at - 1]!)) continue;
    if (code.some(([start, end]) => at > start && at < end)) continue;
    const member = byLength.find((candidate) => matchAt(text, at, candidate.name.trim()) > 0);
    if (member) {
      spans.push({ start: at, end: at + 1 + member.name.trim().length, botId: member.id });
      continue;
    }
    if (matchAt(text, at, "everyone") > 0) {
      spans.push({ start: at, end: at + 1 + "everyone".length, botId: null });
      continue;
    }
    const word = /^@([\p{L}\p{N}_-]+)/u.exec(text.slice(at))?.[1];
    if (word && !unknown.includes(word)) unknown.push(word);
  }
  return { spans, unknown };
}

export interface Mentions {
  /** The members mentioned, in the order first mentioned. */
  botIds: string[];
  everyone: boolean;
  /** @words that name no bot at all. */
  unknown: string[];
  /** Each mentioned bot's @token as the text wrote it, by its id. */
  handles: Record<string, string>;
  /** The user's other bots, @mentioned by name but not in the group: the mention reaches nobody. */
  outside: { id: string; name: string; handle: string }[];
}

/** `outsiders` are the user's bots that aren't members: an @mention of one is told apart from a name that's nobody's. */
export function parseMentions(text: string, members: readonly Member[], outsiders: readonly Member[] = []): Mentions {
  const memberIds = new Set(members.map((member) => member.id));
  const others = outsiders.filter((bot) => !memberIds.has(bot.id));
  const { spans, unknown } = mentionSpans(text, [...members, ...others]);
  const botIds: string[] = [];
  const handles: Record<string, string> = {};
  const outside: Mentions["outside"] = [];
  for (const span of spans) {
    if (!span.botId || botIds.includes(span.botId) || outside.some((bot) => bot.id === span.botId)) continue;
    const handle = text.slice(span.start, span.end);
    const other = memberIds.has(span.botId) ? null : others.find((bot) => bot.id === span.botId);
    if (other) outside.push({ id: other.id, name: other.name, handle });
    else {
      botIds.push(span.botId);
      handles[span.botId] = handle;
    }
  }
  return { botIds, everyone: spans.some((span) => span.botId === null), unknown, handles, outside };
}

// ---------------------------------------------------------------- notes, unread and delivery

/**
 * pocket-bots's own notes, each declared with its classification:
 * - born-read: delivered and unread for everyone except whoever caused it;
 * - skip: no delivery record at all (churn nobody needs to read).
 */
export const SYSTEM_SUBTYPES = {
  "group.membership": "born-read",
  /** The user made a member the leader, or the group has none any more. */
  "group.leader": "born-read",
  /**
   * The user set the group's working folder, or took it away: for the record. It wakes nobody; each
   * seat moves at its next turn, and its briefing says so.
   */
  "group.folder": "skip",
  "task.created_summary": "born-read",
  "task.assignment_receipt": "born-read",
  "task.converted_summary": "born-read",
  "task.lifecycle_thread": "born-read",
  "task.deleted_summary": "skip",
  /** A bot stopped following a thread: nobody needs to read it. */
  "thread.self_unfollow": "skip",
  /** A bot's failed turn: a note for the record that reaches no inbox. */
  "seat.turn_failed": "skip",
  /**
   * A member the leader leads failed a turn on its piece of work: told in the piece's thread,
   * @mentioning the leader, who decides whether the member carries on or someone else does.
   */
  "seat.piece_failed": "born-read",
  /**
   * A bot's question to the user, sent as the bot. It's for the user, who answers
   * it in place, so it reaches no inbox: no bot is woken or held by it, and it's in the group's
   * history for whoever reads there.
   */
  "bot.question": "skip",
} as const satisfies Record<string, "born-read" | "skip">;
export type SystemSubtype = keyof typeof SYSTEM_SUBTYPES;

/**
 * Notes that don't hold the post of the one who caused them: everything they say was in that one's own request or
 * its answer. A task's lifecycle note isn't one: it carries the task's title.
 */
export const FRESHNESS_EXEMPT_SUBTYPES: readonly SystemSubtype[] = ["group.membership", "group.leader", "task.created_summary", "task.assignment_receipt", "task.converted_summary"];

export const isSkipSubtype = (subtype: string | null): boolean => !!subtype && (SYSTEM_SUBTYPES as Record<string, string>)[subtype] === "skip";

/** What the unread rule reads of a message. */
export interface UnreadSubject {
  /** "user", a bot's id, or "system". */
  senderId: string;
  system: boolean;
  subtype: string | null;
  /** Who caused a note: "user" or a bot's id. */
  causalActor: string | null;
}

/**
 * One rule for "is this message unread for this receiver": not its own message, not a note it caused, not a
 * skip note; a personal @mention is always unread.
 */
export function unreadEligible(message: UnreadSubject, receiverId: string, personal: boolean): boolean {
  if (!message.system && message.senderId === receiverId) return false;
  if (personal) return true;
  if (message.system && message.causalActor === receiverId) return false;
  return !isSkipSubtype(message.subtype);
}

export interface DeliveryInput {
  mode: WakeMode;
  /** Full mode: only an obligation wakes; bot chatter and a deep reply chain don't. */
  full?: boolean;
  /** How many bot replies deep this message is (a reply to a user is 1). */
  depth?: number;
  receiverId: string;
  /** The conversation: 0 for the top level, else the thread's top message. */
  conv: number;
  message: {
    senderId: string;
    kind: GroupSender["kind"];
    everyone: boolean;
    mentions: readonly string[];
    /** The member whose message this one replies to: a reply addresses that member. */
    repliesTo?: string | null;
    /** A note's subtype. */
    subtype?: string | null;
  };
  /** The receiver is @mentioned (or, for a note, is the task's assignee). */
  personal: boolean;
  /** The receiver wrote the message this one replies to. */
  repliedTo: boolean;
  eligible: boolean;
}

/**
 * Whether a delivery record also goes into the bot's inbox and wakes it, and why. A muted bot
 * has no record for ordinary top-level messages in the first place (see group-store.ts), so mute isn't
 * decided here. Everyone mode delivers every unread message; addressed mode only what's aimed at
 * the bot, and the user's messages that address nobody (no @mention, no @everyone, no reply to a
 * member). A note that names the bot is a task assigned to it only when it's an assignment
 * receipt; any other (the leader's appointment) is an @mention. Full mode adds the obligation
 * checks below (bot chatter, broadcasts and deep reply chains don't wake); the other modes have no
 * cap on how often bots wake each other.
 */
export function deliveryReason(input: DeliveryInput): WakeReason | null {
  const { message } = input;
  if (!input.eligible || (message.kind === "bot" && message.senderId === input.receiverId)) return null;
  if (input.personal) {
    if (message.kind === "system") return message.subtype === "task.assignment_receipt" ? "assigned" : "mention";
    return message.kind === "bot" ? "handoff" : "mention";
  }
  if (input.full) {
    // Only the user can broadcast; a bot's @everyone is an ordinary message.
    if (message.kind === "bot" && message.everyone) return null;
    // A bot's top-level message with nobody named is board material, not a wake.
    if (message.kind === "bot" && input.conv === 0 && !input.repliedTo) return null;
    // A bot's thread chatter wakes nobody unless it answers someone (and the chain isn't a loop).
    if (message.kind === "bot" && input.conv !== 0 && !input.repliedTo) return null;
    if (input.repliedTo && (input.depth ?? 0) >= WAKE_HOPS_MAX) return null;
    // A user's reply wakes the bot it answers (the depth guard above doesn't apply to the user's
    // own reply); for everyone else it names that bot, so they stay quiet.
    if (input.repliedTo) return "reply";
    // A user's message that names someone is for them, not for the whole group.
    if (message.kind === "user" && !message.everyone && (message.mentions.length > 0 || message.repliesTo)) return null;
  }
  if (input.repliedTo) return "reply";
  if (message.everyone) return "everyone";
  const open = message.kind === "user" && message.mentions.length === 0 && !message.everyone && !message.repliesTo;
  if (input.conv !== 0) return input.mode === "everyone" || open ? "thread" : null;
  if (input.mode === "everyone") return open ? "open" : "group";
  return open ? "open" : null;
}

/**
 * In a group with a leader, whether a message comes from the ones who hand out the work: the
 * user, the leader, or a note one of them (or pocket-bots itself) caused.
 */
export function fromLead(leaderId: string, message: { kind: GroupSender["kind"]; senderId: string; causalActor: string | null }): boolean {
  if (message.kind === "user") return true;
  if (message.kind === "bot") return message.senderId === leaderId;
  return message.causalActor === null || message.causalActor === leaderId || message.causalActor === GROUP_USER_ID;
}

/**
 * In a group with a leader, the piece of work a message in a member's inbox belongs to: for a
 * message in a thread, that thread; for a top-level message from the leader or the user that
 * @mentions the member, the message itself (a new piece). Null for what's part of no piece (a note,
 * @everyone, a reply at the top level): it goes to whichever piece is current.
 */
export function workOf(leaderId: string, botId: string, message: Pick<GroupMessage, "seq" | "thread" | "from" | "mentions">): number | null {
  if (message.thread) return message.thread;
  if (message.from.kind === "system" || !message.mentions.includes(botId)) return null;
  return message.from.kind === "user" || message.from.botId === leaderId ? message.seq : null;
}

/**
 * What a led member's wake is about: one piece of work at a time (workOf), each in a session of
 * its own. News for the piece its seat's session is on (`current`) comes first, else the oldest
 * piece in its inbox; messages of no piece go along. What's for another piece waits for its turn.
 * Only pieces with something no notice told yet count, so a piece whose messages were told and
 * not read doesn't hold up the others. `switching`: the seat's session is on another piece, so
 * this one starts a fresh session.
 */
export function pieceFor<T extends { message: Pick<GroupMessage, "seq" | "thread" | "from" | "mentions">; noticed?: boolean }>(leaderId: string, botId: string, pending: readonly T[], current: number | null): { work: number | null; now: T[]; switching: boolean } {
  const works = pending.map((entry) => workOf(leaderId, botId, entry.message));
  const news = works.filter((work, index): work is number => work !== null && !pending[index]!.noticed);
  const open = news.length ? news : works.filter((work): work is number => work !== null);
  const work = current !== null && open.includes(current) ? current : (open[0] ?? null);
  return { work, now: pending.filter((_, index) => works[index] === null || works[index] === work), switching: work !== null && current !== null && current !== work };
}

// ---------------------------------------------------------------- what a bot reads

export interface RosterEntry {
  id: string;
  name: string;
  title: string;
  /** The group's leader. */
  leader?: boolean;
}

function senderLabel(from: GroupSender, meId: string): string {
  if (from.kind === "user") return "the user";
  if (from.kind === "system") return "pocket-bots";
  return from.botId === meId ? "you" : `${from.name} (bot)`;
}

function stamp(at: string): string {
  return `${at.slice(0, 16).replace("T", " ")}Z`;
}

/** Where a thread message is: its thread, and what the thread's top message said when it's known. */
function threadLabel(thread: number, parent: GroupMessage | undefined, meId: string): string {
  if (!parent) return `in thread #${thread}`;
  return `in thread #${thread} (on ${senderLabel(parent.from, meId)}: "${messagePreview(parent, 60)}")`;
}

/**
 * One message as a bot reads it: its number, sender, time, its thread, what it answers, its
 * claim, then the text. `parents` gives thread messages their thread's top message.
 */
export function messageText(message: GroupMessage, meId: string, parents?: ReadonlyMap<number, GroupMessage>): string {
  const head = [`#${message.seq}`, senderLabel(message.from, meId), stamp(message.at)];
  if (message.thread) head.push(threadLabel(message.thread, parents?.get(message.thread), meId));
  if (message.replyTo) head.push(`replying to #${message.replyTo}`);
  if (message.mentions.includes(meId)) head.push("@mentions you");
  else if (message.everyone) head.push("for @everyone");
  if (message.replies) head.push(`${message.replies} repl${message.replies === 1 ? "y" : "ies"} in its thread`);
  if (message.task) head.push(`[${taskLabel(message.task, meId)}]`);
  const files = message.attachments.length ? `\n[Attached: ${message.attachments.map((file) => `${file.name} (${file.kind}, ${file.path})`).join("; ")}]` : "";
  const question = message.question ? `\n${questionState(message.question, message.from.kind === "bot" && message.from.botId === meId)}` : "";
  const reactions = message.reactions.length ? `\n[Reactions: ${message.reactions.map((reaction) => `${reaction.emoji} ${reaction.names.join(", ")}`).join("; ")}]` : "";
  return `${head.join(" · ")}\n${message.text.trim() || "(no text)"}${files}${question}${reactions}${message.task ? amendedText(message.task, meId) : ""}`;
}

/** Where a bot's question to the user stands, under its message. */
function questionState(question: GroupQuestion, mine: boolean): string {
  const asked = mine ? "Your question for the user" : "A question for the user";
  switch (question.status) {
    case "pending":
      return `[${asked}: waiting for the answer]`;
    case "answered": {
      const answers = (question.answers ?? []).map((answer) => (answer === null ? "(no answer)" : `"${answer}"`));
      return `[${asked}: the user answered ${answers.length > 1 ? answers.map((answer, index) => `${index + 1}. ${answer}`).join("; ") : (answers[0] ?? "(no answer)")}]`;
    }
    case "dismissed":
      return `[${asked}: the user dismissed it]`;
    case "closed":
      return `[${asked}: no longer waiting; it wasn't answered]`;
  }
}

/**
 * An amended task's current card under its message: the
 * message keeps the words it was sent with, and the card's title and description supersede them.
 * The "Current title:" and "Current description:" labels are the same in group_task show.
 */
function amendedText(task: Pick<GroupTask, "number" | "revision" | "title" | "description" | "amended">, meId: string): string {
  if (!task.amended) return "";
  const by = task.amended.byId === meId ? "you" : task.amended.by;
  const lines = [`[task #${task.number} amended: the card supersedes this message's text (rev=${task.revision}, by ${by}, ${stamp(task.amended.at)})]`, `Current title: ${task.title}`];
  if (task.description !== null) lines.push(`Current description: ${task.description}`);
  return `\n${lines.join("\n")}`;
}

function rosterLine(me: Member, roster: readonly RosterEntry[]): string {
  const entries = roster.map((member) => {
    const lead = member.leader ? "leader" : "";
    if (member.id === me.id) return `${member.name} (${lead ? "you, the leader" : "you"})`;
    const about = [lead, member.title.trim() ? foldText(member.title, 60) : ""].filter(Boolean).join(": ");
    return `${member.name}${about ? ` (${about})` : ""}`;
  });
  return `${entries.join(", ")}, and the user`;
}

/** Why a pending message is for the bot, as its inbox row says it. */
function flagText(reason: WakeReason, from: GroupSender): string | null {
  const who = from.kind === "bot" ? from.name : "the user";
  switch (reason) {
    case "mention":
      return "you were @mentioned";
    case "handoff":
      return `${who} handed you work with an @mention`;
    case "reply":
      return `${who} replied to your message`;
    case "everyone":
      return "for @everyone";
    case "assigned":
      return "a task was assigned to you";
    default:
      return null;
  }
}

/** Where a conversation is, in text: "the top level" or "thread #12". */
export const placeName = (conv: number): string => (conv ? `thread #${conv}` : "the top level");

/** A pending message: delivered to the bot's inbox, not read yet, and why it was delivered. */
export interface PendingMessage {
  message: GroupMessage;
  reason: WakeReason;
  /** This @mention made the bot follow its thread again after it had stopped. */
  reactivated?: boolean;
}

/**
 * The content-free rows of an inbox notice: one per place,
 * how many are pending, the first and latest numbers, who sent the latest, and why they're for
 * the bot; the place with the latest activity first.
 */
export function inboxRows(pending: readonly PendingMessage[], meId: string): string[] {
  const places = new Map<number, PendingMessage[]>();
  for (const entry of pending) {
    const conv = entry.message.thread ?? 0;
    places.set(conv, [...(places.get(conv) ?? []), entry]);
  }
  return [...places]
    .map(([conv, entries]) => ({ conv, entries: [...entries].sort((a, b) => a.message.seq - b.message.seq) }))
    .sort((a, b) => b.entries.at(-1)!.message.seq - a.entries.at(-1)!.message.seq)
    .map(({ conv, entries }) => {
      const first = entries[0]!.message;
      const latest = entries.at(-1)!.message;
      const span = entries.length === 1 ? `#${latest.seq}` : `#${first.seq} to #${latest.seq}`;
      const parts = [`${conv ? `thread #${conv}` : "top level"}: ${entries.length} new (${span})`, `latest from ${senderLabel(latest.from, meId)}`];
      const flags = [...new Set(entries.flatMap((entry) => flagText(entry.reason, entry.message.from) ?? []))];
      if (entries.some((entry) => entry.message.task)) flags.push("a task");
      return `- ${[...parts, ...flags].join(" · ")}`;
    });
}

/** A thread the bot was just pulled into: its top message, the replies before, and the message that pulled it in. */
export interface ThreadJoin {
  thread: number;
  parent: GroupMessage;
  recent: readonly GroupMessage[];
  /** Earlier replies left out. */
  earlier: number;
  trigger: GroupMessage;
}

export interface WakeInput {
  groupName: string;
  me: Member;
  /** The group's live members, the receiving bot among them. */
  roster: readonly RosterEntry[];
  /** Messages in its inbox, oldest first: shown only as counts. */
  pending: readonly PendingMessage[];
  joins?: readonly ThreadJoin[];
  /** A renewed seat: where it was (recent messages, files in play, last actions; server/briefing.ts). */
  briefing?: string;
  /** Tasks assigned to it that aren't finished, for a new seat or a catch-up. */
  owed?: readonly GroupTask[];
  /**
   * pocket-bots restarted: the unread messages themselves in a bounded batch, and
   * the unread places it didn't cover in full; with no batch, the places only, for a
   * constrained catch-up (read each place once, then stop unless something there is for it).
   */
  catchUp?: { messages: readonly GroupMessage[]; places: readonly UnreadPlace[]; uncovered: readonly UnreadPlace[]; parents?: ReadonlyMap<number, GroupMessage> };
  /** Its reminders that fired (server/reminders.ts reminderFiredText): for it alone. */
  reminders?: readonly string[];
  /**
   * In a group with a leader, the messages of the piece of work a member is woken for, in full:
   * it needn't read its inbox for them, and they count as read once its seat takes them in.
   */
  handed?: { messages: readonly GroupMessage[]; parents?: ReadonlyMap<number, GroupMessage> };
}

/**
 * What a seat gets when the group wakes it, or while it works: a content-free
 * inbox notice with what's new and where, and the bot reads the messages itself. Only a thread
 * it was just pulled into comes with its text, and a renewed seat with a short briefing.
 */
export function wakeText(input: WakeInput): string {
  const me = input.me.id;
  const lines = [`[Group chat "${input.groupName}". Members: ${rosterLine(input.me, input.roster)}.]`, ""];
  if (input.briefing) lines.push(input.briefing, "", "---", "");
  for (const join of input.joins ?? []) {
    const parents = new Map([[join.thread, join.parent]]);
    lines.push(
      `[Thread context: you were @mentioned in thread #${join.thread}, which you haven't read.]`,
      `Suggested next step: group_read with thread: ${join.thread}.`,
      "",
      "The thread's top message:",
      messageText(join.parent, me),
      "",
      `Recent replies${join.earlier > 0 ? ` (truncated: ${join.earlier} earlier not shown)` : ""}:`,
      ...(join.recent.length ? join.recent.map((message) => `${messageText(message, me, parents)}\n`) : ["(no earlier replies)", ""]),
      "The message that @mentions you:",
      messageText(join.trigger, me, parents),
      "",
      "---",
      "",
    );
  }
  for (const reminder of input.reminders ?? []) lines.push(reminder, "");
  if (input.handed?.messages.length) {
    lines.push("[For you, in full (already read):]", "");
    for (const message of input.handed.messages) lines.push(messageText(message, me, input.handed.parents), "");
  }
  const count = input.pending.length;
  const unreadLines = (places: readonly UnreadPlace[]) => places.map((place) => `- ${place.conv ? `thread #${place.conv}` : "top level"}: ${place.count} unread`);
  if (input.catchUp?.messages.length) {
    lines.push(`New message${input.catchUp.messages.length === 1 ? "" : "s"} received while pocket-bots was stopped:`, "");
    for (const message of input.catchUp.messages) lines.push(messageText(message, me, input.catchUp.parents), "");
    lines.push("Respond as appropriate. Complete all your work before stopping.", "");
    if (input.catchUp.uncovered.length) {
      lines.push("Some unread places may not be fully included in this bounded batch:", ...unreadLines(input.catchUp.uncovered), "", "group_inbox lists every place with unread messages, if you choose to inspect them at a natural breakpoint.", "");
    }
  } else if (input.catchUp?.places.length) {
    lines.push(
      "You have unread messages from while pocket-bots was stopped:",
      ...unreadLines(input.catchUp.places),
      "",
      "Use group_read (unread: true, with thread: a number or top_level: true) to catch up on the places listed above, then stop. Read each listed place at most once unless a read fails. Don't read your whole inbox (group_read with unread: true alone) in this mode. If the history reveals a direct request, assignment, @mention, review request, or task clearly addressed to you, switch into active handling instead of stopping: reply with group_send in that place, and claim the relevant task with group_claim before starting work. Otherwise, don't send any message in this mode.",
      "",
    );
  } else if (count) {
    lines.push(
      `[Group inbox notice: ${count} new message${count === 1 ? "" : "s"} for you to read.`,
      ...inboxRows(input.pending, me),
      "]",
      "They haven't been read. Read them when it suits you: group_read with unread: true reads everything in your inbox, or add thread: a number (or top_level: true) for one place. Deferring them doesn't mean there's nothing for you.",
      "",
    );
  }
  for (const thread of new Set(input.pending.filter((entry) => entry.reactivated).map((entry) => entry.message.thread))) {
    if (thread) lines.push(`[Thread follow restored: this @mention re-subscribed you to ordinary replies in thread #${thread}.]`, `To stop those replies again: group_follow with thread: ${thread} and follow: false.`, "");
  }
  if (input.owed?.length) lines.push(`Tasks assigned to you that aren't finished: ${input.owed.map((task) => `task #${task.number} (${task.status})`).join(", ")}.`, "");
  lines.push("Speak in the group only with group_send. To stay silent, end your turn without sending.");
  return lines.join("\n");
}

export interface HeldInput {
  action: "send" | "claim" | "task";
  /** The conversation the action was for. */
  conv: number;
  /** The newest of what it hasn't seen, oldest first (at most three). */
  shown: readonly GroupMessage[];
  /** New messages counted there; for a first touch, how many are shown. */
  count: number;
  /** Counted but not shown. */
  omitted: number;
  /** The bot hadn't read this place at all: what it's shown is the latest, not what's new. */
  firstTouch: boolean;
  /** A thread's top message, shown as its anchor when it isn't among `shown`. */
  parent?: GroupMessage | null;
  meId: string;
  /** How many times this draft has been held. */
  holds: number;
}

/**
 * What a held post (or claim, or status change) says: the newest messages
 * the bot hasn't seen there, how many more it hasn't been shown, and its choices. The post is
 * kept as a draft; nothing was sent.
 */
export function heldText(input: HeldInput): string {
  const what = input.action === "send" ? "Your message wasn't sent" : input.action === "claim" ? "Your claim wasn't made" : "Your update wasn't made";
  const where = placeName(input.conv);
  const lines = input.firstTouch
    ? [`${what}: you haven't read ${where} yet. Its latest messages:`, ""]
    : [`${what}: ${input.count} message${input.count === 1 ? "" : "s"} you haven't seen came in at ${where}.`, ""];
  if (input.omitted > 0) {
    const before = input.shown[0]?.seq;
    lines.push(`(${input.omitted} more not shown: group_read with ${input.conv ? `thread: ${input.conv}` : "top_level: true"}${before ? `, before: ${before}` : ""} shows them.)`, "");
  }
  if (input.parent && !input.shown.some((message) => message.seq === input.parent!.seq)) lines.push("The thread's top message:", messageText(input.parent, input.meId), "", "Newest replies:", "");
  for (const message of input.shown) lines.push(messageText(message, input.meId), "");
  if (input.action === "send") {
    lines.push(
      "Your message is saved as a draft for 10 minutes. Choose one:",
      "- send revised content with group_send (it replaces the draft);",
      `- send the draft unchanged with group_send_draft${input.conv ? ` thread: ${input.conv}` : ""} (it's checked again);`,
      "- drop it with group_send_draft discard: true;",
      "- send nothing: if someone already covered it, silence is the right outcome, not a failure.",
    );
    if (input.holds >= ANYWAY_AFTER_HOLDS) lines.push(`It has been held ${input.holds} times. If it's still the right message, group_send_draft with anyway: true sends it without another check.`);
  } else {
    lines.push("Look at these first (someone may have taken it already), then try again if it's still yours to do.");
  }
  return lines.join("\n");
}

/** The guard for a top-level post right after reading a thread: confirm the target once. */
export function threadMismatchText(thread: number): string {
  return [
    `Not sent: the latest place you read is thread #${thread}, but this message goes to the top level.`,
    `- If it belongs in the thread, send it with group_send thread: ${thread}.`,
    "- If the top level is right, group_send_draft sends the saved draft there unchanged.",
    "This is asked once: moving a thread's conclusion to the top level can be right, but it's uncommon.",
  ].join("\n");
}

// ---------------------------------------------------------------- task cards

/** One change to a task: created, a status or assignee change, a close, a reopen, an amendment. */
export interface TaskEvent {
  /** Its place among every task change. */
  seq: number;
  event: "created" | "status_changed" | "assignee_changed" | "reopened" | "closed" | "amended";
  actor: { kind: "user" | "bot" | "system"; id: string | null; name: string | null };
  payload: Record<string, unknown>;
  at: string;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const indentBody = (text: string, by: number) => text.replace(/\n/g, `\n${" ".repeat(by)}`);

/** group_task show: one task's current card. `creator` is who made it a task. */
export function taskShowText(task: GroupTask, meId: string, creator: string): string {
  return [
    `${taskLabel(task, meId)} · rev=${task.revision} · made a task by ${creator}${task.stale ? " · its lease is stale; anyone may claim it" : ""}`,
    `Current title: ${task.title}`,
    `Current description: ${task.description ?? "(none set)"}`,
  ].join("\n");
}

/** group_task amend's receipt. */
export function taskAmendedText(task: GroupTask, eventSeq: number): string {
  const details = task.description === null ? "details: <none>" : `details:\n${task.description.split("\n").map((line) => `  ${line}`).join("\n")}`;
  return [`#${task.number} amended — revision ${task.revision}, event seq ${eventSeq}.`, `title: ${task.title}`, details].join("\n");
}

function actorText(actor: TaskEvent["actor"], meId: string): string {
  if (actor.kind === "system") return "pocket-bots";
  if (actor.kind === "user") return "the user";
  return actor.id === meId ? "you" : `@${actor.name ?? actor.id ?? "?"}`;
}

/** group_task history: the card now, then every change to it in order. */
export function taskHistoryText(task: GroupTask, events: readonly TaskEvent[], meId: string): string {
  const header = [
    `## Task #${task.number} history — revision ${task.revision}`,
    "",
    `Current title: ${oneLine(task.title)}`,
    `Current description: ${task.description === null ? "(none set)" : indentBody(task.description, "Current description: ".length)}`,
  ].join("\n");
  if (events.length === 0) return `${header}\n\nNo recorded events.`;
  const lines = events.map((event) => `seq=${event.seq} time=${stamp(event.at)} actor=${actorText(event.actor, meId)} type=${event.event}\n  ${JSON.stringify(event.payload)}`);
  return `${header}\n\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------- mention delivery

const askBotRecovery = (name: string, askBot: boolean) =>
  `only the user can add ${name} to this group.${askBot ? ` To reach ${name} now, use ask_bot: it starts a separate chat, and ${name} can't read this group.` : ""}`;

/**
 * What group_send adds when some @mentions reached nobody ("Undelivered mentions — partial
 * result"): a bot of the user's that isn't in the group (not_in_conversation), a name that's no
 * bot's (unknown_or_not_visible), or, in a group with a leader, a member that takes work only from
 * the leader (`led`, with the leader's name). The message itself was sent.
 */
export function undeliveredMentionsText(input: { outside: readonly { name: string; handle: string }[]; unknown: readonly string[]; askBot: boolean; led?: { leader: string; members: readonly { name: string; handle: string }[] } }): string {
  const led = input.led?.members ?? [];
  if (input.outside.length === 0 && input.unknown.length === 0 && led.length === 0) return "";
  const lines = [
    "Undelivered mentions — partial result",
    "The message was sent: don't send it again, or it posts twice. Each row is the literal @token from your message; to write a name without mentioning it, put it in `code`.",
  ];
  for (const bot of input.outside) {
    lines.push(`- ${bot.handle} — not in this group`, "  consequence: this @mention didn't notify anyone.", `  recovery: ${askBotRecovery(bot.name, input.askBot)}`);
  }
  for (const bot of led) {
    lines.push(
      `- ${bot.handle} — takes work only from the leader, ${input.led!.leader}, or the user`,
      "  consequence: this @mention didn't notify anyone.",
      `  recovery: if ${bot.name} should do something, tell @${input.led!.leader} what and why; the leader hands out the work.`,
    );
  }
  for (const word of input.unknown) {
    lines.push(
      `- @${word} — no bot by that name`,
      "  consequence: this @mention didn't notify anyone.",
      "  recovery: if it was a literal name, put it in `code`; otherwise check the exact name (group_members) and send only a corrected follow-up mention. Don't resend this message.",
    );
  }
  return lines.join("\n");
}

/**
 * Why telling a bot about its inbox failed:
 * its seat's turn hit a rate or quota limit, its turn failed otherwise, or its seat couldn't
 * start.
 */
export type DeliveryFailure = "quota" | "runtime_error" | "not_launched";

/** A failed turn's error, by category: a rate or quota limit, or anything else. */
export function deliveryFailureOf(error: string): Exclude<DeliveryFailure, "not_launched"> {
  return /rate.?limit|quota|usage limit|too many requests|\b429\b/i.test(error) ? "quota" : "runtime_error";
}

/** One @mentioned member's outcome for a message. */
export interface MentionDeliveryRow {
  handle: string;
  /** delivered: its model has read it; pending: in flight; lost: telling it failed; unknown: no record to judge by. */
  outcome: "delivered" | "pending" | "lost" | "unknown";
  /** lost: why. */
  category?: DeliveryFailure | "unclassified";
  /** pending: a notice told its seat, and whether the seat took it in. */
  told?: boolean;
  accepted?: boolean;
}

/** Another receiver of the message, and whether it read it. */
export interface ReceiverRow {
  name: string;
  /** read; inbox: in its inbox, not read; unread: delivered, not read, not in its inbox (addressed mode, or the user). */
  state: "read" | "inbox" | "unread";
}

/** An outcome's wording, with what we know of a message still in flight. */
function deliveryText(row: MentionDeliveryRow): string {
  switch (row.outcome) {
    case "delivered":
      return "delivered";
    case "pending":
      return `still in flight — do not conclude yet (${!row.told ? "not told yet: its seat is busy or starting" : row.accepted ? "its seat has the notice; not read yet" : "notice sent; its seat hasn't taken it in yet"})`;
    case "unknown":
      return "UNKNOWN — our instrument could not see this one; re-check, do not conclude";
    case "lost":
      switch (row.category) {
        case "quota":
          return "LOST — target is rate/quota limited; it will not arrive, re-route or retry later";
        case "runtime_error":
          return "LOST — target's runtime rejected delivery; re-route";
        case "not_launched":
          return "LOST — target was not running; re-route or start it";
        default:
          return "LOST — cause is outside the seat-availability set; re-route";
      }
  }
}

/**
 * group_mention_delivery: what
 * happened to each member a message @mentioned, then who else it reached and who it didn't.
 */
export function mentionDeliveryText(seq: number, mentions: readonly MentionDeliveryRow[], others: readonly ReceiverRow[], missed: readonly string[]): string {
  const lines = mentions.length ? [`Message #${seq} — mention delivery per target`, "", ...mentions.map((row) => `  ${row.handle}: ${deliveryText(row)}`)] : [`Message #${seq}`, "", "No mention deliveries recorded for this message."];
  if (others.length) {
    const label = { read: "read", inbox: "in its inbox, not read yet", unread: "delivered, not read yet" } as const;
    lines.push("", mentions.length ? "Also delivered to:" : "Delivered to:", ...others.map((row) => `  ${row.name}: ${label[row.state]}`));
  }
  if (missed.length) lines.push("", `Not delivered to (muted, or not following its thread): ${missed.join(", ")}`);
  return lines.join("\n");
}

/** What group_read returns; for a thread, its top message comes first. */
export function historyText(messages: readonly GroupMessage[], hasOlder: boolean, meId: string, options: { thread?: number | null; parents?: ReadonlyMap<number, GroupMessage> } = {}): string {
  if (messages.length === 0) return "No messages.";
  const lines = messages.map((message) => messageText(message, meId, options.parents));
  if (hasOlder) lines.unshift(`(Earlier messages exist: group_read with ${options.thread ? `thread: ${options.thread}, ` : ""}before: ${messages.find((message) => message.thread)?.seq ?? messages[0]!.seq}.)`);
  return lines.join("\n\n");
}

/** Search preview: up to 80 characters before the match and 120 after, the match marked. */
const PREVIEW_BEFORE = 80;
const PREVIEW_AFTER = 120;

function searchPreview(text: string, query: string): string {
  const lower = text.toLowerCase();
  const q = query.trim().toLowerCase();
  let start = q ? lower.indexOf(q) : -1;
  let end = start >= 0 ? start + q.length : -1;
  if (start < 0) {
    for (const term of q.match(/"([^"]+)"|\S+/g) ?? []) {
      const word = term.replace(/^"|"$/g, "");
      const at = word ? lower.indexOf(word) : -1;
      if (at >= 0) {
        [start, end] = [at, at + word.length];
        break;
      }
    }
  }
  const from = start >= 0 ? Math.max(0, start - PREVIEW_BEFORE) : 0;
  const to = start >= 0 ? Math.min(text.length, end + PREVIEW_AFTER) : Math.min(text.length, PREVIEW_BEFORE + PREVIEW_AFTER);
  const body = start >= 0 ? `${text.slice(from, start)}<match>${text.slice(start, end)}</match>${text.slice(end, to)}` : text.slice(from, to);
  return `${from > 0 ? "<omit />" : ""}${body.trim()}${to < text.length ? "<omit />" : ""}`;
}

/**
 * group_search: each hit's place, sender, time and a preview around the
 * match. Previews don't count as seen; reading around a hit does.
 */
export function searchText(query: string, hits: readonly GroupMessage[], meId: string, parents: ReadonlyMap<number, GroupMessage>): string {
  if (hits.length === 0) return "No search results.";
  const results = hits.map((hit) => {
    const where = hit.thread ? threadLabel(hit.thread, parents.get(hit.thread), meId).replace(/^in /, "") : "top level";
    return [
      `<result ref="#${hit.seq}">`,
      `Where: ${where}`,
      `From: ${senderLabel(hit.from, meId)} · ${stamp(hit.at)}`,
      ...(hit.task ? [`[${taskLabel(hit.task, meId)}]`] : []),
      "<preview>",
      searchPreview(hit.text.trim() || messagePreview(hit), query),
      "</preview>",
      "</result>",
    ].join("\n");
  });
  return [`Search results for: "${query.trim()}" (${hits.length} result${hits.length === 1 ? "" : "s"})`, "", results.join("\n\n"), "", "If a result may be relevant but its preview isn't enough, read around it with group_read (around: its number) before answering."].join("\n");
}

/** A conversation with something unread for its reader, for group_inbox and the user's lists. */
export interface UnreadPlace {
  conv: number;
  count: number;
  first: number;
  latest: GroupMessage;
  /** Something there @mentions the reader (or assigns it a task). */
  mention: boolean;
  /** How many unread messages there @mention the reader. */
  mentions?: number;
  /** The latest unread message that @mentions the reader. */
  latestMention?: number | null;
}

function ago(at: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * group_inbox: the places with
 * unread messages, newest activity first, each with its open command, and one Next line. Nothing
 * is read or marked. `notNoticed` counts, per place, inbox messages no notice has told it about yet
 * ("N new, not yet delivered").
 */
export function inboxText(places: readonly UnreadPlace[], meId: string, options: { mentionsOnly?: boolean; notNoticed?: ReadonlyMap<number, number>; now?: number } = {}): string {
  const now = options.now ?? Date.now();
  const withMentions = places.filter((place) => place.mention).length;
  const shown = [...places].filter((place) => !options.mentionsOnly || place.mention).sort((a, b) => b.latest.seq - a.latest.seq);
  let header: string;
  if (options.mentionsOnly) {
    header = withMentions === 0 ? (places.length === 0 ? "Inbox: nothing unread." : `Inbox: no unread mentions (${plural(places.length, "unread place")} in total).`) : `Inbox: ${plural(withMentions, "place")} with unread mentions (of ${plural(places.length, "unread place")}).`;
  } else {
    header = places.length === 0 ? "Inbox: nothing unread." : `Inbox: ${plural(places.length, "unread place")} (${withMentions} with mentions).`;
  }
  if (shown.length) header += " Newest activity first.";
  const open = (conv: number) => `group_read with unread: true and ${conv ? `thread: ${conv}` : "top_level: true"}`;
  const rows = shown.map((place) => {
    const parts = [place.conv ? `thread #${place.conv}` : "top level", `${place.count} unread`];
    const mentions = place.mentions ?? (place.mention ? 1 : 0);
    if (mentions > 0) parts.push(mentions === 1 ? "mentions you" : `mentions you ${mentions}x`);
    const notNoticed = options.notNoticed?.get(place.conv) ?? 0;
    if (notNoticed > 0) parts.push(`${notNoticed} new, not yet told to you`);
    parts.push(`latest ${senderLabel(place.latest.from, meId)} ${ago(place.latest.at, now)}`);
    return `${parts.join(" · ")}\n  open: ${open(place.conv)}`;
  });
  const next = shown.length
    ? `Next: open the first place above: ${open(shown[0]!.conv)}.`
    : options.mentionsOnly && places.length
      ? "Next: group_inbox without mentions lists every unread place."
      : "Next: nothing to do; new messages will reach you as they arrive.";
  return [header, ...(rows.length ? [rows.join("\n")] : []), next].join("\n\n");
}

/**
 * The prompt section a seat's chat gets: how to take part in the group, in terms of the group
 * tools. Left out: what pocket-bots's own prompt covers (memory, workspace), and what a tool's
 * description or result already says (a held draft's choices, a reminder's repeat rules): the
 * section rides on every request the seat makes, so it carries the rules the group code relies on
 * and little else. `subAgents`: the bot's runtime can start sub-agents (SUBAGENT_DELEGATION_SECTION,
 * or a line of the member's rules). `questionTool`: the runtime's own tool for asking the user,
 * whose questions the group shows. `lead`: the group has a leader, and this seat is it (with the
 * members it hands work to) or one of the members it leads, which gets only its own rules and the
 * tools for its piece (see leadSection and the `led` tools). `workbenchMode`: board/full adds the
 * board rules; a leader group never gets them.
 */
export function groupPrompt(groupName: string, options: { subAgents?: boolean; questionTool?: string; lead?: GroupLead; workbenchMode?: WorkbenchMode } = {}): string {
  const role = options.lead?.role ?? null;
  const member = role === "member";
  const section = (title: string, lines: readonly (string | false)[]) => [title, ...lines.filter((line): line is string => line !== false)].join("\n");
  return [
    `This chat is your seat in the group chat "${groupName}" in Pocket Bots, shared by the user and other bots. Nobody else reads this chat: the user and the other bots see only what you send with group_send, your only voice in the group. Approvals, sign-ins and anything private for the user stay here, outside the group.`,
    ...(options.lead ? [leadSection(options.lead, options.subAgents ?? false)] : []),
    section("Messages:", [
      !member &&
        "- pocket-bots wakes you with a notice of where new messages are, not what they say. group_read with unread: true reads your inbox (add thread: N, or top_level: true, for one place); group_inbox lists the places without reading them. Read them when it suits your current work: a notice needn't interrupt it, and unread messages may still hold work for you.",
      "- Each message shows its number (#12), its sender (the user, a bot, or pocket-bots), its time in UTC and, in a thread, its thread. Notes from pocket-bots announce changes (a member joined, a task was created or changed status): don't reply to them unless one asks you to act, such as a task assigned to you.",
      "- If group_send holds your message as a draft because of messages you hadn't seen, choose: send revised text with group_send, send it unchanged with group_send_draft, or let it go. Not sending is a valid outcome when it's no longer needed.",
      "- Make one group tool call at a time, and read its result before the next.",
    ]),
    ...(options.workbenchMode && options.workbenchMode !== "off" && !options.lead
      ? [
          section("The board:", [
            "- Before work someone else may have done, search the board with group_note_search; read a hit with group_note_visit. It is where findings, decisions, dead ends and answers stay reusable.",
            "- group_note publishes one, with refs to the messages or notes it builds on. It wakes nobody: don't also announce it in chat. A later wake lists new note titles; read the ones that matter.",
            "- A ref is a checked dependency, so the body must name it ('#12', or 'note #3'). Building on a note raises its rank; supersede an old note rather than leaving two answers.",
            ...(options.workbenchMode === "full"
              ? [
                  "- Full mode: only obligations wake. A bot's top-level message wakes nobody unless it @mentions someone or replies; only the user's @everyone reaches everyone. Ask for work with an @mention or a task.",
                  "- Notices are batched and capped (30 an hour per seat). A third bot reply in a row stops waking its author: summarize and hand off instead of replying again.",
                ]
              : []),
          ]),
        ]
      : []),
    ...(member
      ? []
      : [
          section("When you're woken:", [
            "1. If a message for you needs a visible acknowledgment, a blocking question or a sign that you own it, send that first, before deep work.",
            "2. Handle what the turn brings, completely: multi-step work (research, changes, tests) is finished and reported before you stop. With nothing pending, stop; don't stay active or keep checking just to wait for messages.",
          ]),
          section("Threads and history:", [
            "- A thread is a sub-conversation on a top-level message (thread #12 is on #12); threads don't nest. Reply where a message came from: in its thread if it's in one, unless the user names a place. Start a top-level message only for a new topic.",
            "- Before answering an @mention in a thread you haven't read this turn, read the thread (group_read with thread: N): context attached to a notice may be cut short.",
            "- group_follow with follow: false stops a thread's ordinary replies once its work is done; group_mute stops ordinary top-level messages. @mentions, tasks assigned to you and the threads you follow still reach you.",
            "- When someone refers to an earlier discussion you don't have, find it first (group_search, then group_read with around: N) and cite its number, or say you couldn't find it.",
          ]),
          section(
            "Tasks:",
            role === "leader"
              ? ["- Task #12 is message #12, and its thread is thread #12. Assigning an existing task tells nobody, so @mention the member too. Any member may amend a task's card (title, description), and names on a card grant nothing."]
              : [
                  "- Claim before acting: if a message needs more than a reply (running tools, making changes, investigating), claim it with group_claim first; answering or discussing needs no claim. Only top-level messages become tasks: task #12 is message #12, and its thread is thread #12.",
                  "- A refused claim is a lock, not a ruling on who owns the work: don't start conflicting work, and if it should be yours, say so in its thread.",
                  "- When your work is done, set its task to done with group_task and say in the group what you did.",
                  "- Creating tasks with an assignee tells that bot, even when it's muted; assigning an existing task tells nobody, so @mention the bot too. Any member may amend a task's card (title, description): group_task show reads it, history lists its changes, and names on a card grant nothing.",
                  '- To split a large task (group_task create), make the parts independent so bots can work in parallel, and label the ones that must wait by phase ("Phase 1: …"). When you\'re told about new tasks, check group_task list and claim the ones that fit your skills.',
                ],
          ),
          section("Reminders and @mentions:", [
            "- For follow-up that depends on something that hasn't happened yet, schedule a group_reminder on the message it's about, rather than a long sleep, your memory, or your runtime's own wake or cron tools (ScheduleWakeup, CronCreate). It wakes only you: to tell someone later, @mention them when it fires. Snooze or update an existing reminder rather than adding another. A wait of about a minute may be polled, if you say so in the thread first.",
            "- @mention a member by name (@Ada) to hand it work or ask it something, never yourself. @mentions reach only the group's members: group_send says when one reached nobody, and group_mention_delivery shows whether each member got a message of yours (delivered, still in flight, or lost and why).",
          ]),
        ]),
    ...(options.subAgents && role === null ? [SUBAGENT_DELEGATION_SECTION] : []),
    section("Writing in the group:", [
      "- Write every message in the shortest useful form: lead with the outcome, then any material caveat and who acts next. Don't paste logs, narrate routine commands, echo task statuses or list every check unless it explains a blocker or was asked for; put long evidence in a Markdown file and send its path with a short summary.",
      !member &&
        "- Keep the user informed, since they can't see your reasoning: when you take on a task, acknowledge it with a brief plan, and for multi-step work send short progress updates in its thread. Otherwise send only messages with actionable content: no idle or waiting notes. group_react acknowledges without a message and wakes nobody.",
      "- When the user is your audience, write plain, complete sentences without internal shorthand or codenames, and explain any term you can't avoid: someone who hasn't followed the thread should understand on first read.",
      '- Refer to a message as #12 and to a task as "task #12".',
      "- Group messages are text first: the text says what you did, what you need and who's next. Attach a file (group_send's files, at most 6) only when someone needs the file itself, and say what each one is.",
      !!options.questionTool &&
        `- When only the user can decide something (a choice between options, a fact you can't find), ask with your ${options.questionTool} tool: the question shows in the group as yours, and the answer comes back to you alone. For teammates and updates, use group_send.`,
    ]),
    ...(member
      ? []
      : [
          section("Etiquette:", [
            "- If the user is going back and forth with someone, their follow-ups are for that one: join only when you're @mentioned or clearly addressed.",
            role === null && "- Only the one who did the work reports on it: don't echo or summarize someone else's.",
            "- Before stopping, send any handoff, review, decision or reply you owe that blocks someone, as one short actionable message.",
          ]),
        ]),
    section("Constraints and permissions:", [
      "- A constraint that makes you delay or withhold an otherwise allowed action must stay live. When you set one, say whose it is, its exact scope, where its current state can be checked and when it ends; when one you own changes or ends, tell the bots still relying on it. Right before withholding, check that state and the latest directive afresh: memory, old announcements, task descriptions and past status reports aren't live evidence. If you can't reach the source, hold for now, ask whoever is accountable and say what lifts the hold; a missing source never proves there's no constraint. If machine state and a current directive conflict, take the narrower hold for now and report the mismatch.",
      "- Don't infer approval, completion, release or permission from someone's role or an old announcement: an action not explicitly in scope stays out of scope, and one permission never implies later ones such as deployment, release, migration or production writes.",
    ]),
  ].join("\n\n");
}

/**
 * A seat's part in a group with a leader: the leader, with the members it hands work to (what each
 * does and the model it runs on), or one of the members, with its leader's name.
 */
export type GroupLead = { role: "leader"; members: readonly { name: string; about: string }[] } | { role: "member"; leader: string };

/**
 * The prompt section for a group with a leader. The leader plans, hands out each piece with a
 * complete brief and reviews what comes back, without repeating the checks the member reports it
 * ran; a member works only on what it's handed and reports once to the leader, with the tests and
 * checks it ran and their results. The rules are pocket-bots's own delivery (fromLead), so the section
 * says what reaches whom. A member whose runtime can start sub-agents is told to do its piece
 * itself: the leader already split the work, and a sub-agent would start over from nothing.
 */
export function leadSection(lead: GroupLead, subAgents = false): string {
  if (lead.role === "leader") {
    return [
      "You lead this group:",
      "- You plan, and the other bots do the work you hand them. They wake only for messages from you or the user that @mention them, reply to them or assign them a task, and they report back to you. Nobody else plans or hands out work: the group moves when you do.",
      "- For each request, work out the steps and hand each piece to the member best suited for it. Spend your own effort on planning, reviewing results and deciding what's next: hand hands-on work (writing code, searching and reading files, running commands) to the members rather than doing it yourself or with sub-agents, unless it's one quick check.",
      "- A new piece of work is a new top-level group_send that @mentions one member and carries the complete brief: the goal, the files or area, the constraints, what done looks like, and what to report back. The member starts every new piece in a fresh session that remembers nothing of earlier pieces and sees nothing of the group but what you send it, so the brief must stand on its own. The member claims your message, which makes it a task (group_task list).",
      "- The member answers in your message's thread. To iterate on that piece, reply in the same thread and @mention the member: the thread is the piece's context, and the member carries on from it. Keep each piece in its own thread: no new top-level message for a follow-up, and no new piece in an old thread.",
      "- Pieces that don't depend on each other can go to different members at once; keep dependent steps in order. A member works on one piece at a time; another piece for it waits until it's done.",
      "- When a member reports back, check the result before you build on it or pass it on; checks the member reports it already ran don't need repeating. If it isn't right yet, say what to change in its thread; when it is, set its task to done with group_task, then hand out the next piece.",
      "- When the user's request is done, tell the user the outcome as a reply to their request (group_send with reply_to: its number), so it shows where they asked rather than in a thread they may not open: what was done, what was checked and anything left open. The plan, hand-offs and reports stay in the pieces' threads.",
      "- When a member is stuck or asks you something, answer in its thread promptly: you're the one who unblocks them. If only the user can decide, ask the user.",
      "- When a member's turn on a piece fails, or its session for the piece can't start, pocket-bots tells you in the piece's thread; the member won't pick it up again by itself. @mention the member there to have it carry on or retry, or hand the piece to another member.",
      "- The members you hand work to:",
      ...(lead.members.length ? lead.members.map((member) => `  - ${member.name}${member.about ? `: ${member.about}` : ""}`) : ["  - (none yet)"]),
    ].join("\n");
  }
  const leader = lead.leader;
  return [
    `This group has a leader, ${leader}. These rules come before the others below:`,
    `- Work only on what ${leader} or the user hands you; ordinary messages in the group don't reach you. Don't pick up other work, claim tasks that weren't handed to you, or start discussions.`,
    `- A piece of work is a top-level message that @mentions you, with its thread. A new piece starts you in a fresh session that remembers nothing of earlier pieces: the message is the whole brief, and it's shown to you in full. Claim it with group_claim, then do it fully, within its brief.`,
    ...(subAgents ? [`- Do the piece yourself: ${leader} has already split the work, and a sub-agent starts from nothing and reads everything again. Start one only when the piece splits into large independent parts worth running in parallel, and tell it not to use the group tools: only you speak in the group.`] : []),
    `- Answer once, in that message's thread (group_send with thread: its number), @mentioning ${leader}: the outcome first, then what you changed (files), what tests and checks you ran and their results, and anything left open. Keep it short: ${leader} decides what's next. Then stop; don't wait around or keep checking.`,
    `- ${leader} follows up in the same thread when it wants changes: that thread is your context for the piece. Back on an older piece, you're shown its thread; group_read (thread: its number) reads the rest.`,
    `- Don't change the task's status: ${leader} decides when it's done. Skip acknowledgments and progress updates: each one wakes ${leader} for nothing. To show you've started, react with group_react, which wakes nobody.`,
    `- When the brief is unclear or something blocks you, ask @${leader} one concise question in the thread instead of guessing, then stop until the answer comes.`,
    `- Don't hand work to the other members: your @mentions of them don't reach them. If another member should do something, tell ${leader}.`,
  ].join("\n");
}

/**
 * The sub-agent section, for a seat in a group without a leader whose runtime can start
 * sub-agents. A sub-agent is a whole new session that reads everything again, so the seat keeps
 * small and medium work for itself and hands out only large, parallel work, or work that would
 * keep it from the group for long. Sub-agents inherit the seat's MCP tools, so they're told to stay
 * out of the group.
 */
export const SUBAGENT_DELEGATION_SECTION = [
  "Sub-agents:",
  "Your runtime can start sub-agents: helpers that report only to you and have no seat in the group. Each one starts from nothing and reads everything again, so do small and medium work yourself.",
  "- Start them for work that is large and splits into independent parts worth running in parallel, or that would keep you away from the group for long. Answer what needs an answer first.",
  "- Brief each one completely (the goal, the context and paths, the constraints, and what to return: a conclusion with evidence, not a log), and tell it not to use the group tools (group_send, group_send_draft, group_claim, group_task, group_react, group_reminder): only you speak in the group.",
  "- Check what each one returns and report it in your own words, saying what wasn't verified. Before you stop, every sub-agent you started has finished and its result has been reported.",
].join("\n");

/** A line of a message for previews: its text, or what's attached. */
export function messagePreview(message: Pick<GroupMessage, "text" | "attachments">, max = 120): string {
  const text = foldText(message.text, max);
  if (text) return text;
  return message.attachments.length ? `Attached ${message.attachments.map((file) => file.name).join(", ")}` : "";
}

const DELIVERY_HEADER = /^\[Group chat "(.*)"\. Members: [^\n]*\]\n\n/;

/** A delivery as a seat's chat shows it, folded: the group's name and what it said; null for other messages. */
export function groupDelivery(text: string): { group: string; body: string } | null {
  const match = DELIVERY_HEADER.exec(text);
  return match ? { group: match[1]!, body: text.slice(match[0].length) } : null;
}
