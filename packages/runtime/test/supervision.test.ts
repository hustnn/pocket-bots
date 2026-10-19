// What the app's supervision needs from a runtime session: a turn it can give up, the runtime's
// own view of its turns, whether its process still runs, and Pi's failed compactions (a stand-in
// `pi` that speaks its RPC, so no model or login is needed).
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAdapter, type FakeSession } from "../src/adapters/fake.ts";
import { PiAdapter } from "../src/adapters/pi.ts";
import type { RuntimeEvent, SessionSpec } from "../src/types.ts";
import { processAlive } from "../src/util.ts";

const spec: SessionSpec = { key: "k", cwd: tmpdir(), systemPrompt: "", mcpServers: {}, trustedTools: [], approvals: async () => ({ behavior: "allow" }) };

/** A stand-in for Pi's RPC mode: it answers prompts, and its compaction fails unless PI_STANDIN_COMPACTION is "ok". */
const STANDIN = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
if (process.env.PI_STANDIN_ARGS) appendFileSync(process.env.PI_STANDIN_ARGS, JSON.stringify(process.argv.slice(2)) + "\\n");
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  const reply = (data) => out({ type: "response", id: command.id, command: command.type, success: true, data });
  if (command.type !== "prompt") return reply({});
  reply({ disposition: "started" });
  out({ type: "agent_start" });
  out({ type: "compaction_start", reason: "threshold" });
  if (process.env.PI_STANDIN_COMPACTION === "ok") out({ type: "compaction_end", reason: "threshold", result: { summary: "s", tokensBefore: 10 }, aborted: false, willRetry: false });
  else out({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, errorMessage: "The summary request didn't fit the model." });
  out({ type: "agent_end" });
  out({ type: "agent_settled" });
});
`;

function standIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "bots-pi-standin-"));
  const path = join(dir, "pi.cjs");
  writeFileSync(path, STANDIN);
  chmodSync(path, 0o755);
  return path;
}

function turnEnd(events: RuntimeEvent[]) {
  return new Promise<Extract<RuntimeEvent, { type: "turn_ended" }>>((resolve) => {
    const timer = setInterval(() => {
      const ended = events.find((event) => event.type === "turn_ended");
      if (ended) {
        clearInterval(timer);
        resolve(ended as Extract<RuntimeEvent, { type: "turn_ended" }>);
      }
    }, 10);
  });
}

describe("a session's supervision seams", () => {
  it("gives up a turn the runtime never showed: it ends canceled, and the next input starts a new one", async () => {
    const fake = new FakeAdapter();
    fake.sessionDefaults = { silent: true, reportsTurns: true };
    const session = (await fake.open(spec)) as FakeSession;
    const events: RuntimeEvent[] = [];
    session.on((event) => events.push(event));
    const sent = await session.send({ text: "hi" }, { whenBusy: "reject", clientMessageId: "1" });
    expect(sent).toMatchObject({ ok: true, as: "turn" });
    expect(session.liveTurn).toBe(false);
    session.abandonTurn();
    expect(session.activeTurnId).toBeNull();
    expect(events.at(-1)).toMatchObject({ type: "turn_ended", outcome: "canceled" });
    session.silent = false;
    expect(await session.send({ text: "again" }, { whenBusy: "reject", clientMessageId: "2" })).toMatchObject({ ok: true, as: "turn" });
  });

  it("says whether a child process still runs", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise((resolve) => child.once("spawn", resolve));
    expect(processAlive(child)).toBe(true);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(processAlive(child)).toBe(false);
    expect(processAlive(undefined)).toBeUndefined();
  });
});

describe("Pi's compactions and sessions", () => {
  it("shows a compaction with no result as failed, which fails the turn", async () => {
    const pi = new PiAdapter({ binary: standIn() });
    const session = await pi.open(spec);
    const events: RuntimeEvent[] = [];
    session.on((event) => events.push(event));
    const ended = turnEnd(events);
    expect(await session.send({ text: "hello" }, { whenBusy: "reject", clientMessageId: "1" })).toMatchObject({ ok: true, as: "turn" });
    const end = await ended;
    const compaction = events.filter((event) => event.type === "item" && event.item.type === "compaction").map((event) => (event as Extract<RuntimeEvent, { type: "item" }>).item);
    expect(compaction).toEqual([
      { type: "compaction", status: "loading", trigger: "auto" },
      { type: "compaction", status: "failed", trigger: "auto", error: "The summary request didn't fit the model." },
    ]);
    expect(end).toMatchObject({ outcome: "failed", error: "Context compaction failed: The summary request didn't fit the model." });
    await session.close();
  });

  it("shows a compaction with a result as completed, and the runtime's own turn while it runs", async () => {
    const pi = new PiAdapter({ binary: standIn() });
    const session = await pi.open({ ...spec, env: { PI_STANDIN_COMPACTION: "ok" } });
    expect(session.liveTurn).toBe(false);
    const events: RuntimeEvent[] = [];
    session.on((event) => events.push(event));
    const ended = turnEnd(events);
    await session.send({ text: "hello" }, { whenBusy: "reject", clientMessageId: "1" });
    expect((await ended).outcome).toBe("completed");
    expect(events.some((event) => event.type === "item" && event.item.type === "compaction" && event.item.status === "completed")).toBe(true);
    expect(session.liveTurn).toBe(false);
    expect(session.alive()).toBe(true);
    await session.close();
  });

  it("gives every new session an id of its own, so a chat that starts over doesn't load the old one", async () => {
    const binary = standIn();
    const args = join(mkdtempSync(join(tmpdir(), "bots-pi-args-")), "args.jsonl");
    const pi = new PiAdapter({ binary });
    const first = await pi.open({ ...spec, env: { PI_STANDIN_ARGS: args } });
    const second = await pi.open({ ...spec, env: { PI_STANDIN_ARGS: args } });
    const resumed = await pi.open({ ...spec, env: { PI_STANDIN_ARGS: args }, resume: first.handle! });
    const ids = readFileSync(args, "utf8").trim().split("\n").map((line) => {
      const argv = JSON.parse(line) as string[];
      return argv[argv.indexOf("--session-id") + 1];
    });
    expect(ids[0]).toMatch(/^bots-k-[0-9a-f]{8}$/);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[2]).toBe(ids[0]);
    await Promise.all([first.close(), second.close(), resumed.close()]);
  });
});
