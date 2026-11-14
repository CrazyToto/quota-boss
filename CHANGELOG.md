# Changelog

This format follows Keep a Changelog, and the project uses Semantic Versioning.

## [Unreleased]

## [0.1.4] - 2026-11-14

### Fixed

- The session rules again tell the boss to hand work down when the table names a cheaper worker; the 0.1.3 shortening had dropped that instruction. A test now keeps the core delegation sentences in every host's rules.
- Updates now reach `thresholds.json` and the settings help: shipped values live in `defaults/`, `config/thresholds.json` keeps only your own changes (the first update removes, once, the values an older install copied unchanged), and user values replace only their own setting instead of a whole group. No more `.new` files for these two; leftover ones the installer wrote earlier are removed.

## [0.1.3] - 2026-11-14

### Added

- Parallel worker copies with `quota-boss worktree add|list|merge|remove|clean`, runner `--cwd` and optional handover `WORKDIR:`.

- `quota-boss free-models` checks local public model lists for changed free presets and new candidates, with a weekly GitHub check.

- The setup's free-offers question has a **no-key** answer that turns on only the offers without a key or account, and marks the offers that need a key.

### Fixed

- An invalid `config/providers.json` no longer removes the routing table silently: hooks, the status line and `route` fall back to the built-in providers and show a warning. Commands that change provider settings stay strict, so the broken file is never overwritten.
- When the session hook fails with boss mode on, it now prints a warning instead of nothing.
- Worker copies work on Windows when a path uses a short 8.3 folder name, and the session rules are shorter so the routing table still fits with long home paths.

## [0.1.2] - 2026-11-13

### Fixed

- Windows: waiting for a busy lock no longer fails with `EPERM` when the lock file is deleted but still open in another process.
- A code graph built by hand (`graphify update .` or `/graphify .`) now keeps its `graphify-out/` folder out of Git by itself, like the one setup builds.
- The setup wizard tests no longer depend on a `graphify-out/` folder in the working folder.

### Changed

- The release workflow also creates the GitHub release, with the notes from this changelog.

## [0.1.1] - 2026-11-12

### Added

- Codex SessionStart hook attaches routing and limits for enabled Codex projects, with safe user-hook merging and a `/hooks` trust reminder. On Windows the entry also carries `commandWindows`, because Codex runs hooks in PowerShell there.

### Changed

- The status line names the pool a mode belongs to: `mode claude-save` and `mode claude-emergency` instead of `mode save` and `mode emergency`, so a Codex boss no longer reads a Claude limit as its own.

### Fixed

- Windows: taking a lock no longer fails with `EPERM` while another process is still letting go of the deleted lock file; the attempt is repeated for a few milliseconds.

## [0.1.1-rc.0] - 2026-11-12

### Changed

- Releases are published by a GitHub workflow through npm trusted publishing, without a stored npm token. This pre-release is the first one made that way; the package content is the same as 0.1.0.

## [0.1.0] - 2026-11-12

### Changed

- One `set <name> <value>` command replaces `profile`, `terse`, `consensus`, `allow-training`, `workers`, `statusline` and `context <value>`; `use <id> on|off` replaces `providers enable|disable`. The old forms are gone.
- `settings` shows the command that changes each value, and `help` lists the commands by group with one line each.
- `context` shows how large sessions are at their start, because every step reads that part again.

### Added

- Stop a prompt once after an hour or more away from a large Claude Code session, with cheaper options before paying for its expired cache.
- Show project session start sizes and loaded MCP servers, skills, plugins and CLAUDE.md sizes in `quota-boss doctor`.

- `bench/effort.js` measures how the reasoning level changes usage, and the routing table uses measured values for seven models instead of one estimate for all.

- Add `use` and `only` to choose which subscriptions and single models receive delegated work, globally or for one project.
  `only` is a filter, so `only off` brings back the earlier choices.
