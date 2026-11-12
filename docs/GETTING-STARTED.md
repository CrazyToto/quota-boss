# Getting started

You need Node 18 or newer and Claude Code or Codex. Everything else is offered during setup.

## 1. Install

```
node install.js
```

If a provider CLI is missing or outdated, the installer shows one list and asks once.

## 2. Set up

Type **/boss-setup** in Claude Code. It shows one command to start the setup in your own terminal, so that nothing
mixes with the chat. Run it from your project folder. The setup goes step by step and explains each option where
you decide: what it is, what happens when it is on or off, the catch, and what you need. You can move between pages
with `f` and `b`, and Ctrl+C stops without changes.

Without Claude Code, run `node "<home>/scripts/quota-boss.js" setup` in your project folder instead and pick Codex as
the assistant; the installer prints the exact path. Claude then is an optional worker through the `claude` CLI, off
when that CLI is missing.

Nothing changes until the summary at the end, which lists every choice and the exact install commands with their
sources. You answer once, then it:

1. installs what your choices need and reports each program,
2. saves your choices. A provider only ends up on if its program is really there,
3. offers each login that is still missing, one at a time. On Windows each opens in its own window, so the setup stays visible.

`quota-boss explain providers.<name>` shows the explanation for one option at any time.

## 3. Choose what to use

### Subscriptions

Your own login through the provider's official CLI. No API costs.

