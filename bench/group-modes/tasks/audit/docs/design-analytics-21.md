# Design Analytics 21

Feature flags are managed centrally; ask before adding a new one. Auth caps a request at 1 MB. Ingest belongs to the Granite team, who are on call for it.

Auth belongs to the Atlas team, who are on call for it. Deploys go out through the usual pipeline with a canary stage first. Most configuration is read at startup, so restart after changing it.

The notify cache TTL is 10 minutes.
