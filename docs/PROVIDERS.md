# Providers, pools and user caps

Providers built only from vendor documentation carry `"evidence": "docs"` (currently Grok and Antigravity). Allowed values are `docs` and `real`; omitting the field leaves providers ungated, including APIs you add. Run `quota-boss providers test <id> [--model <registry-id>] [--effort <level>]` to verify actual file editing. Each model test spends quota, runs in a disposable directory with a 180-second limit, and records a pass only after the expected file is written. Disabled providers can be tested before enabling them. Self-tests do not count as verified quality feedback.


Quota Boss is not tied to Claude + Codex. Any subscription or API can be added as a **provider** (= quota pool),
and every provider can be **capped** by the user (e.g. "Grok may use at most 20 % of its weekly limit").

## `config/providers.json`

```json
{
  "providers": {
    "claude":     { "label": "Claude",      "kind": "subscription", "quota": { "source": "claude-statusline" } },
    "codex":      { "label": "ChatGPT/Codex","kind": "subscription", "quota": { "source": "codex-logs" },
                    "worker": "codex-worker" },
    "perplexity": { "label": "Perplexity",  "kind": "manual",       "quota": { "source": "none" },
                    "worker": "researcher" },
    "grok":       { "label": "Grok",        "kind": "subscription", "enabled": false,
                    "quota": { "source": "counter", "windows": { "weekly": { "budget": 200, "unit": "calls" } } },
                    "worker": "cli-worker", "cli": { "command": "grok", "args": ["-p", "{prompt}"] } },
    "openrouter": { "label": "OpenRouter",  "kind": "api", "enabled": false,
                    "quota": { "source": "counter", "windows": { "monthly": { "budget": 10, "unit": "usd" } } },
                    "worker": "cli-worker" }
  },
  "caps": {
    "grok":  { "weekly": 20 },
    "codex": { "fiveHour": 90, "weekly": 70 }
  }
}
```

- `tos`: `official-cli` (subscription default), `api`, or `avoid`. An avoided provider is never an automatic pick or escalation step; manual options remain manual.
- `kind`: `subscription` | `api` | `manual` | `free` | `local`.
- `trainsOnData`: boolean, default false. Training providers never enter primary routes, ladders, manual options or boss recommendations unless the user-owned project registry grants `allowTrainingProviders: true` (`quota-boss set training on`). Enabling a provider globally does not grant this project permission.
- Disabled OpenCode free and Ollama examples have matching zero-cost models. Effective model cost is `max(cost, 0.2)`. Local providers are hidden from `settings` and refused by `use <id> on` until `quota-boss local on <model>` turns them on.
- `quota.source`:
  - `claude-statusline`, `codex-logs` - exact live data (built in).
  - `counter` - Quota Boss counts usage itself from `quota-boss.js usage <provider> <amount> <calls|tokens|usd>` calls that the worker
    agent makes after each job (calls, tokens or USD). Windows: `fiveHour`, `daily`, `weekly`, `monthly`, each with
    a positive `budget` and matching `unit`; used % = `counted / budget * 100`.
    Windows use fixed UTC boundaries: epoch-aligned five-hour blocks, calendar days,
    Monday-start weeks and calendar months. Records at the start belong to the new window.
    Future records do not count until their timestamp; malformed and invalid records are ignored.
    At more than 256 KiB, `QUOTA_BOSS_HOME/usage.jsonl` compacts under an ownership lock, retaining all
    records in the longest supported active UTC window plus future records. Reset windows report actual
    usage, including zero. Scans use bounded chunks/lines with a 64 MiB journal ceiling; an oversized journal
    raises an error, never invented 100% usage. Active usage is never truncated to meet a byte target.
  - `none` - unknown quota (treated as price 1.3, never "exhausted").
