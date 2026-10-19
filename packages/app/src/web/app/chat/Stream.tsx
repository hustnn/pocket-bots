import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatSnapshot } from "../../../shared/chat-types";
import { foldText } from "../../../shared/activity";
import { appSignIns } from "../../../shared/apps";
import type { ComposerAttachment } from "../../../shared/attachments";
import { groupDelivery } from "../../../shared/group-chat";
import { peerMessage, type PeerMessage } from "../../../shared/peers";
import { proposalIdOf } from "../../../shared/proposals";
import { parseReply } from "../../../shared/reply";
import type { BotVoice } from "../../../shared/bot";
import type { ChatCard, TimelineEntry } from "../../../shared/rpc";
import { buildToolCallPresentation, taskStatus, type PlanOutcome } from "../../../shared/tools";
import { Icon, iconFromLucide } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { CopyButton, IconButton, Modal } from "../../components/ui";
import { buildRows, layoutStream, type StreamEntry, type StreamLayoutItem, type StreamRow, type TurnFooterInfo } from "../../chat/model";
import { sentAttachments } from "../../lib/sent";
import { markTermsIn } from "../../lib/highlight";
import { canSpeak, speak, stopSpeaking, useSpeaking } from "../../lib/speech";
import { ConnectCard, PermissionCard, ProposalCard, RoutineRunCard } from "./Cards";
import { ToolDetails } from "./ToolDetails";

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** How long the running turn has taken, ticking every second. */
function Elapsed({ since }: { since: string | null | undefined }) {
  const start = since ? Date.parse(since) : NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(start)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [start]);
  return Number.isFinite(start) ? <span className="elapsed">{duration(Math.max(0, now - start))}</span> : null;
}

function Footer({ footer, voice }: { footer: TurnFooterInfo; voice: BotVoice }) {
  const speaking = useSpeaking(footer.copy);
  return (
    <div className="turn-footer">
      {footer.completedAt ? <span>{new Date(footer.completedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span> : null}
      {footer.durationMs !== null ? <span>· {duration(footer.durationMs)}</span> : null}
      <CopyButton text={footer.copy} title="Copy reply" />
      {canSpeak && footer.copy.trim() ? (
        <IconButton icon={speaking ? "stop" : "volume"} size={14} title={speaking ? "Stop reading" : "Read aloud"} onClick={() => (speaking ? stopSpeaking() : speak(footer.copy, footer.copy, voice.name))} />
      ) : null}
    </div>
  );
}

type ImageAttachment = Extract<ComposerAttachment, { kind: "image" }>;

/** A message you sent, with the attachments this page sent along and a copy button; a reply shows the bot's words it answers above it. */
const UserMessage = memo(function UserMessage({ row, onShowQuote }: { row: Extract<StreamRow, { kind: "user" }>; onShowQuote: (quote: string) => void }) {
  const [lightbox, setLightbox] = useState<ImageAttachment | null>(null);
  const attachments = sentAttachments(row);
  const reply = parseReply(row.text);
  const text = reply ? reply.body : row.text;
  return (
    <div className="msg-user">
      {reply ? (
        <button type="button" className="reply-quote" onClick={() => onShowQuote(reply.quote)} title="Show the message this replies to">
          <Icon name="reply" size={12} />
          <span className="reply-quote-text">{reply.quote}</span>
        </button>
      ) : null}
      {attachments.length ? (
        <div className="sent-attachments">
          {attachments.map((attachment) =>
            attachment.kind === "image" ? (
              <button key={attachment.id} type="button" className="sent-image" title={`Open ${attachment.name}`} onClick={() => setLightbox(attachment)}>
                <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} />
              </button>
            ) : (
              <span key={attachment.id} className="attachment" title={attachment.name}>
                <Icon name="file" size={14} />
                <span className="truncate">{attachment.name}</span>
              </span>
            ),
          )}
        </div>
      ) : null}
      <div className="msg-user-line">
        <span className="msg-actions">
          <CopyButton text={text} title="Copy message" />
        </span>
        <div className="bubble">{text}</div>
      </div>
      {lightbox ? (
        <Modal title={lightbox.name} wide onClose={() => setLightbox(null)}>
          <img className="lightbox-image" src={`data:${lightbox.mimeType};base64,${lightbox.data}`} alt={lightbox.name} />
        </Modal>
      ) : null}
    </div>
  );
});

/**
 * What a reply quotes from a bot's message: the part of it the user selected, or all of it, as
 * it reads on screen.
 */
function quoteFrom(element: HTMLElement): string {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    if (element.contains(range.startContainer) && element.contains(range.endContainer)) {
      const text = selection.toString().trim();
      if (text) return text;
    } else if (range.intersectsNode(element)) {
      const part = range.cloneRange();
      if (!element.contains(part.startContainer)) part.setStart(element, 0);
      if (!element.contains(part.endContainer)) part.setEnd(element, element.childNodes.length);
      const text = part.toString().trim();
      if (text) return text;
    }
  }
  return element.innerText.trim();
}

