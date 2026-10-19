import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataPath } from "./bot-home";
import type { AllowedHostnames } from "./hosts";

// pocket-bots's own settings: where the web UI and the bots' tool relay listen.
// Read from $POCKET_BOTS_HOME/config.json, then environment variables.

const ConfigFileSchema = z.object({
  web: z
    .object({
      host: z.string().optional(),
      port: z.number().int().min(1).max(65_535).optional(),
      /** Extra Host names the web UI answers to; localhost and IP addresses always work. `true` allows any. */
      hostnames: z.union([z.literal(true), z.array(z.string())]).optional(),
    })
    .default({}),
  relay: z
    .object({
      /** Fixed loopback port for bot tools; chats keep this URL, so it should not change. */
      port: z.number().int().min(1).max(65_535).optional(),
    })
    .default({}),
});

export interface PocketConfig {
  webHost: string;
  webPort: number;
  /** Host names the web UI answers to besides localhost and IP addresses. */
  hostnames: AllowedHostnames;
  /** Null lets the relay reuse the last port it had (or pick a free one). */
  relayPort: number | null;
}

const DEFAULT_WEB_PORT = 6880;

function readConfigFile(): z.infer<typeof ConfigFileSchema> {
  const path = join(dataPath(), "config.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return ConfigFileSchema.parse({});
  }
  const parsed = ConfigFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${path} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

function envPort(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a port number.`);
  return port;
}

/** The file's hostnames plus POCKET_BOTS_HOSTNAMES (comma-separated, or "true"); lists append. */
function hostnames(file: true | string[] | undefined): AllowedHostnames {
  const env = process.env.POCKET_BOTS_HOSTNAMES?.trim();
  if (file === true || env === "true") return true;
  const fromEnv = env ? env.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
  return [...(file ?? []), ...fromEnv];
}

export function loadConfig(): PocketConfig {
  const file = readConfigFile();
  return {
    webHost: process.env.POCKET_BOTS_HOST ?? file.web.host ?? "127.0.0.1",
    webPort: envPort("POCKET_BOTS_PORT") ?? file.web.port ?? DEFAULT_WEB_PORT,
    hostnames: hostnames(file.web.hostnames),
    relayPort: envPort("POCKET_BOTS_RELAY_PORT") ?? file.relay.port ?? null,
  };
}
