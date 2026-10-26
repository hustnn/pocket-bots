import { useMemo, useState, type MouseEvent } from "react";
import type { ChatSnapshot } from "../../shared/chat-types";
import { BOT_LABEL, type Bot, type BotListUi, type Team } from "../../shared/bot";
import { displayTitle } from "../../shared/chat";
import { GROUP_LABEL, type GroupSummary } from "../../shared/group-chat";
import { aggregateBuckets, BUCKET_LABELS, chatBucket, moveKey, orderChats, SIDEBAR_GROUP_LIMIT, type ChatBucket } from "../../shared/sidebar";
import { relativeTime } from "../../shared/time";
import { Avatar, AvatarStack } from "../components/Avatar";
import { Icon } from "../components/icons";
import { groupDeleteRpc, groupUpdateRpc } from "../../shared/rpc";
import { IconButton, MenuButton, useContextMenu, useFeedback, type MenuItems } from "../components/ui";
import { errorText, rpc } from "../lib/api";
import { useAllChats, useCommit, useGroups, useListUi, useProviders, useStoreDoc } from "../lib/data";
import { MOD } from "../lib/keys";
import { useLocalState } from "../lib/local";
import { navigate, type Route } from "../lib/router";
import { useBotActions } from "./botActions";
import { useChatMenu } from "./chat/menu";
import { groupRowInfo } from "./group/GroupView";
import { TeamDialog } from "./team/TeamDialogs";
import { useDeleteTeam } from "./team/TeamView";

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

/** A session's dot: a seat waiting for approval needs input, one working is running, news from the bots is ready to review. */
function sessionBucket(group: GroupSummary, info: ReturnType<typeof groupRowInfo>, active: boolean): ChatBucket {
  return info.approval ? "needs_input" : info.working ? "running" : group.unread && !active ? "attention" : "done";
}

/** Rename and delete, for a session's row. */
function useSessionMenu() {
  const feedback = useFeedback();
  return (group: GroupSummary, active: boolean, team: Team): MenuItems => [
    {
      label: "Rename",
      icon: "edit",
      onSelect: () =>
        void (async () => {
          const name = await feedback.prompt({ title: "Rename session", label: "Name", value: group.name, action: "Rename" });
          if (name === null || !name.trim() || name.trim() === group.name) return;
          await rpc(groupUpdateRpc, { groupId: group.id, name: name.trim() }).catch((failure: unknown) => feedback.error(errorText(failure)));
        })(),
    },
    "divider",
    {
      label: "Delete session",
      icon: "trash",
      danger: true,
      onSelect: () =>
        void (async () => {
          const yes = await feedback.confirm({ title: `Delete ${group.name}?`, body: "Its messages go. Each bot's side of the session is archived and stays in that bot's chat history.", action: "Delete", danger: true });
          if (!yes) return;
          try {
            await rpc(groupDeleteRpc, { groupId: group.id });
            if (active) navigate({ page: "team", teamId: team.id });
          } catch (failure) {
            feedback.error(errorText(failure));
          }
        })(),
    },
  ];
}

