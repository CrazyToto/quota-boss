# Changelog

This format follows Keep a Changelog, and the project uses Semantic Versioning.

## [Unreleased]

## [0.5.1] - 2026-11-28

### Added

- One `quota-boss` command for everything. The installer puts a small launcher into a folder of your home that is already on PATH, and it always runs the installed copy. `quota-boss update` installs the newest version, `quota-boss uninstall` removes everything, the launcher included.

### Fixed

- Without the global command, setup and other hints told you to run `quota-boss config`, which then failed with "not recognized". Hints now name the command that works on your machine.
- An old `npm install -g quota-boss` copy no longer runs an older version than the installed one: updates remove it, and `npx quota-boss <command>` runs the installed copy.

## [0.5.0] - 2026-11-28

### Added

- A rewritten setup: Look, Work, Providers and Finish pages in the keyboard list, with a live status line preview. `setup --update` asks only about what changed, the installer starts the setup by itself in a terminal, and `quota-boss config` shows every setting in one list to change in place.
- Claude Sonnet 4.6 through Antigravity (`antigravity-claude-sonnet-4-6`). A model with `efforts: []` keeps its bare name in a `{model}-{effort}` slug, since Antigravity's Claude models take no level. Bench results for it and GPT-OSS 120B are in docs/BENCHMARKS.md.
- `plans: ["paid"]` in config/models.json keeps a model off on a free or unknown plan. Devin SWE-2 now needs a paid plan: free accounts get "Upgrade to Pro", although `devin models list` shows it without a price.

- Provider models follow the account's plan by themselves, as Codex and Claude do. At setup, once a day in the background and after an update, Quota Boss asks Devin (`devin auth status` for the plan, `devin models list`) and Antigravity (`agy models`) what the account has. Models the account lists without a price go on and models it lacks go off. A Devin model shown with a price stays off on every plan, because Devin reports no usage that could stop it before billing beyond the allowance; `quota-boss use <model-id> on` turns it on. Setup lists what it set. A manual `quota-boss use <model-id> on|off` always wins.
- Kilo (`kilo models kilo --verbose`) and Codex (`codex debug models`) also report which models the account offers. For Kilo, only models marked free count as included; zero-price routers like `kilo-auto/frontier` bill the model they pick and stay off. Codex is report-only and never switches a model. The model report and setup now name new models the account offers that the table does not route yet, split into included and priced, and leave out other effort variants of models already in the table.
- Gemini 4 Neon (paid Google AI Pro and Ultra) and Gemini 4 Carbon (Ultra only) in Antigravity. Both ship off and turn on by themselves once `agy models` lists them for your account.
- The weekly free-models check also lists recent models on models.dev that the routing table does not have yet. `bench/run.js --host agy` benchmarks Antigravity models. A bench run stopped by a provider limit is marked `limited` and left out of the report.
- `quota-boss providers models <id>` asks Devin or Antigravity which models your account offers and shows which are routed, which you can turn on, and which the table names but your account lacks.
- Paid-plan models that ship off: Devin SWE-2.1, SWE-2, Claude Opus 5.5, Claude Sonnet 5.5 and GPT-6.2-Sol through Devin, and Gemini 4 Hydrogen in Antigravity. Turn one on with `quota-boss use <model-id> on` if your plan includes it.
- The NVIDIA NIM offer also adds GLM 5.3 Flash (`nvidia-glm`), which NVIDIA's trial serves at no cost. Its scores are cautious until a bench run.
- How to use an OpenCode Go plan, in docs/PROVIDERS.md.
- A new status line look. The default `minimal` style shows a coloured bar per pool: `✻ Claude ━━━━━━━━━━ 34% ↻00:50  wk 43%    ⌬ Codex ━━━━━━━━━━ 10%  wk 2%    ● boss  ◔ 100k`. `set statusline-style rounded` puts the bars in soft pills with round ends (needs a Nerd Font), and `classic` keeps the old compact line. `set statusline-logos on|off` and `set statusline-names on|off` show or hide the symbols and names. The minimal and rounded styles leave out the extra provider counters, and a small pie shows how full the context is.
- Devin (Cognition) as a free provider through its official Devin CLI, off by default. By default it uses SWE-2 Flash Medium, the only free Devin model; the other Devin models bill per token and ship off. Setup asks about it, shows the official install command and starts `devin auth login`; `tools` checks the login with `devin auth status`. It runs with `--permission-mode accept-edits`, so it edits files but cannot run shell commands. The status line does not show Devin usage yet.

