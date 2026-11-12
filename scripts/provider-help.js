'use strict';
// Plain-language help for every provider choice. It lives in code, not config, so updates always reach
// existing installs and user configuration can never change what the setup tells people.

const yours = 'Your subscriptions', more = 'Other subscriptions', free = 'Free offers';

const UNCONFIRMED_TRAINING = 'We could not confirm whether it trains on your data, so Quota Boss treats it as if it does.';
const SCRIPTED_CLAUDE_WARNING = 'Claude then runs as a scripted helper. Anthropic\'s consumer terms allow scripted access only with an API key or where Anthropic explicitly permits it, so a Claude plan may be at risk. Set ANTHROPIC_API_KEY for the helper, or run: quota-boss use claude off';

const PROVIDER_HELP = Object.freeze({
  claude: { group: yours, name: 'Claude', what: 'Your Claude plan. It runs the boss, which plans the work and checks the results.',
    on: 'Claude does the hard thinking and hands simpler work to others.',
    off: 'Cannot be turned off while Claude Code is your main assistant.',
    catch: 'Its limits are the ones you most want to protect.', needs: 'A Claude plan.' },
  'workers.codex': { group: yours, name: 'ChatGPT coding tasks', what: 'ChatGPT does coding tasks through the official Codex program.',
    on: 'Normal coding tasks go to ChatGPT, so your Claude limit lasts much longer.',
    off: 'Claude writes everything itself and reaches its limit sooner.',
    catch: 'Uses your ChatGPT limit.', needs: 'A ChatGPT plan and the Codex program.' },
  'workers.gpt': { group: yours, name: 'GPT second reviewer', what: 'GPT reads your code as a second reviewer and changes nothing.',
    on: 'Important changes get a second opinion from a different AI, which catches mistakes Claude misses.',
    off: 'Nobody independent checks Claude\'s work. Saves a little ChatGPT limit.',
    catch: 'Each review uses some of your ChatGPT limit.', needs: 'A ChatGPT plan and the Codex program.' },
  'workers.perplexity': { group: yours, name: 'Perplexity', what: 'Research with sources. You paste a prepared prompt into Perplexity and bring back the answer.',
    on: 'Source-heavy research uses your Perplexity plan instead of Claude or ChatGPT.',
    off: 'Claude does research with its own web search, which uses Claude limit.',
    catch: 'Manual: you copy and paste each time, because automating the website is not allowed.', needs: 'A Perplexity plan.' },
  copilot: { group: more, name: 'GitHub Copilot', what: 'GitHub Copilot through its official command-line program.',
    on: 'One more limit for normal coding tasks, so Claude and ChatGPT last longer.',
    off: 'Nothing is lost if you have no Copilot plan.',
    catch: 'The free student plan has a small monthly allowance and little model choice. Quota Boss only counts calls, so its number is rough.',
    needs: 'A Copilot plan. Verified GitHub Education students get one free: check Copilot settings on github.com. Setup installs the program.' },
  grok: { group: more, name: 'Grok', what: 'xAI\'s Grok through its official Grok Build program.',
    on: 'One more limit for normal coding tasks.', off: 'Nothing is lost if you have no Grok plan.',
    catch: 'You paste one install command yourself.', needs: 'A plan that includes Grok Build. Check xAI\'s plans.' },
  antigravity: { group: more, name: 'Google Antigravity', what: 'Google Gemini through the Antigravity program, which replaced Gemini CLI for free and Google One users.',
    on: 'One more limit for normal coding tasks and research.', off: 'Nothing is lost if you do not use Google\'s AI.',
    catch: 'You install it by hand. Quota Boss runs it in auto mode, so it can edit files without you approving each step.', needs: 'A Google account.',
    warning: 'Account risk. Google\'s Antigravity terms call using third-party software to reach the service a breach and allow suspending your account, and people report such suspensions. Quota Boss only starts Google\'s own program, but whether that is allowed is unclear.' },
  'mistral-api': { group: free, preset: true, name: 'Mistral', what: 'Mistral\'s free Experiment API plan by API key, added through the OpenCode program.',
    on: 'A large free allowance for small tasks, though only 2 requests a minute are reported.',
    off: 'Small tasks use your paid limits instead.',
    catch: 'Mistral may use your requests for training unless you opt out in its Admin area. Weak on hard tasks and slow when several tasks queue. The limits are as reported, so check them in your console.',
    needs: 'A free Mistral account, reportedly with a verified phone number, an API key from admin.mistral.ai, which the free plan allows, and the OpenCode program, which setup installs.' },
  'opencode-free': { group: free, name: 'OpenCode Free', what: 'The free models offered through the OpenCode program.',
    on: 'Small tasks cost none of your paid limits.', off: 'Small tasks use your paid limits instead.',
    catch: 'Free models may train on your prompts and code, and what is offered changes often.', needs: 'The OpenCode program, which setup installs.' },
  'kilo-free': { group: free, name: 'Kilo Free', what: 'Kilo Auto Free through the Kilo CLI for small coding tasks.',
    on: 'Small tasks cost none of your paid limits.', off: 'Small tasks use your paid limits instead.',
    catch: 'Free models may change or be rate limited. No limit is published.',
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
    warning: 'Check Cohere\'s trial terms before relying on it. ' + UNCONFIRMED_TRAINING },
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
    warning: 'Reported as meant for prototyping and evaluation only, so do not use it for production work. ' + UNCONFIRMED_TRAINING },
  'zen-glm': { group: free, preset: true, name: 'OpenCode Zen GLM',
    what: 'The free GLM-5.3-Flash model on OpenCode Zen, through the OpenCode program. OpenCode says its provider keeps no data and does not train on it.',
    on: 'Free calls for small tasks, with no key to create.', off: 'Small tasks use your paid limits instead.',
    catch: 'Free only for a limited time, so it can disappear, and no limit is published. Weak on hard tasks.',
    needs: 'The OpenCode program, which setup installs. No account or key.' },
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
    warning: UNCONFIRMED_TRAINING },
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

