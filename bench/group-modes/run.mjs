#!/usr/bin/env node
// One experiment run: a task, given to a group of four DeepSeek Harness bots in one way of working
// (free chat, a leader, or the shared board), on a pocket-bots server of its own (own data folder,
// port and copy of the task folder). It answers the bots' approvals, waits until every seat has been
// idle for QUIET_MS, then scores the outcome and reads each seat's token use from DSH's session logs.
//   node run.mjs <code|audit|quick> <free|leader|board> <seed> <port>
// Each run writes to $RESULTS/<task>-<arm>-<seed> (default: a folder in the system temp dir), outside
// the repo so the bots don't pick up its AGENTS.md; result.json there is the summary to keep.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const [task, arm, seed, portArg] = process.argv.slice(2);
if (!["code", "audit", "quick"].includes(task) || !["free", "leader", "board"].includes(arm) || !seed || !portArg) {
  console.error("usage: node run.mjs <code|audit|quick> <free|leader|board> <seed> <port>");
  process.exit(2);
}
const EXP = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO ?? join(EXP, "..", "..");
const MODEL = process.env.MODEL ?? "sophon/DeepSeek-V4.1-Flash-1017";
const PORT = Number(portArg);
const RUN = `${task}-${arm}-${seed}`;
const RESULTS = process.env.RESULTS ?? join(tmpdir(), "pocket-bots-group-modes");
const OUT = join(RESULTS, RUN);
const HOME = join(OUT, "home");
const WORK = join(OUT, "work");
const QUIET_MS = Number(process.env.QUIET_MS ?? 45_000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 25 * 60_000);

const TASKS = {
  code: {
    folder: "code",
    text: "This folder is a small JavaScript library, textkit, with four unfinished modules in src/ (slugify, duration, semver, wrap); each has its tests in test/. Implement them so that `npm test` passes, without changing the tests. Tell me when it's done and what the test run shows.",
  },
  audit: {
    folder: "audit",
    text: "The docs/ folder has 72 pages about our platform's services. Some pages contradict each other about a service's facts (its port, request timeout, retries, owning team, datastore, region, payload limit or cache TTL). Find every contradiction: for each one, name the service, the fact, the two conflicting values, and the files that state them.",
  },
  quick: {
    folder: "code",
    text: "How many test(...) cases are in test/semver.test.js? Reply with just the number.",
  },
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
cpSync(join(EXP, "tasks", TASKS[task].folder), WORK, { recursive: true });
const logPath = join(OUT, "driver.log");
const log = (...parts) => {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  console.log(`[${RUN}] ${line}`);
  writeFileSync(logPath, line + "\n", { flag: "a" });
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(name, input = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(`${name}: ${JSON.stringify(body.error ?? response.status)}`);
  return body.data;
}

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC|MCP_|OTEL_|CCD_)/.test(key) || key === "CLAUDECODE") continue;
    env[key] = value;
  }
  return { ...env, POCKET_BOTS_HOME: HOME, POCKET_BOTS_PORT: String(PORT) };
}

