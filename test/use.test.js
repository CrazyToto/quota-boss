'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('../scripts/lib');
const cli = require('../scripts/quota-boss');
const { route } = require('../scripts/route');

test.describe('use', () => {
  let temporary, project, oldCwd, oldEnv;
  const userFile = name => path.join(process.env.QUOTA_BOSS_HOME, 'config', name + '.json');
  const run = (...args) => cli.run(args);
  const provider = id => lib.loadConfig().providers.providers[id];
  const model = id => lib.loadConfig().models.models[id];
  const routed = () => {
    const active = lib.findProjectConfig();
    return route({ ...lib.loadConfig(active), ...active, bossModel: lib.currentBossModel(active) });
  };
  test.beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-use-'));
    project = path.join(temporary, 'project');
    fs.mkdirSync(project);
    oldCwd = process.cwd();
    oldEnv = Object.fromEntries(['QUOTA_BOSS_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'QUOTA_BOSS_BOSS_MODEL'].map(k => [k, process.env[k]]));
    process.env.QUOTA_BOSS_HOME = path.join(temporary, 'quota-boss');
    process.env.CODEX_HOME = path.join(temporary, 'codex');
    process.env.CLAUDE_CONFIG_DIR = path.join(temporary, 'claude');
    delete process.env.QUOTA_BOSS_BOSS_MODEL;
    process.chdir(project);
  });
  test.afterEach(() => {
    process.chdir(oldCwd);
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  test('global provider switches persist in provider storage', () => {
    run('use', 'grok', 'on');
    assert.equal(provider('grok').enabled, true);
    assert.deepEqual(lib.readJson(userFile('providers')).providers.grok, { enabled: true });
    assert.equal(fs.existsSync(lib.useFile()), false);
    run('use', 'grok', 'off');
    assert.equal(provider('grok').enabled, false);
    run('use', 'grok', 'on');
    run('use', 'grok', 'off');
    assert.equal(provider('grok').enabled, false);
    assert.throws(() => run('use', 'ollama', 'on'), /Local models have their own switch/);
    assert.throws(() => run('providers', 'enable', 'ollama'), /Usage: quota-boss providers/);
    run('use', 'ollama', 'off', '--project');
    assert.match(run('use', 'ollama', 'on', '--project'), /Still off globally.*quota-boss local on <model>/);
    assert.deepEqual(lib.findProjectConfig().use.providersOff, []);
  });

  test('only is reversible and raw provider writes never persist filtered flags', () => {
    run('use', 'perplexity', 'off');
    run('only', 'claude', 'claude');
    assert.deepEqual(lib.readJson(lib.useFile()), { only: ['claude'], modelsOff: [] });
    assert.equal(provider('codex').enabled, false);
    run('use', 'grok', 'off');
    assert.deepEqual(Object.keys(lib.readJson(userFile('providers')).providers).sort(), ['grok', 'perplexity']);
    run('only', 'off');
    assert.equal(provider('codex').enabled, true);
    assert.equal(provider('perplexity').enabled, false);
    assert.equal(provider('grok').enabled, false);
    assert.equal(lib.readJson(lib.useFile()).only, undefined);
    run('only', 'codex');
    run('use', 'grok', 'on');
    assert.equal(provider('grok').enabled, false);
    run('only', 'off');
    assert.equal(provider('grok').enabled, true);
  });

  test('global and project model switches preserve model data and exclude delegation', () => {
    const id = 'gpt-6.1-terra', before = model(id);
    assert.ok(routed().candidates.some(c => c.model === id));
    run('use', id, 'off');
    assert.deepEqual(model(id), { ...before, enabled: false });
    assert.ok(routed().candidates.every(c => c.model !== id));
    assert.doesNotMatch(run('route', '--explain'), /GPT-6.1-Terra/);
    assert.equal(fs.existsSync(userFile('models')), false);
    assert.match(run('use', id, 'on', '--project'), /Still off globally.*quota-boss use gpt-6.1-terra on/);
    assert.equal(model(id).enabled, false);
    run('use', id, 'on');
    assert.deepEqual(model(id), before);
    run('use', id, 'off', '--project');
    assert.equal(model(id).enabled, false);
    assert.deepEqual(lib.readJson(lib.useFile()).modelsOff, []);
    run('use', id, 'on', '--project');
    assert.deepEqual(model(id), before);
  });

  test('project restrictions only tighten global choices and preserve ancestor metadata', () => {
    lib.saveProject(project, { enabled: true, custom: { keep: 42 } });
    const nested = path.join(project, 'nested');
    fs.mkdirSync(nested);
    process.chdir(nested);
    run('use', 'codex', 'off', '--project');
    assert.equal(provider('codex').enabled, false);
    assert.equal(fs.existsSync(userFile('providers')), false);
    assert.deepEqual(lib.readProjects()[lib.projectKey(project)].custom, { keep: 42 });
    assert.equal(lib.readProjects()[lib.projectKey(nested)], undefined);
    run('use', 'codex', 'off');
    assert.match(run('use', 'codex', 'on', '--project'), /Still off globally.*quota-boss use codex on/);
    assert.equal(provider('codex').enabled, false);
    run('use', 'codex', 'on');
    assert.equal(provider('codex').enabled, true);
    run('only', 'claude');
    assert.match(run('use', 'codex', 'on', '--project'), /quota-boss only off/);
    assert.equal(provider('codex').enabled, false);
    run('only', 'off');
    run('only', 'claude', '--project');
    assert.match(run('use', 'codex', 'on', '--project'), /quota-boss only off --project/);
    run('only', 'off', '--project');
    assert.equal(provider('codex').enabled, true);
    run('use', 'perplexity', 'off', '--project');
    run('only', 'claude', '--project');
    run('only', 'off', '--project');
    assert.equal(provider('perplexity').enabled, false);
    assert.equal(provider('codex').enabled, true);
    process.chdir(temporary);
    assert.equal(provider('perplexity').enabled, true, 'project restrictions do not affect another project');
  });

  test('invalid forms and disabled-only selections fail without writing', () => {
    for (const args of [['use', 'missing', 'off'], ['use', '../x', 'off'], ['use', 'constructor', 'on'],
      ['use', 'grok'], ['use', 'grok', 'yes'], ['use', '--project'], ['use', 'codex', 'off', '--project', '--project'],
      ['use', 'codex', 'off', 'extra'], ['only'], ['only', 'missing'], ['only', 'grok'], ['only', 'grok', 'local'],
      ['only', 'gpt-6.1-terra'], ['only', 'off', 'claude'], ['only', '--project', 'claude']]) {
      assert.throws(() => cli.run(args), args.join(' '));
    }
    assert.throws(() => run('use', 'missing', 'on'), /neither a provider id nor a model id.*quota-boss use/);
    assert.equal(fs.existsSync(lib.getPaths().projectsFile), false);
    assert.equal(fs.existsSync(lib.useFile()), false);
    assert.equal(fs.existsSync(userFile('providers')), false);
    run('only', 'claude', 'grok'); // A disabled provider may be part of a usable selection.
    assert.equal(provider('claude').enabled, true);
    assert.equal(provider('grok').enabled, false);
  });

  test('use input normalization ignores junk, deduplicates ids and tolerates corrupt JSON', () => {
    for (const junk of [null, [], 42, 'text', { only: [null, '../x'], modelsOff: [null], providersOff: {} }, { only: {}, modelsOff: false, providersOff: 'codex' }]) {
      lib.writeJson(lib.useFile(), junk);
      lib.saveProject(project, { use: junk });
      assert.equal(provider('codex').enabled, true);
      assert.doesNotThrow(() => run('use'));
    }
    const junk = { only: ['claude', 'codex', 'claude', null, 7, '../x'],
      providersOff: ['codex', 'codex', {}, 'bad id'], modelsOff: ['gpt-6.1-terra', 'gpt-6.1-terra', null, 'bad id'] };
    lib.writeJson(lib.useFile(), junk);
    assert.equal(provider('codex').enabled, true, 'global providersOff is not a global switch');
    lib.saveProject(project, { use: junk });
    assert.deepEqual(lib.findProjectConfig().use, { only: ['claude', 'codex'], providersOff: ['codex'], modelsOff: ['gpt-6.1-terra'] });
    assert.equal(provider('codex').enabled, false);
    assert.equal(model('gpt-6.1-terra').enabled, false);
    lib.atomicWrite(lib.useFile(), '{broken');
    lib.saveProject(project, { use: {} });
    assert.equal(provider('codex').enabled, true);
    run('use', 'gpt-6.1-terra', 'off');
    assert.deepEqual(lib.readJson(lib.useFile()), { modelsOff: ['gpt-6.1-terra'] });
  });

  test('provider ids take precedence over matching model ids', () => {
    lib.writeJson(userFile('models'), { models: { codex: { pool: 'codex', label: 'Collision', cost: 1 } } });
    run('use', 'codex', 'off');
    assert.equal(provider('codex').enabled, false);
    assert.equal(fs.existsSync(lib.useFile()), false);
    assert.notEqual(model('codex').enabled, false);
  });

  test('boss model stays available for a full self table, while host-pool disabling keeps existing behavior', () => {
    lib.writeState({ bossModel: 'claude-opus-5-5' });
    lib.saveProject(project, { enabled: true, host: 'claude-code', workers: { codex: false, gpt: false, perplexity: false } });
    for (const scope of [[], ['--project']]) {
      assert.match(run('use', 'claude-opus-5-5', 'off', ...scope), /boss itself keeps running on its model; this only stops delegation to it/);
      run('only', 'claude', ...scope);
      const result = routed();
      assert.equal(result.rows.length, lib.CATEGORIES.length * lib.TIERS.length);
      assert.equal(result.candidates.filter(c => c.via === 'self' && c.model === 'claude-opus-5-5').length, lib.CATEGORIES.length * lib.TIERS.length);
      assert.ok(result.rows.some(r => r.via === 'self' && r.model === 'claude-opus-5-5'));
      assert.ok(result.candidates.filter(c => c.model === 'claude-opus-5-5').every(c => c.via === 'self'));
      run('only', 'off', ...scope);
      run('use', 'claude-opus-5-5', 'on', ...scope);
    }
    assert.match(run('use', 'claude', 'off'), /boss itself keeps running/);
    assert.ok(routed().candidates.every(c => c.pool !== 'claude'));
    run('use', 'claude', 'on');
    assert.match(run('only', 'codex'), /boss itself keeps running/);
    assert.ok(routed().candidates.every(c => c.pool !== 'claude'));
  });

  test('Codex boss model also retains its self identity', () => {
    process.env.QUOTA_BOSS_BOSS_MODEL = 'gpt-6.1-terra';
    lib.saveProject(project, { host: 'codex' });
    assert.match(run('use', 'gpt-6.1-terra', 'off'), /boss itself keeps running/);
    assert.ok(routed().candidates.some(c => c.model === 'gpt-6.1-terra' && c.via === 'self'));
    assert.ok(routed().candidates.filter(c => c.model === 'gpt-6.1-terra').every(c => c.via === 'self'));
  });

  test('listing groups providers, explains filters, quota, model switches and worker restrictions', () => {
    lib.writeState({ claude: { five_hour: { used_percentage: 25 }, seven_day: { used_percentage: 50 } } });
    lib.saveProject(project, { workers: { codex: false, gpt: false } });
    run('use', 'gpt-6.1-terra', 'off');
    run('only', 'claude', 'codex');
    run('use', 'codex', 'off', '--project');
    const report = run('use');
    assert.match(report, /^Subscriptions \(global only: claude, codex\)/);
    assert.match(report, /Free, API, local and manual/);
    assert.match(report, /^  claude +on +5h 75% left, week 50% left$/m);
    assert.match(report, /^  codex +off \(this project\)/m);
    assert.match(report, /^  perplexity +off \(only filter\)$/m);
    assert.match(report, /^  grok +off$/m);
    assert.match(report, /^      .*gpt-6\.1-sol, gpt-6\.1-terra \(off\)/m);
    assert.match(report, /set codex-tasks off/);
    assert.match(report, /set gpt-reviews off/);
    assert.match(report, /quota-boss use <provider-id\|model-id> on\|off \[--project\]/);
    assert.ok(report.split('\n').every(line => line.length <= 110));
    run('only', 'claude', '--project');
    assert.match(run('use'), /^Subscriptions .*project only: claude/);
  });
});
