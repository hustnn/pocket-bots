// How an RPC's error reaches the web UI: the caller's own mistake is a 400, anything else a 500,
// and the UI shows the message either way.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineRpc } from "../src/shared/rpc-core";
import { groupCreateRpc } from "../src/shared/rpc";
import { Db } from "../src/server/db";
import { GroupStore } from "../src/server/group-store";
import { GroupChats } from "../src/server/groups";
import { createApp } from "../src/server/http";
import { rpcHandlers, type Services } from "../src/server/rpc-handlers";
import { rpc, RpcError } from "../src/web/lib/api";
import { fakeHost, makeBot } from "./helpers";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await cleanup?.();
  cleanup = null;
});

const brokenRpc = defineRpc({ name: "pocket.test.broken", input: z.object({}), output: z.object({}) });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "bots-http-"));
  const db = new Db(join(dir, "bots.sqlite"));
  const host = fakeHost([makeBot({ id: "alpha", name: "Alpha", provider: "fake" }), makeBot({ id: "beta", name: "Beta", provider: "fake" })]);
  const groups = new GroupChats(host, new GroupStore(db), async () => "seat");
  const registry = rpcHandlers({ groups } as Partial<Services> as Services);
  // A failure of ours, not the caller's.
  registry.set(brokenRpc.name, {
    contract: brokenRpc,
    handler: () => {
      throw new Error("The disk is full.");
    },
  });
  const app = createApp({ registry, hub: {} as never, host: {} as never, webRoot: null });
  // The web UI's client, talking to this server.
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => app.request(url, { ...init, headers: { ...(init.headers as Record<string, string>), host: "127.0.0.1:6780" } }));
  cleanup = async () => {
    groups.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { app };
}

describe("an RPC's error", () => {
  it("is a 400 when the caller asked for something that can't be done, and the UI shows why", async () => {
    await setup();
    const error = await rpc(groupCreateRpc, { memberIds: ["alpha"] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).status).toBe(400);
    expect((error as RpcError).message).toBe("A group chat needs at least 2 bots.");
    // Asked properly, the same RPC works.
    expect(await rpc(groupCreateRpc, { memberIds: ["alpha", "beta"] })).toEqual({ groupId: expect.any(String) });
  });

  it("is a 500 when something of ours failed, and is logged", async () => {
    await setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await rpc(brokenRpc, {}).catch((caught: unknown) => caught);
    expect((error as RpcError).status).toBe(500);
    expect((error as RpcError).message).toBe("The disk is full.");
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("is a 400 for input the contract refuses", async () => {
    const { app } = await setup();
    const response = await app.request("/api/rpc/pocket.groups.create", { method: "POST", headers: { host: "127.0.0.1:6780", "content-type": "application/json" }, body: JSON.stringify({ memberIds: "alpha" }) });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/^Invalid input: memberIds: /);
  });
});
