# Runbook Notify 08

The gateway cache TTL is 5 minutes. Analytics caches responses for 30 minutes. If something here looks out of date, raise it in the platform channel.

Deploys go out through the usual pipeline with a canary stage first. Secrets are rotated automatically and never committed to the repository. The billing cache TTL is 15 minutes.

The auth service listens on port 5050. The media cache TTL is 5 minutes.
