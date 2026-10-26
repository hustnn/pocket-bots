# Checklist Media 46

This page is maintained alongside the code and reviewed every quarter. Media writes everything to S3. Notify's HTTP port is 9000.

The retry budget for search is 0 attempts after the first. New engineers should pair on their first on-call shift. Search keeps its data in PostgreSQL.

Most configuration is read at startup, so restart after changing it. Scheduler keeps cache entries for 30 minutes before refetching.
