'use strict';
// Plain-language help for every provider choice. It lives in code, not config, so updates always reach
// existing installs and user configuration can never change what the setup tells people.

const yours = 'Your subscriptions', more = 'Other subscriptions', free = 'Free offers';

const UNCONFIRMED_TRAINING = 'We could not confirm whether it trains on your data, so Quota Boss treats it as if it does.';
const JUNIE_DATA = 'JetBrains\' docs do not say whether Junie CLI data is used for training. Its product data collection FAQ says detailed code-related data sharing is on by default for non-commercial licenses (free accounts, likely student licenses too); turn it off in a JetBrains IDE under Settings | Appearance & Behavior | System Settings | Data Sharing. Source: https://www.jetbrains.com/legal/docs/terms/product_data_collection_faq/';
const SCRIPTED_CLAUDE_WARNING = 'Claude then runs as a scripted helper. Anthropic\'s consumer terms allow scripted access only with an API key or where Anthropic explicitly permits it, so a Claude plan may be at risk. Set ANTHROPIC_API_KEY for the helper, or run: quota-boss use claude off';

const PROVIDER_HELP = Object.freeze({
  claude: { group: yours, name: 'Claude', what: 'Your Claude plan. It runs the boss, which plans the work and checks the results.',
    on: 'Claude does the hard thinking and hands simpler work to others.',
    off: 'Cannot be turned off while Claude Code is your main assistant.',
    catch: 'Its limits are the ones you most want to protect.', needs: 'A Claude plan.' },
  codex: { group: yours, name: 'ChatGPT (Codex)', what: 'ChatGPT does coding tasks through the official Codex program and reviews important changes as a second opinion.',
    on: 'Normal coding tasks go to ChatGPT, so your Claude limit lasts much longer, and important changes get a second opinion from a different AI.',
    off: 'Claude writes everything itself, reaches its limit sooner, and nobody independent checks its work.',
    catch: 'Uses your ChatGPT limit.', needs: 'A ChatGPT plan and the Codex program.' },
  perplexity: { group: yours, name: 'Perplexity', what: 'Research with sources. You paste a prepared prompt into Perplexity and bring back the answer.',
    on: 'Source-heavy research uses your Perplexity plan instead of Claude or ChatGPT.',
    off: 'Claude does research with its own web search, which uses Claude limit.',
    catch: 'Manual: you copy and paste each time, because automating the website is not allowed.', needs: 'A Perplexity plan.' },
  'junie-lite': { group: more, name: 'Junie Lite (free)', what: 'JetBrains\' free Junie Lite model through the official Junie CLI. JetBrains\' docs say it does not expire; its announcement says the offer is valid until 31 Dec 2026 and the model is not trained on your code.',
    on: 'Small and routine coding tasks that cost none of your paid limits, whenever the free model is not busy.',
    off: 'Small tasks use your paid limits instead.',
    catch: 'No request limit is published. When busy, Junie retries for about 5 minutes. JetBrains may change the model. Junie trusts the project folder and loads its MCP servers, hooks and skills.',
    needs: 'A free JetBrains account. Quota Boss installs Junie and starts the login.',
    warning: JUNIE_DATA },
  copilot: { group: more, name: 'GitHub Copilot', what: 'GitHub Copilot through its official command-line program.',
    on: 'One more limit for normal coding tasks, so Claude and ChatGPT last longer.',
    off: 'Nothing is lost if you have no Copilot plan.',
    catch: 'The free student plan has a small monthly allowance and little model choice. Quota Boss only counts calls, so its number is rough.',
    needs: 'A Copilot plan. Verified GitHub Education students get one free: check Copilot settings on github.com. Setup installs the program.' },
  grok: { group: more, name: 'Grok', what: 'xAI\'s Grok through its official Grok Build program.',
    on: 'One more limit for normal coding tasks.', off: 'Nothing is lost if you have no Grok plan.',
    catch: 'Tests count against your Grok limit.', needs: 'A plan that includes Grok Build. Check xAI\'s plans.' },
  antigravity: { group: more, name: 'Google Antigravity', what: 'Google Gemini through the Antigravity program, which replaced Gemini CLI for free and Google One users.',
    on: 'One more limit for normal coding tasks and research.', off: 'Nothing is lost if you do not use Google\'s AI.',
    catch: 'You install it by hand. Quota Boss runs it in auto mode, so it can edit files without you approving each step.', needs: 'A Google account.',
    warning: 'Account risk. Google\'s Antigravity terms call using third-party software to reach the service a breach and allow suspending your account, and people report such suspensions. Quota Boss only starts Google\'s own program, but whether that is allowed is unclear.' },
  jetbrains: { group: more, name: 'JetBrains AI (Junie)', what: 'Your JetBrains AI plan through the official Junie CLI, with models such as GPT, Claude and Gemini.',
    on: 'One more limit for normal coding tasks.', off: 'Nothing is lost if you have no JetBrains AI plan.',
    catch: 'Uses JetBrains AI credits. Quota Boss cannot see the balance. Junie trusts the project folder and loads its MCP servers, hooks and skills.',
    needs: 'JetBrains AI Pro or Ultimate, which is included for verified GitHub Education students, and your JetBrains account logged in once in Junie.',
    warning: JUNIE_DATA },
  'kilo-free': { group: free, name: 'Kilo Free', what: 'Kilo Auto Free through the Kilo CLI for small coding tasks.',
    on: 'Small tasks cost none of your paid limits.', off: 'Small tasks use your paid limits instead.',
    catch: 'Kilo allows 200 anonymous free requests per hour per IP address. See https://kilo.ai/docs/gateway/authentication. Free models may change.',
    needs: 'The Kilo CLI, which setup installs. No account or key was needed in testing.',
    warning: 'Kilo says Auto Free may route to providers that log prompts and outputs and use them to improve their services. Do not send personal or confidential data.' },
  'openrouter-free': { group: free, preset: true, name: 'OpenRouter Free', what: 'OpenRouter\'s free models, added through the OpenCode program.',
    on: 'About 50 free requests a day for small tasks.', off: 'Small tasks use your paid limits instead.',
    catch: 'A small allowance, and free models may train on your data. A balance of 0 is normal, because this offer only uses a free model.', needs: 'A free OpenRouter account and the OpenCode program, which setup installs.' },
  cloudflare: { group: free, preset: true, name: 'Cloudflare Workers AI',
    what: 'Open models on Cloudflare\'s free daily allowance, added through the OpenCode program.',
    on: '10,000 free Neurons a day for small tasks.', off: 'Small tasks use your paid limits instead.',
    catch: 'Neurons are a Cloudflare unit, so a long task can use many. Weak on hard tasks.',
    needs: 'A free Cloudflare account, an API token with Workers AI Read and Edit permissions, your account ID (OpenCode may ask for it or read CLOUDFLARE_ACCOUNT_ID), and the OpenCode program, which setup installs.',
    warning: UNCONFIRMED_TRAINING },
  cohere: { group: free, preset: true, name: 'Cohere',
    what: 'Cohere\'s trial API key, added through the OpenCode program.',
    on: '1,000 free calls a month for small tasks.', off: 'Small tasks use your paid limits instead.',
    catch: 'A small allowance, and a trial key is meant for trying things out.',
    needs: 'A free Cohere account and the OpenCode program, which setup installs.',
    warning: 'Trial key, not for production or commercial use. ' + UNCONFIRMED_TRAINING },
  'gemini-api': { group: free, preset: true, name: 'Gemini API',
    what: 'Google\'s unpaid Gemini API by API key, added through the OpenCode program. This is separate from Antigravity.',
    on: 'Free calls for small tasks.', off: 'Small tasks use your paid limits instead.',
    catch: 'The free limit could not be confirmed, so check Google AI Studio. Use an API key, never a Google subscription login.',
    needs: 'A free key from Google AI Studio and the OpenCode program, which setup installs.',
    warning: 'On the unpaid tier Google\'s terms say your content is used to improve its products and humans may read it, and that the API is not for consumer use. Do not send private code.' },
  nvidia: { group: free, preset: true, name: 'NVIDIA NIM',
    what: 'NVIDIA\'s hosted open models by API key, added through the OpenCode program.',
    on: 'Free calls for small tasks, about 40 requests a minute as reported by OmniRoute.', off: 'Small tasks use your paid limits instead.',
    catch: 'Weak on hard tasks, and the limit is not confirmed by NVIDIA.',
    needs: 'A free NVIDIA developer account and the OpenCode program, which setup installs.',
    warning: 'Trial terms: evaluation only, no production, no confidential code. ' + UNCONFIRMED_TRAINING },
  'zen-deepseek': { group: free, preset: true, name: 'OpenCode Zen DeepSeek',
    what: 'The free DeepSeek V4.1 Flash model on OpenCode Zen, through the OpenCode program. OpenCode says its provider keeps no data and does not train on it.',
    on: 'Free calls for small tasks, with no key to create.', off: 'Small tasks use your paid limits instead.',
    catch: 'Free only for a limited time, so it can disappear, and no limit is published. Weak on hard tasks.',
    needs: 'The OpenCode program, which setup installs. No account or key.' },
  zai: { group: free, preset: true, name: 'Z.ai',
    what: 'Z.ai\'s free GLM-4.7-Flash model by API key, added through the OpenCode program.',
    on: 'Free calls for small tasks.', off: 'Small tasks use your paid limits instead.',
    catch: 'Z.ai publishes no limit for its free models, and your data is generally processed in Singapore. Weak on hard tasks.',
    needs: 'A free Z.ai account, an API key, and the OpenCode program, which setup installs.',
    warning: 'Z.ai terms IV.7 say developer API content is not used for training without agreement.' },
});

