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

    await journal.begin("bot-j", "chat-1");
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
    await journal.begin("bot-j", "chat-2");
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

  it("puts back a read-only bot's memory changes when its turn ends, journals them, and lets the person undo", async () => {
    const { MemoryJournal } = await import("../src/server/journal");
    const { memoryFilePath } = await import("../src/server/memory");
    const journal = new MemoryJournal();
    const main = memoryFilePath("bot-r", "MEMORY.md");
    const topic = memoryFilePath("bot-r", "clients.md");
    const chat = { id: "chat-r", title: "Notes" };
    await mkdir(join(main, ".."), { recursive: true });
    await mkdir(join(main, "..", "memory"), { recursive: true });
    await writeFile(main, "# Memory\n- likes tea\n");
    await writeFile(topic, "# Clients\n- Acme\n");

    // The bot edits MEMORY.md, deletes a topic and creates another.
    await journal.begin("bot-r", "chat-r");
    await writeFile(main, "# Memory\n- likes tea\n- works Mon-Fri\n");
    await rm(topic);
    await writeFile(memoryFilePath("bot-r", "ideas.md"), "# Ideas\n");
    await journal.end("bot-r", chat, { readOnly: true });
    expect(await readFile(main, "utf8")).toBe("# Memory\n- likes tea\n");
    expect(await readFile(topic, "utf8")).toBe("# Clients\n- Acme\n");
    await expect(readFile(memoryFilePath("bot-r", "ideas.md"), "utf8")).rejects.toThrow();

    // What the bot did, then what was put back, each in its own entry.
    const entries = await journal.list("bot-r");
    const summary = (entry: (typeof entries)[number]) => [entry.file, entry.actor, entry.via, entry.kind];
    expect(entries.filter((entry) => entry.actor === "bot").map(summary).sort()).toEqual([
      ["MEMORY.md", "bot", "chat", "edited"],
      ["clients.md", "bot", "chat", "deleted"],
      ["ideas.md", "bot", "chat", "created"],
    ]);
    expect(entries.filter((entry) => entry.via === "restore").map(summary).sort()).toEqual([
      ["MEMORY.md", "you", "restore", "edited"],
      ["clients.md", "you", "restore", "created"],
      ["ideas.md", "you", "restore", "deleted"],
    ]);
    expect(entries.filter((entry) => entry.via === "restore").every((entry) => entry.chat?.id === "chat-r")).toBe(true);

    // The restore was the app's doing: the next turn's start finds nothing changed outside the app.
    const count = entries.length;
    await journal.begin("bot-r", "chat-r");
    expect(await journal.list("bot-r")).toHaveLength(count);

    // Undoing a restore gives the bot's version back.
    const restoredMain = entries.find((entry) => entry.via === "restore" && entry.file === "MEMORY.md")!;
    await journal.undo("bot-r", restoredMain.id);
    expect(await readFile(main, "utf8")).toBe("# Memory\n- likes tea\n- works Mon-Fri\n");
    const restoredIdeas = entries.find((entry) => entry.via === "restore" && entry.file === "ideas.md")!;
    await journal.undo("bot-r", restoredIdeas.id);
    expect(await readFile(memoryFilePath("bot-r", "ideas.md"), "utf8")).toBe("# Ideas\n");
  });

  it("leaves a bot's memory changes alone when memory writing is on, and never touches the person's edits", async () => {
    const { MemoryJournal } = await import("../src/server/journal");
    const { memoryFilePath } = await import("../src/server/memory");
    const journal = new MemoryJournal();
    const main = memoryFilePath("bot-w", "MEMORY.md");
    await mkdir(join(main, ".."), { recursive: true });
    await writeFile(main, "# Memory\n");

    await journal.begin("bot-w", "c");
    await writeFile(main, "# Memory\n- by the bot\n");
    await journal.end("bot-w", { id: "c", title: "t" }, { readOnly: false });
    expect(await readFile(main, "utf8")).toBe("# Memory\n- by the bot\n");
    expect((await journal.list("bot-w")).map((entry) => entry.via)).toEqual(["chat"]);

    // The person edits through the app during a read-only bot's turn: that edit stays, the bot's doesn't.
    await journal.begin("bot-w", "c");
    await journal.write("bot-w", "MEMORY.md", "# Memory\n- by me\n");
    await mkdir(join(main, "..", "memory"), { recursive: true });
    await writeFile(memoryFilePath("bot-w", "later.md"), "bot topic");
    await journal.end("bot-w", { id: "c", title: "t" }, { readOnly: true });
    expect(await readFile(main, "utf8")).toBe("# Memory\n- by me\n");
    await expect(readFile(memoryFilePath("bot-w", "later.md"), "utf8")).rejects.toThrow();
    // Writing through the journal has no switch to check, and a turn that changed nothing records nothing.
    const before = (await journal.list("bot-w")).length;
    await journal.begin("bot-w", "c");
    await journal.end("bot-w", { id: "c", title: "t" }, { readOnly: true });
    expect(await journal.list("bot-w")).toHaveLength(before);
  });

  describe("a bot with several turns running at once", () => {
    const setup = async (botId: string) => {
      const { MemoryJournal } = await import("../src/server/journal");
      const { memoryFilePath } = await import("../src/server/memory");
      const main = memoryFilePath(botId, "MEMORY.md");
      await mkdir(join(main, ".."), { recursive: true });
      await writeFile(main, "# Memory\n");
      return { journal: new MemoryJournal(), main, chat: (id: string) => ({ id, title: `Chat ${id}` }) };
    };

    it("still puts back what a read-only bot wrote in a turn that was running when another turn started", async () => {
      const { journal, main, chat } = await setup("bot-p");
      await journal.begin("bot-p", "a", { readOnly: true });
      await writeFile(main, "# Memory\n- written in turn A\n");
      // B starts while A runs: the change is A's, not the person's.
      await journal.begin("bot-p", "b", { readOnly: true });
      expect((await journal.list("bot-p")).filter((entry) => entry.via === "disk")).toEqual([]);
      await journal.end("bot-p", chat("a"), { readOnly: true });
      expect(await readFile(main, "utf8")).toBe("# Memory\n");
      expect((await journal.list("bot-p")).map((entry) => [entry.actor, entry.via, entry.chat?.id])).toEqual([
        ["you", "restore", "a"],
        ["bot", "chat", "a"],
      ]);
      // B ends with nothing left to find.
      await journal.end("bot-p", chat("b"), { readOnly: true });
      expect(await journal.list("bot-p")).toHaveLength(2);
    });

    it("records a change made on disk with no turn running as the person's, and keeps it", async () => {
      const { journal, main, chat } = await setup("bot-q");
      await journal.begin("bot-q", "a", { readOnly: true });
      await journal.end("bot-q", chat("a"), { readOnly: true });
      await writeFile(main, "# Memory\n- typed in an editor\n");
      await journal.begin("bot-q", "b", { readOnly: true });
      expect((await journal.list("bot-q")).map((entry) => [entry.actor, entry.via])).toEqual([["you", "disk"]]);
      await journal.end("bot-q", chat("b"), { readOnly: true });
      expect(await readFile(main, "utf8")).toBe("# Memory\n- typed in an editor\n");
      expect(await journal.list("bot-q")).toHaveLength(1);
    });

    it("leaves a turn ended without `end`, or a deleted chat's turn, out of the running turns", async () => {
      const { journal, main, chat } = await setup("bot-l");
      await journal.begin("bot-l", "a", { readOnly: true });
      await journal.begin("bot-l", "b", { readOnly: true });
      await journal.leave("bot-l", "a");
      await journal.forget("b");
      await writeFile(main, "# Memory\n- typed in an editor\n");
      await journal.begin("bot-l", "c", { readOnly: true });
      expect((await journal.list("bot-l")).map((entry) => [entry.actor, entry.via])).toEqual([["you", "disk"]]);
      await journal.end("bot-l", chat("c"), { readOnly: true });
      expect(await readFile(main, "utf8")).toBe("# Memory\n- typed in an editor\n");
      // The same chat starting twice is still one running turn.
      await journal.begin("bot-l", "c", { readOnly: true });
      await journal.begin("bot-l", "c", { readOnly: true });
      await journal.end("bot-l", chat("c"), { readOnly: true });
      await writeFile(main, "# Memory\n- typed again\n");
      await journal.begin("bot-l", "d", { readOnly: true });
      expect((await journal.list("bot-l"))[0]).toMatchObject({ actor: "you", via: "disk" });
    });

    it("behaves as before when memory writing is on", async () => {
      const { journal, main, chat } = await setup("bot-n");
      await journal.begin("bot-n", "a");
      await writeFile(main, "# Memory\n- written in turn A\n");
      await journal.begin("bot-n", "b");
      // Taken for a change made outside the app, as it always was.
      expect((await journal.list("bot-n")).map((entry) => [entry.actor, entry.via])).toEqual([["you", "disk"]]);
      await journal.end("bot-n", chat("a"));
      await journal.end("bot-n", chat("b"));
      expect(await readFile(main, "utf8")).toBe("# Memory\n- written in turn A\n");
      expect(await journal.list("bot-n")).toHaveLength(1);
    });

    it("is wired to the chats' turns: a read-only bot's parallel turns, a turn nobody saw start, and a deleted chat", async () => {
      const { wireActivity } = await import("../src/server/activity");
      const bot = makeBot({ id: "bot-t", name: "Tern", memoryAutoWrite: false });
      const { journal, main } = await setup("bot-t");
      const handlers = new Map<string, (event: unknown, api: unknown) => Promise<void>>();
      const watcher = { on: (name: string, handler: (event: unknown, api: unknown) => Promise<void>) => void handlers.set(name, handler) };
      wireActivity({ watcher: watcher as never, host: fakeHost([bot]), journal, scheduler: { finished: async () => {} } as never });
      const labels = { "pocket-bots": "1", "pocket-bots.bot": "bot-t" };
      const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => ({ id, cwd: "/", title: `Chat ${id}`, labels }));
      const started = (agent: unknown) => handlers.get("turn.started")!({ agent }, null);
      const ended = (agent: unknown, missed = false) => handlers.get("turn.ended")!({ agent, outcome: { kind: "completed" }, timeline: [], missed }, null);
      const via = async () => (await journal.list("bot-t")).map((entry) => entry.via);

      await started(a);
      await writeFile(main, "# Memory\n- from a\n");
      await started(b);
      await ended(a);
      expect(await readFile(main, "utf8")).toBe("# Memory\n");
      expect(await via()).toEqual(["restore", "chat"]);

      // b's end wasn't seen to begin with (missed); c's chat was deleted. Neither keeps later changes from being the person's.
      await ended(b, true);
      await started(c);
      await handlers.get("agent.removed")!({ agentId: "c" }, null);
      await writeFile(main, "# Memory\n- typed in an editor\n");
      await started(d);
      expect(await via()).toEqual(["disk", "restore", "chat"]);
      await ended(d);
      expect(await readFile(main, "utf8")).toBe("# Memory\n- typed in an editor\n");
    });
  });

  it("with memory writing off, a finished turn keeps no daily log and loses the bot's memory edits; with it on, both stay", async () => {
    const { wireActivity } = await import("../src/server/activity");
    const { MemoryJournal } = await import("../src/server/journal");
    const { listLogDays, memoryFilePath } = await import("../src/server/memory");
    const bot = makeBot({ id: "bot-o", name: "Owl", memoryAutoWrite: false });
    const journal = new MemoryJournal();
    const handlers = new Map<string, (event: unknown, api: unknown) => Promise<void>>();
    const watcher = { on: (name: string, handler: (event: unknown, api: unknown) => Promise<void>) => void handlers.set(name, handler) };
    wireActivity({ watcher: watcher as never, host: fakeHost([bot]), journal, scheduler: { finished: async () => {} } as never });
    const agent = { id: newUuid(), cwd: "/", title: "Notes", labels: { "pocket-bots": "1", "pocket-bots.bot": "bot-o" } };
    const timeline = [
      { type: "user_message", text: "Remember my dentist" },
      { type: "assistant_message", text: "Noted." },
    ];
    const main = memoryFilePath("bot-o", "MEMORY.md");
    await mkdir(join(main, ".."), { recursive: true });
    await writeFile(main, "# Memory\n");
    const turn = async (edit: string) => {
      await handlers.get("turn.started")!({ agent }, null);
      await writeFile(main, edit);
      await handlers.get("turn.ended")!({ agent, outcome: { kind: "completed" }, timeline, missed: false }, null);
    };

    await turn("# Memory\n- dentist on Friday\n");
    expect(await readFile(main, "utf8")).toBe("# Memory\n");
    expect((await listLogDays("bot-o")).days).toEqual([]);
    expect((await journal.list("bot-o")).map((entry) => entry.via).sort()).toEqual(["chat", "restore"]);

    // The switch is read when the turn ends, so flipping it takes effect from the next finished turn.
    bot.memoryAutoWrite = true;
    await turn("# Memory\n- dentist on Friday\n");
    expect(await readFile(main, "utf8")).toBe("# Memory\n- dentist on Friday\n");
    expect((await listLogDays("bot-o")).days).toEqual([{ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), lines: 1 }]);
    expect((await journal.list("bot-o")).filter((entry) => entry.via === "restore")).toHaveLength(1);
  });

  it("logs finished turns of bot chats and searches chats and memory", async () => {
    const { wireActivity } = await import("../src/server/activity");
    const { MemoryJournal } = await import("../src/server/journal");
    const { listLogDays, recentLogEntries } = await import("../src/server/memory");
    const { searchChats } = await import("../src/server/tools/chats");
    const host = fakeHost([makeBot({ id: "bot-s", name: "Scout", memoryAutoWrite: true })]);
    // A watcher that hands its handlers to the test.
    const handlers = new Map<string, (event: unknown, api: unknown) => Promise<void>>();
    const watcher = { on: (name: string, handler: (event: unknown, api: unknown) => Promise<void>) => void handlers.set(name, handler) };
    const finished: string[] = [];
    wireActivity({ watcher: watcher as never, host, journal: new MemoryJournal(), scheduler: { finished: async (_routine: string, _agent: string, outcome: { kind: string }) => void finished.push(outcome.kind) } as never });
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
