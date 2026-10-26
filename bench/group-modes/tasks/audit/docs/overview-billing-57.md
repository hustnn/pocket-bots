# Overview Billing 57

The ingest cache TTL is 30 minutes. Dashboards for every service live in the observability workspace. The largest request body profile accepts is 2 MB.

The largest request body auth accepts is 1 MB. Expect scheduler to cut a call off at 45 seconds. Feature flags are managed centrally; ask before adding a new one.

Scheduler belongs to the Granite team, who are on call for it. Secrets are rotated automatically and never committed to the repository.
