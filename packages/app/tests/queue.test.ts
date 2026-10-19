import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatSnapshot } from "../src/shared/chat-types";
import { fakeChats, fakeHost, makeBot } from "./helpers";

/** Chats that report `status` and record what they're sent. */
function fakeDaemon(status: Record<string, string>) {
  const chats = Object.fromEntries(Object.keys(status).map((id) => [id, { get status() { return status[id] ?? "idle"; } }])) as never;
  const service = fakeChats(chats);
  return { api: service, sent: service.sent, status, failNext: service.failNext };
}

const agent = (id: string, status: string) => ({ id, status, archivedAt: null }) as unknown as ChatSnapshot;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function setup(status: Record<string, string>) {
  const { MessageQueue } = await import("../src/server/queue");
  const host = fakeHost([makeBot()]);
  const daemon = fakeDaemon(status);
  host.attach(daemon.api);
  const changes: string[] = [];
  const queue = new MessageQueue(host, (chatId) => changes.push(chatId));
  return { queue, daemon, changes, MessageQueue, host };
}

describe("the message queue", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pocket-bots-queue-"));
    process.env.POCKET_BOTS_HOME = home;
  });
  afterAll(async () => {
    delete process.env.POCKET_BOTS_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("holds messages while the chat works and sends them one at a time when it's idle", async () => {
    const { queue, daemon, changes } = await setup({ "chat-a": "running" });
    await queue.add("chat-a", { text: "first", attachments: [{ kind: "image", id: "img", name: "a.png", mimeType: "image/png", size: 3, data: "AAA" }] });
    await queue.add("chat-a", { text: "second", attachments: [] });
    expect(daemon.sent).toEqual([]);
    expect((await queue.list("chat-a")).messages.map((entry) => [entry.text, entry.attachments])).toEqual([
      ["first", [{ kind: "image", name: "a.png" }]],
      ["second", []],
    ]);
    expect(changes).toContain("chat-a");

    daemon.status["chat-a"] = "idle";
    queue.onAgent(agent("chat-a", "idle"));
    await settle();
    expect(daemon.sent).toHaveLength(1);
    expect(daemon.sent[0]).toMatchObject({ text: "first", whenBusy: "steer", images: [{ data: "AAA", mimeType: "image/png" }] });

    // A stale idle update before the new turn shows up doesn't send the next one.
    queue.onAgent(agent("chat-a", "idle"));
    await settle();
    expect(daemon.sent).toHaveLength(1);

    queue.onAgent(agent("chat-a", "running"));
    queue.onAgent(agent("chat-a", "idle"));
    await settle();
    expect(daemon.sent.map((entry) => entry.text)).toEqual(["first", "second"]);
    expect((await queue.list("chat-a")).messages).toEqual([]);
  });

  it("sends right away when the chat is already idle", async () => {
    const { queue, daemon } = await setup({ "chat-b": "idle" });
    await queue.add("chat-b", { text: "now please", attachments: [] });
    expect(daemon.sent.map((entry) => entry.text)).toEqual(["now please"]);
  });

  it("puts a failed send back and waits until it's resumed", async () => {
    const { queue, daemon } = await setup({ "chat-c": "idle" });
    daemon.failNext();
    await queue.add("chat-c", { text: "try me", attachments: [] });
    expect(daemon.sent).toEqual([]);
    expect(await queue.list("chat-c")).toMatchObject({ messages: [{ text: "try me" }], error: "The runtime said no." });

    queue.onAgent(agent("chat-c", "idle"));
    await settle();
    expect(daemon.sent).toEqual([]);

    await queue.resume("chat-c");
    expect(daemon.sent.map((entry) => entry.text)).toEqual(["try me"]);
    expect(await queue.list("chat-c")).toEqual({ messages: [], error: null });
  });

  it("takes messages back out, sends one now, and keeps the rest across restarts", async () => {
    const { queue, daemon, MessageQueue, host } = await setup({ "chat-d": "running" });
    const keep = await queue.add("chat-d", { text: "keep", attachments: [] });
    const edit = await queue.add("chat-d", { text: "edit me", attachments: [] });
    const urgent = await queue.add("chat-d", { text: "urgent", attachments: [] });

    expect(await queue.take("chat-d", edit)).toMatchObject({ text: "edit me" });
    expect(await queue.take("chat-d", edit)).toBeNull();

    await queue.sendNow("chat-d", urgent, "interrupt");
    expect(daemon.sent).toMatchObject([{ text: "urgent", whenBusy: "interrupt" }]);

    const reopened = new MessageQueue(host);
    expect((await reopened.list("chat-d")).messages.map((entry) => entry.id)).toEqual([keep]);

    await reopened.forget("chat-d");
    expect((await new MessageQueue(host).list("chat-d")).messages).toEqual([]);
  });
});
