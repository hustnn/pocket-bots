// Search across conversations: the chat timelines' full-text index (kept up at search
// time, and built for chats stored before it), group messages in every group, and the results
// the palette and find in chat get.
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "@pocket-bots/runtime";
import { ChatService, type TurnEndedEvent } from "../src/server/chat-service";
import { Db } from "../src/server/db";
import { GroupStore } from "../src/server/group-store";
import { ftsFilter, searchMessages } from "../src/server/search";
import { BOT_LABEL, POCKET_LABEL } from "../src/shared/bot";
import { GROUP_LABEL } from "../src/shared/group-chat";
import { replyText } from "../src/shared/reply";
import { excerpt, markTerms, searchTerms } from "../src/shared/search";
import { fakeHost, makeBot } from "./helpers";

const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bots-search-"));
  dirs.push(dir);
  const db = new Db(join(dir, "bots.sqlite"));
  // The fake bot answers each message with "re: <message>".
  const chats = new ChatService(db, new Map([["fake", new FakeAdapter((turn, step) => (step === 0 ? { say: `re: ${turn.text}` } : null))]]), async () => ({ systemPrompt: "", mcpServers: {}, trustedTools: [] }), async () => null);
  chats.start();
  closers.push(async () => {
    await chats.stop();
    if (db.raw.isOpen) db.close();
  });
  return { dir, db, chats };
}

const ended = (chats: ChatService, chatId: string) => new Promise<TurnEndedEvent>((resolve) => chats.on("turn.ended", (event) => event.agent.id === chatId && resolve(event)));

/** A bot chat whose first message has had its answer. */
async function chatWith(chats: ChatService, botId: string, text: string, labels: Record<string, string> = {}): Promise<string> {
  const id = `chat-${botId}-${Math.random().toString(36).slice(2, 8)}`;
  const done = ended(chats, id);
  await chats.create({ id, botId, provider: "fake", cwd: tmpdir(), labels: { [POCKET_LABEL]: "1", [BOT_LABEL]: botId, ...labels } }, { text });
  await done;
  return id;
}

async function say(chats: ChatService, chatId: string, text: string): Promise<void> {
  const done = ended(chats, chatId);
  await chats.send(chatId, { text });
  await done;
}

describe("search terms and pieces", () => {
  it("takes every word once, lowercased, without quotes around it", () => {
    expect(searchTerms('  Deploy "Friday"  deploy 发布 ')).toEqual(["deploy", "friday", "发布"]);
    expect(searchTerms("   ")).toEqual([]);
  });

  it("shows a long message around its first match", () => {
    const text = `${"a".repeat(300)} the launch plan ${"b".repeat(300)}`;
    const piece = excerpt(text, ["launch"], 100);
    expect(piece).toContain("launch plan");
    expect(piece.startsWith("…") && piece.endsWith("…")).toBe(true);
    expect(excerpt("short\n text", ["x"])).toBe("short text");
  });

  it("marks the terms in a piece, whatever their case", () => {
    expect(markTerms("Ship the Launch plan", ["launch", "ship"])).toEqual([
      { text: "Ship", match: true },
      { text: " the ", match: false },
      { text: "Launch", match: true },
      { text: " plan", match: false },
    ]);
  });

  it("looks up words of three or more characters in the index and checks shorter ones", () => {
    expect(ftsFilter(["launch", 'say "hi"', "go"], "t_fts", "f.text")).toEqual({ where: ["t_fts MATCH ?", "instr(lower(f.text), ?) > 0"], params: ['"launch" "say ""hi"""', "go"] });
  });
});

