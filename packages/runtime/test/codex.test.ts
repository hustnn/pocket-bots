// How the Codex adapter hands a session's extra directories to Codex: as writable roots of the
// workspace-write sandbox, sent with each turn (a stand-in `codex app-server` that records what it
// was asked, so no model or login is needed).
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapters/codex.ts";
import type { RuntimeEvent, RuntimeSession, SessionSpec } from "../src/types.ts";

/**
 * A stand-in for `codex app-server`: it logs each request to CODEX_STANDIN_LOG and answers with the
 * sandbox Codex would settle on (a workspace-write one carrying a root and network access from the
 * user's config.toml), and runs every turn to completion at once.
 */
const STANDIN = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const SANDBOXES = {
  "workspace-write": { type: "workspaceWrite", writableRoots: ["/from/config"], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  "read-only": { type: "readOnly", networkAccess: false },
  "danger-full-access": { type: "dangerFullAccess" },
};
let turns = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  appendFileSync(process.env.CODEX_STANDIN_LOG, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  const reply = (result) => out({ id: message.id, result });
  const params = message.params ?? {};
  switch (message.method) {
    case "thread/start":
    case "thread/resume":
      return reply({ thread: { id: params.threadId ?? "thread-1" }, sandbox: SANDBOXES[params.sandbox] });
    case "turn/start": {
      const turn = { id: "turn-" + ++turns };
      reply({ turn: { ...turn, status: "inProgress" } });
      setTimeout(() => {
        out({ method: "turn/started", params: { threadId: params.threadId, turn } });
        out({ method: "turn/completed", params: { threadId: params.threadId, turn: { ...turn, status: "completed" } } });
      }, 5);
      return;
    }
    default:
      return reply({});
  }
});
`;

function standIn(): { binary: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "bots-codex-standin-"));
  const binary = join(dir, "codex.cjs");
  writeFileSync(binary, STANDIN);
  chmodSync(binary, 0o755);
  return { binary, log: join(dir, "requests.jsonl") };
}

function spec(log: string, extra: Partial<SessionSpec> = {}): SessionSpec {
  return { key: "k", cwd: tmpdir(), systemPrompt: "", mcpServers: {}, trustedTools: [], approvals: async () => ({ behavior: "allow" }), env: { CODEX_STANDIN_LOG: log }, ...extra };
}

async function turn(session: RuntimeSession, text: string): Promise<void> {
  const ended = new Promise<void>((resolve) => {
    const off = session.on((event: RuntimeEvent) => {
      if (event.type !== "turn_ended") return;
      off();
      resolve();
    });
  });
  expect(await session.send({ text }, { whenBusy: "reject", clientMessageId: text })).toMatchObject({ ok: true, as: "turn" });
  await ended;
}

/** The sandboxPolicy of each turn/start the stand-in was sent (undefined: none). */
function turnSandboxes(log: string): unknown[] {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: { sandboxPolicy?: unknown } })
    .filter((request) => request.method === "turn/start")
    .map((request) => request.params.sandboxPolicy);
}

const widened = (roots: string[]) => ({ type: "workspaceWrite", writableRoots: ["/from/config", ...roots], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false });

describe("Codex's extra directories", () => {
  it("adds them to the thread's own workspace-write sandbox with every turn", async () => {
    const { binary, log } = standIn();
    const codex = new CodexAdapter({ binary });
    expect(codex.capabilities).toMatchObject({ additionalDirectories: true, liveDirectories: true });
    const session = await codex.open(spec(log, { extraDirectories: ["/work/api", "/from/config"] }));
    await turn(session, "one");
    await turn(session, "two");
    expect(turnSandboxes(log)).toEqual([widened(["/work/api"]), widened(["/work/api"])]);
    await session.close();
  });

  it("takes a new list from the next turn on, and takes the roots out again once the list is empty", async () => {
    const { binary, log } = standIn();
    const session = await new CodexAdapter({ binary }).open(spec(log));
    await turn(session, "none yet");
    session.setExtraDirectories!(["/work/api"]);
    await turn(session, "added");
    session.setExtraDirectories!(["/work/api", "/work/docs"]);
    await turn(session, "another");
    session.setExtraDirectories!([]);
    await turn(session, "removed");
    await turn(session, "after");
    expect(turnSandboxes(log)).toEqual([undefined, widened(["/work/api"]), widened(["/work/api", "/work/docs"]), widened([]), undefined]);
    await session.close();
  });

  it("sends them again after a resume, which starts from the thread's own sandbox", async () => {
    const { binary, log } = standIn();
    const codex = new CodexAdapter({ binary });
    const first = await codex.open(spec(log, { extraDirectories: ["/work/api"] }));
    await turn(first, "one");
    const handle = first.handle!;
    await first.close();
    const resumed = await codex.open(spec(log, { extraDirectories: ["/work/api"], resume: handle }));
    await turn(resumed, "two");
    expect(turnSandboxes(log)).toEqual([widened(["/work/api"]), widened(["/work/api"])]);
    await resumed.close();
  });

  it("leaves the read-only and full-access sandboxes alone", async () => {
    const { binary, log } = standIn();
    const codex = new CodexAdapter({ binary });
    for (const mode of ["read-only", "full-access"]) {
      const session = await codex.open(spec(log, { mode, extraDirectories: ["/work/api"] }));
      await turn(session, mode);
      await session.close();
    }
    expect(turnSandboxes(log)).toEqual([undefined, undefined]);
  });
});
