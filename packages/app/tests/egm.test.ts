import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BotSettingsValues } from "../src/shared/bot";
import { applyChanges, ChangesSchema, type ApplyContext } from "../src/shared/changes";
import { addBundledSkills } from "../src/shared/library";
import { BOT_TEMPLATES, newBot, templateSkills, withTemplateSettings } from "../src/shared/templates";
import { makeBot, NOW } from "./helpers";

// The Elephant-Goldfish Model roles: their templates, the skills that ship with them, and how
// those reach the library.

const elephant = BOT_TEMPLATES.find((template) => template.id === "elephant")!;
const goldfish = BOT_TEMPLATES.find((template) => template.id === "goldfish")!;
const BUNDLED = join(__dirname, "..", "bundled-skills");

describe("Elephant and Goldfish templates", () => {
  it("start with their skill, starters and Recent work setting", () => {
    const e = newBot("claude", elephant);
    expect(e.skillIds).toEqual(["egm"]);
    expect(e.includeRecentWork).toBe(true);
    expect(e.starters.map((starter) => starter.text.trim())).toEqual(["egm brainstorm", "egm draft", "egm review docs/designs/", "egm drift report docs/designs/"]);
    const g = newBot("claude", goldfish);
    expect(g.skillIds).toEqual(["egm-goldfish"]);
    expect(g.includeRecentWork).toBe(false);
    expect(g.starters).toEqual([]);
    // Other roles are as they were.
    expect(newBot("claude", BOT_TEMPLATES[0]).skillIds).toEqual([]);
    expect(newBot("claude", BOT_TEMPLATES[0]).includeRecentWork).toBe(true);
  });

  it("put the Goldfish on a ready agent it can hold to reading, in its read-only mode", () => {
    const defaults = { ...newBot("claude", goldfish), model: "opus", modeId: "default", thinkingOptionId: "high", contactBots: "allow" as const };
    const onCodex = withTemplateSettings(defaults, goldfish, ["claude", "codex"]);
    expect(onCodex).toMatchObject({ provider: "codex", model: null, modeId: "read-only", thinkingOptionId: null, contactBots: "off" });
    expect(withTemplateSettings(defaults, goldfish, ["dsh"])).toMatchObject({ provider: "dsh", modeId: "read-only" });
    // Neither is ready: it stays on the default agent and model, in the mode that asks before changes, and can't contact bots.
    expect(withTemplateSettings({ ...defaults, modeId: "bypassPermissions" }, goldfish, ["claude"])).toMatchObject({ provider: "claude", model: "opus", modeId: "default", contactBots: "off" });
    expect(withTemplateSettings(defaults, elephant, ["claude", "codex"])).toMatchObject({ provider: "claude", modeId: "default", contactBots: "allow" });
    expect(withTemplateSettings(defaults, undefined, ["codex"])).toBe(defaults);
  });

  it("list the skills the roles in a set of changes need", () => {
    expect(templateSkills(["elephant", undefined, "goldfish", "elephant", "ops"])).toEqual(["egm", "egm-goldfish"]);
    expect(templateSkills([undefined])).toEqual([]);
  });

  it("give a proposed bot its role's mode on the agent it ends up with, without widening its contact", () => {
    const values: BotSettingsValues = { bots: [makeBot({ id: "chief", name: "Chief" })], history: [], library: { skills: [], mcpServers: [] }, teams: [] };
    const context: ApplyContext = { now: NOW, provider: "claude" };
    const apply = (change: Record<string, unknown>) => applyChanges(values, ChangesSchema.parse([{ type: "create_bot", ...change }]), context).bots[1]!;
    expect(apply({ name: "Fin", role: "goldfish", provider: "codex" })).toMatchObject({ provider: "codex", modeId: "read-only", skillIds: ["egm-goldfish"], includeRecentWork: false, contactBots: "ask" });
    expect(apply({ name: "Fin", role: "goldfish", provider: "codex", mode: "auto" }).modeId).toBe("auto");
    expect(apply({ name: "Ella", role: "elephant" })).toMatchObject({ provider: "claude", modeId: null, skillIds: ["egm"], contactBots: "ask" });
    expect(apply({ name: "Fin", role: "goldfish" }).modeId).toBe("default");
  });
});

describe("the EGM skills that ship with pocket-bots", () => {
  const read = (path: string) => readFile(join(BUNDLED, path), "utf8");

  it("name only personas and standards the Goldfish has", async () => {
    const personas = (await readdir(join(BUNDLED, "egm-goldfish", "personas"))).map((name) => name.replace(/\.md$/, ""));
    const standards = (await readdir(join(BUNDLED, "egm-goldfish", "standards"))).map((name) => name.replace(/\.md$/, ""));
    const elephantSkill = await read("egm/SKILL.md");
    // The Elephant's table of persona names, and the standards it lists.
    const named = [...elephantSkill.matchAll(/^\s*\| egm-[a-z-]+ \| ([a-z_]+) \|$/gm)].map((match) => match[1]);
    expect(named.sort()).toEqual([...personas].sort());
    for (const standard of standards) expect(elephantSkill).toContain(standard);
    // Every standard a review workflow gives a reviewer is one the Goldfish can read.
    const review = await read("egm/workflows/review.md");
    for (const [, name] of review.matchAll(/"([a-z-]+-standard)"/g)) expect(standards).toContain(name);
    const goldfishSkill = await read("egm-goldfish/SKILL.md");
    for (const persona of personas) expect(goldfishSkill).toContain(persona);
  });

  it("route every command to a workflow that's there, and carry the license", async () => {
    const elephantSkill = await read("egm/SKILL.md");
    const workflows = [...elephantSkill.matchAll(/`(workflows\/[a-z_]+\.md)`/g)].map((match) => match[1]!);
    expect(workflows.length).toBeGreaterThanOrEqual(7);
    for (const path of workflows) await expect(read(join("egm", path))).resolves.toBeTruthy();
    await expect(read("egm/references/design_doc.md")).resolves.toContain("## Detailed Implementation Plan");
    await expect(read("egm/execution_instructions.md")).resolves.toContain("Design-Only Scope");
    for (const skill of ["egm", "egm-goldfish"]) await expect(read(`${skill}/LICENSE`)).resolves.toContain("Apache License");
  });
});

