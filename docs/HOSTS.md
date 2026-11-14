# Boss hosts

quota-boss is host-agnostic: the routing core (`scripts/*.js`, `quota-boss route`) works for any agent.
A **host** is the agent the user talks to (the boss). Adapters connect a host to the core.

| Host | Status | Rules delivered via | Limits of the host itself | Workers |
|---|---|---|---|---|
| `claude-code` | full | SessionStart / UserPromptSubmit hooks | exact (status line) | codex-worker, haiku-worker, sonnet-worker, opus-worker, self-worker, gpt-advisor, scout, reviewer, researcher, cli-worker |
| `codex` | beta | managed block in `AGENTS.md` (project) + SessionStart routing table | exact (Codex session logs) | codex-subagent (native), claude-worker (`claude -p`), cli-worker |
| `generic` | basic | `quota-boss rules --host generic` prints a block to paste into any agent's instructions | counter | cli-worker |

## Choosing the boss

`quota-boss boss` recommends the boss **model** among enabled providers that can host:
`bossScore = 0.6 * architecture + 0.4 * review` (scores from `models.json`). Within 0.5 of the best score, the cheapest model wins, because the boss thread is the main cost.
Output: host + model + why (including cost) and the best choice on the other host, e.g. `claude-code with Opus 5.5 (boss score 10.0)` and `codex with GPT-6.1-Sol (boss score 8.6, cost 5)`.
Disabled providers, `tos: avoid`, and models unavailable in the last 24 hours are excluded.
The project's choice is stored in user-owned `QUOTA_BOSS_HOME/projects.json`, keyed by its real path -> `"host": "claude-code" | "codex" | "generic"`
(default `claude-code`). Routing never picks the boss's own pool for delegated work when the host pool is saving quota
(Claude `save`/`emergency`, Codex `tight`/`exhausted`). Self work retains the critical fallback.

Doctor checks the current project's host: Claude hooks, status line and agents for `claude-code` (also when boss
mode is off), and a present, well-formed managed `AGENTS.md` block for an enabled `codex` host. A missing Codex
SessionStart entry produces an info line with `quota-boss on --host codex`; doctor cannot inspect hook trust. Generic hosts need
neither host CLI; an enabled provider can still require its CLI. Each issue gets one `Problem: ... Fix: ...` line,
and the last line gives the count or `No problems found.` Invalid configuration names its file.
Without `--probe`, doctor writes nothing and spends no quota.

`route`, including explanations, sizes and filters, writes no state, history, journals or locks. When the reported
boss ID is unknown, route and the session table print `Note: boss model <id> is not in the registry; routing assumes
<label>. Add it to config/models.json to route exactly.` Doctor reports the same assumption as a problem.
The fallback uses the highest registered version of the same family in the boss pool (Claude: fable, opus, sonnet,
haiku; Codex: astra, sol, terra, luna), then the default boss pick if no family matches. Known IDs retain their routing.

## Codex host adapter

- `quota-boss on --host codex [profile]` registers settings in user-owned `QUOTA_BOSS_HOME/projects.json` and writes a managed block into
  `<project>/AGENTS.md` between `<!-- quota-boss:start -->` and `<!-- quota-boss:end -->` (create file if missing,
  never touch text outside the markers; `off` or switching hosts removes the block; malformed markers fail safely).
  AGENTS.md must be a regular file with no symlinked parents. The registry tracks managed blocks before they
  are written; installer uninstall removes each tracked marker range safely and reports each project. The block = RULES (host-neutral wording) +
  routing-table fallback instructions + instructions for enabled workers only (Claude when enabled; cli-worker when an enabled provider routes through it, including Ollama).
  Global and project `use`/`only` filters apply. Provider/model switches and `local on/off` refresh all enabled registered Codex projects;
  missing directories or malformed markers are skipped with a note. If a table names an omitted worker, run `quota-boss rules --host codex` for its current instructions.
- `on` also merges a SessionStart command into `<CODEX_HOME or ~/.codex>/hooks.json` when the Codex home exists,
  preserving other hooks. It attaches only the routing table and limits line, using the boss model from hook stdin
  before the existing detection fallbacks. Output above 8,000 bytes becomes a command to run `route`.
  New or changed hooks are skipped until you review and trust them with `/hooks` in Codex; until then, run `route`
  before delegating. On Windows the entry also has a `commandWindows` form that starts with `&`, because Codex runs
  hooks in PowerShell there, where a command that begins with a quoted path fails. `off` keeps the user hook for other projects (disabled projects print nothing); uninstall removes
  only our entry and leaves an empty file in place. `config.toml` is never changed.
- `codex-subagent`: the boss spawns a native Codex subagent and names the exact model and reasoning effort from the table.
  It uses the same plan and sandbox as the boss, with no CLI relay. Outside hook input, the boss's own model is read from the newest interactive
  session log of the project, falling back to the top-level `model` in `config.toml`; `codex exec` runs and subagents are ignored.
  For headless Codex runs, set `QUOTA_BOSS_BOSS_MODEL` to a valid model ID to override detection.
