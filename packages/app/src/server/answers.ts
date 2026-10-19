import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BOT_LABEL } from "../shared/bot";
import { dataPath } from "./bot-home";
import type { PocketHost } from "./host";
import type { MessageQueue } from "./queue";
import { answerMessage, readChat } from "./tools/bots";

// Answers that come back on their own. A tool call waits about 50 seconds at
// most, so ask_bot or check_chat can return while the asked bot still works.
// The asking chat is then owed that answer: when the asked chat's turn ends,
// its reply goes to the asking chat as a message, through the queue so a busy
// chat gets it once it's idle, and the asking bot carries on in a new turn.

interface Owed {
  /** The asking chat, the last one told the answer was still coming. */
  from: string;
  at: string;
}

const owedPath = () => join(dataPath(), "answers.json");

export class AskedAnswers {
  private cache: Record<string, Owed> | null = null;
  /** Asked chats a tool call is waiting on right now; that call returns the answer itself. */
  private readonly waits = new Map<string, number>();
  /** Answers handed to the queue, which may not have gone out yet. */
  private readonly queued = new Map<string, { from: string; messageId: string }>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: PocketHost,
    private readonly queue: Pick<MessageQueue, "add" | "take">,
  ) {}

  /** Runs a tool call's look at an asked chat; meanwhile its answer isn't sent separately. */
  async waiting<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    this.waits.set(chatId, (this.waits.get(chatId) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (this.waits.get(chatId) ?? 1) - 1;
      if (left > 0) this.waits.set(chatId, left);
      else this.waits.delete(chatId);
    }
  }

  /** Whether the asked chat's answer is already coming to an asking chat on its own. */
  async owes(chatId: string): Promise<boolean> {
    return chatId in (await this.load());
  }

  /** The asking chat `from` was told the asked chat is still working, so the answer is owed there. */
  owe(chatId: string, from: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.load();
      all[chatId] = { from, at: new Date().toISOString() };
      await this.save();
      // The turn may have ended after the tool looked and before this was noted.
      await this.send(chatId);
    });
  }

  /** A tool call gave the asking chat the answer: nothing is owed, and a copy still queued is dropped. */
  received(chatId: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.load();
      if (all[chatId]) {
        delete all[chatId];
        await this.save();
      }
      const queued = this.queued.get(chatId);
      this.queued.delete(chatId);
      if (queued) await this.queue.take(queued.from, queued.messageId);
    });
  }

  /** An asked chat's turn ended: the chat waiting on it gets the answer. */
  ended(chatId: string): Promise<void> {
    return this.serial(() => this.send(chatId));
  }

  /** A chat that's gone owes nothing and is owed nothing. */
  forget(chatId: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.load();
      const gone = Object.keys(all).filter((asked) => asked === chatId || all[asked]!.from === chatId);
      for (const asked of gone) delete all[asked];
      if (gone.length) await this.save();
      for (const [asked, queued] of this.queued) if (asked === chatId || queued.from === chatId) this.queued.delete(asked);
    });
  }

  /** Sends an owed answer once the asked chat is done. Runs inside `serial`. */
  private async send(chatId: string): Promise<void> {
    const all = await this.load();
    const owed = all[chatId];
    if (!owed || this.waits.has(chatId)) return;
    const chat = await readChat(this.host, chatId).catch(() => null);
    if (!chat || chat.state === "running" || chat.state === "permission") return;
    const who = (await this.host.bot(chat.labels[BOT_LABEL] ?? ""))?.name ?? "The other bot";
    delete all[chatId];
    await this.save();
    const messageId = await this.queue.add(owed.from, { text: answerMessage(chat, who, chatId), attachments: [] });
    this.queued.set(chatId, { from: owed.from, messageId });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => {});
    return next;
  }

  private async load(): Promise<Record<string, Owed>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(owedPath(), "utf8")) as Record<string, Owed>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async save(): Promise<void> {
    await mkdir(dataPath(), { recursive: true });
    const temp = `${owedPath()}.tmp`;
    await writeFile(temp, JSON.stringify(await this.load()), { encoding: "utf8", mode: 0o600 });
    await rename(temp, owedPath());
  }
}
