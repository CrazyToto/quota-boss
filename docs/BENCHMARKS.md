# Benchmarks

These measurements compare boss mode costs, usage, time and results with working without it.
Each row is one run in a short session; the harness is in [bench/](../bench/README.md).

## Does boss mode cost more than working without it?

Measured from real session transcripts (11 boss-mode sessions over 2 days, numeric usage fields only).

| Finding | Evidence | Consequence |
|---|---|---|
| The boss thread is the cost | About 99% of weighted Claude usage. Relay agents that only launch a CLI are about 1%. | Cheaper relays save little. Fewer boss turns in a large context save a lot. |
| The boss did nearly all the work itself | Over 3 days, 21 of about 1,270 tool calls went to agents (10 cli-worker, 4 codex-worker, 4 researcher, 2 gpt-advisor, 1 consensus). None went to Haiku or Sonnet as a working model. 397 Edit and 69 Write calls ran on Opus. | The 99% above is partly a result of this. Cheap workers now exist, so measure again. |
| Context size drives it | Cache reads are 40-77% of cost, cache writes 7-34%, output 16-48%. Average context per turn is 80k-210k tokens, the maximum 382k. A fresh session starts near 45k. | Warn earlier and avoid extra turns. |
| Small delegations are risky | A delegation adds about three boss turns, each more expensive in a large context. A 13-line file sent to a free provider cost 14.4k Haiku tokens and 38 s, failed with HTTP 422, and the boss wrote it anyway. In a small fresh context the benchmark below shows no Claude loss, but 4x the time. | Add a delegation gate and test it. templates/RULES.md has no minimum task size today. |
| Verification has a hole | TRIVIAL work is checked with tests and `git diff --stat`. Docs have no tests, so nobody reads the result. | Always read the changed content. |
| Reviews are doubled | templates/RULES.md rule 5 and `agents/reviewer.md` both ask for a GPT counter-review. | Keep one. |

Using Codex or free quota instead of Claude is the purpose of the tool, so those pools are expected to go up. The goal is
that they are only spent on work that replaces more expensive work, and that Claude usage goes down without worse results.
No guarantee is possible, because the host does not report the cost of a single request. The benchmark below is the check.

### Benchmark

Headless `claude -p --model opus` on a fresh fixture, boss on versus off, with hidden acceptance tests.

| Run | Task | USD (Claude) | Turns | Seconds | Hidden tests | Codex uncached tokens |
|---|---|---|---|---|---|---|
| boss off | small (one function and tests) | 0.29 | 8 | 16 | 5/5 | 0 |
| boss on, current rules | small | 0.26 | 8 | 68 | 5/5 | 6,935 |
| boss off | medium (three modules and tests) | 0.64 | 16 | 136 | 18/18 | 0 |
| boss on, current rules | medium | 0.42 | 15 | 194 | 18/18 | 14,118 |
| boss on, revised rules | small and medium | not run yet | | | | |

One sample per row, on a tiny fixture in a fresh session, so context stayed small. It shows direction only and cannot prove
that boss mode never costs more, least of all in long sessions with a large context. Boss on used less Claude usage in both
tasks (about 11% and 35%), at the price of Codex tokens and more time (52 s and 58 s longer). Hidden tests passed equally, but
the boss-off run wrote a more thorough test suite for the medium task (39 tests against 12), so "equal quality" holds only for
the hidden checks. Each run also had one to four denied commands from the harness permissions. Spec quality should be
improved to ask for thorough tests, and the revised rules must be compared on the same tasks.

### Benchmark with Codex as the boss

Headless `codex exec -m gpt-6.1-sol` at medium effort, `-s workspace-write`, same fixtures and hidden tests, 2026-11-10, codex-cli 0.167.0.
USD is an estimate from token counts of every session in the run folder at list prices. `codex-auto-review` sessions are priced as GPT-6.1 Sol because their price is unknown.

