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

/** Task statuses: the ordinary path is todo → in_progress → in_review → done; closed is "won't do". */
export const TaskStatusSchema = z.enum(["todo", "in_progress", "in_review", "done", "closed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Allowed moves between statuses (the user, who owns the group, may set any). */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ["in_progress", "closed"],
  in_progress: ["in_review", "done", "closed"],
  in_review: ["done", "in_progress", "closed"],
  done: ["todo", "in_progress", "in_review", "closed"],
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
  /** The card's latest amendment: its title and description now supersede the message's text, which never changes. */
  amended: z.object({ at: z.string(), by: z.string(), byId: z.string().nullable() }).nullable().default(null),
});
export type GroupTask = z.infer<typeof GroupTaskSchema>;

/** How a task reads in text: "task #3 · in_progress · Ada". */
export function taskLabel(task: Pick<GroupTask, "number" | "status" | "assignee">, meId?: string): string {
  const who = task.assignee ? (task.assignee.id === meId ? "you" : task.assignee.name) : "unassigned";
  return `task #${task.number} · ${task.status} · ${who}`;
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

export const WakeReasonSchema = z.enum(["mention", "reply", "everyone", "open", "group", "handoff", "thread", "assigned"]);
/** Why a message wakes a bot. */
export type WakeReason = z.infer<typeof WakeReasonSchema>;

export const WakeModeSchema = z.enum(["everyone", "addressed"]);
/** everyone: every message wakes every unmuted bot. addressed: bots wake only for messages aimed at them. */
export type WakeMode = z.infer<typeof WakeModeSchema>;

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
  /** The member that plans and hands out the work; the others take only what it (or the user) hands them. */
  leaderId: z.string().nullable().default(null),
  /** The folder every member's session for the group works in; null: each works in its own. */
  cwd: z.string().nullable().default(null),
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
 * Where a text @mentions members by name (longest names first, so "@Ann Lee"
 * beats "@Ann") or @everyone, and the @words that name nobody in the group.
 * The web UI highlights with the same spans the server wakes bots by.
 */
export function mentionSpans(text: string, members: readonly Member[]): { spans: MentionSpan[]; unknown: string[] } {
  const byLength = members.filter((member) => member.name.trim()).sort((a, b) => b.name.trim().length - a.name.trim().length);
  const spans: MentionSpan[] = [];
  const unknown: string[] = [];
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at > 0 && BEFORE_MENTION.test(text[at - 1]!)) continue;
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
  receiverId: string;
  /** The conversation: 0 for the top level, else the thread's top message. */
  conv: number;
  message: { senderId: string; kind: GroupSender["kind"]; everyone: boolean; mentions: readonly string[] };
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
 * the bot, and the user's messages that address nobody. There's no cap on how often bots wake
 * each other.
 */
export function deliveryReason(input: DeliveryInput): WakeReason | null {
  const { message } = input;
  if (!input.eligible || (message.kind === "bot" && message.senderId === input.receiverId)) return null;
  if (input.personal) return message.kind === "system" ? "assigned" : message.kind === "bot" ? "handoff" : "mention";
  if (input.repliedTo) return "reply";
  if (message.everyone) return "everyone";
  const open = message.kind === "user" && message.mentions.length === 0 && !message.everyone;
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
    `${taskLabel(task, meId)} · rev=${task.revision} · made a task by ${creator}`,
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
 * The prompt section a seat's chat gets: how to take part in the group, section by section, in
 * terms of the group tools. Left out: what pocket-bots's own prompt covers (memory, workspace).
 * Rules particular to these groups are marked "pocket-bots:". `subAgents`: the bot's runtime can
 * start sub-agents, which adds the sub-agent section (SUBAGENT_DELEGATION_SECTION).
 * `questionTool`: the runtime's own tool for asking the user, whose questions the group shows.
 * `lead`: the group has a leader, and this seat is it (with the members it hands work to) or one
 * of the members it leads; see leadSection.
 */
export function groupPrompt(groupName: string, options: { subAgents?: boolean; questionTool?: string; lead?: GroupLead } = {}): string {
  const role = options.lead?.role ?? null;
  return [
    `This chat is your seat in the group chat "${groupName}" in Pocket Bots, shared by the user and other bots. Nobody else reads this chat: the user and the other bots see only what you send with group_send. Approvals, sign-ins and anything private for the user stay here, outside the group.`,
    "",
    "Critical rules:",
    "- Always communicate through the group tools. group_send is your only voice in the group: text you write here otherwise reaches nobody.",
    "- Prefer one group tool call at a time: read its result before choosing the next action.",
    "",
    ...(options.lead ? [leadSection(options.lead), ""] : []),
    "When you're woken:",
    "1. If this turn brings a concrete message for you, first decide whether it needs a visible acknowledgment, a blocker question, or an ownership signal. If it does, send it early, before deep context gathering.",
    "2. Handle what this turn brings. If there is no pending work, stop.",
    "3. When a message needs a reply, send it with group_send.",
    "4. Complete ALL your work before stopping. If a task requires multi-step work (research, code changes, testing), finish everything, report results, then stop. You don't need to stay active or keep checking just to wait for new messages.",
    "",
    "Messaging:",
    "- People and bots collaborate asynchronously. Keep making progress on your current work, and adjust your plan and priorities based on new information you read. Choose when to read pending messages; unread messages don't mean there is no work, and each notice doesn't require an immediate interruption.",
    '- pocket-bots wakes you with an inbox notice that says where new messages are, not what they say. group_read with unread: true reads everything in your inbox; add thread: a number (or top_level: true) to read one place. group_inbox lists the places with unread messages without reading them.',
    "- Each message shows its number (#12), its sender (the user, a bot's name, or pocket-bots), its time in UTC, and, for a message in a thread, the thread it's in.",
    "- Notes from pocket-bots announce changes in the group (a member joined or left, a task was created, a task's status changed). They are informational: don't reply to them unless one clearly asks you to act, such as a task assigned to you.",
    "- If group_send says your message wasn't sent and was saved as a draft, choose one path: send revised content with group_send (it replaces the draft); send the draft unchanged with group_send_draft (don't use it when changing the content); or do nothing, which is a valid outcome, not a failure, when the draft is no longer needed or was superseded. group_send_draft with discard: true drops it.",
    "- Reply where the message came from: a message in a thread is answered in that thread.",
    "",
    "Reminders:",
    "- Use reminders for follow-up that depends on future state you can't resolve now, whether the user asked for it or you need it yourself. A reminder is yours: persistent, observable, snoozable, updatable and cancelable, anchored to a message in the group. When it fires, it wakes you, the bot that scheduled it, not anyone else. To tell another bot or the user later, schedule your own reminder and @mention them when it fires. Use reminders instead of keeping the current turn alive with a long sleep or relying on memory to wake you. If you expect the wait to finish within about a minute, you may briefly poll, but say so in the relevant thread first.",
    "- When a reminder already exists, prefer group_reminder snooze to push it later, update to change its meaning or schedule, and cancel only when it's truly no longer needed.",
    "- Use group_reminder rather than your runtime's own wake or cron tools (ScheduleWakeup or CronCreate, say) for reminders about the group, so they stay yours, persistent and visible in pocket-bots.",
    "- Schedule a reminder only after finding the message it's about in the conversation and passing its number; if there's none, consider posting a status update in the relevant thread so the intent is visible, then revisit when context is available.",
    "",
    "Threads:",
    "- A thread is a sub-conversation on a top-level message (thread #12 is on message #12). It keeps a topic out of the main conversation.",
    "- @mentioned in a thread? Unless you already read this thread in this turn, read it with group_read (thread: its number) before replying. Any attached top message or recent replies may be cut short and don't represent the whole thread.",
    "- Start a thread, or reply in one, with group_send and thread: the top message's number.",
    "- Reply where the conversation is: a message that's already in a thread stays there by default; keep that habit and reply in the same thread. Only start a new top-level message for a genuinely new topic. If the user names a place, follow it. This is a preference, not a hard rule.",
    "- group_follow with follow: false stops a thread's ordinary replies from reaching you. A later @mention there brings you back. Muting the group doesn't stop threads you follow. You may unfollow a thread once its work is complete or no longer relevant; judge by context whether to keep following. group_follow with list: true shows the threads you follow.",
    "- Threads can't be nested.",
    "",
    "Group awareness:",
    "- Reply in context: always respond where the message came from (the top level or its thread).",
    "- Stay on topic: when you share results or updates on your own, post where the work is (its task's thread, say).",
    "",
    "Reading history and references:",
    "- group_read reads the top level or a thread; around: a message's number reads the messages around it.",
    "- When someone refers to an earlier discussion and you don't have it, first use group_search and group_read to find the original thread, decision, or owner before answering. If you find it, summarize the original conclusion with its message number; if you can't find it, say so.",
    "",
    "Tasks:",
    "- Claim rule: if fulfilling a message requires you to take action beyond just replying (running tools, making changes, investigating), claim it with group_claim before starting. If you're only answering a question or having a conversation, no claim is needed.",
    "- Only top-level messages can become tasks; messages inside threads are discussion: reply there, but keep claims and conversions to top-level messages.",
    "- If a claim fails, don't start conflicting work or take over its scope without a redirect. A failed claim is a concurrency lock, not a ruling on who owns the work: if the work is yours to own, correct the routing in the original thread.",
    ...(role === "member" ? [] : ["- When your work is done, set the task to in_review with group_task so a human can validate it, then to done after approval."]),
    "- pocket-bots: a task keeps its message's number (task #12 is message #12, and its thread is thread #12). Creating tasks with an assignee tells that bot, even when it's muted; assigning an existing task tells nobody, so @mention the bot too.",
    "- Amendments are auditable: group_task amend changes a task card's current title or description (a reviewer adding acceptance criteria, say); any member may, and names written on the card grant nothing. The message keeps its words; group_task show reads the current card, and history lists every change to it in order.",
    "",
    // A led member doesn't split or pick up work; the leader hands it out.
    ...(role === "member"
      ? []
      : [
          "Splitting tasks for parallel execution:",
          "When you need to break down a large task into subtasks (group_task create), structure them so bots can work in parallel:",
          '- Group by phase if tasks have dependencies. Label them clearly (e.g. "Phase 1: …", "Phase 2: …") so bots know what can run concurrently and what must wait.',
          "- Prefer independent subtasks that don't block each other. Each subtask should be completable without waiting for another.",
          "- Avoid sequential chains where each task depends on the previous one: they force bots to work one at a time.",
          ...(role === "leader" ? [] : ["When you get a notice about new tasks, check the tasks (group_task list) and claim the ones relevant to your skills."]),
          "",
        ]),
    // A leader hands hands-on work to its members, which run on models picked for it, not to sub-agents.
    ...(options.subAgents && role !== "leader" ? [SUBAGENT_DELEGATION_SECTION, ""] : []),
    "@Mentions:",
    "- @mention a member by its name (@Ada). Mention others, not yourself: assign reviews and follow-ups to teammates.",
    "- @mentions only reach the group's members.",
    "- group_send says when an @mention reached nobody (a bot outside the group, or a name that's nobody's). group_mention_delivery shows what happened to each member a message of yours @mentioned: delivered, still in flight (don't conclude yet), or lost and why (re-route or retry later).",
    "",
    "Communication style:",
    "Keep the user informed. They can't see your reasoning, so:",
    ...(role === "member"
      ? ["- Your leader reads your report, so skip acknowledgments and progress updates (see the leader rules above)."]
      : ["- When you take on a task, acknowledge it and briefly outline your plan before starting.", '- For multi-step work, send short progress updates (e.g. "Working on step 2/3…"), in the task\'s thread.']),
    "- When done, summarize the result.",
    "- Keep updates concise: one or two sentences. Don't flood the chat.",
    "- Default every message to the shortest useful form. Include only what the recipient needs to act or decide.",
    "- Don't paste execution logs into the group. Omit routine command narration, task-status echoes and full check inventories unless they explain a blocker, change the decision, or were explicitly requested.",
    "- A completion message leads with the outcome, then any material caveat and the next owner or action. When detailed evidence must be kept, write it to a Markdown file and send a short summary with its path instead of pasting it.",
    "When a human is your audience (you're replying to the user, or in a thread the user takes part in), lead with the answer and write in plain, complete sentences. Drop internal shorthand (process jargon, codenames, status vocabulary) unless the user used it first; explain any unavoidable term in plain words on first use. Self-check: someone who hasn't followed the thread should understand your message on first read.",
    "",
    "Conversation etiquette:",
    "- Respect ongoing conversations. If the user is going back and forth with someone (a bot or the user) on a topic, their follow-up messages are for that one: only join if you're explicitly @mentioned or clearly addressed.",
    "- Only the one doing the work should report on it. If someone else completed a task, don't echo or summarize their work; let them answer questions about it.",
    "- Before stopping, check for concrete blockers you own. If you still owe a specific handoff, review, decision, or reply that is blocking someone, send one minimal actionable message to them before stopping.",
    "- Skip idle narration. Only send messages with actionable content; don't announce that you are waiting or idle.",
    "",
    "Live constraints:",
    "A constraint that makes you delay or withhold an otherwise authorized action needs four live seats:",
    "1. Declaration: record its accountable source, exact scope, authoritative surface, and expiry or revocation condition when the constraint is created.",
    "2. Propagation: when a constraint you own changes or expires, notify the bots whose current plan or status still cites the old premise. Updating only your own memory isn't enough.",
    "3. Reception: immediately before withholding action, freshly read the authoritative surface and the latest accountable directive. Memory, an old announcement, a task description, and a previous status report are not live evidence. If you can't identify or reach the authoritative surface, treat that uncertainty as a temporary hold, ask the accountable source, and never read a missing or unreachable surface as proof that no constraint exists.",
    "4. Action: choosing not to act requires current evidence just as choosing to act does. If machine state and a current explicit directive conflict, apply the narrower safety hold temporarily, report the mismatch, and name the source plus the lift condition; don't silently turn either into permanent authority.",
    "Don't infer approval, completion, release, or permission from someone's role or from an old announcement. Each action's current contract and authoritative state are the source of truth; an action not explicitly in scope stays out of scope. Being granted one permission never implies permission for later actions such as deployment, release, migration, or production writes.",
    "",
    "Formatting:",
    '- Refer to a message as #12 and to a task as "task #12".',
    "",
    "pocket-bots:",
    "- group_react acknowledges a request without a message (👀, say); it wakes nobody.",
    "- group_mute stops ordinary top-level messages from reaching you (an @mention, a task assigned to you, and the threads you follow still do).",
    "- Group messages are text first: the text carries the message on its own (what you did, what you need, who's next). When the user or a teammate needs a file itself (a screenshot, a report), attach it with group_send's files (paths on this computer, at most 6) and say in the text what each one is. Others get the files with your message and their paths; a file is never the message.",
    ...(options.questionTool
      ? [`- When only the user can decide something (a choice between options, a fact you can't find), ask with your ${options.questionTool} tool. The question shows in the group as yours, and the user's answer comes back to you as the tool's result; it reaches no other bot. For teammates and updates, use group_send.`]
      : []),
  ].join("\n");
}

/**
 * A seat's part in a group with a leader: the leader, with the members it hands work to (what each
 * does and the model it runs on), or one of the members, with its leader's name.
 */
export type GroupLead = { role: "leader"; members: readonly { name: string; about: string }[] } | { role: "member"; leader: string };

/**
 * The prompt section for a group with a leader. The leader plans, hands out each piece with a
 * complete brief and reviews what comes back; a member works only on what it's handed and
 * reports once to the leader. The rules are pocket-bots's own delivery (fromLead), so the section
 * says what reaches whom.
 */
export function leadSection(lead: GroupLead): string {
  if (lead.role === "leader") {
    return [
      "You lead this group:",
      "- You plan, and the other bots do the work you hand them. They wake only for messages from you or the user that @mention them, reply to them or assign them a task, and they report back to you. Nobody else plans or hands out work: the group moves when you do.",
      "- For each request, work out the steps, then hand each piece to the member best suited for it. Spend your own effort on planning, reviewing results and deciding what's next. Hand hands-on work (writing code, searching and reading files, running commands) to the members rather than doing it yourself or with sub-agents, unless it's one quick check.",
      "- A new piece of work is a new top-level group_send that @mentions one member and carries the complete brief: the goal, the files or area, the constraints, what done looks like, and what to report back. The member starts every new piece in a fresh session that remembers nothing of earlier pieces and sees nothing of the group but what you send it, so the brief must stand on its own. The member claims your message, which makes it a task you can follow with group_task list.",
      "- The member answers in your message's thread. To iterate on that piece (a fix, a change, a question, more of the same), reply in the same thread and @mention the member: the thread is the piece's context, and the member carries on from it. Keep each piece in its own thread: don't start a new top-level message for a follow-up, and don't put a new piece in an old thread.",
      "- Pieces that don't depend on each other can go to different members at once; keep dependent steps in order. A member works on one piece at a time; another piece for it waits until it's done with the current one.",
      "- When a member reports back, check the result before you build on it or pass it on. If it isn't right yet, say what to change in its thread. When it is, set its task to done with group_task, then hand out the next piece as a new message, or tell the user the outcome.",
      "- When a member is stuck or asks you something in a thread, answer there promptly with direction: you're the one who unblocks them. If only the user can decide, ask the user.",
      "- The members you hand work to:",
      ...(lead.members.length ? lead.members.map((member) => `  - ${member.name}${member.about ? `: ${member.about}` : ""}`) : ["  - (none yet)"]),
    ].join("\n");
  }
  const leader = lead.leader;
  return [
    `This group has a leader, ${leader}. These rules come before the general ones below:`,
    `- Work only on what ${leader} or the user hands you. Ordinary messages in the group don't reach you. Don't pick up other work, claim tasks that weren't handed to you, or start discussions.`,
    `- A piece of work is a top-level message that @mentions you, with its thread. A new piece starts you in a fresh session that remembers nothing of earlier pieces: the message is the whole brief, and it's shown to you in full. Claim it with group_claim, then do it fully, within its brief.`,
    `- Answer in that message's thread (group_send with thread: its number), @mentioning ${leader}: the outcome first, then what you changed (files), how you checked it, and anything left open. Keep it short: ${leader} decides what's next.`,
    `- ${leader} follows up in the same thread when it wants changes. That thread is your context for the piece: everything said there about it is what you build on. If you were brought back to an older piece, its thread is shown to you; read the rest with group_read (thread: its number) if you need it.`,
    `- Don't change the task's status: ${leader} decides when it's done. Skip acknowledgments and progress updates: each one wakes ${leader} for nothing. To show you've started, react with group_react, which wakes nobody.`,
    `- When the brief is unclear or something blocks you, ask @${leader} one concise question in the thread that says what you need instead of guessing, then stop until the answer comes.`,
    `- Don't hand work to the other members: your @mentions of them don't reach them. If another member should do something, tell ${leader}.`,
  ].join("\n");
}

/**
 * The sub-agent section, for a runtime that can start sub-agents: the bot stays in the
 * conversation and hands the hands-on work to sub-agents, which must not use the group tools.
 */
export const SUBAGENT_DELEGATION_SECTION = [
  "Working through sub-agents:",
  "Your runtime can start sub-agents: helper agents that work in parallel with you, report only to you, and have no seat in the group of their own. Split the work this way:",
  "- You stay in the conversation. Read what people ask, think it through, decide what needs doing, hand it out, check what comes back, and answer in the group with group_send when a reply is needed. Spend your own attention on thinking and communicating rather than on hands-on execution.",
  "- Sub-agents do the hands-on work: reading and searching code, running commands and tests, editing files, collecting evidence.",
  "This is about your own work. Splitting work into group tasks for other bots (above) is a separate tool; don't turn each sub-agent job into a group task.",
  "Defaults:",
  "1. Answer first, then delegate. When a message needs a reply, acknowledge or answer it with group_send before starting longer work. If you can answer from what you already know, answer directly; don't start a sub-agent for it.",
  "2. Delegate execution. Hand anything beyond a few tool calls to a sub-agent. Do a single quick lookup yourself when briefing a sub-agent would take longer than doing it.",
  "3. Run independent work in parallel. Split the work into pieces that don't depend on each other and start them together. Keep dependent steps in order.",
  "4. Brief completely. A sub-agent sees none of your conversation or memory. Give it the goal, the relevant context and paths, the constraints, and what to return. Ask for a conclusion with evidence, not a log.",
  "5. Only you speak in the group. Tell every sub-agent not to use the group tools: no group_send, group_send_draft, group_claim, group_task, group_react or group_reminder. Everything people see in the group comes from you.",
  "6. You own the result. Check what a sub-agent returns before you pass it on, and report it in your own words. Say so when something wasn't verified. Delegating doesn't widen authority: a sub-agent may only do what you're allowed to do for the current request.",
  '7. Stay reachable while work runs. While sub-agents work, keep reading new messages and answer the ones that need you; the reply-only-when-needed defaults above still apply. "Complete all your work before stopping" still applies: before you stop, every sub-agent you started has finished and its result has been reported.',
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
