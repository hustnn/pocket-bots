import { useEffect, useRef, useState } from "react";
import type { ChatSnapshot } from "../../../shared/chat-types";
import { newAttachmentId, normalizeMimeType, preflightFile, rejectReason, toWire, type ComposerAttachment } from "../../../shared/attachments";
import { chatFoldersRpc, chatRespondRpc, chatSendRpc, chatStartRpc, chatStopRpc, queueAddRpc, queueResumeRpc, queueSendNowRpc, queueTakeRpc, uploadRpc, type QueuedSummary, type SlashCommand } from "../../../shared/rpc";
import { LEARN_COMMAND } from "../../../shared/skills";
import { newUuid } from "../../../shared/uuid";
import {
  activeTurnBehaviorFor,
  applyCommand,
  commandQuery,
  contextUsage,
  draftKey,
  filterCommands,
  formatCost,
  formatTokenCount,
  meterTone,
  parseSendBehavior,
  resolveActiveSendBehavior,
  resolveAlternateAction,
  resolveDefaultAction,
  restoreFailedSend,
  sendLabel,
  withOwnCommands,
  type SendAction,
} from "../../chat/composer";
import { Icon } from "../../components/icons";
import { Button, Field, IconButton, MenuButton, Modal, useFeedback } from "../../components/ui";
import { GROUP_LABEL } from "../../../shared/group-chat";
import { errorText, rpc } from "../../lib/api";
import { useChatCommands, useQueue, useStatus } from "../../lib/data";
import { getDraft, setDraft } from "../../lib/drafts";
import { rememberSent } from "../../lib/sent";
import { SEND_BEHAVIOR_KEY, useLocalState } from "../../lib/local";
import { ChatFolder, ExtraFolders, NewChatFolder, PATH_ACCESS_NOTE, useReachesFoldersByPath } from "../folders";

function readAs(file: File, as: "dataUrl" | "text"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
    if (as === "dataUrl") reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);
const OWN_COMMANDS: SlashCommand[] = [LEARN_COMMAND];
const OWN_NAMES = OWN_COMMANDS.map((command) => command.name);

/** How full the chat's context window is, from the provider's last report. */
function ContextMeter({ agent }: { agent: ChatSnapshot | null }) {
  const usage = contextUsage(agent?.lastUsage);
  if (!usage) return null;
  const percent = Math.round(usage.percent);
  const cost = usage.costUsd !== null ? formatCost(usage.costUsd) : null;
  const title = [`Context window ${percent}% used`, `${formatTokenCount(usage.used)} of ${formatTokenCount(usage.max)} tokens`, cost ? `Cost so far ${cost}` : null].filter(Boolean).join("\n");
  return (
    <span className={`context-meter ${meterTone(usage.percent)}`} title={title} aria-label={title}>
      <span className="ring" style={{ ["--percent" as string]: `${usage.percent}%` }} />
      {percent}%
    </span>
  );
}

/** Pasted notes, an email or a log, sent alongside the message as a text attachment instead of in it. */
function PasteTextDialog({ onClose, onAttach }: { onClose: () => void; onAttach: (attachment: ComposerAttachment) => void }) {
  const [text, setText] = useState("");
  const size = new TextEncoder().encode(text).length;
  const problem = text.trim() ? rejectReason("text", size, false) : null;
  const attach = () => {
    const words = text.trim().split(/\s+/).length;
    onAttach({ kind: "text", id: newAttachmentId(), name: `Pasted text (${words} ${words === 1 ? "word" : "words"})`, size, text });
  };
  return (
    <Modal
      title="Paste text"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!text.trim() || !!problem} onClick={attach}>
            Attach
          </Button>
        </>
      }
    >
      <Field label="Text" hint="Sent alongside your message as an attachment, so the message itself stays short." error={problem}>
        <textarea className="textarea mono" rows={14} autoFocus value={text} onChange={(event) => setText(event.target.value)} aria-label="Text to attach" />
      </Field>
    </Modal>
  );
}

