import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const zvec = createRequire(import.meta.url)("@zvec/zvec");
import { rankBoard, type BoardEntry } from "../../packages/app/src/shared/group-board.ts";
const words = "parser cache auth export retry timeout port region datastore owner payload ttl module test fixture config docs service 登录 白屏 缓存 重试 配置 页面 加载 支付 搜索".split(" ");
const pick = (i: number, n: number) => Array.from({ length: n }, (_, k) => words[(i * 7 + k * 13) % words.length]).join(" ");
for (const size of [500, 5000]) {
  const entries: BoardEntry[] = Array.from({ length: size }, (_, i) => ({ number: i + 1, authorId: "a", round: null, subTask: `I've checked ${pick(i, 8)}`, artifact: pick(i + 3, 120), rationale: `B${Math.max(1, i)} gave ${pick(i + 5, 10)}`, refs: i ? [`B${Math.max(1, i - (i % 5))}`] : [], claim: null, createdAt: "" }));
  let started = performance.now();
  for (let k = 0; k < 5; k++) rankBoard(entries, "retry timeout 缓存");
  const ours = (performance.now() - started) / 5;
  const dir = mkdtempSync(join(tmpdir(), "zvec-scale-"));
  const col = zvec.ZVecCreateAndOpen(join(dir, "c"), new zvec.ZVecCollectionSchema({ name: "scale_test", fields: [{ name: "text", dataType: zvec.ZVecDataType.STRING, nullable: false, indexParams: { indexType: zvec.ZVecIndexType.FTS, tokenizerName: "jieba", filters: ["lowercase"] } }] }));
  started = performance.now();
  const docs = entries.map((e) => ({ id: `B${e.number}`, fields: { text: `${e.subTask} ${e.artifact} ${e.rationale}` } }));
  for (let i = 0; i < docs.length; i += 1000) col.insertSync(docs.slice(i, i + 1000));
  const insert = performance.now() - started;
  started = performance.now();
  for (let k = 0; k < 5; k++) col.querySync({ fieldName: "text", fts: { matchString: "retry timeout 缓存" }, topk: 8 });
  const theirs = (performance.now() - started) / 5;
  console.log(`${size} entries: ours ${ours.toFixed(1)} ms/search (full recompute incl. citation weights); zvec jieba ${theirs.toFixed(2)} ms/search, insert all ${insert.toFixed(0)} ms`);
  rmSync(dir, { recursive: true, force: true });
}