/** A bot's message, with Reply: answer it, or the part of it you selected. */
function AssistantMessage({ text, onReply }: { text: string; onReply: ((quote: string) => void) | null }) {
  const body = useRef<HTMLDivElement>(null);
  return (
    <div className="msg-assistant-wrap">
      <div className="msg-assistant" ref={body}>
        <Markdown text={text} />
      </div>
      {onReply ? (
        // Pressing the button mustn't clear a selection in the message: that's what it quotes.
        <span className="msg-actions" onMouseDown={(event) => event.preventDefault()}>
          <IconButton icon="reply" size={14} title="Reply (select part of the message to quote just that)" onClick={() => body.current && onReply(quoteFrom(body.current))} />
        </span>
      ) : null}
    </div>
  );
}

const PLAN_TITLES: Record<PlanOutcome, string> = { pending: "Plan", approved: "Approved plan", rejected: "Rejected plan", canceled: "Canceled plan" };

/** A plan the bot proposed: a card with the plan, folded once it was turned down. */
function PlanCard({ text, outcome }: { text: string; outcome: PlanOutcome | undefined }) {
  const [open, setOpen] = useState(outcome !== "rejected" && outcome !== "canceled");
  return (
    <div className="plan-card">
      <button type="button" className="plan-card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        <Icon name="list" size={14} />
        <span>{PLAN_TITLES[outcome ?? "pending"]}</span>
      </button>
      {open ? <Markdown text={text} /> : null}
    </div>
  );
}

const ToolRow = memo(function ToolRow({ row, cwd }: { row: Extract<StreamRow, { kind: "tool" }>; cwd: string | null }) {
  const [open, setOpen] = useState(false);
  const presentation = buildToolCallPresentation({ name: row.name, status: row.status, error: row.error, detail: row.detail, ...(row.metadata ? { metadata: row.metadata } : {}), ...(cwd ? { cwd } : {}) });
  if (presentation.isPlan && row.detail.type === "plan") return <PlanCard text={row.detail.text} outcome={presentation.planOutcome} />;
  return (
    <div>
      <div className="tool-row" onClick={() => presentation.canOpenDetails && setOpen(!open)}>
        {row.status === "running" ? <span className="spinner" /> : <Icon name={iconFromLucide(presentation.icon)} size={14} />}
        <span className="tool-name">{presentation.displayName}</span>
        {presentation.summary ? <span className="tool-summary">{presentation.summary}</span> : null}
        {row.status === "failed" ? <span className="badge danger">Failed</span> : row.status === "canceled" ? <span className="badge">Canceled</span> : null}
        {presentation.canOpenDetails ? <Icon name={open ? "chevronDown" : "chevronRight"} size={13} /> : null}
      </div>
      {open ? <ToolDetails detail={row.detail} errorText={presentation.errorText ?? null} /> : null}
    </div>
  );
});

