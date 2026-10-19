// ChatService's supervision of runtimes, under fake timers: the start limit and what a start
// carries in, the start timeout, the turn-start watchdog, stalled-run recovery, and the
// compaction watchdog and failure ledger. Real ChatService and SQLite; the runtime is the fake one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter, type FakeScript, type FakeSession, type ProviderId, type SendResult } from "@pocket-bots/runtime";
import { ChatService, type ChatEvents, type TurnEndedEvent } from "../src/server/chat-service";
import { Db } from "../src/server/db";
import {
  COMPACTION_STALE_MS,
  countCompactionFailure,
  MAX_CONCURRENT_STARTS,
  PROGRESS_CHECK_MS,
  RUNTIME_PROGRESS_STALE_MS,
  RUNTIME_START_TIMEOUT_MS,
  sessionNeedsReset,
  sessionResetText,
  START_INTERVAL_MS,
  StartCoordinator,
  STALLED_RECOVERY_SIGTERM_TIMEOUT_MS,
  startTimeoutText,
  TURN_START_OBSERVATION_MS,
} from "../src/server/supervision";

let cleanup: (() => Promise<void>) | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Lets promise chains run, and moves time on by `ms`. */
const pass = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
  for (let index = 0; index < 50; index++) await Promise.resolve();
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function setup(script?: FakeScript, provider: ProviderId = "fake") {
  const dir = mkdtempSync(join(tmpdir(), "bots-supervision-"));
  const db = new Db(join(dir, "bots.sqlite"));
  const fake = new FakeAdapter(script);
  const chats = new ChatService(db, new Map([[provider, fake]]), async () => ({ systemPrompt: "", mcpServers: {}, trustedTools: [] }), async () => null);
  chats.start();
  const events: { [K in keyof ChatEvents]?: ChatEvents[K][] } = {};
  const record = <K extends keyof ChatEvents>(name: K) => {
    events[name] = [];
    chats.on(name, (event) => void events[name]!.push(event as never));
  };
  for (const name of ["turn.ended", "input.accepted", "start.ready", "start.failed", "session.reset"] as const) record(name);
  const ended = () => (events["turn.ended"] ?? []) as TurnEndedEvent[];
  const create = (text?: string) => chats.create({ botId: null, provider, cwd: tmpdir() }, text ? { text } : undefined);
  const notices = (chatId: string) => chats.items(chatId, 400).flatMap((item) => (item.type === "notification" || item.type === "error" ? [item.message] : []));
  cleanup = () => chats.stop();
  return { db, fake, chats, events, ended, create, notices };
}

const session = (fake: FakeAdapter, index = -1) => fake.sessions.at(index) as FakeSession;