describe("bundled skills in the library", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pocket-bots-bundled-"));
    process.env.POCKET_BOTS_HOME = home;
  });
  afterAll(async () => {
    delete process.env.POCKET_BOTS_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("go in reviewed, follow new versions while untouched, and stay the user's once changed", async () => {
    const { installBundledSkills, refreshBundledSkills } = await import("../src/server/bundled-skills");
    const { librarySkillPath, sha256 } = await import("../src/server/library");
    const shipped = await readFile(join(BUNDLED, "egm", "SKILL.md"), "utf8");

    const first = await installBundledSkills({ ids: ["egm"] });
    expect(first.skills).toEqual([{ id: "egm", description: expect.stringContaining("Elephant-Goldfish"), source: "pocket-bots", reviewedSha: sha256(shipped) }]);
    expect(await readFile(join(librarySkillPath("egm"), "workflows", "review.md"), "utf8")).toContain("Goldfish");
    // Installing again is the same.
    expect((await installBundledSkills({ ids: ["egm"] })).skills[0]!.reviewedSha).toBe(sha256(shipped));
    expect(await refreshBundledSkills()).toEqual([]);

    // A copy from an earlier version of the app, untouched since: the next start brings it up to date.
    await writeFile(join(librarySkillPath("egm"), "SKILL.md"), "old version", "utf8");
    const record = join(home, "library", "bundled.json");
    const { createHash } = await import("node:crypto");
    const files = await (async function read(dir: string, base = ""): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) Object.assign(out, await read(join(dir, entry.name), path));
        else out[path] = await readFile(join(dir, entry.name), "utf8");
      }
      return out;
    })(librarySkillPath("egm"));
    const hash = createHash("sha256");
    for (const path of Object.keys(files).sort()) hash.update(`${path}\0${files[path]}\0`);
    await writeFile(record, JSON.stringify({ egm: hash.digest("hex") }), "utf8");
    expect((await refreshBundledSkills()).map((skill) => skill.reviewedSha)).toEqual([sha256(shipped)]);
    expect(await readFile(join(librarySkillPath("egm"), "SKILL.md"), "utf8")).toBe(shipped);

    // The user's own edit stays, through installs and restarts, and keeps its own review.
    await writeFile(join(librarySkillPath("egm"), "SKILL.md"), "my version", "utf8");
    expect((await installBundledSkills({ ids: ["egm"] })).skills).toEqual([{ id: "egm", description: "", source: "pocket-bots" }]);
    expect(await refreshBundledSkills()).toEqual([]);
    expect(await readFile(join(librarySkillPath("egm"), "SKILL.md"), "utf8")).toBe("my version");

    // Deleted from the library: forgotten, and a template puts it back.
    await rm(librarySkillPath("egm"), { recursive: true });
    expect(await refreshBundledSkills()).toEqual([]);
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({});
    expect((await installBundledSkills({ ids: ["egm"] })).skills[0]!.reviewedSha).toBe(sha256(shipped));

    await expect(installBundledSkills({ ids: [".."] })).rejects.toThrow('no bundled skill called ".."');
  });

  it("are listed on and reviewed, except a changed copy, which keeps its review", () => {
    const library = { skills: [{ id: "egm", description: "mine", source: "pocket-bots", enabled: false, reviewedSha: "mine", createdAt: NOW, updatedAt: NOW }], mcpServers: [] };
    const fresh = addBundledSkills({ skills: [], mcpServers: [] }, [{ id: "egm-goldfish", description: "d", source: "pocket-bots", reviewedSha: "s" }]);
    expect(fresh.skills[0]).toMatchObject({ id: "egm-goldfish", enabled: true, reviewedSha: "s" });
    expect(addBundledSkills(library, [{ id: "egm", description: "", source: "pocket-bots" }])).toEqual(library);
    // The user switched it off in the library: a newer version keeps it off.
    expect(addBundledSkills(library, [{ id: "egm", description: "new", source: "pocket-bots", reviewedSha: "new" }]).skills[0]).toMatchObject({ enabled: false, reviewedSha: "new" });
    // Changed, and not listed in the library any more: it waits for a review.
    expect(addBundledSkills({ skills: [], mcpServers: [] }, [{ id: "egm", description: "", source: "pocket-bots" }]).skills[0]).toMatchObject({ enabled: false, reviewedSha: null });
  });
});
