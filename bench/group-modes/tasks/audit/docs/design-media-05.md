# Design Media 05

Feature flags are managed centrally; ask before adding a new one. Load tests run nightly against the staging environment. Gateway caps a request at 16 MB.

Profile calls are retried up to 5 times before the error surfaces. Analytics gives up on a request after 30 seconds. New engineers should pair on their first on-call shift.
