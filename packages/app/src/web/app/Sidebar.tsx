import { useMemo, useState, type MouseEvent } from "react";
import type { ChatSnapshot } from "../../shared/chat-types";
import { BOT_LABEL, type Bot, type BotListUi } from "../../shared/bot";
import { displayTitle } from "../../shared/chat";
import { GROUP_LABEL, type GroupSummary } from "../../shared/group-chat";
import { aggregateBuckets, BUCKET_LABELS, chatBucket, moveKey, orderChats, SIDEBAR_GROUP_LIMIT, type ChatBucket } from "../../shared/sidebar";
import { relativeTime } from "../../shared/time";
import { Avatar, AvatarStack } from "../components/Avatar";
import { Icon } from "../components/icons";
import { IconButton, MenuButton, useContextMenu, type MenuItems } from "../components/ui";
import { useAllChats, useCommit, useGroups, useListUi, useProviders, useStoreDoc } from "../lib/data";
import { MOD } from "../lib/keys";
import { useLocalState } from "../lib/local";
import { navigate, type Route } from "../lib/router";
import { useBotActions } from "./botActions";
import { useChatMenu } from "./chat/menu";
import { groupRowInfo } from "./group/GroupView";

function ConnectionPill() {
  const providers = useProviders();
  const entries = providers.data?.entries ?? [];
  const ready = entries.filter((entry) => entry.status === "ready");
  const state = providers.isPending ? "connecting" : ready.length ? "connected" : "disconnected";
  const label = providers.isPending ? "Checking agents…" : ready.length ? `${ready.map((entry) => entry.label).join(", ")} ready` : "No agent CLI ready";
  return (
    <span className="conn" title={entries.map((entry) => `${entry.label}: ${entry.status}${entry.error ? ` (${entry.error})` : ""}`).join("\n")}>
      <span className={`dot ${state}`} />
      {label}
    </span>
  );
}

/** A chat's dot, with pocket-bots's read state; the open chat is in front of the user, so it counts as read. */
function bucketOf(chat: ChatSnapshot, ui: BotListUi, activeChatId: string | null): ChatBucket {
  return chatBucket(chat.id === activeChatId ? { ...chat, requiresAttention: false } : chat, ui.read[chat.id]);
}

function StatusDot({ bucket }: { bucket: ChatBucket }) {
  return <span className={`dot ${bucket}`} title={BUCKET_LABELS[bucket]} aria-label={BUCKET_LABELS[bucket]} />;
}

interface RowMenus {
  /** The chat's menu: pin, move (manual order only) and the chat actions. */
  chat(bot: Bot, chat: ChatSnapshot, place: { pinned: boolean; siblings: string[] }): MenuItems;
  open(event: MouseEvent, entries: MenuItems): void;
}

function ChatRow({
  bot,
  chat,
  bucket,
  active,
  pinned,
  siblings,
  menus,
}: {
  bot: Bot;
  chat: ChatSnapshot;
  bucket: ChatBucket;
  active: boolean;
  pinned: boolean;
  siblings: string[];
  menus: RowMenus;
}) {
  const entries = () => menus.chat(bot, chat, { pinned, siblings });
  return (
    <div
      className={`chat-row${active ? " active" : ""}${pinned ? " pinned" : ""}`}
      onClick={() => navigate({ page: "bot", botId: bot.id, chatId: chat.id })}
      onContextMenu={(event) => menus.open(event, entries())}
      title={chat.title ?? ""}
    >
      {pinned ? <Avatar avatar={bot.avatar} size={18} /> : null}
      <StatusDot bucket={bucket} />
      <span className="chat-title">
        <span className="truncate">{displayTitle(chat.title)}</span>
        {pinned ? <span className="chat-bot truncate">{bot.name}</span> : null}
      </span>
      <span className="when">{relativeTime(chat.updatedAt)}</span>
      <span className="row-actions" onClick={(event) => event.stopPropagation()}>
        <MenuButton title="Chat actions" entries={entries} />
      </span>
    </div>
  );
}

