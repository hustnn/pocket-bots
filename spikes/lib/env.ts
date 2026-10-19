import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The environment for an agent CLI: ours minus anything that would make the child use
 * someone else's auth or settings (a parent Claude Code session's host-auth proxy, its
 * MCP wiring), so each CLI runs on its own login.
 */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(CLAUDE|ANTHROPIC|MCP_|OTEL_|CCD_)/.test(key) || key === "CLAUDECODE") continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/** A work folder outside any git repo, so no project memory or CLAUDE.md is picked up. */
export function workDir(name: string): string {
  const dir = join(tmpdir(), "pocket-bots-spikes", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
