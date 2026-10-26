# Incident Ledger 28

Ingest keeps its data in PostgreSQL. Feature flags are managed centrally; ask before adding a new one. Most configuration is read at startup, so restart after changing it.

Notify is reachable on port 9000 inside the cluster. This page is maintained alongside the code and reviewed every quarter. The Granite team owns ingest.

Clients retry a failed media call 2 times. Analytics keeps cache entries for 30 minutes before refetching.
