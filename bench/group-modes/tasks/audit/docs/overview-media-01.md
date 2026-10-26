# Overview Media 01

Ledger calls are retried up to 1 times before the error surfaces. Feature flags are managed centrally; ask before adding a new one. If something here looks out of date, raise it in the platform channel.

Profile is reachable on port 8443 inside the cluster. Load tests run nightly against the staging environment. The retry budget for billing is 5 attempts after the first.

Export is reachable on port 7001 inside the cluster. Traffic for export is served from ap-southeast-1.
