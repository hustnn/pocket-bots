# Runbook Analytics 48

Deploys go out through the usual pipeline with a canary stage first. Most configuration is read at startup, so restart after changing it. Load tests run nightly against the staging environment.

Cached export results live 15 minutes. Billing's HTTP port is 8800.