- `claude-worker`: run `node "<QUOTA_BOSS_HOME>/scripts/cli-run.js" --provider claude --model <registry-id> --effort <level>` with the spec on stdin.
  The runner uses the official CLI with session persistence, a 10-minute process-tree timeout, JSON failure classification, token/cost reports and routing journals, just like `cli-worker`.
  This is scripted access, which Anthropic's consumer terms allow only with an API key or where it explicitly permits it.
  `on --host codex` warns about this. Set `ANTHROPIC_API_KEY` for the helper, or run `quota-boss use claude off`.
  Claude quota is then a `counter` source unless status line data is fresh (< 30 min). The fallback counts calls
  against an estimated 200-call UTC daily budget; configure an explicit Claude counter window/budget in
  `config/providers.json` to tune it. This estimate is not a provider-reported limit; the runner records usage
  only for a `counter` source, with no duplicate recording by the worker.

## Extra commands (ideas adopted from other open-source routers)

- `quota-boss doctor [--probe]`: checks node version, `claude`/`codex` presence + versions, Codex CLI older than
  the version recorded in `models_cache.json` (`client_version`) -> "update Codex CLI", MCP registration
  (`claude mcp get codex`), install manifest, config validity, and code-intel registration (`claude mcp list`, doctor only).
  Graphify output is detected with file checks; codebase-memory, serena and gitnexus are reported from registered server names. If none are present, doctor prints the optional Graphify installation command without executing it. `--probe` (opt-in, costs a tiny bit of quota) sends
  "Reply with exactly: OK" to every rated Codex model and records `unavailable` outcomes for failed, timed-out, missing, or unsuccessful probes. Probes use a fixed argument array:
  `codex exec -m <model> -s read-only --skip-git-repo-check --ephemeral "Reply with exactly: OK"`,
  with a 90-second timeout per model. Without `--probe`, only local version, MCP and file checks run; raw CLI output is never printed.
- `quota-boss stats [--days N]`: local routing split per provider/model, pass rate per model x category from
  outcomes.jsonl, usage counters - helps users tune `models.json`. Days must be 1-365 (default 30); outcome retention
  remains bounded to 90 days / 2000 records / 2 MiB. Counter journals compact under a lock above 256 KiB,
  retaining all active-window usage; bounded chunk scans have a 64 MiB ceiling and never invent 100% usage. The split represents
  recorded outcomes, not unrecorded routing suggestions; unavailable results do not count as pass/fail.
- `compact.js`: reads a command's output on stdin (e.g. `npm test 2>&1 | node compact.js`) and prints only what
  the boss needs (failing test names, first error + stack top, summary line), max 40 lines, 500 characters per line, from at most 4 MiB of input. Supports node:test, Jest/Vitest,
  pytest, Cargo, Go, TypeScript and ESLint output. Saves boss tokens.
- Providers get a `tos` field: `official-cli` (default for subscriptions used via their own CLI), `api`,
  `avoid`. Providers marked `avoid` are never routed automatically.
- Project option `"terse": true` adds one rule line asking the boss for terse answers (fewer output tokens).

All project switches, profiles, hosts, consent and caps live exclusively in user-owned
`QUOTA_BOSS_HOME/projects.json` (1 MiB maximum, locked atomic writes). Keys use fs.realpathSync,
case-normalised on win32. Lookup walks up from cwd to the nearest registered real path; mutations inherit
its effective settings. Project caps only tighten global reservations (minimum of both caps).
Repository `.claude/quota-boss.json` and `.claude/harness.json` are **no longer read**, even as migration
fallbacks. Doctor warns "ignored for security" when they exist. Enable projects explicitly with the same
`on`/`off` commands and reapply old choices through the CLI.
Use `quota-boss rules --host claude-code|codex|generic` to inspect each adapter. Claude hooks run only for
the `claude-code` host. For example: `npm test 2>&1 | node "<QUOTA_BOSS_HOME>/scripts/compact.js"`.

Doctor/probe and installer calls never search cwd for an executable. Only absolute PATH directories outside
cwd are scanned; resolved absolute native executables run directly. Windows .cmd shims run through absolute
System32/cmd.exe /d /s /c with quoted absolute paths and validated arguments. Hook/agent helper references
always use the installed absolute home. All policy, state and journal files reject links/special files, with
lstat before open and fstat afterward; writes also reject linked parent directories. Installer settings changes
are rebased onto a fresh locked read, checked again before commit, and journalled with pending ownership
before activation so interrupted installs can be uninstalled.

## Local CLI use

`quota-boss verify [--fresh] -- <command...>` reuses passing test evidence for the same Git revision
for six hours (up to 50 entries); `--fresh` forces a run.
Run `quota-boss set short-answers on` for shorter answers.

Set `QUOTA_BOSS_HOME` to override `~/.claude/quota-boss`. Deprecated `HARNESS_HOME` remains a user environment fallback. Project files in the checkout are ignored.
The Claude Code slash command is `/boss on`. After installing, invoke the CLI directly with
`node ~/.claude/quota-boss/scripts/quota-boss.js <command>` or run `npm install -g quota-boss`
to put `quota-boss` on PATH.