| Run | Task | USD (estimate) | Seconds | Hidden tests | Own tests | Sessions |
|---|---|---|---|---|---|---|
| boss off | small | 0.107 | 85 | 5/5 | 7 | boss only |
| boss on | small | 0.074 | 82 | 5/5 | 7 | boss only, no delegation |
| boss on, boss model known | small | 0.093 | 86 | 5/5 | 7 | boss only, no delegation |
| boss off | medium | 0.140 | 99 | 18/18 | 9 | boss only |
| boss on | medium | 0.325 | 143 | 18/18 | 9 | boss, GPT-6.1 Sol low worker, GPT-6 Luna review |
| boss on, boss model known | medium | 0.379 | 213 | 18/18 | 11 | boss, GPT-6.1 Sol medium review; `route` never returned a table |
| boss on, `route` fixed (2 runs) | medium | 0.50, 0.52 | 234, 196 | 18/18 | 7, 10 | boss, GPT-6.1 Sol low worker, one GPT-6 Luna review; auto-review 0.13 to 0.16 |
| boss off, same conditions | medium | 0.113 | 127 | 18/18 | 12 | boss only |
| boss on, rerun 2026-11-11 | medium | 0.207 | 191 | 18/18 | 9 | boss only; pwsh launch refused, so it wrote files and ran tests through `node_repl` (15 tool calls) |
| boss off, rerun 2026-11-11 | medium | 0.100 | 90 | 18/18 | 9 | boss only; pwsh refused once, then `cmd.exe` (7 tool calls) |
| boss on, shell fallback rule | medium | 0.120 | 110 | 18/18 | 9 | boss only, `route` read through `cmd.exe`, no review agent |

After the `route` fix the table arrives, but `QUOTA_BOSS_BOSS_MODEL` does not reach Codex's `node_repl`, so the boss still saw the table for an unknown boss and sent the whole task to its own model at low effort. With the model known, `route` picks GPT-6.1 Terra at half the price instead.
Breakdown of one boss-on run: boss 0.21 (off: 0.07), worker 0.12, auto-review of all agents 0.17 (off: 0.04). The overhead of handing over (waiting turns in the boss context, the worker reading the project again, a review, approvals for every agent) costs more than the work. Shell launches were refused in boss on and boss off alike, so that does not explain the gap.

One sample per row. Small is even within noise. **Medium costs about 2.3 to 2.7 times boss off with no gain on the hidden tests, so a Codex boss currently breaks the rule that boss mode must not cost more.**
No Claude usage in any run. The six runs moved the Codex 5h window by about 5 points for the first four.

What the logs show:

- The first boss did not know its own model: `codex exec` sessions are ignored and `config.toml` named another one, so no row said `self` and GPT-6.1 Sol handed work to GPT-6.1 Sol at low. `QUOTA_BOSS_BOSS_MODEL` now covers headless runs.
- In the second medium run `route` could not write its lock file outside the workspace under the Codex sandbox, and launching `pwsh` from WindowsApps was refused (`CreateProcessAsUserW failed: 5`). The boss spent about ten steps working around that, including reading the quota-boss source, and got no table.
- Rerun on 2026-11-11: `route` itself now runs in the sandbox (checked with `codex sandbox`, no write outside the workspace). The remaining failure was the shell: Codex on Windows starts commands with `pwsh` from WindowsApps, which the restricted token cannot launch (`CreateProcessAsUserW failed: 5`). Boss off switched to `cmd.exe`; boss on read "If route cannot run" as a stop and worked around every launch. The Codex rules now say to retry once with another shell, on Windows `cmd.exe`. With that, boss on costs 0.120 against 0.100 to 0.140 for the three boss-off runs: within the boss-off spread, about 20% above the same-day run. The fixed part left is the rules block in `AGENTS.md` (about 3.7k tokens, of which about 1.5k are the `claude-worker` and `cli-worker` texts).
- The boss context is the cost: 570k to 580k input tokens against 235k without the boss. Every run on medium also added a review agent, because rule 5 asks for verification by a different model.

### Benchmark with mixed tasks (step 7)

2026-11-10, harness now in [bench/](../bench/README.md). Task `mixed`: the medium task plus four chores (a rename, JSDoc,
two `package.json` fields, a README usage section), 22 hidden checks. Claude: `claude -p` at default effort. Codex:
`codex exec -m gpt-6.1-sol` at medium. Claude USD from the `claude -p` result, Codex USD estimated from tokens at list prices.

