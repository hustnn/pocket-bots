import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "../shared/activity";
import { lineDiff } from "../shared/diff";
import { dataPath } from "./bot-home";
import { RequestError } from "./errors";
import { MAIN_MEMORY, memoryFilePath, memoryFolder } from "./memory";

// The memory journal: every change to a bot's MEMORY.md and topic
// files, with the earlier text so it can be undone. Bots edit their memory with
// their own file tools, so their changes are found by comparing the files when
// a turn starts and ends. The journal lives outside the bots' folders so a bot
// can't rewrite its own history. The daily log is the app's own and isn't journaled.
// A bot whose memory writing is off has its changes put back when the turn ends
// (the restore is journaled too, so it can be undone). A bot can have several turns
// running at once (group seats, routines, chats), so a read-only bot's turn start
// leaves the baseline alone while another turn is running: that turn's changes are
// still to be found, and undone, when it ends.

const KEEP = 200;
const MAX_BEFORE_BYTES = 512 * 1024;

export interface JournalEntry {
  id: string;
  at: string;
  /** "MEMORY.md" or a topic file's name, as the memory RPCs name them. */
  file: string;
  actor: "bot" | "you";
  via: "chat" | "app" | "disk" | "undo" | "restore";
  chat: { id: string; title: string } | null;
  kind: "created" | "edited" | "deleted";
  /** The text before the change; null for a new file or one too large to keep. */
  before: string | null;
  diff: string;
  added: number;
  removed: number;
}

type Snapshot = Map<string, string>;

function journalPath(botId: string): string {
  return join(dataPath(), "journal", `${botId}.ndjson`);
}

/** MEMORY.md (when it exists) and every topic file, by name. */
async function snapshot(botId: string): Promise<Snapshot> {
  const files: Snapshot = new Map();
  const main = await readFile(memoryFilePath(botId, MAIN_MEMORY), "utf8").catch(() => null);
  if (main !== null) files.set(MAIN_MEMORY, main);
  const names = await readdir(join(memoryFolder(botId), "memory")).catch(() => [] as string[]);
  for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
    const text = await readFile(memoryFilePath(botId, name), "utf8").catch(() => null);
    if (text !== null) files.set(name, text);
  }
  return files;
}

export class MemoryJournal {
  /** What each bot's memory looked like when the journal last checked. */
  private readonly seen = new Map<string, Snapshot>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** The chats with a turn running, by bot (ids, so a turn that's reported twice or never leaves no count behind). */
  private readonly running = new Map<string, Set<string>>();

  /** Runs one change per bot at a time. */
  private serial<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(botId) ?? Promise.resolve()).then(work);
    this.queues.set(
      botId,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * A turn of `chatId` is starting: anything that changed since the last look was done outside the app.
   * Not so for a read-only bot while another of its turns is running: what changed may be that turn's
   * doing, so nothing is recorded and the baseline stays for that turn's end to compare with.
   */
  begin(botId: string, chatId: string, { readOnly = false }: { readOnly?: boolean } = {}): Promise<void> {
    return this.serial(botId, async () => {
      const others = [...(this.running.get(botId) ?? [])].some((id) => id !== chatId);
      this.running.set(botId, (this.running.get(botId) ?? new Set()).add(chatId));
      const previous = this.seen.get(botId);
      if (readOnly && others && previous) return;
      const current = await snapshot(botId);
      if (previous) await this.record(botId, previous, current, { actor: "you", via: "disk", chat: null });
      this.seen.set(botId, current);
    });
  }

  /** The turn of `chatId` is over without `end` (the journal didn't see it start), or its chat is gone. */
  leave(botId: string, chatId: string): Promise<void> {
    return this.serial(botId, async () => this.stopRunning(botId, chatId));
  }

  /** A chat was deleted: whatever turn of it the journal thought was running isn't. */
  forget(chatId: string): Promise<void> {
    const bots = [...this.running].filter(([, chats]) => chats.has(chatId)).map(([botId]) => botId);
    return Promise.all(bots.map((botId) => this.leave(botId, chatId))).then(() => {});
  }

  private stopRunning(botId: string, chatId: string): void {
    const chats = this.running.get(botId);
    if (!chats) return;
    chats.delete(chatId);
    if (chats.size === 0) this.running.delete(botId);
  }

  /**
   * A turn ended: what changed during it was the bot's doing in that chat. With `readOnly`
   * (the bot may not write its memory) those changes are then put back, and that is journaled too.
   */
  end(botId: string, chat: { id: string; title: string }, { readOnly = false }: { readOnly?: boolean } = {}): Promise<void> {
    return this.serial(botId, async () => {
      this.stopRunning(botId, chat.id);
      let current = await snapshot(botId);
      const previous = this.seen.get(botId);
      // After a restart there's nothing to compare with until the next turn.
      if (previous) {
        await this.record(botId, previous, current, { actor: "bot", via: "chat", chat });
        if (readOnly) current = await this.restore(botId, previous, current, chat);
      }
      this.seen.set(botId, current);
    });
  }

  /** The app is about to write or delete a memory file (null) for the person. */
  write(botId: string, file: string, text: string | null, via: "app" | "undo" = "app"): Promise<void> {
    return this.serial(botId, () => this.apply(botId, file, text, via));
  }

  private async apply(botId: string, file: string, text: string | null, via: "app" | "undo"): Promise<void> {
    const path = memoryFilePath(botId, file);
    const before = await readFile(path, "utf8").catch(() => null);
    if (text === null) await rm(path, { force: true });
    else {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, text, "utf8");
    }
    await this.append(botId, file, before, text, { actor: "you", via, chat: null });
    const seen = this.seen.get(botId);
    if (seen) {
      if (text === null) seen.delete(file);
      else seen.set(file, text);
    }
  }

