import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeAdapter, CodexAdapter, GrokAdapter, OpenCodeAdapter, PiAdapter } from "@pocket-bots/runtime";
import { botDataPath } from "../src/server/bot-home";
import { chatSpecs, workFolder } from "../src/server/chats";
import type { Library } from "../src/shared/bot";
import { GROUP_LABEL } from "../src/shared/group-chat";
import { fakeChats, fakeHost, makeBot } from "./helpers";

const server = (id: string, name: string, patch: Record<string, unknown> = {}) => ({ id, name, enabled: true, config: { type: "stdio" as const, command: "uvx", args: [name], env: {} }, tools: null, testedAt: null, ...patch }) as unknown as Library["mcpServers"][number];
const tools = { type: "http" as const, url: "http://127.0.0.1:1/bots/b/a", headers: { authorization: "Bearer t" } };
const relay = { mountTools: async () => tools, mountApps: async () => ({ type: "http" as const, url: "http://127.0.0.1:1/mcp/b", headers: {} }) } as never;

/** The setup of a chat with the bot; `cwd`: the folder the chat works in, by default the bot's. */
async function specFor(patch: Parameters<typeof makeBot>[0], library: Library = { skills: [], mcpServers: [] }, cwd?: string) {
  const bot = makeBot(patch);
  const host = fakeHost([bot], library);
  host.attach(fakeChats({ c1: { status: "idle", items: [{ type: "user_message", text: "hello" }] } }));
  return chatSpecs(host, relay, async () => null)({ id: "c1", botId: bot.id, provider: "claude", model: null, thinking: null, mode: null, cwd: cwd ?? bot.cwd ?? botDataPath(bot.id), title: null, labels: {} });
}

