import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatSnapshot } from "../../shared/chat-types";
import { BOT_LABEL, DEFAULT_BOT_LIST_UI, type BotListUi, type BotSettingsValues } from "../../shared/bot";
import type { GroupMessage } from "../../shared/group-chat";
import { chatSettled, readMarkCurrent, withReadMark } from "../../shared/sidebar";
import {
  chatCardsRpc,
  chatCommandsRpc,
  chatsAllRpc,
  chatsListRpc,
  chatTimelineRpc,
  groupMessagesRpc,
  groupNoteRpc,
  groupNotesRpc,
  groupRemindersRpc,
  groupTasksRpc,
  groupsListRpc,
  providersRpc,
  queueListRpc,
  routineStatusRpc,
  workspacesRpc,
  statusRpc,
  storeGetRpc,
  storeSaveRpc,
  type PocketEvent,
  type TimelineEntry,
  type TimelinePage,
} from "../../shared/rpc";
import { mergeEntries } from "../chat/model";
import { errorText, rpc } from "./api";

export const keys = {
  store: ["store"] as const,
  status: ["status"] as const,
  providers: ["providers"] as const,
  allChats: ["chats", "all"] as const,
  botChats: (botId: string, archived: boolean) => ["chats", "bot", botId, archived] as const,
  cards: (chatId: string) => ["cards", chatId] as const,
  queue: (chatId: string) => ["queue", chatId] as const,
  commands: (chatId: string) => ["commands", "chat", chatId] as const,
  routines: ["routines"] as const,
  groups: ["groups"] as const,
  groupMessages: (groupId: string) => ["groups", "messages", groupId] as const,
  /** Under groupMessages, so the group's changes refresh its open thread too. */
  groupThread: (groupId: string, thread: number) => ["groups", "messages", groupId, "thread", thread] as const,
  groupTasks: (groupId: string) => ["groups", "messages", groupId, "tasks"] as const,
  groupNotes: (groupId: string) => ["groups", "messages", groupId, "notes"] as const,
  groupNote: (groupId: string, id: number) => ["groups", "messages", groupId, "notes", id] as const,
  groupReminders: (groupId: string) => ["groups", "messages", groupId, "reminders"] as const,
};

// ---------------------------------------------------------------- the bots document

export function useStoreDoc() {
  return useQuery({ queryKey: keys.store, queryFn: () => rpc(storeGetRpc, {}), staleTime: Infinity });
}

/**
 * Saves a change to the bots document: applies `mutate` to the latest copy and
 * retries on a revision conflict, so two open windows never overwrite each other.
 */
export function useCommit() {
  const client = useQueryClient();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  return useCallback(
    (mutate: (values: BotSettingsValues) => BotSettingsValues): Promise<boolean> => {
      const run = async () => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const cached = client.getQueryData<{ values: BotSettingsValues; revision: string }>(keys.store);
          const current: { values: BotSettingsValues; revision: string } = cached ?? (await rpc(storeGetRpc, {}));
          const next = mutate(structuredClone(current.values));
          const result = await rpc(storeSaveRpc, { values: next, revision: current.revision });
          if (result.status === "saved") {
            client.setQueryData(keys.store, { values: result.values, revision: result.revision });
            return true;
          }
          if (result.status === "invalid") throw new Error(result.error);
          client.setQueryData(keys.store, await rpc(storeGetRpc, {}));
        }
        throw new Error("Someone else keeps changing the bots. Try again.");
      };
      const next = queue.current.then(run);
      queue.current = next.catch(() => {});
      return next;
    },
    [client],
  );
}

/**
 * The bot list's arrangement kept with the bots (pinned chats, chat order,
 * collapsed bots), so every browser shows the same list.
 */
