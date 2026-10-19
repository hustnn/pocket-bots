import { describe, expect, it } from "vitest";
import { launchdPlist, serviceSpec, systemdUnit, type ServiceSpec } from "../src/server/service";

const spec: ServiceSpec = {
  command: ["/opt/node/bin/node", "/src/My Bots & Co/node_modules/tsx/dist/cli.mjs", "src/server/main.ts"],
  cwd: "/src/My Bots & Co/packages/app",
  env: { PATH: "/usr/bin:/bin", HOME: "/Users/me", POCKET_BOTS_PORT: "6880" },
  logFile: "/Users/me/.pocket-bots/logs/server.log",
};

describe("running as a service", () => {
  it("keeps the PATH and pocket-bots's own settings, nothing else from the environment", () => {
    const kept = serviceSpec({ PATH: "/repo/node_modules/.bin:/usr/bin:/usr/bin:/bin", HOME: "/Users/me", POCKET_BOTS_HOME: "/data", ANTHROPIC_API_KEY: "no", CLAUDECODE: "1" });
    expect(kept.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/Users/me", POCKET_BOTS_HOME: "/data" });
    expect(kept.command.at(-1)).toBe("src/server/main.ts");
    expect(kept.logFile).toBe("/data/logs/server.log");
  });

  it("writes a launchd agent that starts at login and restarts after a crash", () => {
    const plist = launchdPlist(spec);
    expect(plist).toContain("<string>/src/My Bots &amp; Co/packages/app</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n      <false/>");
    expect(plist).toContain("<key>POCKET_BOTS_PORT</key>\n      <string>6880</string>");
  });

  it("writes a systemd user unit with every word quoted", () => {
    const unit = systemdUnit({ ...spec, env: { ...spec.env, POCKET_BOTS_HOME: '/data/100% "mine"' } });
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/src/My Bots & Co/node_modules/tsx/dist/cli.mjs" "src/server/main.ts"');
    expect(unit).toContain('Environment="POCKET_BOTS_HOME=/data/100%% \\"mine\\""');
    expect(unit).toContain("WantedBy=default.target");
  });
});
