'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PRESETS } = require('../scripts/add-api');
const { run } = require('../scripts/quota-boss');
const { PROVIDER_HELP } = require('../scripts/provider-help');
const { openCodeOffers } = require('../scripts/diagnostics');
const { BUILTIN_PROVIDERS, loadConfig, mergeProviders, retiredProviders } = require('../scripts/lib');

const script = path.join(__dirname, '..', 'scripts', 'quota-boss.js');

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-add-api-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  return dir;
}
const cli = (dir, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, QUOTA_BOSS_HOME: dir } });
const saved = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, 'config', name + '.json'), 'utf8'));
const save = (dir, name, value) => fs.writeFileSync(path.join(dir, 'config', name + '.json'), JSON.stringify(value) + '\n');

function inIsolatedHome(t) {
  const dir = home(), previous = process.env.QUOTA_BOSS_HOME, cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.QUOTA_BOSS_HOME;
    else process.env.QUOTA_BOSS_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.QUOTA_BOSS_HOME = dir;
  process.chdir(dir);
  return dir;
}

test('no arguments lists the presets', () => {
  const result = cli(home(), 'add-api');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cohere:/);
  assert.doesNotMatch(result.stdout, /groq:|sambanova:/);
  assert.doesNotMatch(result.stdout, /mistral-api:|zen-glm:/);
  assert.match(result.stdout, /gemini-api:.*\n\s+Warning:.*humans may read/);
});

test('a preset registers a working, enabled provider with a zero-cost model', () => {
  const dir = home();
  const result = cli(dir, 'add-api', 'cohere');
  assert.equal(result.status, 0, result.stderr);
  const provider = saved(dir, 'providers').providers.cohere;
  assert.equal(provider.enabled, true);
  assert.equal(provider.trainsOnData, true);
  assert.deepEqual(provider.cli.args, ['run', '-m', '{model}', '{prompt}']);
  assert.equal(provider.cli.defaultModel, 'cohere/north-mini-code-1-0');
  assert.equal(saved(dir, 'models').models['cohere-api'].cost, 0);
  assert.equal(saved(dir, 'models').models['cohere-api'].cliModel, 'cohere/north-mini-code-1-0');
  assert.equal(saved(dir, 'models').models['cohere-plus'].cliModel, 'cohere/command-a-plus-05-2026');
  assert.equal(saved(dir, 'models').models['cohere-plus'].pool, 'cohere');
  assert.match(result.stdout, /opencode auth login -p cohere/);
  assert.match(result.stdout, /quota-boss tools install opencode\b/);
  const tools = cli(dir, 'tools', 'install', 'opencode');
  assert.equal(tools.status, 0, tools.stderr);
  assert.match(tools.stdout, /Run quota-boss tools install in a terminal/);
  assert.match(cli(dir, 'providers').stdout, /cohere/);
});

test('Mistral can still be registered as a paid custom API', () => {
  const dir = home();
  assert.notEqual(cli(dir, 'add-api', 'mistral-api').status, 0);
  const result = cli(dir, 'add-api', 'mistral-api', 'mistral/codestral-latest', '--trains', 'yes');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /opencode auth login -p mistral/);
  assert.equal(saved(dir, 'providers').providers['mistral-api'].kind, 'api');
  assert.ok(saved(dir, 'models').models['mistral-api-api'].cost > 0);
  assert.match(cli(dir, 'providers').stdout, /mistral-api/);
});

test('Zen GLM retirement recognizes both legacy model flags and ignores a model string in other args', () => {
  const model = 'opencode/glm-5.3-flash-free';
  for (const flag of ['-m', '--model']) {
    assert.deepEqual(retiredProviders({ 'zen-glm': { cli: { args: ['run', '--quiet', flag, model, '{prompt}'] } } }).map(p => p.id),
      ['zen-glm']);
  }
  assert.deepEqual(retiredProviders({ 'zen-glm': { cli: { args: ['run', '--other', model, '{prompt}'] } } }), []);
});