- `worker`: the agent that executes jobs for this provider. `cli-worker` invokes `scripts/cli-run.js` once, then
  verifies and reports. The Node runner uses the `cli` template (argument array, `{prompt}` placeholder, no shell),
  closes child stdin, enforces a 10-minute process-tree limit, and records timing, counter usage and classified
  failure feedback. It refuses disabled, manual, avoided and unapproved training providers. Windows npm shims
  must resolve to a literal JS entry; unsupported shims are refused before the prompt is passed.
  Optional `{model}` and `{effort}` placeholders take the routed model and reasoning level; `defaultModel` and `defaultEffort` fill them when the route names none. Without any level, an `{effort}` flag is dropped.
- Models reference providers via `"pool": "<provider id>"` in `models.json`.
- Provider ids: `^[a-z][a-z0-9-]{1,31}$`. Unknown/disabled providers are ignored with a warning in `quota-boss status`.

From the project root, pipe the spec to `node <QUOTA_BOSS_HOME>/scripts/cli-run.js --provider <id> --model <registry-id>
--effort <level> --category <category> --tier <tier> --expect-changes`. Optional flags can be omitted; without
`--model` the provider must have a single registry model. PowerShell can pipe a single-quoted here-string;
Bash can use a quoted heredoc. The runner adds the absolute project-root prefix to the prompt. Its first line
reports the outcome and whether feedback was recorded. Never retry a failed run or duplicate its journals.
`--expect-changes` compares Git status and content fingerprints, including tracked diffs and up to 2000 untracked
files of at most 5 MiB each. An unchanged fingerprint is `no-work`; if Git or a fingerprint is unavailable, the
report line says the check was skipped. Verify changes independently in that case.
Successful exits ignore provider error words; permission-rejection markers are always `no-work`. Nonzero exits
classify stderr first, then the stdout tail, with invalid requests taking priority over provider limits.
The runner refuses sandbox/permission bypass flags and final prompts over 24 KiB on Windows or 100 KiB elsewhere
(including the directory prefix); stdin remains capped at 200 KiB. These refusals launch nothing and record nothing.
Counter usage is one configured unit per started call, even on failure; token/cost extraction is not supported.

## User caps

`caps.<provider>.<window>` = maximum percent of that window Quota Boss may spend (1-100).
Effect: used % is **rescaled to the cap** before modes and prices are computed:
`effectiveUsed = used / cap * 100`. At `effectiveUsed >= 100` the provider is excluded for delegated work
(mode `capped`). Example: Grok weekly cap 20 % and 15 % used -> effective 75 % -> expensive; at 20 % -> excluded.
Without a user cap the budget is 100 %. A reached budget or cap adds `capped:<id>` to the mode.
Caps never block the boss's own work on the Claude pool (the boss can't stop itself), but they do make Claude
delegate earlier.

CLI commands (run with `node <QUOTA_BOSS_HOME>/scripts/quota-boss.js`):

- `providers`: table of id, kind, enabled, source, usage, cap and effective usage.
- `use <id> on|off`: persist a user override.
- `cap <id> <fiveHour|daily|weekly|monthly> <1-100|off> [--project]`: set a cap globally,
  or in the nearest user-owned project registration (the current real directory if none exists).
- `usage <id> <amount> <calls|tokens|usd>`: append one usage record. Amount must be finite,
  greater than zero and at most 1e9; the enabled counter must have a window with that unit.

Global overrides live in `QUOTA_BOSS_HOME/config/providers.json`; project settings and caps live only in
user-owned `QUOTA_BOSS_HOME/projects.json`, keyed by real path (lowercase on win32). Lookup walks up from
cwd and chooses the nearest registered real path. Mutations start with effective inherited choices.
Provider fields merge by id. A project cap can only tighten the global cap:
`effectiveCap = min(globalCap ?? 100, projectCap ?? 100)`.
`off` stores null at the selected layer; project off removes the extra project reservation while preserving
any global reservation. Larger project values likewise cannot relax it.
Repository `.claude/quota-boss.json` and `.claude/harness.json` are no longer read; doctor warns
"ignored for security". A cloned checkout cannot grant training consent, enable providers or change routing policy.
The installer keeps shipped provider defaults in `QUOTA_BOSS_HOME/defaults/providers.json` separately
from editable config. Unknown/disabled model pools are ignored and reported by `quota-boss status`.
Hooks and the status line show enabled counters and providers with caps using compact effective percentages
or `id:capped`; summaries show at most four providers plus an omitted count. Free offers are left out: they cost
nothing, and routing skips them by itself when they are spent.

