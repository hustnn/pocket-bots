# Aggregates <folder>/*/result.json into per-(task, arm) tables: mean and per-seed values.
#   python3 report.py results/v3     (a kept batch; relative to this folder)
#   python3 report.py                (the runs in $RESULTS, where run.mjs writes)
import glob, json, os, statistics, sys, tempfile

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, sys.argv[1]) if len(sys.argv) > 1 else os.environ.get("RESULTS", os.path.join(tempfile.gettempdir(), "pocket-bots-group-modes"))
runs = []
for path in sorted(glob.glob(os.path.join(root, "*", "result.json"))):
    r = json.load(open(path))
    if r["seed"] == "smoke":
        continue
    runs.append(r)

def score(r):
    s = r["score"]
    if r["task"] == "code":
        return f'{s["pass"]}/{s["total"]}' + (" (tests changed)" if s.get("testsChanged") else "")
    if r["task"] == "audit":
        return f'{s["found"]}/{s["total"]}'
    return ("ok" if s["correct"] else "wrong") + f' ({s["answers"]} msg)'

def num(r):
    s = r["score"]
    if r["task"] == "code":
        return s["pass"] / s["total"]
    if r["task"] == "audit":
        return s["found"] / s["total"]
    return 1.0 if s["correct"] else 0.0

ARMS = ["free", "leader", "board"]
for task in ["quick", "code", "audit"]:
    rows = [r for r in runs if r["task"] == task]
    if not rows:
        continue
    print(f"\n### {task}\n")
    print("| arm | seeds | quality (mean) | tokens (mean) | model calls | turns | seats | bot msgs | wall s | per seed: quality · tokens · wall |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for arm in ARMS:
        rs = sorted([r for r in rows if r["arm"] == arm], key=lambda r: r["seed"])
        if not rs:
            continue
        m = lambda f: statistics.mean(f(r) for r in rs)
        per = "; ".join(f'{score(r)} · {r["totals"]["tokens"]/1000:.0f}K · {r["wallSeconds"]}s{"" if r["outcome"] == "completed" else " " + r["outcome"].upper()}' for r in rs)
        print(f'| {arm} | {len(rs)} | {m(num):.0%} | {m(lambda r: r["totals"]["tokens"])/1000:.0f}K | {m(lambda r: r["totals"]["calls"]):.0f} | {m(lambda r: r["totals"]["turns"]):.1f} | {m(lambda r: r["totals"]["seats"]):.1f} | {m(lambda r: r["groupMessages"]["bot"]):.1f} | {m(lambda r: r["wallSeconds"]):.0f} | {per} |')
