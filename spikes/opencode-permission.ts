// Phase-0 spike: does an OpenCode v2 session created with an "ask" rule for the shell tool
// raise permission.asked, and does permission.reply let the command run?
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { OpenCode } from "@opencode/client";
import { spikeEnv, report, sleep } from "./lib/log.ts";
import { cleanEnv, workDir } from "./lib/env.ts";

const { log } = spikeEnv("opencode-permission");
const work = workDir("opencode-permission");
const password = randomBytes(12).toString("hex");
const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: work, env: cleanEnv({ OPENCODE_PASSWORD: password }), stdio: ["ignore", "pipe", "pipe"] });
const url = await new Promise<string>((resolve) => {
  let buffer = "";
  server.stdout!.on("data", (chunk) => {
    buffer += String(chunk);
    const match = buffer.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) resolve(match[1]);
  });
});
const client = OpenCode.make({ baseUrl: url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
const location = { directory: work };
const session = await client.session.create({ location, permissions: [{ action: "shell", resource: "*", effect: "ask" }] } as any);
const asked: unknown[] = [];
let done!: (outcome: string) => void;
const finished = new Promise<string>((resolve) => (done = resolve));
const abort = new AbortController();
void (async () => {
  for await (const event of client.event.subscribe({ signal: abort.signal } as any) as AsyncIterable<any>) {
    if (event.data?.sessionID !== session.id) continue;
    if (event.type === "permission.asked") {
      asked.push({ action: event.data.action, resources: event.data.resources });
      log(`[approval] ${JSON.stringify(event.data).slice(0, 200)} -> once`);
      await client.permission.reply({ sessionID: session.id, requestID: event.data.id, decision: "once" } as any);
    } else if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
      log(`[tool] ${event.type}`);
    } else if (event.type.startsWith("session.execution.") && event.type !== "session.execution.started") {
      done(event.type);
    }
  }
})().catch(() => {});
await sleep(300);
await client.session.prompt({ sessionID: session.id, text: "Run the shell command `touch approval-test.txt` and then reply OK." } as any);
const outcome = await Promise.race([finished, sleep(120_000).then(() => "timeout")]);
abort.abort();
server.kill("SIGTERM");
report(log, { asked, outcome });
process.exit(0);
