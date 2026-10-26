# Incident Media 44

Secrets are rotated automatically and never committed to the repository. The retry budget for auth is 3 attempts after the first. Deploys go out through the usual pipeline with a canary stage first.

Profile caches responses for 15 minutes. The ledger request timeout is 60 seconds. The search service is backed by PostgreSQL.

Ingest caches responses for 5 minutes. Load tests run nightly against the staging environment. Notify is maintained by team Cobalt.
