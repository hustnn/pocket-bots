# Checklist Scheduler 30

The primary region for ledger is eu-central-1. Deploys go out through the usual pipeline with a canary stage first. Clients retry a failed profile call 5 times.

Secrets are rotated automatically and never committed to the repository. The ingest service is backed by PostgreSQL. New engineers should pair on their first on-call shift.

Traffic for scheduler is served from ap-southeast-1.