// A question in the setup, not a provider, so it stays out of the provider guide.
const CODE_GRAPH_HELP = Object.freeze({
  name: 'Code graph (Graphify)', what: 'A map of this project: which file and function uses which. Claude looks things up there instead of reading whole files.',
  on: 'On bigger projects far fewer files get read, which saves context and limits.',
  off: 'Claude searches and reads files as usual. On a small project you lose nothing.',
  catch: 'Setup builds the code map on your computer with no Claude usage. Stale maps refresh in the background at session start. Optional: /graphify . adds docs, PDFs and images; this extra costs Claude usage. It adds a graphify-out folder, a Claude Code skill and a line in your CLAUDE.md.',
  needs: 'The free Graphify program (Apache-2.0), which setup installs. It mostly pays off above a few dozen files.' });

const CUSTOM_HELP = Object.freeze({ what: 'An API you added yourself.', on: 'It can take small tasks.', off: 'Its tasks go to your other providers.',
  catch: 'It may cost money per use, depending on that service.', needs: 'An API key stored in OpenCode. Never use a subscription login there.' });

function block(id, help, state) {
  return ['- ' + id + ' [' + state + ']: ' + help.what, '    On: ' + help.on, '    Off: ' + help.off, '    Catch: ' + help.catch, '    You need: ' + help.needs,
    ...(help.warning ? ['    Warning: ' + help.warning] : [])];
}

