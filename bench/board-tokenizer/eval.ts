// Chinese board search: tokenizers × scorers on the labeled set in dataset.ts.
// - Our scorer (the BM25 in shared/group-board.ts, reimplemented here over any tokenizer, and
//   checked against rankBoard for our own tokens) with: our tokens, bigrams only, unigrams+bigrams,
//   jieba cut, jieba cut-for-search.
// - zvec's FTS (BM25 in C++) with its jieba (mix, search), ngram 2 and standard tokenizers, and with
//   our tokens or jieba tokens pre-split and indexed by its whitespace tokenizer (same tokens,
//   other scorer).
// Metrics at k = 8 (what board_search returns): recall, MRR, nDCG, and queries with no relevant hit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { boardTokens, rankBoard, type BoardEntry } from "../../packages/app/src/shared/group-board.ts";
import { ENTRIES, QUERIES, type QueryType } from "./dataset.ts";

const require = createRequire(import.meta.url);
const zvec = require("@zvec/zvec");
const { Jieba } = require("@node-rs/jieba");
const { dict } = require("@node-rs/jieba/dict");
const jieba = Jieba.withDict(dict);
const K = 8;
const ids = Object.keys(ENTRIES);

// ---------------------------------------------------------------- tokenizers (JS)

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const norm = (text: string) => text.normalize("NFKC").toLowerCase();
const words = (text: string) => norm(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Our tokens without the whole CJK run: only its pairs (a lone character stays). */
function bigramOnly(text: string): string[] {
  const out: string[] = [];
  for (const word of words(text)) {
    const parts = word.split(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/u).filter(Boolean);
    for (const part of parts) {
      if (!CJK.test(part)) out.push(part);
      else {
        const chars = [...part];
        if (chars.length === 1) out.push(part);
        for (let i = 1; i < chars.length; i++) out.push(chars[i - 1]! + chars[i]!);
      }
    }
  }
  return out;
}
function uniBi(text: string): string[] {
  const out = bigramOnly(text);
  for (const word of words(text)) for (const char of word) if (CJK.test(char)) out.push(char);
  return out;
}
const keep = (token: string) => /[\p{L}\p{N}]/u.test(token);
const jiebaCut = (text: string) => (jieba.cut(norm(text), true) as string[]).map((t) => t.trim()).filter(keep);
const jiebaSearch = (text: string) => (jieba.cutForSearch(norm(text), true) as string[]).map((t) => t.trim()).filter(keep);

// ---------------------------------------------------------------- our scorer over any tokenizer

/** shared/group-board.ts boardRelevance, with the tokenizer passed in. */
function bm25(tokenize: (text: string) => string[], query: string): string[] {
  const terms = [...new Set(tokenize(query))];
  const docs = ids.map((id) => ({ id, tokens: tokenize(ENTRIES[id]!) }));
  const average = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / docs.length || 1;
  const idf = new Map(terms.map((term) => {
    const df = docs.filter((doc) => doc.tokens.includes(term)).length;
    return [term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
  }));
  const scored: { id: string; score: number }[] = [];
  for (const doc of docs) {
    let score = 0;
    for (const term of terms) {
      const tf = doc.tokens.filter((token) => token === term).length;
      if (tf) score += (idf.get(term)! * tf * 2.5) / (tf + 1.5 * (0.25 + (0.75 * doc.tokens.length) / average));
    }
    if (score > 0) scored.push({ id: doc.id, score });
  }
  return scored.sort((a, b) => b.score - a.score || ids.indexOf(a.id) - ids.indexOf(b.id)).map((hit) => hit.id);
}

// Our scorer with our tokens must be the board's own ranking.
const boardEntries: BoardEntry[] = ids.map((id, index) => ({ number: index + 1, authorId: "a", round: null, subTask: ENTRIES[id]!, artifact: "", rationale: "", refs: [], claim: null, createdAt: "" }));
for (const { query } of QUERIES) {
  const theirs = rankBoard(boardEntries, query).map((entry) => ids[entry.number - 1]);
  const mine = bm25(boardTokens, query);
  // rankBoard indexes "subTask artifact rationale" (two extra spaces): same tokens, same order.
  if (theirs.join() !== mine.join()) throw new Error(`reimplementation differs on "${query}"`);
}

// ---------------------------------------------------------------- zvec

const dirs: string[] = [];
function zvecSystem(name: string, tokenizer: string, extra?: object, pre?: (text: string) => string[]) {
  const dir = mkdtempSync(join(tmpdir(), "zvec-zh-"));
  dirs.push(dir);
  const schema = new zvec.ZVecCollectionSchema({
    name: `zh_${name.replace(/[^a-z0-9]/gi, "_")}`,
    fields: [{ name: "text", dataType: zvec.ZVecDataType.STRING, nullable: false, indexParams: { indexType: zvec.ZVecIndexType.FTS, tokenizerName: tokenizer, filters: ["lowercase"], ...(extra ? { extraParams: JSON.stringify(extra) } : {}) } }],
  });
  const col = zvec.ZVecCreateAndOpen(join(dir, "c"), schema);
  const text = (raw: string) => (pre ? pre(raw).join(" ") : raw);
  col.insertSync(ids.map((id) => ({ id, fields: { text: text(ENTRIES[id]!) } })));
  return (query: string): string[] => {
    const q = text(query);
    if (!q.trim()) return [];
    return col.querySync({ fieldName: "text", fts: { matchString: q }, topk: K }).map((doc: any) => doc.id);
  };
}

const SYSTEMS: { name: string; group: string; search: (query: string) => string[] }[] = [
  { name: "ours（boardTokens）", group: "我们的 BM25", search: (q) => bm25(boardTokens, q) },
  { name: "仅二元，中英分开（修复后）", group: "我们的 BM25", search: (q) => bm25(bigramOnly, q) },
  { name: "一元+二元", group: "我们的 BM25", search: (q) => bm25(uniBi, q) },
  { name: "jieba 精确模式", group: "我们的 BM25", search: (q) => bm25(jiebaCut, q) },
  { name: "二元 + jieba 精确（并集）", group: "我们的 BM25", search: (q) => bm25((t) => [...bigramOnly(t), ...jiebaCut(t).filter((w) => CJK.test(w))], q) },
  { name: "jieba 搜索模式", group: "我们的 BM25", search: (q) => bm25(jiebaSearch, q) },
  { name: "jieba mix（zg 的配置）", group: "zvec BM25", search: zvecSystem("jieba_mix", "jieba") },
  { name: "jieba search", group: "zvec BM25", search: zvecSystem("jieba_search", "jieba", { cut_mode: "search" }) },
  { name: "ngram 2", group: "zvec BM25", search: zvecSystem("ngram2", "ngram", { ngram_min: 2, ngram_max: 2 }) },
  { name: "standard（单字）", group: "zvec BM25", search: zvecSystem("standard", "standard") },
  { name: "ours 的词，zvec 打分", group: "zvec BM25", search: zvecSystem("ws_ours", "whitespace", undefined, boardTokens) },
  { name: "jieba 搜索模式的词，zvec 打分", group: "zvec BM25", search: zvecSystem("ws_jieba", "whitespace", undefined, jiebaSearch) },
];

// ---------------------------------------------------------------- metrics

function metrics(ranked: string[], relevant: string[]) {
  const top = ranked.slice(0, K);
  const hits = top.filter((id) => relevant.includes(id)).length;
  const first = top.findIndex((id) => relevant.includes(id));
  const dcg = top.reduce((sum, id, i) => sum + (relevant.includes(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = relevant.slice(0, K).reduce((sum, _, i) => sum + 1 / Math.log2(i + 2), 0);
  return { recall: hits / relevant.length, mrr: first < 0 ? 0 : 1 / (first + 1), ndcg: dcg / ideal, miss: hits === 0 ? 1 : 0, wrongFirst: top.length && !relevant.includes(top[0]!) ? 1 : 0 };
}
const TYPES: QueryType[] = ["精确词", "新词/领域词", "粒度不一致", "歧义/跨词误配", "中英混合", "中英无空格", "自然语言问句", "近义改写"];
const pct = (x: number) => `${(x * 100).toFixed(0)}`;

const rows = SYSTEMS.map((system) => {
  const per = QUERIES.map((q) => ({ q, ranked: system.search(q.query), ...metrics(system.search(q.query), q.relevant) }));
  const mean = (list: typeof per, key: "recall" | "mrr" | "ndcg") => list.reduce((sum, row) => sum + row[key], 0) / list.length;
  return { system, per, mean };
});

console.log(`${ids.length} entries, ${QUERIES.length} queries, k = ${K}\n`);
console.log("| 打分 | 分词 | Recall@8 | MRR | nDCG@8 | 一条都没找到 | 第一名不相关 |");
console.log("|---|---|---|---|---|---|---|");
for (const { system, per, mean } of rows) {
  console.log(`| ${system.group} | ${system.name} | ${pct(mean(per, "recall"))}% | ${mean(per, "mrr").toFixed(2)} | ${mean(per, "ndcg").toFixed(2)} | ${per.reduce((s, r) => s + r.miss, 0)} | ${per.reduce((s, r) => s + r.wrongFirst, 0)} |`);
}
console.log(`\nnDCG@8 by query type (queries per type: ${TYPES.map((t) => `${t} ${QUERIES.filter((q) => q.type === t).length}`).join("、")})\n`);
console.log(`| 分词 | ${TYPES.join(" | ")} |`);
console.log(`|---|${TYPES.map(() => "---").join("|")}|`);
for (const { system, per, mean } of rows) {
  console.log(`| ${system.group === "zvec BM25" ? "zvec · " : ""}${system.name} | ${TYPES.map((t) => mean(per.filter((r) => r.q.type === t), "ndcg").toFixed(2)).join(" | ")} |`);
}

// Where they differ: each query's top 3 for a few systems, relevant ones marked with *.
const SHOW = ["ours（boardTokens）", "二元 + jieba 精确（并集）", "jieba 精确模式", "jieba 搜索模式", "jieba mix（zg 的配置）", "jieba search", "standard（单字）"];
console.log("\nTop 3 per query (* = relevant):\n");
for (const [index, q] of QUERIES.entries()) {
  const lines = rows.filter((row) => SHOW.includes(row.system.name)).map((row) => {
    const r = row.per[index]!;
    return `${(row.system.group === "zvec BM25" ? "zvec·" : "") + row.system.name}: ${r.ranked.slice(0, 3).map((id) => (q.relevant.includes(id) ? `${id}*` : id)).join(" ") || "—"} (ndcg ${r.ndcg.toFixed(2)})`;
  });
  const spread = new Set(lines.map((line) => line.split(": ")[1])).size > 1;
  if (spread) console.log(`[${q.type}] "${q.query}" → ${q.relevant.join(",")}\n   ${lines.join("\n   ")}`);
}
console.log("\nHow each tokenizer splits a few queries:");
for (const q of ["数据库存储", "单价", "登录页面", "长江", "白屏", "缓存击穿", "为什么登录页会白屏？", "src/wrap.js", "监测数据入库延迟", "验证码短信", "会员价为原价"]) {
  console.log(`  ${q}: ours [${boardTokens(q).join(" ")}] · jieba [${jiebaCut(q).join(" ")}] · jieba搜索 [${jiebaSearch(q).join(" ")}]`);
}
for (const text of [ENTRIES.E11!, ENTRIES.E25!, ENTRIES.E49!]) console.log(`  「${text.slice(0, 16)}…」 jieba [${jiebaCut(text).slice(0, 10).join(" ")}]`);
for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
