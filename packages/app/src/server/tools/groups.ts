import { z } from "zod";
import { BOT_FILES_MAX, BOT_TEXT_MAX, GROUP_TASK_DESCRIPTION_MAX, GROUP_TASK_TITLE_MAX, NOTE_BODY_MAX, NOTE_KINDS, NOTE_REFS_MAX, NOTE_SEARCH_K, NOTE_TITLE_MAX, NOTE_VISIT_MAX, TaskStatusSchema } from "../../shared/group-chat";
import { defineTool, type ToolCaller } from "./mcp";

// A seat's tools for its group chat (see shared/group-chat.ts). Only a group's seats get these;
// the relay knows a seat by its tools address, which names the group. Every listed tool costs
// tokens on each of a seat's requests, so descriptions say what a call does and leave the rules
// for when to make it to the seat's prompt (groupPrompt). A member of a group with a leader is
// listed only the tools marked `led`: reading, claiming, reacting and reporting.

/** The group a calling chat is a seat of, and the service, or an error the bot can show. */
function seatOf(caller: ToolCaller) {
  if (!caller.groupId) throw new Error("This chat isn't in a group chat.");
  if (!caller.groups) throw new Error("Group chats aren't available right now.");
  return { groupId: caller.groupId, groups: caller.groups };
}

/** The group opted into the board (and has no leader). */
const onBoard = (caller: ToolCaller): boolean => !!caller.groupId && !!caller.groups?.boardEnabled(caller.groupId);

const inGroup = (caller: ToolCaller) => !!caller.groupId;
const Seq = z.number().int().positive();

export const groupSend = defineTool({
  name: "group_send",
  description:
    "Post to your group chat, at the top level or in a thread: your only voice there, since the user and the other bots see nothing else you write. @Name mentions a member. If messages arrived there that you haven't seen, the post is held as a draft and you're shown them.",
  input: z.object({
    text: z.string().min(1).max(BOT_TEXT_MAX).describe("The message: short, outcome first. Say what each attached file is."),
    files: z.array(z.string().min(1).max(4096)).max(BOT_FILES_MAX).optional().describe("Files to attach when the reader needs the file itself: absolute paths, or relative to your working folder."),
    reply_to: Seq.optional().describe("The message this answers; answering one in a thread posts in that thread."),
    thread: Seq.optional().describe("Post in this message's thread (starts it if it has none)."),
    idempotency_key: z.string().max(100).optional().describe("Any unique string: a resend with the same key never posts twice."),
  }),
  available: inGroup,
  led: true,
  async run({ text, files, reply_to, thread, idempotency_key }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.send(caller.bot, groupId, { text, replyTo: reply_to ?? null, thread: thread ?? null, idempotencyKey: idempotency_key ?? null, files: files ?? [] });
  },
});

export const groupSendDraft = defineTool({
  name: "group_send_draft",
  description: "Send your held draft unchanged (it's checked for new messages again), or drop it. Drafts last 10 minutes, one per place.",
  input: z.object({
    thread: Seq.optional().describe("The thread whose draft this is; left out, your latest draft."),
    anyway: z.boolean().optional().describe("Skip the check: only when the draft was held several times and is still right."),
    discard: z.boolean().optional().describe("Drop the draft instead."),
  }),
  available: inGroup,
  led: true,
  async run({ thread, anyway, discard }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.sendDraft(caller.bot, groupId, { thread: thread ?? null, anyway: anyway ?? false, discard: discard ?? false });
  },
});

export const groupRead = defineTool({
  name: "group_read",
  description:
    "Read your group chat. unread: true reads your whole inbox (with thread or top_level, one place's unread); thread: N reads a thread; nothing reads the latest top-level messages; before: N pages back; around: N reads around message N; full: N reads one message in full (a lookup: it doesn't move your read position). A page is bounded; truncated messages point at full: N.",
  input: z.object({
    unread: z.boolean().optional(),
    thread: Seq.optional().describe("A thread's top message, or any message in it."),
    top_level: z.boolean().optional(),
    before: Seq.optional(),
    around: Seq.optional(),
    full: Seq.optional().describe("One message's full text, up to 20,000 characters; doesn't change what you've read."),
    limit: z.number().int().min(1).max(40).optional(),
  }),
  available: inGroup,
  led: true,
  async run({ unread, thread, top_level, before, around, full, limit }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.read(caller.bot, groupId, { unread: unread ?? false, thread: thread ?? null, topLevel: top_level ?? false, before: before ?? null, around: around ?? null, full: full ?? null, ...(limit ? { limit } : {}) });
  },
});

