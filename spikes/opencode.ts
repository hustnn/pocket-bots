// Phase-0 spike: OpenCode v2 (`opencode serve` + @opencode/client), on OpenCode's own login.
// Checks: plugin tool that calls back with the OpenCode session id, loopback MCP tool,
// permission.asked -> reply, steer (delivery: "steer") and its inbox events, interrupt,
// prompting the same session after a server restart.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { OpenCode } from "@opencode/client";
import { spikeEnv, report, sleep } from "./lib/log.ts";
import { cleanEnv, workDir } from "./lib/env.ts";
import { startMcpHost } from "./lib/mcp-host.ts";

const { dir, log } = spikeEnv("opencode");
const work = workDir("opencode");
const results: Record<string, unknown> = {};
const pluginCalls: { sessionID: string; text: string }[] = [];
const approvals: string[] = [];
const mcp = await startMcpHost(log);
const mcpToken = mcp.newToken();

// Callback endpoint for the plugin's tool.
const bridgeToken = randomBytes(12).toString("hex");
const bridge = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${bridgeToken}`) return void res.writeHead(401).end();
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  pluginCalls.push({ sessionID: body.sessionID, text: body.input?.text });
  log(`[plugin-call] session=${String(body.sessionID).slice(0, 12)} ${JSON.stringify(body.input)}`);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: `posted: ${body.input?.text}` }));
});
await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
const bridgeUrl = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;

// The plugin, as a package directory (v2 loads a package's ./server entry).
const pluginDir = join(dir, "plugin");
mkdirSync(pluginDir, { recursive: true });
writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "pocket-bots-spike-plugin", private: true, type: "module", exports: { "./server": "./server.js" } }));
writeFileSync(
  join(pluginDir, "server.js"),
  `export default {
  id: "bots",
  async setup(context) {
    const { baseUrl, token } = context.options;
    const registration = await context.tool.transform((editor) => {
      editor.add({
        name: "post_note",
        description: "Post a short note for the test harness.",
        input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        options: { codemode: false },
        async execute(input, call) {
          const response = await fetch(baseUrl + "/call", {
            method: "POST",
            headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ sessionID: call.sessionID, input }),
          });
          const result = await response.json();
          return { content: [{ type: "text", text: result.text }] };
        },
      });
    });
    return async () => { await registration.dispose(); };
  },
};
`,
);

const password = randomBytes(12).toString("hex");
let server: ChildProcess | null = null;

async function startServer() {
  const env = cleanEnv({
    OPENCODE_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [{ package: pathToFileURL(pluginDir).href, options: { baseUrl: bridgeUrl, token: bridgeToken } }] }),
  });
  server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr!.on("data", (d) => log(`[stderr] ${String(d).trim().slice(0, 200)}`));
  const url = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("startup timeout")), 30_000);
    server!.stdout!.on("data", (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    server!.once("exit", (code) => reject(new Error(`exited ${code}`)));
  });
  log(`[server] ${url}`);
  return OpenCode.make({ baseUrl: url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
}

let client = await startServer();
const location = { directory: work };
const defaultModel = await client.model.default({ location } as any).catch((e: unknown) => ({ error: String(e) }));
log(`[model] default ${JSON.stringify(defaultModel).slice(0, 200)}`);
await client.mcp.add({ server: "bots", location, config: { type: "remote", url: mcp.url(mcpToken), oauth: false, codemode: false } } as any);
const session = await client.session.create({ location, permissions: [{ action: "bash", resource: "*", effect: "ask" }] } as any);
const sessionID = session.id;
log(`[session] ${sessionID}`);
results.sessionID = sessionID;

const inbox = new Map<string, string[]>();
const outcomes: string[] = [];
const texts: string[] = [];
let phase: "turn1" | "turn2" | "done" = "turn1";
let steerInbox: string | null = null;
let steerSent = false;
let interruptSent = false;
let finished!: () => void;
const allDone = new Promise<void>((resolve) => (finished = resolve));
const toolNames = new Map<string, string>();

async function consume(c: ReturnType<typeof OpenCode.make>, signal: AbortSignal) {
  try {
    for await (const event of c.event.subscribe({ signal } as any) as AsyncIterable<any>) {
      const data = event.data ?? {};
      if (data.sessionID && data.sessionID !== sessionID) continue;
      const t: string = event.type;
      if (t === "session.inbox.enqueued" || t === "session.inbox.delivered" || t === "session.inbox.delivery.changed" || t === "session.inbox.cancelled") {
        const list = inbox.get(data.inboxID) ?? [];
        list.push(t.replace("session.inbox.", ""));
        inbox.set(data.inboxID, list);
        log(`[inbox] ${data.inboxID === steerInbox ? "STEER" : String(data.inboxID).slice(0, 10)} ${t}`);
      } else if (t === "session.tool.input.started") {
        toolNames.set(data.id, data.name ?? data.tool ?? "?");
        log(`[tool.input.started] ${JSON.stringify(data).slice(0, 160)}`);
      } else if (t === "session.tool.called") {
        const name = toolNames.get(data.id) ?? "?";
        log(`[tool.called] ${name} ${JSON.stringify(data.input).slice(0, 100)}`);
        const isShell = JSON.stringify(data.input).includes("sleep");
        if (phase === "turn1" && isShell && !steerSent) {
          steerSent = true;
          await sleep(2000);
          const steer = await c.session.prompt({ sessionID, text: "Extra instruction from the user: before you reply FIN, also call post_note with text 'steer-2'.", delivery: "steer" } as any);
          steerInbox = steer.id;
          log(`[harness] steer prompt -> inbox ${steer.id} delivery=${JSON.stringify(steer.delivery)}`);
        }
        if (phase === "turn2" && isShell && !interruptSent) {
          interruptSent = true;
          await sleep(3000);
          log(`[harness] interrupt -> ${JSON.stringify(await c.session.interrupt({ sessionID } as any))}`);
        }
      } else if (t === "permission.asked") {
        approvals.push(`${data.action}:${JSON.stringify(data.resources).slice(0, 50)}`);
        log(`[approval] ${data.action} ${JSON.stringify(data.resources)} -> once`);
        await c.permission.reply({ sessionID, requestID: data.id, decision: "once" } as any);
      } else if (t === "session.text.ended") {
        texts.push(data.text);
        log(`[text] ${JSON.stringify(data.text).slice(0, 120)}`);
      } else if (t.startsWith("session.execution.")) {
        log(`[execution] ${t} ${JSON.stringify(data).slice(0, 120)}`);
        if (t === "session.execution.started") continue;
        outcomes.push(t.replace("session.execution.", ""));
        if (phase === "turn1") {
          phase = "turn2";
          await c.session.prompt({ sessionID, text: "Run the shell command `sleep 25 && echo late` and then reply DONE." } as any);
        } else if (phase === "turn2") {
          phase = "done";
          finished();
        }
      } else if (!t.includes("delta") && !t.startsWith("session.step") && !t.startsWith("session.reasoning") && !t.startsWith("session.text.started") && t !== "session.usage.updated" && t !== "session.usage.recorded") {
        log(`[event] ${t} ${JSON.stringify(data).slice(0, 120)}`);
      }
    }
  } catch (error) {
    if (!signal.aborted) log(`[stream] ended ${String(error)}`);
  }
}

const abort1 = new AbortController();
void consume(client, abort1.signal);
await sleep(500);
const first = await client.session.prompt({
  sessionID,
  text: "Step 1: call the post_note tool with text 'plug-1'. Step 2: call the record_note tool from the bots MCP server with text 'mcp-1'. Step 3: run the shell command `touch approval-test.txt && sleep 12 && echo slept`. Step 4: reply with the single word FIN.",
} as any);
log(`[harness] first prompt -> inbox ${first.id}`);
await Promise.race([allDone, sleep(240_000)]);
results.pluginCalls = pluginCalls.map((c) => `${c.text}@${c.sessionID === sessionID ? "same-session" : c.sessionID}`);
results.mcpCalls = mcp.calls.map((c) => c.text);
results.approvals = approvals;
results.steerInbox = steerInbox ? inbox.get(steerInbox) : null;
results.steerFollowed = pluginCalls.some((c) => c.text === "steer-2");
results.outcomes = outcomes;

log("[harness] restarting server");
abort1.abort();
server!.kill("SIGTERM");
await sleep(1000);
client = await startServer();
const abort2 = new AbortController();
const answer = new Promise<string>((resolve) => {
  void (async () => {
    let last = "";
    try {
      for await (const event of client.event.subscribe({ signal: abort2.signal } as any) as AsyncIterable<any>) {
        if (event.data?.sessionID !== sessionID) continue;
        if (event.type === "session.text.ended") last = event.data.text;
        if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") resolve(last);
      }
    } catch {}
  })();
});
await sleep(500);
await client.session.prompt({ sessionID, text: "What text did you pass to post_note first? Reply with only that text." } as any);
results.resumeAnswer = await Promise.race([answer, sleep(120_000).then(() => "timeout")]);
abort2.abort();
server!.kill("SIGTERM");
await mcp.close();
bridge.close();
report(log, results);
process.exit(0);
