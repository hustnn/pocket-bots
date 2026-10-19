// What stops automatic wakes of a bot whose runtime keeps ending in failure: the terminal-failure
// breaker with its spawn-error backoff, and the crash-loop breaker's early-exit rule. They're
// per seat (group:bot) and in memory, like the delivery waits. A seat's inbox keeps what it's
// owed, so a paused bot misses nothing: its next start tells it everything.

/** Terminal failures in a row with the same fingerprint that open the breaker. */
export const TERMINAL_FAILURE_SAME_FP_THRESHOLD = 2;
/** Terminal failures in a row, any fingerprint, with no completed turn between, that open it. */
export const TERMINAL_FAILURE_TOTAL_THRESHOLD = 3;
/** The wait once open: 1 h, then 4 h, then 24 h (the last step is the cap). */
export const TERMINAL_FAILURE_BACKOFF_MS: readonly number[] = [3_600_000, 4 * 3_600_000, 24 * 3_600_000];
/** How long a probe owns the breaker before its lease lapses back to open. */
export const TERMINAL_FAILURE_PROBE_LEASE_MS = 30 * 60_000;
/** Spawn errors: after the n-th start in a row that never created a runtime, 5 min × 2^(n-1), at most 6 h. */
export const TERMINAL_SPAWN_ERROR_BACKOFF_BASE_MS = 5 * 60_000;
export const TERMINAL_SPAWN_ERROR_BACKOFF_MAX_MS = 6 * 3_600_000;
/** Spawn errors: the retry sweep's fixed extra delay per seat, in [0, this). */
export const TERMINAL_SPAWN_ERROR_RETRY_JITTER_MAX_MS = 60_000;
/** Early exits: a runtime that ends this soon after its start exited early. */
export const WAKE_CRASH_LOOP_WINDOW_MS = 60_000;
/** Early exits in a row that stop automatic wakes until a manual start. */
export const WAKE_CRASH_LOOP_THRESHOLD = 3;

export type BreakerRefusal = "terminal_failure_paused" | "terminal_failure_probe_in_flight";

export interface TerminalBreaker {
  state: "closed" | "open" | "half_open";
  sameFingerprint: { fingerprint: string; count: number } | null;
  /** Terminal failures in a row with no completed turn between. */
  totalCount: number;
  /** Index into TERMINAL_FAILURE_BACKOFF_MS. */
  backoffStep: number;
  /** Open: no automatic start before this. */
  blockedUntil: number | null;
  /** Half open: when the probe's lease lapses. */
  leaseUntil: number | null;
  /** The last failure's kind, for the paused notice (`fingerprint_fence`, `sticky_runtime_error`, `spawn_error`). */
  lastFailureKind: string | null;
  /** Starts in a row that never created a runtime. */
  spawnErrors: number;
  /** A wake was refused (or a start failed) and nothing has served it yet. */
  wakeDemand: boolean;
  /** The paused notice last shown, so each block is shown once. */
  shown: string | null;
}

export function freshBreaker(): TerminalBreaker {
  return { state: "closed", sameFingerprint: null, totalCount: 0, backoffStep: 0, blockedUntil: null, leaseUntil: null, lastFailureKind: null, spawnErrors: 0, wakeDemand: false, shown: null };
}

const backoffMs = (step: number) => TERMINAL_FAILURE_BACKOFF_MS[Math.min(step, TERMINAL_FAILURE_BACKOFF_MS.length - 1)]!;
const nextStep = (step: number) => Math.min(step + 1, TERMINAL_FAILURE_BACKOFF_MS.length - 1);

function resetCounts(breaker: TerminalBreaker): void {
  breaker.sameFingerprint = null;
  breaker.totalCount = 0;
  breaker.backoffStep = 0;
}

/** The spawn-error wait: 5 min × 2^(count-1), at most 6 h. */
export function spawnErrorBackoffMs(count: number): number {
  return Math.min(TERMINAL_SPAWN_ERROR_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(count, 1) - 1, 30), TERMINAL_SPAWN_ERROR_BACKOFF_MAX_MS);
}

/** The seat's fixed extra delay before the sweep retries (an FNV-1a hash of its id). */
export function spawnErrorRetryJitterMs(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % TERMINAL_SPAWN_ERROR_RETRY_JITTER_MAX_MS;
}

/** Lazy lease expiry: a probe that reported nothing by its lease's end leaves the breaker open, one step longer. */
export function normalizeBreaker(breaker: TerminalBreaker, now: number): void {
  if (breaker.state !== "half_open" || breaker.leaseUntil === null || now < breaker.leaseUntil) return;
  breaker.backoffStep = nextStep(breaker.backoffStep);
  breaker.blockedUntil = breaker.leaseUntil + backoffMs(breaker.backoffStep);
  breaker.leaseUntil = null;
  breaker.state = "open";
}

/**
 * A terminal failure: counted while closed, opening the breaker at
 * 2 with the same fingerprint or 3 in all; a probe's failure opens it one step longer. Open, it's
 * already counted. Returns whether it opened now.
 */
export function noteTerminalFailure(breaker: TerminalBreaker, failure: { kind: string; fingerprint: string }, now: number): boolean {
  normalizeBreaker(breaker, now);
  if (breaker.state === "open") return false;
  breaker.sameFingerprint = breaker.sameFingerprint?.fingerprint === failure.fingerprint ? { fingerprint: failure.fingerprint, count: breaker.sameFingerprint.count + 1 } : { fingerprint: failure.fingerprint, count: 1 };
  breaker.totalCount++;
  breaker.lastFailureKind = failure.kind;
  if (breaker.state === "half_open") {
    breaker.backoffStep = nextStep(breaker.backoffStep);
    breaker.blockedUntil = now + backoffMs(breaker.backoffStep);
    breaker.leaseUntil = null;
    breaker.state = "open";
    return true;
  }
  if (breaker.sameFingerprint.count < TERMINAL_FAILURE_SAME_FP_THRESHOLD && breaker.totalCount < TERMINAL_FAILURE_TOTAL_THRESHOLD) return false;
  breaker.backoffStep = 0;
  breaker.blockedUntil = now + backoffMs(0);
  breaker.state = "open";
  return true;
}

