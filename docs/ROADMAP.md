# Roadmap and known limits

What may come after v0.1.0, and what does not work well yet. Nothing here is a promise or has a date.
Ideas and reports are welcome as issues.

## Ideas for later versions

- Install as a Claude Code plugin from a marketplace (`/plugin marketplace add`). Open: the installer also sets the
  status line, hooks in the user settings and the Codex side, which a plugin may not be able to do.
- Extend deterministic runners to more worker adapters. `cli-worker` already uses `scripts/cli-run.js` for
  time limits, failure classification, feedback, usage and timing; `claude-worker` still runs its CLI directly.
- A larger benchmark: many tasks, several repetitions, three arms, blinded review and confidence intervals.
- Changesets for releases.
- Grok is untested, because no plan was available. If you have one, run `quota-boss providers test grok` and report
  the result.
- Unverified candidates: Tencent CodeBuddy, Cursor CLI, JetBrains Junie, and Cerebras (it needs a verified payment
  method).
- Optional `rtk` as an external tool (its engine is BUSL). Fallback ideas from claude-code-router and LiteLLM.

## Known limits and open questions

- The parent check and the write are two steps, so a parent directory can be swapped for a link in between. A real fix
  needs directory descriptors, which Node does not offer portably.
- Offers with only a few real runs may be unreliable: Gemini Lite has two, several others one. Cohere failed once with
  HTTP 422 after three passes, and Command A+ replaced a CI step it was told to insert before. Z.ai passed two of
  three.
- The detection of "exit 0 without doing the work" in `cli-worker` has never been triggered by a real failure.
- `codex-worker` runs Codex in the foreground, but Claude Code moved a 215 s run to the background after about 180 s,
  so the worker reported `ADVICE NEEDED` and the boss had to wait for the task. It worked, but the worker could wait
  for the task itself.
- `cli-run.js` enforces a 10-minute limit and kills Windows process trees with `taskkill /T /F`. Other worker
  adapters still depend on their own runner or the host's tool limit.
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