/** A team in the list, like a bot with its chats: the team's row, then its sessions, newest activity first. */
function TeamGroup({
  team,
  sessions,
  botById,
  chatById,
  route,
  expanded,
  onToggle,
  onEdit,
  onOpenMenu,
}: {
  team: Team;
  sessions: readonly GroupSummary[];
  botById: ReadonlyMap<string, Bot>;
  chatById: ReadonlyMap<string, ChatSnapshot>;
  route: Route;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onOpenMenu: (event: MouseEvent, entries: MenuItems) => void;
}) {
  const [all, setAll] = useState(false);
  const deleteTeam = useDeleteTeam();
  const sessionMenu = useSessionMenu();
  const selected = route.page === "team" && route.teamId === team.id;
  const activeId = route.page === "group" ? route.groupId : null;
  const members = team.memberIds.flatMap((id) => botById.get(id) ?? []);
  const leader = botById.get(team.leaderId);
  const rows = sessions.map((group) => ({ group, info: groupRowInfo(group, botById, chatById) }));
  // An open session stays in view even past the limit.
  const shown = all ? rows : rows.filter((row, index) => index < SIDEBAR_GROUP_LIMIT || row.group.id === activeId);
  const bucket = rows.length ? aggregateBuckets(rows.map((row) => sessionBucket(row.group, row.info, row.group.id === activeId))) : "done";
  const teamMenu = (): MenuItems => [
    { label: "New session", icon: "plus", onSelect: () => navigate({ page: "team", teamId: team.id }) },
    { label: "Team settings", icon: "settings", onSelect: onEdit },
    "divider",
    { label: "Delete team", icon: "trash", danger: true, onSelect: () => void deleteTeam(team).then((gone) => gone && (selected || rows.some((row) => row.group.id === activeId)) && navigate({ page: "home" })) },
  ];
  return (
    <div>
      <div className={`bot-row${selected ? " active" : ""}`} onClick={() => navigate({ page: "team", teamId: team.id })} onContextMenu={(event) => onOpenMenu(event, teamMenu())} title={team.name}>
        <button
          type="button"
          className="chevron"
          aria-label={expanded ? `Collapse ${team.name}` : `Expand ${team.name}`}
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={13} />
        </button>
        <AvatarStack avatars={members.map((bot) => bot.avatar)} size={22} />
        <div className="meta">
          <div className="name truncate">{team.name}</div>
          <div className="role truncate">{leader ? `Led by ${leader.name}` : "No leader"}</div>
        </div>
        <span className="row-actions" onClick={(event) => event.stopPropagation()}>
          <IconButton icon="plus" size={14} title={`New session of ${team.name}`} onClick={() => navigate({ page: "team", teamId: team.id })} />
          <MenuButton title="Team actions" entries={teamMenu} />
        </span>
        <span className={`dot ${bucket}`} title={BUCKET_LABELS[bucket]} />
      </div>
      {expanded ? (
        <div className="bot-chats">
          {selected ? (
            <div className="chat-row active" onClick={() => navigate({ page: "team", teamId: team.id })}>
              <Icon name="plus" size={13} />
              <span className="truncate">New session</span>
            </div>
          ) : null}
          {shown.map(({ group, info }) => {
            const active = group.id === activeId;
            const entries = () => sessionMenu(group, active, team);
            return (
              <div key={group.id} className={`chat-row${active ? " active" : ""}`} onClick={() => navigate({ page: "group", groupId: group.id })} onContextMenu={(event) => onOpenMenu(event, entries())} title={`${group.name}\n${info.last}`}>
                <StatusDot bucket={sessionBucket(group, info, active)} />
                <span className="chat-title">
                  <span className="truncate">{group.name}</span>
                </span>
                <span className="when">{info.when}</span>
                <span className="row-actions" onClick={(event) => event.stopPropagation()}>
                  <MenuButton title="Session actions" entries={entries} />
                </span>
              </div>
            );
          })}
          {rows.length > SIDEBAR_GROUP_LIMIT ? (
            <div className="chat-row more" onClick={() => setAll(!all)}>
              <span className="truncate">{all ? "Show less" : `Show all ${rows.length}`}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Sidebar({ route, onSearch, onNewBot, onNewTeam, onOpenSettings }: { route: Route; onSearch: () => void; onNewBot: () => void; onNewTeam: () => void; onOpenSettings: (botId: string) => void }) {
  const doc = useStoreDoc();
  const commit = useCommit();
  const allChats = useAllChats();
  const [ui, updateUi] = useListUi();
  const groups = useGroups();
  const [teamsCollapsed, setTeamsCollapsed] = useLocalState("pocket.teamsCollapsed", false);
  const [collapsedTeams, setCollapsedTeams] = useLocalState<string[]>("pocket.collapsedTeams", []);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
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
  // Teams and their sessions; group chats made on their own, from before teams, aren't listed.
  const teams = values?.teams ?? [];
  const sessionsByTeam = useMemo(() => {
    const byTeam = new Map<string, GroupSummary[]>();
    for (const group of groups.data ?? []) if (group.teamId) byTeam.set(group.teamId, [...(byTeam.get(group.teamId) ?? []), group]);
    return byTeam;
  }, [groups.data]);
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
      <button type="button" className="sidebar-search" onClick={onSearch} title={`Jump to a bot, team, session, chat or routine, or search messages (${MOD}K)`}>
        <Icon name="search" size={14} />
        <span className="grow">Search</span>
        <kbd>{MOD}K</kbd>
      </button>
      <div className="scroll" style={{ flex: 1, padding: "0 6px 8px" }}>
        <div className="pinned-section">
          <div className="section-label row" role="button" aria-expanded={!teamsCollapsed} onClick={() => setTeamsCollapsed(!teamsCollapsed)}>
            <Icon name={teamsCollapsed ? "chevronRight" : "chevronDown"} size={12} />
            <span className="grow">Teams</span>
            <span onClick={(event) => event.stopPropagation()}>
              <IconButton icon="plus" size={13} title="New team" onClick={onNewTeam} />
            </span>
          </div>
          {teamsCollapsed
            ? null
            : teams.map((team) => (
                <TeamGroup
                  key={team.id}
                  team={team}
                  sessions={sessionsByTeam.get(team.id) ?? []}
                  botById={botById}
                  chatById={chatById}
                  route={route}
                  expanded={!collapsedTeams.includes(team.id)}
                  onToggle={() => setCollapsedTeams(collapsedTeams.includes(team.id) ? collapsedTeams.filter((id) => id !== team.id) : [...collapsedTeams, team.id])}
                  onEdit={() => setEditingTeam(team)}
                  onOpenMenu={context.open}
                />
              ))}
          {!teamsCollapsed && doc.data && teams.length === 0 ? (
            <div className="chat-row more" onClick={onNewTeam}>
              <Icon name="plus" size={13} />
              <span className="truncate">New team</span>
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
      {editingTeam ? <TeamDialog team={editingTeam} onClose={() => setEditingTeam(null)} /> : null}
    </aside>
  );
}