| Run | Claude USD | Codex USD | Seconds | Hidden | Own tests | What the boss did |
|---|---|---|---|---|---|---|
| Opus, boss off | 0.33 | 0 | 50 | 22/22 | 14 | everything |
| Opus, boss on, old rules | 0.91 | 0.08 | 159 | 22/22 | 10 | chores itself, tracker to Codex in the background, then the same job to Sonnet as well |
| Opus, boss on, fixed rules | 0.34 | 0 | 59 | 22/22 | 14 | everything |
| Sonnet, boss off | 0.18 | 0 | 41 | 22/22 | 7 | everything |
| Sonnet, boss on | 0.21 | 0 | 46 | 22/22 | 11 | everything |
| GPT-6.1 Sol, boss off | 0 | 0.13 | 123 | 22/22 | 13 | everything |
| GPT-6.1 Sol, boss on, old rules (2 runs) | 0 | 0.52, 0.52 | 190, 220 | 22/22 | 15, 15 | no table, whole task to a GPT-6.1 Sol medium subagent, Terra review |
| GPT-6.1 Sol, boss on, fixed rules | 0 | 0.14 | 136 | 22/22 | 13 | table read, everything itself |

One sample per row. What went wrong with the old rules, and the fix:

- **Two workers on one job.** `codex-worker` started `codex-run.js` in the background, as its instructions said, and its wait loop
  was refused, so it reported `FAILED` while Codex kept writing. The boss sent the same job to Sonnet, and both wrote the same
  files: 31 turns and 2.8 times boss off. Fix: `codex-worker` runs Codex in the foreground with a 10-minute limit and reports
  `ADVICE NEEDED` instead of `FAILED` when a run may still be going; templates/RULES.md rule 5 says to stop the first run before handing
  the job to another worker.
- **No table, a guessed worker.** The Codex sandbox refused every process launch (`spawnSync node EPERM`, pwsh from WindowsApps),
  so `route` never ran, and the boss handed the whole task to its own model at the same effort: 4.1 times boss off. The
  sandbox refused launches in two runs and allowed them in the third. Fix: the Codex rules say that without a table the boss
  works itself, and never spawns a subagent on its own model at the same or a higher effort.
- **The boss logged a false `fail`** for GPT-6.1 Sol into the owner's outcome log, and `feedback sonnet` was refused without a
  hint. The bench now moves feedback written during a run into the result line, and `feedback` names the closest model id.

With the fixed rules boss on costs 3% (Opus) and 12% (GPT-6.1 Sol) more than boss off on this task, with the same hidden
results. On a task this small both bosses keep the work, which is what the gate intends: a medium job in a 30k context gains
little from handing over. The chores did not change that. Gains from delegation need longer sessions with a larger context,
which this benchmark does not cover.

Sonnet as the boss: Sonnet boss on cost 0.21 against 0.33 for Opus boss off (37% less) with the same hidden results, but wrote
fewer of its own tests (7 to 11 against 14). One small task cannot carry the decision; see the open item in section A.

### Benchmark with a large task (2026-11-16)

Task `large`: an inventory tool in five modules (CSV parser, inventory with CSV import, pricing, report, CLI) plus four
chores, 32 hidden checks. Claude Code host, Opus 5.5 boss at default effort, profile balanced, quota to spare.
USD are list-price estimates per run (`claude -p` result and Codex session tokens).

| Arm | Runs | Hidden | Time (s) | Claude USD | Codex USD | Own tests |
|---|---|---|---|---|---|---|
| off | 3 | 32/32 each | 143, 172, 135 (mean 150) | 0.56, 0.78, 0.66 (mean 0.67) | 0 | 23-25 |
| on, delegated the whole build to one GPT-6-Sol worker | 2 | 32/32 each | 263, 313 (mean 288) | 0.49, 0.56 (mean 0.52) | 0.18, 0.20 | 13-15 |
| on, the boss kept it | 1 | 32/32 | 146 | 0.73 | 0 | 29 |

