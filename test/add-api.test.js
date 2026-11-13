'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PRESETS } = require('../scripts/add-api');
const { PROVIDER_HELP } = require('../scripts/provider-help');
const { openCodeOffers } = require('../scripts/diagnostics');

const script = path.join(__dirname, '..', 'scripts', 'quota-boss.js');

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-add-api-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  return dir;
}
const cli = (dir, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, QUOTA_BOSS_HOME: dir } });
const saved = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, 'config', name + '.json'), 'utf8'));

test('no arguments lists the presets', () => {
  const result = cli(home(), 'add-api');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cohere:/);
  assert.doesNotMatch(result.stdout, /groq:|sambanova:/);
  assert.match(result.stdout, /mistral-api:.*may train/);
  assert.match(result.stdout, /gemini-api:.*\n\s+Warning:.*humans may read/);
  assert.doesNotMatch(result.stdout, /mistral-api:.*\n\s+Warning:/);
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
  assert.match(cli(dir, 'providers').stdout, /cohere/);
});

test('Mistral next steps show its provider login and key page', () => {
  const output = cli(home(), 'add-api', 'mistral-api').stdout;
  assert.match(output, /opencode auth login -p mistral/);
  assert.match(output, /https:\/\/admin\.mistral\.ai\/organization\/api-keys/);
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
  const result = cli(dir, 'add-api', 'zen-glm');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /auth login|allow-training|undefined/);
  const provider = saved(dir, 'providers').providers['zen-glm'];
  assert.deepEqual(provider.cli.args, ['run', '-m', '{model}', '{prompt}']);
  assert.equal(provider.cli.defaultModel, 'opencode/glm-5.3-flash-free');
  assert.equal(provider.trainsOnData, false);
  assert.equal(saved(dir, 'models').models['zen-glm-api'].cost, 0);
});

test('Z.ai asks for its key on its own page and stays behind the training gate', () => {
  const result = cli(home(), 'add-api', 'zai');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /opencode auth login -p zai/);
  assert.match(result.stdout, /https:\/\/z\.ai\/manage-apikey\/apikey-list/);
  assert.match(result.stdout, /set training on/);
  assert.match(result.stdout, /Warning:.*treats it as if it does/);
});

test('a rate-limited offer is paused, found by provider id and not counted as a failure', () => {
  const dir = home();
  assert.equal(cli(dir, 'add-api', 'zen-glm').status, 0);
  const result = cli(dir, 'feedback', 'zen-glm', 'mechanical', 'trivial', 'limited');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /zen-glm-api mechanical trivial limited/);
  assert.match(cli(dir, 'route', '--explain', 'mechanical', 'trivial').stdout, /OpenCode Zen GLM .*rate limited \(paused for 15 minutes\)/);
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
  const list = () => { calls++; return { status: 0, stdout: 'mistral/codestral-latest\nopencode/glm-5.3-flash-free\n' }; };
  assert.deepEqual(openCodeOffers(providers, list), ['OpenCode offer good: OK',
    'OpenCode offer gone: model no longer offered, remove it with: quota-boss remove-api gone',
    'OpenCode offer nokey: no key stored, add one with: opencode auth login -p groq']);
  assert.equal(calls, 1);
  assert.deepEqual(openCodeOffers({ vibe: providers.vibe }, () => assert.fail('no offers, no call')), []);
  assert.deepEqual(openCodeOffers({ good: providers.good }, () => ({ status: 1 })), ['OpenCode offers: could not check. Is OpenCode installed?']);
  for (const stdout of ['', 'Update available\nno models here\n']) {
    assert.deepEqual(openCodeOffers({ nokey: providers.nokey }, () => ({ status: 0, stdout })), ['OpenCode offers: could not check. Is OpenCode installed?']);
  }
  assert.deepEqual(openCodeOffers({ zen: offer('opencode/glm-5.3-flash-free') }, () => ({ status: 0, stdout: 'mistral/codestral-latest\n' })),
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
