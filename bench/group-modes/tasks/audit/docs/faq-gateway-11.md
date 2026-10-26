# Faq Gateway 11

Load tests run nightly against the staging environment. Secrets are rotated automatically and never committed to the repository. Keep notify uploads under 16 MB.

Dashboards for every service live in the observability workspace. Media writes everything to S3. Analytics writes everything to Redis.

Analytics caps a request at 4 MB. The retry budget for ingest is 5 attempts after the first. Point your client at port 5050 to talk to auth.
