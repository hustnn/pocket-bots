import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("the bots document", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pocket-bots-store-"));
    process.env.POCKET_BOTS_HOME = home;
  });
  afterAll(async () => {
    delete process.env.POCKET_BOTS_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("sets an unreadable file aside on reset and starts empty", async () => {
    const { Store } = await import("../src/server/store");
    await writeFile(join(home, "bots.json"), '{"version": 3, "values": {"bots": "not a list"}}', "utf8");
    const broken = new Store();
    await expect(broken.read()).rejects.toThrow(/doesn't match the bots schema/);

    const { backup } = await broken.reset();
    expect(backup).toMatch(/bots\.json\.broken-/);
    expect(await readFile(backup!, "utf8")).toContain("not a list");
    expect((await broken.read()).values.bots).toEqual([]);
    // A fresh process reads the new, empty file.
    expect((await new Store().read()).values.bots).toEqual([]);
    expect((await readdir(home)).filter((name) => name.startsWith("bots.json"))).toHaveLength(2);
  });

  it("resets without a backup when there was no file", async () => {
    await rm(join(home, "bots.json"), { force: true });
    const { Store } = await import("../src/server/store");
    expect((await new Store().reset()).backup).toBeNull();
  });
});
