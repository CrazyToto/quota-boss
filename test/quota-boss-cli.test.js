'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('../scripts/lib');

test.describe('quota-boss-cli', () => {
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

const cli = require('../scripts/quota-boss');

function command(args) { return invoke(cli.main, '', args); }

test('--help prints help to stdout and exits 0', () => {
  const result = command(['--help']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.includes('Quota Boss help'));
  assert.ok(result.stdout.includes('verify'));
  assert.ok(result.stdout.includes('feedback'));
  assert.ok(result.stdout.includes('worktree'));
  assert.ok(result.stdout.includes('graph'));
  assert.ok(result.stdout.includes('providers'));
  assert.ok(result.stdout.includes('--explain'));
  assert.ok(result.stdout.includes('--size'));
});

test('-h is an alias for --help', () => {
  const result = command(['-h']);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('Quota Boss help'));
});
function config() { return lib.readProjects()[lib.projectKey(project)]; }

test('on, profile and off with --project persist only in the current project', () => {
  let result = command(['on', '--project']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Quota Boss on \| profile balanced/);
  assert.equal(config().enabled, true);
  assert.equal(command(['set', 'profile', 'frugal', '--project']).status, 0);
  assert.equal(config().profile, 'frugal');
  const removed = command(['set', 'codex-tasks', 'off']);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /codex-tasks was removed in 0.2.0: switch Codex with quota-boss use codex on|off./);
  assert.equal(config().workers, undefined);
  assert.equal(command(['off', '--project']).status, 0);
  assert.equal(config().enabled, false);
  assert.equal(config().profile, 'frugal');
  assert.equal(command(['on', 'quality', '--project']).status, 0);
  assert.equal(config().profile, 'quality');
  assert.equal(lib.readProjects()[lib.projectKey(temporary)], undefined);
});

test('on, off and set count for every project unless --project is given, and the current project follows them', () => {
  const other = path.join(temporary, 'other');
  fs.mkdirSync(other);
  enable({ custom: { retain: true } });
  assert.match(command(['on', 'frugal']).stdout, /Quota Boss on | profile frugal | all projects/);
  // The project's own copy of the changed fields goes; other keys stay.
  assert.equal(config().enabled, undefined);
  assert.equal(config().profile, undefined);
  assert.deepEqual(config().custom, { retain: true });
  assert.deepEqual(lib.readDefaults(), { enabled: true, profile: 'frugal' });
  process.chdir(other);
  assert.equal(lib.findProjectConfig().enabled, true);
  assert.equal(lib.findProjectConfig().profile, 'frugal');
  assert.equal(lib.readProjects()[lib.projectKey(other)], undefined);
  // A project override wins over the global value.
  assert.match(command(['off', '--project']).stdout, /| this project/);
  assert.equal(lib.findProjectConfig().enabled, false);
  process.chdir(project);
  assert.equal(lib.findProjectConfig().enabled, true);
  assert.equal(command(['set', 'training', 'on']).status, 0);
  assert.equal(lib.readDefaults().allowTrainingProviders, true);
  process.chdir(other);
  assert.equal(lib.findProjectConfig().allowTrainingProviders, true);
  assert.equal(lib.findProjectConfig().enabled, false);
  // Codex rules live in each project's AGENTS.md, so host codex stays per project and never becomes global.
  assert.match(command(['on', '--host', 'codex']).stdout, /| this project/);
  assert.equal(lib.readDefaults().host, undefined);
  fs.writeFileSync(lib.defaultsFile(), JSON.stringify({ host: 'codex', enabled: 'yes', other: 1 }));
  assert.deepEqual(lib.readDefaults(), { enabled: 'yes' });
  process.chdir(project);
  assert.equal(lib.findProjectConfig().host, 'claude-code');
  assert.equal(lib.findProjectConfig().enabled, false);
  assert.equal(command(['set', 'statusline', 'boss', '--project']).status, 1);
});

