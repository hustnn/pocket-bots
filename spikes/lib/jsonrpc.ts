// Newline-delimited JSON-RPC over a child's stdio, for codex app-server and ACP agents.
import { spawn, type ChildProcess } from "node:child_process";

type Handler = (params: any, id: number | string) => Promise<unknown> | unknown;

export class JsonRpcProcess {
  readonly child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private requestHandlers = new Map<string, Handler>();
  private notificationHandlers: ((method: string, params: any) => void)[] = [];
  private buffer = "";

  constructor(
    command: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string>; log: (line: string) => void; withJsonrpcField?: boolean },
  ) {
    this.child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.dispatch(line, opts.log);
      }
    });
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => opts.log(`[stderr] ${chunk.trim().slice(0, 300)}`));
    this.child.on("exit", (code, signal) => {
      opts.log(`[exit] code=${code} signal=${signal}`);
      for (const { reject, method } of this.pending.values()) reject(new Error(`process exited during ${method}`));
      this.pending.clear();
    });
    this.withJsonrpc = opts.withJsonrpcField ?? true;
  }

  private withJsonrpc: boolean;

  private write(payload: Record<string, unknown>) {
    this.child.stdin!.write(JSON.stringify(this.withJsonrpc ? { jsonrpc: "2.0", ...payload } : payload) + "\n");
  }

  private dispatch(line: string, log: (line: string) => void) {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      log(`[stdout] ${line.slice(0, 200)}`);
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message ?? "rpc error"), { data: message.error }));
      else waiter.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      const handler = this.requestHandlers.get(message.method) ?? this.requestHandlers.get("*");
      Promise.resolve(handler ? handler(message.params, message.id) : Promise.reject(new Error(`no handler for ${message.method}`)))
        .then((result) => this.write({ id: message.id, result }))
        .catch((error) => this.write({ id: message.id, error: { code: -32603, message: String(error?.message ?? error) } }));
      if (!this.requestHandlers.has(message.method)) log(`[request] ${message.method} (no specific handler)`);
    } else if (message.method) {
      for (const handler of this.notificationHandlers) handler(message.method, message.params);
    }
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
        method,
      });
    });
  }

  notify(method: string, params: unknown) {
    this.write({ method, params });
  }

  onRequest(method: string, handler: Handler) {
    this.requestHandlers.set(method, handler);
  }

  onNotification(handler: (method: string, params: any) => void) {
    this.notificationHandlers.push(handler);
  }

  kill() {
    this.child.kill("SIGTERM");
  }
}
