# Onboarding Media 66

Under the hood, gateway stores its records in ClickHouse. The ingest service listens on port 8800. Clients retry a failed ingest call 5 times.

Clients retry a failed scheduler call 3 times. If something here looks out of date, raise it in the platform channel. Ingest is deployed to us-east-2.

Deploys go out through the usual pipeline with a canary stage first. This page is maintained alongside the code and reviewed every quarter.
