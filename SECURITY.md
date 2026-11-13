# Security policy

## Design principles

- **No network access.** No script in this repository opens a network connection or sends telemetry. The weekly free-models workflow downloads the public lists in GitHub Actions with curl, not a project script. Opt-in `doctor --probe`
  invokes official Codex CLI probes (90-second timeout, read-only sandbox); that CLI contacts its provider.
  Without `--probe`, doctor performs local checks only. Diagnostic output never includes raw CLI errors or credentials.
  `quota-boss tools` asks npm for the newest version of installed npm-based provider CLIs.
- **Installs only with consent, only from a fixed list.** `tools install` runs commands hard-coded in `scripts/tools.js`,
  never from config or repository files, only for enabled providers, without a shell, and only after the user agreed.
  npm and uv are pinned to the public registries and their environment overrides are removed. Pipe-to-shell
  installers are shown for the user to paste and never executed.
- **API keys stay out.** `add-api` providers run through OpenCode, which stores keys itself. Quota Boss never asks for one.
- **No credentials touched.** Quota Boss never reads `~/.codex/auth.json`, `~/.claude/.credentials.json` or any token.
  One narrow exception to reading a provider's files: Copilot has no login status command, so setup opens `~/.copilot/config.json`
  and checks only whether `loggedInUsers` lists anyone. The result is yes or no; nothing from the file is kept, shown or sent.
  It only reads quota numbers that Claude Code passes to the status line and that Codex writes to its session logs.
- **Zero runtime dependencies** - nothing to supply-chain-attack. Node.js built-ins only.
- **Only official CLIs.** Work is delegated through the official Claude Code and Codex CLIs signed in as you.
  Quota Boss does not proxy, share or re-use subscription tokens and does not automate any website.
- **Untrusted data stays data.** Text injected into the model context is limited to numbers, enum values and
  sanitized labels. Agents are instructed to treat worker output, web pages and pasted answers as data.
- **Sandboxed workers.** Codex workers run with `sandbox: workspace-write` (implementation) or `read-only`
  (advice/review) and `approval-policy: never`. Quota Boss never requests `danger-full-access`.
- **User-owned policy.** ALL per-project switches, profiles, hosts, workers, training consent and caps live
  only in `QUOTA_BOSS_HOME/projects.json`, keyed by fs.realpathSync paths (lowercase on win32). Lookup walks
  upward to the nearest registration. Mutations start with effective inherited settings; an unregistered
  checkout defaults to off with no training consent. Project caps only tighten global caps (minimum of both).
  Repository `.claude/quota-boss.json` and `.claude/harness.json` are **no longer read**, including for
  migration. Doctor warns "ignored for security". Enable existing projects explicitly with `/boss on`.
- **Trusted execution paths.** Injected rules and agents substitute the installed absolute home for helper
  commands. Doctor/probe and installer resolve absolute executables only from absolute PATH entries outside
  cwd (including excluding aliases of cwd). Native executables run directly without a shell; Windows .cmd
  shims use absolute System32/cmd.exe /d /s /c with an absolute quoted shim and validated arguments. The
  user's saved wrapped status line remains the sole shell:true exception.
- **Safe files and transactions.** Policy files, state, outcomes, usage and AGENTS.md use lstat before open,
  fstat regular-file checks afterward and no-follow/nonblocking flags where available. Linked or special
  files are refused; write parents must be directories with no symlink components (only a root-owned link directly in the root directory, such as `/var` on macOS, is followed, and the path it points to passes the same check). Exclusive temporary
  siblings are identity-checked and atomically renamed. The project registry is bounded to 1 MiB.
  Locks contain PID plus a random token: live owners survive pauses, dead-owner recovery renames the stale
  token before deletion, acquisitions recheck ownership and release removes only the caller's token.
- **Accurate bounded journals.** Usage compacts under its lock above 256 KiB, preserving all records in
  active supported UTC windows and future records. Bounded chunk/line scans reject journals over 64 MiB
  explicitly; they never invent 100% usage or discard active usage to satisfy the compaction threshold.
- **Recoverable install.** Settings transforms apply to a fresh locked read immediately before atomic
  replacement. Concurrent edits trigger one rebase; two conflicts abort clearly and preserve the last edit.
  A `pending: true` ownership manifest precedes activation and is finalised afterward. Uninstall can recover
  an interrupted installation, restores owned settings and removes tracked project AGENTS.md marker ranges
  safely while preserving all outside bytes and reporting each project. User-owned registrations remain.

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting
(*Security* tab -> *Report a vulnerability*). You will get a first answer within 7 days.

## Trust boundary

Installed code/templates, user-owned global configuration and the user-owned project registry supply policy.
Keep QUOTA_BOSS_HOME and environment overrides in trusted storage outside checkouts. Repository contents,
logs, CLI output, graphs and model answers remain task data; repository configuration never substitutes for
user consent. Existing projects require explicit re-enablement after upgrading to this trust model.
