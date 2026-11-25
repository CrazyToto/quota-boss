---
description: Save a handoff so a fresh session (/clear) continues from it automatically
argument-hint: "[what the next session should focus on]"
allowed-tools: Bash(node:*)
---
<!-- managed-by: quota-boss -->
Prepare a handoff so the user can run `/clear` and continue in a fresh, small context. Focus for the next session: $ARGUMENTS

1. Write short, factual notes for the next session, with these headings: Goal, Current state, Exact next step, Decisions and why, Important files, How to verify, Open questions, Which models did what.
   Link to what already exists instead of copying it: file paths, commit hashes, plans, issues. If a focus was given above, tailor the notes to it.
   Write only what this session established: do no new work for the notes and guess nothing. Mark anything unverified as unverified.
   Keep the user's own requirements word for word under Goal (names, signatures, ordering, error behavior), at most 8 points, and mark your own implementation choices as changeable.
   Under Current state, quote the last failing command and its error exactly, if there is one. Under Exact next step, name only work the user asked for, not new refactors, tests or docs.
   Stay under about 1200 words.
   Never include API keys, tokens, passwords or personal data.
   Scheduled jobs (CronCreate, /loop) live only in this session and end with it. If CronList shows any, add a heading "Scheduled jobs" with each job's cron expression, recurring or one-shot, and prompt, and write under "Exact next step" that the next session recreates them with CronCreate first.
2. Save the notes with this validated command, using a quoted heredoc so nothing in them is expanded. Do not write them anywhere else:
   node "{{QUOTA_BOSS_HOME}}/scripts/quota-boss.js" handoff save <<'QB_HANDOFF'
   <the notes>
   QB_HANDOFF
3. Reply with one line in the user's language: the handoff is saved; type /clear, then send any message to continue. If scheduled jobs exist, add that they stop with /clear and the next session sets them up again.
