# Onboarding Profile 02

Point your client at port 8800 to talk to ingest. Media writes everything to S3. The retry budget for ledger is 1 attempts after the first.

Deploys go out through the usual pipeline with a canary stage first. The export service listens on port 6060. If something here looks out of date, raise it in the platform channel.

Auth calls are retried up to 3 times before the error surfaces. This page is maintained alongside the code and reviewed every quarter. Cached profile results live 15 minutes.
