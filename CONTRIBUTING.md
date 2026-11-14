# Contributing

Thanks for helping! The most valuable contributions right now:

1. **Model scores** - `config/models.json` holds opinionated defaults. If your experience differs, open a PR
   with the change and a short justification (task type, what went better/worse). Run
   `node "<QUOTA_BOSS_HOME>/scripts/quota-boss.js" route --explain` to see the effect.
2. **New workers** - Gemini CLI, local models via Ollama, other official CLIs that work with a subscription.
   A worker = an agent file in `agents/`, a pool in `models.json`, and (if it has a quota) a reader in `scripts/lib.js`.
3. **Routing ideas** - see `docs/ROUTING.md`. Please include a test that shows the behaviour change.
4. **Bug reports** - include OS, Node version, `claude --version`, `codex --version` and `node "<QUOTA_BOSS_HOME>/scripts/quota-boss.js" status`.

## Ground rules

- Zero runtime dependencies, Node >= 18 built-ins only. No network calls. No reading of credential files.
- Hooks and the status line must never crash or slow down Claude Code: fail silent, keep them fast.
- Never automate websites or re-use subscription tokens outside their official CLI - this project stays within the
  providers' terms of use.
- `npm test` must pass on Windows, macOS and Linux (CI checks this).
- Keep text that is injected into the model context short - every token is paid for on every prompt.

Host adapters and local diagnostics are specified in [docs/HOSTS.md](docs/HOSTS.md). Add fixture-based
tests for new output formats; keep doctor tests on fake CLI responses and reserve quota probes for explicit `--probe`.

## Changelog entries

Record each change with `node tools/release.js add patch Fixed "Describe the change."`.
Choose patch, minor or major and a Keep a Changelog section; commit the generated `.changeset/*.md`.
Use `node tools/release.js status` to preview the next version and `node tools/release.js version --dry-run`
to preview release notes. Run `node tools/release.js version` to prepare the release.
