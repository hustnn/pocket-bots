import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScript } from "@pocket-bots/runtime";
import { ChatService, type ChatServiceOptions, type TurnEndedEvent } from "../src/server/chat-service";
import { Db } from "../src/server/db";
import { groupDelivery } from "../src/shared/group-chat";
import { foldersUpdate, splitFoldersUpdate } from "../src/shared/extra-folders";
import { splitStandingUpdate, standingPromptUpdate } from "../src/shared/standing-prompt";

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

  it("answers the approvals waiting that a new rule now allows, and leaves the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bots-chats-"));
    const db = new Db(join(dir, "bots.sqlite"));
    const fake = new FakeAdapter((_turn, step) => (step === 0 ? { wait: 50 } : null));
    // The policy allows "ls" once the rule is there.
    let rule = false;
    const policy = async (_chat: unknown, request: { input?: Record<string, unknown> }) => (rule && request.input?.command === "ls" ? { behavior: "allow" as const } : null);
    const chats = new ChatService(db, new Map([["fake", fake]]), async () => ({ systemPrompt: "", mcpServers: {}, trustedTools: [] }), policy);
    chats.start();
    cleanup = () => chats.stop();
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() }, { text: "x" });
    const asked = new Promise<void>((resolve) => chats.on("permission.requested", ({ request }) => void (request.id === "b" && resolve())));
    const signal = new AbortController().signal;
    const first = fake.sessions[0]!.spec.approvals({ id: "a", provider: "fake", name: "Bash", kind: "tool", input: { command: "ls" } }, signal);
    fake.sessions[0]!.spec.approvals({ id: "b", provider: "fake", name: "Bash", kind: "tool", input: { command: "rm x" } }, signal);
    await asked;
    expect(await chats.reapprove()).toBe(0);
    rule = true;
    expect(await chats.reapprove()).toBe(1);
    expect(await first).toEqual({ behavior: "allow" });
    expect(chats.get(id)?.pendingPermissions.map((request) => request.id)).toEqual(["b"]);
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

  it("splits the update off the input again, so a seat's chat still shows what the group sent", () => {
    const delivery = '[Group chat "Launch". Members: Writer (you), and the user.]\n\n[Group inbox notice: 1 new message for you to read.]';
    expect(splitStandingUpdate(`${standingPromptUpdate("Rules v2\n\n- Be brief.")}${delivery}`)).toEqual({ standing: "Rules v2\n\n- Be brief.", text: delivery });
    expect(groupDelivery(splitStandingUpdate(`${standingPromptUpdate("Rules v2")}${delivery}`).text)).toMatchObject({ group: "Launch" });
    // Typed in the seat: the user's own words come back as they were.
    expect(splitStandingUpdate(`${standingPromptUpdate("Rules v2")}what's left?`)).toEqual({ standing: "Rules v2", text: "what's left?" });
    // Anything without the update in front stays as it is.
    expect(splitStandingUpdate(delivery)).toEqual({ standing: null, text: delivery });
    expect(splitStandingUpdate("<pocket-bots-standing-prompt-update> is a tag")).toEqual({ standing: null, text: "<pocket-bots-standing-prompt-update> is a tag" });
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

describe("a chat's extra folders", () => {
  /** A runtime whose spec builder passes the chat's extra folders on, as chatSpecs does; each turn's text is kept. */
  function setupFolders(keeps: boolean, options: ChatServiceOptions = {}) {
    const dir = mkdtempSync(join(tmpdir(), "bots-chats-"));
    const db = new Db(join(dir, "bots.sqlite"));
    const texts: string[] = [];
    const fake = new FakeAdapter((turn, step) => {
      if (step === 0) texts.push(turn.text);
      return turn.text.startsWith("slow") ? (step === 0 ? { wait: 200 } : null) : null;
    });
    fake.capabilities.keepsPromptOnResume = keeps;
    const chats = new ChatService(db, new Map([["fake", fake]]), async (chat) => ({ systemPrompt: "test", mcpServers: {}, trustedTools: [], extraDirectories: chat.extraFolders, folders: chat.extraFolders }), async () => null, options);
    chats.start();
    cleanup = () => chats.stop();
    const turn = async (id: string, text: string) => {
      const ended = settled(chats, id);
      await chats.send(id, { text });
      await ended;
    };
    return { chats, db, fake, texts, turn };
  }

  it("starts with the chat's folders and shows them in its snapshot", async () => {
    const { chats, fake, turn } = setupFolders(false);
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir(), extraFolders: ["/work/api"] });
    await turn(id, "hello");
    expect(fake.sessions[0]!.spec.extraDirectories).toEqual(["/work/api"]);
    expect(chats.get(id)?.extraFolders).toEqual(["/work/api"]);
  });

  it("closes an idle session when the folders change, and the next input resumes it with the new list", async () => {
    const { chats, fake, turn } = setupFolders(false);
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    await turn(id, "first");
    const before = fake.sessions[0]!;
    await chats.setExtraFolders(id, ["/work/api", "/work/docs"]);
    expect(before.state).toBe("closed");
    expect(chats.get(id)?.extraFolders).toEqual(["/work/api", "/work/docs"]);
    await turn(id, "second");
    expect(fake.sessions).toHaveLength(2);
    expect(fake.sessions[1]!.spec.resume).toEqual(before.handle);
    expect(fake.sessions[1]!.spec.extraDirectories).toEqual(["/work/api", "/work/docs"]);
    // The same list again changes nothing.
    await chats.setExtraFolders(id, ["/work/api", "/work/docs"]);
    await turn(id, "third");
    expect(fake.sessions).toHaveLength(2);
  });

  it("lets a running turn finish, then reopens at the next input", async () => {
    const { chats, fake, turn } = setupFolders(false);
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    await turn(id, "first");
    const ended = settled(chats, id);
    await chats.send(id, { text: "slow turn" });
    expect(chats.get(id)?.status).toBe("running");
    await chats.setExtraFolders(id, ["/work/api"]);
    // Not interrupted: the same session is still running its turn.
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]!.state).not.toBe("closed");
    expect((await ended).outcome.kind).toBe("completed");
    expect(fake.sessions[0]!.state).not.toBe("closed");
    expect(fake.sessions[0]!.spec.extraDirectories).toEqual([]);
    await turn(id, "after");
    expect(fake.sessions).toHaveLength(2);
    expect(fake.sessions[1]!.spec.resume).toEqual(fake.sessions[0]!.handle);
    expect(fake.sessions[1]!.spec.extraDirectories).toEqual(["/work/api"]);
  });

  it("tells a resumed session that keeps its first prompt the new list in front of its next input, once", async () => {
    const { chats, texts, turn } = setupFolders(true);
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    await turn(id, "first");
    await chats.setExtraFolders(id, ["/work/api"]);
    await turn(id, "second");
    await turn(id, "third");
    // Removed again: the agent is told that too.
    await chats.setExtraFolders(id, []);
    await turn(id, "fourth");
    expect(texts).toEqual(["first", `${foldersUpdate(["/work/api"])}second`, "third", `${foldersUpdate([])}fourth`]);
    expect(splitFoldersUpdate(texts[1]!)).toEqual({ folders: expect.stringContaining("- /work/api"), text: "second" });
  });

  it("doesn't send a note to a runtime that takes its prompt again on every open, or to a chat whose list never changed", async () => {
    const { chats, texts, turn } = setupFolders(false);
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    await turn(id, "first");
    await chats.setExtraFolders(id, ["/work/api"]);
    await turn(id, "second");
    const { chats: other, texts: otherTexts, turn: otherTurn } = setupFolders(true);
    const kept = await other.create({ botId: null, provider: "fake", cwd: tmpdir(), extraFolders: ["/work/api"] });
    await otherTurn(kept, "first");
    await other.archive(kept);
    await otherTurn(kept, "second");
    expect(texts).toEqual(["first", "second"]);
    expect(otherTexts).toEqual(["first", "second"]);
    await chats.stop();
  });

  it("opens with the folders set while its start waited in the queue", async () => {
    // Another chat's start goes first; this one waits out the interval after it.
    const { chats, fake, turn } = setupFolders(false, { startIntervalMs: 300 });
    const other = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    await chats.send(other, { text: "first" });
    const ended = settled(chats, id);
    const sent = chats.send(id, { text: "queued" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.sessions.some((session) => session.spec.key === id)).toBe(false);
    await chats.setExtraFolders(id, ["/work/api"]);
    expect((await sent).ok).toBe(true);
    await ended;
    const opened = fake.sessions.filter((session) => session.spec.key === id);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.spec.extraDirectories).toEqual(["/work/api"]);
    // It has the list already: the next input doesn't reopen it.
    await turn(id, "next");
    expect(fake.sessions.filter((session) => session.spec.key === id)).toHaveLength(1);
  });

  it("hands a runtime that takes a new list in place the folders without reopening it, and tells its agent with the next input", async () => {
    const { chats, fake, texts, turn } = setupFolders(true);
    fake.capabilities.liveDirectories = true;
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    await turn(id, "first");
    await chats.setExtraFolders(id, ["/work/api", "/work/docs"]);
    expect(fake.sessions[0]!.state).not.toBe("closed");
    expect(fake.sessions[0]!.directories).toEqual(["/work/api", "/work/docs"]);
    await turn(id, "second");
    await chats.setExtraFolders(id, []);
    expect(fake.sessions[0]!.directories).toEqual([]);
    await turn(id, "third");
    expect(fake.sessions).toHaveLength(1);
    expect(texts).toEqual(["first", `${foldersUpdate(["/work/api", "/work/docs"])}second`, `${foldersUpdate([])}third`]);
  });

  it("hands them to a busy session at once, for its next turn", async () => {
    const { chats, fake, texts, turn } = setupFolders(true);
    fake.capabilities.liveDirectories = true;
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    await turn(id, "first");
    const ended = settled(chats, id);
    await chats.send(id, { text: "slow turn" });
    await chats.setExtraFolders(id, ["/work/api"]);
    expect(fake.sessions[0]!.directories).toEqual(["/work/api"]);
    expect((await ended).outcome.kind).toBe("completed");
    await turn(id, "after");
    expect(fake.sessions).toHaveLength(1);
    expect(texts).toEqual(["first", "slow turn", `${foldersUpdate(["/work/api"])}after`]);
  });

  it("hands them in place at the next input when they changed while the session opened", async () => {
    const { chats, fake, texts, turn } = setupFolders(true);
    fake.capabilities.liveDirectories = true;
    let release = () => {};
    let opening = () => {};
    const reached = new Promise<void>((resolve) => (opening = resolve));
    fake.beforeOpen = () => {
      opening();
      return new Promise<void>((resolve) => (release = resolve));
    };
    const id = await chats.create({ botId: null, provider: "fake", cwd: tmpdir() });
    const ended = settled(chats, id);
    const sent = chats.send(id, { text: "first" });
    // Its spec is built: the change comes too late for it.
    await reached;
    await chats.setExtraFolders(id, ["/work/api"]);
    release();
    expect((await sent).ok).toBe(true);
    await ended;
    expect(fake.sessions[0]!.directories).toEqual([]);
    await turn(id, "next");
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]!.directories).toEqual(["/work/api"]);
    expect(texts).toEqual(["first", `${foldersUpdate(["/work/api"])}next`]);
  });

  it("splits the note off the input again, after a standing-prompt update", () => {
    const text = `${standingPromptUpdate("Rules v2")}${foldersUpdate(["/a", "/b"])}what's left?`;
    const { standing, text: rest } = splitStandingUpdate(text);
    expect(standing).toBe("Rules v2");
    expect(splitFoldersUpdate(rest)).toEqual({ folders: expect.stringContaining("- /b"), text: "what's left?" });
    expect(splitFoldersUpdate("what's left?")).toEqual({ folders: null, text: "what's left?" });
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
