import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { botLimits } from "../src/shared/bot";
import { folderChoices, shellCommand } from "../src/shared/commands";
import { makeBot } from "./helpers";

describe("allowed commands", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pocket-bots-commands-"));
    process.env.POCKET_BOTS_HOME = home;
  });
  afterAll(async () => {
    delete process.env.POCKET_BOTS_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("matches only the exact command in the exact folder", async () => {
    const { CommandAllowlist } = await import("../src/server/commands");
    const commands = new CommandAllowlist();
    const rule = await commands.add("bot-a", "npm test", "/work/app");
    expect(await commands.add("bot-a", "npm test", "/work/app")).toEqual(rule);
    expect(await commands.list("bot-a")).toEqual([rule]);
    expect(await commands.matches("bot-a", "npm test", "/work/app")).toBe(true);
    expect(await commands.matches("bot-a", "npm test && rm -rf /", "/work/app")).toBe(false);
    expect(await commands.matches("bot-a", "npm test", "/work/other")).toBe(false);
    expect(await commands.matches("bot-b", "npm test", "/work/app")).toBe(false);
    expect(await commands.remove("bot-a", rule.id)).toBe(true);
    expect(await commands.matches("bot-a", "npm test", "/work/app")).toBe(false);
    await expect(commands.add("bot-a", "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'", "/w")).rejects.toThrow("credentials");
    await expect(commands.add("bot-a", "ls", "relative/dir")).rejects.toThrow("absolute path");
    await expect(commands.add("bot-a", "ls", "/work/../etc")).rejects.toThrow("absolute path");
  });

  it("reads the command and folder of a shell approval", () => {
    expect(shellCommand({ detail: { type: "shell", command: "git status" } }, "/chat")).toEqual({ command: "git status", cwd: "/chat" });
    expect(shellCommand({ detail: { type: "shell", command: "ls", cwd: "/elsewhere" } }, "/chat")).toEqual({ command: "ls", cwd: "/elsewhere" });
    expect(shellCommand({ detail: { type: "edit", filePath: "/a" } }, "/chat")).toBeNull();
    expect(shellCommand({}, "/chat")).toBeNull();
  });
});

