// A bot's working folder follows the same rules as a chat's or a group's: ~/ expanded, an existing
// folder, an absolute path. Only bots whose folder was just changed are checked, so a folder that
// has since gone away never blocks saving something else.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { botDataPath } from "../src/server/bot-home";
import { botWorkingFolder, resolveBotFolders, startChat } from "../src/server/chats";
import { RequestError } from "../src/server/errors";
import { rpcHandlers, type Services } from "../src/server/rpc-handlers";
import { Store } from "../src/server/store";
import { applyChanges, ChangesSchema } from "../src/shared/changes";
import type { BotSettingsValues } from "../src/shared/bot";
import { fakeChats, fakeHost, makeBot, NOW } from "./helpers";

let root: string;
let userHome: string;
let dataHome: string;
const savedHome = process.env.HOME;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bots-bot-folder-"));
  userHome = join(root, "me");
  dataHome = join(root, "data");
  await mkdir(join(userHome, "projects", "site"), { recursive: true });
  await mkdir(dataHome, { recursive: true });
  // os.homedir() follows $HOME, so "~/" means this folder here.
  process.env.HOME = userHome;
  process.env.POCKET_BOTS_HOME = dataHome;
});
afterAll(async () => {
  process.env.HOME = savedHome;
  delete process.env.POCKET_BOTS_HOME;
  await rm(root, { recursive: true, force: true });
});

describe("where a bot's chats run", () => {
  it("starts a new chat in the expanded folder when the bot's folder was saved as ~/…", async () => {
    // Old bots.json files hold exactly what was typed.
    const bot = makeBot({ cwd: "~/projects/site" });
    const created: { cwd: string }[] = [];
    const host = fakeHost([bot]);
    host.chats = { create: async (input: { cwd: string }) => void created.push(input) } as never;
    await startChat(host, bot, { prompt: "hi" });
    expect(created[0]?.cwd).toBe(join(userHome, "projects", "site"));
  });

  it("expands a lone ~, treats an empty folder as the managed one, and leaves a remote bot's path to its host", () => {
    expect(botWorkingFolder(makeBot({ cwd: "~" }))).toBe(userHome);
    expect(botWorkingFolder(makeBot({ cwd: "/work/repo" }))).toBe("/work/repo");
    expect(botWorkingFolder(makeBot({ cwd: "" }))).toBe(botDataPath("bot-1"));
    expect(botWorkingFolder(makeBot({ cwd: "   " }))).toBe(botDataPath("bot-1"));
    expect(botWorkingFolder(makeBot({ cwd: "~/projects", hostId: "srv-2" }))).toBe("~/projects");
  });
});

/** The RPC the settings page saves through, over a real bots.json in the temp data folder. */
async function saving(bots: ReturnType<typeof makeBot>[]) {
  await rm(join(dataHome, "bots.json"), { force: true });
  const store = new Store();
  const first = await store.read();
  const base: BotSettingsValues = { ...first.values, bots };
  const seeded = await store.save(base, first.revision);
  if (seeded.status !== "saved") throw new Error("seeding failed");
  const registry = rpcHandlers({ store } as Partial<Services> as Services);
  const handler = registry.get("pocket.store.save")!.handler;
  return {
    store,
    save: async (edit: (bots: ReturnType<typeof makeBot>[]) => ReturnType<typeof makeBot>[]) => {
      const { values, revision } = await store.read();
      return (await handler({ values: { ...values, bots: edit(structuredClone(values.bots)) }, revision })) as { status: string; values?: BotSettingsValues };
    },
  };
}