test('a global switch reaches projects saved as full snapshots before 0.5, and another project training veto stays', () => {
  const old = path.join(temporary, 'old'), vetoed = path.join(temporary, 'vetoed');
  fs.mkdirSync(old); fs.mkdirSync(vetoed);
  lib.saveProject(old, { enabled: true, profile: 'quality', allowTrainingProviders: true, rules: 'tiny', host: 'claude-code' });
  lib.saveProject(vetoed, { enabled: true, profile: 'quality', allowTrainingProviders: false, rules: 'tiny', host: 'claude-code' });
  enable({ allowTrainingProviders: false });
  assert.equal(command(['off']).status, 0);
  assert.equal(command(['set', 'training', 'on']).status, 0);
  // Run here, so this project follows; the other project's own "off" is kept.
  assert.equal(lib.findProjectConfig().allowTrainingProviders, true);
  process.chdir(vetoed);
  assert.equal(lib.findProjectConfig().allowTrainingProviders, false);
  assert.equal(lib.findProjectConfig().enabled, false);
  process.chdir(old);
  assert.equal(lib.findProjectConfig().enabled, false);
  assert.equal(lib.findProjectConfig().profile, 'quality');
  assert.equal(lib.findProjectConfig().allowTrainingProviders, true);
  // A project write ends the snapshot: only the field set here stays, the rest follows global switches.
  assert.equal(command(['set', 'context', 'off', '--project']).status, 0);
  assert.deepEqual(Object.keys(lib.readProjects()[lib.projectKey(old)]).filter(key => lib.DEFAULT_FIELDS.includes(key) || key === 'rules'), ['contextSuggest']);
  assert.equal(command(['on']).status, 0);
  assert.equal(lib.findProjectConfig().enabled, true);
  assert.equal(command(['set', 'training', 'off']).status, 0);
  assert.equal(lib.findProjectConfig().allowTrainingProviders, false);
});

test('mutations preserve unknown config keys and write locally under an enabled ancestor', () => {
  enable({ custom: { retain: true } });
  command(['set', 'profile', 'frugal', '--project']);
  assert.deepEqual(config().custom, { retain: true });
  const nested = path.join(project, 'child');
  fs.mkdirSync(nested);
  process.chdir(nested);
  assert.match(command(['status']).stdout, /Quota Boss on/);
  command(['off', '--project']);
  assert.equal(lib.readProjects()[lib.projectKey(nested)].enabled, false);
  assert.equal(config().enabled, true);
});

test('status and route report quota and respect disabled providers without writing project config', () => {
  enable();
  assert.equal(command(['use', 'perplexity', 'off']).status, 0);
  lib.writeState({ claude: limits(60, 0).claude });
  codexLog(80, 0);
  const status = command(['status']);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /Quota Boss on/);
  assert.match(status.stdout, /Quota Boss on \| profile balanced \| host claude-code/);
  assert.match(status.stdout, /mode claude-save\+codex-tight/);
  assert.equal(command(['use', 'codex', 'off']).status, 0);
  const table = command(['route']);
  assert.match(table.stdout, /critical: architecture=/);
  assert.doesNotMatch(table.stdout, /GPT|Perplexity/);
});

test('bad CLI input has a message, exit one, and causes no writes', () => {
  for (const args of [[], ['unknown'], ['on', 'bad'], ['on', 'quality', 'extra'], ['off', 'extra'],
    ['profile'], ['profile', 'bad'], ['workers', 'alien=on'], ['workers', 'codex=yes'],
    ['set', 'profile', 'frugal', 'extra'], ['set', 'codex-tasks', 'on'], ['route', 'extra'], ['status', 'extra'], ['models']]) {
    const result = command(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^quota-boss: /);
    assert.equal(config(), undefined);
  }
});

test('feedback accepts failure kind flags in either order and rejects invalid flags', () => {
  const command = flags => invoke(cli.main, '', ['feedback', 'gpt-6-sol', 'review', 'normal', 'fail', ...flags]);
  for (const kind of lib.FAILURE_KINDS) for (const flags of [['--kind', kind, '--effort', 'high'], ['--effort', 'high', '--kind', kind]]) {
    assert.equal(command(flags).status, 0);
    assert.equal(lib.readOutcomes().at(-1).kind, kind);
    assert.equal(lib.readOutcomes().at(-1).effort, 'high');
  }
  for (const flags of [['--kind'], ['--kind', 'unknown'], ['--kind', 'quota', '--kind', 'outage'], ['--kind', '--effort'], ['--other', 'quota']]) {
    const before = fs.readFileSync(lib.getPaths().outcomesFile, 'utf8');
    assert.equal(command(flags).status, 1);
    assert.equal(fs.readFileSync(lib.getPaths().outcomesFile, 'utf8'), before);
  }
});

