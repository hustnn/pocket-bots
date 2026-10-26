# bench：共享看板的实验脚本

这里是 [docs/group-board.md](../docs/group-board.md) 里两组实验的脚本、任务和结果，跟着 `group-board-mode` 分支存档，不参与构建和测试。

## 目录里有什么

| 目录 | 内容 | 对应文档 |
|---|---|---|
| `group-modes/` | 自由、leader、共享看板三种方式在三个任务上的对比 | §4 |
| `board-tokenizer/` | 看板搜索的中文分词对比 | §5 |

## group-modes：三种协作方式的对比

**文件：**

- `run.mjs`：跑一次。起一个独立的 pocket-bots 后端（单独的数据目录和端口），建 4 个 DeepSeek Harness bot 和一个群，把任务发进群，替 bot 回答审批，等所有座位空闲后打分，再从 DSH 的会话日志里读出每个座位用的 token。
- `batch.mjs`：跑一批。每个任务、每个 seed，三种方式同时开跑；模型服务出错的那组整组重跑。
- `report.py`：把一批结果汇总成表（每种方式的均值和每次的数值）。
- `compare.py`：两批结果并排比较，默认是第二版对第三版。
- `tasks/code`：编码任务，一个 4 个模块都是空实现的小 JS 库，30 个测试。快问题也用这个目录。
- `tasks/audit`、`audit-truth.json`、`gen/audit.py`：审计任务，72 篇文档，埋了 10 处矛盾；`gen/audit.py` 是生成它的脚本，`audit-truth.json` 是标准答案。
- `results/v1`、`v2`、`v3`：三批运行的结果摘要，每次运行只保留 `result.json`（成本、得分、用时、看板条目和每一轮的记录）。

**怎么跑**（需要本机装好 DeepSeek Harness，模型默认是 `sophon/DeepSeek-V4.1-Flash-1017`，可以用 `MODEL` 改）：

```bash
node bench/group-modes/run.mjs code board 1 7121
node bench/group-modes/batch.mjs
python3 bench/group-modes/report.py results/v3
python3 bench/group-modes/compare.py results/v2 results/v3
```

每次运行写到 `$RESULTS/<任务>-<方式>-<seed>`，默认在系统临时目录的 `pocket-bots-group-modes` 下。放在仓库外是有意的：bot 的工作目录要是在仓库里，可能会读到仓库的 AGENTS.md，任务就不干净了。要保留的是其中的 `result.json`。

## board-tokenizer：中文分词对比

**文件：**

- `dataset.ts`：手写的测试集，75 条中文看板条目、60 个查询，每个查询标好相关条目。
- `eval.ts`：主对比，各种分词在我们的 BM25 和 zvec 的 BM25 上的 Recall@8、MRR、nDCG@8，以及按查询类型的分数。
- `eval-out.txt`、`eval-out-before-fix.txt`：`eval.ts` 在修复中英文分开之后和之前的输出。修复前的输出里「ours（整段+二元，现状）」就是当时的分词。
- `compare.ts`：在第一批实验的真实看板条目（`v1-board-entries.json`）上比较我们的排序和 zvec 的全文搜索。
- `glued.ts`、`modes.ts`、`scale.ts`：几个小检查，分别看中英文不加空格时我们和 jieba 怎么切、zvec 的 jieba 各种切分模式怎么切、看板有 500 条和 5,000 条时每次搜索要多久（和 zvec 比）。

**怎么跑：**

```bash
cd bench/board-tokenizer
npm install
node eval.ts
```
