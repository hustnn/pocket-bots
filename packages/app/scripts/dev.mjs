// Runs the server (restarting on changes) and the Vite dev server together.
// The UI is on http://127.0.0.1:5180 and forwards /api to the server.
import { spawn } from "node:child_process";

const port = process.env.POCKET_BOTS_PORT ?? "6880";
const env = { ...process.env, POCKET_BOTS_PORT: port, POCKET_API: `http://127.0.0.1:${port}` };
const run = (name, args) => {
  const child = spawn("npm", ["run", name, "--", ...args], { stdio: "inherit", env, shell: process.platform === "win32" });
  child.on("exit", (code) => {
    if (code !== null && code !== 0) process.exitCode = code;
    for (const other of children) if (other !== child) other.kill();
  });
  return child;
};

const children = [run("dev:server", []), run("dev:web", [])];
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => children.forEach((child) => child.kill(signal)));