describe("chat timelines' index", () => {
  it("finds the user's and the bot's messages, with the timeline seq the chat shows them at", async () => {
    const { chats } = setup();
    const id = await chatWith(chats, "ada", "Draft the Q3 launch plan");
    const hits = chats.search(["launch"], { labels: { [BOT_LABEL]: "ada" } });
    expect(hits.map((hit) => [hit.role, hit.text])).toEqual([
      ["assistant", "re: Draft the Q3 launch plan"],
      ["user", "Draft the Q3 launch plan"],
    ]);
    const seqs = new Map(chats.timeline(id, { direction: "tail" }).entries.map((entry) => [(entry.item as { text?: string }).text, entry.seqStart]));
    expect(hits.map((hit) => hit.seq)).toEqual([seqs.get("re: Draft the Q3 launch plan"), seqs.get("Draft the Q3 launch plan")]);
  });

  it("needs every word, matches any part of a word and short words, and any language", async () => {
    const { chats } = setup();
    await chatWith(chats, "ada", "下周发布新版本 and the release notes");
    expect(chats.search(["发布"], {}).length).toBe(2);
    expect(chats.search(["新版本", "notes"], {}).length).toBe(2);
    expect(chats.search(["releas", "q3"], {})).toEqual([]);
    expect(chats.search(["RELEASE".toLowerCase()], {}).length).toBe(2);
  });

  it("indexes what was said since the last search, and a removed chat's messages go", async () => {
    const { chats, db } = setup();
    const id = await chatWith(chats, "ada", "first message");
    expect(chats.search(["pelican"], {})).toEqual([]);
    await say(chats, id, "now about the pelican");
    expect(chats.search(["pelican"], {}).map((hit) => hit.role)).toEqual(["assistant", "user"]);
    // Nothing changed: nothing to index again.
    const indexed = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM timeline_fts")!.n;
    chats.search(["pelican"], {});
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM timeline_fts")!.n).toBe(indexed);
    await chats.remove(id);
    expect(chats.search(["pelican"], {})).toEqual([]);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM timeline_fts")!.n).toBe(0);
  });

  it("searches one chat, or the chats with some labels and without others; archived chats too", async () => {
    const { chats } = setup();
    const mine = await chatWith(chats, "ada", "budget review");
    const seat = await chatWith(chats, "ada", "budget review", { [GROUP_LABEL]: "g1" });
    const other = await chatWith(chats, "cody", "budget review");
    await chats.archive(other);
    expect(new Set(chats.search(["budget"], {}).map((hit) => hit.chatId))).toEqual(new Set([mine, seat, other]));
    expect(new Set(chats.search(["budget"], { withoutLabels: [GROUP_LABEL] }).map((hit) => hit.chatId))).toEqual(new Set([mine, other]));
    expect(new Set(chats.search(["budget"], { chatId: seat }).map((hit) => hit.chatId))).toEqual(new Set([seat]));
  });

  it("indexes the chats stored before the index existed (migration 14)", async () => {
    const { dir, db, chats } = setup();
    const id = await chatWith(chats, "ada", "the albatross report");
    await chats.stop();
    // Back to before the migration, with the timeline kept.
    db.raw.exec("DROP TRIGGER timeline_fts_delete; DROP TABLE timeline_fts; ALTER TABLE chats DROP COLUMN indexed_seq; ALTER TABLE groups DROP COLUMN leader_id; ALTER TABLE group_members DROP COLUMN seat_task; ALTER TABLE groups DROP COLUMN cwd; ALTER TABLE chats DROP COLUMN extra_folders; ALTER TABLE chats DROP COLUMN folders_told; ALTER TABLE groups DROP COLUMN extra_folders; ALTER TABLE groups DROP COLUMN team_id; ALTER TABLE groups DROP COLUMN instructions; UPDATE schema_version SET version = 13");
    db.close();
    const reopened = new Db(join(dir, "bots.sqlite"));
    closers.push(() => reopened.close());
    expect(reopened.get<{ version: number }>("SELECT version FROM schema_version")!.version).toBeGreaterThanOrEqual(14);
    expect(reopened.all<{ chat_id: string; text: string }>("SELECT chat_id, text FROM timeline_fts ORDER BY text")).toEqual([
      { chat_id: id, text: "re: the albatross report" },
      { chat_id: id, text: "the albatross report" },
    ]);
    const row = reopened.get<{ seq: number; indexed_seq: number }>("SELECT seq, indexed_seq FROM chats WHERE id = ?", id)!;
    expect(row.indexed_seq).toBe(row.seq);
  });
});

