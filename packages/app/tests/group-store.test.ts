// A group's message management at the storage layer: delivery records,
// mute, threads, notes, read positions and the model-seen ledger.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/server/db";
import { GroupStore, isSeen } from "../src/server/group-store";
import { GROUP_USER, type GroupSender } from "../src/shared/group-chat";

let dir: string;
let db: Db;
let store: GroupStore;
const G = "group-test";
const user: GroupSender = { kind: "user" };
const bot = (id: string): GroupSender => ({ kind: "bot", botId: id, name: id[0]!.toUpperCase() + id.slice(1) });
const system = { kind: "system" } as GroupSender;
const ada = { kind: "bot" as const, id: "ada", name: "Ada" };
const cody = { kind: "bot" as const, id: "cody", name: "Cody" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bots-group-store-"));
  db = new Db(join(dir, "bots.sqlite"));
  store = new GroupStore(db);
  store.createGroup({ id: G, name: "Group", memberIds: ["ada", "cody", "rex"] });
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Each receiver's record for a message: [receiver, unread, why it went into its inbox]. */
const records = (seq: number) =>
  db.all<{ receiver_id: string; unread_eligible: number; wake_reason: string | null }>("SELECT receiver_id, unread_eligible, wake_reason FROM group_inbox WHERE group_id = ? AND seq = ? ORDER BY receiver_id", G, seq).map((row) => [row.receiver_id, !!row.unread_eligible, row.wake_reason]);
const pendingSeqs = (botId: string, conv?: number) => store.pending(G, botId, conv).map((entry) => entry.message.seq);

describe("delivery records", () => {
  it("gives a top-level message a record per member and the user; its sender's isn't unread", () => {
    const { message, woken } = store.append(G, bot("ada"), { text: "I'll take the release notes." });
    expect(records(message.seq)).toEqual([
      ["ada", false, null],
      ["cody", true, "group"],
      ["rex", true, "group"],
      ["user", true, null],
    ]);
    expect(woken).toEqual(["cody", "rex"]);
    // The user's question is open (it addresses nobody); an @mention from a bot hands work over.
    expect(records(store.append(G, user, { text: "Who's around?" }).message.seq).slice(0, 3)).toEqual([
      ["ada", true, "open"],
      ["cody", true, "open"],
      ["rex", true, "open"],
    ]);
    expect(records(store.append(G, bot("ada"), { text: "@Cody can you check?", mentions: ["cody"] }).message.seq)[1]).toEqual(["cody", true, "handoff"]);
  });

  it("writes no record for a muted member's ordinary messages, but does for an @mention or a change of leader", () => {
    store.append(G, user, { text: "before the mute" });
    store.setMuted(G, "rex", true);
    const ordinary = store.append(G, user, { text: "after the mute" });
    expect(records(ordinary.message.seq).map(([id]) => id)).toEqual(["ada", "cody", "user"]);
    const everyone = store.append(G, user, { text: "@everyone stand up", everyone: true });
    expect(records(everyone.message.seq).map(([id]) => id)).not.toContain("rex");
    const mention = store.append(G, user, { text: "@Rex you're up", mentions: ["rex"] });
    expect(records(mention.message.seq).find(([id]) => id === "rex")).toEqual(["rex", true, "mention"]);
    expect(pendingSeqs("rex")).toEqual([1, 4]);
    // A change of leader changes its rules too, so that note gets past the mute.
    const leader = store.append(G, system, { text: "👑 the user made @Ada the group's leader", everyone: true, mentions: ["ada"], subtype: "group.leader", causalActor: "user" });
    expect(records(leader.message.seq).find(([id]) => id === "rex")).toEqual(["rex", true, "everyone"]);
    // Unmuted, ordinary messages reach it again.
    store.setMuted(G, "rex", false);
    expect(records(store.append(G, user, { text: "back" }).message.seq).map(([id]) => id)).toContain("rex");
  });

  it("in addressed mode writes the records but puts only what's aimed at a bot in its inbox", () => {
    store.updateGroup(G, { wakeMode: "addressed" });
    expect(records(store.append(G, bot("ada"), { text: "status update" }).message.seq).slice(1, 3)).toEqual([
      ["cody", true, null],
      ["rex", true, null],
    ]);
    expect(records(store.append(G, user, { text: "anyone?" }).message.seq)[1]).toEqual(["cody", true, "open"]);
    const reply = store.append(G, bot("cody"), { text: "on it", replyTo: 2 });
    expect(records(reply.message.seq)[0]).toEqual(["ada", true, null]);
    // The user's reply to Cody is for Cody: the others get the record, not a wake.
    expect(records(store.append(G, user, { text: "thanks", replyTo: 3 }).message.seq).slice(0, 3)).toEqual([
      ["ada", true, null],
      ["cody", true, "reply"],
      ["rex", true, null],
    ]);
    // A reply to the user's own message still addresses nobody.
    expect(records(store.append(G, user, { text: "anyone else?", replyTo: 2 }).message.seq)[1]).toEqual(["cody", true, "open"]);
  });

  it("sends a thread's messages to its followers and, for the same send, its top message's author and whoever it @mentions", () => {
    const top = store.append(G, bot("ada"), { text: "Plan: ship Friday." }).message.seq;
    const first = store.append(G, user, { text: "Why Friday?", thread: top });
    // Ada wrote the top message; the user replied; nobody else hears about it.
    expect(records(first.message.seq)).toEqual([
      ["ada", true, "thread"],
      ["user", false, null],
    ]);
    expect(store.followers(G, top).sort()).toEqual(["ada", "user"]);
    const mention = store.append(G, user, { text: "@Cody does that work?", thread: top, mentions: ["cody"] });
    expect(records(mention.message.seq).find(([id]) => id === "cody")).toEqual(["cody", true, "mention"]);
    expect(store.followers(G, top)).toContain("cody");
    expect(records(mention.message.seq).map(([id]) => id)).not.toContain("rex");
  });

  it("leaves out one who stopped following a thread, until an @mention brings it back", () => {
    const top = store.append(G, user, { text: "Side topic" }).message.seq;
    store.append(G, bot("cody"), { text: "my two cents", thread: top });
    store.unfollow(G, top, "cody");
    const ordinary = store.append(G, user, { text: "more", thread: top });
    expect(records(ordinary.message.seq).map(([id]) => id)).not.toContain("cody");
    const mention = store.append(G, user, { text: "@Cody one more thing", thread: top, mentions: ["cody"] });
    expect(store.pending(G, "cody", top)).toEqual([expect.objectContaining({ reason: "mention", reactivated: true })]);
    expect(store.followers(G, top)).toContain("cody");
    expect(mention.woken).toEqual(["cody"]);
  });

  it("classifies notes: unread for all but their causer, none at all for skip notes, and an assignment reaches a muted assignee", () => {
    const joined = store.append(G, system, { text: "Rex joined the group.", subtype: "group.membership", causalActor: "user" });
    expect(records(joined.message.seq)).toEqual([
      ["ada", true, "group"],
      ["cody", true, "group"],
      ["rex", true, "group"],
      ["user", false, null],
    ]);
    const summary = store.append(G, system, { text: '📋 1 new task created: #1 "x"', subtype: "task.created_summary", causalActor: "ada" });
    expect(records(summary.message.seq)[0]).toEqual(["ada", false, null]);
    expect(records(store.append(G, system, { text: "🗑 deleted", subtype: "task.deleted_summary", causalActor: "ada" }).message.seq)).toEqual([]);
    store.setMuted(G, "rex", true);
    const receipt = store.append(G, system, { text: "📌 Assigned @Rex to task #1", subtype: "task.assignment_receipt", causalActor: "ada", mentions: ["rex"] });
    expect(records(receipt.message.seq).find(([id]) => id === "rex")).toEqual(["rex", true, "assigned"]);
    // A receipt that @mentions the one who caused it is unread for it too.
    const started = store.append(G, system, { text: "📌 @Ada started task #2", subtype: "task.assignment_receipt", causalActor: "ada", mentions: ["ada"] });
    expect(records(started.message.seq)[0]).toEqual(["ada", true, "assigned"]);
  });
});

describe("a group with a leader", () => {
  beforeEach(() => store.updateGroup(G, { leaderId: "ada" }));

  it("gives the leader every message, and the others only what the leader or the user aims at them", () => {
    const open = store.append(G, user, { text: "Add a dark mode." });
    expect(records(open.message.seq)).toEqual([
      ["ada", true, "open"],
      ["user", false, null],
    ]);
    expect(open.woken).toEqual(["ada"]);
    const handoff = store.append(G, bot("ada"), { text: "@Cody implement it in styles.css", mentions: ["cody"] });
    expect(records(handoff.message.seq)).toEqual([
      ["ada", false, null],
      ["cody", true, "handoff"],
      ["user", true, null],
    ]);
    // The user can hand work to a member directly, and the leader's @everyone reaches everyone.
    expect(records(store.append(G, user, { text: "@Rex find the theme files", mentions: ["rex"] }).message.seq).find(([id]) => id === "rex")).toEqual(["rex", true, "mention"]);
    expect(store.append(G, bot("ada"), { text: "@everyone stand up", everyone: true }).woken).toEqual(["cody", "rex"]);
    // The leader's ordinary message and a reply from it to a member.
    expect(store.append(G, bot("ada"), { text: "thinking about the plan" }).woken).toEqual([]);
    const report = store.append(G, bot("cody"), { text: "done" }).message.seq;
    expect(records(report).map(([id]) => id)).toEqual(["ada", "cody", "user"]);
    expect(records(store.append(G, bot("ada"), { text: "thanks", replyTo: report }).message.seq).find(([id]) => id === "cody")).toEqual(["cody", true, "reply"]);
    expect(pendingSeqs("rex")).toEqual([3, 4]);
  });

  it("lets a member ask another directly without waking the leader; @everyone and assignments don't hand anyone work", () => {
    const ask = store.append(G, bot("cody"), { text: "@Rex where are the theme files?", mentions: ["rex"] });
    expect(records(ask.message.seq)).toEqual([
      ["ada", true, null],
      ["cody", false, null],
      ["rex", true, "handoff"],
      ["user", true, null],
    ]);
    expect(ask.woken).toEqual(["rex"]);
    const rexSaid = store.append(G, bot("rex"), { text: "@Cody in src/theme", mentions: ["cody"] });
    expect(rexSaid.woken).toEqual(["cody"]);
    expect(store.append(G, bot("cody"), { text: "which file?", replyTo: rexSaid.message.seq }).woken).toEqual(["rex"]);
    // Aimed at the leader, a member's message wakes it.
    expect(store.append(G, bot("rex"), { text: "@Ada found them", mentions: ["ada"] }).woken).toEqual(["ada"]);
    expect(store.append(G, bot("cody"), { text: "@everyone ship it", everyone: true }).woken).toEqual(["ada"]);
    // A task one member assigns another reaches neither; the leader's reaches the member.
    expect(store.append(G, system, { text: "📌 Assigned @Rex to task #1", subtype: "task.assignment_receipt", causalActor: "cody", mentions: ["rex"] }).woken).toEqual([]);
    expect(store.append(G, system, { text: "📌 Assigned @Rex to task #1", subtype: "task.assignment_receipt", causalActor: "ada", mentions: ["rex"] }).woken).toEqual(["rex"]);
  });

  it("keeps the members' talk in a piece's thread from waking the leader or anyone it isn't aimed at", () => {
    const top = store.append(G, bot("ada"), { text: "@Cody build it; @Rex find the files", mentions: ["cody", "rex"] }).message.seq;
    // The leader follows its piece's thread, but a member's progress there doesn't wake it.
    expect(store.append(G, bot("cody"), { text: "starting", thread: top }).woken).toEqual([]);
    const rexReport = store.append(G, bot("rex"), { text: "@Ada the files are in src/theme", thread: top, mentions: ["ada"] });
    // Cody follows the thread (it posted there), so it has the record, but isn't woken by Rex.
    expect(records(rexReport.message.seq)).toEqual([
      ["ada", true, "handoff"],
      ["cody", true, null],
      ["rex", false, null],
    ]);
    expect(rexReport.woken).toEqual(["ada"]);
    expect(store.append(G, bot("ada"), { text: "@Cody use src/theme", thread: top, mentions: ["cody"] }).woken).toEqual(["cody"]);
    // A member's question to another wakes only that one, and brings it back into the thread.
    store.unfollow(G, top, "rex");
    expect(store.append(G, bot("cody"), { text: "@Rex which file?", thread: top, mentions: ["rex"] }).woken).toEqual(["rex"]);
    expect(store.followers(G, top)).toContain("rex");
    expect(store.append(G, bot("rex"), { text: "@Cody src/theme/dark.css", thread: top, mentions: ["cody"] }).woken).toEqual(["cody"]);
    expect(store.append(G, bot("cody"), { text: "@Ada done: dark mode in src/theme/dark.css, npm test passes", thread: top, mentions: ["ada"] }).woken).toEqual(["ada"]);
  });

  it("leads only while the leader is a member, and stops when it's cleared", () => {
    store.removeMember(G, "ada");
    expect(store.leader(G)).toBeNull();
    expect(store.append(G, user, { text: "anyone?" }).woken).toEqual(["cody", "rex"]);
    store.addMember(G, "ada");
    expect(store.leader(G)).toBe("ada");
    store.updateGroup(G, { leaderId: null });
    expect(store.append(G, bot("cody"), { text: "@Rex look", mentions: ["rex"] }).woken).toEqual(["ada", "rex"]);
  });
});

describe("a led member's seats", () => {
  beforeEach(() => store.updateGroup(G, { leaderId: "ada" }));

  it("keeps a seat per conversation, and scopes what a seat was told and saw to its own conversations", () => {
    const p = store.append(G, bot("ada"), { text: "@Cody piece one", mentions: ["cody"] }).message.seq;
    const q = store.append(G, bot("ada"), { text: "@Cody piece two", mentions: ["cody"] }).message.seq;
    store.setSeat(G, "cody", p, "chat-p");
    store.setSeat(G, "cody", q, "chat-q");
    expect(store.seats(G, "cody").map((seat) => [seat.piece, seat.chat_id])).toEqual([
      [p, "chat-p"],
      [q, "chat-q"],
    ]);
    expect(store.seatByChat("chat-q")).toMatchObject({ bot_id: "cody", piece: q });
    // From its seat for piece one, Cody asks Rex at the top level; Rex answers in that request's thread.
    const request = store.append(G, bot("cody"), { text: "@Rex find the theme files", mentions: ["rex"], fromPiece: p }).message;
    expect(request.fromPiece).toBe(p);
    expect(store.seatConvs(G, "cody", p)).toEqual([p, request.seq]);
    const answer = store.append(G, bot("rex"), { text: "@Cody src/theme.ts", mentions: ["cody"], thread: request.seq }).message.seq;
    // A failed turn of the seat for piece one fails what it was told: its piece and its request's answer.
    store.markNoticed(G, "cody", [p, q, answer]);
    store.markDeliveryFailed(G, "cody", "runtime_error", undefined, p);
    const failures = db.all<{ seq: number; delivery_failure: string | null }>("SELECT seq, delivery_failure FROM group_inbox WHERE group_id = ? AND receiver_id = 'cody' AND wake_reason IS NOT NULL ORDER BY seq", G);
    expect(failures.map((row) => [Number(row.seq), row.delivery_failure])).toEqual([
      [p, "runtime_error"],
      [q, null],
      [answer, "runtime_error"],
    ]);
    // A seat that didn't start is told again only its own.
    expect(store.retellUntaken(G, "cody", q)).toEqual([q]);
    // A seat's new model context leaves the others' ledgers alone; its own go.
    store.recordSeen(G, "cody", request.seq, { exact: [answer] });
    store.newSeenContext(G, "cody", q);
    expect(isSeen(store.ledger(G, "cody", request.seq), answer)).toBe(true);
    store.resetSeen(G, "cody", p);
    expect(isSeen(store.ledger(G, "cody", request.seq), answer)).toBe(false);
    store.dropSeats(G, "cody");
    expect(store.seats(G, "cody")).toEqual([]);
  });

  it("moves the seats stored before migration 22 into their table, a led member's under its piece", () => {
    db.run("UPDATE group_members SET seat_chat_id = 'chat-a' WHERE group_id = ? AND bot_id = 'ada'", G);
    db.run("UPDATE group_members SET seat_chat_id = 'chat-c', seat_task = 7 WHERE group_id = ? AND bot_id = 'cody'", G);
    db.raw.exec("DROP TABLE group_seats; ALTER TABLE group_messages DROP COLUMN from_piece; UPDATE schema_version SET version = 21");
    db.close();
    db = new Db(join(dir, "bots.sqlite"));
    store = new GroupStore(db);
    expect(store.seats(G).map((seat) => [seat.bot_id, seat.piece, seat.chat_id])).toEqual([
      ["ada", 0, "chat-a"],
      ["cody", 7, "chat-c"],
    ]);
  });
});

describe("read positions", () => {
  it("moves the user's position with their own post, and a bot's only when nothing it wasn't handed lies in between", () => {
    store.append(G, user, { text: "one" });
    expect(store.cursor(G, "user", 0)).toBe(1);
    store.append(G, bot("cody"), { text: "two" });
    // Ada hasn't seen #1 or #2: her post leaves her position where it was.
    store.append(G, bot("ada"), { text: "three" });
    expect(store.cursor(G, "ada", 0)).toBe(0);
    // Rex had seen them; his post moves his position to it.
    store.recordSeen(G, "rex", 0, { boundary: 3 });
    store.append(G, bot("rex"), { text: "four" });
    expect(store.cursor(G, "rex", 0)).toBe(4);
  });

  it("follows what the model has seen, stopping at the first message it hasn't", () => {
    for (const text of ["a", "b", "c", "d"]) store.append(G, user, { text });
    store.recordSeen(G, "ada", 0, { exact: [1, 2, 4] });
    expect(store.cursor(G, "ada", 0)).toBe(2);
    store.recordSeen(G, "ada", 0, { exact: [3] });
    expect(store.cursor(G, "ada", 0)).toBe(4);
  });

  it("lists where something is unread, without moving anything", () => {
    const top = store.append(G, user, { text: "topic" }).message.seq;
    store.append(G, bot("cody"), { text: "reply", thread: top });
    store.append(G, bot("cody"), { text: "@Ada look", mentions: ["ada"] });
    const places = store.unreadPlaces(G, "user");
    expect(places.map((place) => [place.conv, place.count])).toEqual([
      [0, 1],
      [top, 1],
    ]);
    expect(store.unreadPlaces(G, "ada")).toEqual([expect.objectContaining({ conv: 0, count: 2, first: 1, mention: true })]);
    expect(store.cursor(G, "ada", 0)).toBe(0);
  });
});

describe("the model-seen ledger", () => {
  it("keeps a boundary and the messages seen one by one after it, and drains what's seen from the inbox", () => {
    for (const text of ["a", "b", "c", "d", "e"]) store.append(G, user, { text });
    expect(pendingSeqs("ada")).toEqual([1, 2, 3, 4, 5]);
    store.recordSeen(G, "ada", 0, { exact: [4] });
    store.recordSeen(G, "ada", 0, { boundary: 2 });
    let ledger = store.ledger(G, "ada", 0);
    expect([ledger.boundary, [...ledger.exact]]).toEqual([2, [4]]);
    expect([3, 4, 5].map((seq) => isSeen(ledger, seq))).toEqual([false, true, false]);
    expect(pendingSeqs("ada")).toEqual([3, 5]);
    // A boundary never moves back, and seen-one-by-one messages under it are dropped.
    store.recordSeen(G, "ada", 0, { boundary: 4 });
    store.recordSeen(G, "ada", 0, { boundary: 1 });
    ledger = store.ledger(G, "ada", 0);
    expect([ledger.boundary, [...ledger.exact]]).toEqual([4, []]);
  });

  it("keeps each conversation apart and caps the loose seen messages at 2,500, newest kept", () => {
    const top = store.append(G, user, { text: "topic" }).message.seq;
    store.append(G, user, { text: "in thread", thread: top });
    store.recordSeen(G, "ada", top, { boundary: 2 });
    expect(store.ledger(G, "ada", 0).boundary).toBeNull();
    store.recordSeen(G, "ada", 0, { exact: Array.from({ length: 2_600 }, (_, index) => index + 10) });
    const exact = [...store.ledger(G, "ada", 0).exact];
    expect(exact).toHaveLength(2_500);
    expect(exact[0]).toBe(110);
  });

  it("knows which thread a bot read after the top level, and forgets everything for a new seat", () => {
    const top = store.append(G, user, { text: "topic" }).message.seq;
    store.recordSeen(G, "ada", 0, { boundary: 1, read: true });
    expect(store.latestReadThread(G, "ada")).toBeNull();
    store.recordSeen(G, "ada", top, { exact: [1], read: true });
    expect(store.latestReadThread(G, "ada")).toBe(top);
    store.recordSeen(G, "ada", 0, { read: true });
    expect(store.latestReadThread(G, "ada")).toBeNull();
    store.resetSeen(G, "ada");
    expect(store.ledger(G, "ada", 0)).toEqual({ boundary: null, exact: new Set(), readOrder: null });
  });

  it("starts a new model context without forgetting where the seat was shown up to", () => {
    const top = store.append(G, user, { text: "topic" }).message.seq;
    const reply = store.append(G, bot("cody"), { text: "a reply", thread: top }).message.seq;
    store.recordSeen(G, "ada", top, { boundary: reply, read: true });
    store.recordSeen(G, "ada", 0, { exact: [top] });
    expect(store.visibleBoundary(G, "ada", top)).toBe(reply);
    expect(store.latestReadThread(G, "ada")).toBe(top);
    store.newSeenContext(G, "ada");
    // No evidence in the new context: no boundary, nothing seen one by one, no latest read.
    expect(store.ledger(G, "ada", top)).toEqual({ boundary: null, exact: new Set(), readOrder: null });
    expect(isSeen(store.ledger(G, "ada", 0), top)).toBe(false);
    expect(store.latestReadThread(G, "ada")).toBeNull();
    // Shown up to stays, and a read in the new context doesn't move it back.
    expect(store.visibleBoundary(G, "ada", top)).toBe(reply);
    store.recordSeen(G, "ada", top, { exact: [reply] });
    expect(store.visibleBoundary(G, "ada", top)).toBe(reply);
    expect(store.visibleBoundary(G, "ada", 0)).toBeNull();
    // Read positions are the bot's, not its context's.
    expect(store.cursor(G, "ada", top)).toBe(reply);
    store.resetSeen(G, "ada");
    expect(store.visibleBoundary(G, "ada", top)).toBeNull();
  });

  it("counts what came in for the check before a post: delivery records at the top level, every message in a thread", () => {
    store.setMuted(G, "rex", true);
    store.append(G, user, { text: "ordinary" });
    store.append(G, user, { text: "@Rex hi", mentions: ["rex"] });
    store.append(G, bot("rex"), { text: "mine" });
    // Rex's own receipt doesn't hold him; a task's status note in its thread would.
    store.append(G, system, { text: "📌 @Rex started task #3", subtype: "task.assignment_receipt", causalActor: "rex", mentions: ["rex"] });
    expect(store.freshnessRows(G, "rex", 0, 0)).toEqual([2]);
    store.append(G, system, { text: "🔄 Rex moved #1 to In Progress", subtype: "task.lifecycle_thread", causalActor: "rex", thread: 1 });
    store.append(G, user, { text: "in the thread", thread: 1 });
    expect(store.freshnessRows(G, "rex", 1, 0)).toEqual([5, 6]);
    expect(store.freshnessRows(G, "rex", 1, 5)).toEqual([6]);
  });
});

describe("drafts", () => {
  it("keeps one per bot per conversation, counts holds of the same text, and replaces new text with a new key", () => {
    const first = store.saveDraft(G, "ada", 0, { text: "draft", replyTo: null, held: true });
    expect(first.hold_count).toBe(1);
    const again = store.saveDraft(G, "ada", 0, { text: "draft", replyTo: null, held: true });
    expect([again.hold_count, again.draft_key]).toEqual([2, first.draft_key]);
    const thread = store.saveDraft(G, "ada", 5, { text: "thread draft", replyTo: null, held: false });
    expect(thread.hold_count).toBe(0);
    const revised = store.saveDraft(G, "ada", 0, { text: "revised", replyTo: null, held: true });
    expect(revised.hold_count).toBe(1);
    expect(revised.draft_key).not.toBe(first.draft_key);
    expect(store.drafts(G, "ada").map((draft) => draft.conv)).toEqual([0, 5]);
    // A draft keeps the files its post attaches; the same text with other files is a new draft.
    const withFile = store.saveDraft(G, "ada", 0, { text: "revised", replyTo: null, held: true, files: ["/tmp/a.png"] });
    expect([withFile.hold_count, withFile.files, withFile.draft_key === revised.draft_key]).toEqual([1, ["/tmp/a.png"], false]);
    expect(store.saveDraft(G, "ada", 0, { text: "revised", replyTo: null, held: true, files: ["/tmp/a.png"] })).toMatchObject({ hold_count: 2, draft_key: withFile.draft_key });
    db.run("UPDATE group_drafts SET expires_at = ? WHERE conv = 5", new Date(Date.now() - 1).toISOString());
    expect(store.draft(G, "ada", 5)).toBeNull();
  });
});

describe("tasks", () => {
  it("bumps a task's revision on every change, and refuses an assignment made on a stale view", () => {
    const seq = store.append(G, user, { text: "Write the intro" }).message.seq;
    const { task } = store.convertToTask(G, seq, GROUP_USER);
    expect(task.revision).toBe(0);
    const first = store.assignTask(G, task.number, ada, GROUP_USER, 0);
    expect(first).toMatchObject({ ok: true, task: { revision: 1, status: "todo", assignee: { id: "ada" } } });
    // Someone acting on revision 0 loses instead of overwriting Ada's assignment.
    expect(store.assignTask(G, task.number, cody, GROUP_USER, 0)).toMatchObject({ ok: false, reason: "task state changed concurrently", task: { revision: 1 } });
    // Assigning the current assignee again changes nothing, so nobody else's view goes stale.
    expect(store.assignTask(G, task.number, ada, GROUP_USER, 1)).toMatchObject({ ok: true, task: { revision: 1 } });
    expect(store.claimTask(G, { number: task.number }, ada)).toMatchObject({ ok: true, task: { revision: 2, status: "in_progress" } });
    expect(store.setTaskStatus(G, task.number, "done", ada)).toMatchObject({ ok: true, task: { revision: 3 } });
    expect(store.assignTask(G, task.number, cody, ada)).toMatchObject({ ok: false, reason: "task is done" });
  });
});

describe("task cards", () => {
  const history = (number: number) => store.taskEvents(G, number).map((event) => [event.event, event.actor.id, event.payload]);

  it("keeps a card's title, who made it a task, and every change to it in order", () => {
    const seq = store.append(G, user, { text: "Fix the login page" }).message.seq;
    expect(store.convertToTask(G, seq, ada).task).toMatchObject({ title: "Fix the login page", description: null, createdBy: "ada", amended: null });
    store.claimTask(G, { number: seq }, cody);
    // Unclaiming takes the assignee off and leaves the status (they're independent).
    expect(store.unclaimTask(G, seq, ada)).toMatchObject({ ok: true, task: { status: "in_progress", assignee: null } });
    expect(store.unclaimTask(G, seq, ada)).toEqual({ ok: false, reason: "task is not assigned" });
    store.assignTask(G, seq, cody, GROUP_USER);
    store.setTaskStatus(G, seq, "closed", GROUP_USER, true);
    store.setTaskStatus(G, seq, "todo", cody);
    expect(history(seq)).toEqual([
      ["created", "ada", { taskNumber: seq, status: "todo", convertedFromMessage: true }],
      ["assignee_changed", "cody", { assigneeType: "bot", assigneeId: "cody" }],
      ["status_changed", "cody", { from: "todo", to: "in_progress" }],
      ["assignee_changed", "ada", { assigneeType: null, assigneeId: null, previousAssigneeType: "bot", previousAssigneeId: "cody" }],
      ["assignee_changed", "user", { assigneeType: "bot", assigneeId: "cody", previousAssigneeType: null, previousAssigneeId: null }],
      ["closed", "user", { from: "in_progress", to: "closed", forced: true }],
      ["reopened", "cody", { from: "closed", to: "todo", forced: false }],
    ]);
    // Events are ordered among all tasks' changes.
    const seqs = store.taskEvents(G, seq).map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("stamps when a task was done and when and by whom it was closed, and clears them when it moves on", () => {
    const seq = store.append(G, user, { text: "Ship it" }).message.seq;
    store.claimTask(G, { seq }, ada);
    const row = () => db.get<{ completed_at: string | null; closed_at: string | null; closed_by: string | null; claimed_at: string | null }>("SELECT completed_at, closed_at, closed_by, claimed_at FROM group_tasks WHERE group_id = ? AND number = ?", G, seq)!;
    store.setTaskStatus(G, seq, "done", ada);
    expect(row().completed_at).not.toBeNull();
    store.setTaskStatus(G, seq, "closed", cody);
    expect(row()).toMatchObject({ completed_at: null, closed_by: "cody" });
    expect(row().closed_at).not.toBeNull();
    store.setTaskStatus(G, seq, "in_progress", ada);
    expect(row()).toMatchObject({ closed_at: null, closed_by: null });
    expect(row().claimed_at).not.toBeNull();
  });

  it("creates an assigned task in one go: reserved for another bot, started for oneself", () => {
    const reserved = store.append(G, bot("ada"), { text: "Review the copy" }).message.seq;
    expect(store.convertToTask(G, reserved, ada, { assignee: cody, start: false }).task).toMatchObject({ status: "todo", assignee: { id: "cody" }, revision: 0 });
    const started = store.append(G, bot("ada"), { text: "Draft the copy" }).message.seq;
    expect(store.convertToTask(G, started, ada, { assignee: ada, start: true }).task).toMatchObject({ status: "in_progress", assignee: { id: "ada" }, revision: 0 });
    expect(history(started)).toEqual([
      ["created", "ada", { taskNumber: started, status: "in_progress" }],
      ["assignee_changed", "ada", { assigneeType: "bot", assigneeId: "ada" }],
    ]);
  });

  it("amends the card with the exact change in its history, keeps the message's text, and refuses a change that changes nothing", () => {
    const seq = store.append(G, user, { text: "Write the intro" }).message.seq;
    store.convertToTask(G, seq, GROUP_USER);
    const amended = store.amendTask(G, seq, { title: "Write the intro (300 words)", description: "Plain English.\nNo jargon." }, cody);
    expect(amended).toMatchObject({ ok: true, task: { title: "Write the intro (300 words)", description: "Plain English.\nNo jargon.", revision: 1 } });
    expect(store.taskEvents(G, seq).at(-1)).toMatchObject({
      event: "amended",
      actor: { kind: "bot", id: "cody", name: "Cody" },
      payload: { revision: 1, changes: { title: { from: "Write the intro", to: "Write the intro (300 words)" }, description: { from: null, to: "Plain English.\nNo jargon." } } },
    });
    expect(amended.ok && amended.eventSeq).toBe(store.taskEvents(G, seq).at(-1)!.seq);
    const message = store.messageAt(G, seq)!;
    expect(message.text).toBe("Write the intro");
    expect(message.task).toMatchObject({ title: "Write the intro (300 words)", amended: { by: "Cody", byId: "cody" } });
    expect(store.amendTask(G, seq, { title: "Write the intro (300 words)" }, cody)).toEqual({ ok: false, reason: "task amendment makes no changes" });
    expect(store.amendTask(G, seq, { description: null }, GROUP_USER)).toMatchObject({ ok: true, task: { description: null, revision: 2, amended: { by: "the user" } } });
    // A claim also bumps the revision, but it isn't an amendment: the card still shows the latest one.
    store.claimTask(G, { number: seq }, ada);
    expect(store.task(G, { number: seq })).toMatchObject({ revision: 3, amended: { by: "the user" } });
  });

  it("deletes a task with its history; making the message a task again starts a new one", () => {
    const seq = store.append(G, user, { text: "Tidy up" }).message.seq;
    store.convertToTask(G, seq, ada);
    store.amendTask(G, seq, { title: "Tidy up the docs" }, ada);
    store.deleteTask(G, seq);
    expect(store.task(G, { seq })).toBeNull();
    expect(store.taskEvents(G, seq)).toEqual([]);
    expect(store.convertToTask(G, seq, cody).task).toMatchObject({ title: "Tidy up", createdBy: "cody", revision: 0, amended: null });
    expect(store.taskEvents(G, seq)).toHaveLength(1);
  });
});

describe("mentions and their delivery", () => {
  it("records each member a message @mentions, with its token as written", () => {
    const { message } = store.append(G, bot("ada"), { text: "@cody and @REX, look", mentions: ["cody", "rex"], mentionHandles: { cody: "@cody", rex: "@REX" } });
    expect(store.mentionsOf(G, message.seq)).toEqual([
      { targetId: "cody", handle: "@cody" },
      { targetId: "rex", handle: "@REX" },
    ]);
    // A note's personal mention (an assignee) isn't a mention anyone wrote.
    const note = store.append(G, system, { text: "📌 Assigned @Cody", mentions: ["cody"], subtype: "task.assignment_receipt", causalActor: "ada" });
    expect(store.mentionsOf(G, note.message.seq)).toEqual([]);
  });

  it("follows each receiver's record: told by which notice, taken in by its seat, handed to its model, or failed", () => {
    const seq = store.append(G, bot("ada"), { text: "@Cody check this", mentions: ["cody"] }).message.seq;
    const state = (id: string) => store.receivers(G, seq).find((row) => row.receiverId === id);
    // Its sender's own post counts as seen by it; the user's record never goes into an inbox.
    expect(state("ada")).toMatchObject({ inbox: false, drained: true });
    expect(state("user")).toEqual({ receiverId: "user", inbox: false, noticed: false, accepted: false, drained: false, failure: null });
    store.tieToNotice(G, "cody", [seq], "notice-1");
    store.markNoticeAccepted("notice-1");
    store.markNoticed(G, "cody", [seq]);
    expect(state("cody")).toMatchObject({ inbox: true, noticed: true, accepted: true, failure: null });
    // Its turn failed before it read it: lost, until a later notice tells it again.
    store.markDeliveryFailed(G, "cody", "quota");
    expect(state("cody")).toMatchObject({ failure: "quota" });
    store.tieToNotice(G, "cody", [seq], "notice-2");
    expect(state("cody")).toMatchObject({ accepted: false });
    store.markNoticed(G, "cody", [seq]);
    expect(state("cody")).toMatchObject({ failure: null });
    // A seat that couldn't start fails what it was to be told; what a bot has read can't fail.
    store.markDeliveryFailed(G, "rex", "not_launched", [seq]);
    expect(state("rex")).toMatchObject({ noticed: false, failure: "not_launched" });
    store.recordSeen(G, "cody", 0, { exact: [seq] });
    store.markDeliveryFailed(G, "cody", "runtime_error");
    expect(state("cody")).toMatchObject({ drained: true, failure: null });
  });
});

describe("reminders", () => {
  const every15m = { version: 1 as const, rule: { kind: "interval" as const, seconds: 900 } };
  const schedule = (fireAt: Date, recurrence: typeof every15m | null = null) => {
    const anchor = store.append(G, user, { text: "Kick off the build" }).message.seq;
    return store.scheduleReminder({ groupId: G, ownerId: "ada", anchor, title: "check the build", fireAt, recurrence, actor: "Ada" });
  };

  it("fires a one-time reminder once, by the version it was read at, and leaves its owner's wake pending", () => {
    const reminder = schedule(new Date(Date.now() - 1000));
    expect(reminder).toMatchObject({ status: "scheduled", version: 1, anchor: 1, anchorThread: null });
    expect(store.fireReminder(reminder.id, reminder.version, false, new Date())).toMatchObject({ status: "fired", version: 2 });
    // A second fire with the old version (a race, a retry) does nothing.
    expect(store.fireReminder(reminder.id, reminder.version, false, new Date())).toBeNull();
    expect(store.pendingReminderWakes(G, "ada").map((wake) => wake.id)).toEqual([reminder.id]);
    expect(store.pendingReminderWakes(G, "cody")).toEqual([]);
    store.markRemindersWoken([reminder.id]);
    expect(store.pendingReminderWakes(G, "ada")).toEqual([]);
    expect(store.reminderEvents(reminder.id).map((event) => event.event)).toEqual(["fired", "scheduled"]);
  });

  it("doesn't fire a reminder before it's due", () => {
    const reminder = schedule(new Date(Date.now() + 60_000));
    expect(store.fireReminder(reminder.id, reminder.version, false, new Date())).toBeNull();
    expect(store.dueReminders(new Date())).toEqual([]);
    expect(store.nextReminderAt()).toBe(reminder.fireAt);
  });

  it("keeps a recurring one scheduled, its next time counted from now when the slot was missed", () => {
    const missed = new Date(Date.now() - 40 * 60_000);
    const reminder = schedule(missed, every15m);
    const at = new Date();
    const fired = store.fireReminder(reminder.id, reminder.version, true, at)!;
    // Missed slots are skipped, not replayed one by one.
    expect(fired).toMatchObject({ status: "scheduled", firedAt: at.toISOString(), fireAt: new Date(at.getTime() + 900_000).toISOString() });
    expect(store.pendingReminderWakes(G, "ada")[0]).toMatchObject({ catchup: true });
  });

  it("snoozes a fired one back to scheduled, updates only a scheduled one, and cancels", () => {
    const reminder = schedule(new Date(Date.now() - 1000));
    store.fireReminder(reminder.id, reminder.version, false);
    expect(store.updateReminder(reminder.id, { title: "too late" }, "Ada")).toBeNull();
    const snoozed = store.snoozeReminder(reminder.id, 1800, "Ada")!;
    expect(snoozed.status).toBe("scheduled");
    expect(Date.parse(snoozed.fireAt) - Date.now()).toBeGreaterThan(1790_000);
    expect(store.updateReminder(reminder.id, { title: "check the deploy" }, "Ada")).toMatchObject({ title: "check the deploy", version: 4 });
    expect(store.cancelReminder(reminder.id, "Ada")).toMatchObject({ status: "canceled" });
    expect(store.cancelReminder(reminder.id, "Ada")).toBeNull();
    expect(store.reminderEvents(reminder.id).map((event) => `${event.event} by ${event.actor}`)).toEqual(["canceled by Ada", "updated by Ada", "snoozed by Ada", "fired by system", "scheduled by Ada"]);
  });

  it("finds a bot's own reminder by id prefix, and only its own", () => {
    const reminder = schedule(new Date(Date.now() + 60_000));
    expect(store.findReminder(G, "ada", `#${reminder.id.slice(0, 8)}`)).toMatchObject({ ok: true, reminder: { id: reminder.id } });
    expect(store.findReminder(G, "cody", reminder.id.slice(0, 8))).toMatchObject({ ok: false, error: expect.stringMatching(/^No reminder of yours matches/) });
    store.cancelReminder(reminder.id, "Ada");
    expect(store.findReminder(G, "ada", reminder.id.slice(0, 8), ["scheduled", "fired"])).toMatchObject({ ok: false, error: expect.stringMatching(/^No scheduled\/fired reminder of yours/) });
    expect(store.findReminder(G, "ada", "")).toEqual({ ok: false, error: "id is required" });
  });

  it("knows the thread its message is in, and goes with its group", () => {
    const top = store.append(G, user, { text: "Plan the launch" }).message.seq;
    const reply = store.append(G, bot("cody"), { text: "I'll draft it", thread: top }).message.seq;
    const reminder = store.scheduleReminder({ groupId: G, ownerId: "cody", anchor: reply, title: "send the draft", fireAt: new Date(Date.now() + 60_000), recurrence: null, actor: "Cody" });
    expect(reminder).toMatchObject({ anchor: reply, anchorThread: top });
    store.deleteGroup(G);
    expect(store.reminderById(reminder.id)).toBeNull();
    expect(store.reminderEvents(reminder.id)).toEqual([]);
  });
});

describe("task statuses", () => {
  it("moves in_progress straight to done, and migration 19 turns in_review tasks into done with their history intact", () => {
    const { message } = store.append(G, user, { text: "Fix the login page." });
    expect(store.claimTask(G, { seq: message.seq }, ada).ok).toBe(true);
    expect(store.setTaskStatus(G, message.seq, "done", ada)).toMatchObject({ ok: true, from: "in_progress" });
    expect(store.task(G, { number: message.seq })!.status).toBe("done");
    expect(store.setTaskStatus(G, message.seq, "in_progress", ada)).toMatchObject({ ok: true });
    expect(store.setTaskStatus(G, message.seq, "todo", ada)).toMatchObject({ ok: false });

    // A database from before the migration: a task waiting in review, with the event that put it there.
    const { message: second } = store.append(G, user, { text: "Write the notes." });
    store.claimTask(G, { seq: second.seq }, cody);
    db.run("UPDATE group_tasks SET status = 'in_review', completed_at = NULL, updated_at = '2026-10-01T00:00:00.000Z' WHERE number = ?", second.seq);
    db.run("INSERT INTO group_task_events (group_id, number, event, actor_kind, actor_id, actor_name, payload, created_at) VALUES (?, ?, 'status_changed', 'bot', 'cody', 'Cody', ?, '2026-10-01T00:00:00.000Z')", G, second.seq, JSON.stringify({ from: "in_progress", to: "in_review", forced: false }));
    // (Migrations 20 to 22 are undone too, or they would add their columns and table again.)
    db.raw.exec("ALTER TABLE chats DROP COLUMN extra_folders; ALTER TABLE chats DROP COLUMN folders_told; ALTER TABLE groups DROP COLUMN extra_folders; ALTER TABLE groups DROP COLUMN team_id; ALTER TABLE groups DROP COLUMN instructions; DROP TABLE group_seats; ALTER TABLE group_messages DROP COLUMN from_piece");
    db.run("UPDATE schema_version SET version = 18");
    db.close();
    db = new Db(join(dir, "bots.sqlite"));
    store = new GroupStore(db);
    expect(store.task(G, { number: second.seq })).toMatchObject({ status: "done", assignee: { id: "cody" } });
    expect(db.get<{ completed_at: string }>("SELECT completed_at FROM group_tasks WHERE number = ?", second.seq)!.completed_at).toBe("2026-10-01T00:00:00.000Z");
    expect(store.taskEvents(G, second.seq).at(-1)).toMatchObject({ event: "status_changed", payload: { from: "in_progress", to: "in_review" } });
  });
});
