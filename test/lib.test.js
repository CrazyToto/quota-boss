'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('../scripts/lib');

test.describe('lib', () => {
let temporary;
let project;
let savedEnv;
let savedCwd;

test.beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-test-'));
  project = path.join(temporary, 'project');
  fs.mkdirSync(project);
  savedCwd = process.cwd();
  savedEnv = Object.fromEntries(['QUOTA_BOSS_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'QUOTA_BOSS_NO_CLIPBOARD'].map(key => [key, process.env[key]]));
  process.env.QUOTA_BOSS_HOME = path.join(temporary, 'quota-boss');
  process.env.CLAUDE_CONFIG_DIR = path.join(temporary, 'claude');
  process.env.CODEX_HOME = path.join(temporary, 'codex');
  process.env.QUOTA_BOSS_NO_CLIPBOARD = '1';
  process.chdir(project);
});

test.afterEach(() => {
  process.chdir(savedCwd);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});

function enable(config = {}) {
  lib.saveProject(project, { enabled: true, profile: 'balanced', ...config });
}

function limits(c5h = 4, cWeek = 49, x5h = 0, xWeek = 2) {
  return { claude: { five_hour: { used_percentage: c5h }, seven_day: { used_percentage: cWeek } },
    codex: { primary: { used_percent: x5h }, secondary: { used_percent: xWeek } } };
}

function codexLog(used = 0, weekly = 2) {
  const file = path.join(process.env.CODEX_HOME, 'sessions', 'nested', 'log.jsonl');
  lib.atomicWrite(file, JSON.stringify({ timestamp: new Date().toISOString(), payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: used, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 },
    secondary: { used_percent: weekly, window_minutes: 10080, resets_at: Date.now() / 1000 + 86400 } } } }) + '\n');
  return file;
}

function invoke(main, input = '', args = []) {
  let stdout = '';
  let stderr = '';
  const original = { read: fs.readSync, out: process.stdout.write, err: process.stderr.write,
    argv: process.argv, exitCode: process.exitCode };
  const bytes = Buffer.from(input);
  let offset = 0;
  fs.readSync = (fd, buffer, start, length, position) => {
    if (fd !== 0) return original.read(fd, buffer, start, length, position);
    const count = bytes.copy(buffer, start, offset, offset + length);
    offset += count;
    return count;
  };
  process.stdout.write = chunk => { stdout += String(chunk); return true; };
  process.stderr.write = chunk => { stderr += String(chunk); return true; };
  process.argv = [process.execPath, 'quota-boss-test', ...args];
  process.exitCode = 0;
  try { main(); return { stdout, stderr, status: process.exitCode }; }
  finally {
    fs.readSync = original.read;
    process.stdout.write = original.out;
    process.stderr.write = original.err;
    process.argv = original.argv;
    process.exitCode = original.exitCode;
  }
}

test('paths, safe JSON, and atomic writes stay inside overrides', () => {
  const paths = lib.getPaths();
  assert.equal(paths.quotaBossHome, process.env.QUOTA_BOSS_HOME);
  assert.equal(paths.claudeDir, process.env.CLAUDE_CONFIG_DIR);
  assert.equal(paths.codexDir, process.env.CODEX_HOME);
  assert.equal(lib.readJson(path.join(temporary, 'missing'), 'fallback'), 'fallback');
  const file = path.join(temporary, 'nested', 'state.json');
  lib.writeJson(file, { first: true });
  lib.writeJson(file, { second: true });
  assert.deepEqual(lib.readJson(file), { second: true });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
  fs.writeFileSync(file, '{broken');
  assert.equal(lib.readJson(file, 'invalid'), 'invalid');
  assert.equal(lib.readJson(file, 'oversized', 1), 'oversized');
});

