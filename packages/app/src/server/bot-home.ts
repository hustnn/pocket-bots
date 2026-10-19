import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where pocket-bots keeps its data: `$POCKET_BOTS_HOME`, or `~/.pocket-bots`. */
export function dataPath(): string {
  return process.env.POCKET_BOTS_HOME || join(homedir(), ".pocket-bots");
}

/** One folder for every bot that uses the managed folder. */
export function botsHomePath(): string {
  return join(dataPath(), "Bots");
}

/**
 * Each bot's own folder: the working folder of its chats, and where its
 * memory, skills and uploads live so its chats can read and update them.
 */
export function botDataPath(botId: string): string {
  return join(botsHomePath(), botId);
}

export async function ensureBotsHome() {
  const path = botsHomePath();
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "README.md"), "pocket-bots: one folder per bot, the working folder of that bot's chats.\n", { flag: "w" });
  return { path };
}

export async function ensureBotHome({ botId }: { botId: string }) {
  const { path: root } = await ensureBotsHome();
  const path = botDataPath(botId);
  await mkdir(path, { recursive: true });
  return { root, path };
}