- Add `verify [--fresh] -- <command...>` to reuse passing test evidence on an unchanged Git revision.
- Gate documentation-only providers behind real file-write self-tests and verified task probation; report readiness in providers and doctor.
- Route tasks across Claude, ChatGPT/Codex and Perplexity subscriptions by task importance, model quality and remaining quota.
- Read live Claude and Codex quota from the Claude status line and Codex session logs.
- Escalate difficult work through a model ladder and learn from verified outcomes.
- Enable routing per project with `/boss on`; unregistered projects stay off.
- Delegate work through Codex and other worker adapters, with a manual Perplexity research handoff.
- Set up providers step by step with `/boss-setup` and add APIs with `/boss-add-api`.
- Choose optional free offers during setup or later; they start off, show limits and data warnings first, and their limits may change.
- Keep API keys in OpenCode for added API providers.
- Enable an installed Ollama model through `/boss-local`.
- Check local setup and provider readiness with `doctor`.
- Install and uninstall with a reversible installer that preserves existing settings.
- Run with Node.js built-ins and zero runtime dependencies.
- Suggest `/compact` inside a task and a handoff between tasks when the context grows large.
- Add the boss on/off benchmark harness in `bench/` with small, medium and mixed tasks and hidden checks (not part of the package).
- Haiku and Sonnet can now do real work through the new `haiku-worker` and `sonnet-worker` agents.
- The boss picks a model for each job, and workers ask it for advice instead of guessing.
- Routing counts the Claude usage of CLI relays, and a failed route escalates one step at a time.
- A Codex boss can hand work to cheaper Codex models through native subagents, each with its own model and reasoning effort.
- Reasoning effort now covers Claude workers and counts toward the cost of a route.
- `opus-worker` takes work that is beyond a boss running on a weaker model.
- Grok, Antigravity and pinned Copilot models have several tiers, and their CLI templates take a model and a reasoning level.
- `self-worker` runs a job on the boss's own model in a separate context, for large or parallel work.
- Setup builds the Graphify code graph locally, without Claude usage, and keeps its output out of Git. A stale graph refreshes in the background at session start.
- A delegation gate prices the handover (spec, waiting turns, report, review, rework) and the boss's own effort, so small jobs stay with the boss; `route --size small|large` re-checks a job.
- Workers get one fixed handover form and answer in at most 10 lines, and they query the code graph with `quota-boss graph explain|affected|path`.
- Other skills, plugins and slash commands keep their own workflow; boss mode only picks who does the work they leave open.
- `quota-boss savings` reports usage per pool, cost units per worker type and job times from local transcripts.
- `doctor` checks what the project's host needs and prints one `Problem: ... Fix: ...` line per issue.
- Install with one `npx` command from the packed tarball.

### Changed

- Each host now reads only its own worker list in the rules.
- The status line and the prompt line say how old the Codex numbers are instead of "codex data stale".
- Limit recent quota pace to a configurable horizon and discount models with thin evidence.
- Suggest a handoff from 100,000 tokens instead of 150,000.
- `consensus off` also removes the consensus instruction from the session rules.
- CRITICAL work gets one counter-review from the other model family, no longer two.
- After a failed worker the boss routes again, and a structural error such as HTTP 422 is never retried on the same model.
- Antigravity runs in auto mode, so it can edit files without a manual settings change.
- Apply a category effort floor and learn effort from verified feedback recorded with `--effort`.
- `route` is read-only, and an unknown boss model maps to the newest registered model of its family with a note.
- Claude and Codex model costs in the registry follow current list prices, and scores use published benchmarks (`docs/MODELS.md`).
- Only the model the boss actually runs on counts as its own work.
- `quota-boss boss` takes the cheaper of two near-equal models and names the best choice on the other host.
- Upgrades keep only your real registry edits, so new prices reach you.
- TRIVIAL and NORMAL worker results are checked by the boss itself, with tests and a read of the diff, also when the worker ran the boss's own model at a lower effort. Only CRITICAL work gets review agents.

### Fixed

- Installation paths behind a system link, such as `/var` on macOS or a linked `/home` on Linux, are accepted.

- Keep the session start under Claude Code's 10,000-character limit for hook output. Above it only a 2 kB preview reached
  the boss, which happened after every `/clear` with a handoff. The routing table and the notes now arrive with the first
  message when they do not fit beside the rules.
- Codex works without Claude Code: the installer points to the terminal setup, the setup asks whether Claude should be a worker, and `on --host codex` turns Claude off when its CLI is missing instead of routing work to it.
- A Codex boss on Windows retries a refused command launch with `cmd.exe` instead of working around the sandbox. On the medium benchmark boss mode went from about 2.1 times the cost of boss off to 1.2 times.
- Doctor resolves OpenCode model templates through their default model.
- `--uninstall --scan` no longer aborts on Windows junctions under Node 18.
- A stale lock recovered right at its deadline no longer drops the update.
- `codex-worker` runs Codex in the foreground, so a job is never handed to a second worker while the first still writes.
