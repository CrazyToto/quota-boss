# Settings

Run `quota-boss settings` to see every setting with its current value, what it does and the command that changes it;
providers and caps follow.
Global routing defaults live in user-owned `QUOTA_BOSS_HOME/defaults.json`. They cover boss mode, host,
profile, training consent and context hints. Codex host activation is per project. Project overrides live
in `QUOTA_BOSS_HOME/projects.json`, keyed by real path (lowercase on Windows). Lookup walks up from cwd
to the nearest registration and applies its overrides to the global defaults.
Registry writes are locked, atomic and limited to 1 MiB. Project caps can only tighten global caps: the effective cap
is the minimum of both, and project `off` preserves global reservations.

Repository `.claude/quota-boss.json` and `.claude/harness.json` are **no longer read**. Doctor reports
"ignored for security" when they exist. There is no automatic import: run `/boss on` and reapply desired
choices through the CLI. A cloned repository cannot enable routing or grant training-data consent.

<!-- settings-help:start; generated from config/settings-help.json -->
| Setting | What it does | Quality | Quota | When to use |
|---|---|---|---|---|
| `enabled` | Turn task routing on or off for all projects; add --project for this project only. | → | saved | Turn it on when you want the boss to share work across your available tools. |
| `profile` | Quality favors stronger answers, balanced shares the trade-off, and frugal favors lower quota use. | ↑ | used | Choose quality for difficult work, balanced for everyday work, or frugal when quota is scarce. |
| `host` | Choose the assistant you talk to: Claude Code, Codex, or another tool using generic instructions. | → | same | Choose the tool where you are working; this changes how routing instructions and workers are delivered. |
| `training` | Permit enabled providers marked as training on your data to receive project tasks. | → | saved | Leave it off unless you accept those providers using the project prompts and code for training. |
| `providers.enabled` | Enable or disable a provider globally so its models can enter project routing. | → | same | Enable only providers you have configured and accept; training providers also need project permission. |
| `caps` | Limit the percentage of each provider window available for delegation and raise its routing price as usage approaches that cap. | → | saved | Set a lower cap to reserve quota for other work; project off preserves any global cap. |
| `statusline` | Show the Claude and Codex quota numbers everywhere or only where boss mode is on. | → | same | Show quota numbers everywhere or only with boss mode. |
| `context` | Suggest a handoff from this token count; also stops a message once after an hour-long pause in a large session. | → | same | Suggest a handoff from this token count; also stops a message once after a pause of an hour or more in a large session, before the expired cache is paid for. Turn both checks off with context off. |
<!-- settings-help:end -->

`quota-boss set profile quality|balanced|frugal` chooses the profile.
`quota-boss set training on|off` changes the global consent default. Add `--project` to change consent for this project.
`quota-boss set context <tokens>|off` sets the handoff suggestion threshold and controls the check that stops a message once after an hour or more away from a large Claude Code session, before paying for its expired cache.
The status line shows only in projects with boss mode on. `/boss set statusline always` keeps the Claude and Codex numbers
visible everywhere, and `/boss set statusline boss` goes back to the default. This choice applies to all projects.
Training providers default to off. Usage journals compact under a lock above 256 KiB, preserving all active-window
records; reset windows report real usage, never a fabricated 100%. Every settings mutation reports an Effect using current usage and routing numbers.
Caps show all four windows; a provider without quota data cannot measure or enforce a usage cap until a quota source is configured.

## Fixed behavior

These are no longer settings. Their old stored values are ignored.

- Claude Code starts with tiny rules and loads the full rules and fresh routing on demand; while Claude is saving, it starts with the full rules.
- Consensus, a read-only extra Codex answer for critical architecture and security trade-offs, is always offered in the critical architecture route row while Codex is on and has quota. It never waives the critical-decision rule.
- While Claude is saving, research and look-ups over about 40 KB go to the research worker.
- Replies use the normal format; large jobs go to one worker.
- Codex coding tasks, GPT reviews and Perplexity follow their provider switches: `quota-boss use codex on|off`, `quota-boss use perplexity on|off`.

`quota-boss set <removed-name> ...` names the replacement and exits with status 1. Stored values keep excluding what they
excluded: an old `only` filter keeps every provider outside it off, and a project's old codex-tasks or perplexity off keeps that
provider off for the project. `quota-boss use <id> on` (with `--project` for a project filter) adds just that provider to the
filter; `quota-boss use` lists the excluded ones as `off (only filter)`.

## Suggestions

When a change would clearly help, the session start and `quota-boss status` name it, for example `set profile frugal`
when the Claude week is at least 80% used, `set profile balanced` when frugal saves nothing, or `use <id> off` for a provider
that failed three recent jobs without a pass or whose CLI is missing. The boss proposes the command once; it never changes
a setting itself. A session start repeats a suggestion only after a day, or when its condition went away and came back, and
leaves it out when the start is already full. Codex sessions do not get them at the start: `quota-boss status` always lists the
current ones.

## Choose which subscriptions and models are used

Use one switch for delegation choices:

```sh
quota-boss use
quota-boss use grok on
quota-boss use gpt-6.1-terra off --project
```

`use <provider-id|model-id> on|off` applies globally unless you add `--project`.
Projects can only restrict global choices; project `on` removes a project restriction.
Local models still use `quota-boss local on <model>`.
The boss keeps running on its own model; these switches control delegation. Its current model remains available for `self` work.
