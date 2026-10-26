# Overview Export 33

New engineers should pair on their first on-call shift. The analytics service listens on port 8443. The retry budget for scheduler is 5 attempts after the first.

The search cache TTL is 5 minutes. Dashboards for every service live in the observability workspace. Keep analytics uploads under 4 MB.

Ingest calls are retried up to 5 times before the error surfaces. Deploys go out through the usual pipeline with a canary stage first. Billing belongs to the Delta team, who are on call for it.

Profile belongs to the Granite team, who are on call for it. A failing call to analytics is tried again 2 times.
