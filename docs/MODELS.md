# Model data

Last checked: 2026-11-09. Everything here goes stale quickly, so check the sources before you rely on a number.

`config/models.json` holds three things per model. This file says where they come from.

| Field | Meaning |
|---|---|
| `cost` | List price of one agent turn, with Opus 5.5 as 10. |
| `scores` | Quality from 1 to 10 per task category, at the effort the router picks. |
| `efforts` | The reasoning levels the router may pick. `minEffort` sets a floor. |

## Cost

Agent work is mostly cached input, so a price per million tokens says little by itself. The cost column uses the token mix
from 39 real Codex sessions: about 93% cached input, 6% fresh input and 1% output.

Prices are USD per million tokens at the standard rate.

| Model | Input | Cached | Output | `cost` |
|---|---|---|---|---|
| GPT-6 Astra | 10.00 | 1.00 | 50.00 | 32 |
| Claude Fable 5.2 | 8.00 | 0.20 | 40.00 | 17 |
| GPT-5.6 Sol | 4.00 | 0.40 | 20.00 | 13 |
| Claude Opus 5.5 | 4.00 | 0.20 | 20.00 | 10 |
| GPT-5.6 Terra | 2.00 | 0.20 | 12.00 | 6.8 |
| GPT-6 Sol | 2.00 | 0.20 | 10.00 | 6.5 |
| GPT-6.1 Sol | 2.00 | 0.10 | 10.00 | 5 |
| Claude Sonnet 5.5 | 2.00 | 0.10 | 10.00 | 5 |
| GPT-6.1 Terra | 1.00 | 0.05 | 5.00 | 2.5 |
| GPT-5.6 Luna | 0.20 | 0.02 | 1.20 | 0.68 |
| GPT-6 Luna | 0.10 | 0.01 | 0.50 | 0.32 |
| Claude Haiku 5.5 (from) | 0.10 | 0.01 | 0.50 | 0.32 |

Subscriptions do not publish their weights, but Codex's stated limits follow the same ratios. Local messages per five hours on
Plus: Astra 5-45, GPT-6.1 Sol 15-160, GPT-6.1 Terra 35-285, GPT-6 Luna 350-3,000.

## Scores

Scores are judgment informed by the numbers below. They are starting points, and logged outcomes move them per user.

Public evidence per task type, collected on 2026-11-10 by web search and spot-checked at the source. Vendor numbers are
the vendor's own runs; harness, effort and metric differ between rows, so compare within one benchmark only.