function stateOf(id, help, providers, workers) {
  if (id.startsWith('workers.')) return workers[id.slice(8)] ? 'on' : 'off';
  if (help.preset && !providers[id]) return 'not added';
  return providers[id]?.enabled === false ? 'off' : 'on';
}

/** Everything the setup needs to explain each choice before anyone has to decide. */
function guide(config, workers) {
  const providers = config.providers.providers;
  const lines = [];
  for (const group of [yours, more, free]) {
    lines.push(group);
    for (const [id, help] of Object.entries(PROVIDER_HELP)) if (help.group === group) lines.push(...block(id, help, stateOf(id, help, providers, workers)));
  }
  const custom = Object.entries(providers).filter(([id, p]) => p.custom === true && !Object.hasOwn(PROVIDER_HELP, id));
  if (custom.length) lines.push('APIs you added', ...custom.flatMap(([id, p]) => block(id, CUSTOM_HELP, p.enabled === false ? 'off' : 'on')));
  return lines.join('\n');
}

function evidenceNotice(id) {
  return require('./lib').BUILTIN_PROVIDERS.providers[id]?.evidence === 'docs'
    ? "Not run end to end by the maintainer yet, built from the vendor's documentation. Quota Boss gives it no work until quota-boss providers test " + id + ' passes.' : '';
}

function explain(id) {
  const help = PROVIDER_HELP[id];
  return [id, 'what: ' + help.what, 'on: ' + help.on, 'off: ' + help.off, 'catch: ' + help.catch, 'needs: ' + help.needs,
    ...(help.warning ? ['warning: ' + help.warning] : []), ...(evidenceNotice(id) ? [evidenceNotice(id)] : [])].join('\n');
}

/** The sentence added after a provider switch, so every change says what it means. */
function switchEffect(id, enabled) {
  const help = Object.hasOwn(PROVIDER_HELP, id) ? PROVIDER_HELP[id] : null;
  if (!help) return '';
  return ' ' + (enabled ? help.on + (evidenceNotice(id) ? ' ' + evidenceNotice(id) : '') + (help.warning ? ' Warning: ' + help.warning : '') : help.off);
}

module.exports = { PROVIDER_HELP, UNCONFIRMED_TRAINING, CODE_GRAPH_HELP, SCRIPTED_CLAUDE_WARNING, guide, explain, switchEffect };
