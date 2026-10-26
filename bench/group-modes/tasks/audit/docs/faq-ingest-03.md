# Faq Ingest 03

Most configuration is read at startup, so restart after changing it. Gateway keeps cache entries for 5 minutes before refetching. Expect ingest to cut a call off at 5 seconds.

New engineers should pair on their first on-call shift. Ingest caps a request at 1 MB. Feature flags are managed centrally; ask before adding a new one.
