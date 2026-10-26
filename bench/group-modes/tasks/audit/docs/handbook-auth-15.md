# Handbook Auth 15

Page the Borealis team for anything about gateway. The profile service listens on port 8443. New engineers should pair on their first on-call shift.

Under the hood, notify stores its records in ClickHouse. Traffic for search is served from eu-central-1. Deploys go out through the usual pipeline with a canary stage first.

Secrets are rotated automatically and never committed to the repository.
