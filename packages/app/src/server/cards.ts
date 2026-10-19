import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatCard } from "../shared/rpc";
import { dataPath } from "./bot-home";

// Cards pocket-bots shows inside a chat between its messages. They're kept
// apart from the runtime's timeline, and the web UI places them by time (a routine run's result in its results chat).

const KEEP_PER_CHAT = 100;
const cardsPath = () => join(dataPath(), "cards.json");

type Listener = (chatId: string) => void;

export class ChatCards {
  private cache: Record<string, ChatCard[]> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<Listener>();

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(chatId: string): Promise<ChatCard[]> {
    return [...((await this.load())[chatId] ?? [])];
  }

  /** Adds a card, or replaces the one with the same id. */
  upsert(chatId: string, card: ChatCard): Promise<void> {
    const run = async () => {
      const all = await this.load();
      const cards = (all[chatId] ?? []).filter((entry) => entry.id !== card.id);
      const existing = all[chatId]?.find((entry) => entry.id === card.id);
      all[chatId] = [...cards, existing ? { ...card, at: existing.at } : card].sort((a, b) => a.at.localeCompare(b.at)).slice(-KEEP_PER_CHAT);
      await mkdir(dataPath(), { recursive: true });
      const temp = `${cardsPath()}.tmp`;
      await writeFile(temp, JSON.stringify(all), "utf8");
      await rename(temp, cardsPath());
      for (const listener of this.listeners) listener(chatId);
    };
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async load(): Promise<Record<string, ChatCard[]>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(cardsPath(), "utf8")) as Record<string, ChatCard[]>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }
}
