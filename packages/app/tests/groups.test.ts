// Group chats end to end, without a model: real ChatService, relay and group tools, with the fake
// runtime standing in for each bot (its script calls the group tools over MCP like an agent would).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScript, type FakeStep, type FakeTurn } from "@pocket-bots/runtime";
import { fakeHost, makeBot } from "./helpers";

type BotScript = (turn: FakeTurn, step: number, botId: string) => FakeStep | null;

const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 5_000) => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** The bot a seat's session belongs to, from its tools address (/bots/<botId>/<chat>/<group>). */
const botOf = (turn: FakeTurn) => /\/bots\/([^/]+)\//.exec((turn.spec.mcpServers.bots as { url: string }).url)?.[1] ?? "";

/** `outside` are the user's bots that aren't in the group. */
async function setup(script: BotScript, bots = ["alpha", "beta"], options: import("../src/server/groups").GroupOptions = {}, outside: string[] = []) {
  const { ChatService } = await import("../src/server/chat-service");
  const { Db } = await import("../src/server/db");
  const { chatSpecs, startChat } = await import("../src/server/chats");
  const { GroupChats } = await import("../src/server/groups");
  const { Relay } = await import("../src/server/relay");
  const { GroupStore } = await import("../src/server/group-store");
  const { BOT_TOOLS } = await import("../src/server/tools");
  const dir = await mkdtemp(join(tmpdir(), "bots-groups-"));
  const db = new Db(join(dir, "bots.sqlite"));
  const host = fakeHost([...bots, ...outside].map((id) => makeBot({ id, name: id[0]!.toUpperCase() + id.slice(1), provider: "fake" })));
  const relay = new Relay(host, BOT_TOOLS, { port: 0 });
  const store = new GroupStore(db);
  const groups = new GroupChats(host, store, (bot, input) => startChat(host, bot, input), () => {}, options);
  relay.groups = groups;
  const fake = new FakeAdapter(((turn, step) => script(turn, step, botOf(turn))) as FakeScript);
  // Seats start without the 500 ms spacing, so the scripts' timings stay theirs.
  const chats = new ChatService(db, new Map([["fake", fake]]), chatSpecs(host, relay, (groupId, botId) => groups.seatGroup(groupId, botId)), async () => null, { startIntervalMs: 0 });
  host.attach(chats);
  chats.on("input.accepted", (event) => groups.onInputAccepted(event));
  chats.on("turn.ended", async ({ agent, outcome, supervision }) => groups.onTurnEnded(agent, { outcome: outcome.kind, error: outcome.kind === "failed" ? outcome.error.message : null, ...(supervision ? { supervision } : {}) }));
  chats.on("start.failed", (event) => groups.onStartFailed(event));
  chats.on("start.ready", (event) => groups.onStartReady(event));
  chats.on("session.reset", (event) => groups.onSessionReset(event));
  chats.on("agent.settled", (agent) => groups.onAgent(agent));
  chats.on("permission.requested", (event) => groups.onPermission(event));
  chats.on("permission.resolved", (event) => groups.onPermissionResolved(event));
  chats.start();
  const { id } = await groups.create({ name: "Group", memberIds: bots });
  const texts = async () => (await groups.messages(id)).messages.map((message) => `${message.from.kind === "bot" ? message.from.botId : message.from.kind}: ${message.text}`);
  const idle = () => chats.list({}).every((chat) => chat.status !== "running");
  const stop = async () => {
    groups.close();
    relay.stop();
    await chats.stop();
    db.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { groups, chats, id, texts, idle, stop, fake, store, host };
}

let stop: (() => Promise<void>) | null = null;
let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "bots-groups-home-"));
  process.env.POCKET_BOTS_HOME = home;
});
afterAll(async () => {
  delete process.env.POCKET_BOTS_HOME;
  await rm(home, { recursive: true, force: true });
});
afterEach(async () => {
  await stop?.();
  stop = null;
});

const delivered = (turn: FakeTurn) => turn.text.startsWith("[Group chat");

/**
 * A bot that, woken by the group, first reads its unread messages like an agent would (the wake is
 * only a notice), then acts: the wrapped script sees the wake and what it read as the turn's text.
 */
const reads =
  (script: BotScript): BotScript =>
  (turn, step, botId) => {
    if (!delivered(turn)) return null;
    if (step === 0) return { tool: "group_read", args: { unread: true } };
    return script({ ...turn, text: `${turn.text}\n${turn.results[0] ?? ""}`, results: turn.results.slice(1) }, step - 1, botId);
  };


/** Lets wakes go out and every seat finish its turn. */
const settle = async (group: { idle: () => boolean }) => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  await until(group.idle);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await until(group.idle);
};

