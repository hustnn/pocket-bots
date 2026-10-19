import type { ComposerAttachment } from "../../shared/attachments";
import type { SlashCommand } from "../../shared/rpc";

// The composer's rules: what a message does while the bot works, the context window meter, the
// slash command menu, and the drafts each chat keeps.

// ---------------------------------------------------------------- send behavior

/** What a message sent while the bot works does: steer the turn, interrupt it, or wait its turn. */
export type SendBehavior = "steer" | "interrupt" | "queue";
export const DEFAULT_SEND_BEHAVIOR: SendBehavior = "steer";

export function parseSendBehavior(value: unknown): SendBehavior {
  return value === "steer" || value === "interrupt" || value === "queue" ? value : DEFAULT_SEND_BEHAVIOR;
}

/** Queueing behind a permission prompt would strand the message, so it interrupts instead. */
export function resolveActiveSendBehavior(behavior: SendBehavior, hasPendingPermission: boolean): SendBehavior {
  return behavior === "queue" && hasPendingPermission ? "interrupt" : behavior;
}

/** What happens to a message that arrives mid-turn. */
export function activeTurnBehaviorFor(behavior: SendBehavior): "steer" | "interrupt" {
  return behavior === "steer" ? "steer" : "interrupt";
}

export type SendAction = "send" | "queue";

/** Enter and the send button. */
export function resolveDefaultAction(input: { behavior: SendBehavior; running: boolean; canQueue: boolean }): SendAction {
  return input.behavior === "queue" && input.running && input.canQueue ? "queue" : "send";
}

/** Cmd/Ctrl+Enter: the other choice while the bot works (queue when sending steers or interrupts, send when it queues). */
export function resolveAlternateAction(input: { behavior: SendBehavior; running: boolean; canQueue: boolean }): SendAction | null {
  if (!input.running) return null;
  if (input.behavior === "queue") return "send";
  return input.canQueue ? "queue" : null;
}

/** The send button's label for what it will do. */
export function sendLabel(input: { action: SendAction; behavior: SendBehavior; running: boolean }): "Send" | "Steer" | "Interrupt" | "Queue" {
  if (input.action === "queue") return "Queue";
  if (!input.running) return "Send";
  return input.behavior === "interrupt" ? "Interrupt" : input.behavior === "steer" ? "Steer" : "Send";
}

// ---------------------------------------------------------------- context window meter

export interface ContextUsage {
  percent: number;
  used: number;
  max: number;
  costUsd: number | null;
}

/** Only valid numbers produce a reading. */
export function contextUsage(
  usage: { contextWindowMaxTokens?: number | null; contextWindowUsedTokens?: number | null; totalCostUsd?: number | null } | null | undefined,
): ContextUsage | null {
  const max = usage?.contextWindowMaxTokens;
  const used = usage?.contextWindowUsedTokens;
  if (typeof max !== "number" || typeof used !== "number" || !Number.isFinite(max) || max <= 0 || !Number.isFinite(used) || used < 0) return null;
  const cost = usage?.totalCostUsd;
  return { percent: Math.min(100, (used / max) * 100), used, max, costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null };
}

/** The meter's colours: danger above 90%, warning from 70%. */
export function meterTone(percent: number): "danger" | "warning" | "normal" {
  if (percent > 90) return "danger";
  if (percent >= 70) return "warning";
  return "normal";
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return Math.round(value).toString();
}

export function formatCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

// ---------------------------------------------------------------- slash commands

