import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFrontmatter } from "../shared/skills";
import { dataPath } from "./bot-home";
import { RequestError } from "./errors";
import { librarySkillPath, sha256 } from "./library";

// Skills that ship with pocket-bots, in packages/app/bundled-skills/<id>: the roles that need one
// (New bot templates) put it in the library for the bots they make. They arrive reviewed, since
// they're reviewed as part of pocket-bots. A library copy the user hasn't changed follows the one
// in the app as it's updated; a copy they changed stays theirs.

/** The library's `source` for a bundled skill. */
export const BUNDLED_SOURCE = "pocket-bots";

export interface InstalledSkill {
  id: string;
  description: string;
  source: string;
  /** The SKILL.md hash it's reviewed at; absent for a copy the user changed, which keeps its own review. */
  reviewedSha?: string;
}

function bundledRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bundled-skills");
}

/** id → hash of the files as last put in the library, to tell an untouched copy from the user's own. */
function recordPath(): string {
  return join(dataPath(), "library", "bundled.json");
}

async function readRecord(): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recordPath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function writeRecord(record: Record<string, string>): Promise<void> {
  await mkdir(dirname(recordPath()), { recursive: true });
  await writeFile(recordPath(), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** A folder's files by relative path; empty when it's missing. Links aren't followed. */
async function readFolder(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files[relative(root, path).split(sep).join("/")] = await readFile(path, "utf8");
    }
  };
  await walk(root);
  return files;
}

function folderHash(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) hash.update(`${path}\0${files[path]}\0`);
  return hash.digest("hex");
}

async function writeFolder(root: string, files: Record<string, string>): Promise<void> {
  await rm(root, { recursive: true, force: true });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text, "utf8");
  }
}

const describe = (skillMd: string | undefined) => parseSkillFrontmatter(skillMd ?? "").description ?? "";

export async function bundledSkillIds(): Promise<string[]> {
  const entries = await readdir(bundledRoot(), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** Puts these bundled skills in the library folder, unless the user changed their copy. */
export async function installBundledSkills({ ids }: { ids: readonly string[] }): Promise<{ skills: InstalledSkill[] }> {
  const known = await bundledSkillIds();
  const record = await readRecord();
  const skills: InstalledSkill[] = [];
  for (const id of ids) {
    if (!known.includes(id)) throw new RequestError(`pocket-bots has no bundled skill called "${id}".`);
    const files = await readFolder(join(bundledRoot(), id));
    const current = await readFolder(librarySkillPath(id));
    const untouched = Object.keys(current).length === 0 || folderHash(current) === record[id];
    if (!untouched) {
      skills.push({ id, description: describe(current["SKILL.md"]), source: BUNDLED_SOURCE });
      continue;
    }
    const hash = folderHash(files);
    if (folderHash(current) !== hash) await writeFolder(librarySkillPath(id), files);
    record[id] = hash;
    skills.push({ id, description: describe(files["SKILL.md"]), source: BUNDLED_SOURCE, reviewedSha: sha256(files["SKILL.md"] ?? "") });
  }
  await writeRecord(record);
  return { skills };
}

/**
 * Brings the library's untouched copies of bundled skills up to the ones in this version of the
 * app, at startup. Returns the ones it replaced, to update their review in the library.
 */
export async function refreshBundledSkills(): Promise<InstalledSkill[]> {
  const known = await bundledSkillIds();
  const record = await readRecord();
  const refreshed: InstalledSkill[] = [];
  let changed = false;
  for (const id of Object.keys(record)) {
    const current = await readFolder(librarySkillPath(id));
    // Deleted from the library, or no longer shipped: forget it.
    if (Object.keys(current).length === 0 || !known.includes(id)) {
      delete record[id];
      changed = true;
      continue;
    }
    if (folderHash(current) !== record[id]) continue;
    const files = await readFolder(join(bundledRoot(), id));
    const hash = folderHash(files);
    if (hash === record[id]) continue;
    await writeFolder(librarySkillPath(id), files);
    record[id] = hash;
    changed = true;
    refreshed.push({ id, description: describe(files["SKILL.md"]), source: BUNDLED_SOURCE, reviewedSha: sha256(files["SKILL.md"] ?? "") });
  }
  if (changed) await writeRecord(record);
  return refreshed;
}
