import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dataPath } from "./bot-home";

// One pocket-bots per data folder. A second one would run every routine and
// daily-log line twice, send asked bots' answers twice and, starting while the
// first holds the relay port, could leave the saved port behind. The lock is a
// local socket named after the folder: the running instance listens on it and
// answers with its pid, and the system frees it however the process ends, so a
// crash leaves nothing that blocks the next start.

/** How long a start waits for an instance that's shutting down (a restart) to let go. */
const LOCK_WAIT_MS = 3_000;

/** Startup problems the user can fix: printed as they are, without a stack. */
export class StartupError extends Error {}

/** The lock's socket path for a data folder. */
export function lockPath(folder: string): string {
  const id = createHash("sha256").update(resolve(folder)).digest("hex").slice(0, 16);
  return process.platform === "win32" ? `\\\\.\\pipe\\pocket-bots-${id}` : join(tmpdir(), `pocket-bots-${id}.sock`);
}

function listen(server: Server, path: string): Promise<boolean> {
  return new Promise((done, fail) => {
    server.once("error", (error: NodeJS.ErrnoException) => (error.code === "EADDRINUSE" ? done(false) : fail(error)));
    server.listen(path, () => done(true));
  });
}

/** The pid of the instance listening on the lock, or null when nobody is. One that connects but doesn't say is still running. */
function holder(path: string): Promise<string | null> {
  return new Promise((done) => {
    const socket = connect(path);
    let connected = false;
    let pid = "";
    socket.setTimeout(1_000, () => socket.destroy());
    socket.on("connect", () => (connected = true));
    socket.on("data", (chunk) => (pid += chunk.toString()));
    socket.on("close", () => done(connected ? pid.trim() || "unknown" : null));
    socket.on("error", () => {});
  });
}

/** Takes the data folder's lock for this process, or explains which instance has it. */
export async function lockDataFolder(folder: string = dataPath(), waitMs: number = LOCK_WAIT_MS): Promise<{ release(): void }> {
  const path = lockPath(folder);
  const until = Date.now() + waitMs;
  for (;;) {
    const server = createServer((socket) => socket.end(String(process.pid)));
    if (await listen(server, path)) {
      server.unref();
      return { release: () => void server.close() };
    }
    server.close();
    const pid = await holder(path);
    // A socket file nobody listens on is left from an instance that's gone.
    if (pid === null) await rm(path, { force: true }).catch(() => {});
    else if (Date.now() >= until) {
      throw new StartupError(
        `pocket-bots is already running for ${resolve(folder)} (pid ${pid}). Stop it first, or give this one its own data folder with POCKET_BOTS_HOME.`,
      );
    } else await new Promise((wait) => setTimeout(wait, 250));
  }
}