### Fixed

- Windows installs of provider CLIs get past Defender: vendor scripts are saved to a private temp folder and run with `-File` instead of `irm <url> | iex`, and Windows PowerShell no longer inherits PowerShell 7's module path.
- The Junie and Antigravity login windows close by themselves once the login is saved.
- The self-test checks for limits first, so Antigravity's "--mode auto is not available" warning no longer hides a 429 quota error.
- Kilo and OpenCode run again on Windows. Their npm shims start an extensionless Node script and a native .exe, and Quota Boss now reads both from the shim as data: only the one launched path inside the shim's own node_modules counts, never a link, a `..` or a PowerShell shim. A CLI it cannot start counts as not installed, and an update of the launched file makes an old self-test stale.
- The consensus second opinion is offered only when the codex binary is installed.
- `quota-boss use <model-id> on` now turns on a model that ships off; before, it had to be copied into your `config/models.json` by hand.
- Devin: a missing login now counts as "not logged in" and a usage limit as a provider limit, even when the CLI exits 0; a monthly limit pauses Devin until the 1st of the next month. Devin is also stopped once it has changed files and the work tree then stays the same for 5 minutes, because it could keep running for half an hour after the work was written (`cli.settleMinutes`).
- A setting for a provider that this version does not know, for example `use devin on` saved by a newer copy, no longer stops every command with "Invalid provider kind". It is skipped, and `status` shows a warning to update.
- Setup now asks about Gemini media, so its `gemini-api` program is installed when you turn it on, and it counts as an offer that may train on your data. Before, setup never mentioned it.
- The Gemini media login opens `gemini-api configure --interactive` instead of only printing the program's help.

### Changed

- Boss mode settings count for every project: `on`, `off` and `set profile|training|context` apply everywhere, and setup saves its choices for all projects. Add `--project` for one project only. Codex as the assistant stays per project, because its rules live in that project's AGENTS.md. A project override keeps only what you changed there.
- The uninstaller asks in a terminal whether to delete your settings too (with --force they always go, even without an install record), and asks about each program Quota Boss installed itself. Programs you already had, such as Graphify, are never offered for removal. It also names the command that removes the global `quota-boss` command.
- `/handoff` notes keep your own requirements word for word, quote the last failing command exactly, add no new work and stay under about 1200 words.

## [0.4.9] - 2026-11-24

### Changed

- One cheap retry before escalating: when a Codex worker's check fails after in-scope changes, the worker resumes its own Codex session once with only the failing check output, instead of starting the job again on a stronger model. It reports `RECOVERY: resumed`; a second failure escalates as before.

## [0.4.8] - 2026-11-23

### Added