// Approvals: anything that stays in the run's folder runs; reaching elsewhere or the network doesn't.
function decide(request) {
  if (request.kind === "question") return { behavior: "deny", message: "No questions in this run: make a reasonable assumption and carry on." };
  const text = JSON.stringify(request.input ?? {});
  if (/\b(curl|wget|ssh|scp|sudo|git\s+push|npm\s+(install|i|publish)|pip\s+install)\b/.test(text) || /rm\s+-rf\s+\//.test(text)) return { behavior: "deny", message: "Not allowed in this run: stay in the working folder, without the network." };
  return { behavior: "allow" };
}

const now = new Date().toISOString();
const NAMES = ["Ada", "Ben", "Cy", "Dee"];
const BOTS = NAMES.map((name) => ({
  id: `bot-x-${name.toLowerCase()}`,
  name,
  title: "Engineer",
  description: "A software engineer.",
  avatar: { seed: name, palette: null, shape: "circle", imageUrl: null },
  provider: "dsh",
  model: MODEL,
  modeId: "workspace-write",
  thinkingOptionId: null,
  createdAt: now,
  updatedAt: now,
}));

log(`starting pocket-bots on ${PORT}, data in ${HOME}, work in ${WORK}`);
const server = spawn(join(REPO, "node_modules", ".bin", "tsx"), ["src/server/main.ts"], { cwd: join(REPO, "packages", "app"), env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (chunk) => writeFileSync(join(OUT, "server.log"), chunk, { flag: "a" }));
server.stderr.on("data", (chunk) => writeFileSync(join(OUT, "server.log"), chunk, { flag: "a" }));
let stopping = false;
const exited = new Promise((resolve) => server.on("exit", resolve));
server.on("exit", (code) => {
  if (!stopping) {
    log(`server exited (${code})`);
    process.exit(1);
  }
});
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.kill("SIGTERM");
  await Promise.race([exited, sleep(20_000)]);
};
process.on("SIGINT", () => void stop().then(() => process.exit(130)));

for (let i = 0; ; i++) {
  try {
    await rpc("pocket.status");
    break;
  } catch {
    if (i > 120) {
      log("server didn't come up");
      await stop();
      process.exit(1);
    }
    await sleep(500);
  }
}

const { values, revision } = await rpc("pocket.store.get");
const saved = await rpc("pocket.store.save", { values: { ...values, bots: [...values.bots.filter((bot) => !BOTS.some((mine) => mine.id === bot.id)), ...BOTS] }, revision });
if (saved.status !== "saved") {
  log(`couldn't save the bots: ${JSON.stringify(saved)}`);
  await stop();
  process.exit(1);
}

const { groupId } = await rpc("pocket.groups.create", {
  name: `${RUN}`,
  memberIds: BOTS.map((bot) => bot.id),
  cwd: WORK,
  ...(arm === "leader" ? { leaderId: BOTS[0].id } : {}),
  ...(arm === "board" ? { coordination: "board" } : {}),
});
const started = Date.now();
const request = await rpc("pocket.groups.send", { groupId, text: TASKS[task].text });
log(`group ${groupId} (${arm}); task sent as #${request.seq ?? "?"}`);

let quietSince = null;
let everBusy = false;
const answered = new Set();
let timedOut = false;
while (true) {
  const chats = (await Promise.all(BOTS.map((bot) => rpc("pocket.chats.list", { botId: bot.id, includeArchived: true }).then((result) => result.chats)))).flat();
  for (const chat of chats) {
    for (const pending of chat.pendingPermissions ?? []) {
      if (answered.has(pending.id)) continue;
      answered.add(pending.id);
      const response = decide(pending);
      log(`${response.behavior} ${pending.name} ${JSON.stringify(pending.input?.command ?? pending.input ?? "").slice(0, 160)}`);
      await rpc("pocket.chats.respond", { chatId: chat.id, requestId: pending.id, response }).catch((error) => log(`respond failed: ${error.message}`));
    }
  }
  const busy = chats.some((chat) => chat.activeTurn || chat.status === "running" || chat.status === "initializing" || (chat.pendingPermissions ?? []).length);
  everBusy ||= busy || chats.length > 0;
  if (busy || !everBusy) quietSince = null;
  else quietSince ??= Date.now();
  if (quietSince && Date.now() - quietSince > QUIET_MS) break;
  if (Date.now() - started > TIMEOUT_MS) {
    log("timed out");
    timedOut = true;
    break;
  }
  await sleep(1_500);
}
const ended = quietSince ?? Date.now();
await stop();

// ---------------------------------------------------------------- what happened

const db = new DatabaseSync(join(HOME, "pocket-bots.sqlite"), { readOnly: true });
const messages = db.prepare("SELECT seq, sender_kind, sender_id, text, reply_to, thread_seq, system_subtype, created_at FROM group_messages WHERE group_id = ? ORDER BY seq").all(groupId);
const seats = db.prepare("SELECT id, bot_id, resume, created_at, archived_at FROM chats WHERE labels LIKE ?").all(`%${groupId}%`);
const board = arm === "board" ? db.prepare("SELECT number, author_id, round_seq, sub_task, claim, refs FROM group_board WHERE group_id = ? ORDER BY number").all(groupId) : [];
const rounds = arm === "board" ? db.prepare("SELECT * FROM group_rounds WHERE group_id = ?").all(groupId) : [];
const roundMembers = arm === "board" ? db.prepare("SELECT * FROM group_round_members WHERE group_id = ?").all(groupId) : [];
const tasks = db.prepare("SELECT number, status, assignee_id FROM group_tasks WHERE group_id = ?").all(groupId);
db.close();

/** A DSH session's log: its model calls (steps), turns, token use and tool calls by name. */
function sessionUsage(sessionId) {
  const root = join(homedir(), ".dsh", "sessions");
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, sessionId, "session.v4.jsonl.zstd");
    if (!existsSync(file)) continue;
    const lines = execFileSync("zstd", ["-dc", file], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8").split("\n").filter(Boolean);
    const usage = { calls: 0, turns: 0, input: 0, output: 0, maxInput: 0, tools: {} };
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "turn/start") usage.turns++;
      if (entry.type === "assistant/message" && entry.data?.usage) {
        usage.calls++;
        usage.input += entry.data.usage.inputTokens ?? 0;
        usage.output += entry.data.usage.outputTokens ?? 0;
        usage.maxInput = Math.max(usage.maxInput, entry.data.usage.inputTokens ?? 0);
      }
      if (entry.type === "tool/call") {
        const name = String(entry.data?.name ?? "?").replace(/^mcp__bots__|^bots[_.]/, "");
        usage.tools[name] = (usage.tools[name] ?? 0) + 1;
      }
    }
    return usage;
  }
  return null;
}

