import type { PocketEvent } from "../shared/rpc";

type Listener = (event: PocketEvent) => void;

/** Fans server events out to every open web UI (GET /api/events). */
export class EventHub {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: PocketEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("pocket-bots: an event listener failed", error);
      }
    }
  }
}
