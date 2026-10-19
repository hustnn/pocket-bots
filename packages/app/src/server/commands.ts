import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ApprovalRequest } from "@pocket-bots/runtime";
import { redactSecrets } from "../shared/activity";
import { dataPath } from "./bot-home";
import { RequestError } from "./errors";

// What a bot may do without asking, saved from an approval card:
// - the command allowlist: an exact command in an exact folder;
// - trusted folders: shell commands that run in the folder, and reads, edits, writes and searches
//   of files in it (requestPaths says what a request works on).
// Both live on this host apart from the bots' settings, so they're never exported.

const MAX_COMMAND_BYTES = 16_384;
const MAX_RULES_PER_BOT = 200;

export interface CommandRule {
  id: string;
  command: string;
  cwd: string;
}

type StoredRule = CommandRule & { botId: string };

function storePath(): string {
  return join(dataPath(), "commands.json");
}

/** Throws a message the person can act on when a rule can't be saved. */
function validateRule(command: string, cwd: string): void {
  if (!command.trim() || Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES || /[\p{Cc}]/u.test(command.replace(/[\t\r\n]/g, ""))) {
    throw new RequestError("The command must be text of at most 16 KB.");
  }
  if (redactSecrets(command) !== command) throw new RequestError("Commands with credentials in them can't be saved. Use an environment variable instead.");
  if (!isAbsolute(cwd) || cwd.split(/[\\/]/).includes("..")) throw new RequestError("The folder must be an absolute path.");
}

export class CommandAllowlist {
  private queue: Promise<unknown> = Promise.resolve();

  private async load(): Promise<StoredRule[]> {
    try {
      const saved = JSON.parse(await readFile(storePath(), "utf8")) as { rules?: StoredRule[] };
      return Array.isArray(saved.rules) ? saved.rules : [];
    } catch {
      return [];
    }
  }

