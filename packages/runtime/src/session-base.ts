import { randomUUID } from "node:crypto";
import type { ContextUsage, ProviderId, ResumeHandle, RuntimeEvent, SendOptions, SendResult, SessionState, SlashCommand, UserInput } from "./types.ts";

type Listener = (event: RuntimeEvent) => void;

/**
 * Bookkeeping every adapter shares: listeners, state, the running turn, and a local queue for
 * `whenBusy: "queue"` sends, which start as the next turn once the running one ends.
 */
export abstract class SessionBase {
  abstract readonly provider: ProviderId;
  protected listeners = new Set<Listener>();
  protected currentState: SessionState = "starting";
  protected turnId: string | null = null;
  protected resumeHandle: ResumeHandle | null = null;
  protected lastUsage: ContextUsage | null = null;
  private queued: { input: UserInput; options: SendOptions }[] = [];
  private turnWaiters: ((turnId: string) => void)[] = [];

  get state(): SessionState {
    return this.currentState;
  }

  /** The agent's slash commands; none unless the adapter knows how to list them. */
  async commands(): Promise<SlashCommand[]> {
    return [];
  }

  get activeTurnId(): string | null {
    return this.turnId;
  }

  get handle(): ResumeHandle | null {
    return this.resumeHandle;
  }

  usage(): ContextUsage | null {
    return this.lastUsage;
  }

  /** Unknown unless the adapter has the runtime's process. */
  alive(): boolean | undefined {
    return undefined;
  }

  /** Nothing to signal unless the adapter has the runtime's process. */
  kill(_signal: "SIGTERM" | "SIGKILL"): void {}

  abandonTurn(): void {
    if (this.turnId) this.endTurn("canceled");
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(`runtime(${this.provider}): a listener failed`, error);
      }
    }
  }

  protected setHandle(handle: ResumeHandle): void {
    if (this.resumeHandle?.sessionId === handle.sessionId) return;
    this.resumeHandle = handle;
    this.emit({ type: "session_ready", handle });
  }

  /** Marks a new turn as running and announces it. */
  protected beginTurn(): string {
    const turnId = randomUUID();
    this.turnId = turnId;
    this.currentState = "running";
    this.emit({ type: "turn_started", turnId });
    return turnId;
  }

  /** Ends the running turn, then starts the next queued send if there is one. */
  protected endTurn(outcome: "completed" | "failed" | "canceled", extra: { usage?: ContextUsage; error?: string } = {}): void {
    const turnId = this.turnId;
    if (!turnId) return;
    this.turnId = null;
    if (this.currentState === "running") this.currentState = "idle";
    if (extra.usage) this.lastUsage = { ...this.lastUsage, ...extra.usage };
    this.emit({ type: "turn_ended", turnId, outcome, ...(extra.usage ? { usage: extra.usage } : {}), ...(extra.error ? { error: extra.error } : {}) });
    for (const waiter of this.turnWaiters.splice(0)) waiter(turnId);
    const next = this.queued.shift();
    if (next && this.currentState === "idle") {
      void this.send(next.input, { ...next.options, whenBusy: "queue" }).catch((error) => console.error(`runtime(${this.provider}): queued send failed`, error));
    }
  }

  /** Resolves when the running turn ends (immediately when none is running). */
  protected turnEnded(timeoutMs: number): Promise<string | null> {
    if (!this.turnId) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.turnWaiters.push((turnId) => {
        clearTimeout(timer);
        resolve(turnId);
      });
    });
  }

  /** Shared handling of a send while a turn runs; returns null when the adapter should steer. */
  protected async busySend(input: UserInput, options: SendOptions): Promise<SendResult | "steer" | "start"> {
    if (options.expectedTurnId && options.expectedTurnId !== this.turnId) return { ok: false, reason: "turn_mismatch" };
    switch (options.whenBusy) {
      case "reject":
        return { ok: false, reason: "busy" };
      case "queue":
        this.queued.push({ input, options });
        return { ok: true, as: "queued", turnId: null };
      case "interrupt":
        await this.interrupt();
        return "start";
      case "steer":
        return "steer";
    }
  }

  abstract send(input: UserInput, options: SendOptions): Promise<SendResult>;
  abstract interrupt(): Promise<{ canceledTurnId: string | null }>;
}