export const groupInbox = defineTool({
  name: "group_inbox",
  description: "List the places with messages you haven't read (how many, @mentions of you, who wrote last) without reading them.",
  input: z.object({ mentions: z.boolean().optional().describe("Only places that @mention you.") }),
  available: inGroup,
  async run({ mentions }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.inbox(caller.bot, groupId, { mentions: mentions ?? false });
  },
});

export const groupSearch = defineTool({
  name: "group_search",
  description: "Search the group's messages for words. Results are previews: group_read around a hit for more.",
  input: z.object({ query: z.string().min(1).max(200) }),
  available: inGroup,
  async run({ query }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.search(caller.bot, groupId, query);
  },
});

export const groupFollow = defineTool({
  name: "group_follow",
  description: "Follow a thread so its replies reach you, stop following one (with a short reason, noted there; a later @mention brings you back), or list the ones you follow.",
  input: z.object({
    thread: Seq.optional(),
    follow: z.boolean().optional().describe("false to stop following."),
    reason: z.string().max(200).optional(),
    list: z.boolean().optional(),
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
    "Claim work before doing it: give the number of the top-level message that asks for it (task #N is message #N; a message that isn't a task yet becomes one). The first claim wins and the work is yours, in_progress. A refused claim is a lock: don't start that work.",
  input: z.object({ task: Seq }),
  available: inGroup,
  led: true,
  async run({ task }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.claim(caller.bot, groupId, task);
  },
});

export const groupTask = defineTool({
  name: "group_task",
  description: [
    "The group's tasks (todo → in_progress → done; closed: won't do). Task #N is message #N.",
    "- update: set task's status",
    "- create: tasks from titles, one top-level message each; assignee (a bot, \"me\" or \"the user\") is told, even when muted",
    "- convert: make top-level message task a todo task, without claiming it",
    "- assign: to a bot, \"me\", \"the user\" or \"nobody\"; status stays and nobody is told (@mention them). expected_revision (list's rev=) refuses it if the task changed since",
    "- unclaim: drop task's assignee, status stays",
    "- amend: change the card's title or description (or clear_description); any member may, and it's kept in history",
    "- show: the card; history: every change to task",
    "- delete: take the task off its message (only its creator; closing is usually better)",
    "- list: filter (open by default, all, or a status); mine: only yours",
  ].join("\n"),
  input: z.object({
    action: z.enum(["update", "create", "convert", "assign", "unclaim", "amend", "show", "history", "delete", "list"]),
    task: Seq.optional(),
    status: TaskStatusSchema.optional(),
    titles: z.array(z.string().min(1).max(GROUP_TASK_TITLE_MAX)).max(10).optional().describe("Independent pieces that can run in parallel."),
    assignee: z.string().max(100).optional().describe("With create, for every title: tasks for different owners go in separate calls."),
    filter: z.string().max(20).optional(),
    mine: z.boolean().optional(),
    expected_revision: z.number().int().min(0).optional(),
    title: z.string().min(1).max(GROUP_TASK_TITLE_MAX).optional(),
    description: z.string().max(GROUP_TASK_DESCRIPTION_MAX).optional(),
    clear_description: z.boolean().optional(),
  }),
  available: inGroup,
  async run({ expected_revision, clear_description, ...input }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.task(caller.bot, groupId, { ...input, expectedRevision: expected_revision ?? null, clearDescription: clear_description ?? false });
  },
});

export const groupMentionDelivery = defineTool({
  name: "group_mention_delivery",
  description: "For a message you sent: whether each member it @mentioned got it (delivered, still in flight, or lost and why), and who else it reached.",
  input: z.object({ message: Seq }),
  available: inGroup,
  async run({ message }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.mentionDelivery(caller.bot, groupId, message);
  },
});

export const groupReact = defineTool({
  name: "group_react",
  description: "React to a message with an emoji: an acknowledgment that wakes nobody.",
  input: z.object({ message: Seq, emoji: z.string().min(1).max(16).default("👍") }),
  available: inGroup,
  led: true,
  async run({ message, emoji }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.react(caller.bot, groupId, message, emoji);
  },
});

export const groupMute = defineTool({
  name: "group_mute",
  description: "Stop ordinary top-level messages from reaching you, or unmute (muted: false).",
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
    "Your own reminders about a message in the group: when one fires, only you are woken. Ids are the characters after # in list.",
    "- schedule: title, message, and delay_seconds or fire_at (ISO-8601 UTC); repeat: every:15m | every:2h | every:1d | daily@09:00 | weekly:mon,fri@09:00 (in tz, or this computer's time zone)",
    "- list (all: with canceled ones); snooze: id, by (30m, 2h, 1d); update: id and one of title, fire_at, in (a duration from now) or repeat; cancel: id; log: id",
  ].join("\n"),
  input: z.object({
    action: z.enum(["schedule", "list", "snooze", "update", "cancel", "log"]),
    id: z.string().max(64).optional(),
    title: z.string().max(500).optional(),
    message: Seq.optional(),
    delay_seconds: z.number().int().positive().optional(),
    fire_at: z.string().max(40).optional(),
    repeat: z.string().max(60).optional(),
    tz: z.string().max(60).optional().describe("IANA time zone, e.g. Asia/Shanghai."),
    by: z.string().max(20).optional(),
    in: z.string().max(20).optional(),
    all: z.boolean().optional(),
  }),
  available: inGroup,
  async run({ delay_seconds, fire_at, ...input }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.reminder(caller.bot, groupId, { ...input, delaySeconds: delay_seconds ?? null, fireAt: fire_at ?? null });
  },
});

export const groupNote = defineTool({
  name: "group_note",
  description: [
    "Publish a reusable note on the group's board. It wakes nobody; the next wake can list it.",
    "title: what someone would search for. body: the finding, decision, dead end or answer, and why it matters.",
    "refs: what it builds on, {message: 12} or {note: 3}; the body must name every ref ('#12', 'note #3').",
    "kind: finding | decision | dead_end | answer | plan | review. supersedes: replace an older note without editing it.",
    "Use this instead of announcing the same thing in chat.",
  ].join("\n"),
  input: z.object({
    kind: z.enum(NOTE_KINDS),
    title: z.string().min(1).max(NOTE_TITLE_MAX),
    body: z.string().min(1).max(NOTE_BODY_MAX),
    refs: z.array(z.object({ note: Seq.optional(), message: Seq.optional() })).max(NOTE_REFS_MAX).optional(),
    task: Seq.optional().describe("The task this note is about, if any."),
    thread: Seq.optional().describe("The thread this note is about, if any."),
    supersedes: Seq.optional().describe("An older note this one replaces."),
  }),
  available: onBoard,
  led: true,
  async run({ refs, ...input }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.publishNote(caller.bot, groupId, { ...input, ...(refs ? { refs } : {}) });
  },
});

export const groupNoteSearch = defineTool({
  name: "group_note_search",
  description: "Search the group's board before starting work: up to 8 relevant notes, ranked by match and by how often other notes build on them. Read one with group_note_visit.",
  input: z.object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(NOTE_SEARCH_K).optional(),
  }),
  available: onBoard,
  led: true,
  async run({ query, limit }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.searchNotes(caller.bot, groupId, { query, ...(limit ? { limit } : {}) });
  },
});

export const groupNoteVisit = defineTool({
  name: "group_note_visit",
  description: "Read up to 8 board notes in full, with their refs and the notes that cite them. All-or-nothing: one missing id returns nothing.",
  input: z.object({ notes: z.array(Seq).min(1).max(NOTE_VISIT_MAX) }),
  available: onBoard,
  led: true,
  async run({ notes }, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.visitNotes(caller.bot, groupId, { notes });
  },
});

export const groupMembers = defineTool({
  name: "group_members",
  description: "Who is in your group chat: each bot's role, whether it's working, muted, and what it has claimed.",
  input: z.object({}),
  available: inGroup,
  led: true,
  async run(_args, caller) {
    const { groupId, groups } = seatOf(caller);
    return groups.membersText(caller.bot, groupId);
  },
});
