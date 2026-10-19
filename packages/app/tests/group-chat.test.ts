import { describe, expect, it } from "vitest";
import {
  defaultGroupName,
  deliveryFailureOf,
  deliveryReason,
  groupDelivery,
  groupPrompt,
  groupQuestion,
  heldText,
  inboxText,
  membersProblem,
  mentionDeliveryText,
  messageText,
  parseMentions,
  pieceFor,
  questionText,
  taskHistoryText,
  threadMismatchText,
  undeliveredMentionsText,
  unreadEligible,
  wakeText,
  workOf,
  type DeliveryInput,
  type GroupMessage,
} from "../src/shared/group-chat";
import { insertMention, mentionCandidates, mentionQuery, mentionRuns } from "../src/web/chat/mentions";

const members = [
  { id: "r", name: "Researcher" },
  { id: "w", name: "Writer" },
  { id: "a", name: "Ann" },
  { id: "al", name: "Ann Lee" },
  { id: "x", name: "小明" },
];

const message = (seq: number, patch: Partial<GroupMessage> = {}): GroupMessage => ({
  seq,
  at: "2026-10-16T10:02:00.000Z",
  from: { kind: "user" },
  text: "hello",
  replyTo: null,
  thread: null,
  replies: 0,
  lastReplyAt: null,
  mentions: [],
  everyone: false,
  attachments: [],
  task: null,
  reactions: [],
  ...patch,
});

describe("group mentions", () => {
  it("finds members by name in any case, longest name first, and @everyone", () => {
    expect(parseMentions("@researcher gather sources, then @Writer drafts it", members)).toEqual({ botIds: ["r", "w"], everyone: false, unknown: [], handles: { r: "@researcher", w: "@Writer" }, outside: [] });
    expect(parseMentions("@Ann Lee and @Ann", members).botIds).toEqual(["al", "a"]);
    expect(parseMentions("hi @everyone", members)).toMatchObject({ botIds: [], everyone: true });
  });

  it("doesn't take part of a longer word, an email address or a name it doesn't know", () => {
    expect(parseMentions("@Anna, mail me at me@Writer.com", members)).toEqual({ botIds: [], everyone: false, unknown: ["Anna"], handles: {}, outside: [] });
    expect(parseMentions("@Writers", members).botIds).toEqual([]);
  });

  it("tells a bot outside the group from a name that's nobody's", () => {
    const outsiders = [{ id: "g", name: "Grok Helper" }, { id: "w", name: "Writer" }];
    expect(parseMentions("@grok helper and @Writer, then @Nobody", members, outsiders)).toEqual({
      botIds: ["w"],
      everyone: false,
      unknown: ["Nobody"],
      handles: { w: "@Writer" },
      outside: [{ id: "g", name: "Grok Helper", handle: "@grok helper" }],
    });
  });

  it("lets Chinese text follow a name without a space", () => {
    expect(parseMentions("@Writer请写初稿，@小明看一下", members).botIds).toEqual(["w", "x"]);
  });
});

