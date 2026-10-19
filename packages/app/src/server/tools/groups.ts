import { z } from "zod";
import { BOT_FILES_MAX, BOT_TEXT_MAX, TaskStatusSchema } from "../../shared/group-chat";
import { defineTool, type ToolCaller } from "./mcp";

// A seat's tools for its group chat (see shared/group-chat.ts). Only a group's seats get these;
// the relay knows a seat by its tools address, which names the group.

/** The group a calling chat is a seat of, and the service, or an error the bot can show. */
function seatOf(caller: ToolCaller) {
  if (!caller.groupId) throw new Error("This chat isn't in a group chat.");
  if (!caller.groups) throw new Error("Group chats aren't available right now.");
  return { groupId: caller.groupId, groups: caller.groups };
}

const inGroup = (caller: ToolCaller) => !!caller.groupId;
const Seq = z.number().int().positive();

export const groupSend = defineTool({
  name: "group_send",
  description:
    "Send a message to your group chat, at the top level or in a thread. It's your only way to speak there: the user and the other bots see nothing else you write. @mention a bot by name to hand it work. Messages are text first: attach files (files) only when the reader needs the file itself, and say in the text what each one is. If messages arrived there that you haven't seen, the message is held as a draft and you're shown them to decide again.",
  input: z.object({
    text: z.string().min(1).max(BOT_TEXT_MAX).describe("The message. Short: lead with the outcome. With files, say what each one is."),
    files: z.array(z.string().min(1).max(4096)).max(BOT_FILES_MAX).optional().describe(`Files on this computer to attach (a screenshot, a report): absolute paths, or relative to your working folder; at most ${BOT_FILES_MAX}. The user sees them in the group, and the other bots get them with your message.`),
    reply_to: Seq.optional().describe("The number of the message this answers. Answering a message in a thread puts this in that thread."),
    thread: Seq.optional().describe("Post in this message's thread (a top-level message's number; a thread message's number means its thread). Starts the thread if it has none."),
    idempotency_key: z.string().max(100).optional().describe("Any unique string; resending with the same key never posts twice."),
  }),
  available: inGroup,
  async run({ text, files, reply_to, thread, idempotency_key }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.send(caller.bot, groupId, { text, replyTo: reply_to ?? null, thread: thread ?? null, idempotencyKey: idempotency_key ?? null, files: files ?? [] });
  },
});

export const groupSendDraft = defineTool({
  name: "group_send_draft",
  description:
    "Send your held draft unchanged, or drop it. A draft is kept per place (the top level, each thread) for 10 minutes; without thread, your latest draft. It's checked against new messages again, unless anyway is true (use that only when the draft was held several times and is still the right message).",
  input: z.object({
    thread: Seq.optional().describe("The thread whose draft this is; leave out for your latest draft."),
    anyway: z.boolean().optional().describe("Send without checking for new messages again."),
    discard: z.boolean().optional().describe("Drop the draft instead of sending it."),
  }),
  available: inGroup,
  async run({ thread, anyway, discard }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.sendDraft(caller.bot, groupId, { thread: thread ?? null, anyway: anyway ?? false, discard: discard ?? false });
  },
});

export const groupRead = defineTool({
  name: "group_read",
  description: [
    "Read your group chat. Each place is the top level or a thread.",
    "- unread: true alone: everything in your inbox (delivered to you and not read yet), everywhere, oldest first;",
    "- unread: true with thread: N (or top_level: true): that place's messages after your read position;",
    "- thread: N: that thread's top message and latest replies; nothing: the latest top-level messages; before: N pages back;",
    "- around: N: the messages around message N in its place (after a search hit, say).",
  ].join("\n"),
  input: z.object({
    unread: z.boolean().optional().describe("Only what you haven't read."),
    thread: Seq.optional().describe("Read this thread (its top message's number, or any message in it)."),
    top_level: z.boolean().optional().describe("Read the top level (with unread: true)."),
    before: Seq.optional().describe("Read the messages before this number."),
    around: Seq.optional().describe("Read the messages around this number, in its place."),
    limit: z.number().int().min(1).max(40).optional(),
  }),
  available: inGroup,
  async run({ unread, thread, top_level, before, around, limit }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.read(caller.bot, groupId, { unread: unread ?? false, thread: thread ?? null, topLevel: top_level ?? false, before: before ?? null, around: around ?? null, ...(limit ? { limit } : {}) });
  },
});

