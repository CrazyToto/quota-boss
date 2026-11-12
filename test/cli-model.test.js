'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const { route, formatTable } = require('../scripts/route');
const boss = require('../scripts/quota-boss');
const addApi = require('../scripts/add-api');
const defaults = require('../config/providers.json');

test('CLI arguments resolve placeholders and old model flags without mutating input', () => {
  const cli = { args: ['run', '--model={model}', '{prompt}', '{model}'], defaultModel: 'auto' };
  assert.deepEqual(lib.cliArgsForModel(cli, 'cohere/plus'), ['run', '--model=cohere/plus', '{prompt}', 'cohere/plus']);
  assert.deepEqual(lib.cliArgsForModel(cli), ['run', '--model=auto', '{prompt}', 'auto']);
  assert.deepEqual(cli.args, ['run', '--model={model}', '{prompt}', '{model}']);
  assert.throws(() => lib.cliArgsForModel({ args: ['{model}', '{prompt}'] }), /no model/);
  for (const flag of ['-m', '--model']) {
    const old = { args: ['run', flag, 'fixed/model', '{prompt}'] };
    assert.deepEqual(lib.cliArgsForModel(old, 'new/model'), ['run', flag, 'new/model', '{prompt}']);
    const copy = lib.cliArgsForModel(old);
    assert.deepEqual(copy, old.args);
    assert.notStrictEqual(copy, old.args);
    assert.equal(old.args[2], 'fixed/model');
  }
  assert.throws(() => lib.cliArgsForModel({ args: ['{prompt}'] }, 'new/model'), /cannot select a model/);
  assert.throws(() => lib.cliArgsForModel({ args: ['-m'] }, 'new/model'), /cannot select a model/);
});

test('CLI effort fills its placeholder, and the flag goes away when there is no level', () => {
  const cli = { args: ['-p', '{prompt}', '--model', '{model}', '--reasoning-effort', '{effort}'], defaultModel: 'auto' };
  assert.deepEqual(lib.cliArgsForModel(cli, 'gpt-6.1-sol', 'low').slice(-2), ['--reasoning-effort', 'low']);
  assert.deepEqual(lib.cliArgsForModel(cli), ['-p', '{prompt}', '--model', 'auto'], 'auto refuses a reasoning effort');
  assert.deepEqual(lib.cliArgsForModel({ args: ['{prompt}', '--effort={effort}'] }), ['{prompt}']);
  assert.deepEqual(cli.args.at(-1), '{effort}', 'the template is not changed');
  const slug = { args: ['-p', '{prompt}', '--model', '{model}-{effort}'], defaultModel: 'gemini-3.8-flash', defaultEffort: 'medium' };
  assert.deepEqual(lib.cliArgsForModel(slug).slice(-1), ['gemini-3.8-flash-medium']);
  assert.deepEqual(lib.cliArgsForModel(slug, 'gemini-4-argon', 'high').slice(-1), ['gemini-4-argon-high']);
  for (const bad of ['ultra', 'max', '$(id)', 'low; rm']) assert.throws(() => lib.cliArgsForModel(cli, 'x', bad), /Invalid effort/);
  assert.throws(() => lib.mergeProviders(defaults, { providers: { antigravity: { cli: { ...defaults.providers.antigravity.cli, defaultEffort: 'ultra' } } } }), /Invalid CLI/);
});

test('every big provider offers several routes, each template takes a model and an effort', () => {
  const registry = require('../config/models.json').models;
  for (const pool of ['claude', 'codex', 'grok', 'antigravity']) assert.ok(Object.values(registry).filter(m => m.pool === pool).length >= 2, pool);
  for (const id of ['grok', 'copilot', 'antigravity']) {
    const args = defaults.providers[id].cli.args.join(' ');
    assert.match(args, /\{model\}/, id);
    assert.match(args, /\{effort\}/, id);
  }
  assert.deepEqual(lib.cliArgsForModel(defaults.providers.grok.cli, registry['grok-4.7'].cliModel, 'high').slice(-4), ['-m', 'grok-4.7', '--effort', 'high']);
  assert.equal(registry['copilot-default'].efforts, undefined, 'Copilot auto refuses a reasoning effort');
  assert.ok(Object.values(registry).filter(m => m.pool === 'copilot' && m.cliModel).every(m => m.enabled === false), 'other Copilot models depend on the plan');
});

