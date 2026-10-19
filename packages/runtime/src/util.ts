import type { ChildProcess } from "node:child_process";

/** A push-based async iterable, for streaming input. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((result: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
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

/** Whether a child process still runs: it hasn't exited, and its pid answers signal 0. */
export function processAlive(child: ChildProcess | undefined): boolean | undefined {
  if (!child || child.pid === undefined) return undefined;
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** "/name args" split up, or null when the text isn't a slash command. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!, args: (match[2] ?? "").trim() } : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The text of a tool result, whatever shape the runtime gave it. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) ? (str(part.text) ?? (part.type === "image" ? "[image]" : "")) : String(part)))
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

/** Keeps long tool output from bloating the timeline. */
export function clip(text: string, max = 20_000): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}
