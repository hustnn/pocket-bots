import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { botDataPath } from "./bot-home";

export function saveUpload({ botId, fileName, dataBase64 }: { botId: string; fileName: string; dataBase64: string }) {
  return saveFile(join(botDataPath(botId), "uploads"), fileName, dataBase64);
}

/** Writes a picked file into `dir` under a name that can't clash or escape it. */
export async function saveFile(dir: string, fileName: string, dataBase64: string) {
  const safe = fileName.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^\.+/, "") || "file";
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now().toString(36)}-${safe}`);
  const bytes = Buffer.from(dataBase64, "base64");
  await writeFile(path, bytes);
  return { path, size: bytes.length };
}
