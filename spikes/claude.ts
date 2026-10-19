// Phase-0 spike: Claude through the Agent SDK, on the installed `claude` and its own login.
// Checks: login, isolation, in-process tool without approval, approval callback, steer and its
// "input accepted" signal (command_lifecycle), interrupt, resume in a new process.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { query, createSdkMcpServer, tool, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { spikeEnv, report, AsyncQueue } from "./lib/log.ts";
import { cleanEnv, workDir } from "./lib/env.ts";

const { log } = spikeEnv("claude");
const work = workDir("claude");
const claudePath = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
const env = cleanEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false", DISABLE_AUTOUPDATER: "1" });
const results: Record<string, unknown> = {};
const notes: string[] = [];
const approvals: string[] = [];

const tools = createSdkMcpServer({
  name: "bots",
  tools: [
    tool(
      "record_note",
      "Record a short note for the test harness.",
      { text: z.string() },
      async ({ text }) => {
        notes.push(text);
        log(`[tool] record_note ${JSON.stringify(text)}`);
        return { content: [{ type: "text", text: `noted: ${text}` }] };
      },
      { alwaysLoad: true },
    ),
  ],
});

type Msg = SDKUserMessage & { uuid: string };
function userMessage(text: string, priority?: "now" | "next" | "later"): Msg {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: randomUUID(), ...(priority ? { priority } : {}) } as Msg;
}

function open(input: AsyncQueue<SDKUserMessage>, resume?: string): Query {
  return query({
    prompt: input,
    options: {
      pathToClaudeCodeExecutable: claudePath,
      cwd: work,
      env,
      model: "sonnet",
      permissionMode: "default",
      settingSources: [],
      mcpServers: { bots: tools },
      allowedTools: ["mcp__bots__record_note"],
      ...(resume ? { resume } : {}),
      stderr: (data) => log(`[stderr] ${data.trim().slice(0, 200)}`),
      canUseTool: async (name, toolInput) => {
        approvals.push(`${name}:${String(toolInput.command ?? "").slice(0, 40)}`);
        log(`[approval] ${name} ${JSON.stringify(toolInput).slice(0, 80)} -> allow`);
        return { behavior: "allow", updatedInput: toolInput };
      },
    },
  });
}

const input = new AsyncQueue<SDKUserMessage>();
const q = open(input);
const lifecycle = new Map<string, string[]>();
let sessionId: string | null = null;
let phase: "turn1" | "turn2" | "done" = "turn1";
let steer: Msg | null = null;
let interrupted = false;
const turnResults: { subtype: string; text: string }[] = [];

const first = userMessage(
  "Step 1: call the record_note tool with text 'hello-1'. Step 2: run the shell command `touch approval-test.txt && sleep 12 && echo slept`. Step 3: reply with the single word FIN.",
);
input.push(first);

try {
  for await (const message of q) {
    const m = message as Record<string, any>;
    if (m.type === "system" && m.subtype === "init") {
      sessionId = m.session_id;
      const toolNames: string[] = m.tools ?? [];
      log(`[init] session=${m.session_id} model=${m.model} apiKeySource=${m.apiKeySource} tools=${toolNames.length} claudeai=${toolNames.filter((t) => t.includes("claude_ai")).length} mcp=${JSON.stringify(m.mcp_servers)}`);
      results.apiKeySource = m.apiKeySource;
      results.claudeAiConnectorsLoaded = toolNames.filter((t) => t.includes("claude_ai")).length;
    } else if (m.type === "command_lifecycle") {
      const states = lifecycle.get(m.command_uuid) ?? [];
      states.push(m.state);
      lifecycle.set(m.command_uuid, states);
      log(`[lifecycle] ${m.command_uuid === steer?.uuid ? "STEER" : m.command_uuid === first.uuid ? "FIRST" : m.command_uuid.slice(0, 8)} ${m.state}`);
    } else if (m.type === "assistant") {
      for (const block of m.message.content ?? []) {
        if (block.type === "tool_use") {
          log(`[assistant] tool_use ${block.name} ${JSON.stringify(block.input).slice(0, 90)}`);
          if (phase === "turn1" && block.name === "Bash" && !steer) {
            steer = userMessage("Extra instruction from the user: before you reply FIN, also call record_note with text 'steer-2'.", "next");
            const pending = steer;
            setTimeout(() => {
              log("[harness] pushing steer");
              input.push(pending);
            }, 2000);
          }
          if (phase === "turn2" && block.name === "Bash" && !interrupted) {
            interrupted = true;
            setTimeout(async () => {
              log("[harness] interrupt()");
              try {
                log(`[harness] interrupt receipt ${JSON.stringify(await q.interrupt())}`);
              } catch (error) {
                log(`[harness] interrupt threw ${String(error)}`);
              }
            }, 3000);
          }
        } else if (block.type === "text") {
          log(`[assistant] text ${JSON.stringify(block.text).slice(0, 120)}`);
        }
      }
    } else if (m.type === "result") {
      log(`[result] subtype=${m.subtype} is_error=${m.is_error} result=${JSON.stringify(m.result ?? "").slice(0, 80)}`);
      turnResults.push({ subtype: m.subtype, text: m.result ?? "" });
      if (phase === "turn1") {
        phase = "turn2";
        input.push(userMessage("Run the shell command `sleep 15 && echo late` in the foreground and then reply DONE."));
      } else if (phase === "turn2") {
        phase = "done";
        input.end();
      }
    }
  }
} catch (error) {
  log(`[harness] first query ended with error: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
}

results.notes = notes.slice();
results.steerLifecycle = steer ? lifecycle.get(steer.uuid) : null;
results.steerFollowed = notes.includes("steer-2");
results.approvalsAsked = approvals;
results.turn1 = turnResults[0];
results.turn2 = turnResults[1];

log("[harness] resuming in a new process");
const input2 = new AsyncQueue<SDKUserMessage>();
const q2 = open(input2, sessionId ?? undefined);
input2.push(userMessage("What text did you pass to record_note first? Reply with only that text."));
try {
  for await (const message of q2) {
    const m = message as Record<string, any>;
    if (m.type === "system" && m.subtype === "init") log(`[init2] session=${m.session_id}`);
    if (m.type === "result") {
      log(`[result2] ${JSON.stringify(m.result)}`);
      results.resumeAnswer = m.result;
      input2.end();
    }
  }
} catch (error) {
  log(`[harness] resume query ended with error: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
}
report(log, results);