  async list(botId: string, limit = 50): Promise<JournalEntry[]> {
    return (await this.load(botId)).reverse().slice(0, limit);
  }

  /** Puts a file back the way it was before an entry; the undo is journaled too. */
  undo(botId: string, id: string): Promise<void> {
    return this.serial(botId, async () => {
      const entry = (await this.load(botId)).find((candidate) => candidate.id === id);
      if (!entry) throw new RequestError("That change is no longer in the journal.");
      if (entry.kind !== "created" && entry.before === null) throw new RequestError("This change was too large to keep a copy of.");
      // Undoing a new topic file deletes it; MEMORY.md is emptied instead.
      const restore = entry.kind === "created" ? (entry.file === MAIN_MEMORY ? "" : null) : entry.before;
      await this.apply(botId, entry.file, restore, "undo");
    });
  }

  /** Puts every file that differs from `previous` back, journals each restore, and returns what the files look like now. */
  private async restore(botId: string, previous: Snapshot, current: Snapshot, chat: { id: string; title: string }): Promise<Snapshot> {
    let restored = false;
    for (const file of new Set([...previous.keys(), ...current.keys()])) {
      const before = current.get(file) ?? null;
      const after = previous.get(file) ?? null;
      if (before === after) continue;
      const path = memoryFilePath(botId, file);
      try {
        if (after === null) await rm(path, { force: true });
        else {
          await mkdir(join(path, ".."), { recursive: true });
          await writeFile(path, after, "utf8");
        }
      } catch {
        // Not put back: the snapshot below shows it as it is, and the next turn's start notes it.
        continue;
      }
      restored = true;
      await this.append(botId, file, before, after, { actor: "you", via: "restore", chat });
    }
    return restored ? snapshot(botId) : current;
  }

  private async record(botId: string, previous: Snapshot, current: Snapshot, who: Pick<JournalEntry, "actor" | "via" | "chat">): Promise<void> {
    for (const file of new Set([...previous.keys(), ...current.keys()])) {
      const before = previous.get(file) ?? null;
      const after = current.get(file) ?? null;
      if (before !== after) await this.append(botId, file, before, after, who);
    }
  }

  private async append(botId: string, file: string, before: string | null, after: string | null, who: Pick<JournalEntry, "actor" | "via" | "chat">): Promise<void> {
    if (before === after) return;
    const { diff, added, removed } = lineDiff(redactSecrets(before ?? ""), redactSecrets(after ?? ""));
    const entry: JournalEntry = {
      id: `j-${randomBytes(5).toString("hex")}`,
      at: new Date().toISOString(),
      file,
      ...who,
      kind: before === null ? "created" : after === null ? "deleted" : "edited",
      before: before !== null && Buffer.byteLength(before, "utf8") <= MAX_BEFORE_BYTES ? before : null,
      diff,
      added,
      removed,
    };
    const entries = [...(await this.load(botId)), entry].slice(-KEEP);
    await mkdir(join(dataPath(), "journal"), { recursive: true });
    await writeFile(journalPath(botId), entries.map((item) => JSON.stringify(item)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  }

  private async load(botId: string): Promise<JournalEntry[]> {
    const text = await readFile(journalPath(botId), "utf8").catch(() => "");
    const entries: JournalEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        // A torn line from a crash; skip it.
      }
    }
    return entries;
  }
}