describe("the start limit", () => {
  it("starts at most six runtimes at once across all chats, each 500 ms after the one before", async () => {
    const { fake, create, chats } = setup();
    const opens: number[] = [];
    const held: ReturnType<typeof deferred>[] = [];
    fake.beforeOpen = async () => {
      opens.push(Date.now());
      const gate = deferred();
      held.push(gate);
      await gate.promise;
    };
    const ids: string[] = [];
    for (let index = 0; index < 7; index++) ids.push(await create());
    const startedAt = Date.now();
    const sends = ids.map((id, index) => chats.send(id, { text: `hello ${index}` }));
    await pass();
    expect(opens).toHaveLength(1);
    await pass(START_INTERVAL_MS * 5);
    // Six at once (a group has at most six bots), half a second apart.
    expect(MAX_CONCURRENT_STARTS).toBe(6);
    expect(opens.map((at) => at - startedAt)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
    await pass(10_000);
    expect(opens).toHaveLength(6);
    // A slot comes free when a start's runtime is open and its first input written.
    held[0]!.resolve();
    await pass();
    expect(opens).toHaveLength(7);
    for (const gate of held) gate.resolve();
    await pass();
    expect((await Promise.all(sends)).every((result) => result.ok)).toBe(true);
  });

  it("doesn't space out a chat starting again right after itself, and lets go of a queued start", async () => {
    const coordinator = new StartCoordinator(1, START_INTERVAL_MS);
    const order: string[] = [];
    const first = await coordinator.acquire("a");
    const again = coordinator.acquire("a").then((release) => (order.push("a"), release));
    const other = coordinator.acquire("b").then((release) => (order.push("b"), release));
    const gone = coordinator.acquire("c").catch((error: Error) => order.push(`c: ${error.message}`));
    expect(coordinator.cancel("c", "closed")).toBe(true);
    await pass();
    first();
    await pass();
    expect(order).toEqual(["c: closed", "a"]);
    (await again)();
    await pass(START_INTERVAL_MS - 1);
    expect(order).toEqual(["c: closed", "a"]);
    await pass(1);
    expect(order).toEqual(["c: closed", "a", "b"]);
    (await other)();
    await gone;
    expect(coordinator.snapshot()).toEqual({ active: 0, queued: [] });
  });

  it("carries what's sent while a start waits into its first input", async () => {
    const { fake, create, chats, events } = setup((turn, step) => (step === 0 ? { say: `got: ${turn.text}` } : null));
    const gate = deferred();
    fake.beforeOpen = () => gate.promise;
    const id = await create();
    const sends = [chats.send(id, { text: "one", clientMessageId: "m1" }), chats.send(id, { text: "two", clientMessageId: "m2" }), chats.send(id, { text: "three", clientMessageId: "m3" })];
    await pass();
    gate.resolve();
    const results = await Promise.all(sends);
    expect(fake.sessions).toHaveLength(1);
    expect(results.every((result) => result.ok && result.as === "turn")).toBe(true);
    expect(new Set(results.map((result) => (result as Extract<SendResult, { ok: true }>).turnId)).size).toBe(1);
    expect(chats.items(id).at(-1)).toMatchObject({ type: "assistant_message", text: "got: one\n\ntwo\n\nthree" });
    // Each message is told as taken in, the carried ones with the first.
    expect(events["input.accepted"]!.map((event) => event.clientMessageId)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("the start timeout", () => {
  it("fails a start whose runtime never finishes opening, and closes it if it opens later", async () => {
    const { fake, create, chats, events } = setup();
    const gate = deferred();
    fake.beforeOpen = () => gate.promise;
    const id = await create();
    let result: SendResult | null = null;
    void chats.send(id, { text: "hello" }).then((sent) => (result = sent));
    await pass(RUNTIME_START_TIMEOUT_MS - 1);
    expect(result).toBeNull();
    await pass(1);
    const detail = startTimeoutText("Test runtime");
    expect(result).toEqual({ ok: false, reason: "error", detail });
    expect(events["start.failed"]).toEqual([{ chatId: id, error: detail }]);
    expect(chats.get(id)).toMatchObject({ status: "error", lastError: detail });
    gate.resolve();
    await pass();
    expect(session(fake).state).toBe("closed");
  });

  it("fails a start that shows no runtime event: its runtime is stopped and its turn fails", async () => {
    const { fake, create, chats, events, ended } = setup();
    fake.sessionDefaults = { silent: true };
    const id = await create("hello");
    expect(chats.get(id)?.status).toBe("running");
    await pass(RUNTIME_START_TIMEOUT_MS);
    const detail = startTimeoutText("Test runtime");
    expect(session(fake).kills).toEqual(["SIGTERM"]);
    expect(ended()).toHaveLength(1);
    expect(ended()[0]).toMatchObject({ outcome: { kind: "failed", error: { message: detail } }, supervision: "start_failed" });
    expect(events["start.failed"]).toEqual([{ chatId: id, error: detail }]);
    expect(chats.get(id)?.status).toBe("error");
    // The next message starts it again.
    fake.sessionDefaults = {};
    expect(await chats.send(id, { text: "again" })).toMatchObject({ ok: true });
    expect(fake.sessions).toHaveLength(2);
  });

  it("settles a start at its first runtime event", async () => {
    const { create, events } = setup((_turn, step) => (step === 0 ? { wait: 1_000 } : step === 1 ? { say: "done" } : null));
    const id = await create("hello");
    expect(events["start.ready"]).toEqual([{ chatId: id }]);
    await pass(RUNTIME_START_TIMEOUT_MS * 2);
    expect(events["start.failed"]).toEqual([]);
  });
});

describe("the turn-start watchdog", () => {
  it("returns a chat to idle when its runtime doesn't show an idle write's turn within 30 s", async () => {
    const { fake, create, chats, ended, notices } = setup();
    fake.sessionDefaults = { reportsTurns: true };
    const id = await create("hello");
    await pass();
    expect(ended()).toHaveLength(1);
    session(fake).silent = true;
    expect(await chats.send(id, { text: "are you there?" })).toMatchObject({ ok: true, as: "turn" });
    await pass(TURN_START_OBSERVATION_MS - 1);
    expect(chats.get(id)?.status).toBe("running");
    await pass(1);
    expect(chats.get(id)?.status).toBe("idle");
    expect(ended()[1]?.outcome.kind).toBe("canceled");
    expect(notices(id)).toContain("Test runtime didn't show this turn within 30 seconds, so the chat is idle again.");
  });

  it("leaves a turn the runtime shows, and a runtime that doesn't show its turns, alone", async () => {
    const { fake, create, chats } = setup((_turn, step) => (step === 0 ? { wait: 60 * 60_000 } : null));
    fake.sessionDefaults = { reportsTurns: true };
    const shown = await create("long");
    await pass(TURN_START_OBSERVATION_MS * 2);
    expect(chats.get(shown)?.status).toBe("running");

    fake.sessionDefaults = {};
    const unknown = await create();
    expect(await chats.send(unknown, { text: "first" })).toMatchObject({ ok: true });
    await chats.interrupt(unknown);
    await pass();
    session(fake).silent = true;
    await chats.send(unknown, { text: "second" });
    await pass(TURN_START_OBSERVATION_MS * 2);
    expect(chats.get(unknown)?.status).toBe("running");
  });
});

describe("stalled runs", () => {
  const long: FakeScript = (turn, step) => (turn.text === "long" ? (step === 0 ? { wait: 3 * 60 * 60_000 } : null) : step === 0 ? { say: `got: ${turn.text}` } : null);

  it("restarts a run that showed nothing for 15 min and whose process is gone, and sends what it hadn't taken in again", async () => {
    const { fake, create, chats, ended, notices, events } = setup(long);
    const id = await create("long");
    // A steer the runtime hasn't taken in yet (the fake takes steers after its wait).
    expect(await chats.send(id, { text: "also this", clientMessageId: "steer-1" })).toMatchObject({ ok: true, as: "steer" });
    const first = session(fake);
    first.processAlive = false;
    await pass(RUNTIME_PROGRESS_STALE_MS - PROGRESS_CHECK_MS);
    expect(first.kills).toEqual([]);
    await pass(PROGRESS_CHECK_MS);
    expect(first.kills).toEqual(["SIGTERM"]);
    expect(ended()[0]).toMatchObject({ outcome: { kind: "failed", error: { message: "Runtime stalled: no runtime events for 15m (queued=1)" } }, supervision: "stalled" });
    expect(notices(id)).toContain("Test runtime showed nothing for 15 minutes and its process is gone, so pocket-bots restarted it; what it hadn't taken in yet goes to it again.");
    // The new start resumes the session with what was waiting, under its own id.
    await pass();
    expect(fake.sessions).toHaveLength(2);
    expect(session(fake).spec.resume).toEqual(first.handle);
    expect(chats.items(id).at(-1)).toMatchObject({ type: "assistant_message", text: "got: also this" });
    expect(events["input.accepted"]!.map((event) => event.clientMessageId)).toContain("steer-1");
    await pass(STALLED_RECOVERY_SIGTERM_TIMEOUT_MS);
    expect(first.kills).toEqual(["SIGTERM"]);
  });

  it("kills a stalled runtime SIGTERM didn't end within 10 s", async () => {
    const { fake, create } = setup(long);
    await create("long");
    const stuck = session(fake);
    stuck.processAlive = false;
    stuck.kill = (signal) => {
      stuck.kills.push(signal);
      stuck.processAlive = undefined;
    };
    await pass(RUNTIME_PROGRESS_STALE_MS);
    expect(stuck.kills).toEqual(["SIGTERM"]);
    await pass(STALLED_RECOVERY_SIGTERM_TIMEOUT_MS);
    expect(stuck.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("only records a silent run whose process is alive, once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, create, chats } = setup(long);
    const id = await create("long");
    session(fake).processAlive = true;
    await pass(2 * RUNTIME_PROGRESS_STALE_MS);
    expect(session(fake).kills).toEqual([]);
    expect(chats.get(id)?.status).toBe("running");
    expect(warn.mock.calls.filter(([text]) => String(text).includes("no runtime events"))).toHaveLength(1);
  });

  it("returns a busy chat to idle when its live runtime shows no turn running", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, create, chats, notices } = setup(long);
    fake.sessionDefaults = { reportsTurns: true, processAlive: true };
    const id = await create("long");
    session(fake).forgetTurn();
    await pass(RUNTIME_PROGRESS_STALE_MS);
    expect(chats.get(id)?.status).toBe("idle");
    expect(notices(id)).toContain("Test runtime shows no turn running and nothing happened for 15 minutes, so the chat is idle again.");
  });
});

describe("compactions", () => {
  it("says when a compaction shows no finish within 5 min", async () => {
    const { create, notices } = setup((_turn, step) => (step === 0 ? { emit: { type: "compaction", status: "loading", trigger: "auto" } } : step === 1 ? { wait: 60 * 60_000 } : null));
    const id = await create("hello");
    await pass(COMPACTION_STALE_MS - 1);
    expect(notices(id)).not.toContain("Context compaction is still running; no finish was seen.");
    await pass(1);
    expect(notices(id)).toContain("Context compaction is still running; no finish was seen.");
  });

  const compacting = (outcome: { failed: boolean }): FakeScript => (_turn, step) =>
    step === 0 ? { emit: outcome.failed ? { type: "compaction", status: "failed", trigger: "auto", error: "The summary request didn't fit." } : { type: "compaction", status: "completed", trigger: "auto" } } : null;

  it("stops resuming a Pi session whose compaction failed three times in a row; the next start opens a new one and says so", async () => {
    const outcome = { failed: true };
    const { fake, create, chats, events, db, notices } = setup(compacting(outcome), "pi");
    const id = await create("one");
    const sessionId = session(fake).handle!.sessionId;
    await chats.send(id, { text: "two" });
    expect(chats.sessionNeedsReset(id)).toBe(false);
    await chats.send(id, { text: "three" });
    expect(JSON.parse(db.get<{ compaction_failures: string }>("SELECT compaction_failures FROM chats WHERE id = ?", id)!.compaction_failures)).toMatchObject({ sessionId, model: null, count: 3 });
    expect(chats.sessionNeedsReset(id)).toBe(true);
    // Its session closes (idle, say); the next start doesn't resume it.
    await chats.archive(id);
    outcome.failed = false;
    await chats.send(id, { text: "four" });
    expect(fake.sessions).toHaveLength(2);
    expect(session(fake).spec.resume).toBeUndefined();
    expect(notices(id)).toContain(sessionResetText("Test runtime", 3));
    expect(events["session.reset"]).toEqual([{ chatId: id, failures: 3 }]);
    expect(chats.sessionNeedsReset(id)).toBe(false);
  });

  it("clears the count on a success, and counts only on Pi", async () => {
    const outcome = { failed: true };
    const pi = setup(compacting(outcome), "pi");
    const id = await pi.create("one");
    await pi.chats.send(id, { text: "two" });
    outcome.failed = false;
    await pi.chats.send(id, { text: "three" });
    expect(pi.db.get<{ compaction_failures: string | null }>("SELECT compaction_failures FROM chats WHERE id = ?", id)!.compaction_failures).toBeNull();
    await pi.chats.stop();

    outcome.failed = true;
    const other = setup(compacting(outcome));
    const chat = await other.create("one");
    await other.chats.send(chat, { text: "two" });
    await other.chats.send(chat, { text: "three" });
    expect(other.db.get<{ compaction_failures: string | null }>("SELECT compaction_failures FROM chats WHERE id = ?", chat)!.compaction_failures).toBeNull();
  });

  it("starts the count over for another session or another model", () => {
    let record = countCompactionFailure(null, "s1", "m1", "t");
    record = countCompactionFailure(record, "s1", "m1", "t");
    record = countCompactionFailure(record, "s1", "m1", "t");
    expect(record.count).toBe(3);
    expect(sessionNeedsReset(record, "s1", "m1")).toBe(3);
    expect(sessionNeedsReset(record, "s2", "m1")).toBeNull();
    expect(sessionNeedsReset(record, "s1", "m2")).toBeNull();
    expect(countCompactionFailure(record, "s1", "m2", "t").count).toBe(1);
    expect(countCompactionFailure(record, "s2", "m1", "t").count).toBe(1);
  });
});
