// Runs the contract scenario against a real CLI on its own login:
//   node packages/runtime/test/live.ts claude [model] [mode]
import { ClaudeAdapter } from "../src/adapters/claude.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { DshAdapter } from "../src/adapters/dsh.ts";
import { GrokAdapter } from "../src/adapters/grok.ts";
import { OpenCodeAdapter } from "../src/adapters/opencode.ts";
import { PiAdapter } from "../src/adapters/pi.ts";
import { contractScript } from "./contract-script.ts";
import { startFakeOpenAI } from "./fake-openai.ts";
import type { RuntimeAdapter } from "../src/types.ts";
import { runContract } from "./contract.ts";

const adapters: Record<string, () => RuntimeAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  dsh: () => new DshAdapter(),
  opencode: () => new OpenCodeAdapter(),
  grok: () => new GrokAdapter(),
  pi: () => new PiAdapter(),
  "pi-fake": () => new PiAdapter(),
};

const [name = "claude", model, mode] = process.argv.slice(2);
const make = adapters[name];
if (!make) {
  console.error(`unknown runtime ${name}; one of ${Object.keys(adapters).join(", ")}`);
  process.exit(2);
}
const adapter = make();
console.log("probe", await adapter.probe());
const started = Date.now();
// pi-fake: Pi against a scripted model, for a machine without a Pi login.
const fake = name === "pi-fake" ? await startFakeOpenAI(contractScript({ note: "mcp__notes__record_note", shell: "bash" }), () => {}) : null;
const env = fake ? { BOTS_FAKE_URL: fake.baseUrl, BOTS_PI_EXTENSIONS: new URL("./pi-fake-provider.ts", import.meta.url).pathname } : undefined;
const report = await runContract(adapter, { ...(model ? { model } : fake ? { model: "fake/fake-1" } : {}), ...(mode ? { mode } : {}), ...(env ? { env } : {}), log: (line) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${line}`) });
const { events: _events, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
const steered = adapter.capabilities.steer ? report.steer.followed : report.steer.result === "steer_unavailable";
const pass = report.notes[0] === "hello-1" && steered && report.turn1 === "completed" && /canceled/.test(report.turn2) && report.resumedAnswer.includes("hello-1") && report.toolsAfterResume;
console.log(pass ? "CONTRACT PASS" : "CONTRACT FAIL");
process.exit(pass ? 0 : 1);