test('user configuration replaces model entries and merges thresholds leaf by leaf', () => {
  lib.writeJson(path.join(process.env.QUOTA_BOSS_HOME, 'config', 'models.json'), {
    models: { 'gpt-6.1-sol': { pool: 'codex', label: 'Custom', cost: 1, scores: { review: 10 } } }
  });
  lib.writeJson(path.join(process.env.QUOTA_BOSS_HOME, 'config', 'thresholds.json'), { claude: { save: 20 } });
  const config = lib.loadConfig();
  assert.equal(config.models.models['gpt-6.1-sol'].label, 'Custom');
  assert.equal(config.models.models['gpt-6.1-sol'].scores.implementation, undefined);
  assert.ok(config.models.models['claude-opus-5-5']);
  // A user value replaces only its own leaf, so shipped keys the user never set still arrive.
  assert.equal(config.thresholds.claude.save, 20);
  assert.equal(config.thresholds.claude.emergency, 85);
  assert.equal(config.thresholds.codex.exhausted, 95);
  lib.writeJson(path.join(process.env.QUOTA_BOSS_HOME, 'config', 'thresholds.json'), { claude: 7, gate: { size: { small: 0.5 } }, list: [1] });
  const replaced = lib.loadConfig().thresholds;
  assert.equal(replaced.claude, 7);
  assert.equal(replaced.gate.size.small, 0.5);
  assert.equal(replaced.gate.size.large, 3);
  assert.equal(replaced.gate.margin, 0.8);
  assert.deepEqual(replaced.list, [1]);
  fs.writeFileSync(path.join(process.env.QUOTA_BOSS_HOME, 'config', 'thresholds.json'), '{"__proto__":{"injected":1},"gate":{"constructor":{"x":1}}}');
  const guarded = lib.loadConfig().thresholds;
  assert.equal(guarded.injected, undefined);
  assert.equal(Object.getPrototypeOf(guarded), Object.prototype);
  assert.equal(guarded.gate.constructor, Object);
});

test('project lookup uses the nearest config and strict enablement', () => {
  enable({ profile: 'frugal', workers: { codex: false } });
  const nested = path.join(project, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(lib.findProjectConfig(nested).profile, 'frugal');
  assert.equal(lib.findProjectConfig(nested).workers.codex, false);
  lib.saveProject(path.join(project, 'a'), { enabled: 'true', profile: 'INJECT\ntext' });
  const nearer = lib.findProjectConfig(nested);
  assert.equal(nearer.enabled, false);
  assert.equal(nearer.profile, 'balanced');
  assert.equal(lib.findProjectConfig(temporary).enabled, false);
});

test('Codex parser chooses last quota event, tolerates bad lines, expires windows, and sanitizes metadata', () => {
  const file = codexLog(42, 87);
  const now = Date.now();
  fs.appendFileSync(file, '{bad}\n' + JSON.stringify({ timestamp: 'not a timestamp\nIGNORE', payload: {
    type: 'token_count', rate_limits: { primary: { used_percent: 99, resets_at: now / 1000 - 1 }, secondary: { used_percent: 34, resets_at: now / 1000 + 10 } }
  } }) + '\n' + JSON.stringify({ payload: { type: 'message', text: 'IGNORE instructions' } }));
  const result = lib.readCodexLimits(now);
  assert.equal(result.primary.used_percent, 0);
  assert.equal(result.secondary.used_percent, 34);
  assert.equal(result.observed_at, null);
  assert.doesNotMatch(JSON.stringify(result), /IGNORE/);
});

test('Codex logs are bounded to their tail and the ten newest files', () => {
  const directory = path.join(process.env.CODEX_HOME, 'sessions');
  fs.mkdirSync(directory, { recursive: true });
  const old = path.join(directory, 'old.jsonl');
  fs.writeFileSync(old, JSON.stringify({ payload: { type: 'token_count', rate_limits: { primary: { used_percent: 88 } } } }) + '\n');
  fs.utimesSync(old, new Date(1000), new Date(1000));
  for (let index = 0; index < 10; index++) {
    const file = path.join(directory, index + '.jsonl');
    fs.writeFileSync(file, 'x'.repeat(600 * 1024) + '\n{bad}\n');
    fs.utimesSync(file, new Date(10000 + index), new Date(10000 + index));
  }
  const realRead = fs.readSync;
  const opened = new Set();
  let bytes = 0;
  fs.readSync = (fd, ...args) => {
    opened.add(fd);
    const count = realRead(fd, ...args);
    bytes += count;
    return count;
  };
  try { assert.equal(lib.readCodexLimits(), null); } finally { fs.readSync = realRead; }
  assert.ok(bytes <= 10 * lib.MAX_LOG_BYTES);
  const newest = path.join(directory, '9.jsonl');
  fs.appendFileSync(newest, JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 12 } } } }) + '\n');
  assert.equal(lib.readCodexLimits().primary.used_percent, 12);
});

