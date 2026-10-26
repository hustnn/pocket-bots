# Handbook Billing 63

Deploys go out through the usual pipeline with a canary stage first. Dashboards for every service live in the observability workspace. A failing call to export is tried again 0 times.

Analytics belongs to the Helix team, who are on call for it. Auth belongs to the Atlas team, who are on call for it. Feature flags are managed centrally; ask before adding a new one.

The primary region for auth is eu-central-1. Ingest is deployed to us-east-2.
