// Group delivery machinery, under fake timers: the backoff after a recoverable
// runtime error, the spawn-fail backoff, the repeated-error fence, the stop after an error only the
// user can fix, a busy seat's notice delay and the model-context scope of the seen ledger. Real
// GroupStore; the seats are a stand-in chat service.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db } from "../src/server/db";
import { GroupStore } from "../src/server/group-store";
import { claimAutomaticStart, freshBreaker, noteTerminalFailure, spawnErrorBackoffMs, spawnErrorRetryJitterMs } from "../src/server/breakers";
import { BUSY_NOTICE_DELAY_MS, BUSY_NOTICE_RETRY_MS, GroupChats, RUNTIME_ERROR_BACKOFF_BASE_MS, RUNTIME_ERROR_BACKOFF_MAX_MS } from "../src/server/groups";
import { startTimeoutText } from "../src/server/supervision";
import { fakeChats, fakeHost, makeBot, type FakeChat } from "./helpers";

let cleanup: (() => Promise<void>) | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(async () => {
  vi.useRealTimers();
  await cleanup?.();
  cleanup = null;
});

/** Lets a group's deliveries (promise chains) run, and moves time on by `ms`. */
const pass = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
  for (let index = 0; index < 50; index++) await Promise.resolve();
};

async function setup(options: { random?: () => number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bots-delivery-"));
  const db = new Db(join(dir, "bots.sqlite"));
  const store = new GroupStore(db);
  const host = fakeHost([makeBot({ id: "alpha", name: "Alpha", provider: "fake" }), makeBot({ id: "beta", name: "Beta", provider: "fake" })]);
  const seats: Record<string, FakeChat> = {};
  const chats = fakeChats(seats);
  // The notices' ids, for telling the group a seat took one in.
  const noticeIds: string[] = [];
  const send = chats.send;
  chats.send = async (chatId, message, whenBusy) => {
    const id = (message as { clientMessageId?: string }).clientMessageId;
    if (id) noticeIds.push(id);
    return send(chatId, message, whenBusy);
  };
  host.attach(chats);
  const starts: { botId: string; prompt: string }[] = [];
  const tries: Record<string, number> = {};
  const failing: { start: string | null } = { start: null };
  const groups = new GroupChats(
    host,
    store,
    async (bot, input) => {
      tries[bot.id] = (tries[bot.id] ?? 0) + 1;
      if (failing.start) throw new Error(failing.start);
      const id = `seat-${bot.id}-${starts.length}`;
      seats[id] = { status: "running", labels: input.labels ?? {}, ...(input.cwd ? { cwd: input.cwd } : {}) };
      starts.push({ botId: bot.id, prompt: input.prompt });
      return id;
    },
    () => {},
    { random: options.random ?? (() => 0) },
  );
  const { id } = await groups.create({ name: "Group", memberIds: ["alpha", "beta"] });
  /** A bot's latest seat (a member the leader leads has one per conversation). */
  const seatOf = (botId: string) => store.seats(id, botId).at(-1)?.chat_id ?? null;
  /** What was sent to a bot's seat after it started. */
  const sentTo = (botId: string) => chats.sent.filter((sent) => sent.chatId === seatOf(botId));
  /** Ends the running turn of a bot's seat, as ChatService reports it. */
  const endTurn = async (botId: string, outcome: "completed" | "failed", error: string | null = null) => {
    const seat = seatOf(botId)!;
    seats[seat]!.status = outcome === "failed" ? "error" : "idle";
    const snapshot = chats.get(seat)! as never;
    await groups.onTurnEnded(snapshot, { outcome, error });
    groups.onAgent(snapshot);
    await pass();
  };
  /** A seat starts its turn (it took a notice). */
  const busy = (botId: string) => void (seats[seatOf(botId)!]!.status = "running");
  const bot = async (botId: string) => (await host.bot(botId))!;
  cleanup = async () => {
    groups.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { groups, store, chats, seats, id, starts, tries, failing, noticeIds, seatOf, sentTo, endTurn, busy, bot };
}

const texts = async (group: Awaited<ReturnType<typeof setup>>) => (await group.groups.messages(group.id)).messages.map((message) => `${message.from.kind === "bot" ? message.from.botId : message.from.kind}: ${message.text}`);
const HOUR = 3_600_000;
/** Beta reads what's new (its checks), then posts; the number it was sent as. */
const fromBeta = async (group: Awaited<ReturnType<typeof setup>>, text: string) => {
  const beta = await group.bot("beta");
  await group.groups.read(beta, group.id, {});
  const seq = Number(/^Sent as #(\d+)\./.exec(await group.groups.send(beta, group.id, { text }))?.[1]);
  await pass();
  return seq;
};

describe("the backoff after a recoverable runtime error", () => {
  it("doesn't wake a rate-limited bot until the backoff ends, then tells it once about what came in", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    expect(group.starts.map((start) => start.botId).sort()).toEqual(["alpha", "beta"]);
    await group.endTurn("beta", "completed");
    await group.endTurn("alpha", "failed", "429 Too Many Requests: rate limit exceeded");

    // Two messages while Alpha waits: nothing goes to its seat, and a mention of it reads as rate limited.
    await group.groups.postFromUser(group.id, { text: "Second" });
    await pass();
    await group.groups.read(await group.bot("beta"), group.id, {});
    const third = Number(/^Sent as #(\d+)\.$/.exec(await group.groups.send(await group.bot("beta"), group.id, { text: "@Alpha are you there?" }))?.[1]);
    await pass();
    expect(group.sentTo("alpha")).toEqual([]);
    expect(await group.groups.mentionDelivery(await group.bot("beta"), group.id, third)).toContain("@Alpha: LOST — target is rate/quota limited");

    await pass(RUNTIME_ERROR_BACKOFF_BASE_MS - 1);
    expect(group.sentTo("alpha")).toEqual([]);
    await pass(1);
    // One notice for everything in its inbox.
    expect(group.sentTo("alpha")).toHaveLength(1);
    expect(group.sentTo("alpha")[0]!.text).toMatch(/\[Group inbox notice: \d+ new messages for you to read\./);
    expect(await group.groups.mentionDelivery(await group.bot("beta"), group.id, third)).toContain("@Alpha: still in flight");
  });

  it("doubles the wait with each failure in a row, adds jitter, and starts over after a completed turn", async () => {
    const group = await setup({ random: () => 0.5 });
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    await group.endTurn("alpha", "failed", "API Error: 503 Service Unavailable");
    await group.groups.postFromUser(group.id, { text: "One" });
    await pass();
    // 10 s plus 10% of it times the jitter unit (0.5): 10.5 s.
    await pass(10_499);
    expect(group.sentTo("alpha")).toHaveLength(0);
    await pass(1);
    expect(group.sentTo("alpha")).toHaveLength(1);

    group.busy("alpha");
    await group.endTurn("alpha", "failed", "API Error: 503 Service Unavailable");
    await group.groups.postFromUser(group.id, { text: "Two" });
    await pass(20_999);
    expect(group.sentTo("alpha")).toHaveLength(1);
    await pass(1);
    expect(group.sentTo("alpha")).toHaveLength(2);

    // A completed turn is progress: the next message wakes it at once.
    group.busy("alpha");
    await group.endTurn("alpha", "completed");
    await group.groups.postFromUser(group.id, { text: "Three" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(3);
  });

  it("caps the wait at five minutes", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    // Six connection failures in a row, each with a different text so the fence doesn't trip.
    for (let failure = 0; failure < 6; failure++) {
      group.busy("alpha");
      await group.endTurn("alpha", "failed", `connect ECONNRESET ${["a", "b", "c", "d", "e", "f"][failure]}`);
      await group.groups.postFromUser(group.id, { text: `Ping ${failure}` });
      await pass(Math.min(RUNTIME_ERROR_BACKOFF_MAX_MS, RUNTIME_ERROR_BACKOFF_BASE_MS * 2 ** failure));
    }
    expect(group.sentTo("alpha")).toHaveLength(6);
    // The sixth wait was 5 min, not 10 min 40 s.
    group.busy("alpha");
    await group.endTurn("alpha", "failed", "connect ECONNRESET g");
    await group.groups.postFromUser(group.id, { text: "Last" });
    await pass(RUNTIME_ERROR_BACKOFF_MAX_MS);
    expect(group.sentTo("alpha")).toHaveLength(7);
  });

  it("doesn't repeat messages a notice already carried", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    await group.endTurn("alpha", "failed", "429 Too Many Requests");
    await pass(RUNTIME_ERROR_BACKOFF_MAX_MS);
    // Nothing new came in: the wait ends without a notice.
    expect(group.sentTo("alpha")).toEqual([]);
  });

  it("doesn't back off after an error that isn't recoverable", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    await group.endTurn("alpha", "failed", "The tool runner crashed.");
    await group.groups.postFromUser(group.id, { text: "Again" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(1);
    // A sign-in problem isn't backed off either (it needs the user, not time).
    group.busy("alpha");
    await group.endTurn("alpha", "failed", "Not logged in · Please run /login");
    await group.groups.postFromUser(group.id, { text: "Once more" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(2);
  });
});

describe("the repeated-error fence", () => {
  it("stops a bot's runtime after three failures with the same fingerprint; its next message starts it again", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    // The same failure, with a different number each time: one fingerprint.
    for (const code of [7, 8]) {
      await group.endTurn("alpha", "failed", `The tool runner crashed with code ${code}.`);
      await group.groups.postFromUser(group.id, { text: `Try ${code}` });
      await pass();
      group.busy("alpha");
    }
    expect(group.sentTo("alpha")).toHaveLength(2);
    await group.endTurn("alpha", "failed", "The tool runner crashed with code 9.");
    const note = (await texts(group)).at(-1)!;
    expect(note).toMatch(/^system: Alpha stopped after 3 repeated runtime errors with the same fingerprint \([0-9a-f]{16}\)\. Last error: The tool runner crashed with code 9\. Restart after the runtime\/tooling issue is fixed: @mention Alpha to restart it, or its next message starts it again\.$/);

    // Stopped: what's in its inbox waits, and no wait running out tells it.
    await pass(RUNTIME_ERROR_BACKOFF_MAX_MS);
    expect(group.sentTo("alpha")).toHaveLength(2);
    expect(group.store.pending(group.id, "alpha").length).toBeGreaterThan(0);

    // Its next message, another bot's too, starts it again: one notice for its whole inbox.
    await fromBeta(group, "Alpha, are you back?");
    expect(group.sentTo("alpha")).toHaveLength(3);
  });

  it("counts again from one after a different failure or a completed turn", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    const fail = async (error: string) => {
      await group.endTurn("alpha", "failed", error);
      await group.groups.postFromUser(group.id, { text: "Next" });
      await pass();
      group.busy("alpha");
    };
    await fail("The tool runner crashed.");
    await fail("The tool runner crashed.");
    await fail("Something else broke.");
    await fail("The tool runner crashed.");
    await group.endTurn("alpha", "completed");
    await group.groups.postFromUser(group.id, { text: "Next" });
    await pass();
    group.busy("alpha");
    await fail("The tool runner crashed.");
    await fail("The tool runner crashed.");
    expect((await texts(group)).some((text) => text.includes("repeated runtime errors"))).toBe(false);
    expect(group.sentTo("alpha")).toHaveLength(7);
  });
});

describe("the terminal-failure breaker", () => {
  it("pauses automatic wakes for an hour at the second terminal failure with one fingerprint, then lets one probe through", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    // Billing is a terminal failure only the user can fix: the runtime stops, and the breaker counts it.
    await group.endTurn("alpha", "failed", "402 Payment Required");
    expect((await texts(group)).at(-1)).toBe("system: Alpha's turn failed: 402 Payment Required");
    await group.groups.postFromUser(group.id, { text: "Topped up" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(1);

    // The second, with the same fingerprint, opens it for an hour.
    group.busy("alpha");
    const failedAt = Date.now();
    await group.endTurn("alpha", "failed", "402 Payment Required");
    expect((await texts(group)).at(-1)).toBe(
      `system: Alpha: Automatic wake paused until ${new Date(failedAt + HOUR).toISOString()} after repeated runtime failures (sticky_runtime_error). The next message, reminder or manual start after that retries; a manual start lifts it now. @mention Alpha to start it now.`,
    );
    // Paused: messages wait in its inbox, and a mention of it is rejected.
    const ask = await fromBeta(group, "@Alpha ping");
    await pass(HOUR - 1);
    expect(group.sentTo("alpha")).toHaveLength(1);
    expect(await group.groups.mentionDelivery(await group.bot("beta"), group.id, ask)).toContain("@Alpha: LOST — target's runtime rejected delivery");
    await pass(1);
    // The pause is over: the next message is the one probe.
    await group.groups.postFromUser(group.id, { text: "Try now" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(2);

    // The probe fails the same way: paused again, one step longer (4 h).
    group.busy("alpha");
    const probeFailedAt = Date.now();
    await group.endTurn("alpha", "failed", "402 Payment Required");
    expect((await texts(group)).at(-1)).toContain(`paused until ${new Date(probeFailedAt + 4 * HOUR).toISOString()} after repeated runtime failures (sticky_runtime_error).`);
    await pass(4 * HOUR);
    await group.groups.postFromUser(group.id, { text: "And now?" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(3);
    // This probe completes its turn: closed, and the next message wakes it at once.
    group.busy("alpha");
    await group.endTurn("alpha", "completed");
    await group.groups.postFromUser(group.id, { text: "Good" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(4);
  });

  it("opens at the third terminal failure in a row whatever the fingerprints, and a completed turn starts the count over", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    const fail = async (error: string) => {
      await group.endTurn("alpha", "failed", error);
      await group.groups.postFromUser(group.id, { text: "Next" });
      await pass();
      group.busy("alpha");
    };
    await fail("402 Payment Required");
    await fail("model is not supported");
    await group.endTurn("alpha", "completed");
    await group.groups.postFromUser(group.id, { text: "Fine again" });
    await pass();
    group.busy("alpha");
    await fail("402 Payment Required");
    await fail("model is not supported");
    expect((await texts(group)).some((text) => text.includes("Automatic wake paused"))).toBe(false);
    expect(group.sentTo("alpha")).toHaveLength(5);
    // A third, with another fingerprint: paused.
    await group.endTurn("alpha", "failed", "Insufficient balance on this account");
    expect((await texts(group)).at(-1)).toMatch(/^system: Alpha: Automatic wake paused until .* \(sticky_runtime_error\)\./);
    await group.groups.postFromUser(group.id, { text: "Hello?" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(5);
  });

  it("is lifted by the user's @mention", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    await group.endTurn("alpha", "failed", "402 Payment Required");
    await group.groups.postFromUser(group.id, { text: "Again" });
    await pass();
    group.busy("alpha");
    await group.endTurn("alpha", "failed", "402 Payment Required");
    await group.groups.postFromUser(group.id, { text: "Still paused" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(1);
    await group.groups.postFromUser(group.id, { text: "@Alpha the balance is back" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(2);
  });

  it("pauses one step longer when a probe reports nothing within its 30-minute lease", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    await group.endTurn("alpha", "failed", "402 Payment Required");
    await group.groups.postFromUser(group.id, { text: "Again" });
    await pass();
    group.busy("alpha");
    await group.endTurn("alpha", "failed", "402 Payment Required");
    await pass(HOUR);
    const claimedAt = Date.now();
    await group.groups.postFromUser(group.id, { text: "Probe" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(2);
    // The probe stops on a sign-in problem, which isn't the breaker's evidence: it stays a probe in flight.
    group.busy("alpha");
    await group.endTurn("alpha", "failed", "Not logged in · Please run /login");
    await group.groups.postFromUser(group.id, { text: "In the lease" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(2);
    // The lease lapses: open again, 4 h from its end.
    await pass(30 * 60_000);
    await group.groups.postFromUser(group.id, { text: "After the lease" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(2);
    expect((await texts(group)).at(-1)).toContain(`paused until ${new Date(claimedAt + 30 * 60_000 + 4 * HOUR).toISOString()}`);
  });
});

describe("the breakers' caps", () => {
  it("never pauses longer than 24 h, nor waits longer than 6 h after spawn errors", () => {
    const breaker = freshBreaker();
    let now = 0;
    noteTerminalFailure(breaker, { kind: "sticky_runtime_error", fingerprint: "a" }, now);
    noteTerminalFailure(breaker, { kind: "sticky_runtime_error", fingerprint: "a" }, now);
    const waits: number[] = [];
    for (let probe = 0; probe < 4; probe++) {
      waits.push(breaker.blockedUntil! - now);
      now = breaker.blockedUntil!;
      expect(claimAutomaticStart(breaker, now)).toBeNull();
      noteTerminalFailure(breaker, { kind: "sticky_runtime_error", fingerprint: "a" }, now);
    }
    expect(waits).toEqual([HOUR, 4 * HOUR, 24 * HOUR, 24 * HOUR]);
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(spawnErrorBackoffMs)).toEqual([5, 10, 20, 40, 80, 160, 320, 360].map((minutes) => minutes * 60_000));
    expect(spawnErrorRetryJitterMs("g:alpha")).toBe(spawnErrorRetryJitterMs("g:alpha"));
    expect(spawnErrorRetryJitterMs("g:alpha")).toBeLessThan(60_000);
  });
});

describe("an error only the user can fix", () => {
  it("starts a bot stopped by a sign-in problem again at its next message, whoever sends it", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    await group.endTurn("alpha", "failed", "Not logged in · Please run /login");
    expect((await texts(group)).at(-1)).toBe("system: Alpha's turn failed: Not logged in · Please run /login");
    // Stopped: nothing is backed off, and no timer tells it.
    await pass(RUNTIME_ERROR_BACKOFF_MAX_MS);
    expect(group.sentTo("alpha")).toEqual([]);
    // Another bot's @mention is its next wake: any sender wakes it.
    const ask = await fromBeta(group, "@Alpha can you look at this?");
    expect(group.sentTo("alpha")).toHaveLength(1);
    // Its whole inbox: the failed turn's "Hello" and Beta's question.
    expect(group.sentTo("alpha")[0]!.text).toContain("[Group inbox notice: 2 new messages for you to read.");
    expect(await group.groups.mentionDelivery(await group.bot("beta"), group.id, ask)).toContain("@Alpha: still in flight");
  });

  it("pauses automatic wakes after three early exits in a row, until the user @mentions it", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    // Each runtime ends on the sign-in problem within a minute of its start: an early exit.
    await group.endTurn("alpha", "failed", "Not logged in · Please run /login");
    for (const text of ["Try again", "And again"]) {
      await group.groups.postFromUser(group.id, { text });
      await pass(30_000);
      group.busy("alpha");
      await group.endTurn("alpha", "failed", "Not logged in · Please run /login");
    }
    expect(group.sentTo("alpha")).toHaveLength(2);
    expect((await texts(group)).at(-1)).toBe("system: Alpha: Automatic wake paused after 3 early exits. @mention Alpha to start it again.");
    await group.groups.postFromUser(group.id, { text: "Anyone?" });
    await fromBeta(group, "@Alpha?");
    await pass(HOUR);
    expect(group.sentTo("alpha")).toHaveLength(2);
    await group.groups.postFromUser(group.id, { text: "@Alpha I signed in" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(3);
  });

  it("doesn't count an exit a minute or more after the runtime started", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    for (const text of ["One", "Two", "Three"]) {
      await pass(61_000);
      await group.endTurn("alpha", "failed", "Not logged in · Please run /login");
      await group.groups.postFromUser(group.id, { text });
      await pass();
      group.busy("alpha");
    }
    expect((await texts(group)).some((text) => text.includes("early exits"))).toBe(false);
    expect(group.sentTo("alpha")).toHaveLength(3);
  });

  it("starts a stopped bot again for its reminder, and drops the reminder's wake while it's paused", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    await group.groups.reminder(await group.bot("alpha"), group.id, { action: "schedule", title: "Check the invoice", message: 1, delaySeconds: 60 });
    await group.endTurn("alpha", "failed", "402 Payment Required");
    await pass(60_000);
    expect(group.sentTo("alpha")).toHaveLength(1);
    expect(group.sentTo("alpha")[0]!.text).toContain("Check the invoice");

    group.busy("alpha");
    await group.groups.reminder(await group.bot("alpha"), group.id, { action: "schedule", title: "Look at the bill again", message: 1, delaySeconds: 60 });
    await group.endTurn("alpha", "failed", "402 Payment Required");
    // Paused now; the reminder fires and its wake is dropped.
    await pass(60_000);
    expect(group.sentTo("alpha")).toHaveLength(1);
    await pass(HOUR);
    await group.groups.postFromUser(group.id, { text: "Later" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(2);
    expect(group.sentTo("alpha")[1]!.text).not.toContain("Look at the bill again");
  });
});

describe("a failed turn on a led member's piece", () => {
  /** Alpha leads; it hands Beta a piece. Returns the piece's number. */
  const handOut = async (group: Awaited<ReturnType<typeof setup>>) => {
    await group.groups.update(group.id, { leaderId: "alpha" });
    await pass();
    await group.endTurn("alpha", "completed");
    await group.endTurn("beta", "completed");
    const alpha = await group.bot("alpha");
    await group.groups.read(alpha, group.id, { unread: true });
    await group.groups.read(alpha, group.id, { topLevel: true });
    const piece = Number(/^Sent as #(\d+)\./.exec(await group.groups.send(alpha, group.id, { text: "@Beta fix the login page" }))?.[1]);
    await pass();
    // The piece has a seat of its own.
    expect(group.store.seat(group.id, "beta", piece)?.chat_id).toBe(group.seatOf("beta"));
    group.busy("beta");
    return piece;
  };
  const threadNote = async (group: Awaited<ReturnType<typeof setup>>, piece: number) => (await group.groups.messages(group.id, { thread: piece })).messages.at(-1)!;

  it("tells the leader in the piece's thread, which wakes it, and not the member", async () => {
    const group = await setup();
    const piece = await handOut(group);
    await group.endTurn("beta", "failed", "429 Too Many Requests");
    const note = await threadNote(group, piece);
    expect(note).toMatchObject({ thread: piece, from: { kind: "system" }, mentions: ["alpha"] });
    expect(note.text).toBe("⚠️ @Alpha: Beta's turn on this piece failed: 429 Too Many Requests. Beta won't pick it up again by itself. @mention Beta here to have it carry on, or hand the piece to another member.");
    expect(group.store.pending(group.id, "alpha").map((entry) => [entry.message.seq, entry.reason])).toContainEqual([note.seq, "mention"]);
    expect(group.store.pending(group.id, "beta").map((entry) => entry.message.seq)).not.toContain(note.seq);
    // The top level still has its record of the failure, for nobody's inbox.
    expect((await texts(group)).at(-1)).toBe("system: Beta's turn failed: 429 Too Many Requests");

    // The leader's @mention in the thread brings the member back to the piece, in the same session, once its wait is over.
    const seat = group.seatOf("beta");
    const sent = group.sentTo("beta").length;
    const alpha = await group.bot("alpha");
    await group.groups.read(alpha, group.id, { unread: true, thread: piece });
    expect(await group.groups.send(alpha, group.id, { text: "@Beta carry on", thread: piece })).toMatch(/^Sent as #\d+ in thread #\d+\.$/);
    await pass(RUNTIME_ERROR_BACKOFF_BASE_MS);
    expect(group.seatOf("beta")).toBe(seat);
    expect(group.sentTo("beta")).toHaveLength(sent + 1);
  });

  it("says when only the user can fix what stopped the member", async () => {
    const group = await setup();
    const piece = await handOut(group);
    await group.endTurn("beta", "failed", "Not logged in · Please run /login");
    expect((await threadNote(group, piece)).text).toBe("⚠️ @Alpha: Beta's turn on this piece failed: Not logged in · Please run /login. Its runtime stopped on an error only the user can fix: tell the user, or hand the piece to another member.");
  });

  it("tells the leader again once someone has spoken in the thread, and not while nobody has", async () => {
    const group = await setup();
    const piece = await handOut(group);
    const notes = async () => (await group.groups.messages(group.id, { thread: piece })).messages.filter((message) => message.from.kind === "system").length;
    await group.endTurn("beta", "failed", "429 Too Many Requests");
    expect(await notes()).toBe(1);
    // The leader has it carry on, and it fails the same way: the group's note isn't repeated
    // within ten minutes, but the leader is told again.
    const alpha = await group.bot("alpha");
    await group.groups.read(alpha, group.id, { unread: true, thread: piece });
    expect(await group.groups.send(alpha, group.id, { text: "@Beta carry on", thread: piece })).toMatch(/^Sent as #\d+ in thread #\d+\.$/);
    await pass(RUNTIME_ERROR_BACKOFF_MAX_MS);
    group.busy("beta");
    const groupNotes = (await texts(group)).length;
    await group.endTurn("beta", "failed", "429 Too Many Requests");
    expect((await texts(group)).length).toBe(groupNotes);
    expect(await notes()).toBe(2);
    // A third time with nobody answering stops its runtime; the thread already says it's stuck.
    group.busy("beta");
    await group.endTurn("beta", "failed", "429 Too Many Requests");
    expect((await texts(group)).at(-1)).toMatch(/^system: Beta stopped after 3 repeated runtime errors/);
    expect(await notes()).toBe(2);
  });

  it("tells the leader when a member's seat stops trying to start on a new piece", async () => {
    const group = await setup();
    await handOut(group);
    await group.endTurn("beta", "completed");
    // The next piece needs a new seat, and it can't start.
    group.failing.start = "fake isn't available here.";
    const alpha = await group.bot("alpha");
    await group.groups.read(alpha, group.id, { unread: true });
    await group.groups.read(alpha, group.id, { topLevel: true });
    const second = Number(/^Sent as #(\d+)\./.exec(await group.groups.send(alpha, group.id, { text: "@Beta now the signup page" }))?.[1]);
    await pass();
    const inThread = async () => (await group.groups.messages(group.id, { thread: second })).messages.filter((message) => message.from.kind === "system");
    // Still retrying by itself: nothing for the leader yet. (Its seats so far: the one for the
    // note of the new leader, the first piece's, and this one's first try.)
    expect(group.tries.beta).toBe(3);
    expect(await inThread()).toEqual([]);
    await pass(1_000 + 2_000 + 4_000 + 8_000);
    expect(group.tries.beta).toBe(7);
    const [note] = await inThread();
    expect(note).toMatchObject({ mentions: ["alpha"] });
    expect(note!.text).toBe("⚠️ @Alpha: Beta couldn't start on this piece after 5 tries: fake isn't available here. It won't try again by itself: @mention Beta here to retry, or hand the piece to another member.");
    expect(group.store.pending(group.id, "alpha").map((entry) => [entry.message.seq, entry.reason])).toContainEqual([note!.seq, "mention"]);
  });

  it("tells nobody about a failed turn that wasn't on a piece, or a leader's own", async () => {
    const group = await setup();
    await group.groups.update(group.id, { leaderId: "alpha" });
    await pass();
    // Beta's wake for the leader note belongs to no piece.
    await group.endTurn("beta", "failed", "429 Too Many Requests");
    await group.endTurn("alpha", "failed", "503 Service Unavailable");
    const notes = (await group.groups.messages(group.id)).messages.filter((message) => message.from.kind === "system");
    expect(notes.map((message) => message.text)).toEqual([expect.stringContaining("made @Alpha the group's leader"), "Beta's turn failed: 429 Too Many Requests", "Alpha's turn failed: 503 Service Unavailable"]);
  });
});

describe("the spawn-fail backoff", () => {
  it("tries a seat that couldn't start again after 1, 2, 4 and 8 s, then at its next message under the spawn-error backoff", async () => {
    const group = await setup();
    group.failing.start = "fake isn't available here.";
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    expect(group.tries).toEqual({ alpha: 1, beta: 1 });
    expect((await texts(group)).filter((text) => text.startsWith("system:"))).toEqual(["system: Alpha couldn't join: fake isn't available here.", "system: Beta couldn't join: fake isn't available here."]);

    // A message during the wait doesn't try again; it's buffered (in flight) until the next try.
    await group.groups.read(await group.bot("beta"), group.id, {}).catch(() => "");
    await group.groups.postFromUser(group.id, { text: "Still there?" });
    await pass(999);
    expect(group.tries.alpha).toBe(1);
    await pass(1);
    expect(group.tries.alpha).toBe(2);
    await pass(2_000);
    expect(group.tries.alpha).toBe(3);
    await pass(4_000);
    expect(group.tries.alpha).toBe(4);
    await pass(8_000);
    expect(group.tries.alpha).toBe(5);
    const alphaNotes = async () => (await texts(group)).filter((text) => text.startsWith("system: Alpha"));
    expect((await alphaNotes()).at(-1)).toBe("system: Alpha couldn't join after 5 tries: fake isn't available here. Its next message or reminder tries again; @mention Alpha to try now.");
    await pass(60_000);
    expect(group.tries.alpha).toBe(5);

    // Its next message is a start; it fails, and the spawn-error backoff pauses it 5 min.
    const failedAt = Date.now();
    await group.groups.postFromUser(group.id, { text: "Still broken?" });
    await pass();
    expect(group.tries.alpha).toBe(6);
    expect((await alphaNotes()).at(-1)).toBe(
      `system: Alpha couldn't join: fake isn't available here. Automatic wake paused until ${new Date(failedAt + 5 * 60_000).toISOString()} after repeated runtime failures (spawn_error). The next message, reminder or manual start after that retries; a manual start lifts it now. @mention Alpha to start it now.`,
    );
    await group.groups.postFromUser(group.id, { text: "Meanwhile" });
    await pass();
    expect(group.tries.alpha).toBe(6);

    // The sweep tries again once the pause and the seat's jitter are over, then waits twice as long.
    const jitter = spawnErrorRetryJitterMs(`${group.id}:alpha`);
    await pass(5 * 60_000 + jitter - 1);
    expect(group.tries.alpha).toBe(6);
    await pass(1);
    expect(group.tries.alpha).toBe(7);
    // Fixed: the next sweep starts it.
    group.failing.start = null;
    await pass(10 * 60_000 + jitter);
    expect(group.tries.alpha).toBe(8);
    expect(group.seatOf("alpha")).not.toBeNull();
  });

  it("stops at once when the seat can't start until the user acts, and only the user's @mention tries again", async () => {
    const group = await setup();
    group.failing.start = "Not logged in · Please run /login";
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    expect((await texts(group)).filter((text) => text.startsWith("system: Alpha"))).toEqual(["system: Alpha couldn't join: Not logged in · Please run /login Fix that, then @mention Alpha to try again."]);
    await group.groups.postFromUser(group.id, { text: "Again" });
    await pass(HOUR);
    expect(group.tries.alpha).toBe(1);
    group.failing.start = null;
    await group.groups.postFromUser(group.id, { text: "@Alpha signed in" });
    await pass();
    expect(group.tries.alpha).toBe(2);
    expect(group.seatOf("alpha")).not.toBeNull();
  });

  it("loses a mention once the next try fails too", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    await group.groups.read(await group.bot("beta"), group.id, {});
    // Alpha's seat goes away and can't start again.
    await group.groups.onRemoved(group.seatOf("alpha")!);
    group.failing.start = "fake isn't available here.";
    const seq = Number(/^Sent as #(\d+)\.$/.exec(await group.groups.send(await group.bot("beta"), group.id, { text: "@Alpha ping" }))?.[1]);
    await pass();
    expect(await group.groups.mentionDelivery(await group.bot("beta"), group.id, seq)).toContain("@Alpha: LOST — target was not running");
    await group.groups.read(await group.bot("beta"), group.id, {});
    const again = Number(/^Sent as #(\d+)\.$/.exec(await group.groups.send(await group.bot("beta"), group.id, { text: "@Alpha ping again" }))?.[1]);
    await pass();
    expect(await group.groups.mentionDelivery(await group.bot("beta"), group.id, again)).toContain("@Alpha: still in flight");
    await pass(1_000);
    expect(await group.groups.mentionDelivery(await group.bot("beta"), group.id, again)).toContain("@Alpha: LOST — target was not running");
  });
});

describe("a busy seat's notice delay", () => {
  it("gives a busy seat one notice for a burst, 3 s after its first message; an idle seat is told at once", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    // Alpha is still working on "Hello"; three messages come in a second apart.
    await group.groups.postFromUser(group.id, { text: "One" });
    await pass(1_000);
    await group.groups.postFromUser(group.id, { text: "Two" });
    await pass(1_000);
    await group.groups.postFromUser(group.id, { text: "Three" });
    await pass(BUSY_NOTICE_DELAY_MS - 2_000 - 1);
    expect(group.sentTo("alpha")).toEqual([]);
    // Beta, idle, was told at once.
    expect(group.sentTo("beta").length).toBeGreaterThan(0);
    await pass(1);
    expect(group.sentTo("alpha")).toHaveLength(1);
    // Its whole inbox ("Hello", which it's still on, and the three).
    expect(group.sentTo("alpha")[0]!.text).toContain("[Group inbox notice: 4 new messages for you to read.");
    await pass(BUSY_NOTICE_RETRY_MS);
    expect(group.sentTo("alpha")).toHaveLength(1);
  });

  it("tells the seat at once when its turn ends before the delay is over, and not again after", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.groups.postFromUser(group.id, { text: "One" });
    await pass(1_000);
    await group.endTurn("alpha", "completed");
    expect(group.sentTo("alpha")).toHaveLength(1);
    await pass(BUSY_NOTICE_DELAY_MS);
    expect(group.sentTo("alpha")).toHaveLength(1);
  });

  it("tries a busy seat again after 15 s when it didn't take the notice", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("beta", "completed");
    await group.groups.postFromUser(group.id, { text: "One" });
    await pass();
    group.chats.failNext();
    await pass(BUSY_NOTICE_DELAY_MS);
    expect(group.sentTo("alpha")).toEqual([]);
    await pass(BUSY_NOTICE_RETRY_MS - 1);
    expect(group.sentTo("alpha")).toEqual([]);
    await pass(1);
    expect(group.sentTo("alpha")).toHaveLength(1);
  });
});

describe("the seen ledger's model context", () => {
  it("drops what a seat saw when it compacts, so its next post is held until it reads again", async () => {
    const group = await setup();
    const alpha = await group.bot("alpha");
    await group.groups.postFromUser(group.id, { text: "What's 2+2?" });
    await pass();
    await group.groups.read(alpha, group.id, { unread: true, topLevel: true });
    expect(group.store.ledger(group.id, "alpha", 0).boundary).toBe(1);
    expect(await group.groups.send(alpha, group.id, { text: "4" })).toBe("Sent as #2.");

    group.groups.onCompaction(group.seatOf("alpha")!);
    expect(group.store.ledger(group.id, "alpha", 0)).toEqual({ boundary: null, exact: new Set(), readOrder: null });
    // Its read position stays: what it read is read, just not in front of this context.
    expect(group.store.cursor(group.id, "alpha", 0)).toBe(2);
    const held = await group.groups.send(alpha, group.id, { text: "Also, 5" });
    expect(held).toMatch(/^Your message wasn't sent: you haven't read the top level yet\. Its latest messages:/);
    await group.groups.read(alpha, group.id, { unread: false });
    expect(await group.groups.sendDraft(alpha, group.id, {})).toBe("Sent as #3.");
  });

  it("keeps a resumed seat's context, and starts a new one for a new session or a runtime that never reports compaction", async () => {
    const group = await setup();
    const alpha = await group.bot("alpha");
    await group.groups.postFromUser(group.id, { text: "Hi" });
    await pass();
    await group.groups.read(alpha, group.id, { unread: true, topLevel: true });
    const seat = group.seatOf("alpha")!;
    group.groups.onSessionOpened({ chatId: seat, resumed: true, reportsCompaction: true });
    expect(group.store.ledger(group.id, "alpha", 0).boundary).toBe(1);
    group.groups.onSessionOpened({ chatId: seat, resumed: true, reportsCompaction: false });
    expect(group.store.ledger(group.id, "alpha", 0).boundary).toBeNull();
    await group.groups.read(alpha, group.id, { unread: false });
    group.groups.onSessionOpened({ chatId: seat, resumed: false, reportsCompaction: true });
    expect(group.store.ledger(group.id, "alpha", 0).boundary).toBeNull();
  });

  it("doesn't introduce a thread again after a compaction, which keeps where it was shown up to", async () => {
    const group = await setup();
    const beta = await group.bot("beta");
    await group.groups.postFromUser(group.id, { text: "Plan" });
    await pass();
    await group.endTurn("alpha", "completed");
    await group.endTurn("beta", "completed");
    await group.groups.read(beta, group.id, { unread: true });
    // Beta pulls Alpha into thread #1: Alpha's notice brings the thread's context.
    await group.groups.send(beta, group.id, { text: "@Alpha look at this", thread: 1 });
    await pass();
    expect(group.sentTo("alpha").at(-1)!.text).toContain("[Thread context: you were @mentioned in thread #1");
    // Its seat took the notice in: the thread is shown up to the mention.
    group.groups.onInputAccepted({ chatId: group.seatOf("alpha")!, clientMessageId: group.noticeIds.at(-1)! });
    expect(group.store.visibleBoundary(group.id, "alpha", 1)).toBe(2);
    await group.endTurn("alpha", "completed");
    group.groups.onCompaction(group.seatOf("alpha")!);
    expect(group.store.ledger(group.id, "alpha", 1).boundary).toBeNull();
    expect(group.store.visibleBoundary(group.id, "alpha", 1)).toBe(2);
    await group.groups.read(beta, group.id, { thread: 1 });
    await group.groups.send(beta, group.id, { text: "@Alpha and this", thread: 1 });
    await pass();
    const notice = group.sentTo("alpha").at(-1)!.text;
    expect(notice).not.toContain("[Thread context");
    expect(notice).toContain("[Group inbox notice:");
  });
});

describe("ChatService's supervision, for a seat (supervision.ts)", () => {
  it("tries a seat whose runtime didn't start again as one that couldn't join, and tells it again what it never took in", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("alpha", "completed");
    await group.groups.postFromUser(group.id, { text: "Again" });
    await pass();
    expect(group.sentTo("alpha")).toHaveLength(1);
    // Its session didn't show anything within the start timeout (ChatService's start.failed).
    const error = startTimeoutText("Claude");
    group.groups.onStartFailed({ chatId: group.seatOf("alpha")!, error });
    await pass();
    expect((await texts(group)).filter((text) => text.startsWith("system: Alpha"))).toEqual([`system: Alpha couldn't start: ${error}`]);
    // The spawn-fail backoff: 1 s, then the notice goes out again with what it was told.
    await pass(999);
    expect(group.sentTo("alpha")).toHaveLength(1);
    await pass(1);
    expect(group.sentTo("alpha")).toHaveLength(2);
    expect(group.sentTo("alpha")[1]!.text).toContain("2 new messages for you to read");
    // A second failure waits twice as long; a start that shows its runtime ends the backoff.
    group.groups.onStartFailed({ chatId: group.seatOf("alpha")!, error });
    await pass(1_999);
    expect(group.sentTo("alpha")).toHaveLength(2);
    await pass(1);
    expect(group.sentTo("alpha")).toHaveLength(3);
    group.groups.onStartReady({ chatId: group.seatOf("alpha")! });
    group.groups.onStartFailed({ chatId: group.seatOf("alpha")!, error });
    await pass(1_000);
    expect(group.sentTo("alpha")).toHaveLength(4);
  });

  it("notes a stalled run's restart without backing off or counting it as a failure", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    const seat = group.seatOf("alpha")!;
    group.seats[seat]!.status = "error";
    await group.groups.onTurnEnded(group.chats.get(seat)! as never, { outcome: "failed", error: "Runtime stalled: no runtime events for 15m (queued=1)", supervision: "stalled" });
    await pass();
    expect((await texts(group)).at(-1)).toBe("system: Alpha's run stalled (Runtime stalled: no runtime events for 15m (queued=1)) and its process was gone, so pocket-bots restarted it.");
    expect(group.store.receivers(group.id, 1).find((row) => row.receiverId === "alpha")?.failure).toBeNull();
    // No backoff: the next message tells it at once.
    group.seats[seat]!.status = "idle";
    await group.groups.postFromUser(group.id, { text: "Still there?" });
    await pass();
    expect(group.sentTo("alpha").at(-1)?.text).toContain("[Group inbox notice:");
    // A failed start's turn end is left to start.failed.
    await group.groups.onTurnEnded(group.chats.get(seat)! as never, { outcome: "failed", error: startTimeoutText("Claude"), supervision: "start_failed" });
    await pass();
    expect((await texts(group)).filter((text) => text.includes("did not finish starting"))).toEqual([]);
  });

  it("starts a seat whose session can't be resumed over, with a briefing, and notes a session started over", async () => {
    const group = await setup();
    await group.groups.postFromUser(group.id, { text: "Hello" });
    await pass();
    await group.endTurn("alpha", "completed");
    const seat = group.seatOf("alpha")!;
    (group.chats as unknown as { sessionNeedsReset: (chatId: string) => boolean }).sessionNeedsReset = (chatId) => chatId === seat;
    await group.groups.postFromUser(group.id, { text: "Next" });
    await pass();
    expect(group.chats.archived).toContain(seat);
    expect(group.seatOf("alpha")).not.toBe(seat);
    expect(group.starts.at(-1)).toMatchObject({ botId: "alpha" });
    expect(group.starts.at(-1)!.prompt).toContain("the old one couldn't be compacted to fit the model any more");
    expect(await texts(group)).toContain("system: Alpha's session failed context compaction too many times in a row to be resumed, so Alpha starts over in a new session with a briefing of the group.");
    // ChatService started one over by itself (a seat opened elsewhere): the group hears it.
    group.groups.onSessionReset({ chatId: group.seatOf("alpha")!, failures: 3 });
    await pass();
    expect((await texts(group)).at(-1)).toBe("system: Alpha's session failed context compaction 3 times in a row, so it started a new session; it doesn't have the conversation from before.");
  });
});
