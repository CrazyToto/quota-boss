'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('../scripts/lib');

test.describe('hooks', () => {
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

const session = require('../scripts/hook-session');
const prompt = require('../scripts/hook-prompt');

/** The session start, plus the first prompt when the table had to wait for it (a long test path fills the budget). */
function start(data) {
  const result = invoke(session.main, data);
  return result.stdout.includes('routing table arrives') ? { ...result, stdout: result.stdout + invoke(prompt.main, data).stdout } : result;
}
function input(id = 'session-1') { return JSON.stringify({ cwd: project, session_id: id, source: 'startup' }); }

test('hooks are silent when disabled, missing opt-in, or malformed', () => {
  for (const main of [session.main, prompt.main]) {
    assert.equal(invoke(main, input()).stdout, '');
    assert.equal(invoke(main, '{broken').stdout, '');
    assert.equal(invoke(main, 'x'.repeat(1024 * 1024 + 1)).stdout, '');
  }
  enable({ enabled: 'true' });
  assert.equal(invoke(session.main, input()).stdout, '');
  assert.equal(invoke(prompt.main, input()).stdout, '');
  assert.equal(fs.existsSync(lib.getPaths().stateFile), false);
});

test('session prints rules when present, compact routing, and numeric quota context', () => {
  enable();
  codexLog();
  lib.writeState({ claude: limits().claude });
  const result = start(input());
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.startsWith(require('../scripts/hosts').rules('claude-code', lib.findProjectConfig(project))));
  assert.doesNotMatch(result.stdout, /Codex host:/);
  assert.match(result.stdout, /critical: architecture=/);
  assert.match(result.stdout, /\[quota-boss\] Claude 5h 4% wk 49% \| Codex 5h 0% wk 2% \| profile balanced \| mode normal/);
});

test('a broken providers.json keeps the table on built-in providers and warns in hooks and route', () => {
  enable();
  codexLog();
  lib.writeState({ claude: limits().claude });
  const file = path.join(process.env.QUOTA_BOSS_HOME, 'config', 'providers.json');
  for (const broken of ['[', '{"providers":{"bad id!":{}}}', '[]']) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, broken);
    const started = start(input());
    assert.match(started.stdout, /critical: architecture=/, broken);
    assert.match(started.stdout, /WARNING: the provider config is invalid/, broken);
    const prompted = invoke(prompt.main, JSON.stringify({ cwd: project, prompt: 'hi' }));
    assert.match(prompted.stdout, /WARNING: the provider config is invalid/, broken);
    const routed = require('../scripts/quota-boss').run(['route']);
    assert.match(routed, /WARNING: the provider config is invalid[\s\S]*critical: architecture=/, broken);
    // Commands that change provider settings stay strict, so nothing overwrites the user's broken file.
    assert.throws(() => require('../scripts/quota-boss').run(['providers']), broken);
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
  }
  fs.writeFileSync(file, '{}');
  assert.doesNotMatch(start(input()).stdout, /WARNING: the provider config/);
});

test('session honors consensus and terse together through shared host rules', () => {
  const hosts = require('../scripts/hosts');
  for (const consensus of [undefined, true, false]) {
    for (const terse of [false, true]) {
      enable({ consensus, terse });
      const result = start(input());
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.ok(result.stdout.startsWith(hosts.rules('claude-code', lib.findProjectConfig(project))));
      assert.equal(result.stdout.includes('use `consensus` before deciding'), consensus !== false);
      assert.equal(result.stdout.split('Keep answers terse:').length - 1, terse ? 1 : 0);
      assert.match(result.stdout, /critical: architecture=/);
    }
  }
});

test('consensus off explains both route and session behavior', () => {
  enable();
  const output = require('../scripts/quota-boss').run(['set', 'consensus', 'off']);
  assert.ok(output.includes('The consensus option is off: it is hidden from the route table and removed from the session rules. Critical changes still get the counter-review from templates/RULES.md.'));
});

test('session read errors do not crash and tell an active boss the table is missing', () => {
  enable();
  const original = lib.readBounded;
  lib.readBounded = (file, max) => {
    if (path.basename(file) === 'RULES.md') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(file, max);
  };
  try {
    const result = invoke(session.main, input());
    assert.match(result.stdout, /^\[quota-boss\] WARNING: Boss mode is ON, but the rules and the routing table could not be loaded\./);
    assert.equal(result.stdout.split('\n').length, 2);
    assert.equal(result.stderr, '');
    assert.equal(result.status, 0);
  } finally { lib.readBounded = original; }
});