  private change<T>(edit: (rules: StoredRule[]) => { rules: StoredRule[]; result: T }): Promise<T> {
    const run = async () => {
      const { rules, result } = edit(await this.load());
      await mkdir(dataPath(), { recursive: true });
      await writeFile(storePath(), JSON.stringify({ version: 1, rules }, null, 2), { encoding: "utf8", mode: 0o600 });
      return result;
    };
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  async list(botId: string): Promise<CommandRule[]> {
    return (await this.load()).filter((rule) => rule.botId === botId).map(({ botId: _botId, ...rule }) => rule);
  }

  async add(botId: string, command: string, cwd: string): Promise<CommandRule> {
    validateRule(command, cwd);
    return this.change((rules) => {
      const mine = rules.filter((rule) => rule.botId === botId);
      const same = mine.find((rule) => rule.command === command && rule.cwd === cwd);
      if (same) return { rules, result: { id: same.id, command, cwd } };
      if (mine.length >= MAX_RULES_PER_BOT) throw new RequestError(`A bot can have at most ${MAX_RULES_PER_BOT} allowed commands.`);
      const rule: CommandRule = { id: randomUUID(), command, cwd };
      return { rules: [...rules, { ...rule, botId }], result: rule };
    });
  }

  remove(botId: string, id: string): Promise<boolean> {
    return this.change((rules) => {
      const next = rules.filter((rule) => rule.botId !== botId || rule.id !== id);
      return { rules: next, result: next.length !== rules.length };
    });
  }

  /** Exact command and folder only: a longer command or another folder still asks. */
  async matches(botId: string, command: string, cwd: string): Promise<boolean> {
    return (await this.load()).some((rule) => rule.botId === botId && rule.command === command && rule.cwd === cwd);
  }
}

// ---------------------------------------------------------------- trusted folders

const MAX_FOLDERS_PER_BOT = 50;
/** Device files a command may name in any folder (2>/dev/null). */
const DEVICE_PATHS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const GLOB = /[*?[{]/;

export interface FolderRule {
  id: string;
  folder: string;
}

type StoredFolder = FolderRule & { botId: string };

function foldersPath(): string {
  return join(dataPath(), "folders.json");
}

const home = (path: string) => path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());

/** The folder a path names before its first glob character: src/lib/*.ts is src/lib. */
function staticPrefix(path: string): string {
  const glob = path.search(GLOB);
  return glob < 0 ? path : dirname(path.slice(0, glob) + "x");
}

/** Whether `path` is `folder` or inside it. */
export function isInside(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

/** A command without its here-documents' bodies: they're text for a file or a program (an import of "../x"), not paths. */
function withoutHeredocs(command: string): string {
  const kept: string[] = [];
  let end: string | null = null;
  for (const line of command.split("\n")) {
    if (end !== null) {
      if (line.replace(/^\t+/, "") === end) end = null;
      continue;
    }
    kept.push(line);
    // <<EOF, <<'EOF', <<"EOF", <<-EOF; not a here-string (<<<).
    const heredoc = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (heredoc) end = heredoc[2]!;
  }
  return kept.join("\n");
}

/**
 * The paths a shell command's words name that could reach outside its folder: absolute ones, ~ and
 * $HOME ones, and relative ones that climb out with "..". Device files and here-documents' text
 * don't count. It's a guard against the obvious, not a sandbox: a command can still reach
 * elsewhere in ways words don't show.
 */
export function commandPaths(command: string, folder: string): string[] {
  const paths: string[] = [];
  for (const word of withoutHeredocs(command).split(/[\s;|&<>()`'"=,]+/)) {
    if (!word) continue;
    const expanded = home(word);
    if (expanded.startsWith("/")) paths.push(resolve(staticPrefix(expanded)));
    else if (expanded.split("/").includes("..")) paths.push(resolve(folder, staticPrefix(expanded)));
  }
  return paths.filter((path) => !DEVICE_PATHS.has(path));
}

const strings = (value: unknown): string[] | null => (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry) ? (value as string[]) : null);

/**
 * What an approval request works on, as absolute paths: a shell command's folder and the paths
 * its words name (commandPaths); the file a read, edit or write touches (Codex's patch: every
 * file it changes; OpenCode's edit: its resources); where a file search looks. Null when it isn't
 * about files at all (a web search, an MCP tool) or doesn't say: those always ask.
 */
export function requestPaths(request: Pick<ApprovalRequest, "kind" | "name" | "input" | "detail">, cwd: string): string[] | null {
  if (request.kind !== "tool") return null;
  const input = request.input ?? {};
  const at = (path: string, base = cwd) => resolve(base, home(path));
  const detail = request.detail;
  switch (detail?.type) {
    case "shell": {
      const folder = at(detail.cwd || cwd);
      return [folder, ...commandPaths(detail.command, folder)];
    }
    case "read":
    case "edit":
    case "write":
      return [at(detail.filePath), ...(strings(input.paths) ?? []).map((path) => at(path))];
    case "search": {
      if (detail.toolName !== "grep" && detail.toolName !== "glob") return null;
      const where = at(typeof input.path === "string" && input.path ? input.path : cwd);
      // An absolute glob pattern names where it looks itself.
      const pattern = typeof input.pattern === "string" ? home(input.pattern) : "";
      return detail.toolName === "glob" && pattern.startsWith("/") ? [where, staticPrefix(pattern)] : [where];
    }
  }
  const paths = strings(input.paths) ?? (["edit", "write", "patch"].includes(request.name) ? strings(input.resources) : null);
  return paths ? paths.map((path) => at(staticPrefix(path))) : null;
}

/** A path with its links resolved as far as it exists, so a link inside a folder can't lead out of it. */
async function real(path: string): Promise<string> {
  let existing = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(existing), ...rest.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      rest.push(existing.slice(parent.length).replace(/^[\\/]+/, ""));
      existing = parent;
    }
  }
}

/** Throws a message the person can act on when a folder can't be trusted. */
function validateFolder(folder: string): void {
  if (!isAbsolute(folder) || folder.split(/[\\/]/).includes("..")) throw new RequestError("The folder must be an absolute path.");
  if (isInside(folder, homedir())) throw new RequestError("That folder is too broad: it holds your whole home folder. Pick a project folder instead.");
}

/**
 * Folders a bot may work in without asking: a command that runs in one (and names no path outside
 * it), and reading, editing, writing or searching files in one. Saved from an approval card;
 * each bot has its own.
 */
export class FolderGrants {
  private queue: Promise<unknown> = Promise.resolve();

  private async load(): Promise<StoredFolder[]> {
    try {
      const saved = JSON.parse(await readFile(foldersPath(), "utf8")) as { folders?: StoredFolder[] };
      return Array.isArray(saved.folders) ? saved.folders : [];
    } catch {
      return [];
    }
  }

  private change<T>(edit: (folders: StoredFolder[]) => { folders: StoredFolder[]; result: T }): Promise<T> {
    const run = async () => {
      const { folders, result } = edit(await this.load());
      await mkdir(dataPath(), { recursive: true });
      await writeFile(foldersPath(), JSON.stringify({ version: 1, folders }, null, 2), { encoding: "utf8", mode: 0o600 });
      return result;
    };
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  async list(botId: string): Promise<FolderRule[]> {
    return (await this.load()).filter((rule) => rule.botId === botId).map(({ botId: _botId, ...rule }) => rule);
  }

  async add(botId: string, rawFolder: string): Promise<FolderRule> {
    validateFolder(rawFolder);
    const folder = resolve(rawFolder);
    return this.change((folders) => {
      const mine = folders.filter((rule) => rule.botId === botId);
      const same = mine.find((rule) => rule.folder === folder);
      if (same) return { folders, result: { id: same.id, folder } };
      if (mine.length >= MAX_FOLDERS_PER_BOT) throw new RequestError(`A bot can have at most ${MAX_FOLDERS_PER_BOT} trusted folders.`);
      const rule: FolderRule = { id: randomUUID(), folder };
      return { folders: [...folders, { ...rule, botId }], result: rule };
    });
  }

  remove(botId: string, id: string): Promise<boolean> {
    return this.change((folders) => {
      const next = folders.filter((rule) => rule.botId !== botId || rule.id !== id);
      return { folders: next, result: next.length !== folders.length };
    });
  }

  /** Every path is inside one of the bot's trusted folders, links resolved on both sides. */
  async covers(botId: string, paths: readonly string[]): Promise<boolean> {
    const folders = await this.list(botId);
    if (folders.length === 0 || paths.length === 0) return false;
    const trusted = await Promise.all(folders.map((rule) => real(rule.folder)));
    for (const path of paths) {
      const resolved = await real(path);
      if (!trusted.some((folder) => isInside(folder, resolved))) return false;
    }
    return true;
  }
}
