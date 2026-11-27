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
    run('use', 'grok', 'on', '--no-test');
    assert.equal(provider('grok').enabled, true);
    assert.deepEqual(lib.readJson(userFile('providers')).providers.grok, { enabled: true });
    assert.equal(fs.existsSync(lib.useFile()), false);
    run('use', 'grok', 'off');
    assert.equal(provider('grok').enabled, false);
    run('use', 'grok', 'on', '--no-test');
    run('use', 'grok', 'off');
    assert.equal(provider('grok').enabled, false);
    assert.throws(() => run('use', 'ollama', 'on'), /Local models have their own switch/);
    assert.throws(() => run('providers', 'enable', 'ollama'), /Usage: quota-boss providers/);
    run('use', 'ollama', 'off', '--project');
    assert.match(run('use', 'ollama', 'on', '--project'), /Still off globally.*quota-boss local on <model>/);
    assert.deepEqual(lib.findProjectConfig().use.providersOff, []);
  });

  test('the detected plan switches models, a manual switch wins and a manual on survives the plan changing', () => {
    const plans = (on, off) => lib.writeJson(lib.planModelsFile(), { providers: { devin: { plan: 'paid', on, off } } });
    plans(['devin-swe-2-1'], ['devin-swe-2-flash']);
    assert.equal(model('devin-swe-2-1').enabled, true);
    assert.equal(model('devin-swe-2-flash').enabled, false);
    // The plan lacks it, so a manual on needs an entry, and it outlives the plan listing the model and dropping it again.
    run('use', 'devin-swe-2-flash', 'on');
    assert.deepEqual(lib.readUse().modelsOn, ['devin-swe-2-flash']);
    plans(['devin-swe-2-1', 'devin-swe-2-flash'], []);
    run('use', 'devin-swe-2-1', 'off');
    assert.deepEqual(lib.readUse().modelsOn, ['devin-swe-2-flash']);
    assert.equal(model('devin-swe-2-1').enabled, false, 'a manual off beats a detected on');
    plans([], ['devin-swe-2-flash']);
    assert.notEqual(model('devin-swe-2-flash').enabled, false);
    assert.equal(lib.loadConfig(undefined, { use: false }).models.models['devin-swe-2-1'].enabled, false, 'the shipped table ignores the plan');
  });

  test('a paid-plan model that ships off turns on with use and off again', () => {
    assert.equal(model('copilot-gpt-6.1-sol').enabled, false);
    assert.match(run('use', 'copilot-gpt-6.1-sol', 'on'), /is off because only some plans include it/);
    assert.equal(model('copilot-gpt-6.1-sol').enabled, true);
    assert.deepEqual(lib.readUse().modelsOn, ['copilot-gpt-6.1-sol']);
    run('use', 'copilot-gpt-6.1-sol', 'on');
    assert.deepEqual(lib.readUse().modelsOn, ['copilot-gpt-6.1-sol']);
    run('use', 'copilot-gpt-6.1-sol', 'off');
    assert.equal(model('copilot-gpt-6.1-sol').enabled, false);
    assert.equal(lib.readUse().modelsOn, undefined);
    assert.deepEqual(lib.readUse().modelsOff, ['copilot-gpt-6.1-sol']);
    // A model that ships on and was only switched off never gets an on entry; a stale entry is dropped on the next switch.
    run('use', 'grok-build', 'off');
    assert.doesNotMatch(run('use', 'grok-build', 'on'), /only some plans/);
    assert.equal(lib.readUse().modelsOn, undefined);
    lib.writeJson(lib.useFile(), { modelsOff: [], modelsOn: ['grok-build', 'gone-model', 'devin-swe-2'] });
    run('use', 'copilot-gpt-6.1-sol', 'on');
    assert.deepEqual(lib.readUse().modelsOn, ['devin-swe-2', 'copilot-gpt-6.1-sol']);
    // A project can turn it on for itself; a global off still wins.
    run('use', 'copilot-gpt-6-luna', 'on', '--project');
    assert.deepEqual(lib.findProjectConfig().use.modelsOn, ['copilot-gpt-6-luna']);
    assert.equal(model('copilot-gpt-6-luna').enabled, true);
    run('use', 'copilot-gpt-6-luna', 'off');
    assert.equal(lib.loadConfig(lib.findProjectConfig()).models.models['copilot-gpt-6-luna'].enabled, false);
  });

  test('a stored only filter from before 0.2.0 keeps excluding, also training providers, and cannot be set again', () => {
    lib.writeJson(userFile('providers'), { providers: { 'kilo-free': { enabled: true } } });
    lib.saveProject(project, { allowTrainingProviders: true });
    assert.equal(provider('kilo-free').enabled, true);
    lib.writeJson(lib.useFile(), { only: ['claude', 'codex'], modelsOff: [] });
    assert.equal(provider('claude').enabled, true);
    assert.equal(provider('codex').enabled, true);
    for (const id of ['perplexity', 'grok', 'kilo-free']) assert.equal(provider(id).enabled, false, id + ' stays outside the global filter');
    lib.saveProject(project, { allowTrainingProviders: true, use: { only: ['claude'] } });
    assert.equal(provider('codex').enabled, false, 'the project filter narrows further');
    assert.equal(provider('claude').enabled, true);
    assert.throws(() => run('only', 'claude'));
    assert.match(run('use'), /^  codex +off \(only filter\)/m);
    assert.match(run('use'), /^  perplexity +off \(only filter\)/m);
  });

  test('use <id> on lets that one provider through a stored only filter, never more', () => {
    lib.writeJson(lib.useFile(), { only: ['claude'], modelsOff: [] });
    lib.saveProject(project, { use: { only: ['claude'] } });
    assert.match(run('use', 'codex', 'on', '--project'), /Still off globally\. Turn it on with: quota-boss use codex on/);
    assert.deepEqual(lib.findProjectConfig().use.only, ['claude', 'codex']);
    assert.deepEqual(lib.readUse().only, ['claude']);
    assert.equal(provider('codex').enabled, false);
    run('use', 'codex', 'on', '--no-test');
    assert.deepEqual(lib.readUse().only, ['claude', 'codex']);
    assert.equal(provider('codex').enabled, true);
    for (const id of ['perplexity', 'grok']) assert.equal(provider(id).enabled, false, id + ' stays outside');
    assert.match(run('use', 'perplexity', 'on', '--no-test'), /Still off by the project only filter\. Turn it on with: quota-boss use perplexity on --project/);
    assert.deepEqual(lib.readUse().only, ['claude', 'codex', 'perplexity']);
    assert.equal(provider('perplexity').enabled, false);
    run('use', 'grok', 'off');
    assert.deepEqual(lib.readUse().only, ['claude', 'codex', 'perplexity'], 'off never touches the filter');
    lib.writeJson(lib.useFile(), { modelsOff: [] });
    run('use', 'grok', 'on', '--no-test');
    assert.equal(Object.hasOwn(lib.readJson(lib.useFile()), 'only'), false, 'no filter is created');
  });

  test('a project use write drops the old worker switches and keeps their effect until turned on', () => {
    lib.saveProject(project, { workers: { codex: false, gpt: false, perplexity: false } });
    run('use', 'grok', 'off', '--project');
    const saved = lib.readProjects()[lib.projectKey(project)];
    assert.equal(Object.hasOwn(saved, 'workers'), false);
    assert.deepEqual(saved.use.providersOff, ['codex', 'perplexity', 'grok']);
    run('use', 'codex', 'on', '--project');
    assert.equal(provider('codex').enabled, true);
    assert.equal(provider('perplexity').enabled, false);
  });

  test('raw provider writes stay minimal', () => {
    run('use', 'perplexity', 'off');
    run('use', 'grok', 'off');
    assert.deepEqual(Object.keys(lib.readJson(userFile('providers')).providers).sort(), ['grok', 'perplexity']);
    assert.equal(provider('perplexity').enabled, false);
    assert.equal(provider('codex').enabled, true);
    assert.doesNotMatch(run('use'), /only/);
  });

  test('stored worker switches from before 0.2.0 keep codex and perplexity off for that project; gpt alone is dropped', () => {
    lib.saveProject(project, { workers: { gpt: false } });
    assert.equal(provider('codex').enabled, true);
    assert.deepEqual(lib.findProjectConfig().use.providersOff, []);
    lib.saveProject(project, { workers: { codex: false, gpt: true, perplexity: true } });
    assert.equal(provider('codex').enabled, false);
    assert.equal(provider('perplexity').enabled, true);
    lib.saveProject(project, { workers: { codex: true, perplexity: false }, use: { providersOff: ['perplexity', 'grok'] } });
    assert.equal(provider('codex').enabled, true);
    assert.equal(provider('perplexity').enabled, false);
    assert.deepEqual(lib.findProjectConfig().use.providersOff, ['perplexity', 'grok']);
    assert.match(run('use'), /^  perplexity +off \(this project\)/m);
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
    run('use', 'codex', 'on', '--no-test');
    assert.equal(provider('codex').enabled, true);
    assert.doesNotMatch(run('use', 'codex', 'on', '--project'), /Still off/);
    assert.equal(provider('codex').enabled, true);
    run('use', 'perplexity', 'off', '--project');
    assert.equal(provider('perplexity').enabled, false);
    assert.equal(provider('codex').enabled, true);
    process.chdir(temporary);
    assert.equal(provider('perplexity').enabled, true, 'project restrictions do not affect another project');
  });

  test('invalid forms and disabled-only selections fail without writing', () => {
    for (const args of [['use', 'missing', 'off'], ['use', '../x', 'off'], ['use', 'constructor', 'on'],
      ['use', 'grok'], ['use', 'grok', 'yes'], ['use', '--project'], ['use', 'codex', 'off', '--project', '--project'],
      ['use', 'codex', 'off', 'extra'], ['only'], ['only', 'claude'], ['only', 'off']]) {
      assert.throws(() => cli.run(args), args.join(' '));
    }
    assert.throws(() => run('use', 'missing', 'on'), /neither a provider id nor a model id.*quota-boss use/);
    assert.equal(fs.existsSync(lib.getPaths().projectsFile), false);
    assert.equal(fs.existsSync(lib.useFile()), false);
    assert.equal(fs.existsSync(userFile('providers')), false);
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
    lib.saveProject(project, { enabled: true, host: 'claude-code' });
    const others = Object.keys(lib.loadConfig().providers.providers).filter(id => id !== 'claude');
    for (const scope of [[], ['--project']]) {
      assert.match(run('use', 'claude-opus-5-5', 'off', ...scope), /boss itself keeps running on its model; this only stops delegation to it/);
      for (const id of others) if (scope.length || lib.loadConfig().providers.providers[id].kind !== 'local') run('use', id, 'off', ...scope);
      const result = routed();
      assert.equal(result.rows.length, lib.CATEGORIES.length * lib.TIERS.length);
      assert.equal(result.candidates.filter(c => c.via === 'self' && c.model === 'claude-opus-5-5').length, lib.CATEGORIES.length * lib.TIERS.length);
      assert.ok(result.rows.some(r => r.via === 'self' && r.model === 'claude-opus-5-5'));
      assert.ok(result.candidates.filter(c => c.model === 'claude-opus-5-5').every(c => c.via === 'self'));
      for (const id of others) if (scope.length || lib.loadConfig().providers.providers[id].kind !== 'local') run('use', id, 'on', ...scope, ...(scope.length ? [] : ['--no-test']));
      run('use', 'claude-opus-5-5', 'on', ...scope);
    }
    assert.match(run('use', 'claude', 'off'), /boss itself keeps running/);
    assert.ok(routed().candidates.every(c => c.pool !== 'claude'));
  });

  test('Codex boss model also retains its self identity', () => {
    process.env.QUOTA_BOSS_BOSS_MODEL = 'gpt-6.1-terra';
    lib.saveProject(project, { host: 'codex' });
    assert.match(run('use', 'gpt-6.1-terra', 'off'), /boss itself keeps running/);
    assert.ok(routed().candidates.some(c => c.model === 'gpt-6.1-terra' && c.via === 'self'));
    assert.ok(routed().candidates.filter(c => c.model === 'gpt-6.1-terra').every(c => c.via === 'self'));
  });

  test('listing groups providers, quota, model switches and project switches', () => {
    lib.writeState({ claude: { five_hour: { used_percentage: 25 }, seven_day: { used_percentage: 50 } } });
    lib.saveProject(project, { workers: { codex: false, gpt: false } });
    run('use', 'gpt-6.1-terra', 'off');
    run('use', 'perplexity', 'off');
    run('use', 'codex', 'off', '--project');
    const report = run('use');
    assert.match(report, /^Subscriptions\n/);
    assert.match(report, /Free, API, local and manual/);
    assert.match(report, /^  claude +on +5h 75% left, week 50% left$/m);
    assert.match(report, /^  codex +off \(this project\)/m);
    assert.match(report, /^  perplexity +off$/m);
    assert.match(report, /^  grok +off$/m);
    assert.match(report, /^      .*gpt-6\.1-sol, gpt-6\.1-terra \(off\)/m);
    assert.doesNotMatch(report, /codex-tasks|gpt-reviews|only/);
    assert.match(report, /quota-boss use <provider-id\|model-id> on\|off \[--project\]/);
    assert.ok(report.split('\n').every(line => line.length <= 110));
  });
});
