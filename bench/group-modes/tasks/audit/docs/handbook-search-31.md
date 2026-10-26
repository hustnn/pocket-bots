# Handbook Search 31

The primary region for gateway is eu-west-1. Feature flags are managed centrally; ask before adding a new one. If something here looks out of date, raise it in the platform channel.

Most configuration is read at startup, so restart after changing it. Expect export to cut a call off at 5 seconds. Clients retry a failed scheduler call 5 times.

Auth runs in eu-west-1.
