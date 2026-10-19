// Phase-0 spike: Pi through `pi --mode rpc` plus our extension, on Pi's own login/providers.
// Checks: extension tool calling back to the host, MCP via pi.registerMcpServer, approvals via
// the extension's tool_call hook, steer and its acceptance signal, abort, resume by session id.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spikeEnv, report, sleep } from "./lib/log.ts";
import { cleanEnv, workDir } from "./lib/env.ts";
import { startMcpHost } from "./lib/mcp-host.ts";
import { startFakeOpenAI, textOf, type ChatMessage, type FakeStep } from "./lib/fake-openai.ts";

// PI_FAKE=1: run against a scripted model (Pi has no working login on this machine).
const useFake = process.env.PI_FAKE === "1";

const { dir, log } = spikeEnv("pi");
const work = workDir("pi");
const results: Record<string, unknown> = {};
const toolCalls: string[] = [];
const approvals: string[] = [];
const mcp = await startMcpHost(log);
const mcpToken = mcp.newToken();

function decide(messages: ChatMessage[]): FakeStep {
  const prompts = messages.map((m, i) => ({ m, i })).filter((x) => x.m.role === "user" && !textOf(x.m).includes("Extra instruction"));
  const last = prompts[prompts.length - 1];
  const since = messages.slice(last.i + 1);
  const calls = since.flatMap((m) => m.tool_calls ?? []).map((c) => c.function);
  const prompt = textOf(last.m);
  const steered = since.some((m) => m.role === "user" && textOf(m).includes("steer-2"));
  if (prompt.startsWith("Step 1")) {
    if (!calls.some((c) => c.name === "post_note")) return { tool: "post_note", args: { text: "ext-1" } };
    if (process.env.PI_MCP === "1" && !calls.some((c) => c.name === "mcp__bots__record_note")) return { tool: "mcp__bots__record_note", args: { text: "mcp-1" } };
    if (!calls.some((c) => c.name === "bash")) return { tool: "bash", args: { command: "touch approval-test.txt && sleep 12 && echo slept" } };
    if (steered && !calls.some((c) => c.arguments.includes("steer-2"))) return { tool: "post_note", args: { text: "steer-2" } };
    return { text: "FIN" };
  }
  if (prompt.includes("sleep 25")) return calls.some((c) => c.name === "bash") ? { text: "DONE" } : { tool: "bash", args: { command: "sleep 25 && echo late" } };
  if (prompt.includes("What text")) {
    const first = messages.flatMap((m) => m.tool_calls ?? []).map((c) => c.function).find((c) => c.name === "post_note");
    return { text: first ? JSON.parse(first.arguments).text : "unknown" };
  }
  return { text: "ok" };
}
const fake = useFake ? await startFakeOpenAI(decide, log) : null;

const bridgeToken = randomBytes(12).toString("hex");
const bridge = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${bridgeToken}`) return void res.writeHead(401).end();
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (req.url === "/tool") {
    toolCalls.push(body.input?.text);
    log(`[ext-tool] ${JSON.stringify(body.input)}`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: `posted: ${body.input?.text}` }));
  } else if (req.url === "/approve") {
    approvals.push(`${body.tool}:${String(body.input?.command ?? "").slice(0, 40)}`);
    log(`[approval] ${body.tool} ${JSON.stringify(body.input).slice(0, 100)} -> allow`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ allow: true }));
  } else res.writeHead(404).end();
});
await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
const bridgeUrl = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;

const extDir = join(dir, "ext");
mkdirSync(extDir, { recursive: true });
const extPath = join(extDir, "bots.ts");
writeFileSync(
  extPath,
  `import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const base = process.env.BOTS_BRIDGE_URL!;