function BotGroup({
  bot,
  chats,
  ui,
  route,
  pinnedIds,
  menus,
  botMenu,
  onToggle,
}: {
  bot: Bot;
  chats: ChatSnapshot[];
  ui: BotListUi;
  route: Route;
  pinnedIds: ReadonlySet<string>;
  menus: RowMenus;
  botMenu: () => MenuItems;
  onToggle: () => void;
}) {
  const [all, setAll] = useState(false);
  const expanded = !ui.collapsed.includes(bot.id);
  const selected = route.page === "bot" && route.botId === bot.id;
  const activeChatId = route.page === "bot" ? route.chatId : null;
  const listed = orderChats(
    chats.filter((chat) => !pinnedIds.has(chat.id)),
    ui.chatSort,
    ui.chatOrder[bot.id] ?? [],
  );
  const siblings = listed.map((chat) => chat.id);
  // A chat that's open stays in view even past the limit.
  const shown = all ? listed : listed.filter((chat, index) => index < SIDEBAR_GROUP_LIMIT || chat.id === activeChatId);
  const bucket = chats.length ? aggregateBuckets(chats.map((chat) => bucketOf(chat, ui, activeChatId))) : "done";
  return (
    <div>
      <div className={`bot-row${selected ? " active" : ""}`} onClick={() => navigate({ page: "bot", botId: bot.id, chatId: null })} onContextMenu={(event) => menus.open(event, botMenu())}>
        <button
          type="button"
          className="chevron"
          aria-label={expanded ? `Collapse ${bot.name}` : `Expand ${bot.name}`}
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={13} />
        </button>
        <Avatar avatar={bot.avatar} size={28} />
        <div className="meta">
          <div className="name truncate">
            {bot.name || "Untitled bot"}
            {bot.pinned ? (
              <span className="muted" title="Pinned" style={{ marginLeft: 5, verticalAlign: "-1px" }}>
                <Icon name="pin" size={11} />
              </span>
            ) : null}
            {bot.archived ? <span className="badge" style={{ marginLeft: 6 }}>Archived</span> : null}
          </div>
          {bot.title ? <div className="role truncate">{bot.title}</div> : null}
        </div>
        <span className="row-actions" onClick={(event) => event.stopPropagation()}>
          <IconButton icon="plus" size={14} title={`New chat with ${bot.name}`} onClick={() => navigate({ page: "bot", botId: bot.id, chatId: null })} />
          <MenuButton title="Bot actions" entries={botMenu} />
        </span>
        <span className={`dot ${bucket}`} title={BUCKET_LABELS[bucket]} />
      </div>
      {expanded ? (
        <div className="bot-chats">
          {selected ? (
            <div className={`chat-row${activeChatId === null ? " active" : ""}`} onClick={() => navigate({ page: "bot", botId: bot.id, chatId: null })}>
              <Icon name="plus" size={13} />
              <span className="truncate">New chat</span>
            </div>
          ) : null}
          {shown.map((chat) => (
            <ChatRow key={chat.id} bot={bot} chat={chat} bucket={bucketOf(chat, ui, activeChatId)} active={chat.id === activeChatId} pinned={false} siblings={siblings} menus={menus} />
          ))}
          {listed.length > SIDEBAR_GROUP_LIMIT ? (
            <div className="chat-row more" onClick={() => setAll(!all)}>
              <span className="truncate">{all ? "Show less" : `Show all ${listed.length}`}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function GroupRow({ group, info, active }: { group: GroupSummary; info: ReturnType<typeof groupRowInfo>; active: boolean }) {
  // The bot list's dots: a seat waiting for approval needs input, one working is running, news from the bots is ready to review.
  const dot: ChatBucket = info.approval ? "needs_input" : info.working ? "running" : group.unread && !active ? "attention" : "done";
  return (
    <div className={`bot-row group-row${active ? " active" : ""}`} onClick={() => navigate({ page: "group", groupId: group.id })} title={group.name}>
      <AvatarStack avatars={info.members.map((bot) => bot.avatar)} size={22} />
      <div className="meta">
        <div className="name truncate">{group.name}</div>
        <div className="role truncate">{info.last}</div>
      </div>
      <span className="when">{info.when}</span>
      <span className={`dot ${dot}`} title={BUCKET_LABELS[dot]} />
    </div>
  );
}

export function Sidebar({ route, onSearch, onNewBot, onNewGroup, onOpenSettings }: { route: Route; onSearch: () => void; onNewBot: () => void; onNewGroup: () => void; onOpenSettings: (botId: string) => void }) {
  const doc = useStoreDoc();
  const commit = useCommit();
  const allChats = useAllChats();
  const [ui, updateUi] = useListUi();
  const groups = useGroups();
  const [groupsCollapsed, setGroupsCollapsed] = useLocalState("pocket.groupsCollapsed", false);
  const [showArchived, setShowArchived] = useLocalState("pocket.showArchived", false);
  const [hiddenOpen, setHiddenOpen] = useLocalState("pocket.hiddenBotsOpen", false);
  const botActions = useBotActions();
  const chatMenu = useChatMenu();
  const context = useContextMenu();
  const values = doc.data?.values;
  const allBots = values?.bots ?? [];
  const archivedCount = allBots.filter((bot) => bot.archived).length;
  // Pinned bots first. Hidden bots (Hide from sidebar) keep working and wait in their own section at the bottom.
  const bots = useMemo(() => allBots.filter((bot) => !bot.hidden && (showArchived || !bot.archived)).sort((a, b) => Number(b.pinned) - Number(a.pinned)), [allBots, showArchived]);
  const hiddenBots = useMemo(() => allBots.filter((bot) => bot.hidden && (showArchived || !bot.archived)), [allBots, showArchived]);
  const botById = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);

  // A bot's side of a group chat is reached from the group, so its chat list leaves it out.
  const chatsByBot = useMemo(() => {
    const byBot = new Map<string, ChatSnapshot[]>();
    for (const chat of (allChats.data ?? []) as ChatSnapshot[]) {
      const botId = chat.labels?.[BOT_LABEL];
      if (botId && !chat.labels?.[GROUP_LABEL]) byBot.set(botId, [...(byBot.get(botId) ?? []), chat]);
    }
    return byBot;
  }, [allChats.data]);
  const chatById = useMemo(() => new Map(((allChats.data ?? []) as ChatSnapshot[]).map((chat) => [chat.id, chat])), [allChats.data]);
  const listedIds = new Set([...bots, ...hiddenBots].map((bot) => bot.id));
  // Pins of chats that are gone (archived) or whose bot isn't bots here don't show.
  const pins = ui.pinnedChats.filter((pin) => listedIds.has(pin.botId) && chatById.has(pin.chatId));
  const pinnedIds = new Set(ui.pinnedChats.map((pin) => pin.chatId));
  const activeChatId = route.page === "bot" ? route.chatId : null;

  /** Swaps a bot with its neighbour as the list shows it; pinned and unpinned bots keep their own runs. */
  const moveBot = (bot: Bot, delta: -1 | 1): (() => void) | undefined => {
    const index = bots.findIndex((entry) => entry.id === bot.id);
    const neighbour = bots[index + delta];
    if (index === -1 || !neighbour) return undefined;
    const swap = (ids: readonly string[]) => ids.map((id) => (id === bot.id ? neighbour.id : id === neighbour.id ? bot.id : id));
    if (neighbour.pinned !== bot.pinned) return undefined;
    return () =>
      void commit((current) => {
        const order = swap(current.bots.map((entry) => entry.id));
        return { ...current, bots: order.map((id) => current.bots.find((entry) => entry.id === id)!) };
      });
  };

  const unpin = (chatId: string) => (current: BotListUi) => ({ ...current, pinnedChats: current.pinnedChats.filter((pin) => pin.chatId !== chatId) });

  const menus: RowMenus = {
    chat: (bot, chat, place) => {
      const move = (delta: -1 | 1) => {
        const order = moveKey(place.siblings, chat.id, delta);
        return order ? () => updateUi((current) => ({ ...current, chatOrder: { ...current.chatOrder, [bot.id]: order } })) : undefined;
      };
      const up = move(-1);
      const down = move(1);
      const extra: MenuItems = [
        {
          label: place.pinned ? "Unpin" : "Pin to top",
          icon: place.pinned ? "pinOff" : "pin",
          onSelect: () => updateUi((current) => (place.pinned ? unpin(chat.id)(current) : { ...current, pinnedChats: [...current.pinnedChats, { botId: bot.id, chatId: chat.id }] })),
        },
        ...(place.pinned || ui.chatSort !== "manual"
          ? []
          : [
              { label: "Move up", icon: "arrowUp" as const, disabled: !up, onSelect: () => up?.() },
              { label: "Move down", icon: "arrowDown" as const, disabled: !down, onSelect: () => down?.() },
            ]),
      ];
      return chatMenu({ botId: bot.id, chatId: chat.id, cwd: chat.cwd ?? null, onArchived: () => updateUi(unpin(chat.id)) }, extra);
    },
    open: context.open,
  };

  const displayMenu: MenuItems = [
    {
      label: "Archived bots",
      icon: "archive",
      trailing: showArchived ? "Shown" : archivedCount ? `Hidden (${archivedCount})` : "Hidden",
      onSelect: () => setShowArchived(!showArchived),
    },
    {
      label: "Chat order",
      icon: "list",
      trailing: ui.chatSort === "manual" ? "Manual" : "Last activity",
      onSelect: () => updateUi((current) => ({ ...current, chatSort: current.chatSort === "manual" ? "activity" : "manual" })),
    },
  ];

  return (
    <aside className="sidebar">
      <div className="brand">
        <Icon name="bot" size={20} />
        <span className="name" onClick={() => navigate({ page: "home" })} style={{ cursor: "pointer" }}>
          Pocket Bots
        </span>
        <MenuButton icon="menu" title="Display preferences" entries={displayMenu} />
        <IconButton icon="plus" title="New bot" onClick={onNewBot} />
      </div>
      <div style={{ padding: "0 14px 10px" }}>
        <ConnectionPill />
      </div>
      <button type="button" className="sidebar-search" onClick={onSearch} title={`Jump to a bot, group, chat or routine, or search messages (${MOD}K)`}>
        <Icon name="search" size={14} />
        <span className="grow">Search</span>
        <kbd>{MOD}K</kbd>
      </button>
      <div className="scroll" style={{ flex: 1, padding: "0 6px 8px" }}>
        <div className="pinned-section">
          <div className="section-label row" role="button" aria-expanded={!groupsCollapsed} onClick={() => setGroupsCollapsed(!groupsCollapsed)}>
            <Icon name={groupsCollapsed ? "chevronRight" : "chevronDown"} size={12} />
            <span className="grow">Group chats</span>
            <span onClick={(event) => event.stopPropagation()}>
              <IconButton icon="plus" size={13} title="New group chat" onClick={onNewGroup} />
            </span>
          </div>
          {groupsCollapsed
            ? null
            : (groups.data ?? []).map((group) => (
                <GroupRow key={group.id} group={group} info={groupRowInfo(group, botById, chatById)} active={route.page === "group" && route.groupId === group.id} />
              ))}
          {!groupsCollapsed && groups.data && groups.data.length === 0 ? (
            <div className="chat-row more" onClick={onNewGroup}>
              <Icon name="plus" size={13} />
              <span className="truncate">New group chat</span>
            </div>
          ) : null}
        </div>
        {pins.length ? (
          <div className="pinned-section">
            <div className="section-label" onClick={() => updateUi((current) => ({ ...current, pinnedCollapsed: !current.pinnedCollapsed }))} role="button" aria-expanded={!ui.pinnedCollapsed}>
              <Icon name={ui.pinnedCollapsed ? "chevronRight" : "chevronDown"} size={12} />
              Pinned
            </div>
            {ui.pinnedCollapsed
              ? null
              : pins.map((pin) => {
                  const bot = botById.get(pin.botId)!;
                  const chat = chatById.get(pin.chatId)!;
                  return <ChatRow key={pin.chatId} bot={bot} chat={chat} bucket={bucketOf(chat, ui, activeChatId)} active={pin.chatId === activeChatId} pinned siblings={[]} menus={menus} />;
                })}
          </div>
        ) : null}
        {doc.isPending ? (
          <div className="empty">
            <span className="spinner" />
          </div>
        ) : bots.length === 0 && hiddenBots.length ? (
          <div className="empty small">
            All your bots are hidden.
            <br />
            <button type="button" className="btn small" style={{ marginTop: 10 }} onClick={() => setHiddenOpen(true)}>
              <Icon name="eye" size={13} /> Show hidden bots
            </button>
          </div>
        ) : bots.length === 0 ? (
          <div className="empty small">
            {allBots.length && !bots.length ? "All bots are archived." : "No bots yet."}
            <br />
            <button type="button" className="btn small" style={{ marginTop: 10 }} onClick={allBots.length && !bots.length ? () => setShowArchived(true) : onNewBot}>
              <Icon name={allBots.length && !bots.length ? "archive" : "plus"} size={13} /> {allBots.length && !bots.length ? "Show archived" : "New bot"}
            </button>
          </div>
        ) : (
          bots.map((bot) => (
            <BotGroup
              key={bot.id}
              bot={bot}
              chats={chatsByBot.get(bot.id) ?? []}
              ui={ui}
              route={route}
              pinnedIds={pinnedIds}
              menus={menus}
              botMenu={() => botActions.menu(bot, { openSettings: () => onOpenSettings(bot.id), move: { up: moveBot(bot, -1), down: moveBot(bot, 1) } })}
              onToggle={() =>
                updateUi((current) => ({ ...current, collapsed: current.collapsed.includes(bot.id) ? current.collapsed.filter((id) => id !== bot.id) : [...current.collapsed, bot.id] }))
              }
            />
          ))
        )}
        {hiddenBots.length ? (
          <div className="hidden-bots">
            <div className="section-label row" role="button" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen(!hiddenOpen)} title="Bots taken off the list. They keep running their routines and taking chats.">
              <Icon name={hiddenOpen ? "chevronDown" : "chevronRight"} size={12} />
              <span className="grow">Hidden bots</span>
              <span className="count">{hiddenBots.length}</span>
            </div>
            {hiddenOpen
              ? hiddenBots.map((bot) => (
                  <BotGroup
                    key={bot.id}
                    bot={bot}
                    chats={chatsByBot.get(bot.id) ?? []}
                    ui={ui}
                    route={route}
                    pinnedIds={pinnedIds}
                    menus={menus}
                    botMenu={() => botActions.menu(bot, { openSettings: () => onOpenSettings(bot.id) })}
                    onToggle={() =>
                      updateUi((current) => ({ ...current, collapsed: current.collapsed.includes(bot.id) ? current.collapsed.filter((id) => id !== bot.id) : [...current.collapsed, bot.id] }))
                    }
                  />
                ))
              : null}
          </div>
        ) : null}
      </div>
      <div className="sidebar-footer">
        <button type="button" className="btn ghost" onClick={() => navigate({ page: "library", tab: "skills" })}>
          <Icon name="library" size={14} /> Skills & Tools
        </button>
        <IconButton icon="settings" title="Settings" onClick={() => navigate({ page: "settings" })} />
      </div>
      {context.menu}
    </aside>
  );
}
