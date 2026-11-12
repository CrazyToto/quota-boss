# Roadmap and known limits

What may come after v0.1.0, and what does not work well yet. Nothing here is a promise or has a date.
Ideas and reports are welcome as issues.

## Ideas for later versions

- A Codex `SessionStart` hook (stable in codex-cli 0.167, `~/.codex/hooks.json`) could attach the table at session
  start, with the boss model from the hook input, so the boss needs no process launch for `route`. Codex skips new
  hooks until the user trusts them with `/hooks`, so setup must say so.
- Load the `claude-worker` and `cli-worker` texts into the Codex `AGENTS.md` block only when such providers are enabled
  (about 1.5k tokens per turn).
- A deterministic runner instead of LLM relays. It saves little usage (about 1%), but it makes time limits, failure
  classification and usage logging reliable.
- A larger benchmark: many tasks, several repetitions, three arms, blinded review and confidence intervals.
- Parallel workers on the same files, each in its own git worktree and branch. Today two workers must never write the
  same files, so such jobs run one after the other. Claude Code's Agent tool already offers `isolation: "worktree"`;
  Codex and CLI workers would need the worktree path as their working directory. The boss merges the branches and
  resolves conflicts, so it only pays when the jobs touch different parts of a file. Open: who runs the check after
  the merge, and cleanup of worktrees left by a failed worker.
- Changesets for releases.
- Detect free models from models.dev and the OpenRouter model list.
- Grok is untested, because no plan was available. If you have one, run `quota-boss providers test grok` and report
  the result.
- Unverified candidates: Tencent CodeBuddy, Cursor CLI, JetBrains Junie, and Cerebras (it needs a verified payment
  method).
- Optional `rtk` as an external tool (its engine is BUSL). Fallback ideas from claude-code-router and LiteLLM.

## Known limits and open questions

- `cli-worker` times a call with Bash (`SECONDS`, `< /dev/null`). Claude Code runs Bash on Windows too (Git Bash), but
  a Codex or generic boss on Windows with only PowerShell cannot follow those steps as written. A Node runner for
  timing and stdin would fix it (see the deterministic runner above).
- The parent check and the write are two steps, so a parent directory can be swapped for a link in between. A real fix
  needs directory descriptors, which Node does not offer portably.
- Offers with only a few real runs may be unreliable: Gemini Lite has two, several others one. Cohere failed once with
  HTTP 422 after three passes, and Command A+ replaced a CI step it was told to insert before. Z.ai passed two of
  three.
- The detection of "exit 0 without doing the work" in `cli-worker` has never been triggered by a real failure.
- `codex-worker` runs Codex in the foreground, but Claude Code moved a 215 s run to the background after about 180 s,
  so the worker reported `ADVICE NEEDED` and the boss had to wait for the task. It worked, but the worker could wait
  for the task itself.
- The 10-minute worker limit is only enforced by the host's Bash tool. Whether it kills child processes on Windows is
  unverified.
- `kilo-free` does not appear in the route table: Haiku has the higher utility for trivial work (see
  `route --explain mechanical trivial`), so this is the intended result and not a tie-break problem.
- With many providers enabled, the session start comes close to the 10,000-character hook limit. The table and the
  handoff notes move to the first prompt when they do not fit. Shorter rules would bring them back into the session
  start, but the rule text is tuned by benchmark, so shortening it needs a benchmark rerun.
- OpenAI's Terms of Use could not be fetched automatically (HTTP 403), so read them in a browser.
- Mistral Vibe and `mistral-api` may share one limit. Some limit texts still come from OmniRoute's reported values.
- Extra provider models had one real call each on 2026-11-09: Cohere Command A+, OpenRouter Nemotron Ultra and Copilot
  `auto` answered. Mistral Large is not in the free tier, Gemini Flash hung for 90 s, and Copilot rejected
  `claude-haiku-5.5` on the test account. Their scores are provisional until outcomes are logged.
- A fresh session starts near 45k tokens. By estimate most of that is the host and the user's own tools, and only 1-2k
  is Quota Boss. This was not measured separately.
- With several sessions open on different models, `route` and a mode change use the last status line. Only the table
  at session start uses that session's own model. A resumed older Codex session in the same project can be mistaken
  for a newer one.
- A registry cleanup during install can overwrite an API added at the very same moment. The installer is not meant to
  run alongside `add-api`.
- All routing thresholds are estimates. Weighted tokens only approximate real subscription accounting.