| Task type | Best public signal | What it shows |
|---|---|---|
| implementation | DeepSWE v1.1, SWE-bench Pro, FrontierCode (vendor) | Gemini 4 Argon 77.9%, GPT-6.1 Sol 75.2% (high), GPT-6 Astra 74.1%, Gemini 3.8 Flash 73.7%, Grok 4.7 71.0%, GPT-6 Sol 68.8%, GPT-6 Luna 66.6% (max) on DeepSWE. Claude reports FrontierCode instead: Sonnet 5.5 52.1% (xhigh, v1.1), Haiku 5.5 46.4% (v1.1), Fable 5.2 49.1% and Opus 5.5 45.5% (v2.0). GPT-5.6 Sol/Terra/Luna 64.6/63.4/62.7% on SWE-bench Pro. |
| debugging | Terminal-Bench 4.1 board (Snorkel), 2026-11-09 | Opus 5.5 65.8%, Sonnet 5.5 63.9%, GPT-6.1 Sol 60.9%, GPT-6 Astra 60.3%, GPT-6 Sol 50.3%, Grok 4.7 38.8%, GPT-5.6 Sol 38.5%, GPT-5.6 Terra 21.5%, Gemini 3.8 Flash 18.2%, GPT-5.6 Luna 17.6%, GPT-6 Luna 15.2%. Vendor Terminal-Bench 4.0: Gemini 4 Argon 57.4%, GPT-6.1 Terra 50.3% (max), Haiku 5.5 39.2%. |
| architecture | proxies only: Humanity's Last Exam with tools, ARC-AGI-2, GPQA Diamond | No benchmark measures software design. HLE with tools (Anthropic): Fable 5.2 74.2%, Opus 5.5 67.7%, Sonnet 5.5 64.5%, Haiku 5.5 57.4%. ARC-AGI-2 (ARC Prize, verified): Gemini 4 Argon 91.3%, GPT-6 Sol 89.6%, Grok 4.7 61.4%, GPT-6 Luna 59.3%. |
| review | Qodo real-bug PR benchmark (F1), CodePanel, MacroscopeBench, Martian Code Review Bench | All from review-product vendors with different metrics. Qodo F1: Opus 5.5 56.8%, Sonnet 5.5 54.9%, GPT-6 Sol 48.7%, Gemini 3.8 Flash 47.0%, GPT-6 Astra 46.6%, GPT-6 Luna 42.2%. CodePanel bugs caught: GPT-6.1 Sol 89%, Gemini 4 Argon 82%, GPT-5.6 Sol 72%, Haiku 5.5 64%. MacroscopeBench: GPT-6.1 Terra 82.3, Fable 5.2 78.5. |
| research | BrowseComp, HLE with tools, WANDR (vendor) | GPT-6 Astra 91.5% and GPT-5.6 Sol/Terra/Luna 90.4/87.5/83.3% on BrowseComp; Fable 5.2 82.1% and Opus 5.5 72.3% on WANDR. No public research numbers for GPT-6.1 Sol, Terra, GPT-6 Sol, Luna, Grok or Gemini. |
| mechanical | IFEval subset (Measured Lab), 2026-10-22 | GPT-6 Sol 100%, Opus 5.5 98%, Gemini 3.8 Flash 98%, Sonnet 5.5 92%, Haiku 5.5 82%. Small subset, and it tests instruction following, not exact edits. |

No public data: Fable 5.2 for debugging and mechanical work, GPT-6.1 Terra for architecture, Grok Build apart from Grok 4.7,
and most models for mechanical work.

Where the evidence and the scores differ, the scores stay for now and logged outcomes decide:

- **GPT-6.1 Terra** is rated 6 for debugging and review, but it matches GPT-6 Sol (rated 7) on Terminal-Bench at max effort
  and leads MacroscopeBench. Both are single vendor numbers at high effort.
- **Claude Haiku 5.5** is rated 5 for debugging, level with GPT-5.6 Sol (rated 6) on Terminal-Bench 4.0, but that number
  is the vendor's own and is not on the board.
- **Grok 4.7** and **Gemini 3.8 Flash** score high on DeepSWE (vendor) but low on the independent Terminal-Bench board, so
  their implementation scores stay at 6.
- **GPT-6 Luna** stays low for implementation despite 66.6% on DeepSWE at max effort: 15.2% on Terminal-Bench, and see below.

Earlier single table, kept for comparison: Artificial Analysis Coding Agent Index v1.5 (reported 2026-10-05): Sonnet 5.5
first, Opus 5.5 second, Gemini 4 Argon 64, GPT-6.1 Sol at xhigh 63, GPT-6 Astra at max 62, Fable 5.1 62.

What follows from that:

- **Sonnet 5.5** is rated level with Opus for implementation and one point below it for debugging, at half the price.
- **GPT-6.1 Sol** matches Astra on these benchmarks at about a sixth of the cost, so Astra rarely wins a route.
- **GPT-6 Luna** is rated low for implementation. It is the cheapest option, and with a high score it would win every normal
  job and then fail most of them. OpenAI positions it for focused, high-volume work, which is where it stays.
- **Fable 5.2** has no worker, because its usage may bill to credits instead of plan limits. It only applies when you pick it as the boss.

## Effort

`low`, `medium`, `high` and `xhigh` are routable. Both vendors offer `max`, and Codex offers `ultra`. The router leaves those
out because OpenAI says most tasks do not need them and Anthropic warns that `max` can overthink.