test('retired routes are excluded before setup, and the suggested command removes each stored entry', t => {
  const dir = inIsolatedHome(t);
  const provider = { label: 'Retired Offer', kind: 'free', enabled: true, worker: 'cli-worker', quota: { source: 'none' } };
  const model = { label: 'Retired Model', cost: 0, scores: { mechanical: 10 } };
  const providers = {
    'zen-glm': { ...provider, custom: true, cli: { command: 'opencode', args: ['run', '-m', 'opencode/glm-5.3-flash-free', '{prompt}'] } },
    'mistral-api': { ...provider, custom: true, cli: { command: 'opencode', args: ['run', '-m', 'mistral/codestral-latest', '{prompt}'] } },
    mistral: { ...provider, cli: { command: 'vibe', args: ['--prompt', '{prompt}'] } },
  };
  for (const [id, entry] of Object.entries(providers)) {
    save(dir, 'providers', { providers: { [id]: entry }, caps: { [id]: { daily: 50 } } });
    save(dir, 'models', { models: { 'retired-model': { ...model, pool: id } } });
    const config = loadConfig();
    assert.equal(config.providers.providers[id], undefined);
    assert.equal(config.models.models['retired-model'], undefined);
    assert.doesNotMatch(run(['route', '--explain', 'mechanical', 'trivial']), /Retired Model|retired-model/);
    assert.match(run(['status']), new RegExp('remove-api ' + id + '\\b'));
    assert.doesNotMatch(run(['providers']), /Retired Offer|unknown provider/);
    assert.equal(run(['remove-api', id]), 'API removed: ' + id);
    assert.deepEqual(saved(dir, 'providers').providers, {});
    assert.deepEqual(saved(dir, 'models').models, {});
    assert.doesNotMatch(run(['status']), /remove-api/);
  }
});

test('copied and partial overrides for removed examples load without restoring their routes', t => {
  const dir = inIsolatedHome(t);
  const caps = { 'opencode-free': { daily: 60 }, openrouter: { monthly: 50 } };
  const copied = {
    'opencode-free': { label: 'Legacy OpenCode', kind: 'free', enabled: true, worker: 'cli-worker', quota: { source: 'none' },
      cli: { command: 'opencode', args: ['run', '{prompt}'] } },
    openrouter: { label: 'Legacy OpenRouter', kind: 'api', enabled: true, worker: 'cli-worker',
      quota: { source: 'counter', windows: { monthly: { budget: 10, unit: 'usd' } } } },
  };
  save(dir, 'models', { models: {
    'opencode-free-example': { pool: 'opencode-free', label: 'Legacy OpenCode', cost: 0, scores: { mechanical: 10 } },
  } });
  for (const providers of [copied, { 'opencode-free': { enabled: true }, openrouter: { enabled: true } }, {}]) {
    save(dir, 'providers', { providers, caps });
    const merged = mergeProviders(BUILTIN_PROVIDERS, { providers }, { caps });
    assert.deepEqual(merged.caps, {});
    for (const id of Object.keys(copied)) assert.equal(merged.providers[id], undefined);
    assert.doesNotMatch(run(['route', '--explain', 'mechanical', 'trivial']), /Legacy OpenCode|unknown provider/);
    assert.doesNotMatch(run(['providers']), /Legacy OpenCode|Legacy OpenRouter/);
    assert.throws(() => run(['tools', 'install', 'opencode']), /only enabled providers/);
  }
  assert.match(run(['add-api', 'openrouter', 'openrouter/example', '--trains', 'no']), /quota-boss tools install opencode\b/);
  assert.match(run(['providers']), /openrouter/);
});

test('a preset that may train says how to allow it', () => {
  assert.match(cli(home(), 'add-api', 'openrouter-free').stdout, /set training on/);
});

test('a warned preset repeats its warning and training command', () => {
  const output = cli(home(), 'add-api', 'gemini-api').stdout;
  assert.match(output, /google\/gemini-flash-lite-latest/);
  assert.match(output, /Warning:/);
  assert.match(output, /set training on/);
});

test('Cloudflare uses the OpenCode model and no quota counter', () => {
  const dir = home();
  const result = cli(dir, 'add-api', 'cloudflare');
  assert.equal(result.status, 0, result.stderr);
  const provider = saved(dir, 'providers').providers.cloudflare;
  assert.deepEqual(provider.cli.args, ['run', '-m', '{model}', '{prompt}']);
  assert.equal(provider.cli.defaultModel, 'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash');
  assert.equal(provider.quota.source, 'none');
});