/** A completed turn: the counts and the spawn errors start over, and a probe's success closes it. */
export function noteTurnCompleted(breaker: TerminalBreaker, now: number): void {
  normalizeBreaker(breaker, now);
  resetCounts(breaker);
  breaker.spawnErrors = 0;
  breaker.wakeDemand = false;
  breaker.state = "closed";
  breaker.blockedUntil = null;
  breaker.leaseUntil = null;
}

/**
 * An automatic start (claimTerminalStart): closed passes; open past its wait passes as the one
 * probe, under a lease; a probe in flight or a wait not over refuses it, and the refused wake is
 * demand the spawn-error sweep may serve.
 */
export function claimAutomaticStart(breaker: TerminalBreaker, now: number): BreakerRefusal | null {
  normalizeBreaker(breaker, now);
  if (breaker.state === "half_open") {
    breaker.wakeDemand = true;
    return "terminal_failure_probe_in_flight";
  }
  if (breaker.state === "open") {
    if (breaker.blockedUntil !== null && now < breaker.blockedUntil) {
      breaker.wakeDemand = true;
      return "terminal_failure_paused";
    }
    breaker.state = "half_open";
    breaker.leaseUntil = now + TERMINAL_FAILURE_PROBE_LEASE_MS;
  }
  return null;
}

/** A manual start: whatever the breaker holds, it's lifted. The spawn-error evidence stays. */
export function liftBreaker(breaker: TerminalBreaker): void {
  resetCounts(breaker);
  breaker.state = "closed";
  breaker.blockedUntil = null;
  breaker.leaseUntil = null;
  breaker.wakeDemand = false;
}

/**
 * A start that never created a runtime opens the breaker for 5 min × 2^(n-1) (at most 6 h),
 * never shortening a wait already set; a probe's after terminal failures also takes the next step. Its wake wasn't served.
 */
export function noteSpawnError(breaker: TerminalBreaker, now: number): void {
  normalizeBreaker(breaker, now);
  breaker.spawnErrors++;
  breaker.lastFailureKind = "spawn_error";
  breaker.wakeDemand = true;
  let until = now + spawnErrorBackoffMs(breaker.spawnErrors);
  if (breaker.state === "open" && breaker.blockedUntil !== null) until = Math.max(until, breaker.blockedUntil);
  if (breaker.state === "half_open" && breaker.totalCount > 0) {
    breaker.backoffStep = nextStep(breaker.backoffStep);
    until = Math.max(until, now + backoffMs(breaker.backoffStep));
  }
  breaker.blockedUntil = until;
  breaker.leaseUntil = null;
  breaker.state = "open";
}

/** A runtime was created; the run of spawn errors is over. */
export function noteSpawned(breaker: TerminalBreaker): void {
  breaker.spawnErrors = 0;
}

/**
 * The sweep starts the seat again when only spawn errors opened
 * the breaker, a wake is waiting to be served, and the wait plus the seat's jitter is over.
 */
export function spawnRetryDue(breaker: TerminalBreaker, now: number, jitterMs: number): boolean {
  normalizeBreaker(breaker, now);
  return breaker.state === "open" && breaker.lastFailureKind === "spawn_error" && breaker.spawnErrors > 0 && breaker.totalCount === 0 && breaker.wakeDemand && breaker.blockedUntil !== null && now >= breaker.blockedUntil + jitterMs;
}

/**
 * The notice for a paused breaker, or null when nothing pauses it now. Each block is shown
 * once.
 */
export function pausedText(breaker: TerminalBreaker, now: number): string | null {
  normalizeBreaker(breaker, now);
  if (breaker.state !== "open" || breaker.blockedUntil === null || now >= breaker.blockedUntil) return null;
  const why = breaker.lastFailureKind ? ` after repeated runtime failures (${breaker.lastFailureKind})` : " after repeated runtime failures";
  return `Automatic wake paused until ${new Date(breaker.blockedUntil).toISOString()}${why}. The next message, reminder or manual start after that retries; a manual start lifts it now.`;
}

/** Early exits in a row since the last manual start, and whether they stopped automatic wakes. */
export interface CrashLoop {
  /** When the runtime last started (a new seat, or a stopped bot woken again); 0 when unknown. */
  startedAt: number;
  earlyExits: number;
  blocked: boolean;
}

export function freshCrashLoop(): CrashLoop {
  return { startedAt: 0, earlyExits: 0, blocked: false };
}

/**
 * A runtime ended within a minute of its start is an early
 * exit; one that ran longer resets the count and isn't counted. The third in a row stops
 * automatic wakes. Returns whether this one did.
 */
export function noteExit(loop: CrashLoop, now: number): boolean {
  if (loop.blocked) return false;
  if (loop.startedAt === 0 || now - loop.startedAt > WAKE_CRASH_LOOP_WINDOW_MS) {
    loop.earlyExits = 0;
    return false;
  }
  loop.earlyExits++;
  if (loop.earlyExits < WAKE_CRASH_LOOP_THRESHOLD) return false;
  loop.blocked = true;
  return true;
}
