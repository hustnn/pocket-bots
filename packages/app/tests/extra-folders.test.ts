// A chat's or a group's extra folders: checking them, handing them to the runtime and the prompt,
// changing them under an open chat (the session's own behaviour is in chat-service.test.ts and
// groups.test.ts).
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ClaudeAdapter, CodexAdapter, FakeAdapter, GrokAdapter, OpenCodeAdapter, PiAdapter } from "@pocket-bots/runtime";
import { botDataPath } from "../src/server/bot-home";
import { ChatService } from "../src/server/chat-service";
import { chatSpecs, extraFolders } from "../src/server/chats";
import { Db } from "../src/server/db";
import { RequestError } from "../src/server/errors";
import { rpcHandlers, type Services } from "../src/server/rpc-handlers";
import { promptSections } from "../src/shared/bot";
import { folderChoices } from "../src/shared/commands";
import { extraFoldersText, MAX_EXTRA_FOLDERS } from "../src/shared/extra-folders";
import { GROUP_LABEL } from "../src/shared/group-chat";
import * as rpc from "../src/shared/rpc";
import { dropExperimentSchema, fakeChats, fakeHost, makeBot } from "./helpers";

let home: string;
let root: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "bots-extra-home-"));
  process.env.POCKET_BOTS_HOME = home;
  root = await mkdtemp(join(tmpdir(), "bots-extra-folders-"));
});
afterAll(async () => {
  delete process.env.POCKET_BOTS_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const folder = async (name: string) => {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  return path;
};

describe("checking the extra folders", () => {
  it("takes existing folders, resolved, without repeats and without the working folder", async () => {
    const [api, docs] = [await folder("api"), await folder("docs")];
    expect(await extraFolders([api, `${docs}/sub/..`, api, `  ${docs}  `], docs)).toEqual([api]);
    expect(await extraFolders([], api)).toEqual([]);
    // ~ expands like it does for a working folder.
    expect(await extraFolders(["~"], null)).toEqual([homedir()]);
  });

  it("says what's wrong with a folder that can't be used", async () => {
    const api = await folder("api");
    await expect(extraFolders([api, "projects/site"], null)).rejects.toThrow("must be an absolute path");
    await expect(extraFolders([join(root, "missing")], null)).rejects.toThrow(`There's no folder at ${join(root, "missing")}.`);
    await expect(extraFolders([join(root, "missing")], null)).rejects.toBeInstanceOf(RequestError);
  });

  it(`takes at most ${MAX_EXTRA_FOLDERS}`, async () => {
    const many = await Promise.all(Array.from({ length: MAX_EXTRA_FOLDERS + 1 }, (_, index) => folder(`many-${index}`)));
    expect(await extraFolders(many.slice(0, MAX_EXTRA_FOLDERS), null)).toHaveLength(MAX_EXTRA_FOLDERS);
    await expect(extraFolders(many, null)).rejects.toBeInstanceOf(RequestError);
    // One of them being the working folder leaves room for the rest.
    expect(await extraFolders(many, many[0]!)).toHaveLength(MAX_EXTRA_FOLDERS);
  });
});

describe("what the agent gets", () => {
  const relay = { mountTools: async () => null, mountApps: async () => null } as never;
  const specFor = async (cwd: string, folders: string[], labels: Record<string, string> = {}) => {
    const bot = makeBot({ id: "bot-1", cwd: null });
    const host = fakeHost([bot]);
    host.attach(fakeChats({ c1: { status: "idle", items: [{ type: "user_message", text: "hello" }] } }));
    return chatSpecs(host, relay, async () => ({ name: "Launch" }))({ id: "c1", botId: bot.id, provider: "claude", model: null, thinking: null, mode: null, cwd, extraFolders: folders, title: null, labels });
  };

  it("adds the folders to the session's extra directories, once and never the working folder", async () => {
    const spec = await specFor("/work/repo", ["/work/api", "/work/repo", "/work/api", "/work/docs"]);
    // The bot's own folder (memory) comes first, since the chat works elsewhere.
    expect(spec.extraDirectories).toEqual([botDataPath("bot-1"), "/work/api", "/work/docs"]);
    expect(spec.folders).toEqual(["/work/api", "/work/docs"]);
    // The bot's own folder as the working folder, and no folders: nothing extra.
    expect((await specFor(botDataPath("bot-1"), [])).extraDirectories).toEqual([]);
    expect((await specFor(botDataPath("bot-1"), [botDataPath("bot-1")])).extraDirectories).toEqual([]);
  });

  it("lists them in the system prompt, but not in the standing prompt a resumed seat is re-sent", async () => {
    const plain = await specFor("/work/repo", ["/work/api", "/work/docs"]);
    expect(plain.systemPrompt).toContain(extraFoldersText(["/work/api", "/work/docs"]));
    expect(plain.systemPrompt).toContain("- /work/api\n- /work/docs");
    expect((await specFor("/work/repo", [])).systemPrompt).not.toContain("Extra folders");
    expect((await specFor("/work/repo", [])).systemPrompt).not.toContain("extra folders");
    // A seat's standing prompt leaves them out: a change reaches a resumed session as a note of its own.
    const seat = await specFor("/work/repo", ["/work/api"], { [GROUP_LABEL]: "g1" });
    expect(seat.systemPrompt).toContain("- /work/api");
    expect(seat.standingPrompt).not.toContain("/work/api");
  });

  it("says only what changed when the list is emptied, without telling the agent to stay in its working folder", () => {
    const text = extraFoldersText([]);
    expect(text).toBe("The user removed this chat's extra folders; the folders listed before are no longer part of this chat.");
    expect(text).not.toContain("only your working folder");
  });

  it("places the section after the project guidance", () => {
    const sections = promptSections(makeBot({}), { memory: "", memoryPath: null, recentWork: [], playbooks: [], skills: [], botTools: false, apps: [], folders: ["/work/api"] });
    expect(sections.map((section) => section.title)).toEqual(["Persona", "Project guidance", "Extra folders"]);
    expect(promptSections(makeBot({}), { memory: "", memoryPath: null, recentWork: [], playbooks: [], skills: [], botTools: false, apps: [] }).map((section) => section.title)).toEqual(["Persona", "Project guidance"]);
  });

  it("says in the capabilities that Claude and Codex take them natively, and Codex takes a new list in place", () => {
    expect([new ClaudeAdapter(), new CodexAdapter(), new OpenCodeAdapter(), new GrokAdapter(), new PiAdapter(), new FakeAdapter()].map((adapter) => [adapter.id, adapter.capabilities.additionalDirectories, adapter.capabilities.liveDirectories])).toEqual([
      ["claude", true, false],
      ["codex", true, true],
      ["opencode", false, false],
      ["grok", false, false],
      ["pi", false, false],
      ["fake", false, false],
    ]);
  });
});

describe("the approval card's folder choices", () => {
  const read = (filePath: string) => ({ kind: "tool", detail: { type: "read", filePath } });

  it("offers the extra folder a request works in, after the chat's own and before the folders above it", () => {
    expect(folderChoices(read("/Users/ann/api/src/a.ts"), "/Users/ann/app", ["/Users/ann/api"])).toEqual(["/Users/ann/api", "/Users/ann/api/src"]);
    // In the chat's own folder and an extra folder inside it: the chat's first.
    expect(folderChoices(read("/Users/ann/app/lib/a.ts"), "/Users/ann/app", ["/Users/ann/app/lib"])).toEqual(["/Users/ann/app", "/Users/ann/app/lib"]);
    // The innermost of nested extra folders.
    expect(folderChoices(read("/Users/ann/api/v2/a.ts"), "/Users/ann/app", ["/Users/ann/api", "/Users/ann/api/v2"])[0]).toBe("/Users/ann/api/v2");
    // A request outside every extra folder is as before.
    expect(folderChoices(read("/Users/ann/notes/todo.md"), "/Users/ann/app", ["/Users/ann/api"])).toEqual(["/Users/ann/notes"]);
    expect(folderChoices(read("/Users/ann/api/src/a.ts"), "/Users/ann/app")).toEqual(["/Users/ann/api/src", "/Users/ann/api"]);
  });
});

describe("migration 20", () => {
  it("gives the chats and groups already stored an empty list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bots-extra-db-"));
    try {
      const db = new Db(join(dir, "bots.sqlite"));
      db.run("INSERT INTO groups (id, name, wake_mode, created_at, updated_at) VALUES ('g1', 'G', 'everyone', 'x', 'x')");
      db.run("INSERT INTO chats (id, provider, cwd, labels, status, created_at, updated_at) VALUES ('c1', 'fake', '/tmp', '{}', 'idle', 'x', 'x')");
      dropExperimentSchema(db);
      db.raw.exec("ALTER TABLE chats DROP COLUMN extra_folders; ALTER TABLE chats DROP COLUMN folders_told; ALTER TABLE groups DROP COLUMN extra_folders; UPDATE schema_version SET version = 19");
      db.close();
      const reopened = new Db(join(dir, "bots.sqlite"));
      expect(reopened.get("SELECT extra_folders, folders_told FROM chats WHERE id = 'c1'")).toEqual({ extra_folders: "[]", folders_told: null });
      expect(reopened.get("SELECT extra_folders FROM groups WHERE id = 'g1'")).toEqual({ extra_folders: "[]" });
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the RPCs", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "bots-extra-rpc-"));
    const db = new Db(join(dir, "bots.sqlite"));
    const host = fakeHost([makeBot({ id: "alpha", name: "Alpha", provider: "fake" })]);
    const chats = new ChatService(db, new Map([["fake", new FakeAdapter()]]), async (chat) => ({ systemPrompt: "test", mcpServers: {}, trustedTools: [], extraDirectories: chat.extraFolders }), async () => null);
    chats.start();
    host.attach(chats);
    cleanup = async () => {
      await chats.stop();
      db.close();
      await rm(dir, { recursive: true, force: true });
    };
    const registry = rpcHandlers({ host } as Partial<Services> as Services);
    const call = <C extends { name: string }>(contract: C, input: unknown) => registry.get(contract.name)!.handler(input as never) as Promise<Record<string, unknown>>;
    return { chats, call };
  }

  it("starts a chat with extra folders, and changes them later", async () => {
    const [repo, api, docs] = [await folder("repo"), await folder("api"), await folder("docs")];
    const { chats, call } = await setup();
    const { chatId } = (await call(rpc.chatStartRpc, { botId: "alpha", text: "hello", cwd: repo, extraFolders: [api, repo, api] })) as { chatId: string };
    expect(chats.get(chatId)).toMatchObject({ cwd: repo, extraFolders: [api] });
    expect(await call(rpc.chatFoldersRpc, { chatId, extraFolders: [api, docs] })).toEqual({ extraFolders: [api, docs] });
    expect(chats.get(chatId)?.extraFolders).toEqual([api, docs]);
    await expect(call(rpc.chatFoldersRpc, { chatId, extraFolders: [join(root, "missing")] })).rejects.toThrow("There's no folder at");
    expect(chats.get(chatId)?.extraFolders).toEqual([api, docs]);
    await expect(call(rpc.chatStartRpc, { botId: "alpha", text: "hello", extraFolders: [join(root, "missing")] })).rejects.toBeInstanceOf(RequestError);
    expect(await call(rpc.chatFoldersRpc, { chatId, extraFolders: [] })).toEqual({ extraFolders: [] });
  });

  it("refuses to change a group seat's folders by itself, and a chat that isn't there", async () => {
    const api = await folder("api");
    const { chats, call } = await setup();
    const seat = await chats.create({ botId: "alpha", provider: "fake" as never, cwd: root, labels: { [GROUP_LABEL]: "g1" } });
    await expect(call(rpc.chatFoldersRpc, { chatId: seat, extraFolders: [api] })).rejects.toThrow("changed in the group");
    expect(chats.get(seat)?.extraFolders).toEqual([]);
    await expect(call(rpc.chatFoldersRpc, { chatId: "nope", extraFolders: [api] })).rejects.toBeInstanceOf(RequestError);
  });
});
