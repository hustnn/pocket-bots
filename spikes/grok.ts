// Phase-0 spike: Grok Build over ACP (`grok agent stdio`), on its own grok.com login.
// Checks: loopback MCP tool, session/request_permission answered by us, mid-turn steer through
// the `_x.ai/interject` extension, session/cancel, resuming the session in a new process.
import { spikeEnv, report, sleep } from "./lib/log.ts";
import { cleanEnv, workDir } from "./lib/env.ts";
import { JsonRpcProcess } from "./lib/jsonrpc.ts";
import { startMcpHost } from "./lib/mcp-host.ts";

const { log } = spikeEnv("grok");
const work = workDir("grok");
const env = cleanEnv();
const mcp = await startMcpHost(log);
const token = mcp.newToken();
const results: Record<string, unknown> = {};
const permissions: string[] = [];
const mcpServers = [{ type: "http", name: "bots", url: mcp.url(token), headers: [] }];

function start(): JsonRpcProcess {
  const rpc = new JsonRpcProcess("grok", ["agent", "--no-leader", "stdio"], { cwd: work, env, log });
  rpc.onRequest("session/request_permission", (params) => {
    const options: { optionId: string; kind: string }[] = params.options ?? [];
    const pick = options.find((o) => o.kind === "allow_once") ?? options[0];
    permissions.push(`${params.toolCall?.title ?? params.toolCall?.kind ?? "?"}`.slice(0, 50));
    log(`[permission] ${JSON.stringify(params.toolCall?.title ?? params.toolCall).slice(0, 120)} options=${options.map((o) => o.kind).join(",")} -> ${pick?.kind}`);
    return { outcome: { outcome: "selected", optionId: pick.optionId } };
  });
  rpc.onRequest("*", (params, id) => {
    log(`[request?] ${id} ${JSON.stringify(params).slice(0, 200)}`);
    return {};
  });
  return rpc;
}

async function init(rpc: JsonRpcProcess) {
  await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
}

let rpc = start();
await init(rpc);
const created = await rpc.request("session/new", { cwd: work, mcpServers });
const sessionId: string = created.sessionId;
log(`[session] ${sessionId} models=${JSON.stringify(created.models?.currentModelId ?? created._meta?.modelState?.currentModelId)}`);

let phase: "turn1" | "turn2" = "turn1";
let steerSent = false;
let cancelSent = false;
let steerResponse: unknown = null;
let userChunksAfterSteer = 0;
const agentText: string[] = [];

rpc.onNotification(async (method, params) => {
  if (method !== "session/update") {
    log(`[notify] ${method} ${JSON.stringify(params).slice(0, 150)}`);
    return;
  }
  const u = params.update ?? {};
  const kind = u.sessionUpdate;
  if (kind === "agent_message_chunk") {
    agentText.push(u.content?.text ?? "");
    return;
  }
  if (kind === "agent_thought_chunk" || kind === "usage_update" || kind === "available_commands_update") return;
  if (kind === "user_message_chunk") {
    if (steerSent) userChunksAfterSteer++;
    log(`[update] user_message_chunk ${JSON.stringify(u.content?.text ?? "").slice(0, 100)}`);
    return;
  }
  log(`[update] ${kind} ${JSON.stringify({ title: u.title, kind: u.kind, status: u.status, id: u.toolCallId }).slice(0, 160)}`);
  const isShell = kind === "tool_call" && /sleep/.test(JSON.stringify(u));
  if (isShell && phase === "turn1" && !steerSent) {
    steerSent = true;
    await sleep(2000);
    log("[harness] _x.ai/interject");
    try {
      steerResponse = await rpc.request("_x.ai/interject", {
        sessionId,
        text: "Extra instruction from the user: before you reply FIN, also call record_note with text 'steer-2'.",
        interjectionId: "spike-1",
      });
    } catch (error) {
      steerResponse = { error: String(error), data: (error as any).data };
    }
    log(`[harness] interject response ${JSON.stringify(steerResponse)}`);
  }
  if (isShell && phase === "turn2" && !cancelSent) {
    cancelSent = true;
    await sleep(3000);
    log("[harness] session/cancel");
    rpc.notify("session/cancel", { sessionId });
  }
});

const turn1 = await rpc.request(
  "session/prompt",
  {
    sessionId,
    prompt: [
      {
        type: "text",
        text: "Step 1: call the record_note tool from the bots MCP server with text 'mcp-1'. Step 2: run the shell command `touch approval-test.txt && sleep 12 && echo slept`. Step 3: reply with the single word FIN.",
      },
    ],
  },
  300_000,
);
log(`[turn1] ${JSON.stringify(turn1)} text=${JSON.stringify(agentText.join("")).slice(-80)}`);
results.turn1 = turn1?.stopReason;
results.mcpCalls = mcp.calls.map((c) => c.text);
results.steerResponse = steerResponse;
results.userChunksAfterSteer = userChunksAfterSteer;
results.steerFollowed = mcp.calls.some((c) => c.text === "steer-2");

phase = "turn2";
agentText.length = 0;
const turn2 = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Run the shell command `sleep 25 && echo late` and then reply DONE." }] }, 300_000);
log(`[turn2] ${JSON.stringify(turn2)}`);
results.turn2 = turn2?.stopReason;
results.permissions = permissions.slice();

log("[harness] killing grok and resuming in a new process");
rpc.kill();
await sleep(1000);
rpc = start();
await init(rpc);
let resumed: unknown;
try {
  resumed = await rpc.request("session/resume", { sessionId, cwd: work, mcpServers });
  results.resumeMethod = "session/resume";
} catch (error) {
  log(`[resume] session/resume failed ${String(error)}; trying session/load`);
  resumed = await rpc.request("session/load", { sessionId, cwd: work, mcpServers });
  results.resumeMethod = "session/load";
}
log(`[resume] ${JSON.stringify(resumed).slice(0, 160)}`);
const answer: string[] = [];
rpc.onNotification((method, params) => {
  if (method === "session/update" && params.update?.sessionUpdate === "agent_message_chunk") answer.push(params.update.content?.text ?? "");
});
await sleep(500);
answer.length = 0;
await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "What text did you pass to record_note first? Reply with only that text." }] }, 120_000);
results.resumeAnswer = answer.join("").trim();
rpc.kill();
await mcp.close();
report(log, results);
process.exit(0);
