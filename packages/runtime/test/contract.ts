// The scenario every adapter must pass, against a real CLI or the fake runtime:
//   1. a turn calls our MCP tool, runs a command that needs approval, and a steer sent while the
//      command runs joins the turn and is followed;
//   2. a second turn is interrupted while its command runs;
//   3. the session is closed and resumed in a new session, which remembers turn 1.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest, RuntimeAdapter, RuntimeEvent, RuntimeSession, SessionSpec } from "../src/types.ts";
import { startNoteHost } from "./mcp-host.ts";

export interface ContractReport {
  notes: string[];
  approvals: string[];
  steer: { result: string; accepted: boolean; followed: boolean };
  turn1: string;
  turn2: string;
  resumedAnswer: string;
  toolsAfterResume: boolean;
  events: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(session: RuntimeSession, match: (event: RuntimeEvent) => boolean, timeoutMs: number): Promise<RuntimeEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for an event"));
    }, timeoutMs);
    const off = session.on((event) => {
      if (!match(event)) return;
      clearTimeout(timer);
      off();
      resolve(event);
    });
  });
}

export async function runContract(adapter: RuntimeAdapter, options: { model?: string; mode?: string; env?: Record<string, string>; timeoutMs?: number; log?: (line: string) => void } = {}): Promise<ContractReport> {
  const log = options.log ?? (() => {});
  const timeout = options.timeoutMs ?? 240_000;
  const host = await startNoteHost();
  const cwd = mkdtempSync(join(tmpdir(), `bots-contract-${adapter.id}-`));
  const approvals: string[] = [];
  const events: string[] = [];
  const spec = (resume?: SessionSpec["resume"]): SessionSpec => ({
    key: "contract",
    cwd,
    ...(options.model ? { model: options.model } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.env ? { env: options.env } : {}),
    systemPrompt: "You are a test agent. Follow the user's steps exactly and keep replies short.",
    mcpServers: { notes: { type: "http", url: host.url } },
    trustedTools: ["notes"],
    hostedMcpServers: ["notes"],
    approvals: async (request: ApprovalRequest) => {
      approvals.push(request.name);
      log(`approval: ${request.name}`);
      return { behavior: "allow" };
    },
    ...(resume ? { resume } : {}),
  });
  const record = (session: RuntimeSession) =>
    session.on((event) => {
      const line = event.type === "item" ? `item ${event.item.type}${event.item.type === "tool_call" ? ` ${event.item.name} ${event.item.status}` : ""}` : event.type === "turn_ended" ? `turn_ended ${event.outcome}${event.error ? ` (${event.error})` : ""}` : event.type;
      if (events[events.length - 1] !== line) events.push(line);
      log(line);
    });

  try {
    const session = await adapter.open(spec());
    record(session);
    const steerId = "steer-1";
    let steerResult = "not sent";
    const shell = waitFor(session, (e) => e.type === "item" && e.item.type === "tool_call" && /sleep/.test(JSON.stringify(e.item.detail)), timeout);
    const ended1 = waitFor(session, (e) => e.type === "turn_ended", timeout);
    const accepted = waitFor(session, (e) => e.type === "input_accepted" && e.clientMessageId === steerId, timeout).then(() => true, () => false);
    const first = await session.send(
      { text: "Step 1: call the record_note tool with text 'hello-1'. Step 2: run the shell command `touch contract.txt && sleep 12 && echo slept`. Step 3: reply with the single word FIN." },
      { whenBusy: "reject", clientMessageId: "first" },
    );
    if (!first.ok) throw new Error(`first send failed: ${first.reason}`);
    await shell;
    await sleep(2000);
    const steer = await session.send({ text: "Extra instruction from the user: before you reply FIN, also call record_note with text 'steer-2'." }, { whenBusy: "steer", clientMessageId: steerId, expectedTurnId: first.turnId! });
    steerResult = steer.ok ? steer.as : steer.reason;
    const turn1 = (await ended1) as Extract<RuntimeEvent, { type: "turn_ended" }>;
    const steerAccepted = await Promise.race([accepted, sleep(1000).then(() => false)]);

    const shell2 = waitFor(session, (e) => e.type === "item" && e.item.type === "tool_call" && /time\.sleep\(25\)/.test(JSON.stringify(e.item.detail)), timeout);
    await session.send({ text: 'Run the shell command `python3 -c "import time; time.sleep(25); print(1)"` in the foreground and then reply DONE.' }, { whenBusy: "reject", clientMessageId: "second" });
    await shell2;
    await sleep(3000);
    await session.interrupt();
    const turn2 = events.filter((line) => line.startsWith("turn_ended")).pop() ?? "none";
    const handle = session.handle;
    await session.close();
    if (!handle) throw new Error("no resume handle");

    const resumed = await adapter.open(spec(handle));
    record(resumed);
    let answer = "";
    const off = resumed.on((event) => {
      if (event.type === "item" && event.item.type === "assistant_message") answer = event.item.text;
    });
    const ended3 = waitFor(resumed, (e) => e.type === "turn_ended", timeout);
    await resumed.send({ text: "Call the record_note tool with text 'resumed-3'. Then reply with only the text you passed to record_note the very first time in this conversation." }, { whenBusy: "reject", clientMessageId: "third" });
    await ended3;
    off();
    await resumed.close();

    return {
      notes: host.notes.slice(),
      approvals,
      steer: { result: steerResult, accepted: steerAccepted, followed: host.notes.includes("steer-2") },
      turn1: turn1.outcome,
      turn2,
      resumedAnswer: answer.trim(),
      toolsAfterResume: host.notes.includes("resumed-3"),
      events,
    };
  } finally {
    await host.close();
  }
}
