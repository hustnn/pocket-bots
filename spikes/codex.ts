// Phase-0 spike: Codex through `codex app-server` (JSON-RPC over stdio), on its own ChatGPT login.
// Checks: dynamic tool (experimental) and loopback MCP tool, command approval request, turn/steer
// and its acceptance signal, turn/interrupt, thread/resume in a new process.
import { randomUUID } from "node:crypto";
import { spikeEnv, report, sleep } from "./lib/log.ts";
import { cleanEnv, workDir } from "./lib/env.ts";
import { JsonRpcProcess } from "./lib/jsonrpc.ts";
import { startMcpHost } from "./lib/mcp-host.ts";

const { log } = spikeEnv("codex");
const work = workDir("codex");
const env = cleanEnv();
const mcp = await startMcpHost(log);
const token = mcp.newToken();
const results: Record<string, unknown> = {};
const dynamicCalls: string[] = [];
const approvals: string[] = [];

function startServer(): JsonRpcProcess {
  const rpc = new JsonRpcProcess("codex", ["app-server"], { cwd: work, env, log, withJsonrpcField: false });
  rpc.onRequest("item/tool/call", (params) => {
    const text = String(params.arguments?.text ?? "");
    dynamicCalls.push(text);
    log(`[dynamic] ${params.tool} ${JSON.stringify(params.arguments)} turn=${params.turnId?.slice(0, 8)}`);
    return { contentItems: [{ type: "inputText", text: `posted: ${text}` }], success: true };
  });
  rpc.onRequest("item/commandExecution/requestApproval", (params) => {
    approvals.push(`command:${String(params.command ?? "").slice(0, 40)}`);
    log(`[approval] command ${JSON.stringify(params.command)} -> accept`);
    return { decision: "accept" };
  });
  rpc.onRequest("item/fileChange/requestApproval", () => {
    approvals.push("fileChange");
    return { decision: "accept" };
  });
  rpc.onRequest("mcpServer/elicitation/request", (params) => {
    approvals.push(`mcp:${JSON.stringify(params).slice(0, 60)}`);
    log(`[approval] mcp elicitation ${JSON.stringify(params).slice(0, 160)} -> accept`);
    return { action: "accept", content: null, _meta: null };
  });
  rpc.onRequest("*", (params, id) => {
    log(`[request?] id=${id} ${JSON.stringify(params).slice(0, 200)}`);
    return {};
  });
  return rpc;
}

