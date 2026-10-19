import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScript } from "@pocket-bots/runtime";
import { ChatService, standingPromptUpdate, type TurnEndedEvent } from "../src/server/chat-service";
import { Db } from "../src/server/db";

function setup(script?: FakeScript) {
  const dir = mkdtempSync(join(tmpdir(), "bots-chats-"));
  const db = new Db(join(dir, "bots.sqlite"));
  const fake = new FakeAdapter(script);
  const chats = new ChatService(db, new Map([["fake", fake]]), async () => ({ systemPrompt: "test", mcpServers: {}, trustedTools: [] }), async () => null);
  chats.start();
  return { db, fake, chats, dir };
}

const settled = (chats: ChatService, chatId: string) =>
  new Promise<TurnEndedEvent>((resolve) => chats.on("turn.ended", (event) => event.agent.id === chatId && resolve(event)));

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("ChatService", () => {
  it("runs a turn and stores the timeline", async () => {
    const { chats } = setup();
    cleanup = () => chats.stop();
    const ended = new Promise<TurnEndedEvent>((resolve) => chats.on("turn.ended", resolve));
    const id = await chats.create({ botId: "b1", provider: "fake", cwd: tmpdir(), labels: { "pocket-bots.bot": "b1" } }, { text: "hello" });
    const event = await ended;
    expect(event.outcome.kind).toBe("completed");
    expect(event.timeline.map((item) => item.type)).toEqual(["user_message", "assistant_message"]);
    const page = chats.timeline(id, { direction: "tail" });
    expect(page.entries).toHaveLength(2);
    expect(page.agent?.status).toBe("idle");
    expect(page.agent?.title).toBe("hello");
    expect(chats.list({ labels: { "pocket-bots.bot": "b1" } }).map((chat) => chat.id)).toEqual([id]);
    expect(chats.list({ labels: { "pocket-bots.bot": "other" } })).toEqual([]);
  });

  it("pages with after cursors and keeps an updated item at its place", async () => {
    const { chats } = setup((turn, step) => (step === 0 ? { tool: "nothing", server: "none", args: {} } : step === 1 ? { say: `done ${turn.text}` } : null));
    cleanup = () => chats.stop();
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    const first = chats.timeline(id, { direction: "tail" });
    expect(first.entries).toHaveLength(0);
    const ended = settled(chats, id);
    await chats.send(id, { text: "a" });
    await ended;
    const after = chats.timeline(id, { direction: "after", cursor: first.endCursor! });
    // user message, the tool call (written twice: running, then failed), the reply
    expect(after.entries.map((entry) => entry.item.type)).toEqual(["user_message", "tool_call", "assistant_message"]);
    const tool = after.entries[1]!;
    expect(tool.seqEnd).toBeGreaterThan(tool.seqStart);
    expect((tool.item as { status: string }).status).toBe("failed");
  });

  it("steers a running turn and interrupts", async () => {
    const { chats } = setup((turn, step) => (step === 0 ? { wait: 300 } : step === 1 ? { say: `steers: ${turn.steers.join(",")}` } : null));
    cleanup = () => chats.stop();
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() }, { text: "go" });
    const steer = await chats.send(id, { text: "also this" }, "steer");
    expect(steer).toMatchObject({ ok: true, as: "steer" });
    const ended = await settled(chats, id);
    expect(ended.timeline.at(-1)).toMatchObject({ type: "assistant_message", text: "steers: also this" });

    const second = settled(chats, id);
    await chats.send(id, { text: "long" });
    expect(await chats.interrupt(id)).toBe(true);
    expect((await second).outcome.kind).toBe("canceled");
  });

  it("lists the agent's slash commands, opening its session to ask", async () => {
    const { chats, fake } = setup();
    cleanup = () => chats.stop();
    fake.commandList = [{ name: "compact", description: "Free up context", argumentHint: "", kind: "command" }];
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    expect(fake.sessions).toHaveLength(0);
    expect(await chats.commands(id)).toEqual(fake.commandList);
    expect(fake.sessions).toHaveLength(1);
    await expect(chats.commands("missing")).rejects.toThrow(/doesn't exist/);
  });

  it("marks a turn that was running when the process stopped", async () => {
    const { db, chats, dir } = setup((_turn, step) => (step === 0 ? { wait: 10_000 } : null));
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() }, { text: "slow" });
    expect(chats.get(id)?.status).toBe("running");
    db.close();
    const db2 = new Db(join(dir, "bots.sqlite"));
    const again = new ChatService(db2, new Map([["fake", new FakeAdapter()]]), async () => ({ systemPrompt: "", mcpServers: {}, trustedTools: [] }), async () => null);
    again.start();
    cleanup = async () => {
      await chats.stop();
      await again.stop();
    };
    expect(again.get(id)?.status).toBe("idle");
    expect(again.items(id).at(-1)).toMatchObject({ type: "notification", level: "warning" });
  });

  it("holds an approval until the user answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bots-chats-"));
    const db = new Db(join(dir, "bots.sqlite"));
    const fake = new FakeAdapter((_turn, step) => (step === 0 ? { wait: 50 } : null));
    const chats = new ChatService(db, new Map([["fake", fake]]), async () => ({ systemPrompt: "", mcpServers: {}, trustedTools: [] }), async () => null);
    chats.start();
    cleanup = () => chats.stop();
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() }, { text: "x" });
    const asked = new Promise<string>((resolve) => chats.on("permission.requested", ({ request }) => resolve(request.id)));
    const decision = fake.sessions[0]!.spec.approvals({ id: "req-1", provider: "fake", name: "Bash", kind: "tool" }, new AbortController().signal);
    expect(await asked).toBe("req-1");
    expect(chats.get(id)?.pendingPermissions.map((request) => request.id)).toEqual(["req-1"]);
    expect(chats.get(id)?.attentionReason).toBe("permission");
    const resolved: unknown[] = [];
    chats.on("permission.resolved", (event) => void resolved.push(event));
    await chats.respond(id, "req-1", { behavior: "allow" });
    expect(await decision).toEqual({ behavior: "allow" });
    expect(chats.get(id)?.pendingPermissions).toEqual([]);
    // Answered, or given up because its turn ended: either way it's told.
    const ended = new AbortController();
    const shown = new Promise<void>((resolve) => chats.on("permission.requested", ({ request }) => void (request.id === "req-2" && resolve())));
    const late = fake.sessions[0]!.spec.approvals({ id: "req-2", provider: "fake", name: "AskUserQuestion", kind: "question" }, ended.signal);
    await shown;
    ended.abort();
    expect(await late).toEqual({ behavior: "deny", message: "The turn ended." });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toEqual([
      { chatId: id, requestId: "req-1", decision: { behavior: "allow" }, reason: "answered" },
      { chatId: id, requestId: "req-2", decision: { behavior: "deny", message: "The turn ended." }, reason: "ended" },
    ]);
  });
});

