// Newline-delimited JSON-RPC over a child's stdio (codex app-server, ACP agents).
import { spawn, type ChildProcess } from "node:child_process";

type RequestHandler = (params: any, id: number | string) => Promise<unknown> | unknown;

export interface JsonRpcOptions {
  cwd: string;
  env: Record<string, string>;
  /** Codex's app-server leaves out the "jsonrpc" field; ACP wants it. */
  jsonrpcField: boolean;
  onStderr?: (text: string) => void;
}

export class JsonRpcProcess {
  readonly child: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (value: any) => void; reject: (error: Error) => void; method: string }>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers: ((method: string, params: any) => void)[] = [];
  private readonly exitHandlers: ((error: string | null) => void)[] = [];
  private buffer = "";
  private readonly jsonrpcField: boolean;
  exited = false;

  constructor(command: string, args: string[], options: JsonRpcOptions) {
    this.jsonrpcField = options.jsonrpcField;
    this.child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.dispatch(line);
      }
    });
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => options.onStderr?.(chunk));
    this.child.on("error", (error) => this.finish(error.message));
    this.child.on("exit", (code, signal) => this.finish(code === 0 || signal === "SIGTERM" ? null : `exited with ${code ?? signal}`));
  }

  private finish(error: string | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const { reject, method } of this.pending.values()) reject(new Error(`The agent process stopped during ${method}.`));
    this.pending.clear();
    for (const handler of this.exitHandlers) handler(error);
  }

  private write(payload: Record<string, unknown>): void {
    if (this.exited || !this.child.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify(this.jsonrpcField ? { jsonrpc: "2.0", ...payload } : payload) + "\n");
  }

  private dispatch(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message ?? "The agent returned an error."), { data: message.error }));
      else waiter.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      const handler = this.requestHandlers.get(message.method) ?? this.requestHandlers.get("*");
      Promise.resolve()
        .then(() => (handler ? handler(message.params, message.id) : Promise.reject(new Error(`Unsupported request ${message.method}`))))
        .then((result) => this.write({ id: message.id, result: result ?? {} }))
        .catch((error) => this.write({ id: message.id, error: { code: -32603, message: String(error?.message ?? error) } }));
    } else if (message.method) {
      for (const handler of this.notificationHandlers) {
        try {
          handler(message.method, message.params);
        } catch (error) {
          console.error("runtime: a notification handler failed", error);
        }
      }
    }
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.exited) return Promise.reject(new Error("The agent process isn't running."));
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        method,
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(handler: (method: string, params: any) => void): void {
    this.notificationHandlers.push(handler);
  }

  onExit(handler: (error: string | null) => void): void {
    this.exitHandlers.push(handler);
  }

  kill(): void {
    if (!this.exited) this.child.kill("SIGTERM");
  }
}