describe("saving a bot's folder", () => {
  it("stores ~/ expanded", async () => {
    const { save, store } = await saving([makeBot()]);
    const result = await save(([bot]) => [{ ...bot!, cwd: "~/projects/site" }]);
    expect(result.status).toBe("saved");
    expect((await store.values()).bots[0]!.cwd).toBe(join(userHome, "projects", "site"));
  });

  it("refuses a folder that isn't there, a file, or a relative path, and saves nothing", async () => {
    const { save, store } = await saving([makeBot()]);
    await writeFile(join(userHome, "notes.md"), "x");
    await expect(save(([bot]) => [{ ...bot!, cwd: "~/nope" }])).rejects.toThrow(`There's no folder at ${join(userHome, "nope")}.`);
    await expect(save(([bot]) => [{ ...bot!, cwd: "~/notes.md" }])).rejects.toThrow("is a file, not a folder");
    await expect(save(([bot]) => [{ ...bot!, cwd: "projects/site" }])).rejects.toThrow("must be an absolute path");
    await expect(save(([bot]) => [{ ...bot!, cwd: "~/nope" }])).rejects.toBeInstanceOf(RequestError);
    expect((await store.values()).bots[0]!.cwd).toBeNull();
  });

  it("checks a new bot's folder too", async () => {
    const { save } = await saving([makeBot()]);
    await expect(save((bots) => [...bots, makeBot({ id: "bot-2", cwd: "/no/such/folder" })])).rejects.toThrow("There's no folder at /no/such/folder.");
  });

  it("treats an empty folder as none", async () => {
    const { save, store } = await saving([makeBot({ cwd: "/tmp" })]);
    await save(([bot]) => [{ ...bot!, cwd: "  " }]);
    expect((await store.values()).bots[0]!.cwd).toBeNull();
  });

  it("only checks the bots whose folder changed", async () => {
    // Another bot's folder was deleted after it was saved.
    const gone = join(root, "deleted-later");
    await mkdir(gone);
    const { save, store } = await saving([makeBot({ id: "a", name: "A", cwd: gone }), makeBot({ id: "b", name: "B" })]);
    await rm(gone, { recursive: true });
    const result = await save((bots) => bots.map((bot) => (bot.id === "b" ? { ...bot, title: "Renamed", cwd: "~/projects/site" } : bot)));
    expect(result.status).toBe("saved");
    const saved = (await store.values()).bots;
    expect(saved.find((bot) => bot.id === "a")!.cwd).toBe(gone);
    expect(saved.find((bot) => bot.id === "b")!.cwd).toBe(join(userHome, "projects", "site"));
    // Changing the broken one itself is checked.
    await expect(save((bots) => bots.map((bot) => (bot.id === "a" ? { ...bot, cwd: `${gone}/x` } : bot)))).rejects.toThrow("There's no folder");
  });

  it("leaves a remote bot's folder to its host: no ~/ expansion here, no check here", async () => {
    const { save, store } = await saving([makeBot({ hostId: "srv-2" })]);
    await save(([bot]) => [{ ...bot!, cwd: "~/not-on-this-computer" }]);
    expect((await store.values()).bots[0]!.cwd).toBe("~/not-on-this-computer");
    await expect(save(([bot]) => [{ ...bot!, cwd: "relative/path" }])).rejects.toThrow("must be an absolute path");
  });

  it("keeps bots.json as it was after a refusal", async () => {
    const { save } = await saving([makeBot()]);
    const before = await readFile(join(dataHome, "bots.json"), "utf8");
    await save(([bot]) => [{ ...bot!, cwd: "~/nope" }]).catch(() => undefined);
    expect(await readFile(join(dataHome, "bots.json"), "utf8")).toBe(before);
  });
});

describe("the assistant's update_bot working folder", () => {
  const values = (): BotSettingsValues => ({ bots: [makeBot({ id: "scout", name: "Scout" })], history: [], library: { skills: [], mcpServers: [] } });
  const context = { now: NOW, provider: "claude" };
  const apply = (working_folder: string | null) => applyChanges(values(), ChangesSchema.parse([{ type: "update_bot", bot: "Scout", working_folder }]), context).bots[0]!.cwd;

  it("accepts ~/ like the settings page, and still refuses a relative path", () => {
    expect(apply("~/projects/site")).toBe("~/projects/site");
    expect(apply("~")).toBe("~");
    expect(apply("/work/repo")).toBe("/work/repo");
    expect(() => apply("projects/site")).toThrow("absolute path");
  });

  it("takes an empty folder as the managed one", () => {
    expect(apply("")).toBeNull();
    expect(apply(null)).toBeNull();
  });

  it("is expanded and checked when the user applies it, like a folder typed in the settings", async () => {
    const applied = (folder: string) => resolveBotFolders(values(), applyChanges(values(), ChangesSchema.parse([{ type: "update_bot", bot: "Scout", working_folder: folder }]), context));
    expect((await applied("~/projects/site")).bots[0]!.cwd).toBe(join(userHome, "projects", "site"));
    await expect(applied("~/nope")).rejects.toThrow("Scout: There's no folder at");
  });
});
