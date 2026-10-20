// Does Codex write in a session's extra directories without asking? On the CLI's own login:
//   node packages/runtime/test/live-directories.ts [model]
// In Auto mode (workspace-write) a write in an extra directory should run without an approval, a
// directory added mid-session should be writable from the next turn, one taken out shouldn't be,
// and a resumed session should have them again. The folders live under the home folder, as /tmp
// and $TMPDIR are writable in Codex's sandbox anyway.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.ts";
import type { ResumeHandle, RuntimeEvent, RuntimeSession } from "../src/types.ts";

const [model] = process.argv.slice(2);
const adapter = new CodexAdapter();
const root = mkdtempSync(join(homedir(), ".pocket-bots-live-directories-"));
const [cwd, api, docs] = ["work", "api", "docs"].map((name) => join(root, name)) as [string, string, string];
for (const dir of [cwd, api, docs]) mkdirSync(dir);
const approvals: string[] = [];

function open(extraDirectories: string[], resume?: ResumeHandle): Promise<RuntimeSession> {
  return adapter.open({
    key: `live-directories-${Date.now()}`,
    cwd,
    mode: "auto",
    ...(model ? { model } : {}),
    systemPrompt: "Run the command you're given exactly once, with no escalated permissions, and don't retry it. Then reply DONE, or FAILED if it failed.",
    mcpServers: {},
    trustedTools: [],
    extraDirectories,
    approvals: async (request) => {
      approvals.push(request.name);
      return { behavior: "deny", message: "Not in this test." };
    },
    ...(resume ? { resume } : {}),
  });
}

/** Asks for a write of `file`; says whether it was written and how many approvals that took. */
async function write(session: RuntimeSession, file: string): Promise<{ written: boolean; approvals: number }> {
  const before = approvals.length;
  const ended = new Promise<Extract<RuntimeEvent, { type: "turn_ended" }>>((resolve) => {
    const off = session.on((event) => {
      if (event.type !== "turn_ended") return;
      off();
      resolve(event);
    });
  });
  const sent = await session.send({ text: `Run this shell command: echo hi > ${file}` }, { whenBusy: "reject", clientMessageId: file });
  if (!sent.ok) throw new Error(`send failed: ${sent.reason} ${sent.detail ?? ""}`);
  await ended;
  return { written: existsSync(file), approvals: approvals.length - before };
}

const results: [string, { written: boolean; approvals: number }, boolean][] = [];
const check = (step: string, result: { written: boolean; approvals: number }, wanted: boolean) => {
  results.push([step, result, wanted ? result.written && result.approvals === 0 : !result.written]);
  console.log(step, result);
};
try {
  const session = await open([api]);
  check("extra directory from the start", await write(session, join(api, "one.txt")), true);
  session.setExtraDirectories!([api, docs]);
  check("directory added mid-session", await write(session, join(docs, "two.txt")), true);
  session.setExtraDirectories!([api]);
  check("directory taken out again", await write(session, join(docs, "three.txt")), false);
  const handle = session.handle;
  await session.close();
  if (!handle) throw new Error("no resume handle");
  const resumed = await open([api], handle);
  check("after a resume", await write(resumed, join(api, "four.txt")), true);
  await resumed.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
const pass = results.every(([, , ok]) => ok);
console.log(pass ? "DIRECTORIES PASS" : `DIRECTORIES FAIL: ${results.filter(([, , ok]) => !ok).map(([step]) => step).join(", ")}`);
process.exit(pass ? 0 : 1);