/** The partial command name while the draft is a lone `/word` being typed, else null. */
export function commandQuery(text: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

/** pocket-bots's own commands first; a provider command with the same name is hidden. */
export function withOwnCommands(own: readonly SlashCommand[], provider: readonly SlashCommand[]): SlashCommand[] {
  const taken = new Set(own.map((command) => command.name));
  return [...own, ...provider.filter((command) => !taken.has(command.name))];
}

/**
 * Prefix matches first, then substring matches, each alphabetical. `pinned`
 * names (the app's own) lead their group, so a long provider list can't push
 * them past the limit. Names starting with "__" are provider internals.
 */
export function filterCommands(commands: readonly SlashCommand[], query: string, { limit = 50, pinned = [] }: { limit?: number; pinned?: readonly string[] } = {}): SlashCommand[] {
  const q = query.toLowerCase();
  const prefix: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith("__")) continue;
    if (name.startsWith(q)) prefix.push(command);
    else if (q && name.includes(q)) contains.push(command);
  }
  const rank = (command: SlashCommand) => (pinned.includes(command.name) ? 0 : 1);
  const order = (a: SlashCommand, b: SlashCommand) => rank(a) - rank(b) || a.name.localeCompare(b.name);
  return [...prefix.sort(order), ...contains.sort(order)].slice(0, limit);
}

export function applyCommand(command: SlashCommand): string {
  return `/${command.name} `;
}

// ---------------------------------------------------------------- drafts

export interface ComposerDraft {
  text: string;
  attachments: ComposerAttachment[];
  updatedAt: number;
}

/** One draft per chat; a bot's new, unstarted chat has one of its own. */
export function draftKey(botId: string, chatId: string | null): string {
  return chatId ? `chat:${chatId}` : `new:${botId}`;
}

export function isDraftEmpty(draft: { text: string; attachments: readonly unknown[] } | null | undefined): boolean {
  return !draft || (draft.text.length === 0 && draft.attachments.length === 0);
}

const MAX_DRAFTS = 50;
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

function isAttachment(value: unknown): value is ComposerAttachment {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.size !== "number") return false;
  if (entry.kind === "image") return typeof entry.data === "string" && typeof entry.mimeType === "string";
  if (entry.kind === "text") return typeof entry.text === "string";
  if (entry.kind === "file") return typeof entry.path === "string" && typeof entry.mimeType === "string";
  return false;
}

/** Stored drafts, skipping anything malformed or empty. */
export function parseDrafts(raw: string | null | undefined): Record<string, ComposerDraft> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const drafts: Record<string, ComposerDraft> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      const text = typeof entry.text === "string" ? entry.text : "";
      const attachments = Array.isArray(entry.attachments) ? entry.attachments.filter(isAttachment) : [];
      const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
      if (!isDraftEmpty({ text, attachments })) drafts[key] = { text, attachments, updatedAt };
    }
    return drafts;
  } catch {
    return {};
  }
}

/**
 * Keeps the newest drafts and, when they'd outgrow browser storage, drops image
 * data from the oldest drafts first (text and other attachments always stay).
 */
export function serializeDrafts(drafts: Record<string, ComposerDraft>, limits: { maxDrafts?: number; maxBytes?: number } = {}): string {
  const maxDrafts = limits.maxDrafts ?? MAX_DRAFTS;
  const maxBytes = limits.maxBytes ?? MAX_DRAFT_BYTES;
  const entries = Object.entries(drafts)
    .filter(([, draft]) => !isDraftEmpty(draft))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, maxDrafts);
  let json = JSON.stringify(Object.fromEntries(entries));
  for (let index = entries.length - 1; index >= 0 && json.length > maxBytes; index--) {
    const [key, draft] = entries[index]!;
    if (!draft.attachments.some((attachment) => attachment.kind === "image")) continue;
    entries[index] = [key, { ...draft, attachments: draft.attachments.filter((attachment) => attachment.kind !== "image") }];
    json = JSON.stringify(Object.fromEntries(entries.filter(([, value]) => !isDraftEmpty(value))));
  }
  return json;
}

/** A failed send puts its text and attachments back; anything typed meanwhile follows it instead of being lost. */
export function restoreFailedSend(
  failed: { text: string; attachments: ComposerAttachment[] },
  current: { text: string; attachments: ComposerAttachment[] },
): { text: string; attachments: ComposerAttachment[] } {
  const typed = current.text.trim();
  const text = !typed ? failed.text : !failed.text ? current.text : `${failed.text}\n${current.text}`;
  const ids = new Set(failed.attachments.map((attachment) => attachment.id));
  return { text, attachments: [...failed.attachments, ...current.attachments.filter((attachment) => !ids.has(attachment.id))] };
}
