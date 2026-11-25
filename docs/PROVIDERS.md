# Providers, pools and user caps

Providers built only from vendor documentation carry `"evidence": "docs"` (currently Grok, Devin, Antigravity, Junie Lite and JetBrains AI). Allowed values are `docs` and `real`; omitting the field leaves providers ungated, including APIs you add. Run `quota-boss providers test <id> [--model <registry-id>] [--effort <level>]` to verify actual file editing. Each model test spends quota, runs in a disposable directory with a 180-second limit, and records a pass only after the expected file is written. Disabled providers can be tested before enabling them. Self-tests do not count as verified quality feedback.


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
  - `counter` - Quota Boss counts usage itself from `quota-boss.js usage <provider> <amount> <calls|tokens|usd|credits>` calls that the worker
    agent makes after each job (calls, tokens, USD or AI credits). Windows: `fiveHour`, `daily`, `weekly`, `monthly`, each with
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
Bash can use a quoted heredoc. Claude Code asks about (and headless runs deny) a heredoc whose body holds JSON,
so on Claude Code the Quota Boss PreToolUse hook moves the body of exactly this runner form into
`<QUOTA_BOSS_HOME>/prompts/` and runs the same command with `--prompt-file <name>` instead; the normal permission
check still decides, and the runner reads the file once and deletes it. The runner adds the absolute project-root prefix to the prompt. Its first line
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
- `usage <id> <amount> <calls|tokens|usd|credits>`: append one usage record. Amount must be finite,
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
summary and asks once. The installer does the same for already enabled providers. After an update the installer asks
once about each provider the new version added (state.json keeps `knownProviders`); confirming the setup summary marks
every provider it showed as answered.

- `quota-boss tools`: one line per tool with state, exact command and source, then `Installable: <ids>`.
- `quota-boss tools install <id...>`: installs the agreed ids in one run and reports each one. A failure does not stop the rest.
- `quota-boss tools logins`: shows who is logged in and the login commands still to run.

| Provider | Install | Updates offered | Login check |
|---|---|---|---|
| claude | npm `@anthropic-ai/claude-code` | no, it updates itself | `claude auth status` |
| codex | npm `@openai/codex` | yes | `codex login status` |
| copilot | npm `@github/copilot` | yes | none |
| opencode | npm `opencode-ai` | yes | none |
| kilo-free | npm `@kilocode/cli` | yes | not needed |
| ollama | winget (Windows), brew (macOS), by hand on Linux | no | not needed |
| graphify (optional, not a provider) | `uv tool install graphifyy`, then `graphify install`; asked in setup | no | not needed |
| grok | xAI's install script | no | none |
| devin | by hand from docs.devin.ai/cli, then `devin auth login` | no | none |
| antigravity | by hand from Google's guide | no | none |
| junie (junie-lite, jetbrains) | JetBrains' install script | no | Windows: a saved login in the folder `~/.junie/dpapi_credentials`; elsewhere none |

Copilot defaults to 2 parallel CLI runs; set `maxParallel` to 4 on Pro/Pro+ or 8 on Max. Its monthly budget is 200 AI
credits (the Student plan); set `quota.windows.monthly.budget` to 1500 on Pro, 7000 on Pro+ or 20000 on Max.

Commands live in `scripts/tools.js`, not in `providers.json`, so a config file can never supply one. npm and uv are
pinned to the public registries, and environment overrides for them are removed before they start.

## Adding any API

`quota-boss add-api` (or `/boss-add-api`) registers an API as a provider that runs through OpenCode, which keeps
the key in its own credential store. `quota-boss add-api` alone lists the presets. For anything else:
`add-api <id> <provider/model> --trains <yes|no> [--free] [--budget <amount> <calls|usd|tokens> <daily|weekly|monthly>]`.
`--trains` has no default because only you can check that service's terms. `remove-api <id>` undoes it and only works
on APIs added this way. Added models start with cautious scores and improve from recorded outcomes.
Use an API key in OpenCode, never a subscription login: Anthropic and Google do not allow those in other tools.

The maintainer tool `node tools/free-models.js <models-dev.json> [<openrouter.json>]` checks free presets and lists new free candidates from local files. It opens no network connections. The weekly GitHub workflow downloads both lists and reports changes.

## Junie Lite and JetBrains AI

Both run JetBrains' official [Junie CLI](https://junie.jetbrains.com/docs/junie-headless.html) headless, with the task
on stdin (`--input-format=text`), never in argv. On Windows Quota Boss starts the native `junie.exe` that the
`junie.bat` launcher would start (version from `<data>/current`, data folder `JUNIE_DATA_DIR` or
`%USERPROFILE%\.local\share\junie`, path checked to stay inside it) and sets `JUNIE_DATA` and `EJ_RUNNER_PWD` like the
launcher does. Choose "Continue with JetBrains account" in Junie to log in. Activation starts Junie and waits up to
five minutes on Windows for its saved login. The CLI's "Cannot find authorization" message is reported as unavailable.

