// Debug: what does a resumed Agent SDK query emit for its first prompt?
import { randomUUID } from "node:crypto";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { cleanEnv, findBinary } from "../packages/runtime/src/env.ts";
import { AsyncQueue } from "../packages/runtime/src/util.ts";
import { workDir } from "./lib/env.ts";

const binary = (await findBinary("claude"))!;
const cwd = workDir("claude-resume");
const env = cleanEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
const msg = (text: string) => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: randomUUID() }) as unknown as SDKUserMessage;

async function run(text: string, resume?: string): Promise<string | undefined> {
  const input = new AsyncQueue<SDKUserMessage>();
  const q = query({ prompt: input, options: { pathToClaudeCodeExecutable: binary, cwd, env, model: "claude-haiku-5-5", settingSources: [], includePartialMessages: false, ...(resume ? { resume } : {}) } });
  input.push(msg(text));
  let session: string | undefined;
  for await (const m of q as AsyncIterable<any>) {
    console.log(resume ? "R" : "N", m.type, m.subtype ?? "", m.type === "result" ? JSON.stringify(m.result) : m.type === "assistant" ? JSON.stringify(m.message.content).slice(0, 100) : m.type === "command_lifecycle" ? m.state : "");
    if (m.type === "system" && m.subtype === "init") session = m.session_id;
    if (m.type === "result") input.end();
  }
  return session;
}

const id = await run("Remember the word PELICAN. Reply OK.");
console.log("--- resume", id);
await run("What word did I ask you to remember? Reply with only the word.", id);