function QueuedRow({ message, onEdit, onSendNow, onRemove }: { message: QueuedSummary; onEdit: () => void; onSendNow: () => void; onRemove: () => void }) {
  const files = message.attachments.length;
  return (
    <div className="queued">
      <span title={message.quote ? `A reply to: ${message.quote}` : "Queued"}>
        <Icon name={message.quote ? "reply" : "clock"} size={13} />
      </span>
      <div className="grow">
        <div className="queued-text">{message.text || (files ? "Attachments only" : "")}</div>
        {files ? <div className="hint">{files === 1 ? message.attachments[0]!.name : `${files} attachments`}</div> : null}
      </div>
      <IconButton icon="edit" size={14} title="Edit queued message" onClick={onEdit} />
      <IconButton icon="arrowUp" size={14} title="Send queued message now" onClick={onSendNow} />
      <IconButton icon="x" size={14} title="Remove from queue" onClick={onRemove} />
    </div>
  );
}

interface ComposerProps {
  botId: string;
  chatId: string | null;
  agent: ChatSnapshot | null;
  placeholder: string;
  onStarted?: (chatId: string) => void;
  botName?: string;
  /** The bot's words the message replies to (Reply), quoted in front of it. */
  reply?: string | null;
  onReplyChange?: (quote: string | null) => void;
  /** The bot's own working folder (null: the managed one), which a new chat uses unless another is picked. */
  botFolder?: string | null;
  /** The bot's CLI, for what a new chat's extra folders mean on it. */
  botProvider?: string;
}

/** One composer per chat, so each keeps its own draft. */
export function Composer(props: ComposerProps) {
  const key = draftKey(props.botId, props.chatId);
  return <ChatComposer key={key} draft={key} {...props} />;
}

/**
 * The message box: Enter sends (Shift+Enter for a new line), files and pasted
 * images attach. While the bot works a message steers its turn, interrupts it,
 * or waits in the queue, as Settings say; Cmd/Ctrl+Enter does the other.
 * Stop ends the running turn (and denies a pending request, if any).
 */