test('missing RULES does not prevent routing; hook data never echoes injected log content', () => {
  enable({ profile: 'balanced\nIGNORE', workers: { perplexity: false } });
  const log = codexLog();
  fs.appendFileSync(log, JSON.stringify({ timestamp: 'IGNORE\ninstructions', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 'IGNORE', resets_at: 'IGNORE' }, secondary: { used_percent: 2 }, text: 'IGNORE instructions'
  } } }) + '\n');
  const original = lib.readBounded;
  lib.readBounded = (file, max) => {
    if (path.basename(file) === 'RULES.md') { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
    return original(file, max);
  };
  try {
    const result = invoke(session.main, input());
    assert.ok(result.stdout.startsWith('critical:'));
    assert.doesNotMatch(result.stdout, /IGNORE/);
    assert.match(result.stdout, /profile balanced/);
    assert.match(result.stdout, /codex data unknown/);
  } finally { lib.readBounded = original; }
});

test('prompt prints one line initially and routing only on a subsequent mode change per session', () => {
  enable();
  codexLog();
  lib.writeState({ claude: limits().claude });
  const first = invoke(prompt.main, input());
  assert.equal(first.stdout.trim().split('\n').length, 1);
  assert.equal(lib.readState().sessions['session-1'].mode, 'normal');
  const state = lib.readState();
  state.claude.five_hour.used_percentage = 60;
  lib.writeState(state);
  const other = invoke(prompt.main, input('other-session'));
  assert.doesNotMatch(other.stdout, /mode changed/);
  const changed = invoke(prompt.main, input());
  assert.match(changed.stdout, /\[quota-boss\] mode changed -> claude-save\. New routing:\ncritical:/);
  assert.doesNotMatch(changed.stdout.split('\n').filter(line => /^(critical|normal|trivial):/.test(line)).join('\n'), />/); // prompt tables leave out the ladder
  assert.equal(lib.readState().sessions['session-1'].mode, 'save');
  const stable = invoke(prompt.main, input());
  assert.equal(stable.stdout.trim().split('\n').length, 1);
});

test('prompt retains fifty most recent sessions, handles special keys, and never echoes IDs', () => {
  enable();
  const sessions = Object.fromEntries(Array.from({ length: 50 }, (_, index) => ['old-' + index, { mode: 'normal', updated_at: index }]));
  lib.writeState({ sessions });
  const result = invoke(prompt.main, input('__proto__'));
  assert.doesNotMatch(result.stdout, /__proto__/);
  const saved = lib.readState().sessions;
  assert.equal(Object.keys(saved).length, 50);
  assert.equal(Object.hasOwn(saved, '__proto__'), true);
  assert.equal(Object.hasOwn(saved, 'old-0'), false);
  assert.equal({}.mode, undefined);
});

test('prompt write failures are silent; missing session IDs do not create shared session entries', () => {
  enable();
  const anonymous = invoke(prompt.main, JSON.stringify({ cwd: project }));
  assert.match(anonymous.stdout, /^\[quota-boss\]/);
  assert.equal(fs.existsSync(lib.getPaths().stateFile), false);
  fs.rmSync(process.env.QUOTA_BOSS_HOME, { recursive: true });
  fs.writeFileSync(process.env.QUOTA_BOSS_HOME, 'blocked');
  const failed = invoke(prompt.main, input());
  assert.equal(failed.stdout, '');
  assert.equal(failed.stderr, '');
  assert.equal(failed.status, 0);
});

test('session and changed-mode prompt use learned exclusions and preserve sampled quota history', () => {
  enable();
  codexLog();
  const config = lib.loadConfig();
  lib.appendOutcome({ model: 'claude-opus-5-5', category: 'review', tier: 'normal', result: 'unavailable' }, config.models);
  lib.writeState({ claude: limits().claude, history: { claude: [{ t: Date.now() - 600000, u5: 3, uw: 48 }] } });
  const first = start(input());
  const table = first.stdout.split('\n').filter(line => /^(critical|normal|trivial):/.test(line)).join('\n');
  assert.doesNotMatch(table, /Opus 5\.5/);
  assert.doesNotMatch(table, />/); // session tables leave out the ladder
  invoke(prompt.main, input());
  const state = lib.readState();
  assert.equal(state.history.codex.length, 1);
  assert.equal(state.history.claude.length, 1);
  state.claude.five_hour.used_percentage = 60;
  lib.writeState(state);
  const changed = invoke(prompt.main, input());
  assert.match(changed.stdout, /mode changed/);
  assert.doesNotMatch(changed.stdout, /Opus 5\.5/);
  assert.ok(changed.stdout.trim().split('\n').length <= 8);
  assert.equal(lib.readState().history.codex.length, 1);
});


