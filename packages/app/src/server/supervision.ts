// How pocket-bots watches over its chats' runtimes: the start queue, its limits and the timeouts.
// ChatService uses these for every chat, a group's seats included; docs/design.md lists them.

/**
 * Runtimes starting at once. A group has at most 6 bots, so one @everyone starts every member
 * at once.
 */
export const MAX_CONCURRENT_STARTS = 6;
/** One start begins at least this long after the last (a chat starting again right after itself doesn't wait). */
export const START_INTERVAL_MS = 500;
/** A start shows a runtime event within this long, or fails (no chat stays on "starting" forever). */
export const RUNTIME_START_TIMEOUT_MS = 2 * 60_000;
/** How long an idle write may go without the runtime showing the turn. */
export const TURN_START_OBSERVATION_MS = 30_000;
/** How often a running chat's progress is looked at. */
export const PROGRESS_CHECK_MS = 60_000;
/** A running turn with no runtime event for this long is checked for a stall. */
export const RUNTIME_PROGRESS_STALE_MS = 15 * 60_000;
/** A busy chat this quiet whose runtime shows no live turn missed its turn's end. */
export const BUSY_STALE_MS = 10 * 60_000;
/** A stalled runtime SIGTERM didn't stop is killed after this long. */
export const STALLED_RECOVERY_SIGTERM_TIMEOUT_MS = 10_000;
/** A compaction should finish within this long; a missing finish is said. */
export const COMPACTION_STALE_MS = 5 * 60_000;
/** Failed compactions in a row that stop a session being resumed. */
export const SESSION_NEEDS_RESET_THRESHOLD = 3;
/** Where a failed compaction is counted: Pi, whose compaction is one request that can outgrow the model. */
export const COMPACTION_LEDGER_RUNTIMES: ReadonlySet<string> = new Set(["pi"]);

/** What a chat says when its runtime didn't finish starting. */
export function startTimeoutText(runtime: string): string {
  return `${runtime} did not finish starting on this machine. Check that ${runtime} is installed, logged in, and can run non-interactively, then retry starting this agent.`;
}

/** What a chat says when its run stalled. */
export function stallText(minutes: number, queued: number): string {
  return `Runtime stalled: no runtime events for ${minutes}m${queued ? ` (queued=${queued})` : ""}`;
}

/** What a chat says when its session can't be resumed, and what pocket-bots does about it. */
export function sessionResetText(runtime: string, failures: number): string {
  return `The ${runtime} session failed context compaction ${failures} times in a row and can't be resumed (its conversation no longer fits the model), so this chat started a new session. The earlier conversation isn't in it.`;
}

/**
 * Starts wait their turn in one queue for the whole process (every
 * group and chat), at most `maxConcurrent` at once, and each begins at least `intervalMs` after
 * the one before, unless it's the same chat starting again. A start holds its slot until its
 * runtime is open and its first input written.
 */
export class StartCoordinator {
  private readonly queue: { chatId: string; resolve: (release: () => void) => void; reject: (error: Error) => void }[] = [];
  private active = 0;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  private lastChatId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly maxConcurrent = MAX_CONCURRENT_STARTS,
    readonly intervalMs = START_INTERVAL_MS,
  ) {}

  /** Resolves with the function that gives the slot back, once this start may begin. */
  acquire(chatId: string): Promise<() => void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ chatId, resolve, reject });
      this.pump();
    });
  }

  /** A queued start that's no longer wanted (its chat closed); false when it isn't queued. */
  cancel(chatId: string, reason: string): boolean {
    const index = this.queue.findIndex((item) => item.chatId === chatId);
    if (index < 0) return false;
    const [item] = this.queue.splice(index, 1);
    item!.reject(new Error(reason));
    if (this.queue.length === 0) this.clearTimer();
    return true;
  }

  /** Every queued start (pocket-bots is stopping). */
  cancelAll(reason: string): void {
    for (const item of this.queue.splice(0)) item.reject(new Error(reason));
    this.clearTimer();
  }

  snapshot(): { active: number; queued: string[] } {
    return { active: this.active, queued: this.queue.map((item) => item.chatId) };
  }

  private pump(): void {
    if (this.timer || this.queue.length === 0 || this.active >= this.maxConcurrent) return;
    const next = this.queue[0]!;
    const wait = next.chatId === this.lastChatId ? 0 : Math.max(0, this.intervalMs - (Date.now() - this.lastStartAt));
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      this.timer.unref?.();
      return;
    }
    this.queue.shift();
    this.active++;
    this.lastStartAt = Date.now();
    this.lastChatId = next.chatId;
    let released = false;
    next.resolve(() => {
      if (released) return;
      released = true;
      this.active--;
      this.pump();
    });
    this.pump();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** A chat's failed compactions in a row (ids, a model and a count; never conversation content). */
export interface CompactionFailures {
  sessionId: string;
  model: string | null;
  count: number;
  updatedAt: string;
}

/** One more failure of this session on this model, or the first of a new one. */
export function countCompactionFailure(current: CompactionFailures | null, sessionId: string, model: string | null, at: string): CompactionFailures {
  const same = current !== null && current.sessionId === sessionId && current.model === model;
  return { sessionId, model, count: same ? current.count + 1 : 1, updatedAt: at };
}

/** The count when resuming this session on this model must be refused, else null (another session or model clears it). */
export function sessionNeedsReset(current: CompactionFailures | null, sessionId: string, model: string | null): number | null {
  if (!current || current.sessionId !== sessionId || current.model !== model) return null;
  return current.count >= SESSION_NEEDS_RESET_THRESHOLD ? current.count : null;
}
