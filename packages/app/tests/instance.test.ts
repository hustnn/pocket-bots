import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockDataFolder, lockPath } from "../src/server/instance";

describe("one pocket-bots per data folder", () => {
  let folder: string;
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "pocket-bots-lock-"));
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("refuses a second instance and names the running one", async () => {
    const lock = await lockDataFolder(folder, 0);
    await expect(lockDataFolder(folder, 0)).rejects.toThrow(`pocket-bots is already running for ${folder} (pid ${process.pid}).`);
    // Another data folder is another lock.
    const other = await mkdtemp(join(tmpdir(), "pocket-bots-lock-"));
    (await lockDataFolder(other, 0)).release();
    await rm(other, { recursive: true, force: true });

    lock.release();
    await new Promise((wait) => setTimeout(wait, 50));
    (await lockDataFolder(folder, 0)).release();
  });

  it.skipIf(process.platform === "win32")("takes over from an instance that was killed", async () => {
    const path = lockPath(folder);
    await new Promise((wait) => setTimeout(wait, 50));
    const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}); setInterval(() => {}, 1000);`], { stdio: "ignore" });
    for (let tries = 0; !existsSync(path) && tries < 100; tries++) await new Promise((wait) => setTimeout(wait, 20));
    await expect(lockDataFolder(folder, 0)).rejects.toThrow("already running");
    child.kill("SIGKILL");
    await new Promise((done) => child.once("exit", done));
    // The socket file is still there, but nobody listens on it.
    expect(existsSync(path)).toBe(true);
    (await lockDataFolder(folder, 0)).release();
  });
});