function ThoughtRow({ row }: { row: Extract<StreamRow, { kind: "thought" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="tool-row" onClick={() => setOpen(!open)}>
        {row.loading ? <span className="spinner" /> : <Icon name="brain" size={14} />}
        <span className="tool-name">{row.loading ? "Thinking" : "Thought"}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
      </div>
      {open ? <div className="thought">{row.text}</div> : null}
    </div>
  );
}

const PEER_TITLES: Record<PeerMessage["kind"], (bot: string) => string> = {
  request: (bot) => `Message from ${bot}`,
  answer: (bot) => `Answer from ${bot}`,
  failure: (bot) => `${bot} stopped with an error`,
};

/** A one-line preview of Markdown: no heading, list or emphasis marks. */
function preview(text: string): string {
  return foldText(text.replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/gm, "").replace(/\*\*|__|`/g, ""), 160);
}

/** A message another bot's chat passed in (a request, or an answer that came back later), folded like a thought. */
function PeerRow({ peer }: { peer: PeerMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="tool-row" onClick={() => setOpen(!open)}>
        <Icon name={peer.kind === "failure" ? "alert" : "bot"} size={14} />
        <span className="tool-name">{PEER_TITLES[peer.kind](peer.bot)}</span>
        {open ? null : (
          <span className="tool-summary" style={{ fontFamily: "var(--font)", fontSize: 13 }}>
            {preview(peer.body)}
          </span>
        )}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
      </div>
      {open ? (
        <div className="peer-message">
          <Markdown text={peer.body} />
        </div>
      ) : null}
    </div>
  );
}

/** What a group chat sent this bot's seat, folded like a thought: the bot's own chat isn't the group. */
function GroupDeliveryRow({ delivery }: { delivery: { group: string; body: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="tool-row" onClick={() => setOpen(!open)}>
        <Icon name="messages" size={14} />
        <span className="tool-name">Group chat · {delivery.group}</span>
        {open ? null : (
          <span className="tool-summary" style={{ fontFamily: "var(--font)", fontSize: 13 }}>
            {preview(delivery.body)}
          </span>
        )}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
      </div>
      {open ? (
        <div className="peer-message">
          <Markdown text={delivery.body} />
        </div>
      ) : null}
    </div>
  );
}

function TodoRow({ row }: { row: Extract<StreamRow, { kind: "todo" }> }) {
  const [open, setOpen] = useState(false);
  const label =
    row.activity.type === "created" ? `Created ${row.activity.count} task${row.activity.count === 1 ? "" : "s"}` : `${row.activity.type === "added" ? "Added" : row.activity.type === "started" ? "Started" : "Completed"}: ${row.activity.task}`;
  return (
    <div>
      <div className="tool-row" onClick={() => setOpen(!open)}>
        <Icon name="listTodo" size={14} />
        <span className="tool-summary" style={{ fontFamily: "var(--font)", fontSize: 13 }}>
          {label}
        </span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
      </div>
      {open ? (
        <div className="tool-detail" style={{ padding: "6px 10px" }}>
          {row.items.map((task, index) => {
            const status = taskStatus(task);
            return (
              <div key={index} className="row small" style={{ padding: "2px 0", textDecoration: status === "completed" ? "line-through" : undefined, color: status === "in_progress" ? "var(--accent)" : undefined }}>
                <Icon name={status === "completed" ? "check" : status === "in_progress" ? "play" : "clock"} size={12} />
                {task.text}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

interface RowProps {
  item: StreamLayoutItem;
  chatId: string;
  botId: string;
  cwd: string | null;
  voice: BotVoice;
  /** Reply to a bot's message; null where the chat takes no messages. */
  onReply: ((quote: string) => void) | null;
  onShowQuote: (quote: string) => void;
}

const Row = memo(function Row({ item, chatId, botId, cwd, voice, onReply, onShowQuote }: RowProps) {
  const row = item.row;
  let body;
  switch (row.kind) {
    case "user": {
      const delivery = groupDelivery(row.text);
      const peer = delivery ? null : peerMessage(row.text);
      body = delivery ? <GroupDeliveryRow delivery={delivery} /> : peer ? <PeerRow peer={peer} /> : <UserMessage row={row} onShowQuote={onShowQuote} />;
      break;
    }
    case "assistant":
      body = <AssistantMessage text={row.text} onReply={row.phase === "complete" ? onReply : null} />;
      break;
    case "thought":
      body = <ThoughtRow row={row} />;
      break;
    case "tool": {
      const call = { name: row.name, status: row.status, detail: row.detail };
      const proposalId = proposalIdOf(call);
      const signIns = appSignIns(call);
      body = (
        <>
          <ToolRow row={row} cwd={cwd} />
          {proposalId ? <ProposalCard proposalId={proposalId} /> : null}
          {signIns.map((signIn) => (
            <ConnectCard key={signIn.url} signIn={signIn} since={row.timestamp} chatId={chatId} botId={botId} />
          ))}
        </>
      );
      break;
    }
    case "speak":
      body = (
        <div className="msg-assistant">
          <Markdown text={row.text} />
        </div>
      );
      break;
    case "todo":
      body = <TodoRow row={row} />;
      break;
    case "notification":
      body = <div className={`notice ${row.level}`}>{row.message}</div>;
      break;
    case "compaction":
      body = (
        <div className="tool-row">
          {row.status === "loading" ? <span className="spinner" /> : <Icon name="archive" size={14} />}
          <span className="tool-summary" style={{ fontFamily: "var(--font)" }}>
            {row.status === "loading"
              ? "Compacting the conversation…"
              : row.status === "failed"
                ? `Compacting the conversation failed${row.error ? `: ${row.error}` : ""}`
                : row.status === "canceled"
                  ? "Compaction stopped"
                  : "Conversation compacted"}
          </span>
        </div>
      );
      break;
    case "routine-run":
      body = <RoutineRunCard card={row.card} botId={botId} />;
      break;
  }
  return (
    <div style={{ marginBottom: item.gapBelow }} data-row={row.key}>
      {body}
      {item.footer ? <Footer footer={item.footer} voice={voice} /> : null}
    </div>
  );
});

/** Lowercase on one line, for finding a quote in the messages on screen. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Scrolls a row to the middle of the chat and flashes it. */
function showRow(element: HTMLElement): void {
  element.scrollIntoView({ block: "center" });
  element.classList.add("flash");
  setTimeout(() => element.classList.remove("flash"), 1500);
}

/** A message to show (a search result): its timeline seq; `id` tells one request from the next. */
export interface StreamFocus {
  seq: number;
  id: number;
}

export function Stream({
  chatId,
  botId,
  voice,
  agent,
  entries,
  cards,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  focus = null,
  onFocused,
  terms = [],
  onReply = null,
}: {
  chatId: string;
  botId: string;
  voice: BotVoice;
  agent: ChatSnapshot | null;
  entries: TimelineEntry[];
  cards: ChatCard[];
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  focus?: StreamFocus | null;
  /** The focused message is on screen. */
  onFocused?: (focus: StreamFocus) => void;
  /** Words to mark in the messages (find in chat). */
  terms?: readonly string[];
  onReply?: ((quote: string) => void) | null;
}) {
  const running = agent?.status === "running" || agent?.status === "initializing";
  const layout = useMemo(() => layoutStream(buildRows(entries as unknown as StreamEntry[], running, cards), running), [entries, running, cards]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Scrolled away from the end: the button back down shows. */
  const [away, setAway] = useState(false);
  const lastKey = useRef<string | null>(null);
  const permissions = agent?.pendingPermissions ?? [];
  // A reply that finishes while its chat is open is read aloud when the bot's voice says so.
  const wasRunning = useRef(running);
  const latest = layout.auxiliaryFooter?.copy ?? "";
  useEffect(() => {
    if (wasRunning.current && !running && voice.readReplies && latest) speak(latest, latest, voice.name);
    wasRunning.current = running;
  }, [running, latest, voice]);

  useLayoutEffect(() => {
    const element = scroller.current;
    const last = layout.items[layout.items.length - 1]?.row;
    // A message you just sent brings the chat back to its end, wherever you'd scrolled.
    if (last?.kind === "user" && lastKey.current !== null && last.key !== lastKey.current) pinned.current = true;
    lastKey.current = last?.key ?? null;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [layout, permissions.length]);

  // A message to show: once its row is loaded, it comes into view and stops the chat following its end.
  const shown = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!focus || shown.current === focus.id) return;
    const target = scroller.current?.querySelector<HTMLElement>(`[data-row="e${focus.seq}"]`);
    if (!target) return;
    shown.current = focus.id;
    pinned.current = false;
    setAway(true);
    showRow(target);
    onFocused?.(focus);
  }, [focus, layout, onFocused]);

  useEffect(() => {
    markTermsIn(scroller.current, terms);
  }, [terms, layout]);
  useEffect(() => () => markTermsIn(null, []), []);

  /** Shows the bot's message a reply quotes, if it's loaded. */
  const showQuote = useCallback((quote: string) => {
    const head = flat(quote.replace(/…$/, "")).slice(0, 80);
    if (!head) return;
    for (const element of scroller.current?.querySelectorAll<HTMLElement>(".msg-assistant") ?? []) {
      if (!flat(element.innerText).includes(head)) continue;
      const row = element.closest<HTMLElement>("[data-row]") ?? element;
      pinned.current = false;
      setAway(true);
      showRow(row);
      return;
    }
  }, []);

  const scrollToBottom = () => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = true;
    setAway(false);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="stream-wrap">
      <div
        className="stream"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          setAway(!pinned.current);
          if (element.scrollTop < 60 && hasOlder && !loadingOlder) onLoadOlder();
        }}
      >
        <div className="stream-inner">
          {hasOlder ? (
            <div className="row" style={{ justifyContent: "center", padding: 8 }}>
              {loadingOlder ? (
                <span className="spinner" />
              ) : (
                <button type="button" className="btn small ghost" onClick={onLoadOlder}>
                  Load earlier messages
                </button>
              )}
            </div>
          ) : null}
          {layout.items.map((item) => (
            <Row key={item.row.key} item={item} chatId={chatId} botId={botId} cwd={agent?.cwd ?? null} voice={voice} onReply={onReply} onShowQuote={showQuote} />
          ))}
          {layout.auxiliaryFooter ? <Footer footer={layout.auxiliaryFooter} voice={voice} /> : null}
          {running && permissions.length === 0 ? (
            <div className="row muted small" style={{ padding: "6px 0 12px" }}>
              <span className="spinner" /> Working… <Elapsed since={agent?.activeTurn?.startedAt} />
            </div>
          ) : null}
          {permissions.map((permission) => (
            <PermissionCard key={permission.id} chatId={chatId} permission={permission} botId={botId} cwd={agent?.cwd ?? null} />
          ))}
          {agent?.status === "error" && agent.lastError ? <div className="notice error">{agent.lastError}</div> : null}
        </div>
      </div>
      {away ? (
        <button type="button" className="scroll-bottom" title="Scroll to bottom" aria-label="Scroll to bottom" onClick={scrollToBottom}>
          <Icon name="chevronDown" size={18} />
        </button>
      ) : null}
    </div>
  );
}