export const groupInbox = defineTool({
  name: "group_inbox",
  description: "List the places in your group chat with messages you haven't read, newest activity first: how many, whether they @mention you, who wrote the latest, and the group_read call that opens each. It reads nothing and marks nothing read.",
  input: z.object({ mentions: z.boolean().optional().describe("Only the places with unread messages that @mention you.") }),
  available: inGroup,
  async run({ mentions }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.inbox(caller.bot, groupId, { mentions: mentions ?? false });
  },
});

export const groupSearch = defineTool({
  name: "group_search",
  description: "Search your group chat's messages for words. Results show a preview around each match; read around a result (group_read with around) when the preview isn't enough.",
  input: z.object({ query: z.string().min(1).max(200) }),
  available: inGroup,
  async run({ query }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.search(caller.bot, groupId, query);
  },
});

export const groupFollow = defineTool({
  name: "group_follow",
  description:
    "Follow a thread so its replies reach you, stop following one whose work is done or no longer relevant (with a short reason, noted in the thread; a later @mention there brings you back), or list the threads you follow.",
  input: z.object({
    thread: Seq.optional().describe("The thread's top message, or any message in it."),
    follow: z.boolean().optional().describe("true to follow (default), false to stop."),
    reason: z.string().max(200).optional().describe("Why you stop following, shown in the thread."),
    list: z.boolean().optional().describe("List the threads you follow instead."),
  }),
  available: inGroup,
  async run({ thread, follow, reason, list }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.follow(caller.bot, groupId, { thread: thread ?? null, follow: follow ?? true, reason: reason ?? null, list: list ?? false });
  },
});

export const groupClaim = defineTool({
  name: "group_claim",
  description:
    "Claim work before doing it (running tools, changing files, researching). Give the number of the top-level message that asks for it: task #N is message #N, and a message that isn't a task yet becomes one. The first claim wins; claimed work is in_progress and yours. A refused claim is a lock: don't start the same work. Answering a question needs no claim.",
  input: z.object({ task: Seq.describe("The task's number, which is its message's number.") }),
  available: inGroup,
  async run({ task }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.claim(caller.bot, groupId, task);
  },
});

export const groupTask = defineTool({
  name: "group_task",
  description: [
    "Work with the group's tasks (todo → in_progress → in_review → done; closed means won't do). Task #N is message #N:",
    "- update: set task's status (in_review when your work is ready for the user to check; done after they approve)",
    "- create: new tasks from titles (one top-level message each); assignee hands them to a bot by name (it's told, even when muted), \"me\" starts them yourself, \"the user\"",
    "- convert: make a top-level message (task: its number) a task, todo, without claiming it",
    "- assign: give task to a bot by name, \"me\", \"the user\" or \"nobody\" (status stays; nobody is told, so @mention the bot; it claims the task to start). expected_revision (from list's rev=) refuses it if the task changed since you read it",
    "- unclaim: drop task's assignee; its status stays (refused once done)",
    "- amend: change task's card: title and/or description (acceptance criteria, say), or clear_description. Any member may; the message keeps its words, and the change goes in the task's history",
    "- show: task's current card (title, description); history: every change to task, in order",
    "- delete: take the task off its message (only the bot that made it a task; the user can too). Closing (update, closed) is usually what you want",
    "- list: tasks (filter: open (default), all, or a status; mine: only yours)",
  ].join("\n"),
  input: z.object({
    action: z.enum(["update", "create", "convert", "assign", "unclaim", "amend", "show", "history", "delete", "list"]),
    task: Seq.optional().describe("The task's number, which is its message's number (every action but create and list)."),
    status: TaskStatusSchema.optional().describe("The new status (update)."),
    titles: z.array(z.string().min(1).max(BOT_TEXT_MAX)).max(10).optional().describe("Task titles (create): independent pieces that can run in parallel."),
    assignee: z.string().max(100).optional().describe("A bot's name, \"me\", \"the user\" or \"nobody\" (create, assign). With create it applies to every title: create tasks for different owners in separate calls."),
    filter: z.string().max(20).optional().describe("open, all, todo, in_progress, in_review, done or closed (list)."),
    mine: z.boolean().optional().describe("Only tasks assigned to you (list)."),
    expected_revision: z.number().int().min(0).optional().describe("The task's rev= when you read it (assign): refused if it changed since."),
    title: z.string().min(1).max(10_000).optional().describe("The card's new title (amend)."),
    description: z.string().max(50_000).optional().describe("The card's new details or acceptance criteria (amend)."),
    clear_description: z.boolean().optional().describe("Clear the card's description (amend)."),
  }),
  available: inGroup,
  async run({ expected_revision, clear_description, ...input }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.task(caller.bot, groupId, { ...input, expectedRevision: expected_revision ?? null, clearDescription: clear_description ?? false });
  },
});