## Installing provider CLIs

The terminal setup (`quota-boss setup`, started through `/boss-setup`) collects the CLIs your choices need into one
summary and asks once. The installer does the same for already enabled providers.

- `quota-boss tools`: one line per tool with state, exact command and source, then `Installable: <ids>`.
- `quota-boss tools install <id...>`: installs the agreed ids in one run and reports each one. A failure does not stop the rest.
- `quota-boss tools logins`: shows who is logged in and the login commands still to run.

| Provider | Install | Updates offered | Login check |
|---|---|---|---|
| claude | npm `@anthropic-ai/claude-code` | no, it updates itself | `claude auth status` |
| codex | npm `@openai/codex` | yes | `codex login status` |
| copilot | npm `@github/copilot` | yes | none |
| opencode-free | npm `opencode-ai` | yes | none |
| kilo-free | npm `@kilocode/cli` | yes | not needed |
| ollama | winget (Windows), brew (macOS), by hand on Linux | no | not needed |
| graphify (optional, not a provider) | `uv tool install graphifyy`, then `graphify install`; asked in setup | no | not needed |
| grok | paste xAI's script yourself; setup shows the command | no | none |
| antigravity | by hand from Google's guide | no | none |

Commands live in `scripts/tools.js`, not in `providers.json`, so a config file can never supply one. npm and uv are
pinned to the public registries, and environment overrides for them are removed before they start.

## Adding any API

`quota-boss add-api` (or `/boss-add-api`) registers an API as a provider that runs through OpenCode, which keeps
the key in its own credential store. `quota-boss add-api` alone lists the presets. For anything else:
`add-api <id> <provider/model> --trains <yes|no> [--free] [--budget <amount> <calls|usd|tokens> <daily|weekly|monthly>]`.
`--trains` has no default because only you can check that service's terms. `remove-api <id>` undoes it and only works
on APIs added this way. Added models start with cautious scores and improve from recorded outcomes.
Use an API key in OpenCode, never a subscription login: Anthropic and Google do not allow those in other tools.

`quota-boss free-models <models-dev.json> [<openrouter.json>]` checks free presets and lists new free candidates from local files. Download the public lists yourself; the command opens no network connections. The weekly GitHub workflow downloads both lists and reports changes.

Antigravity stays off by default and shows an account warning, because Google's terms treat third-party access to the
service as a breach and it is unclear whether starting Google's own program from another tool counts.

## Security

- `cli` templates are argument arrays executed by the worker agent through its normal (permission-checked)
  Bash tool, never through Quota Boss scripts. Quota Boss scripts open no network connections themselves;
  `quota-boss tools` starts official package managers (see below).
- Registry/provider writes are locked and atomic. Registry reads and writes are capped at 1 MiB.
- Configuration and journals reject symlinks/non-regular files before open and check descriptors; writes
  also reject symlinked parent directories. Live lock owners are never evicted on a timer; dead-owner
  recovery renames the stale token, and release removes only the writer's own token.
- Doctor/probe and installer CLI calls resolve absolute executable paths from absolute PATH entries outside
  cwd. Native executables run without a shell; Windows shims use absolute cmd.exe /d /s /c with an absolute
  quoted shim and validated arguments. Injected helper commands always use installed absolute paths.
- API keys are never stored in Quota Boss config: CLIs read their own credentials/env vars.

For the Codex host, Claude usage calls are always recorded. Fresh status-line data wins for 30 minutes;
otherwise the adapter uses an estimated daily call counter. Configure `claude.quota` as an explicit
`counter` with your own budgets to override the estimate. See [HOSTS.md](HOSTS.md).