Delegating used about 22% less Claude at the same hidden result, but took about twice as long: the worker alone needed
about 185 s, while Opus built everything in about 150 s. The cause was the delegation gate: it priced the boss at 150 s
per medium job (450 s for this large job), about three times the measured speed. The gate now has `bossSeconds`
(Claude Code 50 s per medium job), and a worker without timing data is assumed as fast as the boss. With quota to spare
a normal job now stays with an Opus boss unless a worker is about as fast; while the Claude pool is saving, the looser
time limit still lets large jobs go to Codex. A second opinion from GPT-6.1 Sol agreed and advised against splitting
work into parallel workers as a blanket rule until it is measured. Three runs per arm show direction only.

### Codex as the boss, rerun with all task sizes (2026-11-16)

Codex CLI host, GPT-6.1 Sol at medium effort, with the same fixtures and hidden checks as above. Boss on used current
main with the delegation gate from d4de92d. The Claude pool was above 60%, so routing ran in Claude saving mode.
USD are list-price equivalents from Codex session logs, including Codex's own auto-review sessions.

| Task | Arm | Runs | Hidden | Time (s), mean (runs) | USD, mean (runs) |
|---|---|---|---|---|---|
| small | off | 2 | 5/5 both | 65 (53, 77) | 0.078 (0.086, 0.070) |
| small | on | 2 | 5/5 both | 44 (34, 53) | 0.046 (0.054, 0.038) |
| medium | off | 2 | 18/18 both | 132 (139, 124) | 0.136 (0.135, 0.137) |
| medium | on | 2 | 18/18 both | 110 (97, 122) | 0.127 (0.108, 0.147) |
| large | off | 3 | 32/32 all | 209 (205, 186, 236) | 0.198 (0.225, 0.171, 0.200) |
| large | on | 3 | 32/32 all | 219 (193, 210, 254) | 0.195 (0.207, 0.180, 0.197) |

In every boss-on run the boss kept the work itself: one GPT-6.1 Sol session and no worker. That is what the gate should
do at this size. Every boss-off run and the boss-on medium and large runs also started a short `codex-auto-review`
session, Codex's own approval reviewer from the user's config. These cost $0.015 to $0.029 per run. Boss-on small runs
had none. The boss rules may explain this: they tell Codex to retry a refused command launch with another shell, so it
asks for fewer approvals. This was seen on one Windows machine and is not a general claim.

Boss on cost slightly less on all three sizes and finished sooner on small and medium. Large took 10 s longer on average,
within the spread of the runs. All hidden results were the same. Two or three runs per arm are a small sample: read the
cost differences as no extra cost, not as a measured saving. The earlier Codex-boss benchmark cost 2.3 to 2.7 times
boss off before the fixes and about 1.2 times after. The rules overhead on this Codex host is now gone.

### Claude Code: tiny rules and saving mode (2026-11-16)

Claude Code host, Opus 5.5 boss at default effort, profile balanced, same fixtures and hidden checks as above (small,
medium, large). Boss on used `--rules full` (rules, routing table and notes at session start) or `--rules tiny` (a
six-line start; the full rules and a fresh table load on demand). `--claude-mode normal` simulates Claude 5h use of 10%
and `--claude-mode save` 75% (`QUOTA_BOSS_CLAUDE_5H`, commit 7f83d72), so routing prices Claude as it would at that use.
While Claude is saving, tiny starts with the full rules (557cd4b), so the saving runs below are tiny projects that
started with full rules. USD are list-price estimates per run.

Quota to spare:

| Task | Arm | Runs | Hidden | Time (s), mean (runs) | Claude USD, mean (runs) |
|---|---|---|---|---|---|
| small | off | 2 | 5/5 both | 32 (39, 25) | 0.184 (0.183, 0.185) |
| small | on, full | 5 | 5/5 all | 27 (37, 26, 21, 25, 25) | 0.217 (0.241, 0.213, 0.196, 0.217, 0.219) |
| small | on, tiny | 5 | 5/5 all | 24 (30, 31, 19, 21, 21) | 0.181 (0.181, 0.209, 0.171, 0.164, 0.181) |
| medium | off | 2 | 18/18 both | 50 (55, 45) | 0.276 (0.273, 0.278) |
| medium | on, full | 5 | 18/18 all | 52 (55, 47, 54, 53, 52) | 0.320 (0.315, 0.312, 0.338, 0.330, 0.306) |
| medium | on, tiny | 5 | 18/18 all | 46 (46, 50, 47, 43, 45) | 0.284 (0.284, 0.285, 0.290, 0.275, 0.284) |
| large | off | 2 | 32/32 both | 151 (153, 149) | 0.722 (0.734, 0.710) |
| large | on, tiny | 2 | 32/32 both | 155 (137, 172) | 0.738 (0.673, 0.802) |

