import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { journalSummary, lastTurn, logLine, matchesAll, parseLog, parseSince, recentWork, redactSecrets, searchWords, snippet } from "../src/shared/activity";
import { lineDiff } from "../src/shared/diff";
import { newUuid } from "../src/shared/uuid";
import { fakeChats, fakeHost, makeBot } from "./helpers";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute);

describe("daily log lines", () => {
  it("takes the last reply and the tools of the latest turn", () => {
    const turn = lastTurn([
      { type: "user_message", text: "old" },
      { type: "assistant_message", text: "old answer" },
      { type: "user_message", text: "Check my inbox" },
      { type: "tool_call", name: "mcp__apps__COMPOSIO_SEARCH_TOOLS" },
      { type: "assistant_message", text: "Looking." },
      { type: "tool_call", name: "Read" },
      { type: "tool_call", name: "Read" },
      { type: "assistant_message", text: "Three new mails." },
    ]);
    expect(turn).toEqual({ reply: "Three new mails.", tools: ["apps/COMPOSIO_SEARCH_TOOLS", "Read"] });
  });

  it("writes one folded, redacted line per turn", () => {
    expect(logLine({ at: at(27, 9, 5), chat: 'Inbox "daily"', reply: "Sent it.\nKey sk-abcdefghijklmnopqrstuv is set.", tools: ["Read"] })).toBe(
      '- 09:05 · from chat "Inbox \'daily\'" · Sent it. Key [redacted] is set. [tools: Read]',
    );
    expect(logLine({ at: at(27, 9, 5), chat: "x", reply: "  ", tools: [] })).toBeNull();
    expect(logLine({ at: at(27, 9, 5), chat: "x", reply: "", tools: [], failure: "rate limited" })).toBe('- 09:05 · from chat "x" · (turn failed: rate limited)');
    expect(logLine({ at: at(27, 9, 5), chat: "x", reply: "a".repeat(400), tools: [] })!.length).toBeLessThan(300);
    expect(redactSecrets("Bearer abcdefghijklmnopqrstuvwxyz0123 and ghp_abcdefghijklmnopqrstuvwxyz")).toBe("Bearer [redacted] and [redacted]");
  });

  it("briefs the newest line from each chat of the last two days", () => {
    const today = parseLog(
      "2026-09-27",
      ['- 08:00 · from chat "Inbox" · First. [tools: Read]', '- 09:30 · from chat "Inbox" · Sent the three invoices.', '- 10:00 · from chat "Report" · (turn failed: boom)', "a note the bot wrote"].join("\n"),
    );
    const earlier = parseLog("2026-09-26", '- 17:40 · from chat "Report" · Drafted the report.\n');
    const old = parseLog("2026-09-24", '- 12:00 · from chat "Old" · Too old.\n');
    expect(today).toHaveLength(3);
    expect(recentWork([...old, ...earlier, ...today], at(27, 12))).toEqual(['- today 09:30 · "Inbox" · you said: "Sent the three invoices."', '- yesterday 17:40 · "Report" · you said: "Drafted the report."']);
  });
});

describe("the journal's diff", () => {
  it("shows changed lines with two lines of context", () => {
    const before = ["# Memory", "a", "b", "c", "d", "e", "f"].join("\n") + "\n";
    const after = ["# Memory", "a", "b", "C", "d", "e", "f", "g"].join("\n") + "\n";
    const { diff, added, removed } = lineDiff(before, after);
    expect({ added, removed }).toEqual({ added: 2, removed: 1 });
    expect(diff).toBe(["@@ -2,6 +2,7 @@", " a", " b", "-c", "+C", " d", " e", " f", "+g"].join("\n"));
    expect(lineDiff("", "one\ntwo\n")).toMatchObject({ diff: "@@ -0,0 +1,2 @@\n+one\n+two", added: 2, removed: 0 });
    expect(lineDiff("same\n", "same\n")).toEqual({ diff: "", added: 0, removed: 0 });
  });
});

