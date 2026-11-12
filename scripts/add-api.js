'use strict';
// Registers any API as a provider. OpenCode is the bridge: it speaks to many APIs and keeps the keys
// in its own credential store, so Quota Boss never sees or stores one.

const path = require('node:path');
const lib = require('./lib');
const { PROVIDER_HELP } = require('./provider-help');

const PRESETS = Object.freeze({
  'mistral-api': { label: 'Mistral Experiment', model: 'mistral/codestral-latest', keyPage: 'https://admin.mistral.ai/organization/api-keys', free: true, trains: true,
    gets: 'about 1 billion tokens a month, 2 requests a minute',
    limit:'about 1 billion tokens a month and 2 requests a minute (reported by OmniRoute, check your console)' },
  'openrouter-free': { label: 'OpenRouter free', model: 'openrouter/cohere/north-mini-code:free', keyPage: 'https://openrouter.ai/settings/keys', free: true, trains: true,
    keyHint: 'A balance of 0 is normal: this offer only uses a free model, so it costs nothing.',
    gets: '50 calls a day',
    limit: '50 calls a day',
    windows: { daily: { budget: 50, unit: 'calls' } },
    extraModels: [{ suffix: 'ultra', label: 'OpenRouter Nemotron Ultra', model: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
      scores: { architecture: 4, debugging: 5, implementation: 6, review: 4, research: 4, mechanical: 7 } }] },
  cloudflare: { label: 'Cloudflare Workers AI', model: 'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash', keyPage: 'https://dash.cloudflare.com/', free: true, trains: true,
    keyHint: 'There, open Workers AI and then Use REST API. Copy the Account ID, then choose Create a Workers AI API Token, which sets the right permissions. Keep both ready for OpenCode.',
    gets: '10,000 Neurons a day',
    limit: "10,000 Neurons a day (Cloudflare's own unit)" },
  cohere: { label: 'Cohere trial', model: 'cohere/north-mini-code-1-0', keyPage: 'https://dashboard.cohere.com/api-keys', free: true, trains: true,
    gets: '1,000 calls a month',
    limit: '1,000 calls a month and 20 chat requests a minute',
    windows: { monthly: { budget: 1000, unit: 'calls' } },
    extraModels: [{ suffix: 'plus', label: 'Cohere Command A+', model: 'cohere/command-a-plus-05-2026',
      scores: { architecture: 4, debugging: 5, implementation: 6, review: 4, research: 4, mechanical: 7 } }] },
  'gemini-api': { label: 'Gemini API free', model: 'google/gemini-flash-lite-latest', keyPage: 'https://aistudio.google.com/apikey', free: true, trains: true,
    gets: 'limit not confirmed',
    limit: 'not confirmed, check Google AI Studio' },
  nvidia: { label: 'NVIDIA NIM', model: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b', keyPage: 'https://build.nvidia.com/settings/api-keys', free: true, trains: true,
    gets: 'about 40 requests a minute',
    limit: 'about 40 requests a minute (reported by OmniRoute)' },
  'zen-glm': { label: 'OpenCode Zen GLM', model: 'opencode/glm-5.3-flash-free', keyless: true, free: true, trains: false,
    gets: 'no key, no published limit, free for now',
    limit: 'no key needed, no published limit, free for a limited time' },
  'zen-deepseek': { label: 'OpenCode Zen DeepSeek', model: 'opencode/deepseek-v4.1-flash-free', keyless: true, free: true, trains: false,
    gets: 'no key, no published limit, free for now',
    limit: 'no key needed, no published limit, free for a limited time' },
  zai: { label: 'Z.ai GLM Flash', model: 'zai/glm-4.7-flash', keyPage: 'https://z.ai/manage-apikey/apikey-list', free: true, trains: true,
    gets: 'no published limit',
    limit: 'free, no published limit' },
});

const USAGE = 'Usage: quota-boss add-api [<preset>|<id> <provider/model> --trains <yes|no> [--free] [--budget <amount> <calls|usd|tokens> <daily|weekly|monthly>]]';
// Passed as one argument to OpenCode: must contain a provider and can never look like a flag.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,126}$/;

function parseCustom(id, model, flags) {
  const spec = { label: id, model, free: false, trains: undefined, windows: undefined };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--free') spec.free = true;
    else if (flags[i] === '--trains' && /^(yes|no)$/.test(flags[i + 1] || '')) spec.trains = flags[++i] === 'yes';
    else if (flags[i] === '--budget' && flags[i + 3] && !flags.slice(i + 1, i + 4).some(v => v.startsWith('--'))) {
      const [amount, unit, window] = flags.slice(i + 1, i + 4);
      spec.windows = { [window]: { budget: Number(amount), unit } };
      i += 3;
    } else throw new Error(USAGE);
  }
  if (spec.trains === undefined) throw new Error('Say whether this API may train on your data: --trains yes or --trains no.');
  return spec;
}

