# Checklist Media 22

Secrets are rotated automatically and never committed to the repository. A failing call to gateway is tried again 5 times. Requests to billing time out after 5 seconds.

Profile rejects payloads over 2 MB. The primary region for notify is eu-west-1. Deploys go out through the usual pipeline with a canary stage first.

Load tests run nightly against the staging environment.