describe("group messages across groups", () => {
  it("finds the user's and bots' messages in every group, newest first, with their thread; not pocket-bots's notes", () => {
    const { db } = setup();
    const store = new GroupStore(db);
    store.createGroup({ id: "g1", name: "Launch", memberIds: ["ada", "cody"] });
    store.createGroup({ id: "g2", name: "Ops", memberIds: ["ada", "rex"] });
    const top = store.append("g1", { kind: "user" }, { text: "Who owns the launch checklist?" }).message;
    store.append("g1", { kind: "bot", botId: "ada", name: "Ada" }, { text: "I own the launch checklist.", thread: top.seq });
    store.append("g2", { kind: "user" }, { text: "Unrelated" });
    store.append("g2", { kind: "system" }, { text: "Rex joined the launch group" });
    const hits = store.searchAll(["launch"]);
    expect(hits.map((hit) => [hit.groupId, hit.from.kind, hit.thread])).toEqual([
      ["g1", "bot", top.seq],
      ["g1", "user", null],
    ]);
    expect(store.searchAll(["launch"], { groupId: "g2" })).toEqual([]);
  });
});

describe("searchMessages (the palette's results)", () => {
  it("puts chats and groups together, newest first, and leaves out group seats and deleted bots' chats", async () => {
    const { db, chats } = setup();
    const host = fakeHost([makeBot({ id: "ada", name: "Ada" })]);
    host.attach(chats);
    const store = new GroupStore(db);
    const groups = { searchAll: (terms: readonly string[], scope: { groupId?: string; limit?: number }) => store.searchAll(terms, scope) } as never;
    const chatId = await chatWith(chats, "ada", "the orca memo");
    await chatWith(chats, "ada", "the orca memo", { [GROUP_LABEL]: "g1" });
    await chatWith(chats, "gone", "the orca memo");
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.createGroup({ id: "g1", name: "Launch", memberIds: ["ada"] });
    store.append("g1", { kind: "user" }, { text: "Is the orca memo done?" });

    const hits = await searchMessages(host, groups, { query: "orca" });
    expect(hits.map((hit) => (hit.kind === "chat" ? `chat:${hit.chatId}:${hit.from}` : `group:${hit.groupId}`))).toEqual(["group:g1", `chat:${chatId}:bot`, `chat:${chatId}:user`]);
    expect(hits[1]).toMatchObject({ kind: "chat", botId: "ada", chatTitle: "the orca memo", archived: false, text: "re: the orca memo" });
    expect((await searchMessages(host, groups, { query: "orca", chatId })).every((hit) => hit.kind === "chat" && hit.chatId === chatId)).toBe(true);
    expect((await searchMessages(host, groups, { query: "orca", groupId: "g1" })).map((hit) => hit.kind)).toEqual(["group"]);
    expect(await searchMessages(host, groups, { query: "  " })).toEqual([]);
  });

  it("shows a reply's own words, not the quote in front, when they match", async () => {
    const { chats } = setup();
    const host = fakeHost([makeBot({ id: "ada", name: "Ada" })]);
    host.attach(chats);
    const groups = { searchAll: () => [] } as never;
    const chatId = await chatWith(chats, "ada", "list three options");
    await say(chats, chatId, replyText("Option two: the heron route", "go with the heron route"));
    const hits = await searchMessages(host, groups, { query: "heron", chatId });
    expect(hits.find((hit) => hit.kind === "chat" && hit.from === "user")?.text).toBe("go with the heron route");
  });
});
