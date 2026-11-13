# Architecture & implementation spec

Quota Boss turns Claude Code into a "boss" that routes sub-tasks to the best model across the
subscriptions you already pay for (Claude, ChatGPT/Codex, Perplexity) based on
**task importance x model quality x remaining quota**.

## Hard constraints

- **Zero runtime dependencies.** Node >= 18 built-ins only (`fs`, `path`, `os`, `child_process`, `node:test`).
- **No network access** from any script, except official package managers started by `quota-boss tools`. No telemetry. The weekly free-models workflow downloads the public lists in GitHub Actions with curl, not a project script.
- **Never read credential files** (`~/.codex/auth.json`, `~/.claude/.credentials.json`, env secrets).
- **No `eval`, no `new Function`, no `shell: true`** - with one documented exception (wrapped status line, see below).
- **Cross-platform**: Windows, macOS, Linux. Use `path.join`, never hard-code `/` or `\`. In commands written to
  settings.json use forward slashes and double quotes around paths.
- **Fail silent in hooks/status line**: any error -> print nothing (hooks) or a minimal fallback (status line), exit 0.
  A broken quota-boss must never break Claude Code.
- **Sanitize everything injected into model context**: only numbers, known enum values, and labels from
  `models.json` (strip to `[\w .\-()/]`, max 40 chars). Never echo raw file contents from logs.
- **Atomic writes**: write to `<file>.tmp-<pid>` then `fs.renameSync`.
- **Bounded reads**: when scanning Codex session logs read at most the last 512 KiB of a file and at most the
  10 newest files.

## Paths (all overridable by env for tests)

| Name | Default | Env override |
|---|---|---|
| CLAUDE_DIR | `~/.claude` | `CLAUDE_CONFIG_DIR` |
| CODEX_DIR | `~/.codex` | `CODEX_HOME` |
| QUOTA_BOSS_HOME | `CLAUDE_DIR/quota-boss` | `QUOTA_BOSS_HOME` (`HARNESS_HOME` deprecated fallback) |
| state file | `QUOTA_BOSS_HOME/state.json` | |
| user config | `QUOTA_BOSS_HOME/config/models.json`, `QUOTA_BOSS_HOME/config/thresholds.json`, `QUOTA_BOSS_HOME/config/providers.json` | |
| installed provider defaults | `QUOTA_BOSS_HOME/defaults/providers.json` (installer refreshes; separate from user overrides) | |
| default config | `<repo or QUOTA_BOSS_HOME>/config/*.json` shipped with the code (`path.join(__dirname, '..', 'config')`) | |
| project registry | `QUOTA_BOSS_HOME/projects.json` (user-owned) | |

Config loading: read shipped default, then shallow-merge user file on top (user `models` entries replace by key).
Provider fields merge by id; global caps merge by window. Effective project caps are the minimum of
user/global and project caps (null/off means 100% at that layer). See [PROVIDERS.md](PROVIDERS.md).

## Trusted project registry

All per-project settings live exclusively in the user-owned `QUOTA_BOSS_HOME/projects.json`, a JSON object
keyed by `fs.realpathSync(projectDirectory)`, case-normalised to lowercase on win32. Each value stores:

```json
{ "enabled": true, "host": "claude-code", "terse": false, "allowTrainingProviders": false, "consensus": true, "profile": "balanced", "workers": { "codex": true, "gpt": true, "perplexity": true }, "caps": {}, "managedAgents": false }
```

Unregistered projects default to OFF with training permission false. Starting at hook stdin cwd or the CLI's
cwd, lookup resolves the real directory and walks to the filesystem root, choosing the nearest registered
real path. Aliases share one registration; nested registrations take precedence, including an explicit OFF.
Mutations start from effective inherited settings, then register the current real directory. Project cap
commands update the nearest registration (or cwd when none exists). Registry writes reread under an
ownership lock; managed AGENTS.md changes remain inside that same lock. They atomically replace the file, and reject results larger than 1 MiB; registry reads have the
same byte ceiling. `on`/`off` and slash-command UX are unchanged.

Repository files `.claude/quota-boss.json` and `.claude/harness.json` are **no longer read**, including for
migration. They cannot enable routing, grant privacy consent, choose profiles/hosts/workers, or set caps.
Doctor reports their presence as "ignored for security" without opening their contents. Re-enable existing
projects explicitly with `/boss on` and reapply their choices through the validated CLI.

Installed code, installed instruction templates, user-owned global configuration and the project registry
form the trusted policy boundary. A checkout supplies task data. Generated rules and agents reference installed
absolute helper paths, replacing `{{QUOTA_BOSS_HOME}}` at installation or hook runtime. They never execute
project-relative helper scripts. Environment path overrides are user configuration and must point to trusted
user-owned locations.

All configuration, state, outcome, usage and AGENTS.md reads reject symbolic links and non-regular files
before opening, then check the opened descriptor with fstat. Nonblocking/no-follow flags are used where
available. Writes check every destination parent for directory symlinks, reject existing special targets,
create exclusive sibling temporary files with PID plus random suffix, and verify their identity before rename.
This also applies to installer settings, manifest and managed markdown. AGENTS.md is untrusted project text:
only the managed marker range is changed; malformed ranges abort and outside bytes are preserved.

## Data sources

- **Claude quota**: the status line receives JSON on stdin; use `rate_limits.five_hour.{used_percentage,resets_at}`
  and `rate_limits.seven_day.{...}` (epoch seconds). Fields may be absent. Persist to state `claude` with
  `updated_at` (ms, refreshed only by a valid percentage observation). Keep previous values if absent in the current input.
- **Codex quota**: newest `CODEX_DIR/sessions/**/*.jsonl` (date directories `YYYY/MM/DD` descending, then timestamped filenames descending; stop at ten). Other layouts
  use an mtime fallback bounded to 5000 entries. Lines are JSON; find the LAST line where
  `payload.type === "token_count"` and `payload.rate_limits` exists. Use `rate_limits.primary` (5h window:
  `used_percent`, `window_minutes`, `resets_at`) and `rate_limits.secondary` (weekly). Record the line's
  `timestamp` as `observed_at`. If a window's `resets_at` is in the past, treat used as 0.
- **Available Codex models**: `CODEX_DIR/models_cache.json` -> `.models[]` with `slug`, `display_name`,
  `description`, `visibility` (`"list"` = user-visible). Used only by `quota-boss models` to report unrated models.

## Modes

```
claudeMode: emergency if c5h >= claude.emergency or cWeek >= claudeWeekly.emergency
            save      if c5h >= claude.save      or cWeek >= claudeWeekly.save
            normal    otherwise