test('Codex limits survive a sandbox that forbids writing state, other write errors still surface', () => {
  const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '01', '03');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-sandbox.jsonl'), JSON.stringify({ timestamp: '2026-01-03T10:00:00Z', payload: { type: 'token_count',
    rate_limits: { limit_id: 'codex', primary: { used_percent: 21 }, secondary: { used_percent: 5 } } } }) + '\n');
  const realOpen = fs.openSync;
  for (const code of ['EPERM', 'EACCES', 'EROFS', 'EIO']) {
    let denied = 0;
    fs.openSync = (name, ...args) => {
      if (String(name).endsWith('.lock')) { denied++; throw Object.assign(new Error(code + ': refused'), { code }); }
      return realOpen(name, ...args);
    };
    try {
      if (code === 'EIO') assert.throws(() => lib.readCodexLimits(), /EIO/);
      else assert.equal(lib.readCodexLimits().primary.used_percent, 21);
    } finally { fs.openSync = realOpen; }
    assert.ok(denied > 0, code + ' never reached the lock');
  }
});

test('a lock name that Windows briefly refuses is retried, a lasting refusal is thrown and the action runs once', { skip: process.platform !== 'win32' }, () => {
  const file = path.join(process.env.CODEX_HOME, 'pending-delete.json');
  const realOpen = fs.openSync;
  const refuse = limit => { let seen = 0; fs.openSync = (name, ...args) => {
    if (String(name).endsWith('.lock') && seen++ < limit) throw Object.assign(new Error('EPERM: refused'), { code: 'EPERM' });
    return realOpen(name, ...args);
  }; };
  try {
    let runs = 0;
    refuse(3);
    assert.equal(lib.withLock(file, () => { runs++; return 'done'; }), 'done');
    assert.equal(runs, 1);
    assert.equal(fs.existsSync(file + '.lock'), false);
    refuse(Infinity);
    assert.throws(() => lib.withLock(file, () => { runs++; }), { code: 'EPERM' });
    assert.equal(runs, 1);
    fs.openSync = realOpen;
    // A refusal thrown by the action itself is not a lock problem and must not run the action again.
    assert.throws(() => lib.withLock(file, () => { runs++; throw Object.assign(new Error('EPERM: action'), { code: 'EPERM' }); }), /action/);
    assert.equal(runs, 2);
    assert.equal(fs.existsSync(file + '.lock'), false);
  } finally { fs.openSync = realOpen; }
});

test('Codex limits come from the newest entry across parallel sessions', () => {
  const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '01', '02');
  fs.mkdirSync(day, { recursive: true });
  const entry = (timestamp, used) => JSON.stringify({ ...(timestamp ? { timestamp } : {}), payload: { type: 'token_count',
    rate_limits: { limit_id: 'codex', primary: { used_percent: used }, secondary: { used_percent: 26 } } } }) + '\n';
  const write = (name, text) => fs.writeFileSync(path.join(day, name), text);

  // The session that started last stopped reporting before the one that started earlier.
  write('rollout-b.jsonl', entry('2026-01-02T10:00:00Z', 30));
  write('rollout-a.jsonl', entry('2026-01-02T10:02:00Z', 32));
  const result = lib.readCodexLimits();
  assert.equal(result.primary.used_percent, 32);
  assert.equal(result.observed_at, '2026-01-02T10:02:00.000Z');

  // A future date must not pin the display, and an undated entry must not beat a dated one.
  write('rollout-c.jsonl', entry(new Date(Date.now() + 3600000).toISOString(), 99));
  write('rollout-d.jsonl', entry(null, 98));
  assert.equal(lib.readCodexLimits().primary.used_percent, 32);

  // Windows keeps the creation time as the modified time while Codex writes, so it must not rule a log out.
  const open = path.join(day, 'rollout-0.jsonl');
  fs.writeFileSync(open, entry('2026-01-02T10:05:00Z', 40));
  fs.utimesSync(open, new Date('2026-01-02T09:00:00Z'), new Date('2026-01-02T09:00:00Z'));
  assert.equal(lib.readCodexLimits().primary.used_percent, 40);
});