- **junie-lite** is JetBrains' free [Junie Lite](https://junie.jetbrains.com/blog/junie-lite/) tier: only a JetBrains
  account and no published request limit. Its [docs](https://junie.jetbrains.com/docs/junie-lite.html) say it does
  not expire; the announcement says the offer is valid until 31 Dec 2026, inference stays on JetBrains' servers and
  is not used to train the model. When the model is busy Junie retries for about 5 minutes and then exits with code 1, with no fallback. The
  model behind it changes without notice: the docs name OpenAI GPT-6 Luna, the announcement Qwen 3.6 27B, and test
  runs on 2026-11-19 and 2026-11-22 used Qwen 3.6 27B. Every call passes `--model=junie-lite`, because the
  account default model uses paid credits.
  Setup turns it on by default unless you turned it off before (`quota-boss use junie-lite off`).
- **jetbrains** uses a JetBrains AI Pro or Ultimate plan, which is included for verified GitHub Education students.
  Models are chosen with `--model`; only `jetbrains-gpt-6-luna` is on by default.
- Junie runs with `--output-format=json` and `--skip-update-check`. cli-run adds `--json-output-file` with a private
  temp file, which it reads and deletes: request errors appear only there (stdout shows the readable answer). A refused
  license (code 492, "Untrusted license") counts as unavailable, a limit as limited, and the report line shows the
  tokens and the model Junie really ran (`ran Qwen/...`). A plan that Junie does not accept for paid models fails the
  self-test with "JetBrains license not accepted for this model"; Junie Lite works without it.
- Headless Junie trusts the project folder by itself and loads its MCP servers, hooks and skills.

## Devin

Devin runs Cognition's official [Devin CLI](https://docs.devin.ai/cli) in print mode (`devin -p`), always with
`--model swe-2-flash-medium`: SWE-2 Flash Medium is the only model `devin models list` marks as free, every other one
bills per token. `--permission-mode accept-edits` lets it edit files; it refuses shell commands in print mode, so it
cannot run tests itself and the boss's check matters more. `--respect-workspace-trust false` skips the trust prompt
that print mode cannot show. It prints plain text with no usage, and there is no CLI quota command (only `/usage` in
a session and the web dashboard), so the status line has no Devin numbers.

- Data: on the free plan Cognition may use your data to train its models, and only paid plans can opt out, so the
  preset says it trains on data and Devin gets no work until you allow that (`quota-boss set training on`).
- Terms: Cognition's terms forbid using the service to build competing products or train competing models. Quota Boss
  only starts the official CLI on your own coding tasks.
- Quality (solo bench 2026-11-25, see [Benchmarks](BENCHMARKS.md)): about the level of Junie Lite. In 3 of 24 runs the
  CLI kept running for 24 to 30 minutes after it had written the work; cli-run stops a worker after 10 minutes, so
  such a job reports a timeout and the boss checks what was written.

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
Kilo Free is also off by default. Setup can install its CLI; no account or key was needed in testing. Kilo allows 200 anonymous free requests per hour per IP address. Free models may change. See [Kilo Gateway authentication](https://kilo.ai/docs/gateway/authentication). Kilo says Auto Free may send prompts and outputs to providers that log and use them for improvement. Do not send personal or confidential data.
All three have zero-cost, conservatively scored models; routing uses max(cost, 0.2) to avoid division by zero.
Turn Ollama on with `/boss-local`, which asks for your installed model. Free API offers (OpenCode Zen, OpenRouter, Cloudflare, Cohere, Gemini, NVIDIA, Z.ai) are presets in the setup and in `/boss-add-api`. None is added unless you choose it: setup can add all offers except NVIDIA at once, add only those that do not train on your data, or let you choose one by one. NVIDIA's trial terms allow evaluation only, with no production use or confidential code. They use official API keys, or no key at all for OpenCode Zen, and never web-cookie or subscription logins.
Example scores and training flags are conservative configuration declarations; check the selected service/model terms before changing them.

## Untested providers

Turning on a paid docs-only provider in a terminal runs its self-test after install and login. Each test spends quota.
A free or local one runs none: its first real trivial jobs are the test, and a failed one closes its trial and hands the job back.
`use <id> on --no-test` only switches it on. Without a terminal, `use <id> on` prints how to finish in a terminal.
A pass is bound to that model and the CLI's resolved path, size and modification time. CLI changes require another test.

Paid docs-only models can do trivial work after the self-test. Normal work needs three verified trivial-or-higher passes; free and local routes need one (`freeProbationPasses`). Critical work needs three verified normal-or-critical passes and registry scores as public evidence; this critical gate also applies to every pool except Claude and Codex. `probationPasses` changes the required count.

## Capabilities

`route --needs image,pdf --context 100000` filters every option, including fallback models. Inputs are `text`, `image`, `pdf`, `video` and `audio`; tools are `image-gen` and `web-search`. Unknown capabilities fail the filter. Model `inputs`/`tools` and worker support must both allow a need; `text` always works. CLI workers declare their handover support in `cli.inputs` and `cli.tools` (default: text only), and a template may take one `{input}` argument that `cli-run --input <file|YouTube URL>` fills (a YouTube link, or a regular file inside the working directory of a type the provider declares, at most 14 MiB; hidden files such as `.env` or `.git/*` are refused). `contextTokens` holds the documented context size; a model without it fails any `--context` need. A model with `specialist: true` only routes when the job needs one of its non-text inputs. `route --explain` lists what each route can actually accept.

Shipped: Claude and Codex workers read images (Claude also PDFs); Codex workers generate images with `$imagegen` (gpt-image-2, which counts 3-5 times a normal turn on the ChatGPT plan) and search the web with `--search live`; Claude self, `researcher`, `gpt-advisor` and Antigravity search the web. Only the free `gemini-media` route (Google's official `gemini-api` CLI with an AI Studio key, Gemini 3.8 Flash, off by default) takes video, audio and YouTube links. It takes one file per job. Its free tier trains on your data (outside the EEA, the UK and Switzerland) and has no image model and no Google Search. Use an AI Studio key from a project without billing: with billing on, Google charges per token although Quota Boss counts the route as free. Models without a documented context size never match `--context`.

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
  activity. Since 2026-06-01 every Copilot request is billed in AI Credits from your plan; Copilot Free and Student
  offer only `auto`. Each worker run gets its own session id, and Quota Boss books the AI credits that session's
  events file reports (`~/.copilot/session-state/<id>/events.jsonl`; about 5-10 credits per worker job, 0.1-0.4 for a
  one-line reply). Copilot used outside Quota Boss is not counted, so the number can be lower than GitHub's meter.
  Every run is capped with `--max-ai-credits 30`, the lowest cap the CLI accepts.
  Workers run with `--disable-builtin-mcps`: the built-in GitHub MCP server adds about 1.1k input tokens to every call
  (14.9k vs 13.8k on GPT-5.6 Luna, 2026-11-23), and a worker edits local files only.
- **ChatGPT through Codex** documents `codex exec` for scripts, and it reuses your saved login. OpenAI recommends an API
  key for automation and [says not to use a ChatGPT login in CI for public or open-source repositories](https://learn.chatgpt.com/docs/non-interactive-mode).
  Use that login on your own machine only, never on a CI runner.
- **Mistral by API key** requires billing activation and pay-as-you-go. Add it as a custom API with OpenCode. See [Mistral usage and limits](https://docs.mistral.ai/admin/billing-usage/usage-limits#plan-usage-and-limits).
- **OpenCode Zen** needs no key. Quota Boss offers only the two free models whose providers, [according to OpenCode](https://opencode.ai/docs/zen/),
  keep no data and do not train on it. Only DeepSeek V4.1 Flash is left, because OpenCode retired the free GLM model. It is free for a limited time.
- **OpenRouter Free** models have a 50-call daily cap, with a higher daily cap after $10 of credits. One OpenCode run
  sends about 5 API requests, so the local counter budgets 10 runs a day (Cohere: 200 runs for 1,000 calls a month).
  When OpenRouter answers "free-models-per-day" anyway, the route pauses until 00:00 UTC.
- **Other free API offers** are off until you add them. Each shows its limit and warning first. Gemini's unpaid tier
  is not used to train for users in the EEA, UK or Switzerland. Elsewhere Google may use content to improve products
  and humans may read it. NVIDIA NIM trial terms allow evaluation only, with no production use or confidential code.
  Cohere trial keys are not for production or commercial use. Z.ai's terms say developer API content is not used for
  training without agreement. Where we could not confirm a service's training policy Quota Boss treats it as if it
  trains on your data.
  The one exception is Junie Lite and JetBrains AI, by the user's decision, so the free tier works out of the box:
  they are marked trainsOnData: false, although JetBrains' docs do not say whether Junie CLI data is used for training.
  JetBrains' [product data collection FAQ](https://www.jetbrains.com/legal/docs/terms/product_data_collection_faq/)
  says detailed code-related data sharing is on by default for non-commercial licenses (free accounts, likely student
  licenses too). Turn it off in a JetBrains IDE under Settings | Appearance & Behavior | System Settings | Data Sharing.
- **OpenCode** is for API keys only. Never use a subscription login there.
- **Free plans** can be limited, for example to testing, and some may train on your data. Check before relying on one.

## Send a provider report

Run `quota-boss providers report <id>` with your signed-in provider CLI.
Use `--model <registry-id>` to test one model. The self-test and coding task each make a CLI call that can count against your limit.
Open the issue link, name your plan, and paste or attach `quota-boss-report-<id>.md`.
