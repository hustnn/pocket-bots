import type { ComposerAttachment } from "../../shared/attachments";
import { isDraftEmpty, parseDrafts, serializeDrafts, type ComposerDraft } from "../chat/composer";

// What's typed in each chat's composer, kept in this browser so switching
// chats or reloading doesn't lose it. Saved a moment after the last change.

const STORAGE_KEY = "pocket.drafts";
const PERSIST_MS = 200;

function load(): Record<string, ComposerDraft> {
  try {
    return parseDrafts(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

let drafts: Record<string, ComposerDraft> = load();
let timer: ReturnType<typeof setTimeout> | null = null;

export function getDraft(key: string): ComposerDraft | null {
  return drafts[key] ?? null;
}

export function setDraft(key: string, draft: { text: string; attachments: ComposerAttachment[] }): void {
  const current = drafts[key];
  if (isDraftEmpty(draft)) {
    if (!current) return;
    const { [key]: _removed, ...rest } = drafts;
    drafts = rest;
  } else {
    if (current && current.text === draft.text && current.attachments === draft.attachments) return;
    drafts = { ...drafts, [key]: { text: draft.text, attachments: draft.attachments, updatedAt: Date.now() } };
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      window.localStorage.setItem(STORAGE_KEY, serializeDrafts(drafts));
    } catch {
      // Storage blocked or full; drafts still hold for this page.
    }
  }, PERSIST_MS);
}
