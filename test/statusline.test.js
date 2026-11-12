'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('../scripts/lib');

test.describe('statusline', () => {
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

const statusline = require('../scripts/statusline');
const strip = value => value.replace(/\x1b\[[0-9;]*m/g, '');

test('statusline persists Claude windows, preserves absent fields, and displays active project', () => {
  enable();
  codexLog(0, 2);
  const input = { cwd: project, rate_limits: { five_hour: { used_percentage: 4, resets_at: Date.now() / 1000 + 3600 }, seven_day: { used_percentage: 49 } } };
  const first = invoke(statusline.main, JSON.stringify(input));
  assert.equal(first.status, 0);
  assert.equal(first.stderr, '');
  assert.match(strip(first.stdout), /^C 5h 4% ↻\d\d:\d\d · wk 49% │ X 5h 0% · wk 2% │ boss on:balanced\n$/);
  assert.match(first.stdout, /\x1b\[32m4%/);
  const previous = lib.readState().claude;
  assert.equal(typeof previous.updated_at, 'number');
  const second = invoke(statusline.main, JSON.stringify({ cwd: project, rate_limits: { five_hour: { used_percentage: 62 } } }));
  assert.match(second.stdout, /\x1b\[33m62%/);
  const current = lib.readState().claude;
  assert.equal(current.seven_day.used_percentage, 49);
  assert.equal(current.five_hour.resets_at, previous.five_hour.resets_at);
});

test('statusline colors weekly thresholds, keeps only Claude and Codex when boss is off, and shows unknown safely', () => {
  const line = statusline.formatStatus(limits(85, 80, 95, 85), { enabled: false }, lib.loadConfig().thresholds, Date.now(), undefined, 'ctx 50%');
  assert.match(line, /\x1b\[31m85%/);
  assert.match(line, /\x1b\[33m80%/);
  assert.match(line, /\x1b\[31m95%/);
  assert.match(strip(line), /^C 5h .* │ X 5h \d+% · wk \d+%/);
  assert.doesNotMatch(line, /boss|ctx/);
  lib.writeJson(lib.statuslineFile(), { showWithoutBoss: true });
  const unknown = invoke(statusline.main, '{}');
  assert.match(strip(unknown.stdout), /X 5h \? · wk \?.*codex data unknown/);
});

test('statusline prints nothing without boss mode by default but keeps a wrapped user status line', () => {
  codexLog(0, 2);
  const input = JSON.stringify({ cwd: project, rate_limits: { five_hour: { used_percentage: 4 }, seven_day: { used_percentage: 49 } } });
  assert.equal(invoke(statusline.main, input).stdout, '');
  assert.equal(lib.readState().claude.five_hour.used_percentage, 4);
  lib.writeJson(path.join(process.env.QUOTA_BOSS_HOME, 'wrapped-statusline.json'), { command: `"${process.execPath}" -e "console.log('mine')"` });
  assert.equal(invoke(statusline.main, input).stdout, 'mine\n');
});

test('quota-boss statusline saves the choice for every project and rejects anything else', () => {
  const cli = require('../scripts/quota-boss');
  assert.match(cli.run(['set', 'statusline', 'boss']), /only where boss mode is on/);
  assert.match(cli.run(['set', 'statusline', 'always']), /also show where boss mode is off/);
  assert.equal(lib.showsWithoutBoss(), true);
  codexLog(0, 2);
  assert.match(strip(invoke(statusline.main, JSON.stringify({ cwd: project })).stdout), /^C 5h .* │ X 5h 0% · wk 2%\n$/);
  assert.match(cli.run(['set', 'statusline', 'boss']), /only where boss mode is on/);
  assert.equal(lib.showsWithoutBoss(), false);
  assert.throws(() => cli.run(['set', 'statusline', 'sometimes']), /Valid values/);
});

test('the status line remembers which model the boss runs on', () => {
  const statusline = require('../scripts/statusline');
  invoke(statusline.main, JSON.stringify({ cwd: project, model: { id: 'claude-sonnet-5-5[1m]' } }));
  assert.equal(lib.readState().bossModel, 'claude-sonnet-5-5');
  invoke(statusline.main, JSON.stringify({ cwd: project, model: { id: 'not a model' } }));
  assert.equal(lib.readState().bossModel, 'claude-sonnet-5-5', 'an invalid id does not replace the last good one');
});

test('statusline remembers models per project and preserves them on missing or invalid input', () => {
  const other = path.join(temporary, 'other');
  fs.mkdirSync(other);
  enable();
  lib.saveProject(other, { enabled: true, host: 'claude-code' });
  invoke(statusline.main, JSON.stringify({ cwd: project, model: { id: 'claude-opus-5-5[1m]' } }));
  const first = lib.readState().bossModels[lib.projectHash(project)];
  assert.equal(first.model, 'claude-opus-5-5');
  assert.equal(typeof first.at, 'number');
  invoke(statusline.main, JSON.stringify({ cwd: other, model: { id: 'claude-sonnet-5-5' } }));
  let state = lib.readState();
  assert.deepEqual(state.bossModels[lib.projectHash(project)], first);
  assert.equal(state.bossModels[lib.projectHash(other)].model, 'claude-sonnet-5-5');
  assert.equal(state.bossModel, 'claude-sonnet-5-5');
  assert.equal(lib.currentBossModel({ host: 'claude-code', directory: project }, state), 'claude-opus-5-5');
  const before = state.bossModels;
  for (const model of [undefined, { id: 'invalid model' }]) invoke(statusline.main, JSON.stringify({ cwd: project, model }));
  assert.deepEqual(lib.readState().bossModels, before);
  invoke(statusline.main, JSON.stringify({ cwd: project, model: { id: 'claude-haiku-4-5' } }));
  state = lib.readState();
  assert.equal(Object.keys(state.bossModels).length, 2);
  assert.equal(state.bossModels[lib.projectHash(project)].model, 'claude-haiku-4-5');
  assert.equal(state.bossModels[lib.projectHash(other)].model, 'claude-sonnet-5-5');
});

test('statusline records Claude history with injected time and preserves Codex history and sessions', () => {
  const now = Date.UTC(2026, 10, 8);
  const clock = Date.now;
  lib.writeState({ sessions: { keep: { mode: 'normal' } }, history: { codex: [{ t: now, u5: 2, uw: 3 }] } });
  try {
    Date.now = () => now;
    invoke(statusline.main, JSON.stringify({ cwd: project, rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 20 } } }));
    Date.now = () => now + 299999;
    invoke(statusline.main, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } } }));
    assert.deepEqual(lib.readState().history.claude, [{ t: now, u5: 10, uw: 20 }]);
    Date.now = () => now + 300000;
    invoke(statusline.main, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 15 } } }));
    const state = lib.readState();
    assert.deepEqual(state.history.claude.at(-1), { t: now + 300000, u5: 15, uw: 20 });
    assert.deepEqual(state.history.codex, [{ t: now, u5: 2, uw: 3 }]);
    assert.equal(state.sessions.keep.mode, 'normal');
  } finally { Date.now = clock; }
});