In every boss-on run with quota to spare the boss kept the work, with no Codex use, as the gate should.

Claude saving:

| Task | Arm | Runs | Hidden | Time (s), mean (runs) | Claude USD, mean (runs) | Codex USD, mean (runs) |
|---|---|---|---|---|---|---|
| medium | off | 2 | 18/18 both | 50 (55, 45) | 0.276 (0.273, 0.278) | 0 |
| medium | on, saving | 2 | 18/18 both | 203 (222, 184) | 0.276 (0.277, 0.275) | 0.153 (0.151, 0.154) |
| large | off | 2 | 32/32 both | 151 (153, 149) | 0.722 (0.734, 0.710) | 0 |
| large | on, saving | 3 | 32/32 all | 304 (341, 272, 298) | 0.476 (0.326, 0.461, 0.642) | 0.188 (0.246, 0.138, 0.179) |

Tiny and full had the same hidden results. Tiny cost about the same as boss off (small 2% less, medium 3% more, large
2% more) and was faster on small and medium; large took 4 s more on average. Full rules cost 16-18% more than boss off
on small and medium. The difference is the startup text.

In every large saving run the boss handed the build to one Codex worker (GPT-6.1 Sol or GPT-6 Sol). Mean Claude use fell
by about a third (0.476 against 0.722) at the same hidden result. Codex added about 0.19 and the run took about twice
as long. Claude use varied from 0.326 to 0.642: the boss sometimes fixed worker bugs itself.

The medium saving handover saved no Claude (0.276 against 0.276), added Codex cost and took about four times as long.
The gate had priced the boss side of a Claude Code handover too low. Its `handover.claude-code.fixed` is now overridden
to 0.5 for normal implementation jobs only, fitted to these runs: a saving boss keeps a medium job and still hands a large
one to Codex; other jobs keep 0.2 until measured. The compact table
now shows a `[large:...]` note on a row that the boss keeps at medium size but would hand down when large.

Earlier `--claude-mode save` runs only renamed the mode while routing still priced Claude at the real low use, so the
boss never handed work down; they are left out. Runs between 03:41 and 03:49 UTC ran two at a time, so their times are
less clean; cost and hidden results are not affected. In one medium saving run the boss gave the Codex wrapper agent
Sonnet instead of its Haiku default (+$0.04); the rules now say to leave the Agent model unset for CLI wrapper workers
(1c61475). Two to five runs per arm show direction only.

### Claude Code: reading guidance and the saved-output guard (2026-11-17)

Same host and boss as above, tiny rules, quota to spare except for the large task (`--claude-mode save`). New in these
runs: the start text asks for parallel independent reads but warns that dumping whole folders costs more than an extra
turn; a Haiku `Explore` agent replaces the built-in search agent; and a PreToolUse guard turns a read of 40 KB or more
of a saved tool output (Claude Code persists large command output to a file, which the model then often reads whole)
into a hint to Grep it or read a smaller range. The research fixture asks nine questions over an 80 KB manual; readheavy
is a code change that needs many files read.

| Task | Arm | Runs | Hidden | Time (s), mean (runs) | Claude USD, mean (runs) |
|---|---|---|---|---|---|
| research | off | 3 | 9/9 all | 26 (21, 28, 29) | 0.427 (0.458, 0.347, 0.476) |
| research | on | 4 | 9/9 all | 46 (43, 45, 45, 50) | 0.386 (0.396, 0.378, 0.395, 0.377) |
| readheavy | off | 2 | 15/15 both | 62 (58, 65) | 0.388 (0.379, 0.396) |
| readheavy | on | 3 | 15/15 all | 60 (55, 57, 67) | 0.380 (0.357, 0.354, 0.430) |
| large | on, saving | 1 | 32/32 | 283 | 0.541 (+0.128 Codex) |

