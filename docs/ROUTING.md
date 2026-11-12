# Routing algorithm (v2)

Providers with `evidence: "docs"` receive no work until that model has passed `quota-boss providers test <pool>`. Critical work also requires three verified `pass` outcomes for that model in retained history (`probationPasses` overrides the count). Log every verified result with `feedback`, including jobs performed outside the routing table; a file-write self-test does not end probation.


Goal: for every sub-task pick the model that gives the **best chance of a correct result per unit of
*scarce* quota**, where "scarce" depends on how fast each subscription is being burned and when it resets.
The algorithm is deterministic, explainable (`quota-boss route --explain`) and learns from verified outcomes.

Ideas borrowed from cascade routing research (FrugalGPT) and OpenRouter's Auto Code router: score by
*cost per solved task*, penalise failures asymmetrically, prefer raising reasoning effort over switching models,
and escalate through a ladder instead of always starting with the most expensive model.

## 1. Inputs

| Input | Source |
|---|---|
| task `tier` (critical / normal / trivial) and `category` | classified by the boss (see templates/RULES.md) |
| model registry `scores[cat]` (1-10), `cost`, `pool` | `config/models.json` (+ user override) |
| profile (quality / balanced / frugal) | user-owned `QUOTA_BOSS_HOME/projects.json` real-path registration |
| quota per pool and window: `used` (0-100), `resets_at`, `window_minutes` | status line (Claude), Codex logs |
| usage history samples per pool | state.json `history[pool]` = last 48 samples `{t, u5, uw}` (deduplicated, >= 5 min apart) |
| verified outcomes | `QUOTA_BOSS_HOME/outcomes.jsonl` lines `{t, model, category, tier, result: pass|fail|unavailable|limited, effort?}` |

## 2. Success probability `P(model, category, tier)`

1. Prior from the registry score: `d = difficulty[tier]` (critical 8.5, normal 6.5, trivial 4.5),
   `prior = 1 / (1 + exp(-1.1 * (score - d)))`.
2. Learned posterior (Beta-Bernoulli): over outcomes for (model, category) of the last 90 days,
   with weights `w = 1` for tier match and `0.5` otherwise, and **failures weighted 2x** (asymmetric penalty):
   `P = (prior * n0 + wins) / (n0 + wins + 2*fails)`, `n0 = 6`.
3. `unavailable` outcomes in the last 24 h => model excluded (e.g. "model not supported for this plan" or
   "requires newer CLI"). Reported by `quota-boss models`.

## 3. Quota price `price(pool)` (pace-aware, "use it or lose it")

Provider caps rescale each window's usage and history before mode and price calculation:
`effectiveUsed = used / cap * 100`. A reached cap excludes delegated work; see PROVIDERS.md.

For each window `w` of a pool with usage `u` clamped to 0..100, time left `L` and window length `W`
(all times in minutes; defaults 300 for 5h and 10080 for weekly):
- expired windows use `u = 0`; clamp `L` to 0..W
- elapsed fraction `e = clamp(1 - L/W, 0.02, 1)`
- burn rate comes from the first and last valid samples within `history.paceMinutes` (default 120),
  after discarding samples before a counter drop/reset; fallback `rate = u / (e*W)`
- observed minutes = time between those samples when at least two exist, otherwise `e*W`
- confidence `c = clamp(observedMinutes / paceMinutes, 0, 1)`
- recent pace horizon `h = min(L, history.paceHorizonMinutes)` (default 300, bounded 5..1440)
- window average `a = u / (e*W)`, trusted by `t = clamp(e*W / 1440, 0, 1)`
- projected usage at reset `proj = clamp(u + max(0, rate) * h * c + a * (L - h) * t, u, 200)`; five-hour windows keep their previous projection with the default horizon
- pressure `p_w = clamp((u + max(0, proj - 100)) / 100, 0, 1.5)`:
  using a window fully by reset is ideal; only projected overshoot adds pressure to current usage
- slack discount: if `proj < 50` and `L/W < 0.25`, multiply pressure by `0.5`
- without a reset time, projection and rate are unknown, pressure is `u/100`, with no discount

Pool price `price = 1 + 3 * (max_w p_w)^2`; unknown data => `1.3`; mode `emergency`/`exhausted` => `+inf`
(excluded) except for the boss's own CRITICAL work when nothing else qualifies.
On a Claude Code host, Claude gets an extra configurable `bossFactor` (currently `1.5`) for delegated (non-self) work
because the boss context is the scarcest resource. Caps never exclude the boss's own self work.

A worker from the boss's own pool (Codex subagents under a Codex boss, Claude workers under a Claude boss) is only
eligible when its job cost (model cost x effort cost x fresh CLI charge) is at most `samePoolRatio` (default `0.5`,
clamped to 0..1) of the boss's own job cost; otherwise it loses with `lost: same pool, costs more than 0.5 of the boss`
and the row stays `self`. Handover, rereading and review land on the same quota, so a worker that is only a bit cheaper
costs more in total (Codex boss benchmark, 2026-11-10). The rule applies only when the boss itself is usable and
reaches `minP`; other pools are never affected.

