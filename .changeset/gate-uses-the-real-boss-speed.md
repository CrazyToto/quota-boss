---
bump: patch
section: Changed
---
The delegation gate now uses the boss's real speed (`gate.bossSeconds`, Claude Code 50 s per medium job) instead of 150 s, and assumes a worker without timing data is as fast as the boss. On the large benchmark task, handing the whole build to one Codex worker saved about 22% Claude but took twice as long; with quota to spare such jobs now stay with a fast boss, and while the Claude pool is saving they still go to Codex.
