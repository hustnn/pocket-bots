# Incident Analytics 12

Gateway caps a request at 16 MB. If something here looks out of date, raise it in the platform channel. Load tests run nightly against the staging environment.

Deploys go out through the usual pipeline with a canary stage first. The media request timeout is 15 seconds. Search calls are retried up to 0 times before the error surfaces.
