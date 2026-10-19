import type { ProviderId, RuntimeAdapter } from "@pocket-bots/runtime";
import { BOT_LABEL, EMPTY_LIBRARY, type Bot, type BotSettingsValues, type Library } from "../shared/bot";
import { ROUTINE_LABEL } from "../shared/chat";
import type { ChatService } from "./chat-service";
import { Providers } from "./providers";
import type { Store } from "./store";

// What every server feature needs: the bots document, the chats and the runtimes.

export class PocketHost {
  chats!: ChatService;
  readonly providers: Providers;

  constructor(
    readonly store: Store,
    readonly runtimes: ReadonlyMap<ProviderId, RuntimeAdapter>,
  ) {
    this.providers = new Providers(runtimes);
  }

  async values(): Promise<BotSettingsValues | null> {
    return this.store.values();
  }

  async library(): Promise<Library> {
    return (await this.store.values()).library ?? EMPTY_LIBRARY;
  }

  async bots(): Promise<Bot[]> {
    return (await this.store.values()).bots;
  }

  async bot(botId: string): Promise<Bot | null> {
    return (await this.bots()).find((bot) => bot.id === botId) ?? null;
  }

  /** A bot chat's bot, its current title, routine and labels; null for other chats. */
  async chatOf(chatId: string): Promise<{ botId: string; title: string | null; routineId: string | null; labels: Record<string, string> } | null> {
    const chat = this.chats.get(chatId);
    const botId = chat?.labels[BOT_LABEL] ?? null;
    return chat && botId ? { botId, title: chat.title, routineId: chat.labels[ROUTINE_LABEL] ?? null, labels: chat.labels } : null;
  }

  async botIdOf(chatId: string): Promise<string | null> {
    return this.chats.get(chatId)?.labels[BOT_LABEL] ?? null;
  }
}
