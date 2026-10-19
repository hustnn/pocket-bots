import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../src/adapters/fake.ts";
import { toolDetail } from "../src/tool-detail.ts";
import { parseSlash } from "../src/util.ts";
import type { RuntimeEvent, RuntimeSession, SessionSpec } from "../src/types.ts";

const spec: SessionSpec = { key: "k", cwd: "/tmp", systemPrompt: "", mcpServers: {}, trustedTools: [], approvals: async () => ({ behavior: "allow" }) };

function record(session: RuntimeSession) {
  const events: RuntimeEvent[] = [];
  session.on((event) => events.push(event));
  const ended = () => new Promise<Extract<RuntimeEvent, { type: "turn_ended" }>>((resolve) => session.on((event) => event.type === "turn_ended" && resolve(event)));
  return { events, ended };
}

describe("runtime sessions", () => {
  it("steers a running turn, and the steer is accepted into it", async () => {
    const session = await new FakeAdapter((turn, step) => (step === 0 ? { wait: 100 } : step === 1 ? { say: turn.steers.join("|") } : null)).open(spec);
    const { events, ended } = record(session);
    const done = ended();
    const first = await session.send({ text: "go" }, { whenBusy: "reject", clientMessageId: "a" });
    expect(first).toMatchObject({ ok: true, as: "turn" });
    const steer = await session.send({ text: "also" }, { whenBusy: "steer", clientMessageId: "b", expectedTurnId: first.ok ? first.turnId! : "" });
    expect(steer).toMatchObject({ ok: true, as: "steer", turnId: first.ok ? first.turnId : null });
    expect((await done).outcome).toBe("completed");
    expect(events.filter((event) => event.type === "input_accepted").map((event) => event.type === "input_accepted" && [event.clientMessageId, event.as])).toEqual([
      ["a", "turn"],
      ["b", "steer"],
    ]);
    expect(events.some((event) => event.type === "item" && event.item.type === "assistant_message" && event.item.text === "also")).toBe(true);
  });

  it("rejects a steer aimed at a turn that already ended, and rejects or queues when told to", async () => {
    const session = await new FakeAdapter((_turn, step) => (step === 0 ? { wait: 80 } : null)).open(spec);
    const { ended } = record(session);
    const first = await session.send({ text: "one" }, { whenBusy: "reject", clientMessageId: "1" });
    expect(await session.send({ text: "x" }, { whenBusy: "steer", clientMessageId: "x", expectedTurnId: "old" })).toEqual({ ok: false, reason: "turn_mismatch" });
    expect(await session.send({ text: "x" }, { whenBusy: "reject", clientMessageId: "y" })).toEqual({ ok: false, reason: "busy" });
    const queued = await session.send({ text: "two" }, { whenBusy: "queue", clientMessageId: "2" });
    expect(queued).toEqual({ ok: true, as: "queued", turnId: null });
    const firstEnd = await ended();
    expect(firstEnd.turnId).toBe(first.ok ? first.turnId : null);
    // The queued message starts the next turn on its own.
    const secondEnd = await ended();
    expect(secondEnd.turnId).not.toBe(firstEnd.turnId);
  });

  it("interrupts and resolves once the turn has ended", async () => {
    const session = await new FakeAdapter((_turn, step) => (step === 0 ? { wait: 10_000 } : null)).open(spec);
    const { ended } = record(session);
    const done = ended();
    const sent = await session.send({ text: "long" }, { whenBusy: "reject", clientMessageId: "1" });
    const result = await session.interrupt();
    expect(result.canceledTurnId).toBe(sent.ok ? sent.turnId : null);
    expect((await done).outcome).toBe("canceled");
    expect(session.activeTurnId).toBeNull();
    expect(await session.interrupt()).toEqual({ canceledTurnId: null });
  });
});

describe("slash commands", () => {
  it("splits a command from its arguments, and leaves other text alone", () => {
    expect(parseSlash("/compact")).toEqual({ name: "compact", args: "" });
    expect(parseSlash("  /review  the auth module\nand tests ")).toEqual({ name: "review", args: "the auth module\nand tests" });
    expect(parseSlash("/skill:pdf-tools extract page 2")).toEqual({ name: "skill:pdf-tools", args: "extract page 2" });
    expect(parseSlash("/usr/bin/env is a path")).toBeNull();
    expect(parseSlash("please /compact")).toBeNull();
    expect(parseSlash("/")).toBeNull();
  });
});

describe("tool details", () => {
  it("maps the runtimes' tool names to the timeline's detail kinds", () => {
    expect(toolDetail("Bash", { command: "ls" }, { text: "a\nb", exitCode: 0 })).toEqual({ type: "shell", command: "ls", output: "a\nb", exitCode: 0 });
    expect(toolDetail("shell", { command: ["git", "status"] })).toMatchObject({ type: "shell", command: "git status" });
    expect(toolDetail("Read", { file_path: "/a.ts", offset: 1 })).toEqual({ type: "read", filePath: "/a.ts", offset: 1 });
    expect(toolDetail("edit", { path: "/a.ts", oldString: "x", newString: "y" })).toEqual({ type: "edit", filePath: "/a.ts", oldString: "x", newString: "y" });
    expect(toolDetail("Glob", { pattern: "*.ts" }, { text: "a.ts\nb.ts" })).toEqual({ type: "search", query: "*.ts", toolName: "glob", filePaths: ["a.ts", "b.ts"] });
    expect(toolDetail("WebFetch", { url: "https://x.dev", prompt: "sum" })).toEqual({ type: "fetch", url: "https://x.dev", prompt: "sum" });
    expect(toolDetail("mcp__bots__post_to_group", { text: "hi" }, { text: "sent" })).toEqual({ type: "unknown", input: { text: "hi" }, output: "sent" });
  });
});
