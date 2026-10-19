import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeHost } from "./helpers";

function hold(port: number): Promise<Server> {
  const server = createServer();
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done(server));
  });
}

const release = (server: Server) => new Promise<void>((done) => server.close(() => done()));

describe("the relay port", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pocket-bots-relay-"));
    process.env.POCKET_BOTS_HOME = home;
  });
  afterAll(async () => {
    delete process.env.POCKET_BOTS_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const saved = async () => (JSON.parse(await readFile(join(home, "composio.json"), "utf8")) as { port: number }).port;

  it("keeps the port it picked on the first start, and won't move off it", async () => {
    const { Relay } = await import("../src/server/relay");
    const first = new Relay(fakeHost([]), []);
    const port = await first.start();
    expect(await saved()).toBe(port);
    first.stop();

    // Something else holds it: the start fails and says so, and the saved port stays.
    const blocker = await hold(port);
    const second = new Relay(fakeHost([]), [], { portWaitMs: 300 });
    const failure = await second.start().then(
      () => null,
      (error: Error) => error,
    );
    expect(failure?.message).toContain(`The relay port ${port} is in use by another program.`);
    expect(failure?.message).toContain(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    expect(await saved()).toBe(port);

    // Let go within the wait (a restart's old process): the start goes through on the same port.
    setTimeout(() => void release(blocker), 300);
    const third = new Relay(fakeHost([]), [], { portWaitMs: 3_000 });
    expect(await third.start()).toBe(port);
    third.stop();

    // A failed start can be tried again.
    expect(await second.start()).toBe(port);
    second.stop();
  });

  it("says when the configured port is taken", async () => {
    const { Relay } = await import("../src/server/relay");
    const blocker = await hold(0);
    const port = (blocker.address() as { port: number }).port;
    const relay = new Relay(fakeHost([]), [], { port, portWaitMs: 0 });
    await expect(relay.start()).rejects.toThrow(`The relay port ${port} (relay.port in config.json or POCKET_BOTS_RELAY_PORT) is in use by another program.`);
    await release(blocker);
  });
});
