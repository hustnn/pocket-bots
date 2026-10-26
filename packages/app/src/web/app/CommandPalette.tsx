import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BOT_LABEL, type Bot, type Team } from "../../shared/bot";
import type { ChatSnapshot } from "../../shared/chat-types";
import { displayTitle } from "../../shared/chat";
import { GROUP_LABEL, type GroupSummary } from "../../shared/group-chat";
import { searchRpc, type SearchHit } from "../../shared/rpc";
import { hasAllTerms, markTerms, searchTerms } from "../../shared/search";
import { relativeTime } from "../../shared/time";
import { Avatar, AvatarStack } from "../components/Avatar";
import { Icon, type IconName } from "../components/icons";
import { rpc } from "../lib/api";
import { useAllChats, useGroups, useStoreDoc } from "../lib/data";
import { placeKey, setPendingTerms } from "../lib/highlight";
import { navigate } from "../lib/router";

// The command palette (Cmd/Ctrl+K): jump to a bot, a team, a team's session, a chat or a
// routine by name, and find past messages in one-to-one chats and sessions; each result says
// where it is, and picking a message opens its place at that message.

/** A place to jump to by name. */
interface Jump {
  key: string;
  kind: "bot" | "team" | "group" | "chat" | "routine";
  name: string;
  /** Where it is, or what it is. */
  where: string;
  badge?: string;
  icon: ReactNode;
  at?: string;
  pick: () => void;
}

/** One line of the palette: a place or a message. */
type Entry = { kind: "jump"; jump: Jump } | { kind: "hit"; hit: SearchHit };

const KIND_LABEL: Record<Jump["kind"], string> = { bot: "Bot", team: "Team", group: "Session", chat: "Chat", routine: "Routine" };
const PER_KIND = 6;
const MESSAGE_LIMIT = 30;

function Marked({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {markTerms(text, terms).map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}
    </>
  );
}

function KindIcon({ name }: { name: IconName }) {
  return (
    <span className="palette-icon">
      <Icon name={name} size={15} />
    </span>
  );
}