The further a model is above a job, the less effort it gets (see [ROUTING.md](ROUTING.md)). OpenAI suggests starting GPT-6 Luna
at high, which is its `minEffort`.

Verified feedback can record `--effort <level>`: two failures exceeding passes at the exact model, category, tier and level raise future effort, never lower it. Failures below a candidate level and passes above it count half toward its success probability; older outcomes keep full weight.

No vendor publishes how effort changes usage, so it is measured: `node bench/effort.js` gives one fixed task (an exact
scheduler with a hidden check) to a model at every level. `effortCost` in `config/thresholds.json` is the estimate for
models without a measurement (`low` 0.85, `medium` 1, `high` 1.25, `xhigh` 1.6), and `effortCostByModel` holds the measured
values, as cost against `medium`:

| Model | `low` | `high` | `xhigh` | Output tokens at `medium` and `xhigh` | Seconds at `medium` and `xhigh` | Measured |
|---|---|---|---|---|---|---|
| Fable 5.2 | 0.8 | 1.7 | 3.6 | 3879 and 19634 | 38 and 195 | 2026-11-11, one run per level (two at `low`) |
| Opus 5.5 | 0.85 | 1.35 | 3.5 | 2484 and 13932 | 22 and 130 | 2026-11-11, two runs per level |
| Sonnet 5.5 | 1 | 1.1 | 1.75 | 2042 and 5088 | 16 and 37 | 2026-11-11, two runs per level |
| Haiku 5.5 | 0.9 | 1.4 | 2.65 | 4673 and 15949 | 21 and 65 | 2026-11-11, two runs per level |
| GPT-6.1 Sol | 0.85 (estimate) | 1.65 | 3.4 | 1489 and 9540 | 36 and 228 | 2026-11-10, two runs per level, an earlier scheduler task |
| GPT-6.1 Terra | 0.95 | 1 | 1.45 | 1222 and 2641 | 30 and 56 | 2026-11-11, two runs per level |
| GPT-6 Luna | 0.9 | 1.4 | 1.6 | 1721 and 3889 | 39 and 76 | 2026-11-11, two runs per level |

The strongest models react most: Fable 5.2, Opus 5.5 and GPT-6.1 Sol write five to six times the output at `xhigh` and take
five to six times as long, while Sonnet 5.5 and GPT-6.1 Terra hardly change up to `high`. The values also count input tokens,
which do not grow with effort: 38k input at 80% cached, cached input at 0.1 and output at 6 (Codex) or 5 (Claude) times the
input price. They fit hard jobs, which are the ones that get these levels: on a simple task (merging intervals) GPT-6.1 Sol
stayed at 1.12 for `high` and 1.25 for `xhigh`. One or two runs per level is a small sample.

All Claude runs passed the hidden check. Four of 16 Codex runs did not: GPT-6 Luna returned wrong orders once at `xhigh`,
and three runs failed while writing the file on Windows (a refused write, and twice a leftover patch marker in GPT-6.1 Terra's
file at `low` and `medium`). Their token counts are still in the averages.

The boss's own work is charged at its session level with the same values. In the table this has two effects: a Fable 5.2 or
Opus 5.5 boss at `high` hands a little more trivial work down, and normal mechanical work goes to Haiku 5.5 at `medium`
instead of GPT-6 Luna, whose minimum level `high` now costs 1.4. With no usage at all, Sonnet 5.5 and GPT-6.1 Sol tie for critical
implementation under an Opus 5.5 boss; from about 5% Claude use the job goes to GPT-6.1 Sol as before.

## Other providers

Each gets several models and, where its CLI allows it, a reasoning level. A CLI template takes the level through `{effort}`.

