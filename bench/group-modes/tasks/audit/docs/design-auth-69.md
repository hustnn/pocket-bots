# Design Auth 69

Expect ingest to cut a call off at 5 seconds. Export calls are retried up to 0 times before the error surfaces. Feature flags are managed centrally; ask before adding a new one.

Ledger rejects payloads over 32 MB. Most configuration is read at startup, so restart after changing it. Dashboards for every service live in the observability workspace.