- `providers report` adds a local history table per model: successful runs in the last 30 days with p50 and p95 seconds, pass/fail/limited/unavailable counts, retries per pass and failure kinds. It reads the local logs and makes no extra provider call.
- Capability routing: `route --needs` also takes `video`, `audio`, `image-gen` and `web-search`, and the shipped models carry their documented context sizes for `--context`. Codex workers take image generation (`$imagegen`) and live web search (`--search live`). The new free `gemini-media` route (Google's official `gemini-api` CLI, off by default) is the only one for video, audio and YouTube links; `cli-run --input <file|YouTube URL>` hands it the file. Specialist models such as this one only take jobs that need them.

## [0.4.7] - 2026-11-23

### Added

- `savings --details` shows the prompt cache hit rate and output share per pool (reasoning share for Codex), and the
  median size of a worker's first request, so startup cost and cache misses show up.

### Changed

- Copilot counts AI credits instead of launches. Each worker run reads the credits its session used from Copilot's own
  session file (5 when the file is missing), against a 200-credit monthly budget (the Student plan; see
  docs/PROVIDERS.md for Pro, Pro+ and Max). Every run is capped at 30 credits with `--max-ai-credits`.

### Fixed

- `npm test` runs the same test files as CI and no longer runs test fixtures as tests.

## [0.4.6] - 2026-11-23

### Fixed

- 0.4.5 was not published to npm: one test failed outside Windows. 0.4.6 ships the same changes, and the test now runs on every platform.

## [0.4.5] - 2026-11-23

### Added

- `savings --details` lists Claude boss sessions that kept large work (5+ files written whole or 200+ changed lines)
  without starting a worker, and whether the boss checked `route` first, so a delegation regression shows up.

- `cli-run` caps parallel runs per provider (`maxParallel`). Copilot defaults to 2, as GitHub allows on Free and
  Education; set 4 on Pro or Pro+ and 8 on Max.

- Quota that the longest window would leave unused near its reset counts as nearly free, so routing uses it first.
  It only relaxes the gate when the worker is about as likely to pass as the boss.

### Changed

- Every failed outcome carries a kind (`quota`, `outage`, `structural`, `timeout`, `context`, `not-run`). Only a
  failed check lowers a model's quality score; a limit or a job that never reached the model does not.

- Worker reports clip CLI output to 6,000 characters (the first three quarters and the last quarter).

- Relay agents run the runner command as their first call. A runner heredoc whose body holds JSON is saved to a prompt
  file by the hook, because Claude Code denied those commands even when `node` was allowed.

- The OpenRouter free preset uses Flint v1.0 free; North Mini Code free is gone from OpenRouter.

- Offer notes: Z.ai does not train on developer API content, NVIDIA's trial allows evaluation only and is left out of
  "add all free offers", Cohere trial keys are not for production, and Gemini's free tier does not train for EEA, UK
  and Swiss users.

- Routing pauses a model after quota, outage or timeout failures for longer each time in a row (15 minutes for quota, 5 for
  outages, up to 6 hours), or until the reset time the provider names, such as OpenRouter's free daily limit at 00:00 UTC.
  A quota limit with a reset time pauses the whole pool. After a pause one run probes the model before others use it again.

- On a near tie the model that last passed the same job keeps it.

- `cli-run` records provider limits as `fail` with kind `quota` or `outage`, and `feedback` takes `--until <ISO time>`.

- The boss sizes a task with all its parts, chores included: about 5 new or rewritten files or 200 changed lines makes
  it large and sends it to its `[large:...]` route. In saving mode this cut Claude use on mixed and medium tasks by 11%.

- Copilot workers run without the built-in GitHub MCP server, which saves about 1.1k input tokens (7%) per call.

### Fixed

- OpenCode workers edit the folder they run in. An inherited `PWD` sent their edits to the folder Quota Boss was
  started from, so OpenCode self-tests failed with "work was not done" and a worktree worker edited the main checkout.

- `verify --log` now records a pass it reuses when no earlier run logged it, such as a worker's check. Before, the boss
  lost that feedback or ran the tests again with `--fresh` only to log it, which cost an extra turn.

- The OpenRouter free and Cohere trial presets budget runs, not API requests: one OpenCode run sends about 5 requests,
  so the counter showed 18% when OpenRouter's 50 daily requests were gone. New budgets: 10 runs a day and 200 runs a
  month. An existing setup keeps its budget; change it in `config/providers.json` or add the preset again.

## [0.4.4] - 2026-11-20

### Added

- `quota-boss --help` and `-h` print the command list and exit with code 0.
- Routing rows for a free trial end in `[trial: run route first]`, so the boss refreshes the table before the next job.

### Changed

- Free and local providers (such as Junie Lite) need no self-test: their first real trivial jobs are the test,
  and setup, `use <id> on` and the update offer spend no call on one. One verified pass opens normal work for them
  (`freeProbationPasses`, default 1); critical work still needs three verified normal passes. A free route that failed
  in a category takes work there again only through a new trial.
- Job size counts changed lines and files, not tool turns: do an edit yourself when it changes about 30 lines or fewer;
  a clearly large job goes to the `[large:...]` worker. Read-only jobs are sized by what they must read. CRITICAL work
  never takes the small-job shortcut.

### Fixed

- Free trials stay closed after a route used its trial jobs or failed one, also after old results leave the rolling
  history: a lasting count lives in `state.json`. For an hour after a failed trial, trivial work goes back to the route
  that would have won without trials, not to another unproven free route.
- A trial on a paid docs-only provider needs a passed self-test on the same installed CLI version.
- A CLI worker whose executable is missing, or whose provider has no CLI template, never wins a route.
- The worker gate falls back to a short pointer when the rules would pass the 10,000-character hook limit on a long
  install path.
- A deferred routing table is delivered only to the session that deferred it.
- `providers report` skips the coding call after a limit, timeout or missing login in the self-test, and a rate limit
  pauses the model for 15 minutes.
- Junie: a stale `EJ_RUNNER_PWD` from an earlier launch no longer points Junie at the old project.
- Docs and website: examples name the current default models (GPT-6.2-Sol), absolute README links, probation per tier, worktree output, Codex limits and network wording.

## [0.4.3] - 2026-11-19

### Fixed

- A free or local route now needs three verified passes before it gets normal work, like a docs-only provider. Before, a
  new free API could win normal work on its registry scores alone.
- `/boss add-api` installs OpenCode with `tools install opencode`; the old `opencode-free` id no longer exists.
- Docs: the Copilot limit is a local launch count (GitHub bills AI Credits since 2026-06-01), OpenCode Zen offers only
  DeepSeek, outdated routing algorithm and Mistral notes removed.

### Removed

- Retired routes (Zen GLM, Mistral, including old `-m` and `mistral` pool forms) are dropped when providers load, and
  `quota-boss remove-api` can delete them.
- The inert built-in `openrouter` pool, the unpinned OpenCode free example and dead threshold keys.
- Tests, `.github`, CONTRIBUTING and unused templates from the npm package (207 -> 74 files).

## [0.4.2] - 2026-11-19

### Added

- Free trials: on trivial work an untested free route takes the job when it is within 0.15 of the route that would win otherwise, so free offers can prove themselves. Per category a route gets at most 3 trial jobs and none after a logged fail there; the least tried goes first, and the route that would have won is the next ladder step.

### Fixed

- Worker instructions say to start the run command with `node` and pass `--cwd` instead of `cd <dir> &&`: permission rules do not match a chained heredoc, so the call was denied in headless runs and asked for permission in interactive ones.

### Removed

- The Mistral free preset: Mistral ended free API access (API keys now need billing and pay-as-you-go). Setup and the session start offer to remove a Mistral free entry you added. Mistral still works as a paid custom API.

## [0.4.1] - 2026-11-19

### Fixed

- The 0.4.0 tag did not reach npm because a Linux and macOS install test still expected the old download command. 0.4.1 is the same release with that test fixed.

## [0.4.0] - 2026-11-19

### Added

- `quota-boss providers report <id>`: runs the self-test and one small coding task with hidden checks for each model of a provider, saves a redacted Markdown report and offers to open a prefilled GitHub issue, so people with plans the maintainer lacks can send real numbers for the routing table.

### Changed

- Free first: outside CRITICAL work, a free route (a free or local provider at cost 0) takes a job from a paid worker when it is about as likely to succeed (within 0.02, or 0.05 while that worker's pool is tight). Normal work goes free only after the free route has 3 verified passes; trivial work goes free at once. The boss doing a job itself is never replaced, and the paid worker stays the next ladder step.

- One yes turns a provider on completely. The update question, setup and `quota-boss use <id> on` in a terminal install the official CLI (vendor install scripts too, with the command shown first), start the login in its own window, wait up to 5 minutes for it and run the self-test. A bare `use <id> on` asks once more before running a vendor install script. Outside a terminal, `use` only switches the provider and says how to finish.

- After an update, every Claude Code session start asks about new providers until you answer, also after `/clear` or a compaction. The boss asks you one yes/no question and records either answer.

- Kilo Free's limit is now named: 200 anonymous requests per hour per IP address, from Kilo's gateway docs.

- The models.dev audit (`tools/free-models.js`) marks a preset whose model is deprecated as `retired`, and lists only Zen models that are not deprecated and support tool calls.

### Removed

- The OpenCode Zen GLM preset (`zen-glm`). OpenCode retired the free GLM-5.3-Flash model on 2026-11-18. If you added it, setup removes it and a session start suggests `quota-boss remove-api zen-glm`. OpenCode Zen DeepSeek stays.

- The `JUNIE_API_KEY` note in the provider texts. Junie still never sees an inherited key.

## [0.3.1] - 2026-11-19

### Changed

- The Codex `AGENTS.md` block holds only the short boot lines, as on Claude Code. A Codex boss runs `quota-boss rules --host codex` before its first delegation, review or CRITICAL change. With the full rules in every turn, boss on cost 25-35% more than boss off.

- A model with no score for a category takes the score of its newest rated predecessor in the same pool and family. An unrated new release was never routed, so it could never earn a score; now it is used first, and logged failures or a benched score bring the predecessor back.

### Fixed

- Routing kept GPT-6.1-Sol for research once it had logged passes, although the equally rated GPT-6.2-Sol is available. A newer model of the same family rated at least as high now replaces its predecessor in every row; the running boss model stays. The predecessor comes back only when the successor's own logged failures pull it below its starting value and the predecessor is more likely to pass; passes of the predecessor alone never keep it. A successor below the minimum success rate does not push out a predecessor above it, and a successor that is replaced itself cannot push out an older model. The second opinion follows the same rule.

## [0.3.0] - 2026-11-19

### Added

- Junie Lite (`junie-lite`), JetBrains' free tier with no published limit, and JetBrains AI (`jetbrains`) as providers through the official Junie CLI. You log in once with your JetBrains account in `junie`, which setup starts; a `JUNIE_API_KEY` token is not used because it bills paid credits. The task goes on stdin, Windows starts the native `junie.exe` instead of its `.bat` launcher, and setup turns Junie Lite on by default unless you turned it off before. Junie's "not logged in" message exits with code 0, so cli-run reports it as unavailable. Setup and the update question turn a provider like this on first and run its self-test after the login; Junie never sees an inherited `JUNIE_API_KEY` or `JUNIE_PROJECT`. Both are marked as not training on your data by the user's decision; see docs/PROVIDERS.md for JetBrains' data sharing default.

- GPT-6.2-Sol and GPT-6.2-Astra (efforts low to xhigh). GPT-6.2-Sol has GPT-6.1-Sol's price; GPT-6.2-Astra costs 20 instead of GPT-6-Astra's 32. Until outcomes are logged, their scores are those of the predecessors, because public benchmarks are mixed. Routing skips a Codex model that your Codex CLI's model cache does not list while it lists others of the same family, so an older Codex keeps the older models. Agent defaults and the JetBrains GPT-Sol entry move to GPT-6.2-Sol; Copilot entries stay unchanged.

- `doctor` names a model in your Codex model cache that is newer than every configured model of its family. It only informs and never changes config.

- After an update the installer asks once about each provider the new version added (Junie Lite defaults to yes) and runs `use <id> on` for a yes; a no to Junie Lite is saved as off. Without a terminal it prints one line pointing to `quota-boss setup`, and the session start shows a suggestion until you answer. Providers you turned on or off before are never asked about.

- The session start suggests `quota-boss providers test <id>` for a provider that is on and installed but has not passed its self-test, since routing gives it no work until then.

### Fixed

- A CLI template with an inline `--model={model}` directly before `--effort={effort}` lost its model flag when no effort was given, so `jetbrains` calls without `--effort` failed with "cannot select a model".

- The second opinion for critical architecture picked GPT-6.1-Sol over the equally rated GPT-6.2-Sol once 6.1 had logged passes. A newer model of the same family rated at least as high now replaces its predecessor there.

### Changed

- Junie runs with JSON output and without its update check. cli-run reads Junie's JSON result from a temp file: a refused JetBrains license (code 492) is reported as unavailable instead of "exit 1", limits as limited, and the report shows the tokens and the model Junie really ran. The self-test names a refused license too.

- On a full routing tie the newer model of the same family wins, so an equally rated successor replaces its predecessor.

## [0.2.1] - 2026-11-17

### Fixed

- 0.2.0 was tagged but never published because two tests failed in CI (a Windows-only test on Linux and a test fixture picked up by node --test); 0.2.1 is the first published 0.2 release and contains everything listed under 0.2.0.

## [0.2.0] - 2026-11-17

### Added

- A read of 40 KB or more of a saved tool output is turned into a hint to Grep it or read a smaller range, and the built-in Explore search agent runs on Haiku. In the research benchmark this used 10% less Claude with the same answers.

- Added `verify --log <model> <category> <tier>`, which records the result as feedback in the same call, so logging your own work takes no extra turn.

- `doctor --report` prints a text for GitHub issues with versions, providers, self-test state and seven-day failure counts, without paths, names, keys or custom labels.

- While Claude is saving, research over about 40 KB goes to the research worker (about 25% less Claude in the benchmark). `gpt-advisor` and `researcher` report one line per claim with source and date, and `codex-run --search cached|live|disabled` sets the Codex web search mode.

- Scoped worker copies: `worktree add --scope <paths> --plan <file>`, and `worktree merge` of several copies rejects files outside a scope or shared between copies before merging any.

- `route --needs image,pdf,...` and `--context <tokens>` skip every route whose model cannot take the input (unknown counts as not supported), and a row with no such route says so instead of guessing.

- Self-test passes are bound to the CLI build, so an updated CLI is tested again; `use <provider> on` runs the self-test (`--no-test` skips it), and `doctor` and `providers` show a stale test as stale. Models known only from documentation do trivial work after the self-test, normal work after three verified passes, and critical work only with verified normal passes and public scores.

- The boss suggests setting changes: when a change would clearly help (for example `set profile frugal` when the Claude week is 80% used, or `use <id> off` for a provider that keeps failing or whose CLI is missing), the session start and `quota-boss status` name the command. The boss proposes it to you once and never changes settings itself.

### Changed

- Boss sessions start about 20% smaller: the rules are shorter with every rule kept, and session routing tables leave out the fallback ladder, which `route` still shows when a job fails.

- The delegation gate now uses the boss's real speed (`gate.bossSeconds`, Claude Code 50 s per medium job) instead of 150 s, and assumes a worker without timing data is as fast as the boss. On the large benchmark task, handing the whole build to one Codex worker saved about 22% Claude but took twice as long; with quota to spare such jobs now stay with a fast boss, and while the Claude pool is saving they still go to Codex.

- Independent worker jobs on separate files run at the same time in the background (at most two), while the boss does its own part.

- quota-boss help is short and lists only the everyday commands, grouped as Start, Settings, Providers and Reports.

- quota-boss savings --details also shows the pass rate per model and category, which stats used to show.

- quota-boss settings shows what each setting does next to its value and the command that changes it.

- While Claude is saving, a Claude Code boss now keeps medium implementation jobs, because handing them to Codex saved no Claude in benchmarks; large ones still go to Codex, and the routing table shows them as a `[large:...]` note.

- savings leads with the pool the boss uses, for example "About 30% less Claude usage than doing everything with Opus 5.5 = about 1.4x the work per Claude limit", then the other pools and the all-pools total. The header says "since <date>" when your data starts inside the window, so a short history is not shown as "last 30 days".

- savings now opens with one plain answer (how much cheaper than doing everything with the boss model), then who did the work and the top workers by name with readable times. The old tables moved to savings --details.

- Settings stored before 0.2.0 keep excluding what they excluded: an old only filter keeps every provider outside it off (quota-boss use lists them as off (only filter)), and a project's codex-tasks or perplexity off keeps that provider off for the project. quota-boss use <id> on [--project] lets just that provider in. The setup switches Codex and Perplexity for this project only. A session start repeats a suggestion only after a day or when its condition comes back.

- Claude Code sessions now start with tiny rules (in benchmarks small and medium jobs cost 11-17% less than with the full start, about as much as without boss mode, with the same results); a saving Claude pool still starts with the full rules.

- With quota to spare, the routing no longer hands a job to a worker that would make it more than 90 seconds slower (30 for small, 300 for large jobs); while Claude saves quota, the old limits stay.

### Removed

- Removed the commands explain, only, models, stats, context, boss and free-models: use settings, use, route --explain and savings --details; free-models is now the maintainer tool tools/free-models.js.

- Removed the settings codex-tasks, gpt-reviews and perplexity: use quota-boss use codex|perplexity on|off instead.

- Removed the settings short-answers, rules, consensus, split and research: Claude Code always starts with tiny rules (full while Claude is saving), consensus and research are always on, and large jobs go to one worker. Old stored values are ignored; set <name> names the replacement and exits 1.

### Fixed

- After a long pause the cold-cache check no longer blocks the prompt that carries a finished background task, so a run waiting for a quota reset continues on its own.

- `feedback` and `verify --log` accept table labels such as `Opus 5.5`, and `compact.js` keeps the `node --test` counts and no longer reports passing tests that have "failed" in their name.

- `savings` prices `codex-auto-review` sessions as GPT-6.1-Sol instead of cost 1, as the benchmark already does.

- A scheduled job (CronCreate or /loop) that fires after an hour or more of pause is no longer stopped by the cold-cache check, which used to drop that run. /handoff now lists the session's scheduled jobs so the next session sets them up again.

- The boss leaves the Agent model unset for CLI wrapper workers, which keep their Haiku default instead of a dearer model.

## [0.1.5] - 2026-11-14

### Changed

- Claude workers now use the deterministic CLI runner for the same 10-minute limit, failure classes and journals as other CLI workers. Claude JSON results supply token and cost reports, with prompts sent on stdin.

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