describe("unread and delivery", () => {
  it("applies the unread rule: not one's own message, not a note one caused, not a skip note; a personal @mention always", () => {
    const chat = { senderId: "r", system: false, subtype: null, causalActor: null };
    expect(unreadEligible(chat, "r", false)).toBe(false);
    expect(unreadEligible(chat, "w", false)).toBe(true);
    const note = { senderId: "system", system: true, subtype: "task.created_summary", causalActor: "r" };
    expect(unreadEligible(note, "r", false)).toBe(false);
    expect(unreadEligible(note, "w", false)).toBe(true);
    expect(unreadEligible(note, "r", true)).toBe(true);
    expect(unreadEligible({ ...note, subtype: "task.deleted_summary" }, "w", false)).toBe(false);
  });

  const reason = (patch: Partial<DeliveryInput> & { message?: Partial<DeliveryInput["message"]> }) =>
    deliveryReason({ mode: "everyone", receiverId: "w", conv: 0, personal: false, repliedTo: false, eligible: true, ...patch, message: { senderId: "user", kind: "user", everyone: false, mentions: [], ...patch.message } });

  it("in everyone mode puts every unread message in the inbox, saying why", () => {
    expect(reason({})).toBe("open");
    expect(reason({ message: { mentions: ["r"] } })).toBe("group");
    expect(reason({ personal: true, message: { mentions: ["w"] } })).toBe("mention");
    expect(reason({ personal: true, message: { senderId: "r", kind: "bot", mentions: ["w"] } })).toBe("handoff");
    expect(reason({ personal: true, message: { senderId: "system", kind: "system", mentions: ["w"] } })).toBe("assigned");
    expect(reason({ repliedTo: true, message: { senderId: "r", kind: "bot" } })).toBe("reply");
    expect(reason({ message: { everyone: true } })).toBe("everyone");
    expect(reason({ conv: 3, message: { senderId: "r", kind: "bot" } })).toBe("thread");
    expect(reason({ message: { senderId: "system", kind: "system" } })).toBe("group");
    // Never its own message, nor one that isn't unread for it.
    expect(reason({ receiverId: "r", message: { senderId: "r", kind: "bot" } })).toBeNull();
    expect(reason({ eligible: false })).toBeNull();
  });

  it("in addressed mode only what's aimed at the bot, and the user's messages that address nobody", () => {
    expect(reason({ mode: "addressed" })).toBe("open");
    expect(reason({ mode: "addressed", message: { senderId: "r", kind: "bot" } })).toBeNull();
    expect(reason({ mode: "addressed", repliedTo: true, message: { senderId: "r", kind: "bot" } })).toBe("reply");
    expect(reason({ mode: "addressed", conv: 3, message: { senderId: "r", kind: "bot" } })).toBeNull();
    expect(reason({ mode: "addressed", conv: 3 })).toBe("thread");
    expect(reason({ mode: "addressed", message: { senderId: "system", kind: "system" } })).toBeNull();
  });
});