describe("a resumed session's standing prompt", () => {
  /** A runtime that keeps (or not) a resumed session's first prompt; each turn's text is kept. */
  function setupStanding(keeps: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "bots-chats-"));
    const db = new Db(join(dir, "bots.sqlite"));
    const texts: string[] = [];
    const fake = new FakeAdapter((turn, step) => {
      if (step === 0) texts.push(turn.text);
      return null;
    });
    fake.capabilities.keepsPromptOnResume = keeps;
    const prompt = { standing: "Rules v1" };
    const chats = new ChatService(db, new Map([["fake", fake]]), async () => ({ systemPrompt: `${prompt.standing}\n\nCurrent memory: changes daily`, standingPrompt: prompt.standing, mcpServers: {}, trustedTools: [] }), async () => null);
    chats.start();
    cleanup = () => chats.stop();
    const turn = async (id: string, text: string) => {
      const ended = settled(chats, id);
      await chats.send(id, { text });
      await ended;
    };
    return { chats, db, texts, prompt, turn };
  }

  it("puts the current standing prompt in front of a resumed session's first input when it changed, once", async () => {
    const { chats, texts, prompt, turn } = setupStanding(true);
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    await turn(id, "first");
    // Closed and resumed on the same prompt: nothing added.
    await chats.archive(id);
    await turn(id, "second");
    // The prompt changed while the session was closed: its first input carries the new one.
    prompt.standing = "Rules v2";
    await chats.archive(id);
    await turn(id, "third");
    await turn(id, "fourth");
    await chats.archive(id);
    await turn(id, "fifth");
    expect(texts).toEqual(["first", "second", `${standingPromptUpdate("Rules v2")}third`, "fourth", "fifth"]);
    expect(texts[2]).toMatch(/^<pocket-bots-standing-prompt-update>\npocket-bots updated your standing instructions since this session started\. The instructions below replace the earlier standing instructions \(system or developer prompt\) for the rest of this session; where they differ, follow these\.\n\nRules v2\n<\/pocket-bots-standing-prompt-update>\n\nthird$/);
  });

  it("records a resumed session it has no record of as it is", async () => {
    const { chats, db, texts, prompt, turn } = setupStanding(true);
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    await turn(id, "first");
    db.run("UPDATE chats SET standing_prompt = NULL WHERE id = ?", id);
    prompt.standing = "Rules v2";
    await chats.archive(id);
    await turn(id, "second");
    await chats.archive(id);
    await turn(id, "third");
    expect(texts).toEqual(["first", "second", "third"]);
  });

  it("leaves a runtime that takes the prompt again on every open alone", async () => {
    const { chats, texts, prompt, turn } = setupStanding(false);
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    await turn(id, "first");
    prompt.standing = "Rules v2";
    await chats.archive(id);
    await turn(id, "second");
    expect(texts).toEqual(["first", "second"]);
  });
});