test('every preset has a limit and matching preset help', () => {
  for (const [id, preset] of Object.entries(PRESETS)) {
    assert.ok(preset.limit);
    if (preset.keyless) assert.equal(preset.keyPage, undefined);
    else assert.match(preset.keyPage, /^https:\/\//);
    assert.equal(PROVIDER_HELP[id].preset, true);
  }
});

test('a keyless preset asks for no key and needs no training permission', () => {
  const dir = home();
  const result = cli(dir, 'add-api', 'zen-deepseek');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /auth login|allow-training|undefined/);
  const provider = saved(dir, 'providers').providers['zen-deepseek'];
  assert.deepEqual(provider.cli.args, ['run', '-m', '{model}', '{prompt}']);
  assert.equal(provider.cli.defaultModel, 'opencode/deepseek-v4.1-flash-free');
  assert.equal(provider.trainsOnData, false);
  assert.equal(saved(dir, 'models').models['zen-deepseek-api'].cost, 0);
});

test('a retired Zen GLM registration can be removed without its preset', () => {
  const dir = home();
  assert.equal(Object.hasOwn(PRESETS, 'zen-glm'), false);
  const added = cli(dir, 'add-api', 'zen-glm', 'opencode/glm-5.3-flash-free', '--trains', 'no', '--free');
  assert.equal(added.status, 0, added.stderr);
  const removed = cli(dir, 'remove-api', 'zen-glm');
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(saved(dir, 'providers').providers['zen-glm'], undefined);
  assert.equal(saved(dir, 'models').models['zen-glm-api'], undefined);
});

test('Z.ai asks for its key on its own page and does not train without agreement', () => {
  const result = cli(home(), 'add-api', 'zai');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /opencode auth login -p zai/);
  assert.match(result.stdout, /https:\/\/z\.ai\/manage-apikey\/apikey-list/);
  assert.doesNotMatch(result.stdout, /set training on/);
  assert.match(result.stdout, /Warning: Z\.ai terms IV\.7 say developer API content is not used for training without agreement/);
  assert.equal(PRESETS.zai.trains, false);
});

test('Cohere and NVIDIA preset warnings state their trial restrictions', () => {
  const cohere = cli(home(), 'add-api', 'cohere').stdout;
  assert.match(cohere, /Warning: Trial key, not for production or commercial use\./);
  const nvidia = cli(home(), 'add-api', 'nvidia').stdout;
  assert.match(nvidia, /Warning: Trial terms: evaluation only, no production, no confidential code\./);
  assert.equal(PRESETS.nvidia.trains, true);
  assert.equal(PRESETS['gemini-api'].trains, true);
});

test('a rate-limited offer is paused, found by provider id and not counted as a failure', () => {
  const dir = home();
  assert.equal(cli(dir, 'add-api', 'zen-deepseek').status, 0);
  const result = cli(dir, 'feedback', 'zen-deepseek', 'mechanical', 'trivial', 'limited');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /zen-deepseek-api mechanical trivial limited/);
  // A stand-in for the offer's CLI, so the pause and not a missing CLI decides on any machine.
  const command = saved(dir, 'providers').providers['zen-deepseek'].cli.command, bin = path.join(dir, 'fake-bin');
  fs.mkdirSync(bin);
  const windows = process.platform === 'win32';
  fs.writeFileSync(path.join(bin, windows ? command + '.cmd' : command), windows ? '@exit /b 0\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  const explain = spawnSync(process.execPath, [script, 'route', '--explain', 'mechanical', 'trivial'], { cwd: dir, encoding: 'utf8',
    env: { ...env, QUOTA_BOSS_HOME: dir, PATH: bin + path.delimiter + (process.env.PATH || process.env.Path || '') } });
  assert.match(explain.stdout, /OpenCode Zen DeepSeek .*rate limited \(paused for 15 minutes\)/);
});

test('a rate limit ends after 15 minutes', () => {
  const lib = require('../scripts/lib');
  const start = Date.UTC(2026, 0, 1);
  const outcomes = [{ t: start, model: 'free-api', category: 'mechanical', tier: 'trivial', result: 'limited' }];
  assert.ok(lib.rateLimitedModels(outcomes, start + 14 * 60000).has('free-api'));
  assert.equal(lib.rateLimitedModels(outcomes, start + 15 * 60000).size, 0);
  assert.equal(lib.unavailableModels(outcomes, start + 60000).size, 0);
});