const auth = { Authorization: "Bearer " + process.env.BOTS_BRIDGE_TOKEN, "Content-Type": "application/json" };
const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: auth, body: JSON.stringify(body) }).then((r) => r.json());

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "post_note",
    label: "Post note",
    description: "Post a short note for the test harness.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) {
      const result = await post("/tool", { input: params });
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  });
  if (typeof (pi as any).registerMcpServer === "function") (pi as any).registerMcpServer("bots", { url: process.env.BOTS_MCP_URL!, exposure: "direct" });
  if (process.env.BOTS_FAKE_URL) {
    pi.registerProvider("fake", {
      baseUrl: process.env.BOTS_FAKE_URL,
      apiKey: "fake",
      api: "openai-completions",
      models: [{ id: "fake-1", name: "Fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    });
  }
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const decision = await post("/approve", { tool: event.toolName, input: event.input });
    return decision.allow ? undefined : { block: true, reason: "Not approved" };
  });
}
`,
);

const sessionId = `spike-${randomUUID().slice(0, 8)}`;
const sessionDir = join(dir, "sessions");
mkdirSync(sessionDir, { recursive: true });

class PiRpc {
  child: ChildProcess;
  private buffer = "";
  private waiters = new Map<string, (r: any) => void>();
  listeners: ((e: any) => void)[] = [];
  constructor() {
    this.child = spawn(
      "pi",
      ["--mode", "rpc", "--session-id", sessionId, "--session-dir", sessionDir, "-e", extPath, "--no-context-files", ...(fake ? ["--provider", "fake", "--model", "fake-1"] : ["--thinking", "low"])],
      { cwd: work, env: cleanEnv({ BOTS_BRIDGE_URL: bridgeUrl, BOTS_BRIDGE_TOKEN: bridgeToken, BOTS_MCP_URL: mcp.url(mcpToken), ...(fake ? { BOTS_FAKE_URL: fake.baseUrl } : {}) }), stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i).replace(/\r$/, "");
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        if (record.type === "response" && record.id && this.waiters.has(record.id)) {
          this.waiters.get(record.id)!(record);
          this.waiters.delete(record.id);
        } else for (const l of this.listeners) l(record);
      }
    });
    this.child.stderr!.on("data", (d) => log(`[stderr] ${String(d).trim().slice(0, 200)}`));
    this.child.on("exit", (code) => log(`[exit] ${code}`));
  }
  send(command: Record<string, unknown>): Promise<any> {
    const id = randomUUID();
    this.child.stdin!.write(JSON.stringify({ id, ...command }) + "\n");
    return new Promise((resolve) => this.waiters.set(id, resolve));
  }
}

let pi = new PiRpc();
const state = await pi.send({ type: "get_state" });
log(`[state] ${JSON.stringify(state.data).slice(0, 300)}`);
const steerText = "Extra instruction from the user: before you reply FIN, also call post_note with text 'steer-2'.";
let phase: "turn1" | "turn2" | "done" = "turn1";
let steerSent = false;
let steerAccepted: string[] = [];
let abortSent = false;
const settled: string[] = [];
let finished!: () => void;
const allDone = new Promise<void>((resolve) => (finished = resolve));

pi.listeners.push(async (e) => {
  if (e.type === "tool_execution_start") {
    log(`[tool_start] ${e.toolName} ${JSON.stringify(e.args).slice(0, 100)}`);
    if (phase === "turn1" && e.toolName === "bash" && !steerSent) {
      steerSent = true;
      await sleep(2000);
      const r = await pi.send({ type: "steer", message: steerText });
      log(`[harness] steer response ${JSON.stringify(r)}`);
      steerAccepted.push(`response:${r.data?.disposition}`);
    }
    if (phase === "turn2" && e.toolName === "bash" && !abortSent) {
      abortSent = true;
      await sleep(3000);
      log(`[harness] abort -> ${JSON.stringify(await pi.send({ type: "abort" }))}`);
    }
  } else if (e.type === "tool_execution_end") {
    log(`[tool_end] ${e.toolName} error=${e.isError}`);
  } else if (e.type === "message_start" && e.message?.role === "user") {
    const text = JSON.stringify(e.message.content).slice(0, 80);
    log(`[user message_start] ${text}`);
    if (text.includes("steer-2")) steerAccepted.push("message_start");
  } else if (e.type === "queue_update") {
    log(`[queue_update] steering=${e.steering?.length} followUp=${e.followUp?.length}`);
  } else if (e.type === "message_end" && e.message?.role === "assistant") {
    const text = (e.message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    log(`[assistant] ${JSON.stringify(text).slice(0, 120)} stop=${e.message.stopReason}${e.message.errorMessage ? ` error=${String(e.message.errorMessage).slice(0, 160)}` : ""}`);
  } else if (e.type === "agent_settled") {
    log(`[agent_settled]`);
    settled.push(phase);
    if (phase === "turn1") {
      phase = "turn2";
      await pi.send({ type: "prompt", message: "Run the shell command `sleep 25 && echo late` and then reply DONE." });
    } else if (phase === "turn2") {
      phase = "done";
      finished();
    }
  } else if (["agent_start", "agent_end", "turn_start", "turn_end", "compaction_start", "auto_retry_start"].includes(e.type)) {
    log(`[event] ${e.type}${e.type === "agent_end" ? ` willRetry=${e.willRetry}` : ""}`);
  } else if (e.type === "extension_ui_request" || e.type === "extension_error") {
    log(`[event] ${e.type} ${JSON.stringify(e).slice(0, 200)}`);
  }
});

const r1 = await pi.send({
  type: "prompt",
  message:
    "Step 1: call the post_note tool with text 'ext-1'. Step 2: run the shell command `touch approval-test.txt && sleep 12 && echo slept`. Step 3: reply with the single word FIN.",
});
log(`[harness] prompt response ${JSON.stringify(r1)}`);
await Promise.race([allDone, sleep(300_000)]);
results.extensionToolCalls = toolCalls.slice();
results.mcpCalls = mcp.calls.map((c) => c.text);
results.approvals = approvals;
results.steerAccepted = steerAccepted;
results.steerFollowed = toolCalls.includes("steer-2");

log("[harness] closing pi and resuming by session id");
pi.child.stdin!.end();
await sleep(1500);
pi = new PiRpc();
const answer = new Promise<string>((resolve) => {
  let last = "";
  pi.listeners.push((e) => {
    if (e.type === "message_end" && e.message?.role === "assistant") last = (e.message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    if (e.type === "agent_settled") resolve(last);
  });
});
await pi.send({ type: "prompt", message: "What text did you pass to post_note first? Reply with only that text." });
results.usedFakeModel = useFake;
results.resumeAnswer = await Promise.race([answer, sleep(120_000).then(() => "timeout")]);
pi.child.stdin!.end();
await mcp.close();
bridge.close();
report(log, results);
process.exit(0);
