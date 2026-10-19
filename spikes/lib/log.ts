import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../out/", import.meta.url).pathname;

/** A per-spike log file plus a work folder for the agent, under spikes/out/. */
export function spikeEnv(name: string) {
  const dir = join(root, name);
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  const file = join(dir, "log.txt");
  writeFileSync(file, "");
  const started = Date.now();
  const log = (line: string) => {
    const stamped = `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${line}`;
    appendFileSync(file, stamped + "\n");
    console.log(stamped);
  };
  return { dir, work, log };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Results table printed at the end of each spike. */
export function report(log: (line: string) => void, results: Record<string, unknown>) {
  log("=== RESULTS");
  for (const [key, value] of Object.entries(results)) log(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

/** A push-based async iterable, for streaming input. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((result: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