| Service | Needs | Install | Login |
|---|---|---|---|
| Claude | Claude plan | automatic | `claude auth login` |
| ChatGPT | ChatGPT plan | automatic | `codex login` |
| GitHub Copilot | Copilot plan, free for verified GitHub Education students | automatic | `copilot login` |
| Grok | See xAI's plans | paste one command, shown in setup | `grok login` |
| Gemini | Google account | [Antigravity CLI guide](https://antigravity.google/docs/install) | `agy` |

Claude and ChatGPT are tested end to end. Copilot, Grok and Antigravity are wired up from their official docs
and marked off until you enable them. Gemini CLI was replaced by Antigravity CLI for free and Google One users.

**Antigravity is an account risk:** Google's terms call using third-party software to reach the service a breach and
allow suspending your account. Whether starting Google's own program from Quota Boss counts is unclear. See
[Provider terms](PROVIDERS.md#provider-terms).

### Free offers

The setup asks about them together: all of them, only those that do not train on your data, none, or one by one under
Advanced. If you pick a group and skip a key, that offer is left out. `quota-boss doctor` shows any offer with a
missing key or a model that is gone. A rate-limited offer is paused for 15 minutes and the next one takes over.

Limits change often, so check the provider's page. Offers that may train on your data stay blocked per project
until you run `quota-boss set training on`.

Groq and SambaNova are not offered. Groq's free limit of 8,000 tokens a minute is smaller than a single OpenCode
request, and SambaNova asks for a payment method.

| Offer | How to add | Rough limit | May train on your data |
|---|---|---|---|
| OpenRouter free models (needs OpenCode) | choose it in the setup | 50 requests/day | treated as yes |
| Mistral Experiment (needs OpenCode) | choose it in the setup | about 1 billion tokens/month, 2 requests/minute (reported, check your console) | yes, unless you turn it off in Mistral's Admin area |
| Cloudflare Workers AI (needs OpenCode) | choose it in the setup | 10,000 Neurons/day | treated as yes |
| Cohere trial (needs OpenCode) | choose it in the setup | 1,000 calls/month | treated as yes |
| Gemini API (needs OpenCode) | choose it in the setup | not confirmed | yes, and humans may read it |
| NVIDIA NIM (needs OpenCode) | choose it in the setup | about 40 requests/minute (reported) | treated as yes |
| Z.ai GLM-4.7-Flash (needs OpenCode) | choose it in the setup | none published | treated as yes |
| OpenCode Zen GLM and DeepSeek (needs OpenCode, no key) | choose them in the setup | none published, free for a limited time | no |
| OpenCode's default free model | `quota-boss use opencode-free on` | varies | yes |
| Kilo Auto Free (needs Kilo CLI, no key) | choose it in the setup or `quota-boss use kilo-free on` | none published; may be rate limited | yes; providers may log prompts and outputs for improvement, so do not send personal or confidential data |

### Any other API

The setup asks whether you want to add one. Later, run **/boss-add-api**, or directly:

```
quota-boss add-api my-api provider/model --trains no --budget 5 usd monthly
opencode auth login
```

Run `opencode models` to see valid `provider/model` names. Your key stays in OpenCode and Quota Boss never sees it.
Enter an API key there, never a subscription login: Anthropic and Google do not allow those in other tools.
OpenCode covers most APIs out of the box. `quota-boss remove-api my-api` undoes this.

### Perplexity

Perplexity Pro has no API in the subscription, and automating its website would break its terms. Instead,
the `researcher` agent writes an optimized prompt and copies it to your clipboard, together with a model
suggestion (for example Gemini). You paste it into Perplexity and return the answer with `/pplx-result`.

## Code graph (optional)

Setup asks whether to add Graphify to this folder and builds a map of which file and function uses which.
Building the code map runs on your computer and costs no Claude usage. It mostly pays off above a few dozen files.
Stale maps refresh in the background at session start. You can also run `graphify update .` locally to refresh the map.
Optional: type `/graphify .` in Claude Code for docs, PDFs and images; this extra costs Claude usage.
It adds a `graphify-out` folder (excluded from Git), a Claude Code skill and a line in your global `~/.claude/CLAUDE.md`.

[Graphify](https://graphify.com/blog/install-graphify) is Apache-2.0. To install it yourself, run
`uv tool install graphifyy && graphify install`.
Existing `graphify-out/graph.json`, `graphify-out/GRAPH_REPORT.md` or root `GRAPH_REPORT.md` adds one fixed hint
at session start. Scout prefers the graph or available codebase-memory/serena MCP tools, then targeted file excerpts.
`quota-boss doctor` reports Graphify output and registered codebase-memory, serena and gitnexus servers;
only doctor calls `claude mcp list`, never hooks. Registration means configured, not a connectivity test.

## Long sessions

A large context costs more on every message and can lower quality. In Claude Code, the status line shows it as `ctx 42k 4%`.

From 100,000 tokens, or 60% of a smaller window, Quota Boss asks Claude to finish the current step and then:

- in the middle of a task, asks you to type `/compact`. Claude Code summarizes the session and keeps going in it, so
  the task details stay. It takes about a minute and one summary call.
- at the end of a task, saves a handoff. Then you type `/clear` and send any message, and the new session already has
  the notes. It starts smaller than a compacted one, so this is the cheaper way into the next task.

Claude Code does not let tools run `/compact` or `/clear`, so that step stays yours. There is no official number for this threshold, so adjust it to taste:
`quota-boss set context 100000`, or `quota-boss set context off` to stop the suggestion.

After a pause of an hour or more in a large Claude Code session, Quota Boss stops your next message once, before anything reaches the model or pays for the expired cache. Type `/clear` for a new topic, or `/compact` to read the session once and continue small on the same task. Send your message again to continue as it is. `quota-boss set context off` turns off this check and the size suggestion.

Handoffs are stored per project in the Quota Boss folder, not in your project, and each one names the file with the
full history of that session. `quota-boss handoff list` and `quota-boss handoff show` find them again. A brand new
session only gets a pointer, so unrelated work starts clean.

## Advanced: local models

Only worth it if you already run local models. You need a capable computer and pick and download the model yourself.
Local models take small tasks only and are not part of the normal setup. Use **/boss-local**, or directly:

```
quota-boss local on llama3.2:3b
ollama pull llama3.2:3b
```

`quota-boss local off` turns them off again.

## If something goes wrong

| Message | What to do |
|---|---|
| `open a new terminal` | The tool is installed but this terminal has an old PATH. Open a new one and run setup again. |
| `installed but not starting` | Choose install in setup to repair it. Another program may be using the same command name. |
| `older copy still comes first on PATH` | Remove the older copy, for example one installed by another package manager. |
| `FAILED (... EACCES ...)` | npm cannot write its global folder. See [npm's guide](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally). |
| `NOT logged in` | Run the setup again, or type the listed login in a terminal. |
| `Stayed off because the program is missing` | Install it, or open a new terminal if the setup said so, then run the setup again. |
