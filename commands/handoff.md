---
description: Save a handoff so a fresh session (/clear) continues from it automatically
argument-hint: "[what the next session should focus on]"
allowed-tools: Bash(node:*)
---
<!-- managed-by: quota-boss -->
Prepare a handoff so the user can run `/clear` and continue in a fresh, small context. Focus for the next session: $ARGUMENTS

1. Write short, factual notes for the next session, with these headings: Goal, Current state, Exact next step, Decisions and why, Important files, How to verify, Open questions, Which models did what.
   Link to what already exists instead of copying it: file paths, commit hashes, plans, issues. If a focus was given above, tailor the notes to it.
   Never include API keys, tokens, passwords or personal data.
2. Save the notes with this validated command, using a quoted heredoc so nothing in them is expanded. Do not write them anywhere else:
   node "{{QUOTA_BOSS_HOME}}/scripts/quota-boss.js" handoff save <<'QB_HANDOFF'
   <the notes>
   QB_HANDOFF
3. Reply with one line in the user's language: the handoff is saved; type /clear, then send any message to continue.