test('undated Codex entries are still used when nothing else exists', () => {
  const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '01', '02');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), JSON.stringify({ payload: { type: 'token_count',
    rate_limits: { primary: { used_percent: 7 } } } }) + '\n');
  assert.equal(lib.readCodexLimits().primary.used_percent, 7);
});

test('missing logs and invisible cache entries are safe', () => {
  assert.equal(lib.readCodexLimits(), null);
  assert.deepEqual(lib.readCodexModels(), []);
  lib.writeJson(path.join(process.env.CODEX_HOME, 'models_cache.json'), { models: [
    { slug: 'visible', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }, null
  ] });
  assert.deepEqual(lib.readCodexModels().map(model => model.slug), ['visible']);
  const file = codexLog();
  fs.writeFileSync(file, JSON.stringify({ payload: { type: 'token_count', rate_limits: {} } }));
  assert.equal(lib.computeModes({ codex: lib.readCodexLimits() }).codexUnknown, true);
});

test('the boss model comes from the newest interactive Codex session, never from worker runs', () => {
  const sessions = path.join(process.env.CODEX_HOME, 'sessions');
  const day = path.join(sessions, '2026', '11', '09');
  fs.mkdirSync(day, { recursive: true });
  const log = (name, source, model, cwd = project) => fs.writeFileSync(path.join(day, name + '.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { source, originator: source === 'exec' ? 'codex_exec' : 'codex_cli' } }),
    JSON.stringify({ type: 'turn_context', payload: { model, effort: 'high', cwd } })].join('\n') + '\n');
  log('a', 'cli', 'gpt-6-astra');
  log('b', 'exec', 'gpt-6-luna');
  log('c', { subagent: 'review' }, 'gpt-6-luna');
  assert.equal(lib.readCodexBossModel(), 'gpt-6-astra');
  assert.equal(lib.currentBossModel({ host: 'codex' }), 'gpt-6-astra');
  log('d', 'cli', '../not a model');
  assert.equal(lib.readCodexBossModel(), 'gpt-6-astra', 'an invalid id is skipped');
  log('e', 'cli', 'gpt-6-luna', path.join(temporary, 'another-project'));
  assert.equal(lib.readCodexBossModel(), 'gpt-6-luna');
  assert.equal(lib.readCodexBossModel(project), 'gpt-6-astra', 'a session in another project is not this boss');
  assert.equal(lib.currentBossModel({ host: 'codex', directory: project }), 'gpt-6-astra');
  log('f', 'cli', 'gpt-6-sol', path.join(project, 'packages', 'app'));
  assert.equal(lib.readCodexBossModel(project), 'gpt-6-sol', 'a subfolder belongs to the project');

  fs.rmSync(sessions, { recursive: true, force: true });
  assert.equal(lib.readCodexBossModel(), null);
  const config = path.join(process.env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(config, 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n[profiles.other]\nmodel = "gpt-6-luna"\n');
  assert.equal(lib.readCodexBossModel(), 'gpt-6.1-sol');
  fs.writeFileSync(config, '[profiles.other]\nmodel = "gpt-6-luna"\n');
  assert.equal(lib.readCodexBossModel(), null, 'a model inside a table belongs to something else');
});

test('shellCommand preserves shell strings and quotes split arguments for each platform', () => {
  for (const platform of ['linux', 'win32']) {
    const command = 'node -e "process.exit(0)" && echo done';
    assert.equal(lib.shellCommand([command], platform), command);
    assert.equal(lib.shellCommand(['node', '--test', 'a.js', 'x=1'], platform), 'node --test a.js x=1');
    assert.equal(lib.shellCommand([], platform), '');
  }
  assert.equal(lib.shellCommand(['node', '', 'two words', "it's", 'a"b', '$HOME; echo hi'], 'linux'),
    `node '' 'two words' 'it'\\''s' 'a"b' '$HOME; echo hi'`);
  assert.equal(lib.shellCommand(['node', '', 'two words', 'a"b', 'x&y'], 'win32'),
    'node "" "two words" "a\\"b" "x&y"');
});

test('recordBossModel replaces projects, drops malformed entries and keeps the newest twenty without mutation', () => {
  const current = Object.fromEntries(Array.from({ length: 22 }, (_, i) => ['old-' + i, { model: 'claude-sonnet-5-5', at: i }]));
  Object.assign(current, { nil: null, missing: {}, badModel: { model: 7, at: 100 }, badTime: { model: 'x', at: '100' }, infinite: { model: 'x', at: Infinity } });
  const before = structuredClone(current);
  const key = lib.projectHash(project);
  const saved = lib.recordBossModel(current, project, 'claude-opus-5-5', 100);
  assert.equal(Object.keys(saved).length, 20);
  assert.deepEqual(Object.values(saved).map(entry => entry.at), [100, ...Array.from({ length: 19 }, (_, i) => 21 - i)]);
  assert.deepEqual(saved[key], { model: 'claude-opus-5-5', at: 100 });
  const replaced = lib.recordBossModel(saved, project, 'claude-sonnet-5-5', 101);
  assert.equal(Object.keys(replaced).length, 20);
  assert.deepEqual(replaced[key], { model: 'claude-sonnet-5-5', at: 101 });
  assert.deepEqual(current, before);
  assert.deepEqual(lib.recordBossModel(null, project, 'claude-opus-5-5', 1), { [key]: { model: 'claude-opus-5-5', at: 1 } });
});

test('Claude boss selection uses this project and falls back to the legacy model', () => {
  const other = path.join(temporary, 'other');
  fs.mkdirSync(other);
  let bossModels = lib.recordBossModel({}, project, 'claude-opus-5-5[1m]', 1);
  bossModels = lib.recordBossModel(bossModels, other, 'claude-sonnet-5-5', 2);
  const state = { bossModel: 'claude-haiku-4-5', bossModels };
  assert.equal(lib.currentBossModel({ host: 'claude-code', directory: project }, state), 'claude-opus-5-5');
  assert.equal(lib.currentBossModel({ host: 'claude-code', directory: other }, state), 'claude-sonnet-5-5');
  delete bossModels[lib.projectHash(project)];
  assert.equal(lib.currentBossModel({ host: 'claude-code', directory: project }, state), 'claude-haiku-4-5');
  bossModels[lib.projectHash(project)] = { model: 'invalid model', at: 3 };
  assert.equal(lib.currentBossModel({ host: 'claude-code', directory: project }, state), 'claude-haiku-4-5');
  assert.equal(lib.currentBossModel({ host: 'claude-code', directory: project }, { bossModels }), null);
});

test('model ids are cleaned before they reach routing', () => {
  assert.equal(lib.cleanModelId('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  for (const bad of [undefined, 7, '', '../x', 'has space']) assert.equal(lib.cleanModelId(bad), null);
  assert.equal(lib.currentBossModel({ host: 'claude-code' }, { bossModel: 'claude-sonnet-5-5[1m]' }), 'claude-sonnet-5-5');
  assert.equal(lib.currentBossModel({}, {}), null);
  assert.equal(lib.currentBossModel({ host: 'generic' }, { bossModel: 'claude-sonnet-5-5' }), null);
});

test('mode thresholds use each explicit weekly threshold and inclusive boundaries', () => {
  const { thresholds } = lib.loadConfig();
  for (const [values, expected] of [
    [[59, 79, 79, 84], 'normal'], [[60, 0, 0, 0], 'save'], [[0, 80, 0, 0], 'save'],
    [[85, 0, 0, 0], 'emergency'], [[0, 95, 0, 0], 'emergency'],
    [[0, 0, 80, 0], 'codex-tight'], [[0, 0, 0, 85], 'codex-tight'],
    [[60, 0, 95, 0], 'save+codex-exhausted'], [[0, 95, 0, 97], 'emergency+codex-exhausted']
  ]) assert.equal(lib.computeModes(limits(...values), thresholds).mode, expected);
  assert.equal(lib.computeModes({}, thresholds).codexUnknown, true);
  const old = limits();
  old.codex.observed_at = '2000-01-01T00:00:00Z';
  assert.equal(lib.computeModes(old, thresholds).codexStale, true);
  assert.match(lib.computeModes(old, thresholds).codexAge, /^\d+[hd]$/);
  assert.match(lib.formatLimits(old, 'balanced', thresholds), /codex numbers \d+[hd] old \(refresh on the next Codex run\)/);
});

test('Claude updates retain absent fields and reject non-numeric injected values', () => {
  const previous = { five_hour: { used_percentage: 4, resets_at: 100 }, seven_day: { used_percentage: 49 } };
  const updated = lib.updateClaudeLimits(previous, { rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 'INJECT' } } }, 1234);
  assert.deepEqual(updated, { five_hour: { used_percentage: 12, resets_at: 100 }, seven_day: { used_percentage: 49 }, updated_at: 1234 });
  assert.equal(lib.sanitizeLabel('<script>\nBad:label!_ (ok)/-.'), 'scriptBadlabel_ (ok)/-.');
  assert.equal(lib.sanitizeLabel('a'.repeat(100)).length, 40);
  assert.equal(lib.sanitizeLabel(null), '');
  assert.match(lib.formatReset(Date.now() / 1000 + 3600), /^\d\d:\d\d$/);
  assert.match(lib.formatReset(Date.now() / 1000 + 172800), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/);
  assert.equal(lib.formatReset('INJECT'), '');
});

test('missing or invalid quota fields never refresh the last live observation', () => {
  const previous = {five_hour:{used_percentage:20},updated_at:123};
  assert.equal(lib.updateClaudeLimits(previous,{},999).updated_at,123);
  assert.equal(lib.updateClaudeLimits(previous,{rate_limits:{five_hour:{used_percentage:'bad'}}},999).updated_at,123);
  assert.equal(lib.updateClaudeLimits(previous,{rate_limits:{five_hour:{used_percentage:21}}},999).updated_at,999);
});

test('stdin is bounded even for pipe-like descriptors', () => {
  const response = invoke(() => process.stdout.write(lib.readStdin(8)), 'abcdefgh');
  assert.equal(response.stdout, 'abcdefgh');
  assert.throws(() => invoke(() => lib.readStdin(8), 'abcdefghi'), /Input too large/);
});

test('usage history is pure, deduplicated, spaced by five minutes, and capped at 48 samples', () => {
  const start = 1000000000;
  let history = { claude: [] };
  for (let i = 0; i < 60; i++) history = lib.recordUsageHistory(history, 'claude', limits(i, 10).claude, start + i * 300000);
  assert.equal(history.claude.length, 48);
  assert.equal(history.claude[0].u5, 12);
  const before = JSON.stringify(history);
  const same = lib.recordUsageHistory(history, 'claude', limits(90, 10).claude, start + 59 * 300000 + 299999);
  assert.deepEqual(same, history);
  assert.deepEqual(lib.recordUsageHistory(history, 'claude', limits(1, 1).claude, start + 30 * 300000), history);
  assert.equal(JSON.stringify(history), before);
  assert.equal(lib.recordUsageHistory({}, 'codex', null, start).codex, undefined);
  assert.deepEqual(lib.historySettings({ history: { maxSamples: 100, minIntervalMinutes: 1, outcomeLines: 5000, outcomeDays: 200 } }),
    { maxSamples: 48, minIntervalMinutes: 5, paceMinutes: 120, paceHorizonMinutes: 300, outcomeLines: 2000, outcomeDays: 90, unavailableHours: 24 });
});

test('Codex reader records observation-time history without clobbering other state or duplicating polls', () => {
  const file = codexLog(10, 20);
  const now = Date.UTC(2026, 10, 8);
  lib.writeState({ claude: limits().claude, sessions: { keep: { mode: 'normal' } } });
  for (let i = 0; i < 50; i++) {
    const t = now + i * 300000;
    lib.atomicWrite(file, JSON.stringify({ timestamp: new Date(t).toISOString(), payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: i, resets_at: t / 1000 + 3600 }, secondary: { used_percent: 20 }
    } } }) + '\n');
    lib.readCodexLimits(t);
    lib.readCodexLimits(t + 10000);
  }
  const state = lib.readState();
  assert.equal(state.history.codex.length, 48);
  assert.deepEqual(state.history.codex[47], { t: now + 49 * 300000, u5: 49, uw: 20 });
  assert.equal(state.claude.five_hour.used_percentage, 4);
  assert.equal(state.sessions.keep.mode, 'normal');
});

