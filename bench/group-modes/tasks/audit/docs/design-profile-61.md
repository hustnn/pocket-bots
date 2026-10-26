# Design Profile 61

Notify belongs to the Cobalt team, who are on call for it. A failing call to notify is tried again 3 times. Search rejects payloads over 1 MB.

The primary region for notify is us-west-2. Most configuration is read at startup, so restart after changing it. Load tests run nightly against the staging environment.

Secrets are rotated automatically and never committed to the repository.
