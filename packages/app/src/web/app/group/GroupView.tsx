import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatSnapshot } from "../../../shared/chat-types";
import type { Bot } from "../../../shared/bot";
import { GROUP_MIN_BOTS, GROUP_USER_ID, groupQuestion, messagePreview, pieceOf, type GroupAttachment, type GroupMessage, type GroupQuestion, type GroupSummary, type Member, type TaskStatus } from "../../../shared/group-chat";
import { groupAnswerRpc, groupDeleteRpc, groupReactRpc, groupReadRpc, groupSearchRpc, groupTaskRpc, groupUpdateRpc } from "../../../shared/rpc";
import { relativeTime } from "../../../shared/time";
import { parseQuestionFormQuestions } from "../../chat/question";
import { mentionRuns } from "../../chat/mentions";
import { Avatar, AvatarStack } from "../../components/Avatar";
import { Icon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Button, CopyButton, IconButton, Menu, MenuButton, Modal, useFeedback, type MenuItems } from "../../components/ui";
import { errorText, rpc } from "../../lib/api";
import { useAllChats, useGroupMessages, useGroupReminders, useGroups, useGroupTasks, useStoreDoc } from "../../lib/data";
import { markTermsIn, pendingTermsFor, placeKey } from "../../lib/highlight";
import { MOD, useShortcut } from "../../lib/keys";
import { navigate, replaceRoute } from "../../lib/router";
import { QuestionForm } from "../chat/Cards";
import { ExtraFolders, folderName, PATH_ACCESS_NOTE, useReachesFoldersByPath } from "../folders";
import { GroupComposer, senderName } from "./GroupComposer";

