# Builds a synthetic "contradiction audit" corpus: docs of a fictional platform where each fact is
# stated in several files in varied prose, and a few facts are contradicted in exactly one file.
import json, os, random, sys
out, truth_path, seed = sys.argv[1], sys.argv[2], int(sys.argv[3])
rnd = random.Random(seed)
services = ["auth", "billing", "search", "ingest", "notify", "ledger", "gateway", "scheduler", "media", "analytics", "profile", "export"]
teams = ["Atlas", "Borealis", "Cobalt", "Delta", "Ember", "Fjord", "Granite", "Helix"]
stores = ["PostgreSQL", "Cassandra", "Redis", "DynamoDB", "ClickHouse", "MySQL", "S3"]
regions = ["eu-west-1", "us-east-2", "ap-southeast-1", "us-west-2", "eu-central-1"]
facts = {}
for s in services:
    facts[(s, "port")] = rnd.choice([8080, 8443, 9000, 9090, 7001, 5050, 6060, 4040, 3030, 8800])
    facts[(s, "timeout")] = rnd.choice([5, 10, 15, 20, 30, 45, 60])
    facts[(s, "retries")] = rnd.choice([0, 1, 2, 3, 5])
    facts[(s, "team")] = rnd.choice(teams)
    facts[(s, "store")] = rnd.choice(stores)
    facts[(s, "region")] = rnd.choice(regions)
    facts[(s, "payload")] = rnd.choice([1, 2, 4, 8, 16, 32])
    facts[(s, "ttl")] = rnd.choice([1, 5, 10, 15, 30, 60])
T = {
    "port": ["The {s} service listens on port {v}.", "{S} is reachable on port {v} inside the cluster.", "Point your client at port {v} to talk to {s}.", "{S}'s HTTP port is {v}."],
    "timeout": ["Requests to {s} time out after {v} seconds.", "{S} gives up on a request after {v} seconds.", "The {s} request timeout is {v} seconds.", "Expect {s} to cut a call off at {v} seconds."],
    "retries": ["Clients retry a failed {s} call {v} times.", "{S} calls are retried up to {v} times before the error surfaces.", "The retry budget for {s} is {v} attempts after the first.", "A failing call to {s} is tried again {v} times."],
    "team": ["The {v} team owns {s}.", "{S} belongs to the {v} team, who are on call for it.", "Page the {v} team for anything about {s}.", "{S} is maintained by team {v}."],
    "store": ["{S} keeps its data in {v}.", "The {s} service is backed by {v}.", "{S} writes everything to {v}.", "Under the hood, {s} stores its records in {v}."],
    "region": ["{S} runs in {v}.", "The primary region for {s} is {v}.", "{S} is deployed to {v}.", "Traffic for {s} is served from {v}."],
    "payload": ["{S} rejects payloads over {v} MB.", "The largest request body {s} accepts is {v} MB.", "Keep {s} uploads under {v} MB.", "{S} caps a request at {v} MB."],
    "ttl": ["{S} caches responses for {v} minutes.", "Cached {s} results live {v} minutes.", "The {s} cache TTL is {v} minutes.", "{S} keeps cache entries for {v} minutes before refetching."],
}
filler = [
    "This page is maintained alongside the code and reviewed every quarter.",
    "If something here looks out of date, raise it in the platform channel.",
    "Dashboards for every service live in the observability workspace.",
    "Deploys go out through the usual pipeline with a canary stage first.",
    "Feature flags are managed centrally; ask before adding a new one.",
    "Incident reviews are blameless and published within a week.",
    "Secrets are rotated automatically and never committed to the repository.",
    "Load tests run nightly against the staging environment.",
    "New engineers should pair on their first on-call shift.",
    "Most configuration is read at startup, so restart after changing it.",
]
kinds = ["runbook", "overview", "onboarding", "faq", "incident", "design", "checklist", "handbook"]
N = 72
docs = []
keys = list(facts)
# Every fact appears in 2-4 docs.
mentions = {k: [] for k in keys}
assign = {i: [] for i in range(N)}
for k in keys:
    for i in rnd.sample(range(N), rnd.choice([2, 3, 3, 4])):
        assign[i].append(k)
        mentions[k].append(i)
def alt(attr, v):
    pools = {"port": [8080, 8443, 9000, 9090, 7001, 5050, 6060, 4040, 3030, 8800], "timeout": [5, 10, 15, 20, 30, 45, 60], "retries": [0, 1, 2, 3, 5], "team": teams, "store": stores, "region": regions, "payload": [1, 2, 4, 8, 16, 32], "ttl": [1, 5, 10, 15, 30, 60]}
    return rnd.choice([x for x in pools[attr] if x != v])
contradicted = rnd.sample([k for k in keys if len(mentions[k]) >= 2], 10)
altered = {}
for k in contradicted:
    i = rnd.choice(mentions[k])
    altered[(k, i)] = alt(k[1], facts[k])
names = []
for i in range(N):
    kind = kinds[i % len(kinds)]
    main = rnd.choice(services)
    name = f"{kind}-{main}-{i:02d}.md"
    names.append(name)
truth = []
for i in range(N):
    lines = [f"# {names[i][:-3].replace('-', ' ').title()}", ""]
    sentences = rnd.sample(filler, 3)
    for k in assign[i]:
        v = altered.get((k, i), facts[k])
        s, attr = k
        sentences.append(rnd.choice(T[attr]).format(s=s, S=s.capitalize(), v=v))
    rnd.shuffle(sentences)
    paras = [" ".join(sentences[j:j + 3]) for j in range(0, len(sentences), 3)]
    lines += [p + "\n" for p in paras]
    with open(os.path.join(out, names[i]), "w") as f:
        f.write("\n".join(lines))
for (k, i), v in altered.items():
    others = [names[j] for j in mentions[k] if j != i]
    truth.append({"service": k[0], "attribute": k[1], "true": facts[k], "altered": v, "altered_file": names[i], "other_files": others})
json.dump({"contradictions": truth, "files": N}, open(truth_path, "w"), indent=1)
print(len(truth), "contradictions in", N, "files")
