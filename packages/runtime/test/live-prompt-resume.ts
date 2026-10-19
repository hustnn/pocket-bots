// Does a resumed session take a new system prompt? On the CLI's own login:
//   node packages/runtime/test/live-prompt-resume.ts claude [model]
// Opens a session, closes it, resumes it with a prompt that adds a fact the conversation never
// mentions (a favourite colour), and asks for it. Claude Code and Codex are expected to keep the
// prompt their session started with; this checks it against our adapters.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { GrokAdapter } from "../src/adapters/grok.ts";
import { OpenCodeAdapter } from "../src/adapters/opencode.ts";
import { PiAdapter } from "../src/adapters/pi.ts";
import type { ResumeHandle, RuntimeAdapter, RuntimeEvent, RuntimeSession } from "../src/types.ts";

const adapters: Record<string, () => RuntimeAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  opencode: () => new OpenCodeAdapter(),
  grok: () => new GrokAdapter(),
  pi: () => new PiAdapter(),
};

const [name = "claude", model] = process.argv.slice(2);
const make = adapters[name];
if (!make) {
  console.error(`unknown runtime ${name}; one of ${Object.keys(adapters).join(", ")}`);
  process.exit(2);
}
const adapter = make();
const cwd = mkdtempSync(join(tmpdir(), "bots-prompt-resume-"));
const prompt = (colour: string | null) => `Answer in as few words as you can.${colour ? ` Your favourite colour is ${colour}; when asked for it, answer with the colour alone.` : ""}`;

async function open(colour: string | null, resume?: ResumeHandle): Promise<RuntimeSession> {
  return adapter.open({
    key: `prompt-resume-${Date.now()}`,
    cwd,
    ...(model ? { model } : {}),
    systemPrompt: prompt(colour),
    mcpServers: {},
    trustedTools: [],
    approvals: async () => ({ behavior: "deny", message: "No tools in this test." }),
    ...(resume ? { resume } : {}),
  });
}

async function ask(session: RuntimeSession, text: string, id: string): Promise<string> {
  let answer = "";
  const ended = new Promise<Extract<RuntimeEvent, { type: "turn_ended" }>>((resolve) => {
    session.on((event) => {
      if (event.type === "item" && event.item.type === "assistant_message") answer = event.item.text;
      if (event.type === "turn_ended") resolve(event);
    });
  });
  const sent = await session.send({ text }, { whenBusy: "reject", clientMessageId: id });
  if (!sent.ok) throw new Error(`send failed: ${sent.reason} ${sent.detail ?? ""}`);
  const end = await ended;
  if (end.outcome !== "completed") throw new Error(`turn ${end.outcome}: ${end.error ?? ""}`);
  return answer.trim();
}

const first = await open(null);
console.log("fresh session (no colour in its prompt):", await ask(first, "Say ok.", "q1"));
const handle = first.handle;
await first.close();
if (!handle) throw new Error("no resume handle");
const resumed = await open("TEAL", handle);
const answer = await ask(resumed, "What is your favourite colour? If you weren't told one, say NONE.", "q2");
console.log("resumed session (prompt now names TEAL):", answer);
console.log(/TEAL/i.test(answer) ? "=> the resumed session took the new prompt" : "=> the resumed session kept the old prompt");
await resumed.close();
process.exit(0);
