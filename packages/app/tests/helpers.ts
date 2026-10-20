import { PocketHost } from "../src/server/host";
import { EMPTY_LIBRARY, type Bot, type BotSettingsValues, type Library } from "../src/shared/bot";

export const NOW = "2026-09-27T00:00:00.000Z";

export function makeBot(patch: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Inbox",
    title: "",
    description: "",
    avatar: { seed: "s", palette: null, shape: "circle", imageUrl: null },
    hostId: null,
    provider: "claude",
    model: null,
    modeId: null,
    thinkingOptionId: null,
    soul: "",
    mcpServerIds: [],
    alwaysAllow: [],
    skillIds: [],
    apps: [],
    appRules: {},
    voice: { name: null, readReplies: false },
    contactBots: "ask",
    memoryAutoWrite: false,
    routines: [],
    playbooks: [],
    cwd: null,
    pinned: false,
    hidden: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

export type FakeHost = PocketHost & { values(): Promise<BotSettingsValues>; attach(chats: unknown): void };

/** The real PocketHost over an in-memory bots document; `attach` gives it a (fake) chat service. */
export function fakeHost(bots: Bot[], library: Library = EMPTY_LIBRARY): FakeHost {
  const values: BotSettingsValues = { bots, history: [], library };
  const store = { values: async () => values };
  const host = new PocketHost(store as never, new Map()) as FakeHost;
  host.attach = (chats: unknown) => {
    host.chats = chats as never;
  };
  host.attach(fakeChats({}));
  return host;
}

export interface FakeChat {
  status: string;
  labels?: Record<string, string>;
  title?: string | null;
  reply?: string;
  pendingPermissions?: unknown[];
  lastError?: string | null;
  updatedAt?: string;
  archivedAt?: string | null;
  /** The folder it works in; defaults to /tmp. */
  cwd?: string;
  /** The chat's timeline items; defaults to a question and `reply`. */
  items?: { type: string; [key: string]: unknown }[];
  /** Still working when a wait gives up. */
  stuck?: boolean;
  /** Runs while a tool call waits on the chat. */
  onWait?: () => Promise<void>;
}

export interface Sent {
  chatId: string;
  text: string;
  whenBusy: string;
  images?: unknown[];
}

/** A stand-in for ChatService over a map of chats; records sends and archives. */
export function fakeChats(chats: Record<string, FakeChat>) {
  const sent: Sent[] = [];
  const archived: string[] = [];
  const folderSets: { chatId: string; folders: string[] }[] = [];
  let failures = 0;
  const snapshot = (id: string) => {
    const chat = chats[id];
    if (!chat) return null;
    return {
      id,
      provider: "claude",
      model: null,
      cwd: chat.cwd ?? "/tmp",
      extraFolders: [],
      title: chat.title ?? null,
      labels: chat.labels ?? {},
      status: chat.status,
      pendingPermissions: chat.pendingPermissions ?? [],
      lastError: chat.lastError ?? (chat.status === "error" ? "The model refused." : null),
      lastUsage: null,
      attentionReason: null,
      requiresAttention: false,
      attentionTimestamp: null,
      activeTurn: null,
      createdAt: chat.updatedAt ?? NOW,
      updatedAt: chat.updatedAt ?? NOW,
      lastUserMessageAt: null,
      archivedAt: chat.archivedAt ?? null,
    };
  };
  const items = (id: string) => chats[id]?.items ?? [{ type: "user_message", text: "question" }, ...(chats[id]?.reply ? [{ type: "assistant_message", text: chats[id]!.reply }] : [])];
  const service = {
    sent,
    archived,
    folderSets,
    failNext: () => void failures++,
    get: snapshot,
    items,
    list: (filter: { labels?: Record<string, string> } = {}) =>
      Object.keys(chats)
        .map((id) => snapshot(id)!)
        .filter((chat) => Object.entries(filter.labels ?? {}).every(([key, value]) => chat.labels[key] === value)),
    timeline: (id: string) => ({ entries: items(id).map((item, index) => ({ provider: "claude", item, timestamp: chats[id]?.updatedAt ?? NOW, seqStart: index + 1, seqEnd: index + 1 })), startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, agent: snapshot(id) }),
    waitForFinish: async (id: string) => {
      const chat = chats[id]!;
      await chat.onWait?.();
      if (chat.status === "running" && !chat.stuck) {
        chat.status = "idle";
        chat.reply ??= "Done.";
      }
      return snapshot(id);
    },
    send: async (chatId: string, message: { text: string; images?: unknown[] }, whenBusy = "steer") => {
      if (failures > 0) {
        failures--;
        return { ok: false, reason: "error", detail: "The runtime said no." };
      }
      sent.push({ chatId, text: message.text, whenBusy, ...(message.images ? { images: message.images } : {}) });
      return { ok: true, as: "turn", turnId: "t" };
    },
    archive: async (chatId: string) => {
      archived.push(chatId);
    },
    setExtraFolders: async (chatId: string, folders: string[]) => {
      folderSets.push({ chatId, folders });
    },
    on: () => () => {},
  };
  return service;
}
