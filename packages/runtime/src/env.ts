import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

/**
 * The environment for an agent CLI: ours minus anything that would make the child use another
 * program's auth or settings. A parent Claude Code session, for one, passes its host-auth proxy
 * and MCP wiring down (ANTHROPIC_BASE_URL, CLAUDE_CODE_*); a child that kept them would run on
 * that session's credentials instead of its own login.
 */
export function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(CLAUDE|ANTHROPIC|MCP_|OTEL_|CCD_)/.test(key) || key === "CLAUDECODE") continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** The absolute path of `command` on PATH, or null. */
export async function findBinary(command: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Runs a short command and returns its output (stdout, then stderr), or null when it fails or times out. */
export function runQuiet(command: string, args: string[], timeoutMs = 10_000, env = cleanEnv()): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => resolve(error ? null : `${String(stdout)}${String(stderr)}`));
  });
}
