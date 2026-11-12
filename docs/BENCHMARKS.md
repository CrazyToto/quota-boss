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