function ChatComposer({ botId, chatId, agent, placeholder, onStarted, botName = "the bot", reply = null, onReplyChange, botFolder = null, botProvider, draft }: ComposerProps & { draft: string }) {
  // A new chat's folder, remembered per bot: the next new chat starts in the same project.
  const [folder, setFolder] = useLocalState<string | null>(`pocket.chatFolder.${botId}`, null);
  // A new chat's extra folders, picked for this chat only.
  const [newFolders, setNewFolders] = useState<string[]>([]);
  const dataPath = useStatus().data?.dataPath ?? null;
  const feedback = useFeedback();
  const folderCount = chatId === null ? newFolders.length : (agent?.extraFolders.length ?? 0);
  const byPath = useReachesFoldersByPath([chatId === null ? botProvider : agent?.provider]);
  const setChatFolders = async (next: string[]) => {
    if (!chatId) return;
    try {
      await rpc(chatFoldersRpc, { chatId, extraFolders: next });
    } catch (error) {
      feedback.error(`Couldn't change the folders: ${errorText(error)}`);
    }
  };
  const [text, setText] = useState(() => getDraft(draft)?.text ?? "");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => getDraft(draft)?.attachments ?? []);
  // What's typed is kept per chat, so leaving the chat or reloading doesn't lose it.
  useEffect(() => setDraft(draft, { text, attachments }), [draft, text, attachments]);
  const latest = useRef({ text, attachments });
  latest.current = { text, attachments };
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [storedBehavior] = useLocalState<string>(SEND_BEHAVIOR_KEY, "steer");
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  // Drag events fire for every child the files pass over; the depth says when they've really left.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const running = agent?.status === "running" || agent?.status === "initializing";
  const permission = agent?.pendingPermissions[0] ?? null;
  const behavior = resolveActiveSendBehavior(parseSendBehavior(storedBehavior), permission !== null);
  const canQueue = chatId !== null;
  const queue = useQueue(chatId);
  const queued = queue.data?.messages ?? [];

  // ------------------------------------------------------------ slash commands

  const query = chatId ? commandQuery(text) : null;
  const [dismissed, setDismissed] = useState(false);
  const [activeCommand, setActiveCommand] = useState(0);
  const menuOpen = query !== null && !dismissed;
  const providerCommands = useChatCommands(chatId, menuOpen);
  const commands = menuOpen ? filterCommands(withOwnCommands(OWN_COMMANDS, providerCommands.data?.commands ?? []), query ?? "", { pinned: OWN_NAMES }) : [];
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (query === null) setDismissed(false);
    setActiveCommand(0);
  }, [query]);
  useEffect(() => {
    menu.current?.querySelector(".list-item.active")?.scrollIntoView({ block: "nearest" });
  }, [activeCommand]);
  const selectCommand = (command: SlashCommand) => {
    setText(applyCommand(command));
    setDismissed(true);
    input.current?.focus();
  };

  useEffect(() => {
    input.current?.focus();
  }, []);
  // Reply takes you to the message box.
  useEffect(() => {
    if (reply) input.current?.focus();
  }, [reply]);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
  }, [text]);

  const addFiles = async (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const mimeType = normalizeMimeType(file.type || "application/octet-stream");
      const check = preflightFile(file.name, mimeType, file.size, true);
      if (check.reason) {
        feedback.error(`${file.name}: ${check.reason}`);
        continue;
      }
      try {
        if (check.kind === "image") {
          const data = base64Of(await readAs(file, "dataUrl"));
          setAttachments((current) => [...current, { kind: "image", id: newAttachmentId(), name: file.name || "image.png", mimeType, size: file.size, data }]);
        } else if (check.kind === "text") {
          const content = await readAs(file, "text");
          setAttachments((current) => [...current, { kind: "text", id: newAttachmentId(), name: file.name, size: file.size, text: content }]);
        } else {
          const data = base64Of(await readAs(file, "dataUrl"));
          const saved = await rpc(uploadRpc, { botId, fileName: file.name, dataBase64: data });
          setAttachments((current) => [...current, { kind: "file", id: newAttachmentId(), name: file.name, mimeType, size: saved.size, path: saved.path }]);
        }
      } catch (error) {
        feedback.error(`${file.name}: ${errorText(error)}`);
      }
    }
  };

  // ------------------------------------------------------------ sending

  const submit = async (action: SendAction) => {
    const message = text.trim();
    if ((!message && attachments.length === 0) || sending) return;
    const kept = { text, attachments };
    const quote = chatId && reply ? reply : null;
    setText("");
    setAttachments([]);
    if (quote) onReplyChange?.(null);
    setSending(true);
    try {
      if (action === "queue" && chatId) {
        const { id } = await rpc(queueAddRpc, { chatId, text: message, attachments: kept.attachments, ...(quote ? { quote } : {}) });
        rememberSent(id, message, kept.attachments);
      } else {
        const wire = toWire(kept.attachments);
        const messageId = newUuid();
        rememberSent(messageId, message, kept.attachments);
        const payload = { text: message, messageId, ...(wire.images.length ? { images: wire.images } : {}), ...(wire.attachments.length ? { attachments: wire.attachments } : {}) };
        if (chatId) await rpc(chatSendRpc, { chatId, ...payload, ...(quote ? { quote } : {}), activeTurnBehavior: activeTurnBehaviorFor(behavior) });
        else {
          const { chatId: started } = await rpc(chatStartRpc, { botId, ...payload, ...(folder ? { cwd: folder } : {}), ...(newFolders.length ? { extraFolders: newFolders } : {}) });
          setNewFolders([]);
          onStarted?.(started);
        }
      }
    } catch (error) {
      const restored = restoreFailedSend({ text: kept.text, attachments: kept.attachments }, latest.current);
      setText(restored.text);
      setAttachments(restored.attachments);
      if (quote) onReplyChange?.(quote);
      feedback.error(`Couldn't ${action === "queue" ? "queue" : "send"}: ${errorText(error)}`);
    } finally {
      setSending(false);
      input.current?.focus();
    }
  };

  const defaultAction = resolveDefaultAction({ behavior, running, canQueue });
  const alternateAction = resolveAlternateAction({ behavior, running, canQueue });

  const stop = async () => {
    if (!chatId || stopping) return;
    setStopping(true);
    try {
      if (permission) await rpc(chatRespondRpc, { chatId, requestId: permission.id, response: { behavior: "deny", interrupt: true, message: "Interrupted by the user." } });
      else await rpc(chatStopRpc, { chatId });
    } catch (error) {
      feedback.error(errorText(error));
    } finally {
      setStopping(false);
    }
  };

  // ------------------------------------------------------------ the queue

  const editQueued = async (id: string) => {
    if (!chatId) return;
    try {
      const { message } = await rpc(queueTakeRpc, { chatId, id });
      if (!message) return;
      // What's already typed stays; the queued message joins it.
      setText((current) => (current.trim() ? `${current.trimEnd()}\n${message.text}` : message.text));
      setAttachments((current) => [...current, ...message.attachments]);
      if (message.quote) onReplyChange?.(message.quote);
      input.current?.focus();
    } catch (error) {
      feedback.error(errorText(error));
    }
  };

  const removeQueued = async (id: string) => {
    if (!chatId) return;
    try {
      await rpc(queueTakeRpc, { chatId, id });
    } catch (error) {
      feedback.error(errorText(error));
    }
  };

  const sendQueuedNow = async (id: string) => {
    if (!chatId) return;
    try {
      await rpc(queueSendNowRpc, { chatId, id, activeTurnBehavior: activeTurnBehaviorFor(behavior) });
    } catch (error) {
      feedback.error(`Couldn't send: ${errorText(error)}`);
    }
  };

  const hasContent = text.trim().length > 0 || attachments.length > 0;
  const label = sendLabel({ action: defaultAction, behavior, running });
  const shortcut = navigator.platform.toLowerCase().includes("mac") ? "⌘↵" : "Ctrl+Enter";
  // Sending past the queue interrupts, so that's what the shortcut says when the queue is the default.
  const alternateLabel = alternateAction ? sendLabel({ action: alternateAction, behavior: behavior === "queue" ? "interrupt" : behavior, running }) : null;
  const sendTitle = alternateLabel ? `${label} (Enter) · ${alternateLabel} (${shortcut})` : label;

  return (
    <div className="composer-wrap">
      {queued.length || queue.data?.error ? (
        <div className="queue">
          {queue.data?.error ? (
            <div className="notice error row">
              <span className="grow">Couldn't send a queued message: {queue.data.error}</span>
              <Button small onClick={() => chatId && void rpc(queueResumeRpc, { chatId }).catch((error: unknown) => feedback.error(errorText(error)))}>
                Retry
              </Button>
            </div>
          ) : null}
          {queued.map((message) => (
            <QueuedRow key={message.id} message={message} onEdit={() => void editQueued(message.id)} onSendNow={() => void sendQueuedNow(message.id)} onRemove={() => void removeQueued(message.id)} />
          ))}
        </div>
      ) : null}
      {menuOpen ? (
        <div className="command-menu" ref={menu} role="listbox">
          {commands.map((command, index) => (
            <div
              key={command.name}
              role="option"
              aria-selected={index === activeCommand}
              className={`list-item${index === activeCommand ? " active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveCommand(index)}
              onClick={() => selectCommand(command)}
            >
              <Icon name={command.name === LEARN_COMMAND.name ? "sparkles" : command.kind === "skill" ? "library" : "terminal"} size={14} />
              <span className="mono">/{command.name}</span>
              {command.argumentHint ? <span className="hint truncate argument">{command.argumentHint}</span> : null}
              <span className="spacer" />
              <span className="hint truncate">{command.description}</span>
            </div>
          ))}
          {providerCommands.isFetching && !providerCommands.data ? (
            <div className="list-item hint">
              <span className="spinner" /> Loading the provider's commands…
            </div>
          ) : null}
          {commands.length === 0 && !providerCommands.isFetching ? <div className="list-item hint">No matching commands.</div> : null}
        </div>
      ) : null}
      <div
        className={`composer${dragging ? " dragging" : ""}`}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
        }}
      >
        {dragging ? (
          <div className="drop-hint">
            <Icon name="paperclip" size={16} /> Drop files here
          </div>
        ) : null}
        {reply ? (
          <div className="reply-chip">
            <Icon name="reply" size={13} />
            <span className="truncate grow">
              Replying to <strong>{botName}</strong>: {reply.replace(/\s+/g, " ")}
            </span>
            <IconButton icon="x" size={12} title="Cancel reply (Esc)" onClick={() => onReplyChange?.(null)} />
          </div>
        ) : null}
        {attachments.length ? (
          <div className="attachments">
            {attachments.map((attachment) => (
              <span key={attachment.id} className="attachment" title={attachment.name}>
                {attachment.kind === "image" ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /> : <Icon name="file" size={14} />}
                <span className="truncate">{attachment.name}</span>
                <IconButton icon="x" size={12} title="Remove" onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))} />
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const pasted = Array.from(event.clipboardData.files);
            if (pasted.length) {
              event.preventDefault();
              void addFiles(pasted);
            }
          }}
          onKeyDown={(event) => {
            const composing = event.nativeEvent.isComposing || event.keyCode === 229;
            if (menuOpen && commands.length && !composing) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActiveCommand((index) => (index + step + commands.length) % commands.length);
                return;
              }
              if ((event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
                event.preventDefault();
                selectCommand(commands[Math.min(activeCommand, commands.length - 1)]!);
                return;
              }
            }
            if (menuOpen && event.key === "Escape") {
              event.preventDefault();
              setDismissed(true);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !composing) {
              event.preventDefault();
              void submit((event.metaKey || event.ctrlKey) && alternateAction ? alternateAction : defaultAction);
              return;
            }
            if (event.key === "Escape" && reply) {
              event.preventDefault();
              onReplyChange?.(null);
              return;
            }
            if (event.key === "Escape" && running) void stop();
          }}
        />
        <div className="bar">
          <MenuButton
            icon="paperclip"
            title="Add attachment"
            entries={[
              { label: "Upload files", icon: "upload", onSelect: () => files.current?.click() },
              { label: "Paste text", icon: "file", onSelect: () => setPasting(true) },
            ]}
          />
          <input
            ref={files}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          {pasting ? (
            <PasteTextDialog
              onClose={() => setPasting(false)}
              onAttach={(attachment) => {
                setPasting(false);
                setAttachments((current) => [...current, attachment]);
                input.current?.focus();
              }}
            />
          ) : null}
          {chatId === null ? (
            <>
              <NewChatFolder value={folder} onChange={setFolder} botFolder={botFolder} />
              <ExtraFolders folders={newFolders} exclude={folder ? [folder] : []} onChange={setNewFolders} />
            </>
          ) : agent?.cwd ? (
            <>
              <ChatFolder cwd={agent.cwd} managed={!!dataPath && agent.cwd.startsWith(dataPath)} />
              <ExtraFolders folders={agent.extraFolders} exclude={[agent.cwd]} {...(agent.labels[GROUP_LABEL] ? {} : { onChange: (next: string[]) => void setChatFolders(next) })} />
            </>
          ) : null}
          <span className="spacer" />
          <ContextMeter agent={agent} />
          {running && !hasContent ? (
            <button type="button" className="btn small" disabled={stopping} onClick={() => void stop()} title={permission ? "Interrupt: deny the pending request and end the turn" : "Stop: end the bot's turn now"}>
              {stopping ? <span className="spinner" /> : <Icon name="stop" size={13} />}
              Stop
            </button>
          ) : (
            <button type="button" className="btn small primary" disabled={!hasContent || sending} onClick={() => void submit(defaultAction)} title={sendTitle}>
              {sending ? <span className="spinner" /> : <Icon name={defaultAction === "queue" ? "clock" : "send"} size={13} />}
              {label}
            </button>
          )}
        </div>
        {folderCount > 0 && byPath ? <div className="hint folder-note">{PATH_ACCESS_NOTE}</div> : null}
      </div>
    </div>
  );
}