test('a CLI that cannot take a level gets none, and the table names models for the other family', () => {
  const providers = { ...lib.BUILTIN_PROVIDERS, providers: { ...lib.BUILTIN_PROVIDERS.providers,
    grok: { ...lib.BUILTIN_PROVIDERS.providers.grok, enabled: true, cli: { command: 'grok', args: ['-p', '{prompt}', '-m', '{model}'], defaultModel: 'x' } } } };
  const models = { categories: ['implementation'], models: { g: { pool: 'grok', label: 'G', cost: 1, cliModel: 'g-1', efforts: ['low', 'medium', 'high'], scores: { implementation: 9 } } } };
  const row = route({ models, providers, selfTests: { g: { result: 'pass' } } }).rows.find(r => r.tier === 'normal');
  assert.equal(row.effort, null);
  const enabled = { ...providers, providers: { ...providers.providers, grok: { ...providers.providers.grok, cli: { command: 'grok', args: ['-p', '{prompt}', '-m', '{model}', '--effort', '{effort}'], defaultModel: 'x' } } } };
  const withLevel = route({ models, providers: enabled, selfTests: { g: { result: 'pass' } } });
  assert.equal(withLevel.rows.find(r => r.tier === 'normal').effort, 'low');
  assert.match(formatTable(withLevel), /G\(cli-worker:grok,low,model=g\)/);
  const family = { categories: ['implementation'], models: {
    sol: { pool: 'codex', label: 'Sol', cost: 1, efforts: ['low', 'medium', 'high'], scores: { implementation: 9 } },
    'claude-opus-5-5': { pool: 'claude', label: 'Opus', agentModel: 'opus', cost: 10, scores: { architecture: 10, review: 10, implementation: 9 } } } };
  assert.match(formatTable(route({ models: family })), /Sol\(codex-worker,low,model=sol\)/);
  const codexBoss = { categories: ['implementation'], models: {
    boss: { pool: 'codex', label: 'Boss', cost: 50, scores: { architecture: 9, review: 9, implementation: 9 } },
    'claude-sonnet-5-5': { pool: 'claude', label: 'Sonnet', agentModel: 'sonnet', cost: 1, efforts: ['low', 'medium', 'high'], scores: { implementation: 9 } } } };
  assert.match(formatTable(route({ models: codexBoss, host: 'codex', bossModel: 'boss' })), /Sonnet\(claude-worker,low,model=claude-sonnet-5-5\)/);
});