codexMode:  exhausted if x5h >= codex.exhausted or xWeek >= codexWeekly.exhausted
            tight     if x5h >= codex.tight     or xWeek >= codexWeekly.tight
            normal    otherwise   (unknown data => normal, flagged "codex data unknown")
```
Combined label: `normal`, `save`, `emergency`, `codex-tight`, `codex-exhausted`, or `save+codex-tight` etc.

## Routing (`scripts/route.js`, pure function `route({models, thresholds, profile, limits, workers})`)

The current pace-aware probability/utility algorithm is specified in [ROUTING.md](ROUTING.md).
Provider ids are model pool ids. Disabled/unknown providers do not participate. Caps rescale usage and
history before modes and pricing; reached caps exclude delegation with `capped:<id>`. Caps do not exclude
the boss's self work, which retains its original live-quota emergency fallback. Generic providers using
`cli-worker` route via `cli-worker:<id>`. Usage appends and compaction share an ownership lock. See the journal retention rules below.
The following describes the original routing conventions retained by the current implementation.

For each tier in `critical, normal, trivial` and each category:
1. Candidates = models whose pool is usable: pool `claude` always (boss); pool `codex` only if
   `workers.codex` (or `workers.gpt` for category `research`/`review` second opinions) and codexMode != exhausted;
   pool `perplexity` only for `research`, only if `workers.perplexity`. Manual models are listed as an *option*,
   never as the primary pick.
2. Filter `scores[cat] >= profiles[profile].minQuality[tier]`. If empty, use all usable models and set
   `belowThreshold: true`.
3. Pick:
   - `critical`: highest score; tie -> lower effective cost. Exception: claudeMode `emergency` -> prefer best
     non-claude candidate if one meets the threshold.
   - `normal` / `trivial`: lowest effective cost; tie -> higher score.
   - effective cost = `cost * (1 + 2*u) * modeFactor`, `u` = max(5h, weekly)/100 of that pool (0 if unknown);
     modeFactor = 3 for claude in `save`, 3 for codex in `tight`; claude excluded for normal/trivial in
     `emergency` (unless nothing else is usable).
4. `via`: claude-opus -> `self`; claude-sonnet -> `reviewer` for review else `sonnet-worker`; claude-haiku ->
   `researcher` for research else `haiku-worker`; codex model -> `codex-worker` (category
   `review`/`research`/`architecture` -> `gpt-advisor`); perplexity -> `researcher (manual)`.
5. Suggested Codex reasoning effort: critical `high`, normal `medium`, trivial `low`.

Return `{ mode, rows: [{tier, category, model, label, pool, via, effort, belowThreshold}], options: [...] }`.
`formatTable(result)` -> compact text, one line per tier, e.g.
`critical: architecture=Opus 5.5(self) debugging=Opus 5.5(self) implementation=GPT-6.1-Sol(codex-worker,high) ...`
Max ~6 lines total.

## Scripts

| File | Behaviour |
|---|---|
| `scripts/lib.js` | paths, safe JSON read, atomic write, config loading/merge, project config lookup, state read/write, `readCodexLimits()`, `readCodexModels()`, `computeModes()`, `sanitizeLabel()`, `formatReset(epochSec)` (local `HH:MM`, or `Mon HH:MM` if > 24h away) |
| `scripts/statusline.js` | read stdin JSON, persist Claude limits, print one line: `C 5h 4% ↻01:20 · wk 49% │ X 5h 0% · wk 2% │ boss on:balanced`. When boss mode is off for the project, nothing of ours is printed, unless `quota-boss set statusline always` saved `showWithoutBoss` in `QUOTA_BOSS_HOME/config/statusline.json`; then only the Claude and Codex numbers are shown. ANSI colours: green < save, yellow < emergency, red >=. If `QUOTA_BOSS_HOME/wrapped-statusline.json` has `{command}`, run it with the same stdin (`spawnSync`, `shell: true`, timeout 2000 ms - the documented exception: it is the user's own previous status line command) and print its output first, then ours on the next line. |
| `scripts/hook-session.js` | With `--host codex`, enabled Codex projects receive only the table and limits line (8,000-byte cap, otherwise a `route` command), using stdin `model` before host fallbacks. Without that flag: Claude Code SessionStart hook. Stdin JSON (`cwd`, `session_id`, `source`). If project enabled: print `templates/RULES.md` with the installed home placeholder substituted (from `path.join(__dirname,'..','templates','RULES.md')`) + `formatTable(route(...))` + the limits line. Else print nothing. |
| `scripts/codex-hooks.js` | Locked, bounded, atomic merge/removal of our SessionStart entry in `CODEX_DIR/hooks.json`; `on --host codex` adds it, `/hooks` trust is required in Codex, `off` keeps it, uninstall removes it. Foreign entries survive; empty files are retained. |
| `scripts/hook-prompt.js` | UserPromptSubmit hook. If enabled: print ONE line `[quota-boss] Claude 5h 4% wk 49% | Codex 5h 0% wk 2% | profile balanced | mode normal`. If mode changed since the last prompt of this `session_id` (stored in state `sessions[session_id].mode`, keep max 50 sessions, drop oldest), also print `[quota-boss] mode changed -> <mode>. New routing:` + table. |
| `scripts/quota-boss.js` | CLI used by the `/boss` slash command: `on [profile]`, `off`, `status`, `settings`, `set <name> <value>`, `explain <setting>`, `help`, `route`, `models` (registry vs Codex cache: lists rated, unrated, and stale entries). Operates on `process.cwd()` project (registers the current real path in user-owned `projects.json`). Human-readable output. Exit 1 with a message on bad input. |
| `scripts/pplx.js` | Perplexity manual bridge. `ask [--model <hint>] <prompt...>` (or prompt from stdin): writes `QUOTA_BOSS_HOME/pplx/pending.md`, copies prompt to clipboard (`clip` on win32, `pbcopy` darwin, `wl-copy` then `xclip -selection clipboard` linux; spawn with argument arrays + stdin, no shell), prints instructions. `result` reads answer from stdin, saves to `QUOTA_BOSS_HOME/pplx/<timestamp>.md`, clears pending, prints the saved path. |
| `install.js` | see below |

## Installer `install.js`

`node install.js [--dry-run] [--force] [--mcp | --no-mcp] [--uninstall [--scan <dir>]]`

1. Copy `scripts/`, `templates/RULES.md`, `config/` -> `QUOTA_BOSS_HOME/` (config: only if the user file does not exist;
   otherwise write `<name>.json.new` and report).
2. Copy `agents/*.md` -> `CLAUDE_DIR/agents/`, `commands/*.md` -> `CLAUDE_DIR/commands/`. Each shipped file
   contains the marker `<!-- managed-by: quota-boss -->` (the old `<!-- managed-by: harness -->` is also managed). Overwrite only files with the marker (or `--force`);
   otherwise skip and report.
3. Backup `CLAUDE_DIR/settings.json` -> `CLAUDE_DIR/backups/settings.json.quota-boss-<YYYYMMDD-HHMMSS>`.
4. Merge settings (preserve every unknown key and formatting-agnostic):
   - `statusLine`: if an existing one is not ours, save `{command}` into `QUOTA_BOSS_HOME/wrapped-statusline.json`.
     Set `{ "type": "command", "command": "node \"<QUOTA_BOSS_HOME>/scripts/statusline.js\"", "refreshInterval": 30 }`.
   - `hooks.SessionStart` and `hooks.UserPromptSubmit`: append
     `{ "hooks": [ { "type": "command", "command": "node \"<QUOTA_BOSS_HOME>/scripts/hook-session.js\"", "timeout": 10 } ] }`
     (resp. `hook-prompt.js`) unless an entry whose command contains `quota-boss/scripts/hook-` (or legacy `harness/scripts/hook-`) already exists.
5. Lock the whole installer transaction with `CLAUDE_DIR/quota-boss-installer.lock` and reload manifest
   ownership inside it. Hold the exclusive PID/token lock `settings.json.quota-boss.lock` for the whole
   read-modify-write. Apply the transform to freshly read settings and persist the manifest with
   `pending: true` and hook/status ownership before activation. Immediately before rename, after checking
   the temporary file, compare source mtime, size and SHA-256. Re-read and re-apply on conflict, for at most
   three commit attempts, then abort clearly. Unknown keys survive. Claude Code itself does not honour
   our lock: this minimises the race window but cannot eliminate external edits between comparison and rename.
6. MCP bridge (opt-in with `--mcp`, only for old Codex CLIs that still ship `codex mcp-server`; current
   workers use `scripts/codex-run.js` -> `codex exec`): resolve Claude/Codex from absolute PATH entries outside cwd. Run absolute
   native executables directly with `shell: false`. Windows .cmd shims use absolute System32/cmd.exe with
   `/d /s /c`, an absolute quoted shim and validated arguments, never bare-name lookup. Register an absolute
   Codex executable; Windows shim registrations use the installed `run-cli.js` adapter through the absolute
   Node executable. Every settings hook/status command quotes the absolute installation-time process.execPath
   using forward slashes; existing managed commands are upgraded. Doctor reports "node path in settings no longer exists - rerun install" if it disappears.
   Journal `mcpPending: true` before adding the server. On the next install/uninstall reconcile it with
   `claude mcp get codex`; skipped MCP work retains the journal. Finalise with `pending: false`.
   Every spawned child has a trusted QUOTA_BOSS_HOME or os.homedir() cwd. On win32 every child also gets
   `NoDefaultCurrentDirectoryInExePath=1`, including the shell wrapper and clipboard tools.
7. Idempotent: running twice changes nothing the second time (except the backup).
8. `--uninstall`: remove our Codex SessionStart entry from `CODEX_DIR/hooks.json`, keeping foreign hooks and
   retaining empty files. Using the manifest, remove our Claude hook entries and status line (restore wrapped one), remove
   managed agent/command files, `claude mcp remove codex --scope user` only if we added it. Keep `QUOTA_BOSS_HOME`
   config and state unless `--force`. Scan all projects.json entries for AGENTS.md markers, including
   entries without managedAgents tracking. With `--scan <dir>`, also search below that root (max depth 6,
   max 5000 entries, symlinks skipped). Remove only marked blocks under the registry lock, preserving
   outside bytes. Report missing tracked projects as "already gone" and skip them. Recommend --scan
   for pre-upgrade installs whose projects may be untracked.
9. `--dry-run`: print the plan, change nothing.

Uninstall: `node install.js --uninstall` (add `--force` to also delete installed config and state).
User-owned project registrations remain available for future installs. Configuration, state, journals and
AGENTS.md reject symlinks and special files; write targets also reject linked parents. Injected helpers
always use the installed absolute home.

## Tests (`test/*.test.js`, `node --test`)

Use temp dirs + the env overrides; never touch the real home. Cover: Codex log parsing (incl. expired windows,
missing data, big files), mode computation, routing (critical picks best, frugal picks cheap, emergency excludes
claude, codex exhausted, workers off), statusline persistence + output, hooks off/on/mode change, quota-boss CLI,
installer merge idempotency + uninstall + preserving unknown settings keys + wrapped status line, sanitizer.

## Hosts and concurrent state

See [HOSTS.md](HOSTS.md) for all adapters and commands. Installed copies include worker instructions
under `QUOTA_BOSS_HOME/agents/` so Codex rules can be generated without the source checkout.
The installer replaces both `{{QUOTA_BOSS_HOME}}` and deprecated `{{HARNESS_HOME}}` in managed markdown.

State writes are read-modify-write transactions under `state.json.lock` (exclusive create, mode 0600).
Each lock contains a PID and random ownership nonce. Retry every 10 ms for about 200 ms using a monotonic
clock; contention returns silently for state hooks. A live PID is never evicted because of elapsed time.
A confirmed dead owner can be recovered by atomically renaming its lock to a unique quarantine name before
deleting it. Recovery is serialised per observed token and rereads that token; acquisition rechecks ownership.
Reclamation claims carry PID/nonce in owner.json. Dead owners or claims older than 10 seconds can be
quarantined and recovered, including old empty orphan claims. Reclaimers check claim ownership before
renaming the lock, and release only their own claim. Release only removes the caller's token. The same protocol protects project, provider, usage and installer
settings transactions. Each state writer rereads inside the lock and merges only owned fields: status line owns
Claude and history.claude; Codex discovery owns history.codex; hooks own their session entries (max 50).

Usage journals compact under their lock once they exceed 256 KiB, retaining every valid record in the longest
supported active UTC window, including Claude's fallback, plus future records. Reads scan bounded 64 KiB
chunks and 1024-character lines, with a 64 MiB journal ceiling; exceeding it reports an error rather than fake
100% consumption. Active records are never dropped just to meet the compaction threshold. Expired records
are removed and reset windows show actual usage, including zero. Outcome reads retain their existing
2 MiB / 2000-record / 90-day limits. Hooks remain silent on all file or lock failures.

## Codex workers (`scripts/codex-run.js`)

All Codex-backed agents (codex-worker, gpt-advisor, reviewer, consensus) call
`node <QUOTA_BOSS_HOME>/scripts/codex-run.js --model <id> --effort <e> --sandbox read-only|workspace-write [--resume <id>]`
with the prompt on stdin. It validates every argument (never `danger-full-access`, never approval bypass), starts
Codex without a shell (npm's JS entry point via the trusted Node binary on Windows), passes
`approval_policy=never`, returns one status line (`ok|FAILED`, model, effort, sandbox, seconds, session id) plus at
most 60 lines of Codex's final message, and appends `{t, model, category, tier, seconds, ok}` to
`QUOTA_BOSS_HOME/runs.jsonl` for latency learning. `--resume` continues the same Codex session (`codex exec resume`).