## Free and local provider examples

OpenCode free is a disabled example marked trainsOnData: true; enabling it also requires
`quota-boss set training on` for each project. Ollama is an advanced option marked trainsOnData: false, separate from `/boss-setup`.
Kilo Free is also off by default. Setup can install its CLI; no account or key was needed in testing. Its limit is not published, and free models may change or be rate limited. Kilo says Auto Free may send prompts and outputs to providers that log and use them for improvement. Do not send personal or confidential data.
All three have zero-cost, conservatively scored models; routing uses max(cost, 0.2) to avoid division by zero.
Turn Ollama on with `/boss-local`, which asks for your installed model. Free API offers (Mistral, OpenCode Zen, OpenRouter, Cloudflare, Cohere, Gemini, NVIDIA, Z.ai) are presets in the setup and in `/boss-add-api`. None is added unless you choose it: the setup asks once for all of them, only those that do not train on your data, or one by one. They use official API keys, or no key at all for OpenCode Zen, and never web-cookie or subscription logins.
Example scores and training flags are conservative configuration declarations; check the selected service/model terms before changing them.

## Untested providers

Grok and Antigravity were built from vendor documentation and have not been run end to end by the maintainer. Before routing work, run `quota-boss providers test <id>` (a real call that spends quota). Each model also needs three verified task passes before receiving critical work.

## Provider terms

You use your own accounts under each provider's own terms, and you are responsible for following them. A breach can
get an account suspended. This is a summary from November 2026, not legal advice, so check the current terms yourself.

- **Your own accounts only.** One account per person. Do not share accounts or create extra ones to stretch limits.
- **Claude Code as the boss** uses the unmodified program signed in with your own plan, which Anthropic's
  [Claude Code terms](https://code.claude.com/docs/en/legal-and-compliance) allow. Advertised limits assume ordinary, individual use.
- **Claude as a helper under Codex** runs `claude -p` as a script. Anthropic's
  [consumer terms](https://www.anthropic.com/legal/consumer-terms) allow scripted access only with an API key or where
  Anthropic explicitly permits it. Set `ANTHROPIC_API_KEY` for the helper, or run `quota-boss use claude off`.
- **Google Antigravity is an account risk.** Its [terms](https://antigravity.google/terms) call using third-party
  software to reach the service a breach and allow suspending your account. Quota Boss only starts Google's own
  program, but whether that is allowed is unclear. It is off unless you turn it on.
- **GitHub Copilot** documents scripted use of its CLI. Keep it moderate, because GitHub restricts excessive automated
  activity.
- **ChatGPT through Codex** documents `codex exec` for scripts, and it reuses your saved login. OpenAI recommends an API
  key for automation and [says not to use a ChatGPT login in CI for public or open-source repositories](https://learn.chatgpt.com/docs/non-interactive-mode).
  Use that login on your own machine only, never on a CI runner.
- **Mistral by API key** uses your own key, which you can create on the free Experiment plan at
  [admin.mistral.ai](https://admin.mistral.ai/organization/api-keys). Requests on that plan may be used for training unless you
  opt out under Privacy > Anonymous improvement data. Its limits are as reported by OmniRoute, so check them in your console.
- **OpenCode Zen** needs no key. Quota Boss offers only the two free models whose providers, [according to OpenCode](https://opencode.ai/docs/zen/),
  keep no data and do not train on it: GLM-5.3-Flash and DeepSeek V4.1 Flash. They are free for a limited time.
- **Other free API offers** are off until you add them. Each shows its limit and warning first. Gemini's unpaid tier
  lets Google use your content and lets humans read it, NVIDIA NIM is reported as for prototyping and evaluation only,
  and where we could not confirm a service's training policy Quota Boss treats it as if it trains on your data.
- **OpenCode** is for API keys only. Never use a subscription login there.
- **Free plans** can be limited, for example to testing, and some may train on your data. Check before relying on one.