const perBot = {};
for (const seat of seats) {
  const sessionId = seat.resume ? JSON.parse(seat.resume).sessionId : null;
  const usage = sessionId ? sessionUsage(sessionId) : null;
  const name = BOTS.find((bot) => bot.id === seat.bot_id)?.name ?? seat.bot_id;
  const total = (perBot[name] ??= { seats: 0, calls: 0, turns: 0, input: 0, output: 0, maxInput: 0, tools: {} });
  total.seats++;
  if (!usage) continue;
  total.calls += usage.calls;
  total.turns += usage.turns;
  total.input += usage.input;
  total.output += usage.output;
  total.maxInput = Math.max(total.maxInput, usage.maxInput);
  for (const [tool, n] of Object.entries(usage.tools)) total.tools[tool] = (total.tools[tool] ?? 0) + n;
}
const sum = (key) => Object.values(perBot).reduce((total, bot) => total + bot[key], 0);
const botMessages = messages.filter((message) => message.sender_kind === "bot");
const botText = botMessages.map((message) => message.text).join("\n\n");

// ---------------------------------------------------------------- scoring

let score = null;
if (task === "code") {
  let tap = "";
  try {
    tap = execFileSync("node", ["--test", "--test-reporter=tap"], { cwd: WORK, timeout: 120_000 }).toString();
  } catch (error) {
    tap = String(error.stdout ?? "");
  }
  const pass = Number(/^# pass (\d+)/m.exec(tap)?.[1] ?? 0);
  const total = Number(/^# tests (\d+)/m.exec(tap)?.[1] ?? 30);
  const testsChanged = execFileSync("sh", ["-c", `diff -r ${JSON.stringify(join(EXP, "tasks", "code", "test"))} ${JSON.stringify(join(WORK, "test"))} >/dev/null && echo same || echo changed`]).toString().trim();
  score = { pass, total, testsChanged: testsChanged === "changed" };
} else if (task === "audit") {
  const truth = JSON.parse(readFileSync(join(EXP, "audit-truth.json"), "utf8")).contradictions;
  const found = truth.filter((item) => botText.includes(item.altered_file.replace(/\.md$/, "")));
  score = { found: found.length, total: truth.length, missed: truth.filter((item) => !found.includes(item)).map((item) => `${item.service} ${item.attribute}`) };
} else {
  const truth = (readFileSync(join(EXP, "tasks", "code", "test", "semver.test.js"), "utf8").match(/^test\(/gm) ?? []).length;
  score = { truth, correct: botMessages.length > 0 && new RegExp(`\\b${truth}\\b`).test(botMessages[0].text), answers: botMessages.length };
}

// A run the provider broke (a seat's turn failed on a server error, a broken stream) isn't a result.
const providerErrors = messages.filter((message) => message.system_subtype === "seat.turn_failed" && /\b5\d\d\b|Failed to connect|事件源|stream|ECONN|socket/i.test(message.text)).map((message) => message.text.slice(0, 200));
const result = {
  run: RUN,
  task,
  arm,
  seed,
  model: MODEL,
  outcome: timedOut ? "timed_out" : providerErrors.length ? "provider_error" : "completed",
  providerErrors,
  wallSeconds: Math.round((ended - started) / 1000),
  firstBotMessageSeconds: botMessages.length ? Math.round((Date.parse(botMessages[0].created_at) - started) / 1000) : null,
  lastBotMessageSeconds: botMessages.length ? Math.round((Date.parse(botMessages.at(-1).created_at) - started) / 1000) : null,
  score,
  totals: { seats: sum("seats"), turns: sum("turns"), calls: sum("calls"), input: sum("input"), output: sum("output"), tokens: sum("input") + sum("output") },
  perBot,
  groupMessages: { total: messages.length, bot: botMessages.length, system: messages.filter((message) => message.sender_kind === "system").length, user: messages.filter((message) => message.sender_kind === "user").length },
  tasks,
  board: { entries: board.length, claims: board.filter((entry) => entry.claim).length, cited: board.filter((entry) => JSON.parse(entry.refs).some((ref) => ref.startsWith("B"))).length },
  rounds: rounds.map((round) => ({ ...round, members: roundMembers.filter((member) => member.seq === round.seq).map((member) => `${member.bot_id.replace("bot-x-", "")}:${member.state}/${member.finished_how ?? "-"}`) })),
  transcript: messages.map((message) => `#${message.seq} ${message.sender_kind === "bot" ? (BOTS.find((bot) => bot.id === message.sender_id)?.name ?? message.sender_id) : message.sender_kind}${message.reply_to ? ` ↩#${message.reply_to}` : ""}${message.thread_seq ? ` [t#${message.thread_seq}]` : ""}: ${message.text.slice(0, 300).replace(/\n/g, " ⏎ ")}`),
};
writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2));
log(`${result.outcome}: ${JSON.stringify(result.score)} · ${result.totals.tokens} tokens in ${result.totals.calls} calls, ${result.totals.turns} turns · ${result.wallSeconds}s`);
process.exit(0);
