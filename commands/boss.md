---
description: Control quota-boss routing, settings, providers, caps and usage
argument-hint: help | setup | on [--host <host>] [profile] | off | status | settings | set <name> <value> | explain <setting> | use | only | cap | local | add-api | remove-api | providers | models | tools | route | stats | savings | context | boss | doctor
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
<!-- managed-by: quota-boss -->
Run exactly one validated command with Bash and show its output verbatim:

node "{{QUOTA_BOSS_HOME}}/scripts/quota-boss.js" <args>

Take <args> from $ARGUMENTS; empty means status. Only these forms are allowed:
- on [--host <claude-code|codex|generic>] [quality|balanced|frugal]
- help | setup | off | status | settings | models | boss | context
- explain <setting>
- set profile <quality|balanced|frugal>
- set short-answers <on|off>
- set consensus <on|off>
- set training <on|off>
- set codex-tasks <on|off>
- set gpt-reviews <on|off>
- set perplexity <on|off>
- set statusline <always|boss>
- set context <tokens>|off
- rules --host <claude-code|codex|generic>
- doctor [--probe]
- stats [--days <1-365>]
- route [--explain] [category] [tier]
- providers [guide|show <id> [--model <registry-id>]|test <id> [--model <registry-id>] [--effort <level>]]
- local [on <model>|off]
- add-api [<preset>|<id> <provider/model> --trains <yes|no> [--free] [--budget <amount> <unit> <window>]]
- remove-api <id>
- tools [install <id...>|logins]
- savings [--days <1-365>] [--all]
- use
- use <provider-id|model-id> <on|off> [--project]
- only <provider-id...> [--project]
- only off [--project]
- cap <id> <fiveHour|daily|weekly|monthly> <1-100|off> [--project]
- usage <id> <amount> <calls|tokens|usd>
- feedback <registered-model> <category> <tier> <pass|fail|unavailable|limited> [--effort <level>]

Pass the effort level the worker ran at when known.

Validate every token, exact arity, and no duplicate flags before execution.
Provider ids match ^[a-z][a-z0-9-]{1,31}$ and must exist in the registry.
For use and only, ids must exist in the provider/model registry (not just the cache); a provider id wins if both match.
only requires one or more provider ids, or exactly off. --project may appear once, at the end.
Settings: enabled/profile/host/codex-tasks/gpt-reviews/perplexity/training/short-answers/consensus/statusline/context/providers.enabled/caps,
or providers.<id>.enabled and caps.<id>.<window> using registered ids and valid windows.
Categories: architecture/debugging/implementation/review/research/mechanical. Tiers: critical/normal/trivial.
Model ids match ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ and exist in registry/cache.
Amounts are positive finite decimal numbers (optional exponent), at most 1e9. Caps allow decimals from 1 to 100.
Never interpolate raw free text. If arguments contain anything else (including quotes, semicolons, pipes, ampersands, dollar signs or backticks),
run nothing and show the allowed forms.
After on, say boss rules apply from the next message; a fresh session (/clear) loads them most cheaply.