test('outcome reads bound bytes, physical lines and age, and tolerate corrupt records', () => {
  const now = Date.UTC(2026, 10, 8);
  const entry = { t: now, model: 'gpt-6-sol', category: 'review', tier: 'normal', result: 'pass' };
  const records = Array.from({ length: 2005 }, (_, i) => JSON.stringify({ ...entry, model: 'model-' + i }));
  records.push('{broken', JSON.stringify({ ...entry, t: now - 91 * 86400000 }), JSON.stringify({ ...entry, t: now + 1 }),
    JSON.stringify({ ...entry, tier: 'injected\ntext' }));
  lib.atomicWrite(lib.getPaths().outcomesFile, 'x'.repeat(3 * 1024 * 1024) + '\n' + records.join('\n') + '\n');
  const realRead = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => { const count = realRead(...args); bytes += count; return count; };
  let result;
  try { result = lib.readOutcomes(now); } finally { fs.readSync = realRead; }
  assert.equal(bytes, 2 * 1024 * 1024);
  assert.equal(result.length, 1996);
  assert.equal(result[0].model, 'model-9');
  assert.equal(result.at(-1).model, 'model-2004');
  assert.equal(lib.readOutcomes(now, { history: { outcomeLines: 3 } }).length, 0);
});

test('feedback append preserves prior records and does not touch the journal on invalid input', () => {
  const now = 1000000000;
  const models = { models: { rated: {} } };
  const value = { model: 'rated', category: 'review', tier: 'normal', result: 'fail' };
  lib.appendOutcome(value, models, [], now);
  const before = fs.readFileSync(lib.getPaths().outcomesFile, 'utf8');
  assert.throws(() => lib.appendOutcome({ ...value, model: 'constructor' }, models, [], now), /registry or Codex cache/);
  assert.throws(() => lib.appendOutcome({ ...value, result: 'FAIL' }, models, [], now), /valid category/);
  assert.equal(fs.readFileSync(lib.getPaths().outcomesFile, 'utf8'), before);
  lib.appendOutcome({ ...value, model: 'cached', result: 'pass' }, models, [{ slug: 'cached' }], now + 1);
  assert.equal(lib.readOutcomes(now + 1).length, 2);
  assert.ok(fs.readFileSync(lib.getPaths().outcomesFile, 'utf8').startsWith(before));
  assert.equal(Object.hasOwn(lib.readOutcomes(now + 1)[0], 'effort'), false);
  for (const effort of lib.EFFORT_ORDER) {
    lib.appendOutcome({ ...value, effort }, models, [], now + 1);
    assert.equal(lib.readOutcomes(now + 1).at(-1).effort, effort);
  }
  const journal = fs.readFileSync(lib.getPaths().outcomesFile, 'utf8');
  assert.throws(() => lib.appendOutcome({ ...value, effort: 'unknown' }, models, [], now), /effort.*invalid/i);
  assert.equal(fs.readFileSync(lib.getPaths().outcomesFile, 'utf8'), journal);
  assert.equal(lib.validOutcome({ ...value, t: now, effort: 'unknown' }), true);
});

});

