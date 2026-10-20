// Extra folders: folders besides its working folder that a chat (or a group's seats) may use. The
// agent is told about them in its system prompt, and when the list changes under a resumed
// session (Claude Code and Codex keep the first prompt) in front of its next input, the way a
// standing-prompt update is (standing-prompt.ts). Claude gets them natively as additional
// directories, Codex as writable roots of its sandbox; the other CLIs reach them by path.

/** How many extra folders a chat or a group takes. */
export const MAX_EXTRA_FOLDERS = 20;

/** What the agent is told about the list, in its system prompt and in an update. */
export function extraFoldersText(folders: readonly string[]): string {
  if (folders.length === 0) return "The user removed this chat's extra folders; the folders listed before are no longer part of this chat.";
  return [
    "The user added these folders to this chat besides your working folder. You can read and work in them by their absolute paths; actions there may need the user's approval, as in the working folder.",
    ...folders.map((folder) => `- ${folder}`),
  ].join("\n");
}

const OPEN = "<pocket-bots-folders-update>";
const CLOSE = "</pocket-bots-folders-update>";
const INTRO = "pocket-bots changed this chat's extra folders since this session started. The list below replaces the earlier one for the rest of this session.";

/** The note put in front of the input after the list changed. */
export function foldersUpdate(folders: readonly string[]): string {
  return [OPEN, INTRO, "", extraFoldersText(folders), CLOSE, "", ""].join("\n");
}

/** An input taken apart: the folders note in front of it (null without one) and the input itself. */
export function splitFoldersUpdate(text: string): { folders: string | null; text: string } {
  const end = text.indexOf(CLOSE);
  if (!text.startsWith(OPEN) || end < 0) return { folders: null, text };
  const inner = text.slice(OPEN.length, end).trim();
  const folders = inner.startsWith(INTRO) ? inner.slice(INTRO.length).trim() : inner;
  return { folders, text: text.slice(end + CLOSE.length).trimStart() };
}
