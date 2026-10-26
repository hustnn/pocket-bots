# Runbook Notify 32

Ledger writes everything to ClickHouse. Secrets are rotated automatically and never committed to the repository. Search keeps its data in PostgreSQL.

Load tests run nightly against the staging environment. The profile cache TTL is 15 minutes. Keep export uploads under 16 MB.

Deploys go out through the usual pipeline with a canary stage first. Point your client at port 7001 to talk to media.
