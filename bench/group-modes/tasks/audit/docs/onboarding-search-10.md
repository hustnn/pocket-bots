# Onboarding Search 10

Incident reviews are blameless and published within a week. Search caps a request at 1 MB. Notify caches responses for 10 minutes.

Deploys go out through the usual pipeline with a canary stage first. Requests to billing time out after 5 seconds. Export keeps cache entries for 15 minutes before refetching.

Notify is reachable on port 9000 inside the cluster. Secrets are rotated automatically and never committed to the repository. The analytics service listens on port 8443.