async function init(rpc: JsonRpcProcess) {
  const info = await rpc.request("initialize", {
    clientInfo: { name: "pocket-bots-spike", title: null, version: "0.0.1" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  log(`[init] ${JSON.stringify(info).slice(0, 200)}`);
  rpc.notify("initialized", {});
}

const text = (t: string) => [{ type: "text", text: t, text_elements: [] }];

let rpc = startServer();
await init(rpc);
const thread = await rpc.request("thread/start", {
  cwd: work,
  approvalPolicy: "untrusted",
  sandbox: "workspace-write",
  config: { mcp_servers: { bots: { url: mcp.url(token) } } },
  dynamicTools: [
    {
      type: "function",
      name: "post_note",
      description: "Post a short note for the test harness.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    },
  ],
});
const threadId: string = thread.thread.id;
log(`[thread] ${threadId} model=${thread.model}`);

let phase: "turn1" | "turn2" | "done" = "turn1";
let activeTurn: string | null = null;
let steerSent = false;
let interruptSent = false;
const steerId = randomUUID();
const turnStatus: string[] = [];
let steerAccepted: unknown = null;
let steerItemSeen = false;
let finished!: () => void;
const allDone = new Promise<void>((resolve) => (finished = resolve));

rpc.onNotification(async (method, params) => {
  if (method === "turn/started") {
    activeTurn = params.turn.id;
    log(`[turn/started] ${params.turn.id.slice(0, 8)}`);
  } else if (method === "turn/completed") {
    log(`[turn/completed] ${params.turn.id.slice(0, 8)} status=${params.turn.status} error=${JSON.stringify(params.turn.error)}`);
    turnStatus.push(params.turn.status);
    activeTurn = null;
    if (phase === "turn1") {
      phase = "turn2";
      await rpc.request("turn/start", { threadId, input: text("Run the shell command `sleep 25 && echo late` and then reply DONE.") });
    } else if (phase === "turn2") {
      phase = "done";
      finished();
    }
  } else if (method === "item/started" || method === "item/completed") {
    const item = params.item;
    const summary =
      item.type === "commandExecution" ? item.command :
      item.type === "mcpToolCall" ? `${item.server}.${item.tool} ${JSON.stringify(item.arguments)}` :
      item.type === "dynamicToolCall" ? `${item.tool}` :
      item.type === "userMessage" ? JSON.stringify(item.content).slice(0, 100) :
      item.type === "agentMessage" ? JSON.stringify(item.text).slice(0, 100) : "";
    log(`[${method}] ${item.type} ${summary}`);
    if (item.type === "userMessage" && JSON.stringify(item.content).includes("steer-2")) steerItemSeen = true;
    if (method === "item/started" && item.type === "commandExecution" && phase === "turn1" && !steerSent && activeTurn) {
      steerSent = true;
      await sleep(2000);
      log("[harness] turn/steer");
      try {
        steerAccepted = await rpc.request("turn/steer", {
          threadId,
          expectedTurnId: activeTurn,
          clientUserMessageId: steerId,
          input: text("Extra instruction from the user: before you reply FIN, also call post_note with text 'steer-2'."),
        });
        log(`[harness] steer response ${JSON.stringify(steerAccepted)}`);
      } catch (error) {
        steerAccepted = { error: String(error) };
        log(`[harness] steer failed ${String(error)}`);
      }
    }
    if (method === "item/started" && item.type === "commandExecution" && phase === "turn2" && !interruptSent && activeTurn) {
      interruptSent = true;
      await sleep(3000);
      log("[harness] turn/interrupt");
      const response = await rpc.request("turn/interrupt", { threadId, turnId: activeTurn });
      log(`[harness] interrupt response ${JSON.stringify(response)}`);
    }
  } else if (method === "thread/tokenUsage/updated" || method === "account/rateLimits/updated") {
    // quiet
  } else if (!method.includes("delta") && !method.startsWith("mcpServer/startup") && method !== "thread/status/changed") {
    log(`[notify] ${method} ${JSON.stringify(params).slice(0, 120)}`);
  }
});

await rpc.request("turn/start", {
  threadId,
  input: text(
    "Step 1: call the post_note tool with text 'dyn-1'. Step 2: call the record_note tool from the bots MCP server with text 'mcp-1'. Step 3: run the shell command `touch approval-test.txt && sleep 12 && echo slept`. Step 4: reply with the single word FIN.",
  ),
});
await allDone;
results.dynamicCalls = dynamicCalls.slice();
results.mcpCalls = mcp.calls.map((c) => c.text);
results.approvals = approvals;
results.steerResponse = steerAccepted;
results.steerUserItemSeen = steerItemSeen;
results.steerFollowed = dynamicCalls.includes("steer-2");
results.turnStatus = turnStatus;

log("[harness] killing app-server and resuming in a new one");
rpc.kill();
await sleep(500);
rpc = startServer();
await init(rpc);
const resumed = await rpc.request("thread/resume", { threadId });
log(`[resume] ${resumed.thread?.id}`);
const answer = new Promise<string>((resolve) => {
  let last = "";
  rpc.onNotification((method, params) => {
    if (method === "item/completed" && params.item.type === "agentMessage") last = params.item.text;
    if (method === "turn/completed") resolve(last);
  });
});
await rpc.request("turn/start", { threadId, input: text("What text did you pass to post_note first? Reply with only that text.") });
results.resumeAnswer = await answer;
rpc.kill();
await mcp.close();
report(log, results);
process.exit(0);