describe("resuming", () => {
  it("keeps the handle of a runtime that names its session while opening (Codex, Grok, OpenCode, Pi)", async () => {
    const { chats, db, fake } = setup();
    cleanup = () => chats.stop();
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    let ended = settled(chats, id);
    await chats.send(id, { text: "hello" });
    await ended;
    const handle = db.get<{ resume: string | null }>("SELECT resume FROM chats WHERE id = ?", id)?.resume;
    expect(handle).toBeTruthy();
    await chats.archive(id);
    ended = settled(chats, id);
    await chats.send(id, { text: "again" });
    await ended;
    expect(fake.sessions[1]!.spec.resume).toEqual(JSON.parse(handle!));
  });
});

describe("resuming a session that's gone", () => {
  it("starts a new session and says so, rather than leaving the chat stuck", async () => {
    const { chats, db, fake } = setup();
    cleanup = () => chats.stop();
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    let ended = settled(chats, id);
    await chats.send(id, { text: "hello" });
    await ended;
    await chats.archive(id);
    const open = fake.open.bind(fake);
    fake.open = async (spec) => {
      if (spec.resume) throw new Error("thread not found");
      return open(spec);
    };
    ended = settled(chats, id);
    expect(await chats.send(id, { text: "again" })).toMatchObject({ ok: true });
    await ended;
    expect(fake.sessions.at(-1)!.spec.resume).toBeUndefined();
    expect(chats.items(id).some((item) => item.type === "notification" && item.message.includes("couldn't be resumed (thread not found)"))).toBe(true);
    expect(JSON.parse(db.get<{ resume: string }>("SELECT resume FROM chats WHERE id = ?", id)!.resume).sessionId).toBe(fake.sessions.at(-1)!.handle!.sessionId);
  });
});

describe("model context signals", () => {
  it("tells when a session opens (new or resumed) and when its context is compacted", async () => {
    const { chats, fake } = setup((turn, step) => (turn.text === "/compact" && step === 0 ? { emit: { type: "compaction", status: "completed", trigger: "manual" } } : null));
    cleanup = () => chats.stop();
    const opened: { resumed: boolean; reportsCompaction: boolean }[] = [];
    const compacted: string[] = [];
    chats.on("session.opened", ({ resumed, reportsCompaction }) => void opened.push({ resumed, reportsCompaction }));
    chats.on("compaction", ({ chatId }) => void compacted.push(chatId));
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    let ended = settled(chats, id);
    await chats.send(id, { text: "hello" });
    await ended;
    await chats.archive(id);
    fake.capabilities.reportsCompaction = false;
    ended = settled(chats, id);
    await chats.send(id, { text: "/compact" });
    await ended;
    expect(opened).toEqual([
      { resumed: false, reportsCompaction: true },
      { resumed: true, reportsCompaction: false },
    ]);
    expect(compacted).toEqual([id]);
  });
});