function timeOf(at: string): string {
  const date = new Date(at);
  const today = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === today.toDateString() ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function Attachments({ groupId, files }: { groupId: string; files: readonly GroupAttachment[] }) {
  const [open, setOpen] = useState<GroupAttachment | null>(null);
  if (files.length === 0) return null;
  const url = (file: GroupAttachment) => `/api/groups/${encodeURIComponent(groupId)}/files/${encodeURIComponent(fileName(file.path))}`;
  return (
    <div className="sent-attachments">
      {files.map((file) =>
        file.kind === "image" && file.path.includes(`/groups/${groupId}/`) ? (
          <button key={file.path} type="button" className="sent-image" title={`Open ${file.name}`} onClick={() => setOpen(file)}>
            <img src={url(file)} alt={file.name} />
          </button>
        ) : (
          <span key={file.path} className="attachment" title={file.path}>
            <Icon name="file" size={14} />
            <span className="truncate">{file.name}</span>
          </span>
        ),
      )}
      {open ? (
        <Modal title={open.name} wide onClose={() => setOpen(null)}>
          <img className="lightbox-image" src={url(open)} alt={open.name} />
        </Modal>
      ) : null}
    </div>
  );
}

const QUESTION_SETTLED: Record<Exclude<GroupQuestion["status"], "pending">, string> = {
  answered: "Answered",
  dismissed: "Dismissed",
  closed: "Not answered",
};

/**
 * A bot's question to the user: the form while the bot waits, and the answer goes back
 * to the bot that asked; then what was answered.
 */
function QuestionCard({ groupId, message }: { groupId: string; message: GroupMessage }) {
  const feedback = useFeedback();
  const [busy, setBusy] = useState(false);
  const question = message.question!;
  if (question.status === "pending") {
    const respond = (response: Parameters<typeof rpc<typeof groupAnswerRpc>>[1]["response"]) => {
      setBusy(true);
      rpc(groupAnswerRpc, { groupId, seq: message.seq, response })
        .catch((error: unknown) => feedback.error(`Couldn't answer: ${errorText(error)}`))
        .finally(() => setBusy(false));
    };
    return (
      <div className="group-question">
        <QuestionForm input={question.input} busy={busy} onRespond={respond} />
      </div>
    );
  }
  const questions = parseQuestionFormQuestions(question.input) ?? [];
  return (
    <div className="group-question">
      <div className="chat-card">
        <div className="head">
          <Icon name="info" size={15} />
          <span className="truncate" style={{ flex: 1 }}>
            {questions.length === 1 ? questions[0]!.header : "Questions"}
          </span>
          <span className={`badge${question.status === "answered" ? " success" : ""}`} title={question.status === "closed" ? "The bot stopped waiting before it was answered" : undefined}>
            {QUESTION_SETTLED[question.status]}
          </span>
        </div>
        <div className="body stack">
          {questions.map((entry, index) => (
            <div key={index} className="stack" style={{ gap: 2 }}>
              <span className="hint">{entry.question}</span>
              {question.status === "answered" ? <strong>{question.answers?.[index] ?? "No answer"}</strong> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Plain text with the group's @mentions picked out, for the user's own messages. */
function MentionText({ text, members }: { text: string; members: readonly Member[] }) {
  return (
    <>
      {mentionRuns(text, members).map((run, index) =>
        run.mention ? (
          <span key={index} className="mention">
            {run.text}
          </span>
        ) : (
          run.text
        ),
      )}
    </>
  );
}

function Quote({ message, onJump }: { message: GroupMessage | null; onJump: (seq: number) => void }) {
  if (!message) return null;
  return (
    <button type="button" className="group-quote" onClick={() => onJump(message.seq)} title="Show that message">
      <Icon name="reply" size={12} />
      <strong>{senderName(message)}</strong>
      <span className="truncate">{messagePreview(message, 100)}</span>
    </button>
  );
}

/** A task action of the user's: claim or convert a message, set a status, unclaim, assign, remove. */
interface TaskInput {
  action: "claim" | "convert" | "unclaim" | "status" | "assign" | "delete";
  seq?: number;
  number?: number;
  status?: TaskStatus;
  /** A bot's id, "user", or null for nobody. */
  assignee?: string | null;
}

type Seats = GroupSummary["seats"];
const NO_SEATS: Seats = [];

/**
 * The seat chat a bot wrote a message from: the led seat it names, else its seat for the message's
 * conversation, else its one seat, else its latest.
 */
function seatChat(seats: Seats, botId: string, message: GroupMessage): string | null {
  const own = seats.filter((seat) => seat.botId === botId);
  const piece = message.fromPiece ?? pieceOf(message);
  return (own.find((seat) => seat.piece === piece) ?? own.find((seat) => seat.piece === 0) ?? own.at(-1))?.chatId ?? null;
}

interface RowProps {
  groupId: string;
  message: GroupMessage;
  quoted: GroupMessage | null;
  bots: ReadonlyMap<string, Bot>;
  members: readonly Member[];
  seats: Seats;
  onReply: (message: GroupMessage) => void;
  onJump: (seq: number) => void;
  onTask: (input: TaskInput) => void;
  onReact: (seq: number, emoji: string) => void;
  /** Opens a top-level message's thread; absent inside a thread, where threads don't nest. */
  onThread?: (seq: number) => void;
  /** The row's element id is this plus its number (the thread panel shows its top message again). */
  idPrefix?: string;
}

const REACTIONS = [
  { emoji: "👍", label: "Sounds good" },
  { emoji: "✅", label: "Done" },
  { emoji: "👀", label: "Looking" },
  { emoji: "❤️", label: "Thanks" },
  { emoji: "🎉", label: "Nice" },
];

/** The task statuses in lifecycle order, as the UI names them, and their badge colors. */
const TASK_STATUSES: { status: TaskStatus; label: string; badge: string }[] = [
  { status: "todo", label: "To do", badge: "" },
  { status: "in_progress", label: "In progress", badge: "accent" },
  { status: "done", label: "Done", badge: "success" },
  { status: "closed", label: "Closed", badge: "" },
];
const statusOf = (status: TaskStatus) => TASK_STATUSES.find((entry) => entry.status === status)!;

function assigneeName(task: NonNullable<GroupMessage["task"]>): string {
  return !task.assignee ? "unassigned" : task.assignee.id === GROUP_USER_ID ? "You" : task.assignee.name;
}

/**
 * A message's task menu. Not a task yet: claim it (you're doing it), make it a task, or assign
 * it. A task: any status (you own the group), unclaim, assign, or remove the task.
 */
function taskEntries(message: GroupMessage, onTask: RowProps["onTask"], members: readonly Member[]): MenuItems {
  const task = message.task;
  const assignTo = (except?: string): MenuItems =>
    members
      .filter((member) => member.id !== except)
      .map((member) => ({ label: `Assign to ${member.name}`, icon: "bot" as const, onSelect: () => onTask(task ? { action: "assign", number: task.number, assignee: member.id } : { action: "assign", seq: message.seq, assignee: member.id }) }));
  if (!task) {
    return [
      { label: "Claim: I'm doing it", icon: "flag", onSelect: () => onTask({ action: "claim", seq: message.seq }) },
      { label: "Make it a task", icon: "listTodo", onSelect: () => onTask({ action: "convert", seq: message.seq }) },
      "divider",
      ...assignTo(),
    ];
  }
  return [
    ...TASK_STATUSES.map((entry) => ({
      label: entry.label,
      icon: entry.status === "done" ? ("checks" as const) : entry.status === "closed" ? ("x" as const) : ("check" as const),
      trailing: entry.status === task.status ? "now" : undefined,
      // Unassigned work starts with a claim, so it can't just be set in progress.
      disabled: entry.status === task.status || (entry.status === "in_progress" && !task.assignee),
      onSelect: () => onTask({ action: "status", number: task.number, status: entry.status }),
    })),
    "divider",
    // Unclaiming leaves the status as it is, and a done task can't be unclaimed.
    ...(task.assignee && task.status !== "done" ? [{ label: task.assignee.id === GROUP_USER_ID ? "Unclaim" : `Unclaim (${task.assignee.name})`, icon: "undo" as const, onSelect: () => onTask({ action: "unclaim", number: task.number }) }] : []),
    ...(task.assignee?.id === GROUP_USER_ID ? [] : [{ label: "Assign to me", icon: "flag" as const, onSelect: () => onTask({ action: "assign", number: task.number, assignee: "user" }) }]),
    ...assignTo(task.assignee?.id),
    "divider",
    { label: "Remove task (keep the message)", icon: "trash", danger: true, onSelect: () => onTask({ action: "delete", number: task.number }) },
  ];
}

/** Reply, reply in thread, reactions, the task menu (top-level messages only) and copy. */
function RowActions({ message, members, onReply, onTask, onReact, onThread, replyTitle }: Pick<RowProps, "message" | "members" | "onReply" | "onTask" | "onReact" | "onThread"> & { replyTitle: string }) {
  return (
    <>
      <IconButton icon="reply" size={14} title={replyTitle} onClick={() => onReply(message)} />
      {onThread && !message.thread ? <IconButton icon="messages" size={14} title="Reply in thread" onClick={() => onThread(message.seq)} /> : null}
      <MenuButton icon="smile" size={14} title="React" entries={REACTIONS.map((reaction) => ({ label: `${reaction.emoji}  ${reaction.label}`, onSelect: () => onReact(message.seq, reaction.emoji) }))} />
      {message.thread ? null : <MenuButton icon="listTodo" size={14} title={message.task ? `Task #${message.task.number}` : "Task"} entries={() => taskEntries(message, onTask, members)} />}
      <CopyButton text={message.text} title="Copy message" />
    </>
  );
}

/** The threads with replies the user hasn't read. */
const UnreadThreads = createContext<ReadonlySet<number>>(new Set());

/** A top-level message's thread: how many replies and when the latest came, with a dot when some are unread; opens it. */
function ThreadLink({ message, onThread }: { message: GroupMessage; onThread?: (seq: number) => void }) {
  const unread = useContext(UnreadThreads).has(message.seq);
  if (!onThread || message.thread || message.replies === 0) return null;
  return (
    <button type="button" className={`group-thread-link${unread ? " unread" : ""}`} onClick={() => onThread(message.seq)} title={unread ? "Open the thread: it has replies you haven't read" : "Open the thread"}>
      <Icon name="messages" size={12} />
      {message.replies} {message.replies === 1 ? "reply" : "replies"}
      {message.lastReplyAt ? <span className="hint">· {relativeTime(message.lastReplyAt)}</span> : null}
    </button>
  );
}

/** The message's task (number, status, assignee) and its reactions (click one to add or take back yours). */
function MessageMeta({ message, members, onTask, onReact }: Pick<RowProps, "message" | "members" | "onTask" | "onReact">) {
  if (!message.task && message.reactions.length === 0) return null;
  const task = message.task;
  return (
    <div className="row small group-meta">
      {task ? (
        <MenuBadge className={`badge task-badge ${statusOf(task.status).badge}${task.status === "closed" ? " closed" : ""}`} title="A task: click to change its status, assignee, or remove it" entries={() => taskEntries(message, onTask, members)}>
          <Icon name="listTodo" size={11} />
          task #{task.number} · {statusOf(task.status).label} · {assigneeName(task)}
        </MenuBadge>
      ) : null}
      {message.reactions.map((reaction) => {
        const mine = reaction.ids.includes(GROUP_USER_ID);
        const names = reaction.names.map((name, index) => (reaction.ids[index] === GROUP_USER_ID ? "You" : name));
        return (
          <button key={reaction.emoji} type="button" className={`badge reaction${mine ? " accent" : ""}`} title={`${names.join(", ")}${mine ? " · click to take yours back" : " · click to add yours"}`} onClick={() => onReact(message.seq, reaction.emoji)}>
            {reaction.emoji} {reaction.names.length}
          </button>
        );
      })}
    </div>
  );
}

/** A badge that opens a menu. */
function MenuBadge({ className, title, entries, children }: { className: string; title: string; entries: () => MenuItems; children: React.ReactNode }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button type="button" className={className} title={title} onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}>
        {children}
      </button>
      {anchor ? <Menu anchor={anchor} entries={entries()} align="start" onClose={() => setAnchor(null)} /> : null}
    </>
  );
}

/** Finds messages in the group by words; picking one scrolls to it. */
function SearchPanel({ groupId, signal, onPick, onClose }: { groupId: string; signal: number; onPick: (message: GroupMessage) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GroupMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Cmd/Ctrl+F again while it's open selects what's typed.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [signal]);
  useEffect(() => {
    const words = query.trim();
    if (!words) {
      setResults(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      setBusy(true);
      rpc(groupSearchRpc, { groupId, query: words.slice(0, 200) })
        .then((result) => !stale && setResults(result.messages))
        .catch(() => !stale && setResults([]))
        .finally(() => !stale && setBusy(false));
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [groupId, query]);
  return (
    <div className="group-search">
      <div className="group-search-bar">
        <Icon name="search" size={14} />
        <input ref={input} className="grow" placeholder="Search this group" aria-label="Search this group" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Escape" && onClose()} />
        {busy ? <span className="spinner small" /> : null}
        <IconButton icon="x" size={14} title="Close search" onClick={onClose} />
      </div>
      {results ? (
        <div className="group-search-results">
          {results.length === 0 ? (
            <div className="hint" style={{ padding: "8px 10px" }}>
              No messages match.
            </div>
          ) : (
            results.map((message) => (
              <button key={message.seq} type="button" className="group-search-hit" onClick={() => onPick(message)}>
                <span className="row small" style={{ gap: 6 }}>
                  <strong>{senderName(message)}</strong>
                  <span className="hint">
                    #{message.seq}
                    {message.thread ? ` in thread #${message.thread}` : ""} · {timeOf(message.at)}
                  </span>
                </span>
                <span className="truncate">{messagePreview(message, 160)}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

const MessageRow = memo(function MessageRow({ groupId, message, quoted, bots, members, seats, onReply, onJump, onTask, onReact, onThread, idPrefix = "group-msg" }: RowProps) {
  const id = `${idPrefix}-${message.seq}`;
  if (message.from.kind === "system") {
    return (
      <div id={id} className="group-system">
        {message.text}
      </div>
    );
  }
  if (message.from.kind === "user") {
    return (
      <div id={id} className="msg-user group-user">
        <Quote message={quoted} onJump={onJump} />
        <Attachments groupId={groupId} files={message.attachments} />
        {message.text.trim() ? (
          <div className="msg-user-line">
            <span className="msg-actions">
              <RowActions message={message} members={members} onReply={onReply} onTask={onTask} onReact={onReact} onThread={onThread} replyTitle="Reply" />
            </span>
            <div className="bubble">
              <MentionText text={message.text} members={members} />
            </div>
          </div>
        ) : null}
        <MessageMeta message={message} members={members} onTask={onTask} onReact={onReact} />
        <ThreadLink message={message} onThread={onThread} />
      </div>
    );
  }
  const from = message.from;
  const bot = bots.get(from.botId) ?? null;
  const seat = seatChat(seats, from.botId, message);
  const handedTo = message.mentions.map((botId) => bots.get(botId)?.name).filter(Boolean);
  return (
    <div id={id} className="group-msg">
      {bot ? <Avatar avatar={bot.avatar} size={30} /> : <span className="group-avatar-gone"><Icon name="bot" size={16} /></span>}
      <div className="group-msg-body">
        <div className="group-msg-head">
          <strong>{from.name}</strong>
          {bot?.title ? <span className="hint truncate">{bot.title}</span> : null}
          <span className="hint" title={message.at}>
            {timeOf(message.at)}
          </span>
          <span className="msg-actions">
            <RowActions message={message} members={members} onReply={onReply} onTask={onTask} onReact={onReact} onThread={onThread} replyTitle={`Reply to ${from.name}`} />
            {seat ? <IconButton icon="external" size={14} title={`Open ${from.name}'s side of this group`} onClick={() => navigate({ page: "bot", botId: from.botId, chatId: seat })} /> : null}
          </span>
        </div>
        <Quote message={quoted} onJump={onJump} />
        {message.question ? (
          <QuestionCard groupId={groupId} message={message} />
        ) : (
          <div className="msg-assistant">
            <Markdown text={message.text} />
          </div>
        )}
        <Attachments groupId={groupId} files={message.attachments} />
        <MessageMeta message={message} members={members} onTask={onTask} onReact={onReact} />
        <ThreadLink message={message} onThread={onThread} />
        {handedTo.length || message.everyone ? (
          <div className="group-handoff">
            <Icon name="send" size={11} />
            {message.everyone ? "To everyone" : `Handed to ${handedTo.join(", ")}`}
            {/* A led member's request at the top level, from its seat for another piece. */}
            {!message.thread && message.fromPiece ? (
              <>
                {" · for "}
                <button type="button" className="link" onClick={() => onThread?.(message.fromPiece!)} title={`Open #${message.fromPiece}'s thread`}>
                  #{message.fromPiece}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

interface ThreadPanelProps {
  groupId: string;
  thread: number;
  bots: ReadonlyMap<string, Bot>;
  members: readonly Member[];
  live: readonly Bot[];
  seats: Seats;
  /** A message to scroll to once it's loaded (a search hit). */
  focus: number | null;
  onFocused: () => void;
  onTask: RowProps["onTask"];
  onReact: RowProps["onReact"];
  /** Opens another thread, at a message in it when given. */
  onOpen: (thread: number, focus: number | null) => void;
  onClose: () => void;
  /** It has replies the user hasn't read. */
  unread: boolean;
}

/**
 * A link in a thread to where one of its members went from it: a request it started at the top
 * level, or a question it asked in another thread (`count`: its messages there). Not a message:
 * the bots don't see it.
 */
function AsideRow({ aside, count, bots, onOpen }: { aside: GroupMessage; count: number; bots: ReadonlyMap<string, Bot>; onOpen: ThreadPanelProps["onOpen"] }) {
  const who = aside.from.kind === "bot" ? aside.from.name : "A bot";
  const asked = aside.mentions.map((id) => bots.get(id)?.name).filter(Boolean).join(", ");
  const where = aside.thread ? `in #${aside.thread}` : `in a request, #${aside.seq}`;
  return (
    <button type="button" className="group-aside" onClick={() => (aside.thread ? onOpen(aside.thread, aside.seq) : onOpen(aside.seq, null))} title="Open where it was asked">
      <Icon name="external" size={12} />
      <span className="truncate">
        {who} asked {asked || "a member"} {where}: {messagePreview(aside, 80)}
      </span>
      {count > 1 ? <span className="hint">· {count} messages there</span> : null}
    </button>
  );
}

/** One thread beside the group: its top message, the replies, and a composer that posts there. */
function ThreadPanel({ groupId, thread, bots, members, live, seats, focus, onFocused, onTask, onReact, onOpen, onClose, unread }: ThreadPanelProps) {
  const { messages, hasOlder, asides, loadingOlder, loadOlder, loading, error } = useGroupMessages(groupId, thread);
  // Read while it's open and on screen.
  const visible = useVisible();
  const lastReply = messages.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (!visible || !unread || !lastReply) return;
    void rpc(groupReadRpc, { groupId, seq: lastReply, thread }).catch(() => {});
  }, [visible, unread, groupId, thread, lastReply]);
  const [replyTo, setReplyTo] = useState<GroupMessage | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const bySeq = useMemo(() => new Map(messages.map((message) => [message.seq, message])), [messages]);
  const top = messages[0]?.seq === thread ? messages[0] : null;
  const replies = top ? messages.slice(1) : messages;
  // Where its members went from here: one link per place, at the first message there, with the
  // replies shown so far (older ones wait for "Load earlier replies").
  const elsewhere = useMemo(() => {
    const from = hasOlder ? (replies[0]?.seq ?? thread) : thread;
    const places = new Map<number, { first: GroupMessage; count: number }>();
    for (const aside of asides) {
      const place = aside.thread ?? aside.seq;
      const entry = places.get(place);
      if (entry) entry.count++;
      else places.set(place, { first: aside, count: 1 });
    }
    return [...places.values()].filter((entry) => entry.first.seq >= from);
  }, [asides, hasOlder, replies, thread]);
  const stream = useMemo(
    () => [...replies.map((message) => ({ seq: message.seq, message, aside: null })), ...elsewhere.map((aside) => ({ seq: aside.first.seq, message: null, aside }))].sort((a, b) => a.seq - b.seq),
    [replies, elsewhere],
  );

  const jump = useCallback((seq: number): boolean => {
    const target = document.getElementById(`thread-msg-${seq}`);
    if (!target) return false;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1200);
    return true;
  }, []);
  useLayoutEffect(() => {
    if (focus !== null && jump(focus)) {
      pinned.current = false;
      onFocused();
      return;
    }
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [messages.length, focus, jump, onFocused]);

  const row = (message: GroupMessage) => (
    <MessageRow
      key={message.seq}
      groupId={groupId}
      message={message}
      quoted={message.replyTo ? (bySeq.get(message.replyTo) ?? null) : null}
      bots={bots}
      members={members}
      seats={seats}
      onReply={setReplyTo}
      onJump={jump}
      onTask={onTask}
      onReact={onReact}
      idPrefix="thread-msg"
    />
  );
  return (
    <aside className="group-thread" aria-label={`Thread on #${thread}`}>
      <div className="topbar">
        <div className="title">
          Thread<span className="subtitle"> · on #{thread}</span>
        </div>
        <IconButton icon="x" title="Close thread" onClick={onClose} />
      </div>
      <div
        className="stream"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        <div className="stream-inner group-stream">
          {hasOlder ? (
            <div className="row" style={{ justifyContent: "center", padding: 8 }}>
              {loadingOlder ? (
                <span className="spinner" />
              ) : (
                <button type="button" className="btn small ghost" onClick={loadOlder}>
                  Load earlier replies
                </button>
              )}
            </div>
          ) : null}
          {loading ? (
            <div className="splash">
              <span className="spinner" />
            </div>
          ) : (
            <>
              {top ? row(top) : null}
              <div className="group-thread-divider">{replies.length ? `${top?.replies ?? replies.length} ${(top?.replies ?? replies.length) === 1 ? "reply" : "replies"}` : "No replies yet. The bots that follow this thread get what you write here."}</div>
              {stream.map((item) => (item.message ? row(item.message) : <AsideRow key={`aside-${item.seq}`} aside={item.aside!.first} count={item.aside!.count} bots={bots} onOpen={onOpen} />))}
            </>
          )}
          {error ? <div className="notice error">{error}</div> : null}
        </div>
      </div>
      <GroupComposer
        key={`${groupId}:${thread}`}
        groupId={groupId}
        thread={thread}
        members={live}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onSent={() => {
          setReplyTo(null);
          pinned.current = true;
        }}
      />
    </aside>
  );
}

const BOARD_ORDER: TaskStatus[] = ["in_progress", "todo", "done", "closed"];

/** When a reminder fires, in the viewer's time and from now. */
function reminderWhen(at: string): string {
  const date = new Date(at);
  const minutes = Math.round((date.getTime() - Date.now()) / 60_000);
  const from = Math.abs(minutes) < 60 ? `${minutes} min` : Math.abs(minutes) < 24 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
  const local = date.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return minutes >= 0 ? `${local} · in ${from}` : `${local} · overdue`;
}

/** The task board: tasks by status, each opening its message; then the bots' pending reminders, read-only. */
function TaskBoard({ groupId, onPick, onClose }: { groupId: string; onPick: (target: { seq: number; thread: number | null }) => void; onClose: () => void }) {
  const tasks = useGroupTasks(groupId, true);
  const reminders = useGroupReminders(groupId, true);
  const [finished, setFinished] = useState(false);
  const list = tasks.data ?? [];
  const open = list.filter((task) => task.status !== "done" && task.status !== "closed").length;
  const shown = BOARD_ORDER.filter((status) => finished || (status !== "done" && status !== "closed"));
  return (
    <aside className="group-thread" aria-label="Tasks">
      <div className="topbar">
        <div className="title">
          Tasks<span className="subtitle"> · {open} open</span>
        </div>
        <IconButton icon="x" title="Close tasks" onClick={onClose} />
      </div>
      <div className="stream">
        <div className="stream-inner group-board">
          {tasks.isPending ? <span className="spinner" /> : null}
          {!tasks.isPending && list.length === 0 ? (
            <p className="hint">No tasks yet. Make one from a message's task menu, or a bot creates them when it splits work.</p>
          ) : null}
          {shown.map((status) => {
            const rows = list.filter((task) => task.status === status);
            if (rows.length === 0) return null;
            return (
              <section key={status} className="group-board-section">
                <div className="group-thread-divider">
                  {statusOf(status).label} · {rows.length}
                </div>
                {rows.map((task) => (
                  <button key={task.number} type="button" className="group-search-hit" onClick={() => onPick({ seq: task.seq, thread: null })} title="Show the message">
                    <span className="row small" style={{ gap: 6 }}>
                      <strong>task #{task.number}</strong>
                      <span className={`badge ${statusOf(task.status).badge}`}>{task.assignee ? (task.assignee.id === GROUP_USER_ID ? "You" : task.assignee.name) : "unassigned"}</span>
                      {task.replies ? <span className="hint">· {task.replies} in thread</span> : null}
                    </span>
                    <span className="truncate">{task.preview}</span>
                  </button>
                ))}
              </section>
            );
          })}
          {list.some((task) => task.status === "done" || task.status === "closed") ? (
            <button type="button" className="btn small ghost" onClick={() => setFinished((value) => !value)}>
              {finished ? "Hide done and closed" : "Show done and closed"}
            </button>
          ) : null}
          {reminders.data?.length ? (
            <section className="group-board-section">
              <div className="group-thread-divider">Reminders · {reminders.data.length}</div>
              {reminders.data.map((reminder) => (
                <button key={reminder.id} type="button" className="group-search-hit" onClick={() => onPick({ seq: reminder.anchor, thread: reminder.anchorThread })} title="Show the message it's about">
                  <span className="row small" style={{ gap: 6 }}>
                    <Icon name="clock" size={12} />
                    <strong>{reminder.owner}</strong>
                    <span className="hint">
                      {reminderWhen(reminder.fireAt)}
                      {reminder.repeat ? ` · ${reminder.repeat}` : ""} · #{reminder.anchor}
                    </span>
                  </span>
                  <span className="truncate">{reminder.title}</span>
                </button>
              ))}
            </section>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

/**
 * What the members are doing: working (with the way to their side of the group), or waiting for an
 * approval that stays in the seat (a question the group shows is answered there instead).
 */
function Activity({ members, seats, chats }: { members: readonly Bot[]; seats: Seats; chats: ReadonlyMap<string, ChatSnapshot> }) {
  // One chip per seat: a member the leader leads can work in several conversations at once.
  const rows = members.flatMap((bot) =>
    seats.flatMap((seat): { bot: Bot; chatId: string; piece: number; kind: "approval" | "working" }[] => {
      const agent = seat.botId === bot.id ? chats.get(seat.chatId) : undefined;
      if (!agent) return [];
      if (agent.pendingPermissions?.some((request) => !groupQuestion(request))) return [{ bot, chatId: seat.chatId, piece: seat.piece, kind: "approval" }];
      if (agent.status === "running" || agent.status === "initializing") return [{ bot, chatId: seat.chatId, piece: seat.piece, kind: "working" }];
      return [];
    }),
  );
  if (rows.length === 0) return null;
  return (
    <div className="group-activity">
      {rows.map((row) => (
        <button key={row.chatId} type="button" className={`group-activity-chip${row.kind === "approval" ? " warning" : ""}`} onClick={() => navigate({ page: "bot", botId: row.bot.id, chatId: row.chatId })} title={`Open ${row.bot.name}'s side of this group`}>
          <Avatar avatar={row.bot.avatar} size={16} />
          {row.kind === "approval" ? (
            <>
              <Icon name="shield" size={12} /> {row.bot.name} needs your approval
            </>
          ) : (
            <>
              <span className="spinner small" /> {row.bot.name} is working{row.piece ? ` on #${row.piece}` : ""}…
            </>
          )}
        </button>
      ))}
    </div>
  );
}

function Empty({ group, members }: { group: GroupSummary; members: readonly Bot[] }) {
  const [first, second] = members;
  const leader = members.find((bot) => bot.id === group.leaderId);
  if (leader) {
    const others = members.filter((bot) => bot.id !== leader.id).map((bot) => bot.name);
    return (
      <div className="splash group-empty">
        <AvatarStack avatars={members.map((bot) => bot.avatar)} size={44} max={6} />
        <h1>{group.name}</h1>
        <p className="muted" style={{ maxWidth: 560, margin: 0 }}>
          {leader.name} leads this group. Tell {leader.name} what you want: it plans the work and hands each piece to {others.join(", ") || "the other bots"} with a brief. They work only on what {leader.name} or you hand them, and report back to {leader.name}.
        </p>
      </div>
    );
  }
  return (
    <div className="splash group-empty">
      <AvatarStack avatars={members.map((bot) => bot.avatar)} size={44} max={6} />
      <h1>{group.name}</h1>
      <p className="muted" style={{ maxWidth: 560, margin: 0 }}>
        Describe the shared outcome and who owns the next step. Write normally and the bots decide who answers; @mention a bot when the request is its own, and reply to a bot's message to answer it.
      </p>
      {first && second ? (
        <p className="hint" style={{ maxWidth: 560, margin: 0 }}>
          For example: “@{first.name} gather the source material and link every claim. @{second.name} turn the findings into a draft. Don't publish anything.”
        </p>
      ) : null}
    </div>
  );
}

function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * The folders the group's bots may use besides their working folder: shown under the title,
 * with a remove button on each and a "+" to add one. A change reaches each bot's seat without
 * starting it over (the seat resumes with the new list).
 */
function GroupFolders({ group, providers }: { group: GroupSummary; providers: string[] }) {
  const feedback = useFeedback();
  const byPath = useReachesFoldersByPath(providers);
  const change = async (extraFolders: string[]) => {
    try {
      await rpc(groupUpdateRpc, { groupId: group.id, extraFolders });
    } catch (error) {
      feedback.error(`Couldn't change the folders: ${errorText(error)}`);
    }
  };
  return (
    <div className="group-folders">
      <span className="hint">Extra folders</span>
      <ExtraFolders folders={group.extraFolders} exclude={group.cwd ? [group.cwd] : []} subject="group" onChange={(next) => void change(next)} />
      {group.extraFolders.length > 0 && byPath ? <span className="hint">{PATH_ACCESS_NOTE}</span> : null}
    </div>
  );
}

export function GroupView({ groupId, at, atThread }: { groupId: string; at?: number; atThread?: number }) {
  const feedback = useFeedback();
  const groups = useGroups();
  const doc = useStoreDoc();
  const allChats = useAllChats();
  const group = groups.data?.find((entry) => entry.id === groupId) ?? null;
  const { messages, hasOlder, loadingOlder, loadOlder, reach, loading, error, refetch } = useGroupMessages(groupId);
  const [replyTo, setReplyTo] = useState<GroupMessage | null>(null);
  const [searching, setSearching] = useState(0);
  const pendingJump = useRef<number | null>(null);
  const [thread, setThread] = useState<{ seq: number; focus: number | null } | null>(null);
  const [board, setBoard] = useState(false);
  const openThread = useCallback((seq: number) => {
    setBoard(false);
    setThread({ seq, focus: null });
  }, []);
  const threadFocused = useCallback(() => setThread((current) => (current ? { ...current, focus: null } : current)), []);
  const visible = useVisible();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  // Reopening a conversation returns to where you left it (the top message
  // then on screen), and while you're scrolled up the way down counts the new messages.
  const restored = useRef(false);
  const bottomSeq = useRef(0);
  const saveTimer = useRef<number | null>(null);
  const scrollKey = `pocket-bots.group-scroll.${groupId}`;

  const bots = useMemo(() => new Map((doc.data?.values.bots ?? []).map((bot) => [bot.id, bot])), [doc.data]);
  const members = useMemo(() => (group?.memberIds ?? []).flatMap((id) => bots.get(id) ?? []), [group, bots]);
  const live = members.filter((bot) => !bot.archived);
  const mentionable = useMemo(() => members.map((bot) => ({ id: bot.id, name: bot.name })), [members]);
  const chats = useMemo(() => new Map(((allChats.data ?? []) as ChatSnapshot[]).map((chat) => [chat.id, chat])), [allChats.data]);
  const bySeq = useMemo(() => new Map(messages.map((message) => [message.seq, message])), [messages]);
  const seats = group?.seats ?? NO_SEATS;
  const newBelow = away ? messages.filter((message) => message.seq > bottomSeq.current && message.from.kind !== "user").length : 0;

  // Seen while it's on screen.
  const lastSeq = group?.lastSeq ?? 0;
  const readSeq = group?.readSeq ?? 0;
  const unreadThreads = useMemo(() => new Set(group?.unreadThreads ?? []), [group?.unreadThreads]);
  useEffect(() => {
    if (!visible || lastSeq <= readSeq) return;
    void rpc(groupReadRpc, { groupId, seq: lastSeq }).catch(() => {});
  }, [visible, groupId, lastSeq, readSeq]);

  const jump = useCallback((seq: number): boolean => {
    const target = document.getElementById(`group-msg-${seq}`);
    if (!target) return false;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1200);
    return true;
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!restored.current && !loading && messages.length && element) {
      restored.current = true;
      let saved: number | null = null;
      try {
        saved = Number(localStorage.getItem(scrollKey)) || null;
      } catch {
        // No storage: open at the latest messages.
      }
      const target = saved ? document.getElementById(`group-msg-${saved}`) : null;
      if (target) {
        target.scrollIntoView({ block: "start" });
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        setAway(!pinned.current);
        bottomSeq.current = pinned.current ? (messages.at(-1)?.seq ?? 0) : (saved ?? 0);
        return;
      }
    }
    if (pinned.current) bottomSeq.current = messages.at(-1)?.seq ?? 0;
    if (pendingJump.current !== null && jump(pendingJump.current)) pendingJump.current = null;
    else if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [messages.length, chats, jump]);

  // A search hit may be older than what's loaded: load back to it, then show it.
  const show = useCallback(
    (seq: number) => {
      if (jump(seq)) return;
      pinned.current = false;
      pendingJump.current = seq;
      reach(seq).catch((failure: unknown) => {
        pendingJump.current = null;
        feedback.error(errorText(failure));
      });
    },
    [jump, reach, feedback],
  );
  // A search result in the route (from the palette): once the group has loaded, show it (in its
  // thread for a reply there) with the words it was found by marked for a while.
  const [target, setTarget] = useState<{ seq: number; thread: number | null } | null>(null);
  const [marks, setMarks] = useState<string[]>([]);
  const layout = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    setTarget({ seq: at, thread: atThread ?? null });
    setMarks(pendingTermsFor(placeKey("group", groupId, at)));
    replaceRoute({ page: "group", groupId });
  }, [at, atThread, groupId]);
  useEffect(() => {
    if (!target || loading) return;
    setTarget(null);
    if (target.thread) {
      setBoard(false);
      setThread({ seq: target.thread, focus: target.seq });
    } else {
      restored.current = true;
      show(target.seq);
    }
  }, [target, loading, show]);
  useEffect(() => {
    const root = layout.current;
    if (!root || !marks.length) return markTermsIn(null, []);
    // The place may still be loading (older messages, a thread): mark what arrives too.
    let frame = 0;
    const mark = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => markTermsIn(root, marks));
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    const timer = setTimeout(() => setMarks([]), 10_000);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [marks]);
  useEffect(() => () => markTermsIn(null, []), []);
  useShortcut("f", () => setSearching((open) => open + 1));

  const onTask = useCallback((input: TaskInput) => void rpc(groupTaskRpc, { groupId, ...input }).catch((failure: unknown) => feedback.error(errorText(failure))), [groupId, feedback]);
  const onReact = useCallback(
    (seq: number, emoji: string) => void rpc(groupReactRpc, { groupId, seq, emoji }).catch((failure: unknown) => feedback.error(errorText(failure))),
    [groupId, feedback],
  );

  if (!group) {
    return <div className="splash">{groups.isPending ? <span className="spinner" /> : <p className="muted">That group chat no longer exists.</p>}</div>;
  }

  // A team's session goes back to its team; a group made on its own (from before teams) to the start.
  const team = group.teamId ? (doc.data?.values.teams.find((entry) => entry.id === group.teamId) ?? null) : null;
  const back = () => navigate(team ? { page: "team", teamId: team.id } : { page: "home" });
  const rename = async () => {
    const name = await feedback.prompt({ title: "Rename session", label: "Name", value: group.name, action: "Rename" });
    if (name === null || !name.trim() || name.trim() === group.name) return;
    await rpc(groupUpdateRpc, { groupId, name: name.trim() }).catch((failure: unknown) => feedback.error(errorText(failure)));
  };
  const remove = async () => {
    const yes = await feedback.confirm({
      title: `Delete ${group.name}?`,
      body: "Its messages go. Each bot's side of the session is archived and stays in that bot's chat history; the bots themselves stay.",
      action: "Delete",
      danger: true,
    });
    if (!yes) return;
    try {
      await rpc(groupDeleteRpc, { groupId });
      back();
    } catch (failure) {
      feedback.error(errorText(failure));
    }
  };
  // Each bot's side of the group: its own chat, where its work, approvals and silent turns are (a
  // member the leader leads has one for each conversation it was brought into).
  const sides: MenuItems = members.flatMap((bot) =>
    seats.flatMap((seat) => (seat.botId === bot.id ? [{ label: `${bot.name}'s side${seat.piece ? ` · #${seat.piece}` : ""}`, icon: "bot" as const, onSelect: () => navigate({ page: "bot", botId: bot.id, chatId: seat.chatId }) }] : [])),
  );
  const menu: MenuItems = [
    { label: "Rename", icon: "edit", onSelect: () => void rename() },
    ...(team ? [{ label: `Open ${team.name}`, icon: "users" as const, onSelect: back }] : []),
    ...(sides.length ? ["divider" as const, ...sides] : []),
    "divider",
    { label: "Delete session", icon: "trash", danger: true, onSelect: () => void remove() },
  ];

  return (
    <UnreadThreads.Provider value={unreadThreads}>
      <div className="topbar">
        <IconButton icon="chevronLeft" title={team ? `Back to ${team.name}` : "Back"} onClick={back} />
        <AvatarStack avatars={members.map((bot) => bot.avatar)} size={26} />
        <div className="title" style={{ cursor: "pointer" }} onClick={() => void rename()} title="Rename">
          {group.name}
          {team ? <span className="subtitle"> · {team.name}</span> : null}
          <span className="subtitle"> · {members.map((bot) => (bot.id === group.leaderId ? `${bot.name} (leader)` : bot.name)).join(", ") || "no bots"}</span>
          {group.cwd ? (
            <span className="subtitle" title={`The bots work in ${group.cwd}`}>
              {" · "}
              <Icon name="folder" size={12} /> {folderName(group.cwd)}
            </span>
          ) : null}
        </div>
        <IconButton icon="search" title={`Search this group (${MOD}F)`} onClick={() => setSearching((open) => (open ? 0 : 1))} />
        <IconButton
          icon="listTodo"
          title="Tasks"
          onClick={() => {
            setThread(null);
            setBoard((open) => !open);
          }}
        />
        <MenuButton title="Session actions" entries={menu} />
      </div>
      <GroupFolders group={group} providers={members.map((bot) => bot.provider)} />
      {searching ? <SearchPanel groupId={groupId} signal={searching} onPick={(message) => {
            if (!message.thread) return show(message.seq);
            setBoard(false);
            setThread({ seq: message.thread, focus: message.seq });
          }} onClose={() => setSearching(0)} /> : null}
      <div className="group-layout" ref={layout}>
        <div className="group-main">
          <div className="stream-wrap">
            <div
              className="stream"
              ref={scroller}
              onScroll={(event) => {
                const element = event.currentTarget;
                pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                setAway(!pinned.current);
                if (pinned.current) bottomSeq.current = messages.at(-1)?.seq ?? 0;
                if (element.scrollTop < 60 && hasOlder && !loadingOlder) loadOlder();
                // Remember where this was left: the first message on screen, or nothing at the bottom.
                if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
                saveTimer.current = window.setTimeout(() => {
                  try {
                    if (pinned.current) return localStorage.removeItem(scrollKey);
                    const top = element.getBoundingClientRect().top;
                    const first = [...element.querySelectorAll<HTMLElement>("[id^='group-msg-']")].find((row) => row.getBoundingClientRect().bottom > top);
                    if (first) localStorage.setItem(scrollKey, first.id.slice("group-msg-".length));
                  } catch {
                    // No storage: nothing to remember.
                  }
                }, 250);
              }}
            >
              <div className="stream-inner group-stream">
                {hasOlder ? (
                  <div className="row" style={{ justifyContent: "center", padding: 8 }}>
                    {loadingOlder ? (
                      <span className="spinner" />
                    ) : (
                      <button type="button" className="btn small ghost" onClick={loadOlder}>
                        Load earlier messages
                      </button>
                    )}
                  </div>
                ) : null}
                {loading ? (
                  <div className="splash">
                    <span className="spinner" />
                  </div>
                ) : messages.length === 0 ? (
                  <Empty group={group} members={members} />
                ) : (
                  messages.map((message) => (
                    <MessageRow
                      key={message.seq}
                      groupId={groupId}
                      message={message}
                      quoted={message.replyTo ? (bySeq.get(message.replyTo) ?? null) : null}
                      bots={bots}
                      members={mentionable}
                      seats={seats}
                      onReply={setReplyTo}
                      onJump={show}
                      onTask={onTask}
                      onReact={onReact}
                      onThread={openThread}
                    />
                  ))
                )}
              </div>
            </div>
            {away ? (
              <button
                type="button"
                className={`scroll-bottom${newBelow ? " with-count" : ""}`}
                title="Scroll to bottom"
                aria-label={newBelow ? `${newBelow} new message${newBelow === 1 ? "" : "s"}` : "Scroll to bottom"}
                onClick={() => {
                  pinned.current = true;
                  setAway(false);
                  scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
                }}
              >
                <Icon name="chevronDown" size={newBelow ? 14 : 18} />
                {newBelow ? `${newBelow} new message${newBelow === 1 ? "" : "s"}` : null}
              </button>
            ) : null}
          </div>
          {error ? (
            <div className="notice error row" style={{ margin: "0 20px" }}>
              <span className="grow">{error}</span>
              <Button small icon="refresh" onClick={() => void refetch()}>
                Retry
              </Button>
            </div>
          ) : null}
          {live.length < GROUP_MIN_BOTS ? (
            <div className="notice warning" style={{ margin: "0 20px" }}>
              Fewer than {GROUP_MIN_BOTS} of this session's bots can take part: the others are archived or gone. Restore them, or start a new session from the team.
            </div>
          ) : null}
          <Activity members={members} seats={seats} chats={chats} />
          <GroupComposer
            key={groupId}
            groupId={groupId}
            members={live}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            onSent={() => {
              setReplyTo(null);
              pinned.current = true;
            }}
          />
        </div>
        {thread ? (
          <ThreadPanel
            key={thread.seq}
            groupId={groupId}
            thread={thread.seq}
            bots={bots}
            members={mentionable}
            live={live}
            seats={seats}
            focus={thread.focus}
            onFocused={threadFocused}
            onTask={onTask}
            onReact={onReact}
            onOpen={(seq, focus) => setThread({ seq, focus })}
            onClose={() => setThread(null)}
            unread={unreadThreads.has(thread.seq)}
          />
        ) : board ? (
          <TaskBoard
            groupId={groupId}
            onPick={(target) => {
              if (!target.thread) return show(target.seq);
              setBoard(false);
              setThread({ seq: target.thread, focus: target.seq });
            }}
            onClose={() => setBoard(false)}
          />
        ) : null}
      </div>
    </UnreadThreads.Provider>
  );
}

/** A group's line in the bot list: its bots, name, last message and whether anything's new. */
export function groupRowInfo(group: GroupSummary, bots: ReadonlyMap<string, Bot>, chats: ReadonlyMap<string, ChatSnapshot>) {
  const members = group.memberIds.flatMap((id) => bots.get(id) ?? []);
  const seatChats = group.seats.flatMap((seat) => chats.get(seat.chatId) ?? []);
  const working = seatChats.some((chat) => chat.status === "running" || chat.status === "initializing");
  const approval = seatChats.some((chat) => (chat.pendingPermissions?.length ?? 0) > 0);
  const last = group.last ? `${group.last.from.kind === "bot" ? `${group.last.from.name}: ` : group.last.from.kind === "user" ? "You: " : ""}${messagePreview({ text: group.last.text, attachments: [] }, 80)}` : "No messages yet";
  return { members, working, approval, last, when: relativeTime(group.updatedAt) };
}
