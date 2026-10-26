import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const zvec = createRequire(import.meta.url)("@zvec/zvec");
const docs = ["我已排查登录页白屏的原因", "研究生命起源", "灰度发布的熔断策略", "南京市长江大桥"];
for (const mode of ["mp", "hmm", "mix", "full", "query", "search", "cut_for_search", "default"]) {
  try {
    const col = zvec.ZVecCreateAndOpen(join(mkdtempSync(join(tmpdir(), "zvec-mode-")), "c"), new zvec.ZVecCollectionSchema({ name: "mode_probe", fields: [{ name: "text", dataType: zvec.ZVecDataType.STRING, nullable: false, indexParams: { indexType: zvec.ZVecIndexType.FTS, tokenizerName: "jieba", filters: ["lowercase"], extraParams: JSON.stringify({ cut_mode: mode }) } }] }));
    col.insertSync(docs.map((text, i) => ({ id: `d${i}`, fields: { text } })));
    const probe = (q: string) => col.querySync({ fieldName: "text", fts: { matchString: q }, topk: 5 }).map((d: any) => d.id).join(",") || "-";
    console.log(mode.padEnd(15), "白屏:", probe("白屏"), " 登录:", probe("登录"), " 生命:", probe("生命"), " 长江:", probe("长江"), " 发布:", probe("发布"), " 大桥:", probe("大桥"));
  } catch (error) {
    console.log(mode.padEnd(15), "ERROR", String(error).slice(0, 100));
  }
}
const { Jieba } = createRequire(import.meta.url)("@node-rs/jieba");
const { dict } = createRequire(import.meta.url)("@node-rs/jieba/dict");
const jieba = Jieba.withDict(dict);
for (const text of docs) console.log("node-rs cut:", jieba.cut(text, false).join("/"), "| search:", jieba.cutForSearch(text, true).join("/"));