describe("search helpers", () => {
  it("matches every content word and marks them", () => {
    expect(searchWords("What did we decide about the Q3 invoices?")).toEqual(["decide", "q3", "invoices"]);
    expect(matchesAll("Invoices for Q3 are late", ["q3", "invoices"])).toBe(true);
    expect(matchesAll("Invoices are late", ["q3", "invoices"])).toBe(false);
    expect(snippet("The Q3 invoices went out.", ["q3", "invoices"])).toBe("The [Q3] [invoices] went out.");
  });

  it("reads time ranges", () => {
    const now = at(27, 12);
    expect(parseSince("24h", now)).toEqual(at(26, 12));
    expect(parseSince("today", now)).toEqual(at(27, 0));
    expect(parseSince("yesterday", now)).toEqual(at(26, 0));
    expect(parseSince("2w", now)).toEqual(at(13, 12));
    expect(parseSince("2026-09-01", now)).toEqual(at(1, 0));
    expect(() => parseSince("last tuesday", now)).toThrow("Couldn't read");
  });

  it("words journal rows the way the person reads them", () => {
    const row = { file: "MEMORY.md", actor: "bot" as const, via: "chat" as const, chat: { title: "x" }, kind: "edited" as const, added: 2, removed: 0 };
    expect(journalSummary(row, "Scout")).toBe("Scout added 2 lines to MEMORY.md");
    expect(journalSummary({ ...row, actor: "you", file: "clients.md", kind: "deleted" }, "Scout")).toBe("You deleted the clients topic");
    expect(journalSummary({ ...row, added: 3, removed: 1 }, "Scout")).toBe("Scout rewrote 3 lines in MEMORY.md");
  });
});

