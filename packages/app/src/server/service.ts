import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs pocket-bots as a per-user service that starts at login and restarts if it stops: a
// launchd agent on macOS, a systemd user unit on Linux. It runs what `npm start` runs, with the
// PATH it was installed from, so every agent CLI is found on its own login.

const LABEL = "local.pocket-bots";
const UNIT = "pocket-bots.service";

export interface ServiceSpec {
  /** node, then its arguments. */
  command: string[];
  cwd: string;
  env: Record<string, string>;
  logFile: string;
}

/** What the service runs and with which environment, from the current install. */
export function serviceSpec(env: NodeJS.ProcessEnv = process.env): ServiceSpec {
  const appDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
  // npm puts its own helpers and each package's node_modules/.bin first; the service doesn't need those.
  const path = (env.PATH ?? "")
    .split(":")
    .filter((entry) => entry && !entry.includes("node_modules/.bin") && !entry.includes("/@npmcli/run-script/"))
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .join(":");
  const kept: Record<string, string> = { PATH: path, HOME: env.HOME ?? homedir() };
  for (const [key, value] of Object.entries(env)) if (key.startsWith("POCKET_BOTS_") && value) kept[key] = value;
  // The data folder as the server will see it (bot-home's dataPath, from this environment).
  const data = env.POCKET_BOTS_HOME || join(kept.HOME!, ".pocket-bots");
  return { command: [process.execPath, tsx, "src/server/main.ts"], cwd: appDir, env: kept, logFile: join(data, "logs", "server.log") };
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(spec: ServiceSpec): string {
  const strings = (values: readonly string[]) => values.map((value) => `      <string>${xml(value)}</string>`).join("\n");
  const env = Object.entries(spec.env)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${strings(spec.command)}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(spec.cwd)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xml(spec.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(spec.logFile)}</string>
  </dict>
</plist>
`;
}

/** systemd's quoting: each word in double quotes, with backslashes, quotes and % escaped. */
const quote = (word: string) => `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=Pocket Bots
After=network-online.target

[Service]
WorkingDirectory=${quote(spec.cwd)}
ExecStart=${spec.command.map(quote).join(" ")}
${Object.entries(spec.env)
  .map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`)
  .join("\n")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function servicePath(platform: NodeJS.Platform): string {
  if (platform === "darwin") return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", UNIT);
}

function run(command: string, args: string[], quiet = false): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    const output = String((error as { stderr?: unknown }).stderr ?? (error as Error).message);
    if (!quiet) process.stderr.write(output);
    return { ok: false, output };
  }
}

const launchdTarget = () => `gui/${userInfo().uid}`;

/** `npm run service -- install | uninstall | status | print`. */
export async function runService(argv: readonly string[], platform: NodeJS.Platform = process.platform): Promise<number> {
  const action = argv[0] ?? "status";
  if (platform !== "darwin" && platform !== "linux") {
    console.error("Running pocket-bots as a service is set up for macOS (launchd) and Linux (systemd). Elsewhere, keep `npm start` running yourself.");
    return 1;
  }
  const spec = serviceSpec();
  const file = servicePath(platform);
  const contents = platform === "darwin" ? launchdPlist(spec) : systemdUnit(spec);
  switch (action) {
    case "print":
      console.log(`# ${file}\n${contents}`);
      return 0;
    case "install": {
      if (!existsSync(join(spec.cwd, "dist", "web", "index.html"))) {
        console.error("Build the web UI first: npm run build");
        return 1;
      }
      await mkdir(dirname(file), { recursive: true });
      await mkdir(dirname(spec.logFile), { recursive: true });
      await writeFile(file, contents);
      if (platform === "darwin") {
        run("launchctl", ["bootout", `${launchdTarget()}/${LABEL}`], true);
        if (!run("launchctl", ["bootstrap", launchdTarget(), file]).ok) return 1;
      } else {
        if (!run("systemctl", ["--user", "daemon-reload"]).ok) return 1;
        if (!run("systemctl", ["--user", "enable", "--now", UNIT]).ok) return 1;
      }
      console.log(`Installed ${file}. pocket-bots now starts when you log in and restarts if it stops.`);
      console.log(platform === "darwin" ? `Logs: ${spec.logFile}` : "Logs: journalctl --user -u pocket-bots. To start it at boot before you log in: loginctl enable-linger $USER");
      console.log("Stop any `npm start` you run yourself: one data folder takes one pocket-bots.");
      return 0;
    }
    case "uninstall":
      if (platform === "darwin") run("launchctl", ["bootout", `${launchdTarget()}/${LABEL}`], true);
      else run("systemctl", ["--user", "disable", "--now", UNIT], true);
      await rm(file, { force: true });
      if (platform === "linux") run("systemctl", ["--user", "daemon-reload"], true);
      console.log(`Removed ${file}.`);
      return 0;
    case "status": {
      if (!existsSync(file)) {
        console.log("Not installed. `npm run service -- install` sets it up.");
        return 0;
      }
      if (platform === "darwin") {
        const result = run("launchctl", ["print", `${launchdTarget()}/${LABEL}`], true);
        const state = /^\s*state = (.+)$/m.exec(result.output)?.[1] ?? "not loaded";
        const pid = /^\s*pid = (\d+)$/m.exec(result.output)?.[1];
        console.log(`Installed (${file}): ${state}${pid ? `, pid ${pid}` : ""}. Logs: ${spec.logFile}`);
      } else {
        const result = run("systemctl", ["--user", "is-active", UNIT], true);
        console.log(`Installed (${file}): ${result.output.trim() || "inactive"}. Logs: journalctl --user -u pocket-bots`);
      }
      return 0;
    }
    default:
      console.error("Usage: npm run service -- install | uninstall | status | print");
      return 2;
  }
}