function providerEntry(spec) {
  return { label: spec.label, kind: spec.free ? 'free' : 'api', enabled: true, custom: true, tos: 'api', trainsOnData: spec.trains,
    quota: spec.windows ? { source: 'counter', windows: spec.windows } : { source: 'none' }, worker: 'cli-worker',
    cli: { command: 'opencode', args: ['run', '-m', '{model}', '{prompt}'], defaultModel: spec.model } };
}

// Cautious scores until outcomes teach the router otherwise: good enough for small tasks only.
function modelEntry(id, spec) {
  return { pool: id, label: spec.label, cliModel: spec.model, cost: spec.free ? 0 : 2,
    scores: { architecture: 3, debugging: 4, implementation: 5, review: 3, research: 3, mechanical: 6 } };
}

function modelEntries(id, spec) {
  return { [id + '-api']: modelEntry(id, spec),
    ...Object.fromEntries((spec.extraModels || []).map(extra => [id + '-' + extra.suffix,
      { ...modelEntry(id, spec), label: extra.label, cliModel: extra.model, scores: extra.scores }])) };
}

function update(file, change) {
  const saved = lib.withLock(file, verify => {
    const next = change(lib.readProviderConfig(file));
    verify(); lib.atomicWrite(file, JSON.stringify(next, null, 2) + '\n', verify); return true;
  });
  if (saved === null) throw new Error('Provider config is busy; retry.');
}

function files() {
  const config = path.join(lib.getPaths().quotaBossHome, 'config');
  return { providers: path.join(config, 'providers.json'), models: path.join(config, 'models.json') };
}

function list() {
  return ['Presets (add with: quota-boss add-api <name>):',
    ...Object.entries(PRESETS).flatMap(([id, p]) => ['- ' + id + ': ' + p.model + ', ' + p.limit + (p.trains ? ', may train on your data' : ''),
      ...(PROVIDER_HELP[id]?.warning ? ['    Warning: ' + PROVIDER_HELP[id].warning] : [])]),
    'Any other API that OpenCode supports:',
    '  quota-boss add-api <your-name> <provider/model> --trains <yes|no> [--free] [--budget <amount> <calls|usd|tokens> <daily|weekly|monthly>]'].join('\n');
}

function add(args) {
  if (!args.length) return list();
  const [id, model, ...flags] = args;
  const preset = args.length === 1 && Object.hasOwn(PRESETS, id) ? PRESETS[id] : null;
  if (!preset && args.length < 3) throw new Error(USAGE);
  if (!lib.validProviderId(id) || Object.hasOwn(lib.BUILTIN_PROVIDERS.providers, id)) throw new Error('Choose a new name for this API: letters, digits and dashes, not a built-in provider.');
  if (!preset && !MODEL_PATTERN.test(model)) throw new Error('The model must look like provider/model, as shown by `opencode models`.');
  const spec = preset || parseCustom(id, model, flags);
  const paths = files();
  update(paths.providers, user => {
    const next = { ...user, providers: { ...user.providers, [id]: providerEntry(spec) } };
    lib.mergeProviders(lib.BUILTIN_PROVIDERS, next);
    return next;
  });
  update(paths.models, user => ({ ...user, models: { ...user.models, ...modelEntries(id, spec) } }));
  return ['API added: ' + id + ' (' + spec.model + ')',
    ...(preset && PROVIDER_HELP[id]?.warning ? ['Warning: ' + PROVIDER_HELP[id].warning] : []),
    'Next: 1. quota-boss tools (installs OpenCode if it is missing)',
    ...(spec.keyless ? [] : ['      2. opencode auth login -p ' + spec.model.split('/')[0] + ' (enter an API key, never a subscription login; it stays in OpenCode)',
      ...(preset ? ['         Create the key here: ' + spec.keyPage] : []),
      ...(preset?.keyHint ? ['         ' + preset.keyHint] : [])]),
    ...(spec.trains ? ['      3. quota-boss set training on (this API may train on your data and stays blocked until you allow that per project)'] : [])].join('\n');
}

function remove(args) {
  if (args.length !== 1) throw new Error('Usage: quota-boss remove-api <id>');
  const [id] = args;
  const paths = files();
  if (lib.readProviderConfig(paths.providers).providers?.[id]?.custom !== true) throw new Error('Only APIs added with add-api can be removed.');
  update(paths.providers, user => { const providers = { ...user.providers }; delete providers[id]; return { ...user, providers }; });
  update(paths.models, user => { const models = { ...user.models };
    for (const [modelId, model] of Object.entries(models)) if (model?.pool === id) delete models[modelId];
    return { ...user, models }; });
  return 'API removed: ' + id;
}

module.exports = { PRESETS, MODEL_PATTERN, add, remove, update, modelEntries };