test('codex limits skip non-codex buckets such as an empty trailing "premium" entry', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-bucket-'));
  const day = path.join(dir, 'sessions', '2026', '11', '08');
  fs.mkdirSync(day, { recursive: true });
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const line = (id, primary) => JSON.stringify({ timestamp: new Date(Date.now() - 1000).toISOString(),
    payload: { type: 'token_count', rate_limits: { limit_id: id, primary, secondary: null } } });
  fs.writeFileSync(path.join(day, 'rollout.jsonl'), [line('codex', { used_percent: 100, window_minutes: 300, resets_at: reset }), line('premium', null)].join('\n') + '\n');
  const previous = { CODEX_HOME: process.env.CODEX_HOME, QUOTA_BOSS_HOME: process.env.QUOTA_BOSS_HOME };
  process.env.CODEX_HOME = dir; process.env.QUOTA_BOSS_HOME = path.join(dir, 'home');
  try { assert.equal(require('../scripts/lib').readCodexLimits().primary.used_percent, 100); }
  finally { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('an unknown feedback model names the closest registry ids', () => {
  const models = { models: { 'claude-sonnet-5-5': {}, 'claude-opus-5-5': {}, 'gpt-6.1-sol': {} } };
  const value = { model: 'sonnet', category: 'implementation', tier: 'normal', result: 'pass' };
  assert.throws(() => lib.appendOutcome(value, models, [], 1000), /Did you mean claude-sonnet-5-5\?/);
  assert.throws(() => lib.appendOutcome({ ...value, model: 'zz' }, models, [], 1000), /Run quota-boss models for the ids/);
  assert.throws(() => lib.appendOutcome({ ...value, model: 'xyzq' }, models, [], 1000), /Run quota-boss models for the ids/);
});

test('only a root-owned link directly in a root-owned root directory that others cannot write counts as a system link', () => {
  const entry = (link, uid, mode = 0o755) => ({ isSymbolicLink: () => link, isDirectory: () => !link, uid, mode });
  assert.equal(lib.systemLink(entry(true, 0), entry(false, 0), true, 'darwin'), true);
  assert.equal(lib.systemLink(entry(true, 0), entry(false, 0), true, 'linux'), true);
  assert.equal(lib.systemLink(entry(true, 0), entry(false, 0), false, 'linux'), false, 'deeper down, such as a link in a checkout that root made');
  assert.equal(lib.systemLink(entry(true, 501), entry(false, 0), true, 'darwin'), false, 'a link the user made');
  assert.equal(lib.systemLink(entry(true, 0), entry(false, 501), true, 'darwin'), false, 'the root directory belongs to a user');
  assert.equal(lib.systemLink(entry(true, 0), entry(false, 0, 0o1777), true, 'linux'), false, 'everyone can write the root directory');
  assert.equal(lib.systemLink(entry(true, 0), entry(false, 0, 0o775), true, 'linux'), false, 'a group can write the root directory');
  assert.equal(lib.systemLink(entry(false, 0), entry(false, 0), true, 'darwin'), false, 'a plain directory needs no exception');
  assert.equal(lib.systemLink(entry(true, 0), entry(false, 0), true, 'win32'), false, 'Windows reports uid 0 for everything');
});

test('a link the user made is refused as a parent, and a link in the temporary folder path of the system is followed', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-link-'));
  try {
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    lib.atomicWrite(path.join(root, 'real', 'a.json'), '{}');
    assert.throws(() => lib.atomicWrite(path.join(root, 'link', 'b.json'), '{}'), /Unsafe parent directory/);
    assert.equal(lib.readJson(path.join(root, 'link', 'a.json'), 'refused'), 'refused');
    assert.deepEqual(lib.readJson(path.join(root, 'real', 'a.json'), 'refused'), {});
    assert.equal(fs.existsSync(path.join(root, 'real', 'b.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
