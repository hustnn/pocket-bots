# One batch against another (default: results/v2 against results/v3): per task and mode, mean and
# median tokens, wall time, quality, and for the board who worked in each round.
#   python3 compare.py [before] [after]     (folders relative to this one)
import glob, json, os, statistics, sys

root = os.path.dirname(os.path.abspath(__file__))
before, after = (sys.argv[1:3] + ["results/v2", "results/v3"][len(sys.argv[1:3]):])

def load(folder):
    runs = {}
    for path in glob.glob(os.path.join(root, folder, "*", "result.json")):
        r = json.load(open(path))
        if r["seed"] in ("smoke",) or str(r["seed"]).startswith("probe"):
            continue
        runs.setdefault((r["task"], r["arm"]), []).append(r)
    return runs

def quality(r):
    s = r["score"]
    if r["task"] == "code":
        return s["pass"] / s["total"]
    if r["task"] == "audit":
        return s["found"] / s["total"]
    return 1.0 if s["correct"] else 0.0

v2, v3 = load(before), load(after)
print("| 任务 | 方式 | v2 token 均值 / 中位数 | v3 token 均值 / 中位数 | v2 用时 | v3 用时 | v3 正确率 | v3 每次 token |")
print("|---|---|---|---|---|---|---|---|")
for task in ["quick", "code", "audit"]:
    for arm in ["free", "leader", "board"]:
        a, b = v2.get((task, arm), []), v3.get((task, arm), [])
        if not b:
            continue
        tok = lambda rs: [r["totals"]["tokens"] / 1e6 for r in rs]
        wall = lambda rs: statistics.mean(r["wallSeconds"] for r in rs) if rs else float("nan")
        fmt = lambda xs: f"{statistics.mean(xs):.2f}M / {statistics.median(xs):.2f}M" if xs else "—"
        bad = [r["outcome"] for r in b if r["outcome"] != "completed"]
        print(f"| {task} | {arm} | {fmt(tok(a))} | {fmt(tok(b))} | {wall(a):.0f}s | {wall(b):.0f}s | {statistics.mean(quality(r) for r in b):.0%}{' ' + ','.join(bad) if bad else ''} | {' / '.join(f'{x:.2f}' for x in tok(sorted(b, key=lambda r: r['seed'])))} |")

print("\nBoard rounds in v3 (who worked, how each finished), entries and claims:")
for task in ["quick", "code", "audit"]:
    for r in sorted(v3.get((task, "board"), []), key=lambda r: r["seed"]):
        rd = r["rounds"][0] if r["rounds"] else {}
        per = {k: f"{(v['input'] + v['output']) / 1e3:.0f}K" for k, v in r["perBot"].items()}
        print(f"  {r['run']}: fanned_out={rd.get('fanned_out')} members={rd.get('members')} board={r['board']} perBot={per}")
