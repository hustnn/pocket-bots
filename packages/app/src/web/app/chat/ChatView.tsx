import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bot } from "../../../shared/bot";
import { displayTitle } from "../../../shared/chat";
import { GROUP_LABEL } from "../../../shared/group-chat";
import { Avatar } from "../../components/Avatar";
import { Icon } from "../../components/icons";
import { Button, IconButton, MenuButton, useFeedback } from "../../components/ui";
import { errorText } from "../../lib/api";
import { useAllChats, useChatCards, useChatTimeline, useGroups, useMarkRead } from "../../lib/data";
import { pendingTermsFor, placeKey } from "../../lib/highlight";
import { MOD, useShortcut } from "../../lib/keys";
import { navigate, replaceRoute } from "../../lib/router";
import { Composer } from "./Composer";
import { FindBar } from "./FindBar";
import { useChatMenu } from "./menu";
import { Stream, type StreamFocus } from "./Stream";

export function ChatView({ bot, chatId, at, panelOpen, onTogglePanel }: { bot: Bot; chatId: string | null; at?: number; panelOpen: boolean; onTogglePanel: () => void }) {
  const chatMenu = useChatMenu();
  const feedback = useFeedback();
  const timeline = useChatTimeline(chatId);
  const cards = useChatCards(chatId);
  const allChats = useAllChats();
  // The directory stream is usually fresher than the last timeline page's snapshot.
  const agent = useMemo(() => {
    const live = allChats.data?.find((entry) => entry.id === chatId) ?? null;
    const fetched = timeline.agent;
    if (!live) return fetched;
    if (!fetched) return live;
    return live.updatedAt >= fetched.updatedAt ? live : fetched;
  }, [allChats.data, chatId, timeline.agent]);
  useMarkRead(chatId, agent);
  const groups = useGroups();
  const seatOf = agent?.labels?.[GROUP_LABEL];
  const group = seatOf ? (groups.data?.find((entry) => entry.id === seatOf) ?? null) : null;

  // A message to show (a search result or a find match), the words to mark, find in chat, and the
  // bot's words the next message replies to; each chat starts without them.
  const [focus, setFocus] = useState<StreamFocus | null>(null);
  const [terms, setTerms] = useState<string[]>([]);
  const [finding, setFinding] = useState(0);
  const [reply, setReply] = useState<string | null>(null);
  const focusId = useRef(0);
  const show = useCallback((seq: number) => setFocus({ seq, id: ++focusId.current }), []);
  useEffect(() => {
    setFocus(null);
    setTerms([]);
    setFinding(0);
    setReply(null);
  }, [chatId]);
  // A search result in the route: show it and mark the words it was found by, then take it out of the route.
  useEffect(() => {
    if (!at || !chatId) return;
    show(at);
    const found = pendingTermsFor(placeKey("chat", chatId, at));
    fading.current = found;
    setTerms(found);
    replaceRoute({ page: "bot", botId: bot.id, chatId });
  }, [at, chatId, bot.id, show]);
  // A search result's marks fade after a while; find in chat keeps its own until it's closed.
  const fading = useRef<string[] | null>(null);
  useEffect(() => {
    const found = fading.current;
    if (!found?.length || terms !== found) return;
    const timer = setTimeout(() => setTerms((current) => (current === found ? [] : current)), 10_000);
    return () => clearTimeout(timer);
  }, [terms]);
  // Older than what's loaded: load back to it, and the stream shows it once it's in.
  const { entries, loading, hasOlder, reach } = timeline;
  useEffect(() => {
    if (!focus || loading || !hasOlder) return;
    const first = entries[0]?.seqStart;
    if (first === undefined || first <= focus.seq) return;
    reach(focus.seq).catch((error: unknown) => feedback.error(`Couldn't load that message: ${errorText(error)}`));
  }, [focus, loading, hasOlder, entries, reach, feedback]);
  useShortcut("f", chatId ? () => setFinding((open) => open + 1) : null);
  const closeFind = useCallback(() => {
    setFinding(0);
    setTerms([]);
  }, []);

  return (
    <>
      <div className="topbar">
        <IconButton icon="chevronLeft" title="Back to bots" onClick={() => navigate({ page: "home" })} />
        <Avatar avatar={bot.avatar} size={28} />
        <div className="title">
          {bot.name}
          {chatId ? <span className="subtitle"> · {displayTitle(agent?.title)}</span> : bot.title ? <span className="subtitle"> · {bot.title}</span> : null}
        </div>
        {chatId ? <IconButton icon="search" title={`Find in this chat (${MOD}F)`} onClick={() => setFinding((open) => open + 1)} /> : null}
        {chatId ? <IconButton icon="plus" title="New chat" onClick={() => navigate({ page: "bot", botId: bot.id, chatId: null })} /> : null}
        {chatId ? (
          <MenuButton title="Chat actions" entries={chatMenu({ botId: bot.id, chatId, cwd: agent?.cwd ?? null })} />
        ) : null}
        <IconButton icon="panel" title={panelOpen ? "Hide bot settings" : "Show bot settings"} onClick={onTogglePanel} />
      </div>
      {seatOf ? (
        <div className="notice row seat-banner">
          <Icon name="messages" size={14} />
          <span className="grow">
            {group ? (
              <>
                {bot.name}'s side of the group chat <strong>{group.name}</strong>. The group sees only what {bot.name} posts there; approvals happen here.
              </>
            ) : (
              <>This chat was {bot.name}'s side of a group chat that's gone or that it left.</>
            )}
          </span>
          {group ? (
            <Button small icon="messages" onClick={() => navigate({ page: "group", groupId: group.id })}>
              Open group
            </Button>
          ) : null}
        </div>
      ) : null}
      {chatId && finding ? <FindBar key={chatId} chatId={chatId} signal={finding} onShow={show} onTerms={setTerms} onClose={closeFind} /> : null}
      {chatId ? (
        timeline.loading && timeline.entries.length === 0 ? (
          <div className="splash">
            <span className="spinner" />
          </div>
        ) : (
          <Stream
            chatId={chatId}
            botId={bot.id}
            voice={bot.voice}
            agent={agent}
            entries={timeline.entries}
            cards={cards.data ?? []}
            hasOlder={timeline.hasOlder}
            loadingOlder={timeline.loadingOlder}
            onLoadOlder={timeline.loadOlder}
            focus={focus}
            terms={terms}
            onReply={bot.archived ? null : setReply}
          />
        )
      ) : (
        <div className="splash">
          <Avatar avatar={bot.avatar} size={72} />
          <h1>{bot.name}</h1>
          {bot.title ? <div className="muted">{bot.title}</div> : null}
          {bot.description ? <p className="muted" style={{ maxWidth: 520, margin: 0 }}>{bot.description}</p> : null}
          {bot.archived ? <div className="notice warning">This bot is archived. Restore it in its settings to chat.</div> : null}
        </div>
      )}
      {timeline.error ? (
        <div className="notice error row" style={{ margin: "0 20px" }}>
          <span className="grow">{timeline.error}</span>
          <Button small icon="refresh" onClick={timeline.refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {!bot.archived ? (
        <Composer
          botId={bot.id}
          chatId={chatId}
          agent={agent}
          placeholder={reply ? `Reply to ${bot.name}` : seatOf ? `Message ${bot.name} here, outside the group` : chatId ? `Message ${bot.name}` : `Start a new chat with ${bot.name}`}
          botName={bot.name}
          reply={chatId ? reply : null}
          onReplyChange={setReply}
          botFolder={bot.cwd}
          onStarted={(started) => navigate({ page: "bot", botId: bot.id, chatId: started })}
        />
      ) : null}
    </>
  );
}