test('the CLI worker delegates limits and accounting to one deterministic call', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'agents', 'cli-worker.md'), 'utf8');
  assert.match(agent, /timeout: 600000/);
  assert.match(agent, /scripts\/cli-run\.js/);
  assert.match(agent, /<<'QUOTA_BOSS_PROMPT'/);
  assert.match(agent, /closes child stdin, kills the process tree at 10 minutes/);
  assert.match(agent, /Never retry after a `FAILED` line/);
  assert.doesNotMatch(agent, /SECONDS|< \/dev\/null/);
});

test('doctor names offers with a missing key or a retired model, using one local call', () => {
  const offer = model => ({ enabled: true, cli: { command: 'opencode', args: ['run', '-m', model, '{prompt}'] } });
  const providers = { good: offer('mistral/codestral-latest'), gone: offer('opencode/old-free'), nokey: offer('groq/x'),
    vibe: { enabled: true, cli: { command: 'vibe', args: ['--prompt', '{prompt}'] } }, off: { ...offer('groq/y'), enabled: false } };
  let calls = 0;
  const list = () => { calls++; return { status: 0, stdout: 'mistral/codestral-latest\nopencode/deepseek-v4.1-flash-free\n' }; };
  assert.deepEqual(openCodeOffers(providers, list), ['OpenCode offer good: OK',
    'OpenCode offer gone: model no longer offered, remove it with: quota-boss remove-api gone',
    'OpenCode offer nokey: no key stored, add one with: opencode auth login -p groq']);
  assert.equal(calls, 1);
  assert.deepEqual(openCodeOffers({ vibe: providers.vibe }, () => assert.fail('no offers, no call')), []);
  assert.deepEqual(openCodeOffers({ good: providers.good }, () => ({ status: 1 })), ['OpenCode offers: could not check. Is OpenCode installed?']);
  for (const stdout of ['', 'Update available\nno models here\n']) {
    assert.deepEqual(openCodeOffers({ nokey: providers.nokey }, () => ({ status: 0, stdout })), ['OpenCode offers: could not check. Is OpenCode installed?']);
  }
  assert.deepEqual(openCodeOffers({ zen: offer('opencode/deepseek-v4.1-flash-free') }, () => ({ status: 0, stdout: 'mistral/codestral-latest\n' })),
    ['OpenCode offer zen: not listed by OpenCode, check with: opencode models']);
});

test('a custom API needs a training answer and stores its budget', () => {
  const dir = home();
  assert.match(cli(dir, 'add-api', 'acme', 'acme/coder-1', '--free').stderr, /--trains/);
  const result = cli(dir, 'add-api', 'acme', 'acme/coder-1', '--trains', 'no', '--budget', '5', 'usd', 'monthly');
  assert.equal(result.status, 0, result.stderr);
  const provider = saved(dir, 'providers').providers.acme;
  assert.equal(provider.kind, 'api');
  assert.deepEqual(provider.quota.windows, { monthly: { budget: 5, unit: 'usd' } });
  assert.equal(saved(dir, 'models').models['acme-api'].cost, 2);
});

test('invalid names, models and budgets change nothing', () => {
  const dir = home();
  for (const args of [
    ['codex', 'x/y', '--trains', 'no'],
    ['acme', '--yolo/x', '--trains', 'no'],
    ['acme', 'no-slash', '--trains', 'no'],
    ['acme', 'a/b;rm -rf', '--trains', 'no'],
    ['acme', 'a/b', '--trains', 'maybe'],
    ['acme', 'a/b', '--trains', 'no', '--budget', '-1', 'usd', 'monthly'],
    ['acme', 'a/b', '--trains', 'no', '--budget', '1', 'euro', 'monthly'],
  ]) assert.notEqual(cli(dir, 'add-api', ...args).status, 0, args.join(' '));
  assert.equal(fs.existsSync(path.join(dir, 'config', 'providers.json')), false);
});

test('remove-api deletes added APIs and refuses built-in providers', () => {
  const dir = home();
  cli(dir, 'add-api', 'cohere');
  assert.notEqual(cli(dir, 'remove-api', 'codex').status, 0);
  assert.equal(cli(dir, 'remove-api', 'cohere').status, 0);
  assert.equal(saved(dir, 'providers').providers.cohere, undefined);
  assert.equal(saved(dir, 'models').models['cohere-api'], undefined);
});
