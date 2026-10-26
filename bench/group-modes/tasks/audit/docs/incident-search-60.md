# Incident Search 60

This page is maintained alongside the code and reviewed every quarter. Gateway belongs to the Borealis team, who are on call for it. Notify gives up on a request after 15 seconds.

The auth service listens on port 5050. Expect ledger to cut a call off at 60 seconds. Expect export to cut a call off at 5 seconds.

Dashboards for every service live in the observability workspace. The largest request body ingest accepts is 1 MB. If something here looks out of date, raise it in the platform channel.
