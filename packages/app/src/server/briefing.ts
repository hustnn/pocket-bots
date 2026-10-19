import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { TimelineEntry } from "../shared/chat-types";
import { messageText, type GroupMessage } from "../shared/group-chat";

// The briefing a renewed seat starts with: instead of resuming a big context whose prompt cache has
// gone cold, the new conversation gets the recent messages, the files in play (re-read now, so
// they show their current state) and the old conversation's last actions, within a token budget.

/** Token budgets: the whole panel, one message, the messages section. */
const PANEL_BUDGET_TOKENS = 8_000;
const MESSAGE_MAX_TOKENS = 2_000;
const MESSAGES_SECTION_CAP_TOKENS = 4_000;
const RECENT_ACTIONS = 12;
const MAX_PANEL_OBJECTS = 14;
/** Content shown of a file re-read now. */
const OBJECT_CONTENT_CAP_TOKENS = 700;
/** Files touched longer before the last action than this are out of play: a pointer, no content. */
const OBJECT_IN_PLAY_WINDOW_MS = 2 * 3_600_000;
const REREAD_FILE_MAX_BYTES = 64 * 1024;
/** Never put these files' contents in a briefing. */
const SENSITIVE_PATH = /(secret|credential|password|token|\.key$|\.pem$)/i;

/** A rough token count: about four characters each. */
const tokens = (text: string) => Math.ceil(text.length / 4);

/** Cut to a token budget on a line boundary, and say so. */
function clip(text: string, limit: number): string {
  if (tokens(text) <= limit) return text;
  let cut = text.slice(0, limit * 4);
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > cut.length / 2) cut = cut.slice(0, lastBreak);
  return `${cut}\n[… truncated]`;
}

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const clock = (at: string) => `${at.slice(11, 16)}Z`;

interface Action {
  at: string;
  line: string;
  failed: boolean;
  files: string[];
}

/** A tool call as one line of the action log, and the files it touched. */
function actionOf(entry: TimelineEntry): Action | null {
  const item = entry.item;
  if (item.type !== "tool_call") return null;
  const detail = item.detail;
  const action = (line: string, files: string[] = []): Action => ({ at: entry.timestamp, line, failed: item.status === "failed", files });
  switch (detail.type) {
    case "shell":
      return action(`shell: ${oneLine(detail.command, 120)}`);
    case "read":
    case "edit":
    case "write":
      return action(`${detail.type} ${detail.filePath}`, [detail.filePath]);
    case "search":
      return action(`${detail.toolName ?? "search"} ${oneLine(detail.query, 80)}`, detail.filePaths ?? []);
    case "fetch":
      return action(`fetch ${detail.url}`);
    case "unknown":
      return action(`${item.name} ${oneLine(JSON.stringify(detail.input ?? {}), 100)}`);
    default:
      return action(item.name);
  }
}

interface FileInPlay {
  path: string;
  touches: number;
  last: string;
}

async function reread(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > REREAD_FILE_MAX_BYTES) return null;
    const text = await readFile(path, "utf8");
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

export interface BriefingInput {
  /** Group messages the bot had seen, oldest first. */
  messages: readonly GroupMessage[];
  /** The old seat's timeline (its tool calls are the action log). */
  entries: readonly TimelineEntry[];
  /** The seat's working folder, for relative file paths. */
  cwd: string;
  meId: string;
  parents?: ReadonlyMap<number, GroupMessage>;
  /** Why the conversation was renewed: a cold, large one (the default), or a session that couldn't be resumed (its compaction kept failing). */
  reason?: "stale" | "reset";
}

/** The briefing: recent messages, files in play and recent actions, within its token budget. */
export async function briefingPanel(input: BriefingInput): Promise<string> {
  const sections: string[] = [];
  const lines = input.messages.map((message) => clip(messageText(message, input.meId, input.parents), MESSAGE_MAX_TOKENS));
  // Whole oldest messages drop first when the section is over its cap.
  while (lines.length > 1 && tokens(lines.join("\n\n")) > MESSAGES_SECTION_CAP_TOKENS) lines.shift();
  if (lines.length) sections.push('<recent-messages order="newest last" note="recent tail only; older messages not shown">', lines.join("\n\n"), "</recent-messages>", "");

  const actions = input.entries.flatMap((entry) => actionOf(entry) ?? []);
  const tail = actions.slice(-RECENT_ACTIONS);
  const tailSection = actions.length
    ? [`<recent-actions span="${tail.length} of ${actions.length}" order="oldest first">`, ...tail.map((action) => `- ${clock(action.at)} ${action.line}${action.failed ? " !failed" : ""}`), "</recent-actions>"]
    : [];

  // Files the old conversation touched, most recent first; those touched near its end are in play.
  const files = new Map<string, FileInPlay>();
  for (const action of actions) {
    for (const file of action.files) {
      const path = isAbsolute(file) ? file : join(input.cwd, file);
      const seen = files.get(path);
      files.set(path, { path, touches: (seen?.touches ?? 0) + 1, last: action.at });
    }
  }
  const lastAt = actions.length ? Date.parse(actions.at(-1)!.at) : 0;
  const objects = [...files.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, MAX_PANEL_OBJECTS);
  let left = PANEL_BUDGET_TOKENS - tokens(sections.join("\n")) - tokens(tailSection.join("\n")) - 60;
  const objectLines: string[] = [];
  for (const object of objects) {
    if (left <= 80) break;
    const pointer = `<object name="${object.path}" touched="${object.touches}x" last-observed="${object.last}"/>`;
    const inPlay = lastAt - Date.parse(object.last) <= OBJECT_IN_PLAY_WINDOW_MS;
    const body = inPlay && !SENSITIVE_PATH.test(object.path) ? await reread(object.path) : null;
    if (!body) {
      objectLines.push(pointer);
      left -= tokens(pointer);
      continue;
    }
    const shown = clip(body, Math.min(OBJECT_CONTENT_CAP_TOKENS, left));
    objectLines.push(`<object name="${object.path}" touched="${object.touches}x" freshness="current, re-read just now">`, shown, "</object>");
    left -= tokens(shown) + 30;
  }
  if (objectLines.length) sections.push("<objects-in-play>", ...objectLines, "</objects-in-play>", "");
  return [
    input.reason === "reset"
      ? "This conversation for the group was renewed: the old one couldn't be compacted to fit the model any more, so it can't be resumed. Where you were:"
      : "This conversation for the group was renewed: the old one had been idle past its prompt cache with a large context, and starting fresh costs less than resuming it. Where you were:",
    "",
    ...sections,
    ...tailSection,
  ]
    .join("\n")
    .trimEnd();
}
