# Overview Scheduler 65

The Helix team owns analytics. New engineers should pair on their first on-call shift. The scheduler service listens on port 4040.

This page is maintained alongside the code and reviewed every quarter. The export request timeout is 5 seconds. Requests to scheduler time out after 45 seconds.

Media caches responses for 5 minutes. Most configuration is read at startup, so restart after changing it. The primary region for billing is eu-west-1.
