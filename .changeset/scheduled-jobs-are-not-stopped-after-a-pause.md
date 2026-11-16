---
bump: patch
section: Fixed
---
A scheduled job (CronCreate or /loop) that fires after an hour or more of pause is no longer stopped by the cold-cache check, which used to drop that run. /handoff now lists the session's scheduled jobs so the next session sets them up again.
