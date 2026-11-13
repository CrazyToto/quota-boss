'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('../scripts/lib');
const { route, formatTable } = require('../scripts/route');
const cli = require('../scripts/quota-boss');
const defaults = require('../config/providers.json');
const now = Date.UTC(2026, 10, 11, 12);
const counter = (windows = { weekly: { budget: 200, unit: 'calls' } }) => ({
  label: 'Test provider', kind: 'api', enabled: true, worker: 'cli-worker', quota: { source: 'counter', windows }
});
const config = (caps = {}, providers = {}) => lib.mergeProviders(defaults, {
  providers: { grok: { enabled: true }, ...providers }, caps
});
const registry = { categories: ['implementation'], models: {
  grokModel: { pool: 'grok', label: 'Grok model', cost: 1, scores: { implementation: 10 } },
  boss: { pool: 'claude', label: 'Boss', agentModel: 'opus', cost: 10, scores: { implementation: 10 } },
  helper: { pool: 'claude', label: 'Helper', agentModel: 'haiku', cost: 1, scores: { implementation: 10 } }
} };

test.describe('providers', () => {
  let temporary, project, oldCwd, oldEnv;
  const userFile = () => path.join(process.env.QUOTA_BOSS_HOME, 'config', 'providers.json');
  test.beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-providers-'));
    project = path.join(temporary, 'project');
    fs.mkdirSync(project);
    oldCwd = process.cwd();
    oldEnv = Object.fromEntries(['QUOTA_BOSS_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].map(k => [k, process.env[k]]));
    process.env.QUOTA_BOSS_HOME = path.join(temporary, 'quota-boss');
    process.env.CODEX_HOME = path.join(temporary, 'codex');
    process.env.CLAUDE_CONFIG_DIR = path.join(temporary, 'claude');
    process.chdir(project);
  });
  test.afterEach(() => {
    process.chdir(oldCwd);
    for (const [k, v] of Object.entries(oldEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  test('defaults, user provider overrides and nearest project caps merge per window', () => {
    const base = lib.loadConfig().providers;
    assert.deepEqual(Object.entries(base.providers).filter(([, p]) => p.enabled !== false).map(([id]) => id),
      ['claude', 'codex', 'perplexity']);
    lib.writeJson(userFile(), { providers: { grok: { enabled: true } }, caps: { grok: { weekly: 20, daily: 40 } } });
    lib.saveProject(project, { enabled: true, caps: { grok: { weekly: 30 } } });
    const nested = path.join(project, 'nested');
    fs.mkdirSync(nested);
    process.chdir(nested);
    const loaded = lib.loadConfig().providers;
    assert.equal(loaded.providers.grok.quota.source, 'counter');
    assert.equal(loaded.providers.grok.enabled, true);
    assert.deepEqual(loaded.caps.grok, { weekly: 20, daily: 40 });
    assert.equal(base.providers.grok.enabled, false);
  });

  test('counters count matching units within all four UTC windows and reset at their boundaries', () => {
    const p = config({}, { meter: counter({ fiveHour: { budget: 10, unit: 'calls' }, daily: { budget: 100, unit: 'tokens' },
      weekly: { budget: 200, unit: 'calls' }, monthly: { budget: 10, unit: 'usd' } }) });
    for (const [window, unit, amount] of [['fiveHour', 'calls', 2], ['daily', 'tokens', 25], ['monthly', 'usd', 1.5]]) {
      lib.appendUsage('meter', amount, unit, p, lib.counterWindow(window, now).start);
    }
    lib.appendUsage('meter', 3, 'calls', p, lib.counterWindow('fiveHour', now).start - 1);
    lib.appendUsage('meter', 9, 'usd', p, lib.counterWindow('monthly', now).start - 1);
    lib.appendUsage('meter', 100, 'calls', p, now + 1); // Future records cannot consume quota yet.
    fs.appendFileSync(lib.getPaths().usageFile, '{broken}\n' + JSON.stringify({ t: now, provider: 'meter', amount: -10, unit: 'calls' }) + '\n');
    const windows = lib.readProviderLimits(p, {}, now).meter.windows;
    assert.equal(windows.fiveHour.used_percent, 20);
    assert.equal(windows.daily.used_percent, 25);
    assert.equal(windows.weekly.used_percent, 2.5);
    assert.equal(windows.monthly.used_percent, 15);
    assert.equal(windows.monthly.resets_at, Date.UTC(2026, 11, 1) / 1000);
    assert.equal(new Date(lib.counterWindow('weekly', now).start).getUTCDay(), 1);
    const boundary = lib.counterWindow('fiveHour', now).end;
    assert.equal(lib.readProviderLimits(p, {}, boundary).meter.windows.fiveHour.counted, 0);
  });

  test('expired oversized journals compact and never invent exhaustion', () => {
    const p = config();
    lib.atomicWrite(lib.getPaths().usageFile, 'x'.repeat(lib.MAX_LOG_BYTES + 1) + '\n');
    lib.appendUsage('grok', 1, 'calls', p, now);
    const limits = lib.readProviderLimits(p, {}, now);
    assert.equal(limits.grok.windows.weekly.used_percent, 0.5);
    assert.ok(fs.statSync(lib.getPaths().usageFile).size < 256 * 1024);
  });

  test('caps rescale before prices and modes, exclude delegation and ladders, and retain self work', () => {
    const p = config({ grok: { weekly: 20 }, codex: { fiveHour: 50 } });
    const limits = { grok: { windows: { weekly: { used_percent: 15 } } }, codex: { primary: { used_percent: 40 } } };
    const result = route({ models: registry, providers: p, limits, now, selfTests: { grokModel: { result: 'pass' } }, outcomes: Array.from({ length: 3 }, () => ({ t: now, model: 'grokModel', category: 'implementation', tier: 'normal', result: 'pass' })) });
    const candidate = result.candidates.find(c => c.model === 'grokModel');
    assert.equal(candidate.price, 1 + 3 * 0.75 ** 2);
    assert.match(result.mode, /codex-tight/);
    assert.equal(lib.providerContext(p, limits, { codex: [{ t: now, u5: 20, uw: 10 }] }).history.codex[0].u5, 40);
    assert.equal(candidate.via, 'cli-worker:grok');
    assert.match(formatTable({ rows: [candidate] }), /cli-worker:grok/);
    limits.grok.windows.weekly.used_percent = 20;
    const capped = route({ models: registry, providers: p, limits, now, selfTests: { grokModel: { result: 'pass' } }, outcomes: Array.from({ length: 3 }, () => ({ t: now, model: 'grokModel', category: 'implementation', tier: 'normal', result: 'pass' })) });
    assert.match(capped.mode, /capped:grok/);
    assert.ok(capped.candidates.filter(c => c.pool === 'grok').every(c => c.price === Infinity && /capped:grok/.test(c.reason)));
    assert.ok(capped.rows.every(c => c.pool !== 'grok' && c.ladder.every(s => s.pool !== 'grok')));
    const boss = route({ models: registry, providers: config({ claude: { fiveHour: 20 } }, { grok: { enabled: false } }), now,
      limits: { claude: { five_hour: { used_percentage: 20 } } }, workers: { codex: false } });
    assert.match(boss.mode, /capped:claude/);
    assert.equal(boss.rows.length, 3);
    assert.ok(boss.rows.every(r => r.model === 'boss' && Number.isFinite(r.price)));
    assert.ok(boss.candidates.filter(c => c.model === 'helper').every(c => /capped:claude/.test(c.reason)));
    const nearCap = route({ models: registry, providers: config({ claude: { fiveHour: 20 } }, { grok: { enabled: false } }), now,
      limits: { claude: { five_hour: { used_percentage: 18 } } } });
    assert.match(nearCap.mode, /emergency/);
    assert.equal(nearCap.rows.length, 3);
    assert.ok(nearCap.rows.every(r => r.model === 'boss' && Number.isFinite(r.price)));
  });

  test('disabled and unknown providers never route, count, or appear in compact output', () => {
    const p = lib.loadProviders();
    // Disabled counters must not even read an inaccessible journal.
    fs.mkdirSync(lib.getPaths().usageFile, { recursive: true });
    const limits = lib.readProviderLimits(p, {}, now);
    assert.equal(limits.grok, undefined);
    assert.equal(lib.formatProvidersCompact(p, { grok: { windows: { weekly: { used_percent: 99 } } } }), '');
    const result = route({ providers: p, models: { ...registry, models: { ...registry.models,
      unknown: { pool: 'missing', label: 'Missing', cost: 1, scores: { implementation: 10 } } } }, now });
    assert.ok(result.candidates.every(c => c.pool === 'claude'));
    lib.writeJson(path.join(process.env.QUOTA_BOSS_HOME, 'config', 'models.json'), { models: { ...registry.models,
      unknown: { pool: 'missing', label: 'Missing', cost: 1, scores: { implementation: 10 } } } });
    const status = cli.run(['status']);
    assert.match(status, /Warning: ignored models of unknown provider missing/);
    assert.doesNotMatch(status, /provider grok/, 'a disabled built-in provider is not a warning');
  });

  test('CLI lists providers, persists enable/disable, caps and append-only usage', () => {
    assert.match(cli.run(['providers']), /id \| kind \| enabled \| source \| used \| cap \| effective/);
    assert.match(cli.run(['providers']), /grok \| subscription \| no \| counter/);
    cli.run(['use', 'grok', 'on']);
    assert.deepEqual(lib.readJson(userFile()).providers.grok, { enabled: true });
    cli.run(['usage', 'grok', '30', 'calls']);
    const before = fs.readFileSync(lib.getPaths().usageFile, 'utf8');
    cli.run(['usage', 'grok', '1.5', 'calls']);
    assert.ok(fs.readFileSync(lib.getPaths().usageFile, 'utf8').startsWith(before));
    cli.run(['cap', 'grok', 'weekly', '20']);
    assert.match(cli.run(['providers']), /weekly=15.75% \| weekly=20% \| weekly=78.75%/);
    cli.run(['cap', 'grok', 'weekly', 'off']);
    assert.equal(lib.readJson(userFile()).caps.grok.weekly, null);
    cli.run(['use', 'grok', 'off']);
    assert.equal(lib.loadProviders().providers.grok.enabled, false);
    assert.throws(() => cli.run(['usage', 'grok', '1', 'calls']));
  });

  test('project caps tighten global values and off preserves global reservations', () => {
    lib.saveProject(project, { enabled: true, custom: 42 });
    cli.run(['cap', 'codex', 'weekly', '20']);
    cli.run(['cap', 'codex', 'fiveHour', '50']);
    const global = fs.readFileSync(userFile(), 'utf8');
    cli.run(['cap', 'codex', 'weekly', '40', '--project']);
    assert.deepEqual(lib.loadConfig().providers.caps.codex, { weekly: 20, fiveHour: 50 });
    const nested = path.join(project, 'child');
    fs.mkdirSync(nested);
    process.chdir(nested);
    cli.run(['cap', 'codex', 'weekly', 'off', '--project']);
    assert.equal(lib.loadConfig().providers.caps.codex.weekly, 20);
    assert.equal(lib.readProjects()[lib.projectKey(project)].custom, 42);
    assert.equal(fs.existsSync(path.join(nested, '.claude', 'quota-boss.json')), false);
    assert.equal(fs.readFileSync(userFile(), 'utf8'), global);
  });

  test('bad CLI input and amounts fail before any writes', () => {
    cli.run(['use', 'grok', 'on']);
    const before = fs.readFileSync(userFile(), 'utf8');
    for (const args of [['use', 'grok'], ['use', 'missing', 'on'], ['use', '../x', 'on'],
      ['use', 'grok', 'off', 'extra'], ['cap', 'grok', 'yearly', '20'], ['cap', 'grok', 'weekly', '0'],
      ['cap', 'grok', 'weekly', '101'], ['cap', 'grok', 'weekly', 'NaN'], ['cap', 'grok', 'weekly', '20junk'],
      ['cap', 'grok', 'weekly', '20', '--project', '--project'], ['usage', 'grok', '1', 'usd'],
      ['usage', 'claude', '1', 'tokens'], ['usage', 'grok', '1', 'calls', 'extra']]) assert.throws(() => cli.run(args), args.join(' '));
    for (const amount of ['0', '-1', 'Infinity', 'NaN', '1000000001', '1e999', '0x10', '1junk', ' 1', '']) {
      assert.throws(() => cli.run(['usage', 'grok', amount, 'calls']), amount);
    }
    assert.equal(fs.existsSync(lib.getPaths().usageFile), false);
    assert.equal(fs.readFileSync(userFile(), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(project, '.claude', 'quota-boss.json')), false);
    cli.run(['usage', 'grok', '1e9', 'calls']);
    assert.equal(lib.readUsage().entries[0].amount, 1e9);
  });

  test('strict provider, cap and CLI template validation rejects malformed configuration', () => {
    for (const override of [
      { providers: { 'x': counter() } }, { providers: { 'Bad-id': counter() } },
      { providers: { grok: { enabled: 'true' } } }, { providers: { grok: { kind: 'other' } } },
      { providers: { grok: { quota: { source: 'network' } } } },
      { providers: { grok: { quota: { source: 'claude-statusline' } } } },
      { providers: { codex: { quota: { source: 'none' } } } },
      { providers: { grok: counter({}) } }, { providers: { grok: counter({ daily: { budget: 0, unit: 'calls' } }) } },
      { providers: { grok: counter({ yearly: { budget: 10, unit: 'calls' } }) } },
      { providers: { grok: counter({ daily: { budget: 10, unit: 'requests' } }) } },
      { providers: { grok: { cli: { command: 'grok;echo', args: ['{prompt}'] } } } },
      { providers: { grok: { cli: { command: 'grok', args: '{prompt}' } } } },
      { providers: { grok: { cli: { command: 'grok', args: ['no placeholder'] } } } },
      { caps: { missing: { weekly: 20 } } }, { caps: { grok: { weekly: '20' } } },
      { caps: { grok: { weekly: false } } }, { caps: [] }, { caps: null }
    ]) assert.throws(() => lib.mergeProviders(defaults, override), JSON.stringify(override));
    lib.atomicWrite(userFile(), '{broken');
    assert.throws(() => lib.loadProviders());
    assert.throws(() => cli.run(['use', 'grok', 'on']));
    assert.equal(fs.readFileSync(userFile(), 'utf8'), '{broken');
  });

  test('live sources stay exact and compact output includes only enabled capped or counter providers', () => {
    const p = config({ claude: { fiveHour: 20 } });
    const live = { claude: { five_hour: { used_percentage: 20 } }, codex: { primary: { used_percent: 3 } } };
    const limits = lib.readProviderLimits(p, live, now);
    assert.equal(limits.claude, live.claude);
    assert.equal(limits.codex, live.codex);
    assert.equal(lib.formatProvidersCompact(p, limits), 'claude:capped grok:0%');
    const line = lib.formatLimits(limits, 'balanced', {}, now, p);
    assert.match(line, /capped:claude.*claude:capped grok:0%/);
    assert.equal(line.split('\n').length, 1);
    assert.ok(line.length < 250);
    const status = require('../scripts/statusline').formatStatus(limits, { enabled: true }, {}, now, p);
    assert.match(status, /claude:capped grok:0%/);
    assert.doesNotMatch(status, /openrouter/);
    assert.doesNotMatch(require('../scripts/statusline').formatStatus(limits, { enabled: false }, {}, now, p), /grok/);
  });

  test('free offers stay out of the compact output, even when counted or spent', () => {
    const p = config({ freebie: { daily: 50 } }, { freebie: { ...counter({ daily: { budget: 50, unit: 'calls' } }), kind: 'free' } });
    const limits = lib.readProviderLimits(p, {}, now);
    limits.freebie = { windows: { daily: { used_percent: 100 } } };
    assert.equal(lib.formatProvidersCompact(p, limits), 'grok:0%');
    assert.doesNotMatch(require('../scripts/statusline').formatStatus(limits, { enabled: true }, {}, now, p), /freebie/);
  });

  test('hooks include enabled counters, skip disabled live readers and warn on invalid provider config', () => {
    const prompt = require('../scripts/hook-prompt');
    const session = require('../scripts/hook-session');
    lib.saveProject(project, { enabled: true });
    lib.writeJson(userFile(), { providers: { grok: { enabled: true }, codex: { enabled: false } } });
    const original = { input: lib.readInput, codex: lib.readCodexLimits, out: process.stdout.write };
    lib.readInput = () => ({ cwd: project });
    lib.readCodexLimits = () => { throw new Error('Disabled source must not be read'); };
    const invoke = main => {
      let output = '';
      process.stdout.write = chunk => { output += chunk; return true; };
      try { main(); return output; } finally { process.stdout.write = original.out; }
    };
    try {
      const line = invoke(prompt.main);
      assert.match(line, /grok:0%/);
      assert.doesNotMatch(line, /codex data unknown/);
      assert.equal(line.trim().split('\n').length, 1);
      assert.match(invoke(session.main), /grok:0%/);
      assert.match(cli.run(['providers']), /grok \| subscription \| yes/);
      // An invalid config falls back to the built-in providers (codex on again) and warns instead of going silent.
      lib.writeJson(userFile(), { providers: { grok: { enabled: 'invalid' } } });
      lib.readCodexLimits = original.codex;
      assert.match(invoke(prompt.main), /WARNING: the provider config is invalid/);
      const started = invoke(session.main);
      assert.match(started, /WARNING: the provider config is invalid/);
      assert.doesNotMatch(started, /grok:/);
    } finally {
      lib.readInput = original.input;
      lib.readCodexLimits = original.codex;
      process.stdout.write = original.out;
    }
  });
});