test('malformed and oversized stdin produce a minimal successful fallback', () => {
  for (const input of ['{broken', 'x'.repeat(1024 * 1024 + 1)]) {
    const result = invoke(statusline.main, input);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '');
  }
  lib.writeJson(lib.statuslineFile(), { showWithoutBoss: true });
  assert.equal(invoke(statusline.main, '{broken').stdout, 'C 5h ? · wk ? │ X 5h ? · wk ?\n');
});

test('statusline write errors cannot break Claude Code', () => {
  fs.writeFileSync(process.env.QUOTA_BOSS_HOME, 'not a directory');
  const result = invoke(statusline.main, '{}');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('wrapped status command receives identical stdin with bounded execution and output first', () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawnSync;
  const modulePath = require.resolve('../scripts/statusline');
  const originalModule = require.cache[modulePath];
  const input = JSON.stringify({ cwd: project });
  enable();
  lib.writeJson(path.join(process.env.QUOTA_BOSS_HOME, 'wrapped-statusline.json'), { command: 'user-owned command' });
  let called = 0;
  childProcess.spawnSync = (command, args, options) => {
    called++;
    assert.equal(command, 'user-owned command');
    assert.deepEqual(args, []);
    assert.equal(options.input, input);
    assert.equal(options.shell, true);
    assert.equal(options.timeout, 2000);
    assert.equal(options.maxBuffer, 65536);
    return { status: 0, stdout: 'previous status\n' };
  };
  delete require.cache[modulePath];
  try {
    const wrapped = require('../scripts/statusline');
    const result = invoke(wrapped.main, input);
    assert.match(result.stdout, /^previous status\nC 5h/);
    assert.equal(called, 1);
    childProcess.spawnSync = () => ({ status: null, error: new Error('timeout') });
    delete require.cache[modulePath];
    const failed = invoke(require('../scripts/statusline').main, input);
    assert.match(failed.stdout, /^C 5h/);
    assert.equal(failed.status, 0);
  } finally {
    childProcess.spawnSync = originalSpawn;
    require.cache[modulePath] = originalModule;
  }
});

});
