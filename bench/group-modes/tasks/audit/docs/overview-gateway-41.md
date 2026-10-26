# Overview Gateway 41

The primary region for ledger is eu-central-1. Secrets are rotated automatically and never committed to the repository. This page is maintained alongside the code and reviewed every quarter.

Under the hood, gateway stores its records in ClickHouse. Deploys go out through the usual pipeline with a canary stage first.
