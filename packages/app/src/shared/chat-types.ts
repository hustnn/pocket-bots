// What the server tells the UI about chats. Pure types: shared by server and web.
import type { ApprovalRequest, ContextUsage, ModeDef, ModelDef, ProviderId, TimelineItem } from "@pocket-bots/runtime/types";

export type { ApprovalDecision, ApprovalRequest, ContextUsage, ProviderId, TimelineItem } from "@pocket-bots/runtime/types";

export type ChatStatus = "initializing" | "idle" | "running" | "error" | "closed";

/** One chat (a bot's conversation, a group seat, a routine run) as the UI shows it. */
export interface ChatSnapshot {
  id: string;
  provider: ProviderId;
  model: string | null;
  cwd: string;
  title: string | null;
  labels: Record<string, string>;
  status: ChatStatus;
  /** Approvals waiting for the user. */
  pendingPermissions: ApprovalRequest[];
  lastError: string | null;
  lastUsage: ContextUsage | null;
  /** Why the chat wants the user's attention, until they look at it. */
  attentionReason: "finished" | "error" | "permission" | null;
  requiresAttention: boolean;
  /** When the attention was raised. */
  attentionTimestamp: string | null;
  /** The running turn, if any. */
  activeTurn: { id: string; startedAt: string } | null;
  createdAt: string;
  updatedAt: string;
  lastUserMessageAt: string | null;
  archivedAt: string | null;
}

export interface TimelineCursor {
  epoch: string;
  seq: number;
}

/** One timeline item; `seqStart` is stable while the item updates, `seqEnd` grows. */
export interface TimelineEntry {
  provider: ProviderId;
  item: TimelineItem;
  turnId?: string;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
}

export interface TimelinePage {
  entries: TimelineEntry[];
  startCursor: TimelineCursor | null;
  endCursor: TimelineCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  /** The cursor's epoch is gone: start over from the tail. */
  staleCursor?: boolean;
  reset?: boolean;
  gap?: boolean;
  error?: string;
  agent: ChatSnapshot | null;
}

export interface ProviderEntry {
  provider: ProviderId;
  label: string;
  status: "ready" | "unavailable" | "error";
  enabled: boolean;
  error?: string;
  version?: string;
  models: (ModelDef & { isSelectable?: boolean; defaultThinkingOptionId?: string })[];
  modes: ModeDef[];
  defaultModeId: string | null;
}

export interface ProvidersSnapshot {
  entries: ProviderEntry[];
}
