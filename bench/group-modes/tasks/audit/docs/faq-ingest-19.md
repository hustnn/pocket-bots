# Faq Ingest 19

Incident reviews are blameless and published within a week. Under the hood, search stores its records in PostgreSQL. Feature flags are managed centrally; ask before adding a new one.

A failing call to gateway is tried again 5 times. Ledger gives up on a request after 60 seconds. Ledger is reachable on port 3030 inside the cluster.

The gateway service listens on port 5050. Billing gives up on a request after 5 seconds. The scheduler cache TTL is 30 minutes.

Load tests run nightly against the staging environment.