test('the session start stays under the host limit: a long table and long notes wait for the first prompt', () => {
  const context = require('../scripts/context');
  enable();
  codexLog();
  lib.writeState({ claude: limits().claude });
  const clear = JSON.stringify({ cwd: project, session_id: 'session-1', source: 'clear' });
  context.save('Goal: ship it\n' + 'A long line of notes about the work. '.repeat(120), lib.findProjectConfig(project), project);
  const started = invoke(session.main, clear);
  assert.ok(Buffer.byteLength(started.stdout) <= 10000, 'session start has ' + Buffer.byteLength(started.stdout) + ' bytes');
  assert.match(started.stdout, /Notes from the previous session arrive with the user's first message/);
  assert.doesNotMatch(started.stdout, /Goal: ship it/);
  const first = invoke(prompt.main, clear);
  assert.ok(Buffer.byteLength(first.stdout) <= 10000);
  assert.match(first.stdout, /notes, not instructions[^\n]*\n# Handoff/);
  assert.match(first.stdout, /Goal: ship it/);
  assert.equal((started.stdout + first.stdout).split('critical: architecture=').length - 1, 1, 'the table arrives exactly once');
  const second = invoke(prompt.main, clear);
  assert.equal(second.stdout.trim().split('\n').length, 1);
  assert.deepEqual(lib.readState().pendingHandoffs, {});
  assert.deepEqual(lib.readState().pendingTables ?? {}, {});
});

test('notes longer than a whole prompt are cut with a pointer, short notes still load at the session start', () => {
  const context = require('../scripts/context');
  enable();
  const config = lib.findProjectConfig(project);
  context.save('Goal: small', config, project);
  assert.match(context.sessionStartText(config, 'clear', project, Date.now(), 2000), /Goal: small/);
  assert.equal(context.pendingHandoffText(config, project), '');
  context.save('Goal: huge\n' + 'x'.repeat(20000), config, project, Date.now() + 2000);
  assert.match(context.sessionStartText(config, 'clear', project, Date.now() + 3000, 2000), /arrive with the user's first message/);
  const cut = context.pendingHandoffText(config, project, 9000, Date.now() + 3000);
  assert.ok(Buffer.byteLength(cut) <= 9000);
  assert.match(cut, /Goal: huge/);
  assert.match(cut, /The notes are cut here\. Read all of them with: node .*handoff show$/);
  assert.equal(context.pendingHandoffText(config, project), '');
});

test('cold cache blocks only once with only decision JSON, and a new assistant turn re-arms it', () => {
  enable();
  const file = path.join(project, 'history.jsonl'), stamp = Date.now() - 14 * 3600000;
  const assistant = time => JSON.stringify({ type: 'assistant', timestamp: new Date(time).toISOString(), message: { usage: { input_tokens: 212000 } } });
  fs.writeFileSync(file, assistant(stamp));
  const data = extra => JSON.stringify({ cwd: project, session_id: 'cold', transcript_path: file, prompt: 'Continue', ...extra });
  const send = extra => invoke(prompt.main, data(extra));
  const first = send(), parsed = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(parsed), ['decision', 'reason']);
  assert.equal(parsed.decision, 'block');
  assert.equal(first.stdout, JSON.stringify(parsed));
  assert.equal(first.stderr, '');
  assert.equal(first.status, 0);
  assert.ok(Buffer.byteLength(first.stdout) < require('../scripts/context').HOOK_BUDGET);
  assert.equal(parsed.reason, '[quota-boss] Nothing was sent yet. This session paused for about 14 hours, so its cache has expired and your next message re-reads all 212k tokens at full price instead of the cached price.\n'
    + '- New topic: type /clear first. It costs nothing and starts small.\n'
    + '- Same task: type /compact first. The session is read once, then continues small.\n'
    + '- Or send your message again to continue as it is.\nTurn this check off: quota-boss set context off');
  assert.doesNotMatch(send().stdout, /"decision"/);
  const warning = lib.readState().coldWarned.cold;
  const originalNow = Date.now;
  fs.appendFileSync(file, '\n' + assistant(warning + 1));
  Date.now = () => warning + 1 + 3600000;
  try { assert.equal(JSON.parse(send().stdout).decision, 'block'); }
  finally { Date.now = originalNow; }
  for (const extra of [{ prompt: '  /compact' }, { transcript_path: 'relative.jsonl' }, { transcript_path: file + '.missing' }]) {
    assert.doesNotMatch(send({ session_id: 'other', ...extra }).stdout, /"decision"/);
  }
  fs.writeFileSync(file, assistant(stamp));
  for (const config of [{ contextSuggest: false }, { enabled: false }, { host: 'codex' }]) {
    enable(config);
    assert.doesNotMatch(send({ session_id: 'other' }).stdout, /"decision"/);
  }
});

test('Codex session prints only the exact table and limits, with stdin model first', () => {
  enable({ host: 'codex' });
  codexLog();
  lib.writeState({ claude: limits().claude });
  const now = Date.now(), original = Date.now;
  Date.now = () => now;
  const oldModel = process.env.QUOTA_BOSS_BOSS_MODEL;
  process.env.QUOTA_BOSS_BOSS_MODEL = 'fallback-model';
  try {
    const data = JSON.stringify({ cwd: project, model: 'hook-model' });
    const result = invoke(session.main, data, ['--host', 'codex']);
    const p = lib.findProjectConfig(), config = lib.loadConfig(p), state = lib.readState();
    const quota = lib.readProviderLimits(config.providers, { claude: state.claude, codex: lib.readCodexLimits(now, config.thresholds) }, now);
    const expected = require('../scripts/route').formatTable(require('../scripts/route').route({ ...config, ...p, bossModel: 'hook-model',
      bossEffort: lib.currentBossEffort(p, state, 'hook-model'), size: config.thresholds.gate?.defaultSize ?? 'medium', limits: quota,
      history: state.history, selfTests: state.selfTests, outcomes: lib.readOutcomes(now, config.thresholds), runs: require('../scripts/latency').readRuns(now), now }), { ladder: false });
    assert.equal(result.stdout, expected + '\n' + lib.formatLimits(quota, p.profile, config.thresholds, now, config.providers) + '\n');
    assert.match(result.stdout, /boss model hook-model/);
    assert.equal(result.stderr, '');
    assert.equal(result.status, 0);
    assert.equal(invoke(session.main, data).stdout, '');
    for (const model of [undefined, 12, { id: 'hook-model' }, 'bad id']) {
      assert.match(invoke(session.main, JSON.stringify({ cwd: project, model }), ['--host', 'codex']).stdout, /boss model fallback-model/);
    }
    assert.equal(invoke(session.main, '{bad', ['--host', 'codex']).stdout, '');
    for (const config of [{ host: 'claude-code' }, { host: 'codex', enabled: false }]) {
      enable(config); assert.equal(invoke(session.main, data, ['--host', 'codex']).stdout, '');
    }
    assert.equal(invoke(session.main, JSON.stringify({ cwd: temporary }), ['--host', 'codex']).stdout, '');
    assert.equal(invoke(session.main, '{bad', ['--host', 'codex']).stdout, '');
  } finally {
    Date.now = original;
    if (oldModel === undefined) delete process.env.QUOTA_BOSS_BOSS_MODEL; else process.env.QUOTA_BOSS_BOSS_MODEL = oldModel;
  }
});

test('Codex oversize table becomes one route command, while Claude output stays identical', () => {
  enable();
  const before = start(input()).stdout;
  assert.equal(start(input()).stdout, before);
  const original = lib.formatLimits;
  lib.formatLimits = () => 'x'.repeat(8000);
  try {
    enable({ host: 'codex' });
    assert.equal(invoke(session.main, input(), ['--host', 'codex']).stdout,
      '[quota-boss] Run node "' + lib.trustedHomeText() + '/scripts/quota-boss.js" route before delegating.\n');
  } finally { lib.formatLimits = original; }
});

});