describe("trusted folders", () => {
  let home: string;
  let project: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pocket-bots-folders-"));
    process.env.POCKET_BOTS_HOME = home;
    project = join(home, "work", "app");
    await mkdir(join(project, "src"), { recursive: true });
  });
  afterAll(async () => {
    delete process.env.POCKET_BOTS_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const shell = (command: string, cwd?: string) => ({ kind: "tool" as const, name: "Bash", detail: { type: "shell" as const, command, ...(cwd ? { cwd } : {}) } });

  it("says what a request works on: a command's folder and the paths it names, a file, where a search looks", async () => {
    const { requestPaths } = await import("../src/server/commands");
    expect(requestPaths(shell("npm test && git status 2>/dev/null"), "/w/app")).toEqual(["/w/app"]);
    expect(requestPaths(shell("cat /etc/hosts ~/.ssh/config", "/w/app"), "/chat")).toEqual(["/w/app", "/etc/hosts", join(homedir(), ".ssh/config")]);
    expect(requestPaths(shell("rm -rf ../other/*.log"), "/w/app")).toEqual(["/w/app", "/w/other"]);
    expect(requestPaths(shell("cd /w/app/src && ls"), "/w/app")).toEqual(["/w/app", "/w/app/src"]);
    // A here-document's text is a file's content, not paths (a test file importing "../src/x.js").
    const write = "cat > test/x.test.js <<'E'\nimport { total } from \"../src/format.js\";\nE\nsed -i '' 's/a/b/' src/x.js <<< '../y'\nnpm test";
    expect(requestPaths(shell(write), "/w/app")).toEqual(["/w/app", "/w/y"]);
    expect(requestPaths(shell("cat <<-EOF > /w/app/notes.md\n\t../not/a/path\n\tEOF\ncat ../secret"), "/w/app")).toEqual(["/w/app", "/w/app/notes.md", "/w/secret"]);
    expect(requestPaths({ kind: "tool", name: "Edit", detail: { type: "edit", filePath: "src/a.ts" } }, "/w/app")).toEqual(["/w/app/src/a.ts"]);
    expect(requestPaths({ kind: "tool", name: "Glob", input: { pattern: "**/*.ts" }, detail: { type: "search", query: "**/*.ts", toolName: "glob" } }, "/w/app")).toEqual(["/w/app"]);
    expect(requestPaths({ kind: "tool", name: "Glob", input: { pattern: "/etc/**" }, detail: { type: "search", query: "/etc/**", toolName: "glob" } }, "/w/app")).toEqual(["/w/app", "/etc"]);
    // Codex's patch names every file it changes; OpenCode's edit, its resources.
    expect(requestPaths({ kind: "tool", name: "apply_patch", input: { paths: ["/w/app/a.ts", "/w/b.ts"] }, detail: { type: "edit", filePath: "/w/app/a.ts" } }, "/w/app")).toEqual(["/w/app/a.ts", "/w/app/a.ts", "/w/b.ts"]);
    expect(requestPaths({ kind: "tool", name: "edit", input: { resources: ["src/a.ts"] } }, "/w/app")).toEqual(["/w/app/src/a.ts"]);
    // Not about files, or doesn't say: those ask.
    expect(requestPaths({ kind: "tool", name: "WebSearch", detail: { type: "search", query: "x", toolName: "web_search" } }, "/w/app")).toBeNull();
    expect(requestPaths({ kind: "tool", name: "mcp__x__y", detail: { type: "unknown", input: {}, output: null } }, "/w/app")).toBeNull();
    expect(requestPaths({ kind: "question", name: "AskUserQuestion" }, "/w/app")).toBeNull();
  });

  it("covers what stays inside a trusted folder, links resolved, for that bot only", async () => {
    const { FolderGrants, requestPaths } = await import("../src/server/commands");
    const folders = new FolderGrants();
    const rule = await folders.add("bot-a", project);
    expect(await folders.add("bot-a", project + "/")).toEqual(rule);
    expect(await folders.list("bot-a")).toEqual([rule]);
    const covers = (request: Parameters<typeof requestPaths>[0], botId = "bot-a") => folders.covers(botId, requestPaths(request, project)!);
    expect(await covers(shell("npm test"))).toBe(true);
    expect(await covers(shell("ls", join(project, "src")))).toBe(true);
    expect(await covers({ kind: "tool", name: "Write", detail: { type: "write", filePath: "src/new/file.ts" } })).toBe(true);
    expect(await covers(shell("npm test"), "bot-b")).toBe(false);
    expect(await covers(shell("cat ~/.ssh/id_rsa"))).toBe(false);
    expect(await covers(shell("ls", join(home, "work")))).toBe(false);
    expect(await covers({ kind: "tool", name: "Read", detail: { type: "read", filePath: "../app-secrets/key" } })).toBe(false);
    // A link inside the folder that leads out of it doesn't count as inside.
    await symlink(join(home, "work"), join(project, "up"));
    expect(await covers({ kind: "tool", name: "Read", detail: { type: "read", filePath: "up/other.txt" } })).toBe(false);
    expect(await folders.remove("bot-a", rule.id)).toBe(true);
    expect(await covers(shell("npm test"))).toBe(false);
    await expect(folders.add("bot-a", "relative/dir")).rejects.toThrow("absolute path");
    await expect(folders.add("bot-a", homedir())).rejects.toThrow("too broad");
    await expect(folders.add("bot-a", "/")).rejects.toThrow("too broad");
  });

  it("approves what a trusted folder covers, and answers the approvals already waiting", async () => {
    const { CommandAllowlist, FolderGrants } = await import("../src/server/commands");
    const { savedApprovals } = await import("../src/server/activity");
    const folders = new FolderGrants();
    const policy = savedApprovals(new CommandAllowlist(), folders);
    const chat = { cwd: project, labels: { "pocket-bots.bot": "bot-c" } } as never;
    expect(await policy(chat, { id: "1", provider: "claude", ...shell("npm test") })).toBeNull();
    await folders.add("bot-c", project);
    expect(await policy(chat, { id: "1", provider: "claude", ...shell("npm test") })).toEqual({ behavior: "allow" });
    expect(await policy(chat, { id: "2", provider: "claude", ...shell("rm -rf /tmp/x") })).toBeNull();
  });

  it("offers the chat's folder first, then the request's folder and the ones above it", () => {
    expect(folderChoices(shell("ls", "/Users/ann/work/app/src"), "/Users/ann/work/app")).toEqual(["/Users/ann/work/app", "/Users/ann/work/app/src", "/Users/ann/work"]);
    expect(folderChoices({ kind: "tool", detail: { type: "read", filePath: "/Users/ann/notes/todo.md" } }, "/Users/ann/work/app")).toEqual(["/Users/ann/notes"]);
    expect(folderChoices({ kind: "tool", detail: { type: "edit", filePath: "src/a.ts" } }, "/Users/ann/app")).toEqual(["/Users/ann/app", "/Users/ann/app/src"]);
    expect(folderChoices({ kind: "tool", detail: { type: "read", filePath: "/etc/hosts" } }, "/Users/ann/app")).toEqual([]);
    expect(folderChoices({ kind: "question", detail: { type: "unknown" } }, "/Users/ann/app")).toEqual([]);
  });
});

describe("what a bot won't do", () => {
  it("follows its settings", () => {
    expect(botLimits(makeBot(), { local: true, appsConfigured: true })).toEqual([
      "Asks before running commands and tools it isn't allowed to use.",
      "Asks before contacting other bots.",
      "Has no connected apps.",
      "Won't act on a schedule.",
      "Can read its memory but won't write to it; you edit it on the Memory page.",
      "Keeps skills and routines only after you confirm them.",
    ]);
    const busy = makeBot({ modeId: "bypassPermissions", contactBots: "allow", memoryAutoWrite: true, apps: ["gmail"], routines: [{ id: "r", name: "r", prompt: "p", enabled: true, schedule: { kind: "webhook" }, resultsChatId: null, createdAt: "" }] });
    expect(botLimits(busy, { local: true, appsConfigured: true })).toEqual(["Keeps skills and routines only after you confirm them."]);
    expect(botLimits(busy, { local: false, appsConfigured: true })).toEqual(["Can't contact other bots.", "Has no connected apps."]);
  });
});