describe("group chats", () => {
  it("answers an open question once: the second bot's post is held, and it lets it go", async () => {
    // Both read the question at once; Alpha answers first, Beta (slower) after it.
    const group = await setup(
      reads((turn, step, botId) => {
        if (!turn.text.includes("What's 2+2")) return null;
        if (step === 0) return { wait: botId === "beta" ? 200 : 50 };
        if (step === 1) return { tool: "group_send", args: { text: botId === "alpha" ? "It's 4." : "4" } };
        return null;
      }),
    );
    stop = group.stop;
    await group.groups.postFromUser(group.id, { text: "What's 2+2?" });
    await until(async () => (await group.texts()).length >= 2 && group.idle());
    await new Promise((resolve) => setTimeout(resolve, 200));
    await until(group.idle);
    expect(await group.texts()).toEqual(["user: What's 2+2?", "alpha: It's 4."]);
    // Beta's post is kept as its draft.
    expect(group.store.draft(group.id, "beta", 0)).toMatchObject({ text: "4", hold_count: 1 });
  });

  it("lets only one bot claim a piece of work, as a task, without a note", async () => {
    const claims: string[] = [];
    const group = await setup(
      reads((turn, step, botId) => {
        if (!delivered(turn) || !turn.text.includes("fix the bug")) return null;
        // Alpha claims at once and reports a little later; Beta tries to claim in between.
        if (step === 0) return botId === "beta" ? { wait: 100 } : { tool: "group_claim", args: { task: 1 } };
        if (step === 1) return botId === "beta" ? { tool: "group_claim", args: { task: 1 } } : { wait: 250 };
        const last = turn.results.at(-1) ?? "";
        if (!claims.includes(`${botId}:${last.slice(0, 20)}`)) claims.push(`${botId}:${last.slice(0, 20)}`);
        if (last.startsWith("You've claimed") && !turn.results.some((result) => result.startsWith("Sent"))) return { tool: "group_send", args: { text: "Fixed it." } };
        return null;
      }),
    );
    stop = group.stop;
    await group.groups.postFromUser(group.id, { text: "Please fix the bug." });
    await until(async () => (await group.texts()).includes("alpha: Fixed it.") && group.idle(), 8_000);
    await until(group.idle);
    const { messages } = await group.groups.messages(group.id);
    expect(messages[0]!.task).toMatchObject({ number: 1, status: "in_progress", assignee: { id: "alpha" } });
    expect(claims).toContain("beta:Claim refused for ta");
    // An agent's claim is noted nowhere: the task's label shows it.
    expect(await group.texts()).toEqual(["user: Please fix the bug.", "alpha: Fixed it."]);
  });

  it("wakes a bot with a notice, not the messages; a busy one gets the notice in its turn, once, and reads them itself", async () => {
    const read: string[] = [];
    const group = await setup(
      reads((turn, step, botId) => {
        if (botId !== "alpha") return null;
        if (step === 0) read.push(turn.results.length ? "" : turn.text);
        if (turn.text.includes("long job") && step === 0) return { wait: 400 };
        // After the long job, it reads what the notice said is waiting.
        if (step === 1 && turn.steers.length) return { tool: "group_read", args: { unread: true } };
        if (step === 2) read.push(turn.results.at(-1) ?? "");
        return null;
      }),
    );
    stop = group.stop;
    await group.groups.postFromUser(group.id, { text: "@Alpha start the long job" });
    await until(() => group.chats.list({}).some((chat) => chat.status === "running"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await group.groups.postFromUser(group.id, { text: "FYI the deadline is Friday" });
    await until(() => read.length >= 2 && group.idle(), 5_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await until(group.idle);
    const seat = (await group.groups.list())[0]!.seats.alpha!;
    const wakes = group.chats
      .items(seat, 50)
      .flatMap((item) => (item.type === "user_message" ? [item.text] : []))
      .filter((text) => text.startsWith("[Group chat"));
    // The first wake and the one that joined the running turn are notices without the messages' text.
    expect(wakes).toHaveLength(2);
    expect(wakes[0]).toContain("- top level: 1 new (#1) · latest from the user · you were @mentioned");
    expect(wakes[0]).not.toContain("long job");
    expect(wakes[1]).toContain("[Group inbox notice: 1 new message for you to read.");
    expect(wakes[1]).not.toContain("Friday");
    // The bot read the messages itself; nothing woke it again for the same ones.
    expect(read[0]).toContain("@Alpha start the long job");
    expect(read[1]).toContain("FYI the deadline is Friday");
    expect(group.store.pending(group.id, "alpha")).toEqual([]);
  });

  it("doesn't reach a muted bot with ordinary messages, but an @mention does, and what it never got doesn't hold it", async () => {
    const woke: string[] = [];
    const group = await setup(
      reads((turn, step, botId) => {
        if (step === 0) woke.push(`${botId}:${turn.text.match(/#\d+ · the user[^\n]*\n([^\n]*)/g)?.at(-1)?.split("\n")[1] ?? ""}`);
        return null;
      }),
    );
    stop = group.stop;
    const beta = (await group.host.bot("beta"))!;
    await group.groups.setMuted(group.id, "beta", true);
    await group.groups.postFromUser(group.id, { text: "hello group" });
    await until(() => woke.length >= 1 && group.idle());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(woke).toEqual(["alpha:hello group"]);
    await group.groups.postFromUser(group.id, { text: "@Beta your turn" });
    await until(() => woke.some((entry) => entry.startsWith("beta:")) && group.idle());
    expect(woke.find((entry) => entry.startsWith("beta:"))).toBe("beta:@Beta your turn");
    // Beta reads the top level; later chatter has no record for it, so it neither lists as unread nor holds Beta's post.
    await group.groups.read(beta, group.id, {});
    await group.groups.postFromUser(group.id, { text: "more chatter" });
    await settle(group);
    expect(await group.groups.inbox(beta, group.id)).toMatch(/^Inbox: nothing unread\./);
    expect(await group.groups.send(beta, group.id, { text: "On it." })).toMatch(/^Sent as #4\./);
  });

  it("holds a post for what's in the bot's inbox, newest three shown, and keeps the draft to send, drop or send anyway", async () => {
    const group = await setup(() => null);
    stop = group.stop;
    const alpha = (await group.host.bot("alpha"))!;
    await group.groups.postFromUser(group.id, { text: "first" });
    await settle(group);
    // The notice didn't carry #1: Alpha hasn't seen it.
    const held = await group.groups.send(alpha, group.id, { text: "my take" });
    expect(held).toMatch(/^Your message wasn't sent: 1 message you haven't seen came in at the top level\./);
    expect(held).toContain("first");
    expect(held).not.toContain("anyway: true");
    // Shown once, it's seen: the draft goes out unchanged, once.
    expect(await group.groups.sendDraft(alpha, group.id, {})).toBe("Sent as #2.");
    expect(await group.groups.sendDraft(alpha, group.id, {})).toMatch(/^There's no draft for the top level/);
    for (const text of ["three", "four", "five", "six", "seven"]) await group.groups.postFromUser(group.id, { text });
    await settle(group);
    const many = await group.groups.send(alpha, group.id, { text: "still mine" });
    expect(many).toContain("5 messages you haven't seen came in");
    expect(many).toContain("(2 more not shown: group_read with top_level: true, before: 5 shows them.)");
    expect(many).toContain("seven");
    expect(many).not.toContain("three");
    // What it wasn't shown holds it again; held three times, sending anyway is offered.
    expect(await group.groups.send(alpha, group.id, { text: "still mine" })).toContain("three");
    await group.groups.postFromUser(group.id, { text: "eight" });
    await settle(group);
    const third = await group.groups.send(alpha, group.id, { text: "still mine" });
    expect(third).toContain("It has been held 3 times");
    expect(await group.groups.sendDraft(alpha, group.id, { anyway: true })).toBe("Sent as #9.");
    // A draft can be dropped instead.
    await group.groups.postFromUser(group.id, { text: "nine" });
    await settle(group);
    await group.groups.send(alpha, group.id, { text: "never mind" });
    expect(await group.groups.sendDraft(alpha, group.id, { discard: true })).toBe("Dropped your draft for the top level.");
    expect((await group.texts()).filter((text) => text.startsWith("alpha:"))).toEqual(["alpha: my take", "alpha: still mine"]);
  });

  it("counts what came in after the model's boundary: the bot's own delivery records at the top level, every message in a thread", async () => {
    const group = await setup(() => null);
    stop = group.stop;
    const alpha = (await group.host.bot("alpha"))!;
    const beta = (await group.host.bot("beta"))!;
    await group.groups.update(group.id, { wakeMode: "addressed" });
    await group.groups.postFromUser(group.id, { text: "kickoff" });
    await settle(group);
    await group.groups.read(alpha, group.id, {});
    await group.groups.read(beta, group.id, {});
    // Beta's status update is a record for Alpha but, in addressed mode, not in its inbox: the count catches it.
    expect(await group.groups.send(beta, group.id, { text: "status: halfway" })).toBe("Sent as #2.");
    const held = await group.groups.send(alpha, group.id, { text: "Me too." });
    expect(held).toMatch(/^Your message wasn't sent: 1 message you haven't seen came in at the top level\./);
    expect(held).toContain("status: halfway");
    // It was shown all of it, so its read position moved there.
    expect(group.store.cursor(group.id, "alpha", 0)).toBe(2);
    expect(await group.groups.sendDraft(alpha, group.id, {})).toBe("Sent as #3.");
    // In a thread every message counts, even one with no record for Alpha (it stopped following).
    expect(await group.groups.send(alpha, group.id, { text: "Details here.", thread: 1 })).toMatch(/^Sent as #4 in thread #1\./);
    await group.groups.read(alpha, group.id, { thread: 1 });
    await group.groups.follow(alpha, group.id, { thread: 1, follow: false });
    await group.groups.read(beta, group.id, { thread: 1 });
    // Alpha's unfollow is noted in the thread (#5).
    expect(await group.groups.send(beta, group.id, { text: "Thread news.", thread: 1 })).toBe("Sent as #6 in thread #1.");
    const inThread = await group.groups.send(alpha, group.id, { text: "And more.", thread: 1 });
    expect(inThread).toMatch(/came in at thread #1\./);
    expect(inThread).toContain("The thread's top message:");
    expect(inThread).toContain("Thread news.");
  });

  it("reads: a read that joins up moves the boundary and read position; a gap records each message; going back never lowers them", async () => {
    const group = await setup(() => null);
    stop = group.stop;
    const alpha = (await group.host.bot("alpha"))!;
    for (const text of ["one", "two", "three"]) await group.groups.postFromUser(group.id, { text });
    await settle(group);
    await group.groups.read(alpha, group.id, {});
    const at = () => [group.store.ledger(group.id, "alpha", 0).boundary, group.store.cursor(group.id, "alpha", 0)];
    expect(at()).toEqual([3, 3]);
    expect(group.store.pending(group.id, "alpha")).toEqual([]);
    for (let index = 4; index <= 33; index++) await group.groups.postFromUser(group.id, { text: `message ${index}` });
    await settle(group);
    // The latest five leave #4–#28 unread in between: seen one by one, nothing moves.
    await group.groups.read(alpha, group.id, { limit: 5 });
    expect(at()).toEqual([3, 3]);
    expect([...group.store.ledger(group.id, "alpha", 0).exact]).toEqual([29, 30, 31, 32, 33]);
    // Reading on from its position closes the gap.
    expect(await group.groups.read(alpha, group.id, { unread: true, topLevel: true })).toContain("message 28");
    expect(at()).toEqual([33, 33]);
    expect(await group.groups.read(alpha, group.id, { unread: true, topLevel: true })).toBe("No unread messages at the top level.");
    await group.groups.read(alpha, group.id, { before: 10, limit: 3 });
    expect(at()).toEqual([33, 33]);
    // A thread's read is the thread's; its top message counts as seen at the top level.
    await group.groups.postFromUser(group.id, { text: "reply", thread: 1 });
    await group.groups.read(alpha, group.id, { thread: 1 });
    expect(group.store.ledger(group.id, "alpha", 1).boundary).toBe(34);
    expect(at()).toEqual([33, 33]);
    // The inbox read records each message it shows.
    await group.groups.postFromUser(group.id, { text: "@Alpha ping", mentions: ["alpha"] } as never);
    await settle(group);
    expect(await group.groups.read(alpha, group.id, { unread: true })).toContain("@Alpha ping");
    expect(group.store.ledger(group.id, "alpha", 0).exact.has(35)).toBe(true);
    expect(await group.groups.read(alpha, group.id, { unread: true })).toMatch(/^Your inbox is empty/);
  });

  it("searches with previews that don't count as seen, reads around a hit, and folds what a bot was already shown", async () => {
    const group = await setup(() => null);
    stop = group.stop;
    const alpha = (await group.host.bot("alpha"))!;
    for (const text of ["one", "two", "The release plan moves to Friday.", "four", "five"]) await group.groups.postFromUser(group.id, { text });
    await settle(group);
    const found = await group.groups.search(alpha, group.id, "release plan");
    expect(found).toContain('Search results for: "release plan" (1 result)');
    expect(found).toContain("The <match>release plan</match> moves to Friday.");
    expect(found).toContain("group_read (around: its number)");
    expect(group.store.ledger(group.id, "alpha", 0).exact.size).toBe(0);
    // Reading around the hit records each message it shows, and isn't booked as a read of the place.
    const around = await group.groups.read(alpha, group.id, { around: 3, limit: 3 });
    expect(around).toMatch(/^Around #3 at the top level, oldest first:/);
    expect([...group.store.ledger(group.id, "alpha", 0).exact]).toEqual([2, 3, 4]);
    expect(group.store.ledger(group.id, "alpha", 0).readOrder).toBeNull();
    // #1 is still unseen, so the read position stays put; an unread read prints only what's new to it.
    expect(group.store.cursor(group.id, "alpha", 0)).toBe(0);
    const unread = await group.groups.read(alpha, group.id, { unread: true, topLevel: true });
    expect(unread).toContain("#1 · the user");
    expect(unread).toContain("#5 · the user");
    expect(unread).not.toContain("#3 · the user");
    expect(unread).toContain("(3 messages you were already shown (#2 to #4) aren't repeated; group_read with around: 2 shows them again.)");
    expect(unread).toContain("(Read position at the top level: #0 → #5.)");
  });

  it("lists unread places without reading them, and asks once before a top-level post right after a thread", async () => {
    const group = await setup(() => null);
    stop = group.stop;
    const alpha = (await group.host.bot("alpha"))!;
    expect(await group.groups.send(alpha, group.id, { text: "Topic" })).toBe("Sent as #1.");
    await group.groups.postFromUser(group.id, { text: "a detail", thread: 1 });
    await group.groups.postFromUser(group.id, { text: "@Alpha also this" });
    await settle(group);
    const inbox = await group.groups.inbox(alpha, group.id);
    expect(inbox).toMatch(/^Inbox: 2 unread places \(1 with mentions\)\. Newest activity first\.\n\ntop level · 1 unread · mentions you · latest the user just now\n  open: group_read with unread: true and top_level: true\nthread #1 · 1 unread · latest the user just now/);
    // Listing reads nothing.
    expect(group.store.pending(group.id, "alpha").map((entry) => entry.message.seq)).toEqual([2, 3]);
    expect(await group.groups.inbox(alpha, group.id)).toBe(inbox);
    await group.groups.read(alpha, group.id, {});
    await group.groups.read(alpha, group.id, { thread: 1 });
    expect(await group.groups.inbox(alpha, group.id)).toMatch(/^Inbox: nothing unread\./);
    const asked = await group.groups.send(alpha, group.id, { text: "The detail is X." });
    expect(asked).toMatch(/^Not sent: the latest place you read is thread #1/);
    // Confirmed with the saved draft, it goes to the top level.
    expect(await group.groups.sendDraft(alpha, group.id, {})).toBe("Sent as #4.");
    await group.groups.read(alpha, group.id, {});
    expect(await group.groups.send(alpha, group.id, { text: "Also Y." })).toBe("Sent as #5.");
    // A reply to a top-level message names the top level, so it isn't asked about.
    await group.groups.read(alpha, group.id, { thread: 1 });
    expect(await group.groups.send(alpha, group.id, { text: "Outcome: done.", replyTo: 1 })).toBe("Sent as #6.");
    expect((await group.groups.messages(group.id)).messages.at(-1)).toMatchObject({ seq: 6, thread: null, replyTo: 1 });
  });

  it("starts a stale seat over with a briefing of what it had seen, and a notice of what's new", async () => {
    const group = await setup(reads(() => null), ["alpha", "beta"], { recycleTokens: 0, recycleAfterMs: 0 });
    stop = group.stop;
    await group.groups.postFromUser(group.id, { text: "first thing" });
    await until(() => group.chats.list({}).length === 2 && group.idle());
    const seatOf = async () => (await group.groups.list())[0]!.seats.alpha;
    const before = await seatOf();
    await group.groups.postFromUser(group.id, { text: "second thing" });
    await until(async () => (await seatOf()) !== before && group.idle());
    const after = (await seatOf())!;
    expect(group.chats.get(before!)?.archivedAt).toBeTruthy();
    const first = group.chats.items(after, 10).find((item) => item.type === "user_message");
    const text = first && first.type === "user_message" ? first.text : "";
    expect(text).toContain("This conversation for the group was renewed");
    expect(text).toContain('<recent-messages order="newest last"');
    expect(text).toContain("first thing");
    // The old seat's last actions: it read the group.
    expect(text).toMatch(/<recent-actions span="1 of 1" order="oldest first">\n- \d\d:\d\dZ mcp__bots__group_read/);
    expect(text).toContain("- top level: 1 new (#2) · latest from the user");
    expect(text).not.toContain("second thing");
  });

  it("starts seats in the group's folder, and moves an idle seat to a new one with a briefing", async () => {
    const group = await setup(reads(() => null));
    stop = group.stop;
    const repo = await mkdtemp(join(tmpdir(), "bots-groups-repo-"));
    const other = await mkdtemp(join(tmpdir(), "bots-groups-other-"));
    try {
      await group.groups.update(group.id, { cwd: repo });
      expect((await group.groups.list())[0]!.cwd).toBe(repo);
      await group.groups.postFromUser(group.id, { text: "first thing" });
      await until(() => group.chats.list({}).length === 2 && group.idle());
      const seatOf = async () => (await group.groups.list())[0]!.seats.alpha!;
      const before = await seatOf();
      expect(group.chats.get(before)?.cwd).toBe(repo);
      // A folder that isn't there changes nothing.
      await expect(group.groups.update(group.id, { cwd: join(repo, "missing") })).rejects.toThrow("There's no folder at");
      expect((await group.groups.list())[0]!.cwd).toBe(repo);

      await group.groups.update(group.id, { cwd: other });
      expect(await group.texts()).toContainEqual(`system: 📁 the user set the group's working folder to ${other}: each bot's next turn here runs there.`);
      // The note is for the record: it wakes nobody, and the seats stay where they are until a turn.
      await settle(group);
      expect(await seatOf()).toBe(before);
      await group.groups.postFromUser(group.id, { text: "second thing" });
      await until(async () => (await seatOf()) !== before && group.idle());
      const after = await seatOf();
      expect(group.chats.get(before)?.archivedAt).toBeTruthy();
      expect(group.chats.get(after)?.cwd).toBe(other);
      const first = group.chats.items(after, 10).find((item) => item.type === "user_message");
      const text = first && first.type === "user_message" ? first.text : "";
      expect(text).toContain(`your working folder for the group is now ${other} (it was ${repo})`);
      expect(text).toContain("first thing");

      // Without the group's folder, each seat goes back to its bot's own.
      await group.groups.update(group.id, { cwd: null });
      expect((await group.groups.list())[0]!.cwd).toBeNull();
      await group.groups.postFromUser(group.id, { text: "third thing" });
      await until(async () => (await seatOf()) !== after && group.idle());
      expect(group.chats.get(await seatOf())?.cwd).toBe(join(home, "Bots", "alpha"));
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });

  it("gives the seats the group's extra folders, and resumes an idle seat with a changed list instead of starting it over", async () => {
    const group = await setup(reads(() => null));
    stop = group.stop;
    const repo = await mkdtemp(join(tmpdir(), "bots-groups-repo-"));
    const docs = await mkdtemp(join(tmpdir(), "bots-groups-docs-"));
    try {
      await expect(group.groups.update(group.id, { extraFolders: [join(repo, "missing")] })).rejects.toThrow("There's no folder at");
      await group.groups.update(group.id, { extraFolders: [repo, repo, `${repo}/sub/..`] });
      expect((await group.groups.list())[0]!.extraFolders).toEqual([repo]);
      await group.groups.postFromUser(group.id, { text: "first thing" });
      await until(() => group.chats.list({}).length === 2 && group.idle());
      const seatOf = async () => (await group.groups.list())[0]!.seats.alpha!;
      const before = await seatOf();
      // The seats' chats carry the group's list, and their sessions got it as extra directories.
      expect(group.chats.get(before)?.extraFolders).toEqual([repo]);
      expect(group.fake.sessions.map((session) => session.spec.extraDirectories)).toEqual([[repo], [repo]]);

      await group.groups.update(group.id, { extraFolders: [repo, docs] });
      expect(await group.texts()).toContainEqual(`system: 📁 the user set the group's extra folders to ${repo}, ${docs}: each bot's next turn here can use them.`);
      // Both idle sessions were closed, and nobody was woken for the note.
      expect(group.fake.sessions.map((session) => session.state)).toEqual(["closed", "closed"]);
      await settle(group);
      expect(group.chats.get(before)?.extraFolders).toEqual([repo, docs]);
      const sessions = group.fake.sessions.length;
      await group.groups.postFromUser(group.id, { text: "second thing" });
      await until(() => group.fake.sessions.length === sessions + 2 && group.idle());
      // The same seat chats, resumed on the new list: no new seat, no briefing.
      expect(await seatOf()).toBe(before);
      expect(group.chats.get(before)?.archivedAt).toBeNull();
      const resumed = group.fake.sessions.slice(sessions);
      expect(resumed.every((session) => !!session.spec.resume)).toBe(true);
      expect(resumed.map((session) => session.spec.extraDirectories)).toEqual([[repo, docs], [repo, docs]]);
      const texts = group.chats.items(before, 20).flatMap((item) => (item.type === "user_message" ? [item.text] : []));
      expect(texts.some((text) => text.includes("was renewed") || text.includes("your working folder for the group is now"))).toBe(false);

      // The group's working folder moving still starts the seats over, with a briefing. Moved onto an
      // extra folder, it leaves the list.
      await group.groups.update(group.id, { cwd: docs });
      expect((await group.groups.list())[0]!.extraFolders).toEqual([repo]);
      await group.groups.postFromUser(group.id, { text: "third thing" });
      await until(async () => (await seatOf()) !== before && group.idle());
      expect(group.chats.get(before)?.archivedAt).toBeTruthy();
      // The folder it works in is not also an extra folder for it.
      expect(group.chats.get(await seatOf())?.cwd).toBe(docs);
      expect(group.chats.get(await seatOf())?.extraFolders).toEqual([repo]);
      const last = group.fake.sessions.at(-1)!.spec.extraDirectories;
      expect(last).toContain(repo);
      expect(last).not.toContain(docs);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(docs, { recursive: true, force: true });
    }
  });

  it("lets the user claim, move along, unclaim, react to and search messages; a task's changes are noted in its thread", async () => {
    let wakes = 0;
    const group = await setup((turn, step) => {
      if (delivered(turn) && step === 0) wakes++;
      return null;
    });
    stop = group.stop;
    const seq = await group.groups.postFromUser(group.id, { text: "Draft the release notes for version two." });
    await until(() => wakes === 2 && group.idle());
    await group.groups.userTask(group.id, { action: "claim", seq });
    await expect(group.groups.userTask(group.id, { action: "claim", seq })).rejects.toThrow(/already claimed by you/);
    await group.groups.userTask(group.id, { action: "status", number: 1, status: "done" });
    await group.groups.userReact(group.id, seq, "👍");
    let [message] = (await group.groups.messages(group.id)).messages;
    expect(message!.task).toEqual({ number: 1, status: "done", assignee: { kind: "user", id: "user", name: "the user" }, revision: 2, title: "Draft the release notes for version two.", description: null, createdBy: "user", amended: null });
    expect(message!.reactions).toEqual([{ emoji: "👍", names: ["the user"], ids: ["user"] }]);
    // A second tap takes the reaction back. A done task can't be unclaimed, so it's reopened first; unclaiming
    // then leaves the status as it was (assignee and status are independent), and a second unclaim is refused;
    // removing the task leaves the message.
    await group.groups.userReact(group.id, seq, "👍");
    await group.groups.userTask(group.id, { action: "status", number: 1, status: "in_progress" });
    await group.groups.userTask(group.id, { action: "unclaim", number: 1 });
    await expect(group.groups.userTask(group.id, { action: "unclaim", number: 1 })).rejects.toThrow(/task is not assigned/);
    [message] = (await group.groups.messages(group.id)).messages;
    expect(message!.task).toMatchObject({ number: 1, status: "in_progress", assignee: null, revision: 4 });
    expect(message!.reactions).toEqual([]);
    await group.groups.userTask(group.id, { action: "delete", number: 1 });
    [message] = (await group.groups.messages(group.id)).messages;
    expect(message!.task).toBeNull();
    await expect(group.groups.userTask(group.id, { action: "status", number: 1, status: "done" })).rejects.toThrow(/isn't a task/);
    expect((await group.groups.searchMessages(group.id, "release notes")).map((hit) => hit.seq)).toContain(seq);
    expect(await group.groups.searchMessages(group.id, "nothing like this")).toEqual([]);
    // Making it a task is noted at the top level (that wakes the bots); the rest went to its thread, which they don't follow.
    expect(await group.texts()).toEqual([
      "user: Draft the release notes for version two.",
      'system: 📋 the user converted a message to task #1 "Draft the release notes for version two."',
      'system: 🗑 the user deleted #1 "Draft the release notes for version two."',
    ]);
    expect((await group.groups.messages(group.id, { thread: 1 })).messages.map((entry) => entry.text).slice(1)).toEqual([
      '📌 the user claimed #1 "Draft the release notes for version two."',
      '✅ the user moved #1 "Draft the release notes for version two." to Done',
      '🔄 the user moved #1 "Draft the release notes for version two." to In Progress',
      '🔓 the user released #1 "Draft the release notes for version two."',
    ]);
    await settle(group);
    expect(wakes).toBe(4);
  });

  it("keeps a thread's replies among its followers, and lets a bot stop following", async () => {
    const deliveries: Record<string, string[]> = { alpha: [], beta: [] };
    const group = await setup(
      reads((turn, step, botId) => {
        if (step === 0) deliveries[botId]!.push(turn.text);
        if (botId === "alpha" && step === 0 && turn.text.includes("Plan the launch")) return { tool: "group_send", args: { text: "Here's the plan: Thursday." } };
        if (botId === "beta" && step === 0 && turn.text.includes("@Beta check")) return { tool: "group_send", args: { text: "Dates look fine.", thread: 2 } };
        if (botId === "beta" && step === 1 && turn.results.at(-1)?.startsWith("Sent")) return { tool: "group_follow", args: { thread: 2, follow: false } };
        return null;
      }),
    );
    stop = group.stop;
    await group.groups.postFromUser(group.id, { text: "Plan the launch." });
    await until(async () => (await group.texts()).length >= 2);
    await settle(group);
    const counts = () => [deliveries.alpha!.length, deliveries.beta!.length];
    const before = counts();
    // A reply in the thread on Alpha's message goes to Alpha (it wrote the top message), not Beta.
    await group.groups.postFromUser(group.id, { text: "Move it to Friday.", thread: 2 });
    await settle(group);
    expect(counts()).toEqual([before[0]! + 1, before[1]]);
    expect(deliveries.alpha!.at(-1)).toContain('in thread #2 (on you: "Here\'s the plan: Thursday.")');
    // @Beta pulls Beta in; it answers in the thread, then stops following it.
    await group.groups.postFromUser(group.id, { text: "@Beta check the dates?", thread: 2 });
    await until(async () => (await group.groups.messages(group.id, { thread: 2 })).messages.some((message) => message.text === "Dates look fine."));
    await settle(group);
    // Pulled in with an @mention, Beta got the thread so far with it, and that counts as read there.
    expect(deliveries.beta!.at(-1)).toContain("[Thread context: you were @mentioned in thread #2, which you haven't read.]");
    expect(deliveries.beta!.at(-1)).toContain("Move it to Friday.");
    expect(group.store.followers(group.id, 2).sort()).toEqual(["alpha", "user"]);
    const alphaBot = (await group.host.bot("alpha"))!;
    expect(await group.groups.follow(alphaBot, group.id, { list: true })).toMatch(/^Followed threads \(1\):\n- thread #2 on you: "Here's the plan: Thursday\." \(followed since .+Z, reason=authored\)$/);
    // The user follows the thread they posted in: Beta's reply there is unread for them until they read it.
    expect((await group.groups.list())[0]!.unreadThreads).toEqual([2]);
    await group.groups.markRead(group.id, 5, 2);
    expect((await group.groups.list())[0]!.unreadThreads).toEqual([]);
    const mid = counts();
    await group.groups.postFromUser(group.id, { text: "Thanks, both.", thread: 2 });
    await settle(group);
    expect(counts()).toEqual([mid[0]! + 1, mid[1]]);
    // The top level shows the thread as a count; the thread lists its top message and replies.
    const top = (await group.groups.messages(group.id)).messages;
    expect(top.map((message) => message.text)).toEqual(["Plan the launch.", "Here's the plan: Thursday."]);
    expect(top[1]).toMatchObject({ replies: 5 });
    const thread = (await group.groups.messages(group.id, { thread: 2 })).messages.map((message) => message.text);
    // Beta's unfollow is noted in the thread, for nobody's unread.
    expect(thread).toEqual(["Here's the plan: Thursday.", "Move it to Friday.", "@Beta check the dates?", "Dates look fine.", "@Beta stopped following this thread: no longer following", "Thanks, both."]);
    expect(group.store.unreadPlaces(group.id, "user").map((place) => place.conv)).not.toContain(2);
    // Nothing in the thread Beta left reached it.
    expect(group.store.unreadPlaces(group.id, "beta")).toEqual([]);
    expect(group.store.pending(group.id, "beta")).toEqual([]);
  });

  it("checks what's new where a bot posts, claims only top-level messages, and makes a newcomer to a thread read it", async () => {
    const group = await setup(reads(() => null));
    stop = group.stop;
    const beta = (await group.host.bot("beta"))!;
    await group.groups.postFromUser(group.id, { text: "Question one." });
    await until(async () => group.idle() && group.store.pending(group.id, "beta").length === 0);
    await group.groups.postFromUser(group.id, { text: "@Alpha more detail?", thread: 1 });
    await settle(group);
    // A thread Beta isn't in doesn't hold its top-level post...
    expect(await group.groups.send(beta, group.id, { text: "Top-level answer." })).toMatch(/^Sent as #3\./);
    // ...but posting in that thread first shows its latest messages.
    const held = await group.groups.send(beta, group.id, { text: "Me too.", thread: 1 });
    expect(held).toMatch(/^Your message wasn't sent: you haven't read thread #1 yet\. Its latest messages:/);
    expect(held).toContain("@Alpha more detail?");
    expect(await group.groups.sendDraft(beta, group.id, {})).toMatch(/^Sent as #4 in thread #1\./);
    // Replying to a thread message puts the reply in its thread.
    expect(await group.groups.send(beta, group.id, { text: "Following up.", replyTo: 2 })).toMatch(/in thread #1\./);
    await expect(group.groups.claim(beta, group.id, 2)).rejects.toThrow(/Only top-level messages can be tasks/);
    const claimed = await group.groups.claim(beta, group.id, 1);
    expect(claimed).toMatch(/^You've claimed task #1;/);
    expect(claimed).toContain("When the work is done, set it to done with group_task (action update) and say in the group what you did.");
    expect(await group.groups.task(beta, group.id, { action: "update", task: 1, status: "done" })).toBe("Task #1 is now done. Say in the group what you did.");
  });

  it("runs tasks: creating one with an assignee tells a muted bot, which claims it; status changes go to its thread", async () => {
    const group = await setup(
      reads((turn, step, botId) => {
        if (botId !== "beta") return null;
        const last = turn.results.at(-1) ?? "";
        if (step === 0 && turn.text.includes("Assigned @Beta")) return { tool: "group_claim", args: { task: 1 } };
        // A first claim may be held for messages Beta never saw; then it claims again.
        if (last.startsWith("Your claim wasn't made")) return { tool: "group_claim", args: { task: 1 } };
        if (last.startsWith("You've claimed")) return { tool: "group_task", args: { action: "update", task: 1, status: "done" } };
        return null;
      }),
    );
    stop = group.stop;
    await group.groups.setMuted(group.id, "beta", true);
    const alpha = (await group.host.bot("alpha"))!;
    expect(await group.groups.task(alpha, group.id, { action: "create", titles: ["Write the intro"], assignee: "Beta" })).toBe("Created task #1, todo, assigned to Beta.");
    expect((await group.texts()).at(-1)).toBe('system: 📌 Assigned @Beta to task #1 "Write the intro"');
    await until(() => group.store.task(group.id, { number: 1 })?.status === "done" && group.idle(), 5_000);
    const seat = (await group.groups.list())[0]!.seats.beta!;
    const wake = group.chats.items(seat, 20).find((item) => item.type === "user_message");
    expect(wake && wake.type === "user_message" ? wake.text : "").toContain("a task was assigned to you");
    expect(group.store.task(group.id, { number: 1 })).toMatchObject({ status: "done", assignee: { id: "beta" } });
    expect((await group.groups.messages(group.id, { thread: 1 })).messages.at(-1)!.text).toBe('✅ Beta moved #1 "Write the intro" to Done');
    // A bot follows the allowed transitions (todo can't jump to done); the user may set any status.
    await group.groups.read(alpha, group.id, {});
    await group.groups.userTask(group.id, { action: "status", number: 1, status: "todo" });
    expect(await group.groups.task(alpha, group.id, { action: "update", task: 1, status: "done" })).toMatch(/can't go from todo to done/);
    // Created with its assignee in one go, so it starts at rev=0.
    expect(await group.groups.task(alpha, group.id, { action: "list", filter: "all" })).toContain("- task #1 · todo · Beta · rev=3: Write the intro");
    expect(await group.groups.claim(alpha, group.id, 1)).toMatch(/Claim refused for task #1: already assigned to Beta/);
    // Assigning moves ownership without starting the work, and a stale view loses instead of overwriting.
    expect(await group.groups.task(alpha, group.id, { action: "assign", task: 1, assignee: "me", expectedRevision: 2 })).toMatch(/^Not assigned: task #1 changed since you read it; it's now task #1 · todo · Beta, rev=3\./);
    expect(await group.groups.task(alpha, group.id, { action: "assign", task: 1, assignee: "me", expectedRevision: 3 })).toBe("Task #1 is assigned to you, still todo (rev=4); claim it with group_claim when you start.");
    await group.groups.userTask(group.id, { action: "status", number: 1, status: "closed" });
    expect(await group.groups.claim((await group.host.bot("beta"))!, group.id, 1)).toMatch(/task is closed; reopen it before claiming/);
  });

  it("keeps task cards: any member amends, show and history read them, and only the creator or the user deletes one", async () => {
    const group = await setup(() => null);
    stop = group.stop;
    const alpha = (await group.host.bot("alpha"))!;
    const beta = (await group.host.bot("beta"))!;
    await group.groups.postFromUser(group.id, { text: "Write the intro" });
    expect(await group.groups.task(alpha, group.id, { action: "convert", task: 1 })).toBe("#1 is now task #1, todo and unassigned.");
    // Beta, reviewing, adds acceptance criteria; the change and its revision come back.
    expect(await group.groups.task(beta, group.id, { action: "amend", task: 1, title: "Write the intro (300 words)", description: "Plain English." })).toBe(
      "#1 amended — revision 1, event seq 2.\ntitle: Write the intro (300 words)\ndetails:\n  Plain English.",
    );
    expect(await group.groups.task(beta, group.id, { action: "amend", task: 1, title: "Write the intro (300 words)" })).toBe("Not amended: task amendment makes no changes.");
    await expect(group.groups.task(beta, group.id, { action: "amend", task: 1 })).rejects.toThrow(/At least one amendment is required/);
    await expect(group.groups.task(beta, group.id, { action: "amend", task: 1, description: "x", clearDescription: true })).rejects.toThrow(/not both/);
    expect(await group.groups.task(alpha, group.id, { action: "show", task: 1 })).toBe("task #1 · todo · unassigned · rev=1 · made a task by you\nCurrent title: Write the intro (300 words)\nCurrent description: Plain English.");
    expect(await group.groups.task(alpha, group.id, { action: "list" })).toBe("- task #1 · todo · unassigned · rev=1: Write the intro (300 words)\n  Current description: Plain English.");
    // The message keeps its words; reading it shows the card that supersedes them.
    const read = await group.groups.read(alpha, group.id, { around: 1 });
    expect(read).toContain("\nWrite the intro\n[task #1 amended: the card supersedes this message's text (rev=1, by Beta, ");
    expect(read).toContain("Current title: Write the intro (300 words)\nCurrent description: Plain English.");
    const history = await group.groups.task(beta, group.id, { action: "history", task: 1 });
    expect(history).toMatch(/^## Task #1 history — revision 1\n\nCurrent title: Write the intro \(300 words\)\nCurrent description: Plain English\.\n\nseq=1 time=\S+ \S+ actor=@Alpha type=created\n {2}\{"taskNumber":1,"status":"todo","convertedFromMessage":true\}\n/);
    expect(history).toContain('actor=you type=amended\n  {"revision":1,"changes":{"title":{"from":"Write the intro","to":"Write the intro (300 words)"},"description":{"from":null,"to":"Plain English."}}}');
    // Only the bot that made it a task, or the user, may delete it; closing it is the alternative.
    expect(await group.groups.task(beta, group.id, { action: "delete", task: 1 })).toMatch(/^Not deleted: only the task's creator \(Alpha\) or the user can delete task #1\. Ask one of them, or close it instead/);
    expect(await group.groups.task(alpha, group.id, { action: "delete", task: 1 })).toBe("#1 deleted. Its message stays.");
    expect((await group.texts()).at(-1)).toBe('system: 🗑 Alpha deleted #1 "Write the intro (300 words)"');
    expect(group.store.task(group.id, { number: 1 })).toBeNull();
    // The user may amend and delete any task.
    await group.groups.userTask(group.id, { action: "convert", seq: 1 });
    await group.groups.userTask(group.id, { action: "amend", number: 1, description: "For the launch post." });
    expect(group.store.task(group.id, { number: 1 })).toMatchObject({ title: "Write the intro", description: "For the launch post.", createdBy: "user", amended: { by: "the user" } });
    await group.groups.userTask(group.id, { action: "amend", number: 1, description: null });
    expect(group.store.task(group.id, { number: 1 })).toMatchObject({ description: null, revision: 2 });
    await group.groups.userTask(group.id, { action: "delete", number: 1 });
    expect(group.store.task(group.id, { number: 1 })).toBeNull();
  });

  it("says which @mentions reached nobody, and shows a bot what happened to each member it @mentioned", async () => {
    let rateLimited = false;
    const group = await setup(
      (turn, step, botId) => {
        if (botId === "beta" && rateLimited && delivered(turn)) throw new Error("429 Too Many Requests");
        return null;
      },
      ["alpha", "beta", "delta"],
      {},
      ["gamma"],
    );
    stop = group.stop;
    const [alpha, beta] = [(await group.host.bot("alpha"))!, (await group.host.bot("beta"))!];
    const delivery = (seq: number) => group.groups.mentionDelivery(alpha, group.id, seq);
    await group.groups.setMuted(group.id, "delta", true);
    const sent = await group.groups.send(alpha, group.id, { text: "@Beta please check the build, and @Gamma and @Zed too." });
    expect(sent).toMatch(/^Sent as #1\.\n\nUndelivered mentions — partial result\nThe message was sent: don't send it again/);
    expect(sent).toContain("- @Gamma — not in this group\n  consequence: this @mention didn't notify anyone.\n  recovery: only the user can add Gamma to this group. To reach Gamma now, use ask_bot");
    expect(sent).toContain("- @Zed — no bot by that name\n  consequence: this @mention didn't notify anyone.");
    // Beta's seat took the notice but Beta hasn't read #1; muted Delta got no record at all.
    await settle(group);
    expect(await delivery(1)).toBe(
      [
        "Message #1 — mention delivery per target",
        "",
        "  @Beta: still in flight — do not conclude yet (its seat has the notice; not read yet)",
        "",
        "Also delivered to:",
        "  the user: delivered, not read yet",
        "",
        "Not delivered to (muted, or not following its thread): Delta",
      ].join("\n"),
    );
    await group.groups.read(beta, group.id, { unread: true });
    await group.groups.markRead(group.id, 1);
    expect(await delivery(1)).toMatch(/^Message #1 — mention delivery per target\n\n {2}@Beta: delivered\n\nAlso delivered to:\n {2}the user: read\n/);
    // Only the asker's own messages; someone else's reads like one that doesn't exist.
    await expect(group.groups.mentionDelivery(beta, group.id, 1)).rejects.toThrow(/#1 isn't a message you sent/);
    await expect(group.groups.mentionDelivery(alpha, group.id, 99)).rejects.toThrow(/#99 isn't a message you sent/);

    // The turn Beta was told in failed on a rate limit: lost, rate limited.
    rateLimited = true;
    expect(await group.groups.send(alpha, group.id, { text: "@Beta one more thing" })).toBe("Sent as #2.");
    await settle(group);
    expect(await delivery(2)).toContain("  @Beta: LOST — target is rate/quota limited; it will not arrive, re-route or retry later");
    expect((await group.texts()).at(-1)).toBe("system: Beta's turn failed: 429 Too Many Requests");

    // A bot whose seat can't start (its runtime is missing) is noted; a mention that comes while its
    // seat waits to be tried again stays in flight (it waits out the spawn-fail backoff).
    // group-delivery.test.ts has it lost once the next try fails too.
    (await group.host.bot("gamma"))!.provider = "missing";
    await group.groups.update(group.id, { memberIds: ["alpha", "beta", "delta", "gamma"] });
    await settle(group);
    await group.groups.read(alpha, group.id, {});
    const welcome = Number(/^Sent as #(\d+)\.$/.exec(await group.groups.send(alpha, group.id, { text: "@Gamma welcome" }))?.[1]);
    await settle(group);
    expect(await delivery(welcome)).toContain("  @Gamma: still in flight — do not conclude yet (not told yet: its seat is busy or starting)");
    expect(await group.texts()).toContain("system: Gamma couldn't join: missing isn't available here.");

    // A member that leaves before reading a mention won't get it.
    await group.groups.read(alpha, group.id, {});
    const ping = Number(/^Sent as #(\d+)\.$/.exec(await group.groups.send(alpha, group.id, { text: "@Delta ping" }))?.[1]);
    await settle(group);
    expect(await delivery(ping)).toContain("  @Delta: still in flight — do not conclude yet");
    await group.groups.update(group.id, { memberIds: ["alpha", "beta", "gamma"] });
    expect(await delivery(ping)).toContain("  @Delta: LOST — cause is outside the seat-availability set; re-route");
  });

  it("sends a user's message as a task without a note, at the top level only", async () => {
    const group = await setup(() => null);
    stop = group.stop;
    const seq = await group.groups.postFromUser(group.id, { text: "Draft the launch post.", asTask: true });
    expect(group.store.task(group.id, { seq })).toMatchObject({ number: seq, status: "todo", assignee: null });
    expect(await group.texts()).toEqual(["user: Draft the launch post."]);
    await expect(group.groups.postFromUser(group.id, { text: "a detail", thread: seq, asTask: true })).rejects.toThrow(/Only top-level messages can be tasks/);
    await settle(group);
  });

  it("notes members joining and leaving for the bots to read", async () => {
    const group = await setup(() => null, ["alpha", "beta", "gamma"]);
    stop = group.stop;
    await group.groups.update(group.id, { memberIds: ["alpha", "beta"] });
    await settle(group);
    expect(await group.texts()).toEqual(["system: Gamma left the group."]);
    expect(group.store.unreadPlaces(group.id, "alpha")).toEqual([expect.objectContaining({ conv: 0, count: 1 })]);
    // The user caused it: not unread for them.
    expect((await group.groups.list())[0]!.unread).toBe(false);
  });

  it("after a restart, gives each seat with unread messages a catch-up batch: the messages themselves", async () => {
    const wakes: string[] = [];
    const group = await setup((turn, step, botId) => {
      if (delivered(turn) && step === 0) wakes.push(`${botId}:${turn.text}`);
      return null;
    });
    stop = group.stop;
    await group.groups.postFromUser(group.id, { text: "@Alpha are you there?" });
    await until(() => wakes.length === 2 && group.idle());
    // Neither read it; a new notice isn't sent for the same messages, until pocket-bots starts again.
    group.groups.resume();
    await until(() => wakes.length === 4 && group.idle());
    const alpha = wakes.filter((wake) => wake.startsWith("alpha:")).at(-1)!;
    expect(alpha).toContain("New message received while pocket-bots was stopped:");
    expect(alpha).toContain("@Alpha are you there?");
    expect(alpha).toContain("Respond as appropriate. Complete all your work before stopping.");
    expect(alpha).not.toContain("Group inbox notice");
    // Handed over in full, the batch counts as seen, and it leaves the inbox.
    await settle(group);
    expect(group.store.pending(group.id, "alpha")).toEqual([]);
    expect(group.store.cursor(group.id, "alpha", 0)).toBe(1);
  });

  it("fires a bot's reminder to that bot alone, and one missed while stopped as a catch-up", async () => {
    const wakes: string[] = [];
    const group = await setup((turn, step, botId) => {
      if (!delivered(turn)) return null;
      if (step === 0) wakes.push(`${botId}:${turn.text}`);
      // Woken by its reminder, Alpha catches up and tells Beta: a reminder never wakes anyone else.
      if (botId === "alpha" && turn.text.includes("🔔 Reminder") && !turn.text.includes("standup")) {
        if (step === 0) return { tool: "group_read", args: { unread: true } };
        if (step === 1) return { tool: "group_send", args: { text: "@Beta the build should be done: can you check it?" } };
      }
      return null;
    });
    stop = group.stop;
    await group.groups.postFromUser(group.id, { text: "Kick off the build." });
    await settle(group);
    wakes.length = 0;
    const alpha = (await group.host.bot("alpha"))!;
    const receipt = await group.groups.reminder(alpha, group.id, { action: "schedule", title: "check the build", message: 1, delaySeconds: 1 });
    expect(receipt).toMatch(/^Reminder scheduled: #([0-9a-f]{8}) \(one-time\) "check the build"\nNext: \S+\n\(to modify: snooze\/update\/cancel; group_reminder\)$/);
    const id = /#([0-9a-f]{8})/.exec(receipt)![1]!;
    expect(await group.groups.reminder(alpha, group.id, { action: "list" })).toMatch(new RegExp(`^#${id} \\[scheduled\\] \\(one-time\\) next=\\S+ "check the build" ref=#1$`));
    // Beta can't see or change it.
    const beta = (await group.host.bot("beta"))!;
    expect(await group.groups.reminder(beta, group.id, { action: "list" })).toBe("No reminders.");
    await expect(group.groups.reminder(beta, group.id, { action: "cancel", id })).rejects.toThrow(/No scheduled\/fired reminder of yours matches/);
    await until(() => wakes.some((wake) => wake.startsWith("alpha:")), 4_000);
    await settle(group);
    const wake = wakes.find((text) => text.startsWith("alpha:"))!;
    expect(wake).toContain(`🔔 Reminder #${id} (one-time) — #1 — "check the build"\n(to snooze/cancel: group_reminder)`);
    expect(wake).not.toContain("Group inbox notice");
    // Beta hears only Alpha's @mention, as an ordinary notice.
    const betaWakes = wakes.filter((text) => text.startsWith("beta:"));
    expect(betaWakes).toEqual([expect.stringContaining("latest from Alpha (bot) · Alpha handed you work with an @mention")]);
    expect(betaWakes[0]).not.toContain("🔔");
    expect(await group.groups.reminder(alpha, group.id, { action: "list" })).toMatch(/\[fired\] \(one-time\) fired_at=/);
    await expect(group.groups.reminder(alpha, group.id, { action: "update", id, title: "x" })).rejects.toThrow(`Reminder #${id} is fired; snooze it back to scheduled before updating, or schedule a new reminder`);

    // A recurring one comes due while pocket-bots is stopped: on start it fires once, as a catch-up.
    wakes.length = 0;
    const recurring = await group.groups.reminder(alpha, group.id, { action: "schedule", title: "standup", message: 1, repeat: "every:1h", tz: "UTC" });
    const second = /#([0-9a-f]{8})/.exec(recurring)![1]!;
    group.groups.close();
    const found = group.store.findReminder(group.id, "alpha", second);
    group.store.updateReminder(found.ok ? found.reminder.id : "", { fireAt: new Date(Date.now() - 2 * 3600_000) }, "test");
    group.groups.resume();
    await until(() => wakes.some((text) => text.startsWith("alpha:")), 4_000);
    expect(wakes.find((text) => text.startsWith("alpha:"))).toMatch(new RegExp(`🔔 Reminder #${second} \\(catchup · recurring\\) — #1 — "standup"\\nNext iteration: `));
    await settle(group);
    expect(await group.groups.reminder(alpha, group.id, { action: "log", id: second })).toMatch(/^\S+ FIRED by system next=\S+\n\S+ UPDATED by test next=\S+\n\S+ SCHEDULED by Alpha next=\S+$/);
    expect(await group.groups.reminder(alpha, group.id, { action: "cancel", id: second })).toBe(`Reminder canceled: #${second} [canceled] "standup"`);
  });
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("a bot's replies in a group: files and questions", () => {
  it("attaches a bot's files, text first: kept in the group's folder, shown with its message, and given to a bot pulled in with it", async () => {
    const { groupFilesPath } = await import("../src/server/groups");
    const dir = await mkdtemp(join(tmpdir(), "bots-files-"));
    await writeFile(join(dir, "report.md"), "# Findings\nAll green.");
    await writeFile(join(dir, "shot.png"), Buffer.from(PNG, "base64"));
    const results: string[] = [];
    const betaWakes: string[] = [];
    const group = await setup((turn, step, botId) => {
      if (!delivered(turn)) return null;
      if (botId === "beta") {
        if (step === 0) betaWakes.push(turn.text);
        return null;
      }
      if (step === 0 && turn.text.includes("top level: 1 new (#1)")) return { tool: "group_send", args: { thread: 1, text: "The report and a screenshot. @Beta can you check them?", files: [join(dir, "report.md"), join(dir, "shot.png")] } };
      if (step === 1) results.push(turn.results[0] ?? "");
      return null;
    });
    stop = group.stop;
    await group.groups.postFromUser(group.id, { text: "Plan the launch." });
    await until(() => betaWakes.some((text) => text.includes("[Thread context:")) && group.idle());
    expect(results).toEqual(["Sent as #2 in thread #1 with report.md, shot.png attached."]);
    const [message] = (await group.groups.messages(group.id, { thread: 1 })).messages.filter((entry) => entry.seq === 2);
    expect(message!.attachments.map((file) => [file.name, file.kind, file.mimeType])).toEqual([
      ["report.md", "text", "text/markdown"],
      ["shot.png", "image", "image/png"],
    ]);
    // Kept in the group's files folder as sent, like the user's attachments.
    for (const file of message!.attachments) expect(file.path.startsWith(groupFilesPath(group.id))).toBe(true);
    expect(await readFile(message!.attachments[0]!.path, "utf8")).toBe("# Findings\nAll green.");
    // Beta, pulled into the thread, gets the message with its files: the text one inline, and each one's path.
    const joined = betaWakes.find((text) => text.includes("[Thread context:"))!;
    expect(joined).toContain(`[Attached: report.md (text, ${message!.attachments[0]!.path}); shot.png (image, ${message!.attachments[1]!.path})]`);
    expect(joined).toContain('<attachment name="report.md">\n# Findings\nAll green.\n</attachment>');

    const alpha = (await group.host.bot("alpha"))!;
    await expect(group.groups.send(alpha, group.id, { text: " ", files: [join(dir, "report.md")] })).rejects.toThrow(/Write the message too/);
    await expect(group.groups.send(alpha, group.id, { text: "See this.", thread: 1, files: [join(dir, "missing.md")] })).rejects.toThrow(`There's no file at ${join(dir, "missing.md")}.`);
    await expect(group.groups.send(alpha, group.id, { text: "See this.", thread: 1, files: [dir] })).rejects.toThrow(/isn't a file/);
    await expect(group.groups.send(alpha, group.id, { text: "See this.", thread: 1, files: Array.from({ length: 7 }, () => join(dir, "report.md")) })).rejects.toThrow(/at most 6 files/);

    // A held post keeps its files with its draft, and sending the draft attaches them.
    await group.groups.postFromUser(group.id, { text: "Any news?" });
    await settle(group);
    const held = await group.groups.send(alpha, group.id, { text: "Here's the summary.", files: [join(dir, "report.md")] });
    expect(held).toMatch(/^Your message wasn't sent/);
    expect(group.store.draft(group.id, "alpha", 0)).toMatchObject({ text: "Here's the summary.", files: [join(dir, "report.md")] });
    expect(await group.groups.sendDraft(alpha, group.id, {})).toMatch(/^Sent as #\d+ with report\.md attached\.$/);
    expect((await group.groups.messages(group.id)).messages.at(-1)!.attachments.map((file) => file.name)).toEqual(["report.md"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("shows a bot's question in the group as its own, reaching no inbox, and sends the user's answer back to that bot", async () => {
    const { groupQuestion, messageText } = await import("../src/shared/group-chat");
    const colour = { name: "AskUserQuestion", kind: "question" as const, input: { questions: [{ question: "Which colour?", header: "Colour", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] } };
    const group = await setup(
      reads((turn, step, botId) => {
        if (botId !== "alpha" || !/Pick a colour|Pick again|Secret/.test(turn.text)) return null;
        if (step === 0) return { ask: turn.text.includes("Secret") ? { ...colour, metadata: { secret: true } } : colour };
        if (step === 1) {
          const decision = JSON.parse(turn.results[0]!) as { behavior: string; updatedInput?: { answers: Record<string, string> } };
          return { tool: "group_send", args: { text: decision.behavior === "allow" ? `Going with ${decision.updatedInput!.answers.Colour}.` : "No answer: going with Red." } };
        }
        return null;
      }),
    );
    stop = group.stop;
    const question = async () => (await group.groups.messages(group.id)).messages.filter((message) => message.question).at(-1) ?? null;
    await group.groups.postFromUser(group.id, { text: "@Alpha Pick a colour for the logo." });
    await until(async () => (await question())?.question?.status === "pending");
    const asked = (await question())!;
    expect(asked).toMatchObject({ seq: 2, from: { kind: "bot", botId: "alpha" }, text: "Which colour? (one of: Red / Blue)" });
    const seat = group.store.member(group.id, "alpha")!.seat_chat_id!;
    expect(asked.question).toMatchObject({ chatId: seat, status: "pending", answers: null });
    // The seat's approval is the group's question, so the group doesn't also point at the seat for it.
    const waiting = group.chats.get(seat)!.pendingPermissions;
    expect(waiting.map((request) => request.kind)).toEqual(["question"]);
    expect(groupQuestion(waiting[0]!)).not.toBeNull();
    // It's for the user: no bot's inbox gets it, so it wakes and holds nobody. (Alpha waits for the answer meanwhile.)
    await until(() => {
      const betaSeat = group.store.member(group.id, "beta")?.seat_chat_id;
      return !!betaSeat && group.chats.get(betaSeat)?.status !== "running";
    });
    expect(group.store.pending(group.id, "beta").map((entry) => entry.message.seq)).not.toContain(2);
    // What holds a post after a bot's boundary is its delivery records: the question isn't one.
    expect(group.store.freshnessRows(group.id, "beta", 0, 1)).not.toContain(2);

    await group.groups.answer(group.id, 2, { behavior: "allow", updatedInput: { answers: { Colour: "Blue" } } });
    await until(async () => (await group.texts()).includes("alpha: Going with Blue."));
    expect((await question())!.question).toMatchObject({ status: "answered", answers: ["Blue"] });
    await expect(group.groups.answer(group.id, 2, { behavior: "allow", updatedInput: { answers: { Colour: "Red" } } })).rejects.toThrow("That question was already answered.");
    await expect(group.groups.answer(group.id, 1, { behavior: "deny" })).rejects.toThrow("#1 isn't a question.");
    // Bots reading the group see the question and its answer.
    expect(messageText((await question())!, "beta")).toBe(`#2 · Alpha (bot) · ${(await question())!.at.slice(0, 16).replace("T", " ")}Z\nWhich colour? (one of: Red / Blue)\n[A question for the user: the user answered "Blue"]`);
    await settle(group);

    // Answered in the seat instead (dismissed there): the group's question follows.
    await group.groups.postFromUser(group.id, { text: "@Alpha Pick again." });
    await until(async () => (await question())!.seq > 2 && (await question())!.question!.status === "pending");
    const again = (await question())!;
    await group.chats.respond(seat, again.question!.requestId, { behavior: "deny", message: "Dismissed by user" });
    await until(async () => (await group.texts()).includes("alpha: No answer: going with Red."));
    expect((await group.groups.messages(group.id)).messages.find((message) => message.seq === again.seq)!.question!.status).toBe("dismissed");
    await settle(group);

    // Its turn ends before an answer: the question closes, and a late answer says so.
    await group.groups.postFromUser(group.id, { text: "@Alpha Pick a colour once more." });
    await until(async () => (await question())!.seq > again.seq && (await question())!.question!.status === "pending");
    const late = (await question())!;
    await group.chats.interrupt(seat);
    await until(async () => (await group.groups.messages(group.id)).messages.find((message) => message.seq === late.seq)!.question!.status === "closed");
    await expect(group.groups.answer(group.id, late.seq, { behavior: "allow", updatedInput: { answers: { Colour: "Red" } } })).rejects.toThrow("That question is no longer waiting for an answer.");
    await settle(group);

    // A secret question stays in the seat: the group shows nothing of it.
    const before = (await group.groups.messages(group.id)).messages.length;
    await group.groups.postFromUser(group.id, { text: "@Alpha Secret question time." });
    await until(() => (group.chats.get(seat)?.pendingPermissions.length ?? 0) > 0);
    expect(groupQuestion(group.chats.get(seat)!.pendingPermissions[0]!)).toBeNull();
    expect((await group.groups.messages(group.id)).messages.length).toBe(before + 1);
    await group.chats.interrupt(seat);
    await settle(group);
  });

  it("closes a question left waiting when pocket-bots restarts", async () => {
    const group = await setup(() => null);
    stop = group.stop;
    group.store.append(group.id, { kind: "bot", botId: "alpha", name: "Alpha" }, { text: "Which colour?", subtype: "bot.question", causalActor: "alpha", question: { chatId: "gone", requestId: "r1", input: { questions: [{ question: "Which colour?", header: "Colour", options: [] }] }, status: "pending", answers: null, settledAt: null } });
    group.groups.resume();
    const [message] = (await group.groups.messages(group.id)).messages;
    expect(message!.question).toMatchObject({ status: "closed", answers: null });
    expect(group.store.pendingQuestions()).toEqual([]);
  });
});


describe("a group with a leader", () => {
  it("wakes only the leader for open messages, and a member only for what the leader or the user hands it", async () => {
    const woken: string[] = [];
    const prompts = new Map<string, string>();
    const group = await setup(
      (turn, step, botId) => {
        if (step === 0 && delivered(turn)) {
          woken.push(botId);
          prompts.set(botId, turn.spec.systemPrompt);
        }
        return null;
      },
      ["alpha", "beta", "gamma"],
      {},
      ["delta"],
    );
    stop = group.stop;
    await group.groups.update(group.id, { leaderId: "alpha" });
    // Telling every member about the new leader is the one message they all get.
    expect((await group.texts()).at(-1)).toContain("👑 the user made @Alpha the group's leader");
    await settle(group);
    expect(woken.sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(prompts.get("alpha")).toContain("You lead this group:");
    expect(prompts.get("alpha")).toMatch(/- Beta: .*runs on/);
    expect(prompts.get("beta")).toContain("This group has a leader, Alpha.");
    expect(prompts.get("beta")).not.toContain("claim the ones that fit your skills");
    // A member is told only of the tools it's listed.
    expect(prompts.get("beta")).toContain('Your own tools come from the MCP server "bots": the group tools above, and search_chats');
    expect(prompts.get("beta")).not.toContain("propose_changes");
    // No seat proposes setup changes, the leader's neither: that's for the bot's own chats.
    expect(prompts.get("alpha")).not.toContain("propose_changes");
    expect(prompts.get("alpha")).toContain("Setup changes, routines and skills aren't proposed from a group");
    expect((await group.groups.list())[0]!.leaderId).toBe("alpha");

    // The leader is listed every tool but the setup ones; a member only those for its piece, though a call to another still runs.
    const { answerMcp } = await import("../src/server/tools/mcp");
    const { BOT_TOOLS } = await import("../src/server/tools");
    const seat = async (botId: string) => ({ bot: (await group.host.bot(botId))!, agentId: "seat", host: group.host, relay: null as never, groups: group.groups, groupId: group.id });
    const listed = async (botId: string) => ((await answerMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, BOT_TOOLS, await seat(botId))) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    const setupTools = ["get_setup", "propose_skill", "propose_routine", "propose_changes"];
    expect(await listed("alpha")).toEqual(BOT_TOOLS.map((tool) => tool.name).filter((name) => !setupTools.includes(name)));
    expect(await listed("beta")).toEqual(["group_send", "group_send_draft", "group_read", "group_claim", "group_react", "group_members", "search_chats"]);
    const tasks = (await answerMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "group_task", arguments: { action: "list" } } }, BOT_TOOLS, await seat("beta"))) as { result: { isError?: boolean } };
    expect(tasks.result.isError).toBeUndefined();

    woken.length = 0;
    const ask = await group.groups.postFromUser(group.id, { text: "Add a dark mode." });
    await settle(group);
    expect(woken).toEqual(["alpha"]);

    // A member can't claim work nobody handed it, or hand work to another member.
    const alpha = (await group.host.bot("alpha"))!;
    const beta = (await group.host.bot("beta"))!;
    expect(await group.groups.claim(beta, group.id, ask)).toContain("Claim refused");
    await expect(group.groups.task(beta, group.id, { action: "create", titles: ["find the theme files"], assignee: "Gamma" })).rejects.toThrow(/Alpha hands out the work/);
    await group.groups.read(beta, group.id, { unread: true });
    await group.groups.read(beta, group.id, { topLevel: true });
    // A member asks another directly: the question reaches Gamma and doesn't wake the leader.
    const sent = await group.groups.send(beta, group.id, { text: "@Gamma where are the theme files? @Delta might know." });
    expect(sent).not.toContain("takes work only");
    // A member has no ask_bot, so it isn't pointed to one for a bot outside the group.
    expect(sent).toContain("- @Delta — not in this group");
    expect(sent).not.toContain("ask_bot");
    await settle(group);
    expect(woken).toEqual(["alpha", "gamma"]);
    // A member's @everyone reaches only the leader, and the member is told so.
    const everyone = await group.groups.send(beta, group.id, { text: "@everyone where are the theme files?" });
    expect(everyone).toContain("- @everyone — from a member, it reaches only the leader, Alpha");
    await settle(group);
    expect(woken).toEqual(["alpha", "gamma", "alpha"]);

    woken.length = 0;
    await group.groups.read(alpha, group.id, { unread: true });
    await group.groups.read(alpha, group.id, { topLevel: true });
    const handoff = await group.groups.send(alpha, group.id, { text: "@Beta implement dark mode in styles.css; report back with the files you changed." });
    const seq = Number(/#(\d+)/.exec(handoff)![1]);
    await settle(group);
    expect(woken).toEqual(["beta"]);
    await group.groups.read(beta, group.id, { unread: true });
    expect(await group.groups.claim(beta, group.id, seq)).toContain("You've claimed task");
    // Only the leader moves a task's status, even when the member calls the unlisted tool.
    await expect(group.groups.task(beta, group.id, { action: "update", task: seq, status: "done" })).rejects.toThrow(/In this group Alpha sets task statuses: you can't change them/);
    expect(group.store.task(group.id, { number: seq })!.status).toBe("in_progress");
    // The leader sets the piece done after checking it; it didn't do the work, so it isn't told to say what it did.
    expect(await group.groups.task(alpha, group.id, { action: "update", task: seq, status: "done" })).toBe(`Task #${seq} is now done.`);

    // Without a leader, every bot hears the group again.
    await group.groups.update(group.id, { leaderId: null });
    expect((await group.texts()).at(-1)).toContain("removed the group's leader");
  });
});

describe("a led member's pieces of work", () => {
  it("starts each new piece in a fresh session, and comes back to an old one with its thread as the context", async () => {
    const wakes: { chat: string; text: string }[] = [];
    const group = await setup(
      (turn, step, botId) => {
        if (step === 0 && delivered(turn) && botId === "beta") wakes.push({ chat: turn.spec.key, text: turn.text });
        return null;
      },
      ["alpha", "beta"],
    );
    stop = group.stop;
    await group.groups.update(group.id, { leaderId: "alpha" });
    await settle(group);
    const alpha = (await group.host.bot("alpha"))!;
    const beta = (await group.host.bot("beta"))!;
    /** The leader reads what's new, then speaks: at the top level, or in a piece's thread. */
    const lead = async (text: string, thread?: number) => {
      await group.groups.read(alpha, group.id, { unread: true });
      await group.groups.read(alpha, group.id, thread ? { thread } : { topLevel: true });
      const sent = await group.groups.send(alpha, group.id, { text, ...(thread ? { thread } : {}) });
      expect(sent).toMatch(/^Sent as #\d+/);
      await settle(group);
      return Number(/#(\d+)/.exec(sent)![1]);
    };
    const last = () => wakes.at(-1)!;
    const seatTask = () => group.store.member(group.id, "beta")!.seat_task;

    // A new piece comes in full: no inbox to read, and the claim isn't held for the top level's other messages.
    await group.groups.postFromUser(group.id, { text: "Ship the release notes." });
    const a = await lead("@Beta draft the release notes from CHANGELOG.md");
    const first = last();
    expect(first.text).toContain("[For you, in full (already read):]");
    expect(first.text).toContain("@Beta draft the release notes from CHANGELOG.md");
    expect(first.text).not.toContain("Group inbox notice");
    expect(seatTask()).toBe(a);
    expect(await group.groups.claim(beta, group.id, a)).toContain("answer in its thread (thread: " + a + ") @mentioning Alpha");
    expect(await group.groups.send(beta, group.id, { thread: a, text: "@Alpha drafted in NOTES.md" })).toMatch(/^Sent as/);
    await settle(group);

    // A follow-up in its thread, in the same session: just the new message; it has the piece from the top.
    await lead("@Beta add the date to the title", a);
    expect(last().chat).toBe(first.chat);
    expect(last().text).toContain("add the date to the title");
    expect(last().text).not.toContain("[Thread context");
    // Its piece is handled and told: a restart doesn't wake it to catch up on the group.
    await group.groups.read(beta, group.id, { thread: a });
    expect(await group.groups.send(beta, group.id, { thread: a, text: "@Alpha dated" })).toMatch(/^Sent as/);
    await settle(group);
    const before = wakes.length;
    group.groups.resume();
    await settle(group);
    expect(wakes.length).toBe(before);
    expect(group.store.unreadPlaces(group.id, "beta").filter((place) => place.conv === 0)).toEqual([]);

    // The next piece: a fresh session.
    const b = await lead("@Beta now update the README's install section");
    expect(last().chat).not.toBe(first.chat);
    expect(last().text).toContain("update the README's install section");
    expect(seatTask()).toBe(b);

    // Back to the first piece in its thread: another fresh session, with the thread as its context.
    await lead("@Beta the notes miss the migration step", a);
    const back = last();
    expect(back.chat).not.toBe(first.chat);
    expect(back.text).toContain(`[Thread context: you were @mentioned in thread #${a}`);
    expect(back.text).toContain("draft the release notes from CHANGELOG.md");
    expect(back.text).toContain("drafted in NOTES.md");
    expect(back.text).toContain("the notes miss the migration step");
    expect(seatTask()).toBe(a);

    // More on the same piece: the same session, the message in full.
    await group.groups.read(beta, group.id, { thread: a });
    expect(await group.groups.send(beta, group.id, { thread: a, text: "@Alpha added it" })).toMatch(/^Sent as/);
    await settle(group);
    await lead("@Beta and link the migration guide", a);
    expect(last().chat).toBe(back.chat);
    expect(last().text).toContain("[For you, in full (already read):]");
    expect(last().text).toContain("and link the migration guide");
    expect(last().text).not.toContain("[Thread context");
  });

  it("keeps a new piece out of a busy session on another one, and starts it fresh once that turn ends", async () => {
    const seen: { chat: string; text: string }[] = [];
    const group = await setup(
      (turn, step, botId) => {
        if (botId !== "beta" || !delivered(turn)) return null;
        if (step === 0) seen.push({ chat: turn.spec.key, text: turn.text });
        // The first piece takes a while.
        return step === 0 && turn.text.includes("first piece") ? { wait: 400 } : null;
      },
      ["alpha", "beta"],
    );
    stop = group.stop;
    await group.groups.update(group.id, { leaderId: "alpha" });
    await settle(group);
    const alpha = (await group.host.bot("alpha"))!;
    const send = async (text: string) => {
      await group.groups.read(alpha, group.id, { unread: true });
      await group.groups.read(alpha, group.id, { topLevel: true });
      return group.groups.send(alpha, group.id, { text });
    };
    await send("@Beta the first piece");
    await until(() => seen.some((wake) => wake.text.includes("first piece")));
    await send("@Beta the second piece");
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Still busy on the first: the second hasn't reached it.
    expect(seen.some((wake) => wake.text.includes("second piece"))).toBe(false);
    await settle(group);
    const firstChat = seen.find((wake) => wake.text.includes("first piece"))!.chat;
    const second = seen.find((wake) => wake.text.includes("second piece"))!;
    expect(second.chat).not.toBe(firstChat);
    expect(second.text).not.toContain("first piece");
  });

  it("answers another member's question in the session it's in, without the leader", async () => {
    const wakes: { bot: string; chat: string; text: string }[] = [];
    const group = await setup(
      (turn, step, botId) => {
        if (step === 0 && delivered(turn)) wakes.push({ bot: botId, chat: turn.spec.key, text: turn.text });
        return null;
      },
      ["alpha", "beta", "gamma"],
    );
    stop = group.stop;
    await group.groups.update(group.id, { leaderId: "alpha" });
    await settle(group);
    const alpha = (await group.host.bot("alpha"))!;
    const beta = (await group.host.bot("beta"))!;
    const gamma = (await group.host.bot("gamma"))!;
    const piece = async (text: string) => {
      await group.groups.read(alpha, group.id, { unread: true });
      await group.groups.read(alpha, group.id, { topLevel: true });
      const sent = await group.groups.send(alpha, group.id, { text });
      await settle(group);
      return Number(/#(\d+)/.exec(sent)![1]);
    };
    const a = await piece("@Beta add dark mode to styles.css");
    const b = await piece("@Gamma map where the theme is loaded");
    const gammaChat = wakes.filter((wake) => wake.bot === "gamma").at(-1)!.chat;
    expect(group.store.member(group.id, "gamma")!.seat_task).toBe(b);

    // Beta asks Gamma in its own piece's thread.
    wakes.length = 0;
    await group.groups.read(beta, group.id, { thread: a });
    expect(await group.groups.send(beta, group.id, { thread: a, text: "@Gamma which file loads the theme?" })).toMatch(/^Sent as/);
    await settle(group);
    // Only Gamma wakes, in the session for its own piece, with Beta's thread as context; its piece stays.
    expect(wakes.map((wake) => wake.bot)).toEqual(["gamma"]);
    expect(wakes[0]!.chat).toBe(gammaChat);
    expect(wakes[0]!.text).toContain("which file loads the theme?");
    expect(group.store.member(group.id, "gamma")!.seat_task).toBe(b);

    // Gamma answers there: Beta wakes, the leader doesn't.
    wakes.length = 0;
    await group.groups.read(gamma, group.id, { thread: a });
    expect(await group.groups.send(gamma, group.id, { thread: a, text: "@Beta src/theme/load.ts, line 12" })).toMatch(/^Sent as/);
    await settle(group);
    expect(wakes.map((wake) => wake.bot)).toEqual(["beta"]);
    // The leader has both in its records, unread, to see when it reads the thread.
    expect(group.store.unreadPlaces(group.id, "alpha").map((place) => place.conv)).toContain(a);
    // Beta's report @mentions the leader, which wakes it.
    wakes.length = 0;
    await group.groups.read(beta, group.id, { thread: a });
    expect(await group.groups.send(beta, group.id, { thread: a, text: "@Alpha done: dark mode in styles.css, npm test passes" })).toMatch(/^Sent as/);
    await settle(group);
    expect(wakes.map((wake) => wake.bot)).toEqual(["alpha"]);
  });
});
