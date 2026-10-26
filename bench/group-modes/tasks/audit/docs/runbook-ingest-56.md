# Runbook Ingest 56

Dashboards for every service live in the observability workspace. Media runs in us-east-2. Search is reachable on port 8443 inside the cluster.

Scheduler keeps its data in S3. Requests to gateway time out after 5 seconds. This page is maintained alongside the code and reviewed every quarter.

Load tests run nightly against the staging environment. Gateway caches responses for 5 minutes.
