# Runbook Gateway 64

Deploys go out through the usual pipeline with a canary stage first. Scheduler's HTTP port is 4040. Ledger is deployed to eu-central-1.

Secrets are rotated automatically and never committed to the repository. Gateway is reachable on port 5050 inside the cluster. Clients retry a failed scheduler call 5 times.

The largest request body profile accepts is 2 MB. Export belongs to the Fjord team, who are on call for it. This page is maintained alongside the code and reviewed every quarter.
