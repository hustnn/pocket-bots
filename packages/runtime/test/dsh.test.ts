// The DeepSeek Harness adapter against a stand-in `dsh --profile acp`: what it writes into the
// per-chat system-prompt patch, how it reads models and reasoning levels out of configOptions, and
// how ACP updates, approvals, cancels and resumes become timeline items. No model is involved.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DshAdapter } from "../src/adapters/dsh.ts";
import type { ApprovalRequest, RuntimeEvent, RuntimeSession, SessionSpec } from "../src/types.ts";

/**
 * A stand-in for the acp profile: it logs every request (and how it was launched) to LOG, answers
 * session/new with two provider groups, and plays a turn's updates. "ask" asks for permission
 * before a bash call; "slow" waits for session/cancel.
 */
const STANDIN = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const LOG = __LOG__;
const FAIL_RESUME = __FAIL_RESUME__;
const NO_MODEL = __NO_MODEL__;
if (process.argv.includes("--version")) {
  process.stdout.write("0.2.1-standin\\n");
  process.exit(0);
}
const args = process.argv.slice(2);
appendFileSync(LOG, JSON.stringify({ start: true, args, mode: process.env.DSH_PERMISSION_MODE ?? null }) + "\\n");
const out = (record) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...record }) + "\\n");
const config = (current, thinking) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: current, options: [
    { group: "prov", name: "prov", options: [{ value: '["prov","flash"]', name: "Flash" }, { value: '["prov","pro"]', name: "Pro" }] },
    { group: "other", name: "other", options: [{ value: '["other","solo"]', name: "Solo" }] },
  ] },
  ...(thinking ? [{ id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "off", name: "Off" }, { value: "high", name: "High" }] }] : []),
];
let current = '["prov","flash"]';
let inflight = null;
let permissionId = 900;
const watched = new Map();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) {
    if (message.method === "session/cancel" && inflight) inflight("cancelled");
    return;
  }
  if (message.method === undefined) {
    const done = watched.get(message.id);
    if (done) { watched.delete(message.id); done(message.result); }
    return;
  }
  appendFileSync(LOG, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  const reply = (result) => out({ id: message.id, result });
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      return reply({ protocolVersion: 1, agentInfo: { name: "dsh-standin" }, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] });
    case "session/new":
      return reply({ sessionId: "session-new", configOptions: NO_MODEL ? [] : config(current, current.includes("pro")) });
    case "session/resume":
      if (FAIL_RESUME) return out({ id: message.id, error: { code: -32603, message: "no such session" } });
      return reply({ configOptions: config(current, current.includes("pro")) });
    case "session/set_config_option": {
      if (params.configId === "model") current = params.value;
      return reply({ configOptions: config(current, current.includes("pro")) });
    }
    case "session/close":
      return reply({});
    case "session/prompt": {
      if (inflight) return out({ id: message.id, error: { code: -32602, message: "a prompt is already in flight for this session" } });
      const sessionId = params.sessionId;
      const text = String(params.prompt?.[0]?.text ?? "");
      const update = (update) => out({ method: "session/update", params: { sessionId, update } });
      if (text.includes("slow")) {
        update({ sessionUpdate: "tool_call", toolCallId: "call-slow", title: "bash", kind: "other", status: "in_progress", rawInput: { command: "sleep 30" } });
        inflight = (reason) => {
          inflight = null;
          update({ sessionUpdate: "tool_call_update", toolCallId: "call-slow", status: "failed", content: [{ type: "content", content: { type: "text", text: "aborted" } }] });
          reply({ stopReason: reason });
        };
        return;
      }
      if (text.includes("ask") || text.includes("mcp")) {
        const mcp = text.includes("mcp");
        update({ sessionUpdate: "tool_call", toolCallId: "call-ask", title: mcp ? "mcp__notes__record_note" : "bash", kind: "other", status: "in_progress", rawInput: mcp ? { text: "hi" } : { command: "rm -rf build" } });
        const id = ++permissionId;
        watched.set(id, (result) => {
          update({ sessionUpdate: "tool_call_update", toolCallId: "call-ask", status: "completed", content: [{ type: "content", content: { type: "text", text: "allowed: " + JSON.stringify(result) } }] });
          update({ sessionUpdate: "agent_message_chunk", messageId: "m-ask", content: { type: "text", text: "asked" } });
          reply({ stopReason: "end_turn" });
        });
        out({ id, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "call-ask" }, options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }] } });
        return;
      }
      update({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "bash", kind: "other", status: "in_progress", rawInput: { command: "echo hi" } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi" } }] });
      update({ sessionUpdate: "agent_message_chunk", messageId: "m-1", content: { type: "text", text: "hello" } });
      update({ sessionUpdate: "usage_update", used: 10, size: 100 });
      return reply({ stopReason: "end_turn" });
    }
    default:
      return reply({});
  }
});
`;

function standIn(options: { failResume?: boolean; noModel?: boolean } = {}): { binary: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "bots-dsh-standin-"));
  const binary = join(dir, "dsh.cjs");
  const log = join(dir, "requests.jsonl");
  writeFileSync(binary, STANDIN.replace("__LOG__", JSON.stringify(log)).replace("__FAIL_RESUME__", options.failResume ? "true" : "false")
    .replace("__NO_MODEL__", options.noModel ? "true" : "false"));
  chmodSync(binary, 0o755);
  return { binary, log };
}

// The adapter won't boot a profile DSH never created (its first boot installs plugins for
// minutes), so the tests point DSH_HOME at a home that has one.
const HOME = mkdtempSync(join(tmpdir(), "dsh-home-"));
mkdirSync(join(HOME, "profiles", "acp"), { recursive: true });
process.env.DSH_HOME = HOME;

function spec(extra: Partial<SessionSpec> = {}): SessionSpec {
  return { key: "k", cwd: tmpdir(), systemPrompt: "", mcpServers: {}, trustedTools: [], approvals: async () => ({ behavior: "allow" }), ...extra };
}

function requests(log: string): any[] {
  return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function record(session: RuntimeSession): { events: RuntimeEvent[]; ended: Promise<Extract<RuntimeEvent, { type: "turn_ended" }>>; wait: (match: (event: RuntimeEvent) => boolean) => Promise<RuntimeEvent> } {
  const events: RuntimeEvent[] = [];
  const waiters: { match: (event: RuntimeEvent) => boolean; resolve: (event: RuntimeEvent) => void }[] = [];
  let resolveEnded!: (event: Extract<RuntimeEvent, { type: "turn_ended" }>) => void;
  const ended = new Promise<Extract<RuntimeEvent, { type: "turn_ended" }>>((resolve) => (resolveEnded = resolve));
  session.on((event) => {
    events.push(event);
    if (event.type === "turn_ended") resolveEnded(event);
    for (const waiter of waiters.splice(0)) {
      if (waiter.match(event)) waiter.resolve(event);
      else waiters.push(waiter);
    }
  });
  return { events, ended, wait: (match) => new Promise((resolve) => waiters.push({ match, resolve })) };
}

describe("DshAdapter", () => {
  it("passes the bot's instructions as a system-prompt patch, and removes it on close", async () => {
    const { binary, log } = standIn();
    const session = await new DshAdapter({ binary }).open(spec({ systemPrompt: "You are Nova.\nCall {{tools}} when needed.", mode: "read-only" }));
    const start = requests(log)[0];
    expect(start.mode).toBe("read-only");
    const patchPath = start.args[start.args.indexOf("--patch") + 1];
    const patch = JSON.parse(readFileSync(patchPath, "utf8"));
    expect(patch).toHaveLength(1);
    expect(patch[0].id).toBe("system-prompt");
    expect(patch[0].name).toBe("@deepseek-ai/dsh-system-prompt");
    // DSH replaces the entry's whole config: the persona line has to come along, and the bot's
    // text can't leave a {{…}} group DSH would try to interpolate.
    expect(patch[0].config.personaPrefix).toContain("{{model}}");
    expect(patch[0].config.personaSuffix).toContain("You are Nova.");
    expect(patch[0].config.personaSuffix).toContain("{\u200B{tools}}");
    await session.close();
    await expect(access(patchPath)).rejects.toThrow();
  });

  it("says how to create the acp profile when DSH has never made one", async () => {
    const { binary, log } = standIn();
    await expect(new DshAdapter({ binary }).open(spec({ env: { DSH_HOME: join(tmpdir(), "dsh-home-missing") } }))).rejects.toThrow(/no "acp" profile/);
    // Nothing was spawned: no boot that would sit there installing plugins.
    expect(existsSync(log)).toBe(false);
  });

  it("says what to fix when the acp profile has no model", async () => {
    const { binary } = standIn({ noModel: true });
    await expect(new DshAdapter({ binary }).open(spec())).rejects.toThrow(/no model configured/);
  });

  it("reads models and their reasoning levels out of a throwaway session", async () => {
    const { binary } = standIn();
    const models = await new DshAdapter({ binary }).models();
    expect(models.map((model) => model.id)).toEqual(["prov/flash", "prov/pro", "other/solo"]);
    expect(models.map((model) => model.label)).toEqual(["Flash", "Pro", "Solo"]);
    expect(models.find((model) => model.id === "prov/pro")?.thinkingOptions?.map((option) => option.id)).toEqual(["off", "high"]);
    expect(models.find((model) => model.id === "other/solo")?.thinkingOptions).toBeUndefined();
  });

  it("turns a prompt's updates into timeline items", async () => {
    const { binary, log } = standIn();
    const session = await new DshAdapter({ binary }).open(spec({ systemPrompt: "be brief", model: "prov/pro", thinking: "high" }));
    const run = record(session);
    const sent = await session.send({ text: "hi" }, { whenBusy: "reject", clientMessageId: "c1" });
    expect(sent).toEqual({ ok: true, as: "turn", turnId: expect.any(String) });
    expect((await run.ended).outcome).toBe("completed");
    const items = run.events.flatMap((event) => (event.type === "item" ? [event.item] : []));
    expect(items[0]).toMatchObject({ type: "user_message", text: "hi" });
    const tools = items.flatMap((item) => (item.type === "tool_call" ? [item] : []));
    expect(tools.map((tool) => tool.status)).toEqual(["running", "completed"]);
    expect(tools[0]!.name).toBe("bash");
    expect(tools[1]!.detail).toMatchObject({ type: "shell", command: "echo hi", output: "hi" });
    expect(items.find((item) => item.type === "assistant_message")).toMatchObject({ text: "hello" });
    expect(run.events.find((event) => event.type === "usage")).toMatchObject({ usage: { contextWindowUsedTokens: 10, contextWindowMaxTokens: 100 } });
    // The model and its reasoning level go out as config options, not as part of the prompt.
    const config = requests(log).filter((request) => request.method === "session/set_config_option").map((request) => [request.params.configId, request.params.value]);
    expect(config).toEqual([["model", '["prov","pro"]'], ["reasoning_effort", "high"]]);
    await session.close();
  });

  it("refuses mid-turn input instead of steering", async () => {
    const { binary } = standIn();
    const session = await new DshAdapter({ binary }).open(spec());
    const run = record(session);
    await session.send({ text: "slow" }, { whenBusy: "reject", clientMessageId: "c1" });
    await run.wait((event) => event.type === "item" && event.item.type === "tool_call" && event.item.status === "running");
    await expect(session.send({ text: "more" }, { whenBusy: "steer", clientMessageId: "c2" })).resolves.toMatchObject({ ok: false, reason: "steer_unavailable" });
    const canceled = await session.interrupt();
    expect(canceled.canceledTurnId).toEqual(expect.any(String));
    const items = run.events.flatMap((event) => (event.type === "item" && event.item.type === "tool_call" ? [event.item] : []));
    expect(items.at(-1)?.status).toBe("canceled");
    await session.close();
  });

  it("answers a permission request with the tool its update named", async () => {
    const { binary } = standIn();
    const asked: ApprovalRequest[] = [];
    const session = await new DshAdapter({ binary }).open(spec({ approvals: async (request) => { asked.push(request); return { behavior: "allow" }; } }));
    const run = record(session);
    await session.send({ text: "ask" }, { whenBusy: "reject", clientMessageId: "c1" });
    await run.ended;
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ provider: "dsh", name: "bash", kind: "tool", detail: { type: "shell", command: "rm -rf build" } });
    const items = run.events.flatMap((event) => (event.type === "item" && event.item.type === "tool_call" ? [event.item] : []));
    expect(JSON.stringify(items.at(-1)?.detail)).toContain("allow-once");
    await session.close();
  });

  it("answers a trusted MCP tool without asking", async () => {
    const { binary } = standIn();
    let asked = 0;
    const session = await new DshAdapter({ binary }).open(spec({ trustedTools: ["notes"], approvals: async () => { asked += 1; return { behavior: "deny" }; } }));
    const run = record(session);
    await session.send({ text: "mcp" }, { whenBusy: "reject", clientMessageId: "c1" });
    await run.ended;
    expect(asked).toBe(0);
    const items = run.events.flatMap((event) => (event.type === "item" && event.item.type === "tool_call" ? [event.item] : []));
    expect(items.at(-1)?.name).toBe("mcp__notes__record_note");
    await session.close();
  });

  it("resumes the session it is given, and starts a new one when that fails", async () => {
    const { binary, log } = standIn();
    const session = await new DshAdapter({ binary }).open(spec({ resume: { provider: "dsh", sessionId: "old-session" } }));
    expect(session.handle).toMatchObject({ provider: "dsh", sessionId: "old-session" });
    expect(requests(log).some((request) => request.method === "session/resume" && request.params.sessionId === "old-session")).toBe(true);
    await session.close();

    const failing = standIn({ failResume: true });
    const fresh = await new DshAdapter({ binary: failing.binary }).open(spec({ resume: { provider: "dsh", sessionId: "gone" }, systemPrompt: "be brief" }));
    expect(fresh.handle).toMatchObject({ sessionId: "session-new" });
    const run = record(fresh);
    await fresh.send({ text: "hi" }, { whenBusy: "reject", clientMessageId: "c1" });
    expect(run.events.find((event) => event.type === "item" && event.item.type === "notification")).toMatchObject({ item: { level: "warning" } });
    await fresh.close();
  });

  it("gives DSH MCP servers it can use, and says what it dropped", async () => {
    const { binary, log } = standIn();
    const session = await new DshAdapter({ binary }).open(
      spec({
        systemPrompt: "be brief",
        mcpServers: {
          notes: { type: "stdio", command: "node", args: ["server.js"] },
          remote: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { "x-key": "v" } },
          legacy: { type: "sse", url: "http://127.0.0.1:1/sse" },
        },
      }),
    );
    const created = requests(log).find((request) => request.method === "session/new");
    const servers = created.params.mcpServers;
    expect(servers).toHaveLength(2);
    // DSH requires an absolute command for a stdio server.
    expect(servers[0]).toMatchObject({ name: "notes", args: ["server.js"] });
    expect(servers[0].command.startsWith("/")).toBe(true);
    expect(servers[1]).toMatchObject({ type: "http", name: "remote", url: "http://127.0.0.1:1/mcp", headers: [{ name: "x-key", value: "v" }] });
    const run = record(session);
    await session.send({ text: "hi" }, { whenBusy: "reject", clientMessageId: "c1" });
    const notice = run.events.find((event) => event.type === "item" && event.item.type === "notification");
    expect(JSON.stringify(notice)).toContain("legacy");
    await session.close();
  });
});
