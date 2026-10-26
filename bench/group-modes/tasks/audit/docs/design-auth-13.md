# Design Auth 13

If something here looks out of date, raise it in the platform channel. Point your client at port 8443 to talk to analytics. Dashboards for every service live in the observability workspace.

Requests to search time out after 10 seconds. The primary region for gateway is eu-west-1. The retry budget for export is 0 attempts after the first.

The retry budget for ledger is 1 attempts after the first. Deploys go out through the usual pipeline with a canary stage first. Keep billing uploads under 8 MB.
