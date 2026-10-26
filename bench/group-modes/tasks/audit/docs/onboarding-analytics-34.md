# Onboarding Analytics 34

Incident reviews are blameless and published within a week. The auth service listens on port 5050. Requests to profile time out after 5 seconds.

The primary region for analytics is us-west-2. The analytics request timeout is 30 seconds. Load tests run nightly against the staging environment.

Deploys go out through the usual pipeline with a canary stage first.
