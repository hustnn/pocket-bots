// Pure sidebar logic: each chat's status bucket and unread dot, group limits
// and the user's manual order. (Adapted from Apache-2.0 code; see NOTICE.)

import type { ChatReadMark } from "./bot";

/** The sidebar's status buckets, most urgent first. */
export type ChatBucket = "needs_input" | "failed" | "running" | "attention" | "done";

export interface ChatBucketInput {
  status: string;
  pendingPermissions?: readonly unknown[] | null;
  requiresAttention?: boolean | null;
  attentionReason?: string | null;
  attentionTimestamp?: string | null;
  lastUserMessageAt?: string | null;
}

/** A chat whose turn is over, so what it shows is what there is to read. */
export function chatSettled(agent: Pick<ChatBucketInput, "status" | "pendingPermissions">): boolean {
  return (agent.status === "idle" || agent.status === "error" || agent.status === "closed") && (agent.pendingPermissions?.length ?? 0) === 0;
}

/** The read mark for a chat the user is looking at now. */
export function readMark(agent: ChatBucketInput, at: string): ChatReadMark {
  return { message: agent.lastUserMessageAt ?? null, attention: agent.attentionTimestamp ?? null, at };
}

/** Whether `mark` was taken from the chat as it is now: no turn and no new attention since. */
export function readMarkCurrent(agent: ChatBucketInput, mark: ChatReadMark | null | undefined): boolean {
  return !!mark && mark.message === (agent.lastUserMessageAt ?? null) && mark.attention === (agent.attentionTimestamp ?? null);
}

/**
 * Whether the chat has something the user hasn't seen. A chat raises attention
 * when a turn ends; the user's mark records what they saw: the chat is read
 * while it still shows the same latest message (no turn since) and the same
 * attention (none raised since). Both are the server's own timestamps, so no
 * clocks are compared.
 */
export function chatUnread(agent: ChatBucketInput, mark?: ChatReadMark | null): boolean {
  return !!agent.requiresAttention && !readMarkCurrent(agent, mark);
}

/**
 * The chat's bucket: permission beats error beats running; initializing is
 * not running. An error attention left over from an earlier turn is no failure once the chat is past it, just an unread chat; and an
 * attention the user has seen (`mark`) is no dot at all.
 */
export function chatBucket(agent: ChatBucketInput, mark?: ChatReadMark | null): ChatBucket {
  if ((agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission") return "needs_input";
  if (agent.status === "error") return "failed";
  if (agent.status === "running") return "running";
  if (chatUnread(agent, mark)) return "attention";
  return "done";
}

/** How many read marks the list keeps; the chats seen longest ago drop off first. */
export const READ_MARKS_KEPT = 500;

/** The read marks with the chat's mark set, keeping the newest READ_MARKS_KEPT. */
export function withReadMark(marks: Readonly<Record<string, ChatReadMark>>, chatId: string, mark: ChatReadMark): Record<string, ChatReadMark> {
  const entries = Object.entries({ ...marks, [chatId]: mark });
  if (entries.length <= READ_MARKS_KEPT) return Object.fromEntries(entries);
  return Object.fromEntries(entries.sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at)).slice(0, READ_MARKS_KEPT));
}

/**
 * Collapsed-group priority (STATUS_BUCKET_PRIORITY): unlike the listing order,
 * running outranks attention so a working bot keeps its ring.
 */
const AGGREGATE_PRIORITY: readonly ChatBucket[] = ["needs_input", "failed", "running", "attention", "done"];

export function aggregateBuckets(buckets: Iterable<ChatBucket>): ChatBucket {
  let best = AGGREGATE_PRIORITY.length - 1;
  for (const bucket of buckets) {
    const rank = AGGREGATE_PRIORITY.indexOf(bucket);
    if (rank !== -1 && rank < best) best = rank;
  }
  return AGGREGATE_PRIORITY[best] ?? "done";
}

export const BUCKET_LABELS: Record<ChatBucket, string> = {
  needs_input: "Needs input",
  failed: "Failed",
  attention: "Ready to review",
  running: "Working",
  done: "Done",
};

/** Groups longer than this get "Show more". */
export const SIDEBAR_GROUP_LIMIT = 20;

/**
 * The user's manual order: items keep their base order, except that the
 * items named in `storedOrder` fill their own slots in the stored order. New
 * items therefore appear where the base order puts them and never reshuffle
 * the ones the user arranged.
 */
export function applyStoredOrdering<T>(items: readonly T[], storedOrder: readonly string[], getKey: (item: T) => string): T[] {
  if (items.length <= 1 || storedOrder.length === 0) return [...items];
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(getKey(item), item);
  const pruned: string[] = [];
  const seen = new Set<string>();
  for (const key of storedOrder) {
    if (!byKey.has(key) || seen.has(key)) continue;
    seen.add(key);
    pruned.push(key);
  }
  if (pruned.length === 0) return [...items];
  const ordered: T[] = [];
  let index = 0;
  for (const item of items) {
    const key = getKey(item);
    if (!seen.has(key)) {
      ordered.push(item);
      continue;
    }
    const target = pruned[index] ?? key;
    index += 1;
    ordered.push(byKey.get(target) ?? item);
  }
  return ordered;
}

export type ChatSort = "manual" | "activity";

export interface OrderableChat {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Chat order within a bot. "manual" starts from newest-created first and
 * applies the stored order, so rows don't jump when a chat gets a reply;
 * "activity" is most recently updated first.
 */
export function orderChats<T extends OrderableChat>(chats: readonly T[], sort: ChatSort, storedOrder: readonly string[] = []): T[] {
  if (sort === "activity") return [...chats].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const base = [...chats].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return applyStoredOrdering(base, storedOrder, (chat) => chat.id);
}

/** Moves `key` one step within `keys` (the full visible order). Returns null at an edge or when missing. */
export function moveKey(keys: readonly string[], key: string, delta: -1 | 1): string[] | null {
  const index = keys.indexOf(key);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= keys.length) return null;
  const next = [...keys];
  next[index] = keys[target]!;
  next[target] = key;
  return next;
}