describe("what a bot reads", () => {
  const roster = [
    { id: "r", name: "Researcher", title: "Finds sources" },
    { id: "w", name: "Writer", title: "Drafts copy" },
  ];
  const researcher = { kind: "bot" as const, botId: "r", name: "Researcher" };

  it("wakes a bot with a content-free notice: what's new, where, from whom, and whether it's for it", () => {
    const text = wakeText({
      groupName: "Launch",
      me: { id: "w", name: "Writer" },
      roster,
      pending: [
        { message: message(3, { text: "@Writer draft it", mentions: ["w"] }), reason: "mention" },
        { message: message(4, { from: researcher, text: "Sources: …" }), reason: "group" },
        { message: message(6, { from: researcher, text: "Done there.", thread: 2 }), reason: "thread" },
      ],
    });
    expect(text).toMatch(/^\[Group chat "Launch"\. Members: Researcher \(Finds sources\), Writer \(you\), and the user\.\]/);
    expect(text).toContain("[Group inbox notice: 3 new messages for you to read.");
    // One row per place, the latest activity first.
    expect(text).toContain("- thread #2: 1 new (#6) · latest from Researcher (bot)\n- top level: 2 new (#3 to #4) · latest from Researcher (bot) · you were @mentioned");
    expect(text).toContain("group_read with unread: true");
    // Content-free: the messages themselves aren't in it.
    expect(text).not.toContain("draft it");
    expect(text).not.toContain("Sources");
    expect(groupDelivery(text)).toMatchObject({ group: "Launch" });
    expect(groupDelivery("[Message from Writer, another bot]\n\nhi")).toBeNull();
  });

  it("pulls a bot into a thread with the thread so far, and renews a seat with a briefing", () => {
    const top = message(3, { text: "Plan the launch for next week" });
    const join = wakeText({
      groupName: "Launch",
      me: { id: "w", name: "Writer" },
      roster,
      pending: [],
      joins: [{ thread: 3, parent: top, recent: [message(5, { from: researcher, text: "Friday?", thread: 3 })], earlier: 4, trigger: message(7, { text: "@Writer can you check the dates?", mentions: ["w"], thread: 3 }) }],
    });
    expect(join).toContain("[Thread context: you were @mentioned in thread #3, which you haven't read.]\nSuggested next step: group_read with thread: 3.");
    expect(join).toContain("The thread's top message:\n#3 · the user · 2026-10-16 10:02Z\nPlan the launch for next week");
    expect(join).toContain("Recent replies (truncated: 4 earlier not shown):");
    expect(join).toContain('The message that @mentions you:\n#7 · the user · 2026-10-16 10:02Z · in thread #3 (on the user: "Plan the launch for next week") · @mentions you');
    expect(join).not.toContain("Group inbox notice");
    const renewed = wakeText({ groupName: "Launch", me: { id: "w", name: "Writer" }, roster, pending: [{ message: message(9), reason: "group" }], briefing: "<briefing>", owed: [{ number: 3, seq: 3, status: "in_progress", assignee: { kind: "bot", id: "w", name: "Writer" } }] });
    expect(renewed).toContain("<briefing>\n\n---");
    expect(renewed).toContain("Tasks assigned to you that aren't finished: task #3 (in_progress).");
    expect(messageText({ ...top, replies: 2 }, "w")).toContain("2 replies in its thread");
  });

  it("catches up after a restart with the unread messages themselves, or the places to read, and says when an @mention brought it back to a thread", () => {
    const place = (conv: number, count: number) => ({ conv, count, first: 9, latest: message(9), mention: false });
    const batch = wakeText({ groupName: "Launch", me: { id: "w", name: "Writer" }, roster, pending: [], catchUp: { messages: [message(9, { text: "@Writer status?", mentions: ["w"] })], places: [place(0, 1), place(4, 7)], uncovered: [place(4, 7)] } });
    expect(batch).toContain("New message received while pocket-bots was stopped:\n\n#9 · the user");
    expect(batch).toContain("@Writer status?");
    expect(batch).toContain("Respond as appropriate. Complete all your work before stopping.");
    expect(batch).toContain("Some unread places may not be fully included in this bounded batch:\n- thread #4: 7 unread");
    const summary = wakeText({ groupName: "Launch", me: { id: "w", name: "Writer" }, roster, pending: [], catchUp: { messages: [], places: [place(0, 2)], uncovered: [] } });
    expect(summary).toContain("You have unread messages from while pocket-bots was stopped:\n- top level: 2 unread");
    expect(summary).toContain("Read each listed place at most once unless a read fails.");
    expect(summary).toContain("Otherwise, don't send any message in this mode.");
    const back = wakeText({ groupName: "Launch", me: { id: "w", name: "Writer" }, roster, pending: [{ message: message(9, { mentions: ["w"], thread: 4 }), reason: "mention", reactivated: true }] });
    expect(back).toContain("[Thread follow restored: this @mention re-subscribed you to ordinary replies in thread #4.]");
  });

  it("explains a hold and the ways forward, and suggests sending anyway after three holds", () => {
    const shown = [message(5, { from: { kind: "bot", botId: "r", name: "Researcher" }, text: "I've got this one.", task: { number: 1, status: "in_progress", assignee: { kind: "bot", id: "r", name: "Researcher" } } })];
    const held = { conv: 0, shown, count: 3, omitted: 2, firstTouch: false, meId: "w" };
    const text = heldText({ ...held, action: "send", holds: 1 });
    expect(text).toMatch(/^Your message wasn't sent: 3 messages you haven't seen came in at the top level\./);
    expect(text).toContain("(2 more not shown: group_read with top_level: true, before: 5 shows them.)");
    expect(text).toContain("I've got this one.");
    expect(text).toContain("[task #1 · in_progress · Researcher]");
    expect(text).toContain("group_send_draft discard: true");
    expect(text).not.toContain("anyway: true");
    expect(heldText({ ...held, action: "send", holds: 3 })).toContain("anyway: true");
    expect(heldText({ ...held, action: "claim", holds: 1 })).toMatch(/^Your claim wasn't made/);
    // A first touch shows the latest, not what's new; a thread's hold shows its top message.
    const thread = heldText({ ...held, conv: 2, omitted: 0, firstTouch: true, parent: message(2, { text: "Plan" }), action: "send", holds: 1 });
    expect(thread).toMatch(/^Your message wasn't sent: you haven't read thread #2 yet\. Its latest messages:/);
    expect(thread).toContain("The thread's top message:");
    expect(thread).toContain("group_send_draft thread: 2");
    expect(threadMismatchText(2)).toContain("group_send thread: 2");
  });

  it("lists unread places for group_inbox, newest activity first, each with the call that opens it", () => {
    const now = Date.parse("2026-10-16T10:07:00.000Z");
    const places = [
      { conv: 0, count: 2, first: 3, latest: message(4), mention: false, mentions: 0 },
      { conv: 2, count: 3, first: 6, latest: message(8, { thread: 2, from: { kind: "bot", botId: "r", name: "Researcher" } }), mention: true, mentions: 2 },
    ];
    expect(inboxText(places, "w", { now, notNoticed: new Map([[2, 1]]) })).toBe(
      [
        "Inbox: 2 unread places (1 with mentions). Newest activity first.",
        "",
        "thread #2 · 3 unread · mentions you 2x · 1 new, not yet told to you · latest Researcher (bot) 5m ago\n  open: group_read with unread: true and thread: 2",
        "top level · 2 unread · latest the user 5m ago\n  open: group_read with unread: true and top_level: true",
        "",
        "Next: open the first place above: group_read with unread: true and thread: 2.",
      ].join("\n"),
    );
    expect(inboxText(places, "w", { mentionsOnly: true, now })).toMatch(/^Inbox: 1 place with unread mentions \(of 2 unread places\)\. Newest activity first\.\n\nthread #2/);
    expect(inboxText([], "w")).toBe("Inbox: nothing unread.\n\nNext: nothing to do; new messages will reach you as they arrive.");
  });
});

describe("task cards and mention delivery", () => {
  const card = { number: 3, status: "todo" as const, assignee: null, revision: 2, title: "Fix the login page (mobile too)", description: "Both Safari and Chrome.\nNo new deps.", createdBy: "user", amended: { at: "2026-10-16T11:00:00.000Z", by: "Writer", byId: "w" } };

  it("shows an amended task's current card under its message, with its labels", () => {
    const text = messageText(message(3, { text: "Fix the login page", task: card }), "r");
    expect(text).toBe(
      [
        "#3 · the user · 2026-10-16 10:02Z · [task #3 · todo · unassigned]",
        "Fix the login page",
        "[task #3 amended: the card supersedes this message's text (rev=2, by Writer, 2026-10-16 11:00Z)]",
        "Current title: Fix the login page (mobile too)",
        "Current description: Both Safari and Chrome.\nNo new deps.",
      ].join("\n"),
    );
    expect(messageText(message(3, { task: card }), "w")).toContain("(rev=2, by you, ");
    expect(messageText(message(3, { task: { ...card, amended: null } }), "r")).not.toContain("Current title");
  });

  it("lists a task's history after its current card", () => {
    const text = taskHistoryText(card, [{ seq: 7, event: "amended", actor: { kind: "bot", id: "w", name: "Writer" }, payload: { revision: 2 }, at: "2026-10-16T11:00:00.000Z" }], "r");
    expect(text).toBe(
      [
        "## Task #3 history — revision 2",
        "",
        "Current title: Fix the login page (mobile too)",
        "Current description: Both Safari and Chrome.",
        "                     No new deps.",
        "",
        "seq=7 time=2026-10-16 11:00Z actor=@Writer type=amended",
        '  {"revision":2}',
      ].join("\n"),
    );
    expect(taskHistoryText({ ...card, description: null }, [], "r")).toContain("Current description: (none set)\n\nNo recorded events.");
  });

  it("says which mentions reached nobody, and only points to ask_bot when the bot may ask", () => {
    expect(undeliveredMentionsText({ outside: [], unknown: [], askBot: true })).toBe("");
    const text = undeliveredMentionsText({ outside: [{ name: "Grok", handle: "@grok" }], unknown: ["Zed"], askBot: false });
    expect(text).toContain("- @grok — not in this group\n  consequence: this @mention didn't notify anyone.\n  recovery: only the user can add Grok to this group.\n");
    expect(text).not.toContain("ask_bot");
    expect(text).toContain("- @Zed — no bot by that name");
  });

  it("reports each mentioned member's outcome, and who else a message reached", () => {
    expect(
      mentionDeliveryText(
        9,
        [
          { handle: "@Writer", outcome: "delivered" },
          { handle: "@Researcher", outcome: "pending", told: true, accepted: false },
          { handle: "@Ann", outcome: "lost", category: "quota" },
          { handle: "@Ann Lee", outcome: "lost", category: "runtime_error" },
          { handle: "@小明", outcome: "lost", category: "not_launched" },
          { handle: "@Rex", outcome: "lost", category: "unclassified" },
          { handle: "@Zed", outcome: "unknown" },
        ],
        [{ name: "the user", state: "unread" }, { name: "Cody", state: "inbox" }],
        [],
      ),
    ).toBe(
      [
        "Message #9 — mention delivery per target",
        "",
        "  @Writer: delivered",
        "  @Researcher: still in flight — do not conclude yet (notice sent; its seat hasn't taken it in yet)",
        "  @Ann: LOST — target is rate/quota limited; it will not arrive, re-route or retry later",
        "  @Ann Lee: LOST — target's runtime rejected delivery; re-route",
        "  @小明: LOST — target was not running; re-route or start it",
        "  @Rex: LOST — cause is outside the seat-availability set; re-route",
        "  @Zed: UNKNOWN — our instrument could not see this one; re-check, do not conclude",
        "",
        "Also delivered to:",
        "  the user: delivered, not read yet",
        "  Cody: in its inbox, not read yet",
      ].join("\n"),
    );
    expect(mentionDeliveryText(9, [{ handle: "@Writer", outcome: "pending", told: false }], [], [])).toContain("(not told yet: its seat is busy or starting)");
    expect(mentionDeliveryText(9, [{ handle: "@Writer", outcome: "pending", told: true, accepted: true }], [], [])).toContain("(its seat has the notice; not read yet)");
    expect(mentionDeliveryText(9, [], [], ["Writer"])).toBe("Message #9\n\nNo mention deliveries recorded for this message.\n\nNot delivered to (muted, or not following its thread): Writer");
  });

  it("files a failed turn under its category: rate or quota limited, or the runtime rejected it", () => {
    expect(["Rate limit reached for requests", "429 Too Many Requests", "You've hit your usage limit", "quota exceeded"].map(deliveryFailureOf)).toEqual(["quota", "quota", "quota", "quota"]);
    expect(deliveryFailureOf("spawn grok ENOENT")).toBe("runtime_error");
  });
});

describe("a group with a leader", () => {
  const lead = { kind: "bot" as const, botId: "lead", name: "Lead" };
  const entry = (seq: number, patch: Partial<GroupMessage> = {}) => ({ message: message(seq, patch), noticed: false });

  it("knows the piece of work a message belongs to: its thread, or a new top-level @mention from the leader or the user", () => {
    expect(workOf("lead", "w", message(3, { from: lead, mentions: ["w"] }))).toBe(3);
    expect(workOf("lead", "w", message(4, { mentions: ["w"] }))).toBe(4);
    expect(workOf("lead", "w", message(5, { from: lead, thread: 3, mentions: ["w"] }))).toBe(3);
    expect(workOf("lead", "w", message(6, { from: lead, everyone: true }))).toBeNull();
    expect(workOf("lead", "w", message(7, { from: { kind: "system" }, mentions: ["w"] }))).toBeNull();
    expect(workOf("lead", "w", message(8, { from: { kind: "bot", botId: "r", name: "R" }, mentions: ["w"] }))).toBeNull();
  });

  it("tells a member about one piece at a time: news for its current piece first, else the oldest, notes going along", () => {
    const inbox = [entry(3, { from: lead, mentions: ["w"] }), entry(5, { from: lead, everyone: true }), entry(6, { from: lead, thread: 2, mentions: ["w"] })];
    // Its session is on piece #2: the follow-up there comes first, and #3 waits.
    expect(pieceFor("lead", "w", inbox, 2)).toEqual({ work: 2, now: [inbox[1], inbox[2]], switching: false });
    // On another piece: the oldest goes first, in a fresh session.
    expect(pieceFor("lead", "w", inbox, 9)).toEqual({ work: 3, now: [inbox[0], inbox[1]], switching: true });
    // A new seat, or one that's on no piece yet, takes it up without switching; notes alone are for no piece.
    expect(pieceFor("lead", "w", inbox, null)).toMatchObject({ work: 3, switching: false });
    expect(pieceFor("lead", "w", [inbox[1]!], 2)).toEqual({ work: null, now: [inbox[1]], switching: false });
    // Its current piece has only what it was already told: news for another piece goes first.
    const told = [{ ...inbox[2]!, noticed: true }, inbox[0]!];
    expect(pieceFor("lead", "w", told, 2)).toEqual({ work: 3, now: [inbox[0]], switching: true });
  });

  it("shows a led member its piece in full, and gives the leader and the members their sections", () => {
    const text = wakeText({ groupName: "Launch", me: { id: "w", name: "Writer" }, roster: [{ id: "lead", name: "Lead", title: "", leader: true }, { id: "w", name: "Writer", title: "" }], pending: [], handed: { messages: [message(3, { from: lead, text: "@Writer draft the notes", mentions: ["w"] })] } });
    expect(text).toContain("Members: Lead (leader), Writer (you), and the user.");
    expect(text).toContain("[For you, in full (already read):]\n\n#3 · Lead (bot) · 2026-10-16 10:02Z · @mentions you\n@Writer draft the notes");
    expect(text).not.toContain("Group inbox notice");
    const leader = groupPrompt("Launch", { subAgents: true, lead: { role: "leader", members: [{ name: "Writer", about: "Writes · runs on Claude Code with claude-sonnet-5-5" }] } });
    expect(leader).toContain("You lead this group:");
    expect(leader).toContain("  - Writer: Writes · runs on Claude Code with claude-sonnet-5-5");
    expect(leader).toContain("reply in the same thread and @mention the member: the thread is the piece's context");
    expect(leader).not.toContain("Working through sub-agents:");
    const member = groupPrompt("Launch", { lead: { role: "member", leader: "Lead" } });
    expect(member).toContain("A new piece starts you in a fresh session that remembers nothing of earlier pieces");
    expect(member).toContain("Don't change the task's status: Lead decides when it's done.");
    expect(member).not.toContain("set the task to in_review");
    expect(member).not.toContain("Splitting tasks for parallel execution:");
    expect(member).not.toContain("send short progress updates");
  });
});

describe("the seat prompt", () => {
  it("adds the sub-agent section, between splitting tasks and @mentions, only for a runtime that can start sub-agents", () => {
    const plain = groupPrompt("Launch");
    const delegating = groupPrompt("Launch", { subAgents: true });
    expect(plain).not.toContain("Working through sub-agents:");
    const at = delegating.indexOf("Working through sub-agents:");
    expect(at).toBeGreaterThan(delegating.indexOf("Splitting tasks for parallel execution:"));
    expect(at).toBeLessThan(delegating.indexOf("@Mentions:"));
    // Sub-agents stay out of the group.
    expect(delegating).toContain("5. Only you speak in the group. Tell every sub-agent not to use the group tools: no group_send, group_send_draft, group_claim, group_task, group_react or group_reminder.");
    expect(delegating.replace(/\nWorking through sub-agents:[\s\S]*?has been reported\.\n/, "")).toBe(plain);
  });

  it("tells a seat that group messages are text first, files attached with them, and names its runtime's question tool", () => {
    const plain = groupPrompt("Launch");
    expect(plain).toContain("- Group messages are text first: the text carries the message on its own");
    expect(plain).toContain("attach it with group_send's files (paths on this computer, at most 6)");
    expect(plain).not.toContain("Share files by their path");
    expect(plain).not.toContain("ask with your");
    expect(groupPrompt("Launch", { questionTool: "AskUserQuestion" })).toContain(
      "- When only the user can decide something (a choice between options, a fact you can't find), ask with your AskUserQuestion tool. The question shows in the group as yours, and the user's answer comes back to you as the tool's result; it reaches no other bot.",
    );
  });

  it("tells a seat about task amendments and mention delivery", () => {
    const prompt = groupPrompt("Launch");
    expect(prompt).toContain("group_task amend changes a task card's current title or description");
    expect(prompt).toContain("group_mention_delivery shows what happened to each member a message of yours @mentioned");
  });
});

describe("a bot's questions in the group", () => {
  const questions = { questions: [{ question: "Which colour?", header: "Colour", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] };

  it("shows a seat's question in the group, but not another approval or a secret question", () => {
    expect(groupQuestion({ kind: "question", input: questions })?.map((question) => question.header)).toEqual(["Colour"]);
    expect(groupQuestion({ kind: "tool", input: questions })).toBeNull();
    expect(groupQuestion({ kind: "question", input: questions, metadata: { secret: true } })).toBeNull();
    expect(groupQuestion({ kind: "question", input: { questions: [{ question: "Token?", header: "Token", options: [], isSecret: true }] } })).toBeNull();
    expect(groupQuestion({ kind: "question", input: { nothing: 1 } })).toBeNull();
  });

  it("keeps a question as text for previews and bots, and says where it stands", () => {
    const asked = groupQuestion({ kind: "question", input: questions })!;
    expect(questionText(asked)).toBe("Which colour? (one of: Red / Blue)");
    expect(questionText([...asked, { question: "Anything else?", header: "More", options: [], multiSelect: false }])).toBe("1. Which colour? (one of: Red / Blue)\n2. Anything else?");
    const message: GroupMessage = {
      seq: 4,
      at: "2026-10-19T10:00:00.000Z",
      from: { kind: "bot", botId: "ada", name: "Ada" },
      text: questionText(asked),
      replyTo: null,
      thread: null,
      replies: 0,
      lastReplyAt: null,
      mentions: [],
      everyone: false,
      attachments: [],
      question: { chatId: "c", requestId: "r", input: questions, status: "pending", answers: null, settledAt: null },
      task: null,
      reactions: [],
    };
    expect(messageText(message, "ada")).toBe("#4 · you · 2026-10-19 10:00Z\nWhich colour? (one of: Red / Blue)\n[Your question for the user: waiting for the answer]");
    const states = (["answered", "dismissed", "closed"] as const).map((status) => messageText({ ...message, question: { ...message.question!, status, answers: status === "answered" ? ["Blue"] : null } }, "cody").split("\n").at(-1));
    expect(states).toEqual(['[A question for the user: the user answered "Blue"]', "[A question for the user: the user dismissed it]", "[A question for the user: no longer waiting; it wasn't answered]"]);
  });
});

describe("groups", () => {
  it("names a group after its bots and takes two to six of them", () => {
    expect(defaultGroupName(["Researcher", "Writer"])).toBe("Researcher & Writer");
    expect(defaultGroupName(["A", "B", "C"])).toBe("A, B & C");
    expect(defaultGroupName(["A", "B", "C", "D", "E"])).toBe("A, B, C +2");
    expect(membersProblem(["a"])).toMatch(/at least 2/);
    expect(membersProblem(["a", "a"])).toMatch(/at least 2/);
    expect(membersProblem(["a", "b", "c", "d", "e", "f", "g"])).toMatch(/at most 6/);
    expect(membersProblem(["a", "b"])).toBeNull();
  });

});

describe("the group composer's @mentions", () => {
  it("knows when an @mention is being typed", () => {
    expect(mentionQuery("hi @Wr", 6)).toEqual({ start: 3, query: "Wr" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("请，@小", 4)).toEqual({ start: 2, query: "小" });
    expect(mentionQuery("me@mail", 7)).toBeNull();
    expect(mentionQuery("@Wr\nnext", 8)).toBeNull();
  });

  it("offers names that start with what's typed, then names with a word that does", () => {
    const list = [{ name: "Ann Lee" }, { name: "Lee" }, { name: "Writer" }, { name: "everyone" }];
    expect(mentionCandidates(list, "le").map((entry) => entry.name)).toEqual(["Lee", "Ann Lee"]);
    expect(mentionCandidates(list, "").length).toBe(4);
  });

  it("puts the chosen name in with a space after it", () => {
    expect(insertMention("hi @Wr thanks", { start: 3, query: "Wr" }, 6, "Writer")).toEqual({ text: "hi @Writer thanks", caret: 11 });
  });

  it("picks out mentions for highlighting", () => {
    expect(mentionRuns("@writer and @Ann Lee, not me@Ann or @WriterX", members)).toEqual([
      { text: "@writer", mention: true },
      { text: " and ", mention: false },
      { text: "@Ann Lee", mention: true },
      { text: ", not me@Ann or @WriterX", mention: false },
    ]);
  });
});