/** Places whose name (or where they are) has every term; with none, the bots, teams and latest sessions and chats. */
function jumps(input: { bots: readonly Bot[]; teams: readonly Team[]; groups: readonly GroupSummary[]; chats: readonly ChatSnapshot[]; terms: readonly string[]; onOpenRoutine: (botId: string, routineId: string) => void }): Jump[] {
  const { bots, teams, groups, chats, terms } = input;
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const botBadge = (bot: Bot) => (bot.archived ? "Archived" : bot.hidden ? "Hidden" : undefined);
  const all: Jump[] = [];
  for (const bot of bots) {
    const badge = botBadge(bot);
    all.push({ key: `bot:${bot.id}`, kind: "bot", name: bot.name || "Untitled bot", where: bot.title, ...(badge ? { badge } : {}), icon: <Avatar avatar={bot.avatar} size={22} />, pick: () => navigate({ page: "bot", botId: bot.id, chatId: null }) });
  }
  const teamById = new Map(teams.map((team) => [team.id, team]));
  for (const team of teams) {
    const members = team.memberIds.flatMap((id) => byId.get(id) ?? []);
    all.push({ key: `team:${team.id}`, kind: "team", name: team.name, where: members.map((bot) => bot.name).join(", "), icon: <AvatarStack avatars={members.map((bot) => bot.avatar)} size={18} />, pick: () => navigate({ page: "team", teamId: team.id }) });
  }
  // A team's sessions; group chats made on their own, from before teams, aren't listed.
  for (const group of groups) {
    const team = group.teamId ? teamById.get(group.teamId) : undefined;
    if (!team) continue;
    const members = group.memberIds.flatMap((id) => byId.get(id) ?? []);
    all.push({ key: `group:${group.id}`, kind: "group", name: group.name, where: team.name, icon: <AvatarStack avatars={members.map((bot) => bot.avatar)} size={18} />, ...(group.last ? { at: group.last.at } : {}), pick: () => navigate({ page: "group", groupId: group.id }) });
  }
  // The chats a bot keeps on its own (a group seat's side is reached from its group), newest first.
  const own = chats.filter((chat) => chat.labels?.[BOT_LABEL] && !chat.labels?.[GROUP_LABEL] && byId.has(chat.labels[BOT_LABEL]!)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const chat of own) {
    const bot = byId.get(chat.labels[BOT_LABEL]!)!;
    all.push({ key: `chat:${chat.id}`, kind: "chat", name: displayTitle(chat.title), where: bot.name, icon: <KindIcon name="messages" />, at: chat.updatedAt, pick: () => navigate({ page: "bot", botId: bot.id, chatId: chat.id }) });
  }
  for (const bot of bots) {
    for (const routine of bot.routines) {
      all.push({ key: `routine:${routine.id}`, kind: "routine", name: routine.name, where: bot.name, ...(routine.enabled ? {} : { badge: "Paused" }), icon: <KindIcon name="calendar" />, pick: () => input.onOpenRoutine(bot.id, routine.id) });
    }
  }
  if (terms.length === 0) {
    // A start: the bots on the list, the teams, the latest sessions and the latest chats.
    return [
      ...all.filter((jump) => jump.kind === "bot" && !jump.badge).slice(0, PER_KIND),
      ...all.filter((jump) => jump.kind === "team").slice(0, PER_KIND),
      ...all.filter((jump) => jump.kind === "group").slice(0, PER_KIND),
      ...all.filter((jump) => jump.kind === "chat").slice(0, PER_KIND),
    ];
  }
  const matching = all.filter((jump) => hasAllTerms(`${jump.name} ${jump.where}`, terms));
  // Within each kind: names that start with what's typed, then names with every word, then the rest (a bot's chat, a team with that bot).
  const rank = (jump: Jump) => (jump.name.toLowerCase().startsWith(terms[0]!) ? 0 : hasAllTerms(jump.name, terms) ? 1 : 2);
  const kinds: Jump["kind"][] = ["bot", "team", "group", "chat", "routine"];
  return kinds.flatMap((kind) => matching.filter((jump) => jump.kind === kind).sort((a, b) => rank(a) - rank(b)).slice(0, PER_KIND));
}

