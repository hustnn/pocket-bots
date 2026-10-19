import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatSnapshot } from "../shared/chat-types";
import { toWire, type ComposerAttachment } from "../shared/attachments";
import type { QueuedMessage, QueuedSummary } from "../shared/rpc";
import { newUuid } from "../shared/uuid";
import { dataPath } from "./bot-home";
import { sendToChat } from "./chats";
import { RequestError } from "./errors";
import type { PocketHost } from "./host";
import { isBusy } from "./chat-service";

// Messages queued while a bot works (the "queue" send behavior). They're
// kept here rather than in the browser, so they go out with no page open: one
// at a time, whenever the chat is idle. A send that fails goes back to the
// front and the chat's queue waits until it's resumed.

/** How long a sent message may take to show up as a running turn before the next one may go. */
const AWAIT_TURN_MS = 4_000;
const queuePath = () => join(dataPath(), "queue.json");

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export class MessageQueue {
  private cache: Record<string, QueuedMessage[]> | null = null;
  /** Why a chat's last queued send failed; its queue waits while one is set. */
  private readonly errors = new Map<string, string>();
  /** Chats with a message sent whose turn hasn't been seen starting yet. */
  private readonly awaiting = new Map<string, ReturnType<typeof setTimeout>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: PocketHost,
    private readonly changed: (chatId: string) => void = () => {},
  ) {}

  async list(chatId: string): Promise<{ messages: QueuedSummary[]; error: string | null }> {
    const messages = (await this.load())[chatId] ?? [];
    return {
      messages: messages.map(({ id, text, attachments, quote, queuedAt }) => ({ id, text, queuedAt, attachments: attachments.map(({ kind, name }) => ({ kind, name })), ...(quote ? { quote } : {}) })),
      error: this.errors.get(chatId) ?? null,
    };
  }

  /** Queues a message; an idle chat gets it right away. */
  add(chatId: string, input: { text: string; attachments: ComposerAttachment[]; quote?: string }): Promise<string> {
    return this.serial(async () => {
      const message: QueuedMessage = { id: newUuid(), text: input.text, attachments: input.attachments, ...(input.quote ? { quote: input.quote } : {}), queuedAt: new Date().toISOString() };
      const all = await this.load();
      all[chatId] = [...(all[chatId] ?? []), message];
      this.errors.delete(chatId);
      await this.save(chatId);
      await this.drain(chatId);
      return message.id;
    });
  }

  /** Takes a message out of the queue (to edit it, drop it or send it now). */
  take(chatId: string, id: string): Promise<QueuedMessage | null> {
    return this.serial(async () => {
      const all = await this.load();
      const message = all[chatId]?.find((entry) => entry.id === id) ?? null;
      if (!message) return null;
      all[chatId] = all[chatId]!.filter((entry) => entry.id !== id);
      await this.save(chatId);
      return message;
    });
  }

  /** Sends one queued message now, whatever the chat is doing. */
  async sendNow(chatId: string, id: string, activeTurnBehavior: "steer" | "interrupt"): Promise<void> {
    const message = await this.take(chatId, id);
    if (!message) throw new RequestError("That message isn't queued any more.");
    try {
      await this.deliver(chatId, message, activeTurnBehavior);
    } catch (error) {
      await this.serial(async () => {
        const all = await this.load();
        all[chatId] = [message, ...(all[chatId] ?? [])];
        await this.save(chatId);
      });
      throw error;
    }
  }

  /** Clears a failed send so the queue drains again. */
  resume(chatId: string): Promise<void> {
    this.errors.delete(chatId);
    this.changed(chatId);
    return this.serial(() => this.drain(chatId));
  }

  /** Every update of a bot chat: a running turn means the last send arrived; an idle chat takes the next message. */
  onAgent(agent: ChatSnapshot): void {
    if (isBusy(agent.status)) {
      clearTimeout(this.awaiting.get(agent.id));
      this.awaiting.delete(agent.id);
      return;
    }
    void this.serial(() => this.drain(agent.id, agent)).catch((error: unknown) => console.error(`pocket-bots: couldn't send a queued message to ${agent.id}`, error));
  }

  /** A chat that's gone (archived or deleted) drops what was queued for it. */
  forget(chatId: string): Promise<void> {
    clearTimeout(this.awaiting.get(chatId));
    this.awaiting.delete(chatId);
    this.errors.delete(chatId);
    return this.serial(async () => {
      const all = await this.load();
      if (!all[chatId]) return;
      delete all[chatId];
      await this.save(chatId);
    });
  }

  /** Sends the chat's next message if it's idle and nothing else is on its way. Runs inside `serial`. */
  private async drain(chatId: string, known?: ChatSnapshot): Promise<void> {
    if (this.awaiting.has(chatId) || this.errors.has(chatId)) return;
    const all = await this.load();
    const next = all[chatId]?.[0];
    if (!next) return;
    const agent = known ?? this.host.chats.get(chatId);
    if (!agent || isBusy(agent.status) || agent.archivedAt || agent.status === "closed") return;
    all[chatId] = all[chatId]!.slice(1);
    await this.save(chatId);
    try {
      await this.deliver(chatId, next, "steer");
    } catch (error) {
      all[chatId] = [next, ...(all[chatId] ?? [])];
      this.errors.set(chatId, errorText(error));
      await this.save(chatId);
    }
  }

  private async deliver(chatId: string, message: QueuedMessage, activeTurnBehavior: "steer" | "interrupt"): Promise<void> {
    const wire = toWire(message.attachments);
    await sendToChat(this.host, chatId, { text: message.text, images: wire.images, attachments: wire.attachments, messageId: message.id, activeTurnBehavior, ...(message.quote ? { quote: message.quote } : {}) });
    // Hold the next message until this turn shows up as running (or a moment passes).
    clearTimeout(this.awaiting.get(chatId));
    this.awaiting.set(
      chatId,
      setTimeout(() => {
        this.awaiting.delete(chatId);
        void this.serial(() => this.drain(chatId)).catch(() => {});
      }, AWAIT_TURN_MS),
    );
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => {});
    return next;
  }

  private async load(): Promise<Record<string, QueuedMessage[]>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(queuePath(), "utf8")) as Record<string, QueuedMessage[]>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async save(chatId: string): Promise<void> {
    const all = await this.load();
    if (all[chatId]?.length === 0) delete all[chatId];
    await mkdir(dataPath(), { recursive: true });
    const temp = `${queuePath()}.tmp`;
    await writeFile(temp, JSON.stringify(all), { encoding: "utf8", mode: 0o600 });
    await rename(temp, queuePath());
    this.changed(chatId);
  }
}