function stateOf(id, help, providers) {
  if (help.preset && !providers[id]) return 'not added';
  return providers[id]?.enabled === false ? 'off' : 'on';
}

/** Everything the setup needs to explain each choice before anyone has to decide. */
function guide(config) {
  const providers = config.providers.providers;
  const lines = [];
  for (const group of [yours, more, free]) {
    lines.push(group);
    for (const [id, help] of Object.entries(PROVIDER_HELP)) if (help.group === group) lines.push(...block(id, help, stateOf(id, help, providers)));
  }
  const custom = Object.entries(providers).filter(([id, p]) => p.custom === true && !Object.hasOwn(PROVIDER_HELP, id));
  if (custom.length) lines.push('APIs you added', ...custom.flatMap(([id, p]) => block(id, CUSTOM_HELP, p.enabled === false ? 'off' : 'on')));
  return lines.join('\n');
}

// Benched by the maintainer. A paid docs-only provider stays gated by its self-test, which also proves the CLI and
// login work on this machine; a free one proves itself with its first real trivial jobs.
const MAINTAINER_TESTED = new Set(['junie-lite']);
function evidenceNotice(id) {
  const provider = require('./lib').BUILTIN_PROVIDERS.providers[id];
  if (provider?.evidence !== 'docs') return '';
  return (MAINTAINER_TESTED.has(id) ? 'Tested end to end by the maintainer.'
    : "Not run end to end by the maintainer yet, built from the vendor's documentation.")
    + (['free', 'local'].includes(provider.kind)
      ? ' It starts with small jobs, and verified passes open routine work.'
      : ' Quota Boss gives it no work until its self-test (quota-boss providers test ' + id + ') passes.');
}

/** The sentence added after a provider switch, so every change says what it means. */
function switchEffect(id, enabled) {
  const help = Object.hasOwn(PROVIDER_HELP, id) ? PROVIDER_HELP[id] : null;
  if (!help) return '';
  return ' ' + (enabled ? help.on + (evidenceNotice(id) ? ' ' + evidenceNotice(id) : '') + (help.warning ? ' Warning: ' + help.warning : '') : help.off);
}

module.exports = { PROVIDER_HELP, UNCONFIRMED_TRAINING, CODE_GRAPH_HELP, SCRIPTED_CLAUDE_WARNING, guide, switchEffect };
