// Board search: our BM25 (shared/group-board.ts) against zvec FTS with the jieba, standard and
// ngram tokenizers, on real board entries from the first experiment batch (v1-board-entries.json,
// exported from the code-board-1 and audit-board-1 runs) plus Chinese entries.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const zvec = require("@zvec/zvec");
import { rankBoard, type BoardEntry } from "../../packages/app/src/shared/group-board.ts";

const entries: BoardEntry[] = [];
for (const row of JSON.parse(readFileSync(new URL("./v1-board-entries.json", import.meta.url), "utf8"))) {
  entries.push({ number: entries.length + 1, authorId: row.author_id, round: null, subTask: row.sub_task, artifact: row.artifact, rationale: row.rationale, refs: [], claim: row.claim, createdAt: row.created_at });
}
const zh = [
  ["我已排查登录页白屏的原因", "CSP 头拦截了 bundle.js，去掉 script-src 'self' 之外的限制后不再白屏；本地复现并验证。", "复现了问题"],
  ["我已检查支付服务的重试次数配置", "payment 服务的重试次数在 config/limits.md 写的是 3，在 services/api.md 写的是 5，两处矛盾。", "对照两份文档"],
  ["我已认领缓存模块的单元测试", "负责 src/cache.ts 的测试：缓存过期时间、并发写入。", "按计划认领"],
  ["我已确认搜索服务的缓存过期时间为 5 分钟", "search 服务的缓存 TTL 是 5 分钟，faq-export-43.md 写成 30 分钟是错的。", "读了三份文档"],
  ["我已整理前端页面加载慢的线索", "首页白屏时间长，主要是字体文件 2MB；建议懒加载。", "抓了性能面板"],
];
for (const [subTask, artifact, rationale] of zh) entries.push({ number: entries.length + 1, authorId: "x", round: null, subTask, artifact, rationale, refs: [], claim: null, createdAt: "" });

function collection(tokenizer: string, extra = "") {
  const dir = mkdtempSync(join(tmpdir(), "zvec-board-"));
  const schema = new zvec.ZVecCollectionSchema({
    name: `board_${tokenizer}`,
    fields: [
      { name: "number", dataType: zvec.ZVecDataType.INT32, nullable: false },
      { name: "text", dataType: zvec.ZVecDataType.STRING, nullable: false, indexParams: { indexType: zvec.ZVecIndexType.FTS, tokenizerName: tokenizer, filters: ["lowercase"], ...(extra ? { extraParams: extra } : {}) } },
    ],
  });
  const col = zvec.ZVecCreateAndOpen(join(dir, "c"), schema);
  const started = performance.now();
  col.insertSync(entries.map((entry) => ({ id: `B${entry.number}`, fields: { number: entry.number, text: `${entry.subTask} ${entry.artifact} ${entry.rationale}` } })));
  return { col, dir, insertMs: performance.now() - started };
}

const cols = { jieba: collection("jieba"), standard: collection("standard"), ngram2: collection("ngram", JSON.stringify({ ngram_min: 2, ngram_max: 2 })) };
const queries = ["duration module", "src/wrap.js", "parseDuration formatDuration", "retry limits contradiction", "scheduler retries", "白屏", "登录页", "重试次数", "缓存过期时间", "缓存 TTL", "页面加载"];
const top = (ids: string[]) => ids.slice(0, 5).join(" ") || "—";
console.log(`${entries.length} entries; insert ms: ${Object.entries(cols).map(([k, v]) => `${k} ${v.insertMs.toFixed(1)}`).join(", ")}\n`);
for (const query of queries) {
  const ours = rankBoard(entries, query).map((entry) => `B${entry.number}`);
  const row = [`ours     ${top(ours)} (${ours.length})`];
  for (const [name, { col }] of Object.entries(cols)) {
    const started = performance.now();
    let hits: any[] = [];
    try {
      hits = col.querySync({ fieldName: "text", fts: { matchString: query }, topk: 8 });
    } catch (error) {
      row.push(`${name.padEnd(8)} ERROR ${String(error).slice(0, 80)}`);
      continue;
    }
    row.push(`${name.padEnd(8)} ${top(hits.map((hit) => hit.id))} (${hits.length}) scores ${hits.slice(0, 3).map((hit) => hit.score.toFixed(2)).join("/")} ${(performance.now() - started).toFixed(2)}ms`);
  }
  console.log(`"${query}"\n  ${row.join("\n  ")}\n`);
}
const show = (n: number) => console.log(`B${n}: ${entries[n - 1]!.subTask.slice(0, 90)}`);
for (const n of [entries.length - 4, entries.length - 3, entries.length - 2, entries.length - 1, entries.length]) show(n);
for (const { col, dir } of Object.values(cols)) {
  col.closeSync?.();
  rmSync(dir, { recursive: true, force: true });
}
