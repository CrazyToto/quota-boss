# Benchmark

Boss mode on versus off on a fresh fixture with hidden acceptance tests. Every run uses the real CLIs and the installed
Quota Boss (`node install.js` first), so it spends real quota. The folder is not part of the npm package.

```
node bench/run.js --host claude|codex --mode on|off --task small|medium|mixed [--model <id>] [--effort <level>] [--label <name>] [--n <k>] [--out <dir>]
```

- `small`: one function and its tests (5 hidden checks).
- `medium`: a task store, a report and a CLI with tests (18 hidden checks).
- `mixed`: `medium` plus four chores: a rename, JSDoc comments, two `package.json` fields and a README usage section
  (22 hidden checks). The chores give the boss trivial work it could hand down.

Defaults: `opus` for `--host claude`, `gpt-6.1-sol` at `medium` for `--host codex`, results in
`<tmp>/quota-boss-bench`. Each run appends one line to `results.jsonl` there: time, hidden and own test results, Claude
cost per model from the `claude -p` result, and every Codex session started in the fixture with its tokens and an
estimated USD price (list prices from [docs/MODELS.md](../docs/MODELS.md)).

`node bench/hidden-check.js <task> <folder>` runs the hidden checks alone.

Feedback the boss logs during a run is moved from `~/.claude/quota-boss/outcomes.jsonl` into the result line, so a
benchmark does not teach the router. That moves feedback from any other session that writes in the same minutes too, so
run no other boss sessions while benchmarking. The Claude arm starts `claude` directly; on Windows that needs the native
`claude.exe`, not only an npm `.cmd` shim, and the run stops without a result line when it cannot start.

One run per row shows direction only. Results so far are in [docs/BENCHMARKS.md](../docs/BENCHMARKS.md).

## Effort

```
node bench/effort.js --host claude|codex --model <id> [--efforts low,medium,high,xhigh] [--n 2] [--out <dir>]
node bench/effort.js --report [--out <dir>]
```

One fixed task (an exact scheduler in one file) per level, `--n` times, each checked by 11 hidden checks. Every run appends
its tokens, seconds and check result to `effort.jsonl`, and the report prints output and cost against `medium` per model.
The Claude runs use `--safe-mode` and only the Write tool, so the owner's hooks and plugins do not change the numbers. The
results are in the "Effort" section of [docs/MODELS.md](../docs/MODELS.md). Measuring all four levels twice on the four
Claude models used about half of a 5-hour window of a Claude subscription, most of it for `xhigh` on the two strongest models.