export const groupMentionDelivery = defineTool({
  name: "group_mention_delivery",
  description:
    "What happened to each member a message you sent @mentioned: delivered (its model read it), still in flight (in its inbox; don't conclude yet), lost and why (rate or quota limited, its runtime failed, it wasn't running, or it left; re-route or retry later), or unknown. Then who else the message reached, and who didn't get it.",
  input: z.object({ message: Seq.describe("The number of a message you sent.") }),
  available: inGroup,
  async run({ message }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.mentionDelivery(caller.bot, groupId, message);
  },
});

export const groupReact = defineTool({
  name: "group_react",
  description: "React to a message with an emoji: a quick acknowledgment that wakes nobody, instead of a message.",
  input: z.object({ message: Seq, emoji: z.string().min(1).max(16).default("👍") }),
  available: inGroup,
  async run({ message, emoji }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.react(caller.bot, groupId, message, emoji);
  },
});

export const groupMute = defineTool({
  name: "group_mute",
  description: "Stop ordinary top-level messages from reaching you (an @mention, a task assigned to you and the threads you follow still do), or unmute.",
  input: z.object({ muted: z.boolean().default(true) }),
  available: inGroup,
  async run({ muted }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.mute(caller.bot, groupId, muted);
  },
});

export const groupReminder = defineTool({
  name: "group_reminder",
  description: [
    "Your own reminders: wake yourself up later about a message in the group (a follow-up, a check on something that hasn't happened yet). When one fires, only you are told; to tell someone else, @mention them then. Ids are the 8 characters after # in list.",
    "- schedule: title, message (the number it's about), and delay_seconds (preferred for relative times) or fire_at (ISO-8601 UTC, for calendar times); repeat makes it recurring (every:15m | every:2h | every:1d | daily@09:00 | weekly:mon,fri@09:00, in tz or this computer's time zone)",
    "- list: your scheduled and fired reminders (all: canceled too)",
    "- snooze: id, by (30m, 2h, 1d): fire again that long from now (a fired one is scheduled again)",
    "- update: id and exactly one of title, fire_at, in (a duration from now) or repeat; only a scheduled reminder",
    "- cancel: id; log: id, its history",
    "Change an existing reminder instead of scheduling a duplicate.",
  ].join("\n"),
  input: z.object({
    action: z.enum(["schedule", "list", "snooze", "update", "cancel", "log"]),
    id: z.string().max(64).optional().describe("The reminder's id or its first characters (snooze, update, cancel, log)."),
    title: z.string().max(500).optional().describe("What it's about (schedule, update)."),
    message: Seq.optional().describe("The number of the message it's about (schedule)."),
    delay_seconds: z.number().int().positive().optional().describe("Fire this many seconds from now (schedule)."),
    fire_at: z.string().max(40).optional().describe("Fire at this ISO-8601 UTC time, e.g. 2026-04-21T09:00:00Z (schedule, update)."),
    repeat: z.string().max(60).optional().describe("A repeat rule (schedule, update)."),
    tz: z.string().max(60).optional().describe("IANA time zone for a daily or weekly repeat, e.g. Asia/Shanghai."),
    by: z.string().max(20).optional().describe("How long to snooze: 30m, 2h, 1d."),
    in: z.string().max(20).optional().describe("New fire time as a duration from now (update)."),
    all: z.boolean().optional().describe("Include canceled reminders (list)."),
  }),
  available: inGroup,
  async run({ delay_seconds, fire_at, ...input }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.reminder(caller.bot, groupId, { ...input, delaySeconds: delay_seconds ?? null, fireAt: fire_at ?? null });
  },
});

export const groupMembers = defineTool({
  name: "group_members",
  description: "Who is in your group chat: each bot's role, whether it's working, muted, and what it has claimed.",
  input: z.object({}),
  available: inGroup,
  async run(_args, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.membersText(caller.bot, groupId);
  },
});
