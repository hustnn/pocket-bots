import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { newAttachmentId, normalizeMimeType, preflightFile, type ComposerAttachment } from "../../../shared/attachments";
import type { Bot } from "../../../shared/bot";
import { messagePreview, type GroupMessage } from "../../../shared/group-chat";
import { groupSendRpc, groupUploadRpc } from "../../../shared/rpc";
import { insertMention, mentionCandidates, mentionQuery, type MentionQuery } from "../../chat/mentions";
import { Avatar } from "../../components/Avatar";
import { Icon } from "../../components/icons";
import { IconButton, useFeedback } from "../../components/ui";
import { errorText, rpc } from "../../lib/api";
import { getDraft, setDraft } from "../../lib/drafts";

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

interface Candidate {
  id: string;
  name: string;
  bot: Bot | null;
}

const EVERYONE: Candidate = { id: "everyone", name: "everyone", bot: null };

/** Who a message is from, for the reply chip. */
export function senderName(message: GroupMessage): string {
  return message.from.kind === "bot" ? message.from.name : message.from.kind === "user" ? "You" : "pocket-bots";
}

/**
 * The group's composer: @ to pick a bot (or @everyone), Reply to answer one
 * message, attachments as in a bot's chat. Enter sends, Shift+Enter breaks the line.
 */
export function GroupComposer({
  groupId,
  thread = null,
  members,
  replyTo,
  onCancelReply,
  onSent,
}: {
  groupId: string;
  /** Post in this top-level message's thread. */
  thread?: number | null;
  members: readonly Bot[];
  replyTo: GroupMessage | null;
  onCancelReply: () => void;
  onSent: () => void;
}) {
  const feedback = useFeedback();
  const draftKey = thread ? `group:${groupId}:thread:${thread}` : `group:${groupId}`;
  const [text, setText] = useState(() => getDraft(draftKey)?.text ?? "");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => getDraft(draftKey)?.attachments ?? []);
  const [sending, setSending] = useState(false);
  const [asTask, setAsTask] = useState(false);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const caretAfter = useRef<number | null>(null);

  useEffect(() => setDraft(draftKey, { text, attachments }), [draftKey, text, attachments]);
  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
    if (caretAfter.current !== null) {
      element.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
  }, [text]);

  const candidates = useMemo(() => {
    if (!query) return [];
    const all: Candidate[] = [...members.map((bot) => ({ id: bot.id, name: bot.name, bot })), EVERYONE];
    return mentionCandidates(all, query.query).slice(0, 8);
  }, [members, query]);
  const menuOpen = !!query && candidates.length > 0;

  const track = (value: string, caret: number) => {
    setText(value);
    const next = mentionQuery(value, caret);
    setQuery(next);
    if (next?.query !== query?.query) setActive(0);
  };

  const pick = (candidate: Candidate) => {
    const element = input.current;
    if (!query || !element) return;
    const inserted = insertMention(text, query, element.selectionStart ?? text.length, candidate.name);
    caretAfter.current = inserted.caret;
    setText(inserted.text);
    setQuery(null);
    element.focus();
  };

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
          const saved = await rpc(groupUploadRpc, { groupId, fileName: file.name, dataBase64: base64Of(await readAs(file, "dataUrl")) });
          setAttachments((current) => [...current, { kind: "file", id: newAttachmentId(), name: file.name, mimeType, size: saved.size, path: saved.path }]);
        }
      } catch (error) {
        feedback.error(`${file.name}: ${errorText(error)}`);
      }
    }
  };

  const hasContent = !!text.trim() || attachments.length > 0;
  const submit = async () => {
    if (!hasContent || sending) return;
    const kept = { text, attachments };
    setText("");
    setAttachments([]);
    setQuery(null);
    setSending(true);
    try {
      await rpc(groupSendRpc, { groupId, text: kept.text.trim(), replyTo: replyTo?.seq ?? null, thread, attachments: kept.attachments, ...(asTask && !thread ? { asTask: true } : {}) });
      setAsTask(false);
      onSent();
    } catch (error) {
      setText((current) => current || kept.text);
      setAttachments((current) => (current.length ? current : kept.attachments));
      feedback.error(`Couldn't send: ${errorText(error)}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer-wrap">
      {menuOpen ? (
        <div className="command-menu" role="listbox">
          {candidates.map((candidate, index) => (
            <div
              key={candidate.id}
              role="option"
              aria-selected={index === active}
              className={`list-item${index === active ? " active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(candidate)}
            >
              {candidate.bot ? <Avatar avatar={candidate.bot.avatar} size={20} /> : <Icon name="users" size={16} />}
              <span>@{candidate.name}</span>
              <span className="spacer" />
              <span className="hint truncate">{candidate.bot ? candidate.bot.title : "Every bot in the group"}</span>
            </div>
          ))}
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
        {replyTo ? (
          <div className="reply-chip">
            <Icon name="reply" size={13} />
            <span className="truncate grow">
              Replying to <strong>{senderName(replyTo)}</strong>: {messagePreview(replyTo, 90)}
            </span>
            <IconButton icon="x" size={12} title="Cancel reply" onClick={onCancelReply} />
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
          placeholder={replyTo && replyTo.from.kind === "bot" ? `Reply to ${replyTo.from.name}` : thread ? "Reply in thread · @ to bring a bot in" : "Message the group · @ to pick a bot"}
          onChange={(event) => track(event.target.value, event.target.selectionStart ?? event.target.value.length)}
          onSelect={(event) => {
            const element = event.currentTarget;
            const next = mentionQuery(element.value, element.selectionStart ?? element.value.length);
            if (next?.start !== query?.start || next?.query !== query?.query) setQuery(next);
          }}
          onBlur={() => setQuery(null)}
          onPaste={(event) => {
            const pasted = Array.from(event.clipboardData.files);
            if (pasted.length) {
              event.preventDefault();
              void addFiles(pasted);
            }
          }}
          onKeyDown={(event) => {
            const composing = event.nativeEvent.isComposing || event.keyCode === 229;
            if (menuOpen && !composing) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((index) => (index + step + candidates.length) % candidates.length);
                return;
              }
              if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                event.preventDefault();
                pick(candidates[Math.min(active, candidates.length - 1)]!);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery(null);
                return;
              }
            }
            if (event.key === "Escape" && replyTo) {
              onCancelReply();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !composing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="bar">
          <IconButton icon="paperclip" title="Attach files" onClick={() => files.current?.click()} />
          <IconButton
            icon="atSign"
            title="Mention a bot"
            onClick={() => {
              const element = input.current;
              if (!element) return;
              const caret = element.selectionStart ?? text.length;
              const needsSpace = caret > 0 && !/\s/.test(text[caret - 1]!);
              const value = `${text.slice(0, caret)}${needsSpace ? " " : ""}@${text.slice(caret)}`;
              caretAfter.current = caret + (needsSpace ? 2 : 1);
              track(value, caret + (needsSpace ? 2 : 1));
              element.focus();
            }}
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
          {thread ? null : (
            <button
              type="button"
              className={`chip-toggle${asTask ? " on" : ""}`}
              aria-pressed={asTask}
              title={asTask ? "Will be sent as a task (todo, unassigned)" : "Send as a task: todo, unassigned, for a bot to claim"}
              onClick={() => setAsTask((on) => !on)}
            >
              <Icon name="listTodo" size={13} /> As task
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn small primary" disabled={!hasContent || sending} onClick={() => void submit()} title="Send (Enter)">
            {sending ? <span className="spinner" /> : <Icon name="send" size={13} />}
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
