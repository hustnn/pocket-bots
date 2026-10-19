// Hide from sidebar: a hidden bot leaves the sidebar's main list and keeps working
// (its routines run, it takes new chats), unlike an archived one.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAdapter } from "@pocket-bots/runtime";
import { BotSchema, StoreSchema, type Routine } from "../src/shared/bot";
import { applyChanges, describeChange, setupOverview } from "../src/shared/changes";
import { fakeHost, makeBot } from "./helpers";

const NOW = "2026-10-19T00:00:00.000Z";

describe("a hidden bot", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pocket-bots-hidden-"));
    process.env.POCKET_BOTS_HOME = home;
  });
  afterAll(async () => {
    delete process.env.POCKET_BOTS_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("isn't hidden in a bots file from before hiding existed", () => {
    const { hidden: _hidden, ...old } = makeBot({ id: "old" });
    expect(BotSchema.parse(old).hidden).toBe(false);
    expect(StoreSchema.parse({ bots: [old] }).bots[0]!.hidden).toBe(false);
  });

  it("keeps running its routines; an archived bot's don't run", async () => {
    const { Relay } = await import("../src/server/relay");
    const { RoutineScheduler } = await import("../src/server/scheduler");
    const { ChatCards } = await import("../src/server/cards");
    const due = (id: string): Routine => ({ id, name: "Digest", prompt: "Post the digest.", enabled: true, schedule: { kind: "once", at: new Date(Date.now() - 30_000).toISOString() }, resultsChatId: null, createdAt: new Date(Date.now() - 60_000).toISOString() });
    const host = fakeHost([makeBot({ id: "bot-hidden", hidden: true, routines: [due("rt-hidden")] }), makeBot({ id: "bot-archived", archived: true, routines: [due("rt-archived")] })]);
    host.attach({ get: (agentId: string) => ({ id: agentId, status: "idle", archivedAt: null }) });
    const scheduler = new RoutineScheduler(host, new Relay(host, [], { port: 0 }), new ChatCards());
    scheduler.stop();
    const ran: string[] = [];
    (scheduler as unknown as { newChat: (...args: unknown[]) => Promise<string> }).newChat = async (bot) => {
      ran.push((bot as { id: string }).id);
      return `run-${ran.length}`;
    };
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();
    expect(ran).toEqual(["bot-hidden"]);
  });

  it("takes new chats; an archived bot doesn't", async () => {
    const { Db } = await import("../src/server/db");
    const { ChatService } = await import("../src/server/chat-service");
    const { startChat } = await import("../src/server/chats");
    const db = new Db(join(home, "chats.sqlite"));
    const chats = new ChatService(db, new Map([["fake", new FakeAdapter()]]), async () => ({ systemPrompt: "", mcpServers: {}, trustedTools: [] }), async () => null);
    chats.start();
    try {
      const hidden = makeBot({ id: "bot-h", provider: "fake", hidden: true });
      const host = fakeHost([hidden]);
      host.attach(chats);
      const chatId = await startChat(host, hidden, { prompt: "hello" });
      expect(chats.get(chatId)?.labels["pocket-bots.bot"]).toBe("bot-h");
      await expect(startChat(host, makeBot({ id: "bot-a", provider: "fake", archived: true, name: "Arch" }), { prompt: "hello" })).rejects.toThrow("Arch is archived.");
    } finally {
      await chats.stop();
      db.close();
    }
  });

  it("can be hidden or shown again by a proposed change, and get_setup says so", () => {
    const values = { bots: [makeBot({ id: "scout", name: "Scout" })], history: [] };
    const change = { type: "update_bot" as const, bot: "scout", hidden: true };
    const next = applyChanges(values, [change], { now: NOW, provider: "" });
    expect(next.bots[0]).toMatchObject({ hidden: true, archived: false });
    expect(describeChange(change)).toContain("hidden from the sidebar");
    expect(setupOverview(next, null, null)).toContain("hidden from the sidebar");
    expect(applyChanges(next, [{ ...change, hidden: false }], { now: NOW, provider: "" }).bots[0]!.hidden).toBe(false);
  });
});