describe("memory journal, daily log and search_chats", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pocket-bots-activity-"));
    process.env.POCKET_BOTS_HOME = home;
  });
  afterAll(async () => {
    delete process.env.POCKET_BOTS_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("journals the bot's edits during a turn, the person's edits, and undoes them", async () => {
    const { MemoryJournal } = await import("../src/server/journal");
    const { memoryFilePath } = await import("../src/server/memory");
    const journal = new MemoryJournal();
    const main = memoryFilePath("bot-j", "MEMORY.md");
    await mkdir(join(main, ".."), { recursive: true });
    await writeFile(main, "# Memory\n- likes tea\n");

    await journal.begin("bot-j");
    await writeFile(main, "# Memory\n- likes tea\n- works Mon-Fri\n");
    await mkdir(join(main, "..", "memory"), { recursive: true });
    await writeFile(memoryFilePath("bot-j", "clients.md"), "# Clients\n");
    await journal.end("bot-j", { id: "chat-1", title: "Setup" });

    let entries = await journal.list("bot-j");
    expect(entries.map((entry) => [entry.file, entry.actor, entry.kind, entry.added, entry.removed])).toEqual([
      ["clients.md", "bot", "created", 1, 0],
      ["MEMORY.md", "bot", "edited", 1, 0],
    ]);
    expect(entries[1]!.chat).toEqual({ id: "chat-1", title: "Setup" });

    // Changed outside the app between turns.
    await writeFile(main, "# Memory\n");
    await journal.begin("bot-j");
    entries = await journal.list("bot-j");
    expect(entries[0]).toMatchObject({ file: "MEMORY.md", actor: "you", via: "disk", removed: 2 });

    await journal.undo("bot-j", entries[0]!.id);
    expect(await readFile(main, "utf8")).toBe("# Memory\n- likes tea\n- works Mon-Fri\n");
    const created = (await journal.list("bot-j")).find((entry) => entry.kind === "created")!;
    await journal.undo("bot-j", created.id);
    await expect(readFile(memoryFilePath("bot-j", "clients.md"), "utf8")).rejects.toThrow();

    await journal.write("bot-j", "MEMORY.md", "# Memory\n- edited in the app\n");
    const latest = (await journal.list("bot-j"))[0]!;
    expect(latest).toMatchObject({ actor: "you", via: "app", kind: "edited" });
    expect((await journal.list("bot-j")).filter((entry) => entry.via === "undo")).toHaveLength(2);
  });

  it("logs finished turns of bot chats and searches chats and memory", async () => {
    const { wireActivity } = await import("../src/server/activity");
    const { MemoryJournal } = await import("../src/server/journal");
    const { listLogDays, recentLogEntries } = await import("../src/server/memory");
    const { searchChats } = await import("../src/server/tools/chats");
    const host = fakeHost([makeBot({ id: "bot-s", name: "Scout" })]);
    // A watcher that hands its handlers to the test.
    const handlers = new Map<string, (event: unknown, api: unknown) => Promise<void>>();
    const watcher = { on: (name: string, handler: (event: unknown, api: unknown) => Promise<void>) => void handlers.set(name, handler) };
    const finished: string[] = [];
    wireActivity({ watcher: watcher as never, journal: new MemoryJournal(), scheduler: { finished: async (_routine: string, _agent: string, outcome: { kind: string }) => void finished.push(outcome.kind) } as never });
    const turnEnded = (event: unknown) => handlers.get("turn.ended")!(event, null);
    const agent = { id: newUuid(), cwd: "/", title: "Invoices", labels: { "pocket-bots": "1", "pocket-bots.bot": "bot-s" } };

    const timeline = [
      { type: "user_message", text: "Send the Q3 invoices" },
      { type: "tool_call", name: "mcp__apps__GMAIL_SEND", callId: "1", status: "completed", detail: { type: "unknown", input: null, output: null }, error: null },
      { type: "assistant_message", text: "Sent the three Q3 invoices to Acme." },
    ];
    await turnEnded({ agent, outcome: { kind: "completed" }, timeline, missed: false });
    await turnEnded({ agent: { ...agent, id: "other-agent", labels: {} }, outcome: { kind: "completed" }, timeline, missed: false });
    await turnEnded({ agent, outcome: { kind: "canceled", reason: "stopped" }, timeline, missed: false });
    // A stopped routine run is recorded as stopped, and the log skips it.
    const stoppedRun = { ...agent, id: newUuid(), status: "idle", labels: { ...agent.labels, "pocket-bots.routine": "rt-1" } };
    await turnEnded({ agent: stoppedRun, outcome: { kind: "canceled", reason: "Stopped." }, timeline, missed: false });
    expect(finished).toEqual(["canceled"]);
    expect((await listLogDays("bot-s")).days).toEqual([{ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), lines: 1 }]);
    const [entry] = await recentLogEntries("bot-s", 1);
    expect(entry).toMatchObject({ chat: "Invoices", text: "Sent the three Q3 invoices to Acme. [tools: apps/GMAIL_SEND]" });

    const current = newUuid();
    const past = { id: newUuid(), title: "Invoices", updatedAt: new Date().toISOString() };
    const entries = [
      { item: { type: "user_message", text: "Send the Q3 invoices" }, timestamp: new Date(Date.now() - 60_000).toISOString() },
      { item: { type: "assistant_message", text: "Sent the three Q3 invoices to Acme." }, timestamp: new Date().toISOString() },
    ];
    const chats = fakeChats({
      [current]: { status: "idle", title: "Now", labels: { "pocket-bots.bot": "bot-s" }, items: [{ type: "user_message", text: "q3 invoices again" }] },
      [past.id]: { status: "idle", title: past.title, updatedAt: past.updatedAt, labels: { "pocket-bots.bot": "bot-s" }, items: entries.map((entry) => entry.item) },
      elsewhere: { status: "idle", title: "Other bot", labels: { "pocket-bots.bot": "bot-x" }, items: [{ type: "user_message", text: "q3 invoices" }] },
    });
    host.attach(chats);
    const caller = { bot: makeBot({ id: "bot-s" }), agentId: current, host, relay: null as never };
    const found = await searchChats.run({ query: "q3 invoices" }, caller);
    expect(found).not.toContain("Other bot");
    expect(found).toContain("Memory:\n- [memory/log/");
    expect(found).toContain(`chat "Invoices" (id: ${past.id}) · you] Sent the three [Q3] [invoices] to Acme.`);
    expect(found).toContain("· the user] Send the [Q3] [invoices]");
    expect(found).not.toContain("again");
    expect(await searchChats.run({ query: "unicorns" }, caller)).toBe("Nothing matched.");
    await expect(searchChats.run({}, caller)).rejects.toThrow("Give a few words");
  });
});