test('feedback records optional effort and rejects malformed effort flags', () => {
  const command = args => invoke(require('../scripts/quota-boss').main, '', args);
  const args = ['feedback', 'gpt-6-sol', 'review', 'normal', 'pass'];
  const result = command([...args, '--effort', 'high']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /pass at high/);
  assert.equal(lib.readOutcomes().at(-1).effort, 'high');
  const before = fs.readFileSync(lib.getPaths().outcomesFile, 'utf8');
  for (const flags of [['--effort'], ['--unknown', 'high'], ['--effort', 'invalid'],
    ['--effort', 'high', '--effort', 'low'], ['--effort', '--unknown']]) {
    const invalid = command([...args, ...flags]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, flags.includes('invalid') ? /effort.*invalid/i : /Usage:/);
  }
  assert.equal(fs.readFileSync(lib.getPaths().outcomesFile, 'utf8'), before);
});

test('feedback validates arity, enums and exact registry/cache membership before appending', () => {
  lib.writeJson(path.join(process.env.CODEX_HOME, 'models_cache.json'), { models: [
    { slug: 'new-cached', visibility: 'list' }, { slug: 'hidden-cached', visibility: 'hide' }
  ] });
  const valid = ['feedback', 'gpt-6-sol', 'review', 'normal', 'pass'];
  for (const args of [valid.slice(0, -1), [...valid, 'extra'], ['feedback', 'missing', 'review', 'normal', 'pass'],
    ['feedback', 'constructor', 'review', 'normal', 'pass'], ['feedback', 'gpt-6-sol', 'invalid', 'normal', 'pass'],
    ['feedback', 'gpt-6-sol', 'review', 'NORMAL', 'pass'], ['feedback', 'gpt-6-sol', 'review', 'normal', 'PASS'],
    ['feedback', 'gpt-6-sol\ninject', 'review', 'normal', 'pass']]) {
    assert.equal(command(args).status, 1, args.join(' '));
    assert.equal(fs.existsSync(lib.getPaths().outcomesFile), false);
  }
  for (const [model, result] of [['gpt-6-sol', 'pass'], ['new-cached', 'fail'], ['hidden-cached', 'unavailable']]) {
    assert.equal(command(['feedback', model, 'review', 'normal', result]).status, 0);
  }
  assert.deepEqual(lib.readOutcomes().map(o => [o.model, o.result]),
    [['gpt-6-sol', 'pass'], ['new-cached', 'fail'], ['hidden-cached', 'unavailable']]);
  assert.equal(config(), undefined);
});

test('route filtering and explain show every candidate with metrics and a decision reason', () => {
  enable();
  assert.equal(command(['feedback', 'gpt-6-sol', 'review', 'normal', 'unavailable']).status, 0);
  const report = command(['route', '--explain', 'review', 'normal']);
  assert.equal(report.status, 0);
  const lines = report.stdout.trim().split('\n');
  assert.equal(lines.length, Object.values(lib.loadConfig().models.models).filter(m => lib.loadConfig().providers.providers[m.pool]?.enabled !== false).length);
  assert.ok(lines.every(line => /^normal review .* P=\d\.\d+ price=(\d+\.\d+|Infinity) utility=\d+\.\d+ \| .+/.test(line)));
  assert.equal(lines.filter(line => /\| won:/.test(line)).length, 1);
  assert.match(report.stdout, /GPT-6-Sol .*unavailable \(24h exclusion\)/);
  const table = command(['route', 'review', 'normal']);
  assert.match(table.stdout, /^normal: review=/);
  assert.equal(table.stdout.trim().split('\n').length, 1);
  assert.doesNotMatch(table.stdout, /GPT-6-Sol\(/);
  for (const args of [['route', '--explain', 'invalid'], ['route', 'review', 'invalid'],
    ['route', '--explain', '--explain'], ['route', 'review', 'normal', 'extra']]) assert.equal(command(args).status, 1);
});

test('feedback accepts a unique table label and refuses an unknown one', () => {
  const command = args => invoke(require('../scripts/quota-boss').main, '', args);
  const ok = command(['feedback', 'GPT-6-Sol', 'implementation', 'normal', 'pass']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Feedback recorded: gpt-6-sol implementation normal pass/);
  assert.equal(lib.readOutcomes().at(-1).model, 'gpt-6-sol');
  assert.equal(command(['feedback', 'GPT-9-Nope', 'implementation', 'normal', 'pass']).status, 1);
});

});
