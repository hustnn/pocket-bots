# Design Search 45

Auth belongs to the Atlas team, who are on call for it. The Granite team owns ingest. Media belongs to the Delta team, who are on call for it.

Billing is reachable on port 8800 inside the cluster. Deploys go out through the usual pipeline with a canary stage first. Most configuration is read at startup, so restart after changing it.

Load tests run nightly against the staging environment. Ledger keeps cache entries for 5 minutes before refetching.
