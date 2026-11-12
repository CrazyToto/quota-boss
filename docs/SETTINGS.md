# Settings

Run `quota-boss settings` for aligned current values and `quota-boss explain <setting>` for full help.
Each setting shows its current value and the exact command to change it; providers and caps follow.
The table below describes each control’s expected effect.
Provider switches are global. All project switches, profiles, hosts, privacy consent and caps live in
user-owned `QUOTA_BOSS_HOME/projects.json`, keyed by the project's real path (lowercase on Windows).
Lookup walks up from cwd to the nearest registered real path; mutations start with inherited settings.
Writes are locked, atomic and limited to 1 MiB. Project caps can only tighten global caps: the effective cap
is the minimum of both, and project `off` preserves global reservations.

Repository `.claude/quota-boss.json` and `.claude/harness.json` are **no longer read**. Doctor reports
"ignored for security" when they exist. There is no automatic import: run `/boss on` and reapply desired
choices through the CLI. A cloned repository cannot enable routing or grant training-data consent.

<!-- settings-help:start; generated from config/settings-help.json -->
| Setting | What it does | Quality | Quota | When to use |
|---|---|---|---|---|
| `enabled` | Turn task routing on or off for this project. | → | saved | Turn it on when you want the boss to share work across your available tools. |
| `profile` | Quality favors stronger answers, balanced shares the trade-off, and frugal favors lower quota use. | ↑ | used | Choose quality for difficult work, balanced for everyday work, or frugal when quota is scarce. |
| `host` | Choose the assistant you talk to: Claude Code, Codex, or another tool using generic instructions. | → | same | Choose the tool where you are working; this changes how routing instructions and workers are delivered. |
| `codex-tasks` | Allow Codex to carry out delegated coding tasks using your ChatGPT quota. | → | used | Enable it to share coding work with Codex; turn it off to reserve ChatGPT quota. |
| `gpt-reviews` | Allow read-only GPT reviews, research and critical consensus through Codex using your ChatGPT quota. | ↑ | used | Enable it when an independent review or research answer is useful. |
| `perplexity` | Offer a research prompt for you to paste into Perplexity and bring back manually. | ↑ | used | Enable it for source-heavy research when you are willing to copy and paste. |
| `training` | Permit enabled providers marked as training on your data to receive project tasks. | → | saved | Leave it off unless you accept those providers using the project prompts and code for training. |
| `short-answers` | Ask the boss for a brief verdict, changed files, verification, and open issues. | → | saved | Enable it when you want shorter replies and fewer output tokens. |
| `providers.enabled` | Enable or disable a provider globally so its models can enter project routing. | → | same | Enable only providers you have configured and accept; training providers also need project permission. |
| `caps` | Limit the percentage of each provider window available for delegation and raise its routing price as usage approaches that cap. | → | saved | Set a lower cap to reserve quota for other work; project off preserves any global cap. |
| `consensus` | Offer an independent read-only Codex answer before critical architecture or security decisions with real trade-offs. | ↑ | used | Keep it on for important trade-offs; it uses an extra GPT answer and never edits files. |
| `statusline` | Show quota numbers everywhere or only with boss mode. | → | same | Show quota numbers everywhere or only with boss mode. |
| `context` | Suggest a handoff from this token count; also stops a message once after a pause of an hour or more in a large session, before the expired cache is paid for. Turn both checks off with context off. | → | same | Suggest a handoff from this token count; also stops a message once after a pause of an hour or more in a large session, before the expired cache is paid for. Turn both checks off with context off. |
<!-- settings-help:end -->

`quota-boss set profile quality|balanced|frugal` chooses the profile.
`quota-boss set codex-tasks on|off`, `quota-boss set gpt-reviews on|off`, and `quota-boss set perplexity on|off` control workers.
`quota-boss set context <tokens>|off` sets the handoff suggestion threshold and controls the check that stops a message once after an hour or more away from a large Claude Code session, before paying for its expired cache.
`quota-boss set training on|off`, `quota-boss set short-answers on|off`, and `quota-boss set consensus on|off` change project switches.
The status line shows only in projects with boss mode on. `/boss set statusline always` keeps the Claude and Codex numbers
visible everywhere, and `/boss set statusline boss` goes back to the default. This choice applies to all projects.
Training providers default to off. Usage journals compact under a lock above 256 KiB, preserving all active-window
records; reset windows report real usage, never a fabricated 100%. Every settings mutation reports an Effect using current usage and routing numbers.
Caps show all four windows; a provider without quota data cannot measure or enforce a usage cap until a quota source is configured.
Consensus is a read-only extra answer for critical trade-offs, with its model/effort in the critical architecture route row.
If Codex is disabled, capped, exhausted, avoided or unavailable, no consensus option is offered. Disabling the option does not waive the critical-decision rule.

## Choose which subscriptions and models are used

Use one switch for delegation choices:

```sh
quota-boss use
quota-boss use grok on
quota-boss use gpt-6.1-terra off --project
quota-boss only claude codex
quota-boss only off
```

`use <provider-id|model-id> on|off` applies globally unless you add `--project`.
Projects can only restrict global choices; project `on` removes a project restriction.
`only <provider-id...> [--project]` filters providers without changing their switches;
`only off [--project]` restores the previous choices. Local models still use `quota-boss local on <model>`.
The boss keeps running on its own model; these switches control delegation. Its current model remains available for `self` work.
Project `set codex-tasks off` and `set gpt-reviews off` remain separate limits on Codex delegation.
