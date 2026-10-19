// Lists a real CLI's slash commands and runs /compact on a short conversation, on its own login:
//   node packages/runtime/test/live-commands.ts codex [model]
// BOTS_COMMAND="/name args" runs one more command after that.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { GrokAdapter } from "../src/adapters/grok.ts";
import { OpenCodeAdapter } from "../src/adapters/opencode.ts";
import { PiAdapter } from "../src/adapters/pi.ts";
import type { RuntimeAdapter, RuntimeEvent } from "../src/types.ts";

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
const cwd = mkdtempSync(join(tmpdir(), "bots-commands-"));
const session = await adapter.open({
  key: `commands-${Date.now()}`,
  cwd,
  ...(model ? { model } : {}),
  systemPrompt: "Answer in as few words as you can.",
  mcpServers: {},
  trustedTools: [],
  approvals: async () => ({ behavior: "deny", message: "No tools in this test." }),
});
const events: RuntimeEvent[] = [];
session.on((event) => events.push(event));
const ended = () => new Promise<Extract<RuntimeEvent, { type: "turn_ended" }>>((resolve) => session.on((event) => event.type === "turn_ended" && resolve(event)));

const commands = await session.commands();
console.log(`${commands.length} commands:`, commands.map((command) => `/${command.name}${command.kind === "skill" ? " (skill)" : ""}`).join(" "));

let done = ended();
console.log("send", await session.send({ text: "Say ok." }, { whenBusy: "reject", clientMessageId: "m1" }));
const first = await done;
console.log("turn 1", first.outcome, first.error ?? "");

done = ended();
const before = events.length;
console.log("send /compact", await session.send({ text: "/compact" }, { whenBusy: "reject", clientMessageId: "m2" }));
const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5 * 60_000));
const compacted = await Promise.race([done, timeout]);
console.log("turn 2", compacted ? `${compacted.outcome} ${compacted.error ?? ""}` : "no turn_ended within 5 minutes");
const items = events.slice(before).flatMap((event) => (event.type === "item" ? [`${event.item.type}${"status" in event.item ? `:${event.item.status}` : ""}`] : event.type === "input_accepted" ? ["accepted"] : []));
console.log("events after /compact:", [...new Set(items)].join(", "));
const extra = process.env.BOTS_COMMAND;
if (extra) {
  done = ended();
  const from = events.length;
  console.log(`send ${extra}`, await session.send({ text: extra }, { whenBusy: "reject", clientMessageId: "m3" }));
  const result = await Promise.race([done, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5 * 60_000))]);
  console.log("turn 3", result ? `${result.outcome} ${result.error ?? ""}` : "no turn_ended within 5 minutes");
  const texts = events.slice(from).flatMap((event) => (event.type === "item" && event.item.type === "assistant_message" ? [event.item.text] : []));
  console.log("reply:", (texts.at(-1) ?? "").slice(0, 300));
  console.log("events:", [...new Set(events.slice(from).map((event) => (event.type === "item" ? `item:${event.item.type}${event.item.type === "tool_call" ? `:${event.item.name}:${event.item.status}` : ""}` : event.type)))].join(", "));
}
await session.close();
process.exit(compacted?.outcome === "completed" ? 0 : 1);