| Provider | Models | Effort | Run on this project's machine? |
|---|---|---|---|
| Grok | `grok-4.7` (cost 10, 37.6% on Terminal-Bench 4.0 at xhigh with Grok Build) and `grok-build-0.1` (cost 4.2, no benchmark found) | `--effort` | No, the CLI is not installed. Flags are from xAI's reference. |
| Google Antigravity | Gemini 4 Argon (cost 10, 64 on the Coding Agent Index) and Gemini 3.8 Flash (cost 4.9, 19.1% on Terminal-Bench 4.0 from one site) | part of the slug, for example `gemini-4-argon-high`: only `medium` and `high` | No, the CLI is not installed. Slugs are from Google's headless docs. |
| GitHub Copilot | `auto`, plus `gpt-6.1-sol` and `gpt-6-luna`, which are off by default because they depend on the plan | `--reasoning-effort` on pinned models; `auto` refuses it | Yes, `auto` only |

Costs for Gemini use the prices that apply from 2026-12-01 (Argon) and 2027-01-01 (Flash), when both double.

A test account on a limited Copilot plan rejected every pinned model tried. With `auto`, `--auto-tier intelligence` selected GPT-5.6 Luna,
and the `efficiency` tier no longer exists. So `copilot-default` is rated and priced like GPT-5.6 Luna, and logged outcomes raise it on better plans.
To use the pinned models on a paid plan, copy their entries into your `config/models.json` and remove `"enabled": false`.

## Sources

- [Codex models](https://learn.chatgpt.com/docs/models) and [Codex pricing](https://learn.chatgpt.com/docs/pricing)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)
- [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config) and [subagents](https://code.claude.com/docs/en/sub-agents)
- [Terminal-Bench 4.0 leaderboard summary](https://codingfleet.com/blog/terminal-bench-4-leaderboard-2026/)
- [Coding Agent Index report](https://officechai.com/ai/gemini-4-argon-with-antigravity-places-ahead-of-gpt-6-1-sol-on-codex-on-artificial-analysis-coding-agent-index/)
- [Gemini models](https://aistudio.google.com/docs/models) and [Gemini pricing](https://aistudio.google.com/docs/pricing)
- [Antigravity headless mode](https://antigravity.google/docs/cli/headless)
- [xAI models](https://docs.x.ai/docs/models) and [Grok CLI reference](https://docs.x.ai/build/cli/reference)
- [GitHub Copilot supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- Per task type: [Terminal-Bench board](https://snorkel.ai/leaderboard/terminal-bench/),
  [Qodo PR review benchmark](https://www.qodo.ai/blog/which-llm-should-review-your-code/), [CodePanel](https://codepanel.ai/benchmarks),
  [MacroscopeBench](https://prasso.ai/benchmark), [Martian Code Review Bench](https://ironbee.ai/blog/the-honest-raw-llm-code-review-benchmark),
  [ARC Prize results](https://arcprize.org/results/openai-gpt-6-sol), [Measured Lab IFEval](https://measuredlab.com/ai-models/objects/anthropic-claude-opus-5.5/),
  vendor pages: [Claude Fable 5.2](https://www.anthropic.com/claude-fable-and-mythos-5-2), [Claude Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5),
  [Claude Haiku 5.5](https://www.anthropic.com/claude-haiku-5-5), [GPT-6 Astra](https://openai.com/index/gpt-6-astra/),
  [GPT-6 Sol and Luna](https://openai.com/index/introducing-gpt-6-sol-and-luna/), [GPT-6.1 Terra](https://openai.com/index/introducing-gpt-6-1-terra/),
  [GPT-5.6](https://openai.com/index/gpt-5-6/), [Grok 4.7](https://x.ai/news/grok-4-7), [Gemini 4 Argon](https://deepmind.google/models/model-cards/gemini-4-argon/),
  [Gemini 3.8 Flash](https://deepmind.google/models/model-cards/gemini-3-8-flash/)
- [Terminal-Bench 4.0 on Snorkel](https://snorkel.ai/leaderboard/terminal-bench-4-0/) and [Gemini 3.8 Flash vs Grok 4.7](https://aireleasetracker.com/compare/google/gemini-3.8-flash/xai/grok-4.7)
