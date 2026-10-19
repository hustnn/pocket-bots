import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StoreSchema, STORE_VERSION, type BotSettingsValues } from "../shared/bot";
import { dataPath } from "./bot-home";

// The bots document (bots, library, defaults, presets): one JSON file
// written atomically. Every save names the revision it started from, so two
// editors can't silently overwrite each other; the server is the only writer.

export type StoreState = { values: BotSettingsValues; revision: string };
export type SaveResult = { status: "saved"; revision: string; values: BotSettingsValues } | { status: "conflict"; revision: string } | { status: "invalid"; error: string };

type Listener = (state: StoreState) => void;

const storePath = () => join(dataPath(), "bots.json");
const revisionOf = (raw: string) => createHash("sha256").update(raw).digest("hex").slice(0, 16);

export class Store {
  private state: StoreState | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<Listener>();

  async read(): Promise<StoreState> {
    if (this.state) return this.state;
    let raw: string | null = null;
    try {
      raw = await readFile(storePath(), "utf8");
    } catch {
      raw = null;
    }
    if (raw === null) {
      this.state = { values: StoreSchema.parse({}), revision: "empty" };
      return this.state;
    }
    const envelope = JSON.parse(raw) as { version?: unknown; values?: unknown };
    const parsed = StoreSchema.safeParse(envelope.values ?? {});
    if (!parsed.success) throw new Error(`${storePath()} doesn't match the bots schema: ${parsed.error.message}`);
    this.state = { values: parsed.data, revision: revisionOf(raw) };
    return this.state;
  }

  async values(): Promise<BotSettingsValues> {
    return (await this.read()).values;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Saves a whole document edited from `revision`. */
  save(values: unknown, revision: string): Promise<SaveResult> {
    return this.serial(async () => {
      const current = await this.read();
      if (current.revision !== revision) return { status: "conflict", revision: current.revision };
      const parsed = StoreSchema.safeParse(values);
      if (!parsed.success) return { status: "invalid", error: parsed.error.message };
      return { status: "saved", ...(await this.write(parsed.data)) };
    });
  }

  /**
   * Moves the document aside (to bots.json.broken-<time>) and starts an empty
   * one, for when it can't be read. Nothing is deleted.
   */
  reset(): Promise<{ backup: string | null; revision: string }> {
    return this.serial(async () => {
      const path = storePath();
      const backup = `${path}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      let moved = true;
      try {
        await rename(path, backup);
      } catch {
        moved = false;
      }
      this.state = null;
      const state = await this.write(StoreSchema.parse({}));
      return { backup: moved ? backup : null, revision: state.revision };
    });
  }

  /** Applies a change to the latest document; `change` may throw to cancel. */
  update(change: (values: BotSettingsValues) => BotSettingsValues | Promise<BotSettingsValues>): Promise<StoreState> {
    return this.serial(async () => {
      const current = await this.read();
      const next = StoreSchema.parse(await change(structuredClone(current.values)));
      return this.write(next);
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async write(values: BotSettingsValues): Promise<StoreState> {
    const raw = `${JSON.stringify({ version: STORE_VERSION, values }, null, 2)}\n`;
    const path = storePath();
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, raw, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
    this.state = { values, revision: revisionOf(raw) };
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        console.error("pocket-bots: a store listener failed", error);
      }
    }
    return this.state;
  }
}