### Delegation gate

After the same-pool guardrail, a usable boss reaching `minP` compares delegation with doing the job itself.
The table assumes a medium job (`thresholds.gate.defaultSize`); `route --size small|large` re-checks a job of another size.
Direct `route()` calls with no valid size, or without a usable boss, keep the previous behavior.

With size units `s = { small: 0.3, medium: 1, large: 3 }`, let `B = own.jobCost * own.price`:

```text
selfCost = s * B * (1 + (1 - own.P))
rework = (1 - worker.P) * s * B
workerCost = (s + reread) * worker.jobCost * worker.price
bossSide = (handover.fixed + handover.perSize * s) * B + rework + relay
```

For the same pool, add `workerCost` to `bossSide`; `total = bossSide` must be at most `margin * selfCost`.
For another pool, `total = bossSide + workerCost`: require `bossSide <= margin * selfCost` and
`total <= maxTotalRatio * selfCost`. Relay is the existing relay charge, counted once, or zero for direct workers.
Defaults are `margin = 0.8`, `maxTotalRatio = 1.3`, and `reread = 0.3` medium worker jobs.
Handover `(fixed, perSize)` in medium boss jobs is Claude Code `(0.2, 0.35)`, Codex `(1.5, 0.4)`, generic `(0.5, 0.35)`.

Time must also pass: `extraSeconds = handoverSeconds + s * workerSeconds - s * ownSeconds`.
Missing latency uses `workSeconds = 150`; handover seconds are Claude Code `50`, Codex `90`, generic `60`.
The maximum extra seconds are small `60`, medium `180`, large `600`. Cost failures take precedence over time failures.
All defaults are overridable in `thresholds.gate` (`size` holds the size units). `route --explain` prints the costs and extra time.
The handover estimates come from one benchmark sample per host (see [BENCHMARKS.md](BENCHMARKS.md)); logged runs will later teach them.

The boss's own effort is charged in `jobCost`, while self rows keep effort hidden in the compact table.
Unknown effort counts as medium (factor `1`); `max` costs the same as `xhigh`.
`QUOTA_BOSS_BOSS_EFFORT` overrides detection. Codex reads the newest interactive session's last turn context for this project,
then the top-level `model_reasoning_effort` in `config.toml`. Claude Code reads `CLAUDE_CODE_EFFORT_LEVEL`,
then `modelSettings[bossModel].effortLevel` or top-level `effortLevel` in its config directory's `settings.json`.
Only low, medium, high, xhigh and max are accepted; detected values are lowercased.

On a Claude Code host, every route through a CLI relay (`codex-worker`, `gpt-advisor`, `cli-worker:*`) also pays `relayCost[tier]` (`0.03`, `0.06`, `0.25` for critical, normal, trivial) times the delegated Claude price, because the relay itself runs on Haiku. A relay costs about the same on every run, so it weighs most on small jobs.

On a Codex host, a `claude-worker` job starts a fresh Claude session and re-reads its whole startup context, so its cost is multiplied by `1 + freshCliCost[tier]` (`0.1`, `0.25`, `0.6` for critical, normal, trivial). Native Codex subagents pay neither charge.

## 4. Objective

`utility = P^alpha / (max(cost, 0.2) * effortCost * price * freshCli + relay)`
`relay` is the charge described above, and `0` for direct routes. `freshCli` is `1` except on `claude-worker` routes. `effortCost` is `1` for models that declare no `efforts`.
See [MODELS.md](MODELS.md) for where cost, scores and effort factors come from.

Pools other than `claude` and `codex` use estimated scores: until `probationPasses` verified passes (default 3) across any category or tier, multiply utility by `thinEvidenceFactor` (default 0.75, clamped 0.1..1). Only passes count; `route --explain` marks these candidates with `thin evidence`.

Zero-cost free/local models keep conservative priors and the same probability floors. Training-data providers require project opt-in even for fallback, manual options and escalation.
Critical architecture rows also carry a `consensus` option with an available Codex model and high effort. The consensus agent hides the boss’s draft until an independent read-only answer returns.

`alpha` controls how much quality matters vs quota:

| tier | quality | balanced | frugal |
|---|---|---|---|
| critical | 8 | 6 | 4 |
| normal | 3 | 2 | 1.5 |
| trivial | 1.5 | 1 | 0.7 |

Hard floor: candidates with `P < minP[tier]` (critical 0.75, normal 0.55, trivial 0.4) are dropped unless no
candidate remains (then best P wins and the row is flagged `belowThreshold`).
Ties (within 2%): higher P, then same pool as the previous step of the session (keeps prompt cache warm).

## 5. Effort and escalation ladder

