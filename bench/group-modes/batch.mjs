#!/usr/bin/env node
// A batch: waits until the model answers (Sophon was down once), then runs every (task, seed) with
// its ways of working side by side, re-running a (task, seed) the provider broke. Results land
// where run.mjs puts them ($RESULTS); results/v2 and results/v3 here are two such batches.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXP = dirname(fileURLToPath(import.meta.url));
const RESULTS = process.env.RESULTS ?? join(tmpdir(), "pocket-bots-group-modes");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

function run(task, arm, seed, port, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [join(EXP, "run.mjs"), task, arm, String(seed), String(port)], { env: { ...process.env, ...env }, stdio: "ignore" });
    child.on("exit", () => {
      const path = join(RESULTS, `${task}-${arm}-${seed}`, "result.json");
      resolve(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { outcome: "no_result" });
    });
  });
}

async function waitForModel() {
  for (let attempt = 1; ; attempt++) {
    const result = await run("quick", "board", `probe${attempt}`, 7101, { QUIET_MS: "10000", TIMEOUT_MS: "180000" });
    rmSync(join(RESULTS, `quick-board-probe${attempt}`), { recursive: true, force: true });
    if (result.outcome === "completed" && result.totals?.calls > 0) return log(`model answers again (probe ${attempt})`);
    log(`model still down (probe ${attempt}: ${result.outcome})`);
    await sleep(4 * 60_000);
  }
}

const plan = [];
for (const task of ["quick", "code", "audit"]) {
  for (const seed of [1, 2, 3]) {
    const arms = ["free", "leader", "board"];
    plan.push({ task, seed, arms });
  }
}

await waitForModel();
for (const { task, seed, arms } of plan) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const results = await Promise.all(arms.map((arm, index) => run(task, arm, seed, 7121 + index)));
    const broken = arms.filter((_, index) => results[index].outcome === "provider_error" || results[index].outcome === "no_result");
    for (const [index, arm] of arms.entries()) log(`${task}-${arm}-${seed}: ${results[index].outcome} ${JSON.stringify(results[index].score)} ${results[index].totals?.tokens ?? 0} tokens ${results[index].wallSeconds ?? "?"}s`);
    if (!broken.length) break;
    // Run the whole (task, seed) again, so its ways of working stay side by side.
    log(`provider broke ${broken.join(", ")}; waiting for the model, then running ${task} seed ${seed} again`);
    await waitForModel();
  }
}
log("BATCH-DONE");