export function useListUi(): [BotListUi, (change: (current: BotListUi) => BotListUi) => void] {
  const doc = useStoreDoc();
  const commit = useCommit();
  const ui = doc.data?.values.ui ?? DEFAULT_BOT_LIST_UI;
  const update = useCallback(
    (change: (current: BotListUi) => BotListUi) => void commit((values) => ({ ...values, ui: change(values.ui ?? DEFAULT_BOT_LIST_UI) })).catch(() => {}),
    [commit],
  );
  return [ui, update];
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * Marks the open chat read each time the user sees it settled. The read state
 * is kept with the list UI, which every browser shares.
 */
export function useMarkRead(chatId: string | null, agent: ChatSnapshot | null): void {
  const doc = useStoreDoc();
  const [ui, updateUi] = useListUi();
  const visible = useDocumentVisible();
  const seen = !!chatId && !!doc.data && visible && !!agent && agent.id === chatId && chatSettled(agent);
  // Without attention up there's nothing to mark: any attention raised later is unread anyway.
  const stale = seen && !!agent.requiresAttention && !readMarkCurrent(agent, ui.read[chatId]);
  const message = agent?.lastUserMessageAt ?? null;
  const attention = agent?.attentionTimestamp ?? null;
  useEffect(() => {
    if (!stale || !chatId) return;
    updateUi((current) => ({ ...current, read: withReadMark(current.read, chatId, { message, attention, at: new Date().toISOString() }) }));
  }, [stale, chatId, message, attention, updateUi]);
}

// ---------------------------------------------------------------- server

export function useStatus() {
  return useQuery({ queryKey: keys.status, queryFn: () => rpc(statusRpc, {}), refetchInterval: 30_000 });
}

export function useProviders() {
  return useQuery({ queryKey: keys.providers, queryFn: () => rpc(providersRpc, {}), staleTime: 60_000 });
}

/** Folders other bots work in, to pick a bot's working folder from. */
export function useWorkspaces(enabled = true) {
  return useQuery({ queryKey: ["workspaces"], queryFn: async () => (await rpc(workspacesRpc, {})).workspaces, enabled, staleTime: 30_000 });
}

export function useAllChats() {
  return useQuery({ queryKey: keys.allChats, queryFn: async () => (await rpc(chatsAllRpc, {})).chats });
}

export function useBotChats(botId: string | null, archived = false) {
  return useQuery({
    queryKey: keys.botChats(botId ?? "", archived),
    queryFn: async () => (await rpc(chatsListRpc, { botId: botId!, includeArchived: archived })).chats,
    enabled: !!botId,
  });
}

export function useRoutineStatus() {
  return useQuery({ queryKey: keys.routines, queryFn: () => rpc(routineStatusRpc, {}), refetchInterval: 60_000 });
}

export function useChatCards(chatId: string | null) {
  return useQuery({ queryKey: keys.cards(chatId ?? ""), queryFn: async () => (await rpc(chatCardsRpc, { chatId: chatId! })).cards, enabled: !!chatId });
}

/** Messages queued for a chat while its bot works. */
export function useQueue(chatId: string | null) {
  return useQuery({ queryKey: keys.queue(chatId ?? ""), queryFn: () => rpc(queueListRpc, { chatId: chatId! }), enabled: !!chatId });
}

/** The slash commands the chat's provider offers; asked for once the menu opens. */
export function useChatCommands(chatId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: keys.commands(chatId ?? ""),
    queryFn: () => rpc(chatCommandsRpc, { chatId: chatId! }),
    enabled: enabled && !!chatId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

function upsertChat(list: ChatSnapshot[] | undefined, agent: ChatSnapshot): ChatSnapshot[] | undefined {
  if (!list) return list;
  const index = list.findIndex((entry) => entry.id === agent.id);
  if (index < 0) return [agent, ...list];
  const next = [...list];
  next[index] = agent;
  return next;
}

function applyEvent(client: QueryClient, event: PocketEvent): void {
  switch (event.type) {
    case "store": {
      const current = client.getQueryData<{ revision: string }>(keys.store);
      if (current?.revision !== event.revision) void client.invalidateQueries({ queryKey: keys.store });
      return;
    }
    case "agent": {
      client.setQueryData<ChatSnapshot[]>(keys.allChats, (list) => upsertChat(list, event.agent));
      const botId = event.agent.labels?.[BOT_LABEL];
      if (botId) {
        client.setQueryData<ChatSnapshot[]>(keys.botChats(botId, false), (list) => upsertChat(list, event.agent));
        client.setQueryData<ChatSnapshot[]>(keys.botChats(botId, true), (list) => upsertChat(list, event.agent));
      }
      return;
    }
    case "agent-removed":
      client.setQueryData<ChatSnapshot[]>(keys.allChats, (list) => list?.filter((entry) => entry.id !== event.agentId));
      void client.invalidateQueries({ queryKey: ["chats", "bot"] });
      return;
    case "cards":
      void client.invalidateQueries({ queryKey: keys.cards(event.agentId) });
      return;
    case "queue":
      void client.invalidateQueries({ queryKey: keys.queue(event.agentId) });
      return;
    case "routines":
      void client.invalidateQueries({ queryKey: keys.routines });
      return;
    case "group":
      void client.invalidateQueries({ queryKey: keys.groups, exact: true });
      void client.invalidateQueries({ queryKey: keys.groupMessages(event.groupId) });
      return;
    case "timeline":
      return;
  }
}

const RECONNECT_MS = 2_000;
/** The server pings every 15 seconds; this long without a word, the connection is dead but nobody said so. */
const SILENCE_MS = 45_000;

/**
 * An event stream that outlives pocket-bots restarting. The browser retries a
 * dropped connection by itself, but gives up for good on an error answer (a
 * proxy's 502 while the server is down), and never notices a connection that
 * died quietly (a proxy that lost the server, a laptop that slept), so both
 * start over here. `onOpen` hears whether the stream came back after a gap,
 * whose events were missed.
 */
function openEvents(url: string, onEvent: (event: PocketEvent) => void, onOpen: (reconnected: boolean) => void): () => void {
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let opened = false;
  let closed = false;
  let heard = Date.now();
  const connect = () => {
    const current = new EventSource(url);
    source = current;
    heard = Date.now();
    current.onmessage = (message) => {
      heard = Date.now();
      try {
        onEvent(JSON.parse(message.data) as PocketEvent);
      } catch {
        // A malformed event; the next one or a refetch fixes the view.
      }
    };
    current.addEventListener("ping", () => {
      heard = Date.now();
    });
    current.onopen = () => {
      heard = Date.now();
      onOpen(opened);
      opened = true;
    };
    current.onerror = () => {
      if (closed || current.readyState !== EventSource.CLOSED) return;
      retry = setTimeout(connect, RECONNECT_MS);
    };
  };
  const watchdog = setInterval(() => {
    if (closed || source?.readyState !== EventSource.OPEN || Date.now() - heard < SILENCE_MS) return;
    source.close();
    connect();
  }, 5_000);
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    clearInterval(watchdog);
    source?.close();
  };
}

/** Keeps every query fresh from GET /api/events, and refetches what it missed while disconnected. */
export function useServerEvents(): void {
  const client = useQueryClient();
  useEffect(
    () =>
      openEvents(
        "/api/events",
        (event) => applyEvent(client, event),
        (reconnected) => {
          if (reconnected) {
            void client.invalidateQueries();
            return;
          }
          void client.invalidateQueries({ queryKey: keys.store });
          void client.invalidateQueries({ queryKey: keys.status });
        },
      ),
    [client],
  );
}

// ---------------------------------------------------------------- group chats

export function useGroups() {
  return useQuery({ queryKey: keys.groups, queryFn: async () => (await rpc(groupsListRpc, {})).groups });
}

const GROUP_PAGE = 100;

/**
 * A group chat's top-level messages, or with `thread` that thread's top message and replies: the
 * latest page, refetched whenever the group changes, and older pages added on demand.
 */
export function useGroupMessages(groupId: string, thread: number | null = null) {
  const latest = useQuery({
    queryKey: thread ? keys.groupThread(groupId, thread) : keys.groupMessages(groupId),
    queryFn: () => rpc(groupMessagesRpc, { groupId, limit: GROUP_PAGE, ...(thread ? { thread } : {}) }),
  });
  const scope = `${groupId}:${thread ?? ""}`;
  const [older, setOlder] = useState<{ scope: string; messages: GroupMessage[]; hasOlder: boolean } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const mine = older?.scope === scope ? older : null;
  const page = latest.data;
  const messages = useMemo(() => {
    const recent = page?.messages ?? [];
    const first = recent[0]?.seq ?? Infinity;
    return [...(mine?.messages.filter((message) => message.seq < first) ?? []), ...recent];
  }, [page, mine]);
  const hasOlder = mine ? mine.hasOlder : (page?.hasOlder ?? false);
  const loadOlder = useCallback(() => {
    const before = messages[0]?.seq;
    if (loadingOlder || !before) return;
    setLoadingOlder(true);
    void rpc(groupMessagesRpc, { groupId, before, limit: GROUP_PAGE, ...(thread ? { thread } : {}) })
      // Everything shown so far is kept, so newer pages that move past it leave no gap.
      .then((result) => setOlder({ scope, messages: [...result.messages, ...messages], hasOlder: result.hasOlder }))
      .catch(() => {})
      .finally(() => setLoadingOlder(false));
  }, [groupId, thread, scope, messages, loadingOlder]);
  /** Loads everything back to message `seq`, so it can be shown. */
  const reach = useCallback(
    async (seq: number) => {
      const before = messages[0]?.seq;
      if (!before || seq >= before) return;
      const result = await rpc(groupMessagesRpc, { groupId, before, limit: Math.min(500, before - seq + 10), ...(thread ? { thread } : {}) });
      setOlder({ scope, messages: [...result.messages, ...messages], hasOlder: result.hasOlder });
    },
    [groupId, thread, scope, messages],
  );
  return { messages, hasOlder, loadingOlder, loadOlder, reach, loading: latest.isPending, error: latest.error ? errorText(latest.error) : null, refetch: latest.refetch };
}

/** The bots' pending reminders in a group, refreshed with its messages. */
export function useGroupReminders(groupId: string, enabled: boolean) {
  return useQuery({ queryKey: keys.groupReminders(groupId), queryFn: async () => (await rpc(groupRemindersRpc, { groupId })).reminders, enabled });
}

/** A group's tasks (its task board), refreshed with its messages. */
export function useGroupTasks(groupId: string, enabled: boolean) {
  return useQuery({ queryKey: keys.groupTasks(groupId), queryFn: async () => (await rpc(groupTasksRpc, { groupId })).tasks, enabled });
}

/** The group's board: recent notes, newest first, refreshed with its messages. */
export function useGroupNotes(groupId: string, enabled: boolean) {
  return useQuery({ queryKey: keys.groupNotes(groupId), queryFn: async () => (await rpc(groupNotesRpc, { groupId, limit: 50 })).notes, enabled });
}

/** One board note in full, with the notes that cite it. */
export function useGroupNote(groupId: string, id: number | null) {
  return useQuery({ queryKey: keys.groupNote(groupId, id ?? 0), queryFn: async () => (await rpc(groupNoteRpc, { groupId, id: id! })), enabled: !!id });
}

// ---------------------------------------------------------------- one chat

export interface ChatState {
  entries: TimelineEntry[];
  agent: ChatSnapshot | null;
  loading: boolean;
  error: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
}

const PAGE = 60;
const EMPTY_CHAT: ChatState = { entries: [], agent: null, loading: false, error: null, hasOlder: false, loadingOlder: false };

/**
 * A chat's live timeline: the tail once, then only what's
 * new after the end cursor whenever the chat's event stream pings. Older pages
 * load on demand.
 */
export function useChatTimeline(chatId: string | null) {
  const [state, setState] = useState<ChatState>(EMPTY_CHAT);
  const actions = useRef<{ loadOlder: () => void; reach: (seq: number) => Promise<void>; refresh: () => void }>({ loadOlder: () => {}, reach: async () => {}, refresh: () => {} });

  useEffect(() => {
    if (!chatId) {
      setState(EMPTY_CHAT);
      return;
    }
    setState({ ...EMPTY_CHAT, loading: true });
    let disposed = false;
    let endCursor: TimelinePage["endCursor"] = null;
    let startCursor: TimelinePage["startCursor"] = null;
    let busy = false;
    let queued: "tail" | "after" | null = null;
    let olderBusy = false;

    const sync = async (mode: "tail" | "after"): Promise<void> => {
      if (busy) {
        if (queued !== "tail") queued = mode;
        return;
      }
      busy = true;
      try {
        let replace = mode === "tail" || endCursor === null;
        for (let pages = 0; pages < 25 && !disposed; pages++) {
          const page = replace
            ? await rpc(chatTimelineRpc, { chatId, direction: "tail", limit: PAGE })
            : await rpc(chatTimelineRpc, { chatId, direction: "after", cursor: endCursor!, limit: PAGE });
          if (disposed) return;
          if (page.error) throw new Error(page.error);
          const reset = replace || page.reset || page.staleCursor || page.gap;
          if (page.endCursor) endCursor = page.endCursor;
          if (reset) startCursor = page.startCursor;
          setState((current) => ({
            ...current,
            entries: reset ? page.entries : mergeEntries(current.entries, page.entries),
            agent: page.agent ?? current.agent,
            loading: false,
            error: null,
            hasOlder: reset ? page.hasOlder : current.hasOlder,
          }));
          if (!page.hasNewer || page.entries.length === 0) break;
          replace = false;
        }
      } catch (error) {
        if (!disposed) setState((current) => ({ ...current, loading: false, error: errorText(error) }));
      } finally {
        busy = false;
        if (queued && !disposed) {
          const next = queued;
          queued = null;
          void sync(next);
        }
      }
    };

    const loadOlder = () => {
      if (olderBusy || !startCursor || disposed) return;
      olderBusy = true;
      setState((current) => ({ ...current, loadingOlder: true }));
      void rpc(chatTimelineRpc, { chatId, direction: "before", cursor: startCursor, limit: PAGE })
        .then((page) => {
          if (disposed) return;
          if (page.error) throw new Error(page.error);
          if (page.staleCursor || page.reset) {
            setState((current) => ({ ...current, loadingOlder: false }));
            void sync("tail");
            return;
          }
          if (page.startCursor) startCursor = page.startCursor;
          setState((current) => ({ ...current, entries: mergeEntries(current.entries, page.entries), hasOlder: page.hasOlder && page.entries.length > 0, loadingOlder: false }));
        })
        .catch((error: unknown) => {
          if (!disposed) setState((current) => ({ ...current, loadingOlder: false, error: errorText(error) }));
        })
        .finally(() => {
          olderBusy = false;
        });
    };
    /** Loads older pages until the entry at `seq` is in (a search result to show). */
    const reach = async (seq: number): Promise<void> => {
      if (olderBusy) return;
      olderBusy = true;
      try {
        for (let pages = 0; pages < 100 && !disposed && startCursor && startCursor.seq > seq; pages++) {
          const page = await rpc(chatTimelineRpc, { chatId, direction: "before", cursor: startCursor, limit: 500 });
          if (disposed) return;
          if (page.error) throw new Error(page.error);
          if (page.staleCursor || page.reset) {
            void sync("tail");
            return;
          }
          if (page.startCursor) startCursor = page.startCursor;
          const more = page.hasOlder && page.entries.length > 0;
          setState((current) => ({ ...current, entries: mergeEntries(current.entries, page.entries), hasOlder: more }));
          if (!more) break;
        }
      } finally {
        olderBusy = false;
      }
    };
    actions.current = { loadOlder, reach, refresh: () => void sync(endCursor ? "after" : "tail") };

    const close = openEvents(
      `/api/chats/${chatId}/events`,
      (event) => {
        if (event.type === "timeline") void sync(event.reset ? "tail" : "after");
      },
      // Back after a gap: catch up on what was said meanwhile.
      (reconnected) => {
        if (reconnected) void sync("after");
      },
    );
    void sync("tail");
    return () => {
      disposed = true;
      close();
    };
  }, [chatId]);

  const loadOlder = useCallback(() => actions.current.loadOlder(), []);
  const reach = useCallback((seq: number) => actions.current.reach(seq), []);
  const refresh = useCallback(() => actions.current.refresh(), []);
  return { ...state, loadOlder, reach, refresh };
}