test('providers show resolves an effort and refuses bad flags', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-boss-effort-'));
  const saved = { QUOTA_BOSS_HOME: process.env.QUOTA_BOSS_HOME };
  process.env.QUOTA_BOSS_HOME = home;
  try {
    assert.deepEqual(JSON.parse(boss.run(['providers', 'show', 'antigravity', '--model', 'gemini-4-argon', '--effort', 'high'])).cli.args.slice(-2), ['--model', 'gemini-4-argon-high']);
    assert.deepEqual(JSON.parse(boss.run(['providers', 'show', 'grok', '--effort', 'low'])).cli.args.slice(-2), ['--effort', 'low']);
    assert.throws(() => boss.run(['providers', 'show', 'grok', '--effort', 'ultra']), /Invalid effort/);
    assert.throws(() => boss.run(['providers', 'show', 'grok', '--nope', 'x']), /Usage/);
    assert.throws(() => boss.run(['providers', 'show', 'grok', '--effort', 'low', '--effort', 'high']), /Usage/);
  } finally {
    if (saved.QUOTA_BOSS_HOME === undefined) delete process.env.QUOTA_BOSS_HOME; else process.env.QUOTA_BOSS_HOME = saved.QUOTA_BOSS_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('provider defaultModel validation accepts CLI names and rejects bad values', () => {
  for (const value of ['cohere/command-a-plus-05-2026', 'model:free', 'model@latest'])
    assert.doesNotThrow(() => lib.mergeProviders(defaults, { providers: { copilot: { cli: { ...defaults.providers.copilot.cli, defaultModel: value } } } }));
  for (const value of ['', ' bad', '-bad', 'bad model', 'bad\nmodel', 'x'.repeat(129), 3, null])
    assert.throws(() => lib.mergeProviders(defaults, { providers: { copilot: { cli: { ...defaults.providers.copilot.cli, defaultModel: value } } } }), /Invalid CLI/);
});

test('route carries CLI model through rows and ladder, and drops invalid entries', () => {
  const providers = lib.mergeProviders(defaults, { providers: { cohere: { label: 'Cohere', kind: 'api', enabled: true, worker: 'cli-worker',
    trainsOnData: false, quota: { source: 'none' }, cli: { command: 'opencode', args: ['run', '-m', '{model}', '{prompt}'] } } } });
  const models = { categories: ['implementation'], models: {
    'cohere-plus': { pool: 'cohere', label: 'Cohere Plus', cost: 0, cliModel: 'cohere/plus', scores: { implementation: 10 } },
    'bad id': { pool: 'cohere', label: 'Bad id', cost: 10, cliModel: 'cohere/bad', scores: { implementation: 10 } },
    'bad-cli': { pool: 'cohere', label: 'Bad CLI', cost: 0, cliModel: 'bad model', scores: { implementation: 10 } }
  } };
  const result = route({ models, providers, host: 'generic', now: Date.UTC(2026, 0, 1) });
  const row = result.rows.find(r => r.model === 'cohere-plus');
  assert.ok(row, JSON.stringify(result.candidates.map(c => [c.model, c.reason])));
  assert.equal(row.cliModel, 'cohere/plus');
  assert.equal(row.ladder[0].cliModel, 'cohere/plus');
  assert.match(formatTable(result), /Cohere Plus\(cli-worker:cohere,model=cohere-plus\)/);
  assert.doesNotMatch(formatTable(result), /implementation=Bad id|Bad CLI/);
  assert.equal(formatTable({ rows: [{ ...row, model: 'bad id' }] }), '');
  assert.ok(result.candidates.every(c => c.model !== 'bad-cli'));
  const blocked = lib.mergeProviders(defaults, { providers: { cohere: { ...providers.providers.cohere,
    cli: { command: 'opencode', args: ['run', '{prompt}'] } } } });
  const unavailable = route({ models: { ...models, models: { 'cohere-plus': models.models['cohere-plus'] } }, providers: blocked, host: 'generic' });
  assert.ok(unavailable.candidates.every(c => c.reason === 'worker unavailable'));
  assert.equal(unavailable.rows.length, 0);
});

test('provider show, add-api and remove-api use isolated home', t => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-cli-model-'));
  const previous = Object.fromEntries(['QUOTA_BOSS_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].map(key => [key, process.env[key]]));
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  process.env.QUOTA_BOSS_HOME = path.join(temporary, 'home');
  process.env.CODEX_HOME = path.join(temporary, 'codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(temporary, 'claude');
  fs.mkdirSync(path.join(temporary, 'project'));
  process.chdir(path.join(temporary, 'project'));
  const configDir = path.join(process.env.QUOTA_BOSS_HOME, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  lib.writeJson(path.join(configDir, 'models.json'), { models: {
    'copilot-fast': { pool: 'copilot', label: 'Fast', cost: 1, cliModel: 'fast/model', scores: {} } } });
  assert.deepEqual(JSON.parse(boss.run(['providers', 'show', 'copilot', '--model', 'copilot-fast'])).cli.args.slice(-2), ['--model', 'fast/model']);
  // A worker without a model id must still get runnable arguments, never a raw placeholder.
  assert.deepEqual(JSON.parse(boss.run(['providers', 'show', 'copilot'])).cli.args.slice(-2), ['--model', 'auto']);
  assert.throws(() => boss.run(['providers', 'show', 'copilot', '--model', 'missing']), /Unknown model/);
  assert.throws(() => boss.run(['providers', 'show', 'grok', '--model', 'copilot-fast']), /Unknown model/);
  addApi.add(['trial', 'cohere/base', '--trains', 'no']);
  const provider = lib.readProviderConfig(path.join(configDir, 'providers.json')).providers.trial;
  assert.deepEqual(provider.cli.args, ['run', '-m', '{model}', '{prompt}']);
  assert.equal(provider.cli.defaultModel, 'cohere/base');
  assert.equal(lib.readProviderConfig(path.join(configDir, 'models.json')).models['trial-api'].cliModel, 'cohere/base');
  const preset = { label: 'Trial', model: 'cohere/base', free: true, trains: false,
    extraModels: [{ suffix: 'plus', label: 'Plus', model: 'cohere/plus', scores: { implementation: 9 } }] };
  const models = { ...lib.readProviderConfig(path.join(configDir, 'models.json')).models, ...addApi.modelEntries('trial', preset) };
  assert.deepEqual(models['trial-plus'], { pool: 'trial', label: 'Plus', cliModel: 'cohere/plus', cost: 0, scores: { implementation: 9 } });
  models['trial-extra'] = { ...models['trial-plus'], label: 'Another' };
  lib.writeJson(path.join(configDir, 'models.json'), { models });
  addApi.remove(['trial']);
  assert.ok(Object.values(lib.readProviderConfig(path.join(configDir, 'models.json')).models).every(model => model.pool !== 'trial'));
});