On research every run dumped the whole manual with one shell command; boss off then read the saved 83 KB output whole.
With boss on the guard denied that read in three runs (the fourth run did not try it) and the boss read the sections it
needed instead: 10% less Claude and a narrower spread at the same answers, but about 20 s longer, because targeted
reading takes more turns. The saving grows with the length of the session after the dump, since every later turn
re-reads it; this fixture ends right after. Readheavy cost and time match boss off. The large saving run is within the
earlier range (0.326 to 0.642 Claude, 272 to 341 s); its extra time against the previous round was in the Codex worker,
not in the boss. A second large run finished its work in 268 s but scheduled a wakeup, which kept the `-p` process
alive until the timeout; bench runs now disallow `ScheduleWakeup`. The bench did not call `Explore`. Two to four runs
per arm show direction only.

With the same start text, small and medium (boss on, tiny, quota to spare, 3 runs each) stayed at the earlier tiny
level: small 5/5 in all runs, 22 s (21, 22, 24), 0.181 and 0.185 in two runs; the first run cost 0.275 because it
started on a cold prompt cache (28k cache-write tokens against 16k) with the same five boss calls. Medium 18/18 in all
runs, 47 s (45, 47, 48), 0.281 (0.277, 0.280, 0.286), against 0.284 and 46 s before.

### Claude Code: the split setting (2026-11-17)

Same host and boss, tiny rules, `--claude-mode save`. `quota-boss set split on` adds a rule that lets the boss split a
large job into two scoped worker copies (`worktree add <name> --scope <paths> --plan <file>`, then one
`worktree merge` of both). The new xlarge task is the large task plus an orders module and two CLI commands (44 hidden
checks).

| Task | Arm | Runs | Hidden | Time (s) | Claude USD |
|---|---|---|---|---|---|
| large | off | 2 | 32/32 both | 162 (155, 169) | 0.742 (0.728, 0.755) |
| large | on, one worker | 1 | 32/32 | 225 | 0.520 (+0.102 Codex) |
| large | on, split allowed | 1 | 32/32 | 280 | 0.482 (+0.177 Codex) |
| xlarge | off | 1 | 44/44 | 181 | 0.849 |
| xlarge | on, one worker | 1 | 44/44 | 265 | 0.501 (+0.171 Codex) |
| xlarge | on, split allowed | 1 | 44/44 | 292 | 0.632 (+0.115 Codex) |

In both split runs the rule was in the session, but the boss judged the modules too dependent on each other and sent
one worker, as with split off; the gap in time is spread between runs, not the feature. The bench was stopped there, so
split stays off by default until a task where the boss actually splits shows a gain.

### Claude Code: research by read volume (2026-11-17)

Same host and boss (Opus), tiny rules. The research task asks 8 questions over about 80 KB of local docs; hidden checks
verify the answers and that every cited file exists (not that the citation supports the claim). `quota-boss set research
on` adds a rule that, while Claude is saving, hands research over about 40 KB to the research worker (`gpt-advisor` on
Codex), which returns one line per claim with source and date. Mean of 3 runs each, all 9/9.

| Run | Claude mode | Delegated | Claude USD | Codex USD | Seconds |
| --- | --- | --- | --- | --- | --- |
| research off | normal | 0/3 | 0.388 | 0 | 57 |
| rule in the short start text | normal | 0/3 | 0.378 | 0 | 44 |
| forced by the prompt | normal | 3/3 | 0.286 | 0.088 | 97 |
| research off | save | 0/3 | 0.374 | 0 | 39 |
| research on | save | 1/3 | 0.348 | 0.034 | 50 |

Delegated research uses about 25% less Claude at the same quality, but adds about 0.09 Codex and takes about twice as
long. Left to choose, the boss read the docs itself in 5 of 6 runs, even with quota to spare, so the rule now applies
only while Claude is saving and not when the worker's own pool is tight. Research stays off by default. Kept for
everyone: the claim, source and date report form of `gpt-advisor` and `researcher`, and `codex-run --search
cached|live|disabled`.