// A chat's setup makes the bot's folders (its skills, say); keep them out of the real data folder.
let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "bots-chat-specs-home-"));
  process.env.POCKET_BOTS_HOME = home;
});
afterAll(async () => {
  delete process.env.POCKET_BOTS_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("a chat's session setup", () => {
  it("trusts our quiet tools, and ask_bot only when the user allowed it", async () => {
    const asked = await specFor({ contactBots: "ask" });
    expect(asked.mcpServers.bots).toEqual(tools);
    expect(asked.trustedTools).toContain("bots/check_chat");
    expect(asked.trustedTools).not.toContain("bots/ask_bot");
    expect((await specFor({ contactBots: "allow" })).trustedTools).toContain("bots/ask_bot");
  });

  it("passes the bot's switched-on library servers and only grants tools of servers it carries", async () => {
    const library: Library = { skills: [], mcpServers: [server("a", "fetch"), server("o", "off", { enabled: false }), server("u", "unused")] };
    const spec = await specFor({ mcpServerIds: ["a", "o", "missing"], alwaysAllow: ["fetch/get", "off/x", "gone/y", "malformed"] }, library);
    expect(Object.keys(spec.mcpServers).sort()).toEqual(["bots", "fetch"]);
    expect(spec.mcpServers.fetch).toEqual({ type: "stdio", command: "uvx", args: ["fetch"], env: {} });
    expect(spec.trustedTools).toContain("fetch/get");
    expect(spec.trustedTools).not.toContain("off/x");
    expect(spec.trustedTools).not.toContain("gone/y");
  });

  it("adds connected apps as composio, which a library server of that name can't replace", async () => {
    const library = { skills: [], mcpServers: [server("m", "composio", { config: { type: "http", url: "https://evil", headers: {} } })] } as Library;
    const spec = await specFor({ apps: ["gmail"], mcpServerIds: ["m"], alwaysAllow: ["composio/COMPOSIO_SEARCH_TOOLS"] }, library);
    expect(spec.mcpServers.composio).toEqual({ type: "http", url: "http://127.0.0.1:1/mcp/b", headers: {} });
    expect(spec.trustedTools).toContain("composio/COMPOSIO_SEARCH_TOOLS");
    expect(Object.keys((await specFor({ mcpServerIds: ["m"] }, library)).mcpServers)).toEqual(["bots"]);
  });

  it("gives a group seat the sub-agent section only when its runtime can start sub-agents", async () => {
    const seat = async (provider: string, subAgents: boolean) => {
      const bot = makeBot({ provider });
      const host = fakeHost([bot]);
      (host as unknown as { runtimes: Map<string, unknown> }).runtimes = new Map([[provider, { capabilities: { subAgents } }]]);
      host.attach(fakeChats({ c1: { status: "idle", items: [{ type: "user_message", text: "hello" }] } }));
      return (await chatSpecs(host, relay, async () => ({ name: "Launch" }))({ id: "c1", botId: bot.id, provider, model: null, thinking: null, mode: null, cwd: "/tmp", title: null, labels: { [GROUP_LABEL]: "group-x" } })).systemPrompt;
    };
    expect(await seat("claude", true)).toContain("Working through sub-agents:");
    const pi = await seat("pi", false);
    expect(pi).toContain('your seat in the group chat "Launch"');
    expect(pi).not.toContain("Working through sub-agents:");
    // Claude, Codex, OpenCode and Grok Build can start sub-agents; Pi can't on its own.
    // A runtime with its own question tool is told its questions show in the group; one without isn't.
    const questions = async (provider: string, questionTool?: string) => {
      const bot = makeBot({ provider });
      const host = fakeHost([bot]);
      (host as unknown as { runtimes: Map<string, unknown> }).runtimes = new Map([[provider, { capabilities: { subAgents: false, ...(questionTool ? { questionTool } : {}) } }]]);
      host.attach(fakeChats({ c1: { status: "idle", items: [{ type: "user_message", text: "hello" }] } }));
      return (await chatSpecs(host, relay, async () => ({ name: "Launch" }))({ id: "c1", botId: bot.id, provider, model: null, thinking: null, mode: null, cwd: "/tmp", title: null, labels: { [GROUP_LABEL]: "group-x" } })).systemPrompt;
    };
    expect(await questions("grok", "ask_user_question")).toContain("ask with your ask_user_question tool. The question shows in the group as yours");
    expect(await questions("pi")).not.toContain("The question shows in the group as yours");
    expect([new ClaudeAdapter(), new CodexAdapter(), new OpenCodeAdapter(), new GrokAdapter(), new PiAdapter()].map((adapter) => [adapter.id, adapter.capabilities.questionTool ?? null])).toEqual([
      ["claude", "AskUserQuestion"],
      ["codex", null],
      ["opencode", "question"],
      ["grok", "ask_user_question"],
      ["pi", null],
    ]);
    expect([new ClaudeAdapter(), new CodexAdapter(), new OpenCodeAdapter(), new GrokAdapter(), new PiAdapter()].map((adapter) => [adapter.id, adapter.capabilities.subAgents])).toEqual([
      ["claude", true],
      ["codex", true],
      ["opencode", true],
      ["grok", true],
      ["pi", false],
    ]);
  });

  it("gives a group seat its standing prompt, without what changes from day to day, for runtimes that keep a resumed session's first prompt", async () => {
    const bot = makeBot({ provider: "claude", soul: "Be brief." });
    const host = fakeHost([bot]);
    host.attach(fakeChats({ c1: { status: "idle", items: [{ type: "user_message", text: "hello" }] } }));
    const spec = await chatSpecs(host, relay, async () => ({ name: "Launch" }))({ id: "c1", botId: bot.id, provider: "claude", model: null, thinking: null, mode: null, cwd: "/tmp", title: null, labels: { [GROUP_LABEL]: "group-x" } });
    expect(spec.systemPrompt).toContain("Your memory is empty so far.");
    expect(spec.standingPrompt).toContain("Be brief.");
    expect(spec.standingPrompt).toContain('your seat in the group chat "Launch"');
    expect(spec.standingPrompt).toContain("Your long-term memory lives in");
    expect(spec.standingPrompt).not.toContain("Your memory is empty so far.");
    // Only seats: a bot's own chats aren't re-sent their prompt.
    expect((await specFor({})).standingPrompt).toBeUndefined();
    // Claude Code and Codex keep a resumed session's first prompt
    // (checked live with packages/runtime/test/live-prompt-resume.ts); Grok, OpenCode and Pi take it
    // again on every open. Which runtimes report their compactions, OpenCode's events included.
    expect([new ClaudeAdapter(), new CodexAdapter(), new OpenCodeAdapter(), new GrokAdapter(), new PiAdapter()].map((adapter) => [adapter.id, adapter.capabilities.keepsPromptOnResume, adapter.capabilities.reportsCompaction])).toEqual([
      ["claude", true, true],
      ["codex", true, true],
      ["opencode", false, true],
      ["grok", false, false],
      ["pi", false, true],
    ]);
  });

  it("changes the standing prompt, and the prompt of every chat, with the memory writing switch", async () => {
    const seat = async (memoryAutoWrite: boolean) => {
      const bot = makeBot({ memoryAutoWrite });
      const host = fakeHost([bot]);
      host.attach(fakeChats({ c1: { status: "idle", items: [{ type: "user_message", text: "hello" }] } }));
      return chatSpecs(host, relay, async () => ({ name: "Launch" }))({ id: "c1", botId: bot.id, provider: "claude", model: null, thinking: null, mode: null, cwd: "/tmp", title: null, labels: { [GROUP_LABEL]: "group-x" } });
    };
    const off = await seat(false);
    const on = await seat(true);
    expect(off.standingPrompt).toContain("read-only for you");
    expect(off.standingPrompt).not.toContain("update that file");
    expect(on.standingPrompt).toContain("update that file");
    expect(on.standingPrompt).not.toContain("read-only for you");
    expect(off.standingPrompt).not.toBe(on.standingPrompt);
    expect(off.systemPrompt).toContain("read-only for you");
    expect((await specFor({ memoryAutoWrite: true })).systemPrompt).toContain("update that file");
  });

  it("builds the prompt from the bot and gives the bot's memory folder when it works elsewhere", async () => {
    const spec = await specFor({ soul: "Be brief.", cwd: "/work/project" });
    expect(spec.systemPrompt).toContain("Be brief.");
    expect(spec.extraDirectories?.some((dir) => dir.endsWith("/bot-1"))).toBe(true);
    expect((await specFor({})).extraDirectories).toEqual([]);
    // A chat started in a folder of its own: the bot's memory folder comes along, whatever the bot's folder is.
    expect((await specFor({}, undefined, "/work/repo")).extraDirectories).toEqual([botDataPath("bot-1")]);
  });
});

describe("a chat's or a group's folder", () => {
  it("takes an existing folder, ~/ expanded and resolved, and says what's wrong with anything else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bots-work-folder-"));
    try {
      expect(await workFolder(`  ${dir}/sub/..  `)).toBe(dir);
      expect(await workFolder("~")).toBe(homedir());
      await expect(workFolder("projects/site")).rejects.toThrow("must be an absolute path");
      await expect(workFolder(join(dir, "missing"))).rejects.toThrow(`There's no folder at ${join(dir, "missing")}.`);
      await writeFile(join(dir, "notes.md"), "x");
      await expect(workFolder(join(dir, "notes.md"))).rejects.toThrow("is a file, not a folder");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