export function CommandPalette({ onClose, onOpenRoutine }: { onClose: () => void; onOpenRoutine: (botId: string, routineId: string) => void }) {
  const doc = useStoreDoc();
  const groups = useGroups();
  const allChats = useAllChats();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const bots = useMemo(() => doc.data?.values.bots ?? [], [doc.data]);
  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const groupById = useMemo(() => new Map((groups.data ?? []).map((group) => [group.id, group])), [groups.data]);
  const terms = useMemo(() => searchTerms(query), [query]);
  const places = useMemo(
    () => jumps({ bots, teams: doc.data?.values.teams ?? [], groups: groups.data ?? [], chats: (allChats.data ?? []) as ChatSnapshot[], terms, onOpenRoutine }),
    [bots, doc.data, groups.data, allChats.data, terms, onOpenRoutine],
  );

  // Past messages, for what's typed (two characters or more), a moment after typing stops.
  useEffect(() => {
    const words = query.trim();
    if ([...words].length < 2) {
      setHits(null);
      setSearching(false);
      return;
    }
    let stale = false;
    setSearching(true);
    const timer = setTimeout(() => {
      rpc(searchRpc, { query: words.slice(0, 200), limit: MESSAGE_LIMIT })
        .then((result) => !stale && setHits(result.hits))
        .catch(() => !stale && setHits([]))
        .finally(() => !stale && setSearching(false));
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Results for chats of bots that are gone, or groups that are, don't show.
  const shownHits = useMemo(() => (hits ?? []).filter((hit) => (hit.kind === "chat" ? botById.has(hit.botId) : groupById.has(hit.groupId))), [hits, botById, groupById]);
  const entries: Entry[] = useMemo(() => [...places.map((jump) => ({ kind: "jump" as const, jump })), ...shownHits.map((hit) => ({ kind: "hit" as const, hit }))], [places, shownHits]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    if (entry.kind === "jump") return entry.jump.pick();
    const hit = entry.hit;
    setPendingTerms(placeKey(hit.kind, hit.kind === "chat" ? hit.chatId : hit.groupId, hit.seq), terms);
    if (hit.kind === "chat") navigate({ page: "bot", botId: hit.botId, chatId: hit.chatId, at: hit.seq });
    else navigate({ page: "group", groupId: hit.groupId, at: hit.seq, ...(hit.thread ? { thread: hit.thread } : {}) });
  };

  const hitRow = (hit: SearchHit, index: number) => {
    let icon: ReactNode;
    let where: ReactNode;
    let from: string;
    if (hit.kind === "chat") {
      const bot = botById.get(hit.botId)!;
      icon = <Avatar avatar={bot.avatar} size={22} />;
      where = (
        <>
          {bot.name} › {displayTitle(hit.chatTitle)}
          {hit.archived ? <span className="badge">Archived chat</span> : null}
        </>
      );
      from = hit.from === "bot" ? bot.name : "You";
    } else {
      const group = groupById.get(hit.groupId)!;
      icon = <AvatarStack avatars={group.memberIds.flatMap((id) => botById.get(id)?.avatar ?? [])} size={18} />;
      where = (
        <>
          {group.name}
          {hit.thread ? ` › thread #${hit.thread}` : ""}
        </>
      );
      from = hit.from.kind === "bot" ? (botById.get(hit.from.botId)?.name ?? hit.from.name) : "You";
    }
    const position = places.length + index;
    return (
      <div
        key={`${hit.kind}:${hit.kind === "chat" ? hit.chatId : hit.groupId}:${hit.seq}`}
        role="option"
        aria-selected={active === position}
        className={`palette-item message${active === position ? " active" : ""}`}
        onMouseMove={() => setActive(position)}
        onClick={() => pick({ kind: "hit", hit })}
      >
        {icon}
        <div className="grow">
          <div className="palette-where truncate">
            <span className="truncate">{where}</span>
            <span className="hint">{relativeTime(hit.at)}</span>
          </div>
          <div className="palette-text">
            <strong>{from}:</strong> <Marked text={hit.text} terms={terms} />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Jump to or search">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            autoFocus
            className="grow"
            placeholder="Jump to a bot, team, session, chat or routine, or search messages"
            aria-label="Jump to or search"
            role="combobox"
            aria-expanded
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (entries.length) setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length);
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                pick(entries[active]);
              }
            }}
          />
          {searching ? <span className="spinner small" /> : null}
        </div>
        <div className="palette-list" ref={list} role="listbox">
          {places.length ? <div className="palette-section">{terms.length ? "Jump to" : "Go to"}</div> : null}
          {places.map((jump, index) => (
            <div
              key={jump.key}
              role="option"
              aria-selected={active === index}
              className={`palette-item${active === index ? " active" : ""}`}
              onMouseMove={() => setActive(index)}
              onClick={() => pick({ kind: "jump", jump })}
            >
              {jump.icon}
              <span className="palette-name truncate">
                <Marked text={jump.name} terms={terms} />
              </span>
              {jump.badge ? <span className="badge">{jump.badge}</span> : null}
              <span className="hint truncate grow">{jump.where}</span>
              <span className="palette-kind">{KIND_LABEL[jump.kind]}</span>
            </div>
          ))}
          {hits !== null ? <div className="palette-section">Messages</div> : null}
          {shownHits.map(hitRow)}
          {hits !== null && shownHits.length === 0 && !searching ? <div className="palette-empty hint">No messages with {terms.length > 1 ? "all of those words" : "that"}.</div> : null}
          {places.length === 0 && hits === null ? <div className="palette-empty hint">Nothing by that name. Type two letters or more to search messages too.</div> : null}
        </div>
        <div className="palette-footer hint">
          <span>↑↓ to move · ↵ to open · Esc to close</span>
        </div>
      </div>
    </div>
  );
}