Only the model the boss actually runs on is `self`. Every other model is a worker, so an overqualified boss hands work down:
a Codex boss through `codex-subagent` (a native subagent with its own model and effort), a Claude boss through `sonnet-worker` or `haiku-worker`, and a boss on a weaker Claude model up through `opus-worker`.
The boss model comes from the status line on Claude Code, and from the newest interactive session log of the project or `config.toml` on Codex. For headless Codex runs, a valid `QUOTA_BOSS_BOSS_MODEL` overrides detection. When neither says, the router assumes the cheapest model within 0.5 of the pool's best boss score. A reported boss from another pool owns no row. A reported boss that the registry does not know is mapped to the newest registered model of the same pool and family (for example `gpt-99-sol` to the newest Sol), or to the default boss pick when no family matches, and `route`, the session table and `doctor` print a note. Its cost and quality are then those of the substitute. On Claude Code the status line remembers the boss model per project, so a session on another model elsewhere does not change this project's table.

Effort applies to every worker whose model declares `efforts`, from the margin `m = score - d`: `m >= 2` -> low, `m >= 0.5` -> medium, else high;
critical never below `high`. A model's `minEffort` and category `thresholds.minEffort` are floors (architecture defaults to `medium`; `minEffort.architecture: "low"` removes that category floor), and the result stays within its declared levels. `self` rows carry no effort, because the boss's effort is a session setting. A CLI provider gets a level only when its template has an `{effort}` placeholder.
Retained outcomes at the exact model, category, tier and effort raise the chosen level while there are at least two failures and more failures than passes, stopping at the highest routable level. The router never tries cheaper levels automatically. In the posterior, a failure below the candidate effort or a pass above it has half weight; missing or unknown effort keeps full weight.

Each route row returns a **ladder** of up to 3 steps:
1. primary model @ effort
2. same model @ next effort level (cheaper than a switch: same context and cache)
3. After the effort step, the ladder takes the cheapest model about as likely to succeed (within `0.05` of the winner's `P`, or better), preferably from another pool. Only when no such model exists does it fall back to the most capable alternative.
The boss escalates one step on a verified failure and logs the outcome:
`node <QUOTA_BOSS_HOME>/scripts/quota-boss.js feedback <model> <category> <tier> pass|fail|unavailable|limited [--effort <level>]`. Pass the level the worker ran at when known.
`unavailable` (missing key or model) skips the model for 24 hours. `limited` (rate limit) pauses it for 15 minutes. Neither counts as a failure.

## 6. Output

`route()` returns rows `{tier, category, model, label, via, effort, P, price, utility, ladder[], belowThreshold}`.
`formatTable()` stays compact (<= 6 lines; ladder shown as `A>A+>B`).
`quota-boss route --explain [category] [tier]` prints every candidate with P, price, utility and the reason it
won or lost - for users who want to tune `models.json`.

## 7. Latency

Medians are kept per model and difficulty, with three runs needed before a latency estimate is used. A model
only loses utility once its median passes the tolerance for that difficulty: 120s for trivial, 600s for normal,
and 1800s for critical. Critical work is never affected. These values are assumptions and can be overridden with
`thresholds.latency`. Latency appears only in `stats` and `route --explain` output, never in the status line.

## Savings report

`quota-boss savings [--days N] [--all]` reads local Claude main/subagent transcripts, Codex rollouts, usage counters and successful timing records. The default is 30 days and the registered project root (otherwise cwd); `--all` includes every project. It prints aggregates only and never writes or calls a provider.

Cost units are weighted tokens per million times the exact model registry cost, with unknown models priced at 1 and listed. `thresholds.savings` overrides the default Claude weights (input 1, cache creation 1.25, cache read 0.1, output 5) and Codex weights (uncached input 1, cached input 0.1, output 8). Codex reasoning is already included in output. The boss comparison reprices worker weighted tokens using the model with the most boss units; the estimated total includes the existing boss work. This assumes the same token count, not equivalent work or a bill.

Claude messages are deduplicated by message id within each file, keeping the last usage and timestamp. Codex uses the final cumulative token count and latest model, including the whole session when its final count falls in the window; it cannot apportion sessions crossing the cutoff or model changes. Job duration spans the first and last timestamps (including idle time); multi-model Claude jobs appear once under each model. Quota deltas are omitted per window when reset times change or counters are missing. Runs that overlap in time within one window, such as a Codex auto-review inside a worker run or parallel workers, are merged and counted once; other Codex use on the account at the same time is still included.

Counters and timing journals have no project identity, so those sections are global even without `--all`. Timing follows `readRuns` successful-run validation and its 30-day horizon. Usage uses `readUsage` validation with a read-only reader because `readUsage` itself may compact the journal. Missing, malformed, linked, unreadable or over-32-MiB files are skipped. Transcripts last written before the window and Codex day folders older than it are skipped without reading, and Codex folders are read newest first. At most 2000 files and 2000 directory entries are examined; large output groups are abbreviated. These bounds, missing logs, duplicate exports and retained history can make totals incomplete.

## Tuning

- `~/.claude/quota-boss/config/models.json`: quality scores and cost per model. **PRs with better defaults are very welcome.**
- `~/.claude/quota-boss/config/thresholds.json`: mode thresholds, difficulty, alpha, floors.
- Log outcomes to make routing learn: `node ~/.claude/quota-boss/scripts/quota-boss.js feedback gpt-6.1-sol implementation normal pass`
  (the boss does this automatically after verifying worker results).
