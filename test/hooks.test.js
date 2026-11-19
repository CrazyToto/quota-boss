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
const agent = require('../scripts/hook-agent');
const hosts = require('../scripts/hosts');

test('default tiny startup quotes paths with spaces and uses full rules while saving', () => {
  process.env.QUOTA_BOSS_HOME = path.join(temporary, 'boss with spaces');
  enable();
  assert.equal(Object.hasOwn(lib.readProjects()[lib.projectKey(project)], 'rules'), false);
  lib.writeState({ claude: limits(4).claude });
  const normal = invoke(session.main, input());
  assert.equal(normal.stdout, hosts.boot() + '\n');
  assert.ok(normal.stdout.includes('node "' + lib.trustedHomeText() + '/scripts/quota-boss.js" rules --host claude-code'));
  assert.equal(normal.status, 0);
  lib.writeState({ claude: limits(80).claude });
  const saving = start(input());
  assert.ok(saving.stdout.startsWith(hosts.RULES_LOADED + '\n' + hosts.rules('claude-code', { ...lib.findProjectConfig(), rules: 'full' }) + '\n'));
  assert.match(saving.stdout, /critical: architecture=/);
  assert.match(saving.stdout, /Claude 5h 80%/);
  assert.equal(saving.status, 0);
});

test('tiny startup has only the eight boot lines, graph, warning and existing notes', t => {
  enable({ rules: 'tiny', terse: true });
  const graph = require('../scripts/graph'), context = require('../scripts/context');
  const load = lib.loadConfig;
  t.mock.method(graph, 'sessionText', () => 'graph context');
  t.mock.method(lib, 'loadConfig', (...args) => ({ ...load(...args), warning: 'config warning' }));
  t.mock.method(context, 'sessionStartText', () => 'previous-session notes');
  t.mock.method(require('../scripts/session-routing'), 'build', () => { throw new Error('Tiny startup must not build routing'); });
  t.mock.method(context, 'deferTable', () => { throw new Error('Tiny startup must not defer routing'); });
  const boot = fs.readFileSync(path.join(__dirname, '../templates/BOOT.md'), 'utf8').trim();
  assert.equal(boot.split('\n').length, 8);
  assert.ok(boot.includes('"{{QUOTA_BOSS_HOME}}/scripts/quota-boss.js" rules --host claude-code'));
  const result = invoke(session.main, input());
  assert.equal(result.stdout, [lib.substituteHome(boot), 'graph context', 'config warning', 'previous-session notes'].join('\n') + '\n');
  assert.doesNotMatch(result.stdout, /critical: architecture=|Claude 5h|Boss rules loaded|Keep answers terse/);
  assert.equal(result.status, 0);
});

test('tiny startup falls back to the marked full start while the Claude pool is saving', t => {
  enable({ rules: 'tiny' });
  const context = require('../scripts/context');
  t.mock.method(context, 'sessionStartText', () => 'previous-session notes');
  lib.writeState({ claude: limits(80).claude });
  const result = invoke(session.main, input());
  assert.ok(result.stdout.startsWith(hosts.RULES_LOADED + '\n' + hosts.rules('claude-code', { ...lib.findProjectConfig(), rules: 'full' }) + '\n'));
  assert.equal(result.stdout.split(hosts.RULES_LOADED).length, 2, 'marker once, table not repeated by the rules');
  assert.match(result.stdout, /critical: architecture=/);
  assert.match(result.stdout, /Claude 5h 80%/);
  assert.match(result.stdout, /previous-session notes/);
  assert.doesNotMatch(result.stdout, /Do a job yourself when it changes about 30 lines/);
  assert.equal(result.stdout.split('critical: architecture=').length, 2);
  // The marker in the start text lets the first worker call through.
  lib.writeState({ claude: limits(4).claude });
  assert.ok(invoke(session.main, input()).stdout.startsWith(hosts.boot()));
});

test('the saving full startup matches fresh routing with large-job hints byte for byte, ignoring old stored switches', t => {
  const context = require('../scripts/context'), graph = require('../scripts/graph');
  const { routeTable, formatTable } = require('../scripts/route');
  const now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(graph, 'sessionText', () => 'graph context');
  t.mock.method(context, 'sessionStartText', () => 'previous-session notes');
  t.mock.method(context, 'deferTable', (_p, _cwd, late) => late);
  lib.writeState({ claude: limits(80).claude });
  for (const normalized of [false, true]) for (const large of [false, true]) {
    const project = { enabled: true, rules: 'full', terse: true, consensus: false };
    enable(normalized ? lib.normalizeProject(project) : project);
    const original = lib.formatLimits;
    if (large) lib.formatLimits = () => 'limits '.repeat(2000);
    try {
      const p = lib.findProjectConfig(), config = lib.loadConfig(p, { tolerant: true });
      const codex = lib.readCodexLimits(now, config.thresholds), state = lib.readState();
      const limits = lib.readProviderLimits(config.providers, { claude: state.claude, codex }, now);
      const bossModel = lib.currentBossModel(p, state);
      let table = formatTable(routeTable({ ...config, ...p, bossModel, bossEffort: lib.currentBossEffort(p, state, bossModel), size: config.thresholds.gate?.defaultSize ?? 'medium', limits, history: state.history, selfTests: state.selfTests, outcomes: lib.readOutcomes(now, config.thresholds), runs: require('../scripts/latency').readRuns(now), now }), { ladder: false });
      const fixed = [hosts.RULES_LOADED + '\n' + hosts.rules('claude-code', { ...p, rules: 'full' }), graph.sessionText(p.directory), [lib.formatLimits(limits, p.profile, config.thresholds, now, config.providers), config.warning].filter(Boolean).join('\n')];
      if (Buffer.byteLength([...fixed, table].filter(Boolean).join('\n')) + 1 > context.HOOK_BUDGET) table = '[quota-boss] The routing table arrives with the user\'s first message.';
      assert.equal(invoke(session.main, input()).stdout, [fixed[0], fixed[1], 'previous-session notes', table, fixed[2]].filter(Boolean).join('\n') + '\n');
    } finally { lib.formatLimits = original; }
  }
});

test('tiny rules command starts with marker then full rules, fresh session routing and limits', t => {
  t.mock.method(Date, 'now', () => 1800000000000);
  enable({ rules: 'tiny', terse: true });
  const p = lib.findProjectConfig(), config = lib.loadConfig(p, { tolerant: true });
  const routing = require('../scripts/session-routing').build(p, config);
  const full = hosts.rules('claude-code', { ...p, rules: 'full' });
  const result = require('../scripts/quota-boss').run(['rules', '--host', 'claude-code']);
  assert.equal(result, [hosts.RULES_LOADED, full, routing.table, routing.limits].join('\n'));
  assert.match(result, /critical: architecture=/);
  assert.match(result, /Claude 5h/);
  assert.equal(require('../scripts/quota-boss').run(['rules', '--host', 'codex']), hosts.rules('codex', { ...p, rules: 'full' }));
  assert.equal(require('../scripts/quota-boss').run(['rules', '--host', 'generic']), hosts.rules('generic', { ...p, rules: 'full' }));
  enable({ rules: 'full' });
  assert.equal(require('../scripts/quota-boss').run(['rules', '--host', 'claude-code']), hosts.rules('claude-code', lib.findProjectConfig()));
});

function agentInput(file, type = 'sonnet-worker') {
  return JSON.stringify({ cwd: project, transcript_path: file, tool_input: { subagent_type: type } });
}
function transcript(lines) {
  const file = path.join(temporary, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return file;
}
function denied(file) {
  const result = invoke(agent.main, agentInput(file));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const expected = hosts.rules('claude-code', lib.findProjectConfig()) + '\nSend this job again in the handover form from these rules.';
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expected } });
}
test('worker gate denies absent or pre-compaction markers, and allows markers after either boundary', t => {
  t.mock.method(Date, 'now', () => 1800000000000);
  enable({ rules: 'tiny' });
  const mark = { type: 'user', message: { content: hosts.RULES_LOADED } };
  denied(transcript([]));
  denied(transcript([{ type: 'assistant', message: {} }]));
  assert.equal(invoke(agent.main, agentInput(transcript([mark]))).stdout, '');
  const raw = transcript([]);
  fs.writeFileSync(raw, hosts.RULES_LOADED + '\n');
  assert.equal(invoke(agent.main, agentInput(raw)).stdout, '');
  for (const boundary of [{ subtype: 'compact_boundary' }, { isCompactSummary: true }]) {
    denied(transcript([mark, boundary]));
    denied(transcript([{ ...boundary, content: hosts.RULES_LOADED }]));
    assert.equal(invoke(agent.main, agentInput(transcript([mark, boundary, mark]))).stdout, '');
  }
});

test('read guard turns a whole read of a large saved output into a targeted one', () => {
  const file = transcript([]);
  const results = path.join(temporary, 'transcript', 'tool-results');
  fs.mkdirSync(results, { recursive: true });
  const big = path.join(results, 'big.txt'), small = path.join(results, 'small.txt'), other = path.join(temporary, 'big.txt');
  // 1000 lines of 50 bytes: 50 000 bytes, above the 40 KB limit.
  for (const name of [big, other]) fs.writeFileSync(name, ('x'.repeat(49) + String.fromCharCode(10)).repeat(1000));
  fs.writeFileSync(small, 'x'.repeat(agent.SAVED_OUTPUT_BYTES - 1));
  const read = (target, extra = {}, transcriptPath = file) => invoke(agent.main, JSON.stringify({ cwd: project, transcript_path: transcriptPath, tool_name: 'Read', tool_input: { file_path: target, ...extra } })).stdout;
  for (const config of [{ rules: 'tiny' }, { rules: 'full' }]) {
    enable(config);
    const output = JSON.parse(read(big)).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /covers 49 KB of a saved command output.*Grep it.*offset and limit/);
  }
  // A range that still covers most of the file is no way around the guard; a real part passes.
  for (const extra of [{ offset: 1 }, { offset: 0 }, { limit: 999999 }, { offset: 1, limit: 2000 }, { allow_large: true }]) assert.match(read(big, extra), /"deny"/, JSON.stringify(extra));
  for (const extra of [{ offset: 1, limit: 200 }, { offset: 900 }, { offset: 200, limit: 500 }]) assert.equal(read(big, extra), '', JSON.stringify(extra));
  if (process.platform === 'win32') assert.match(read(big.toUpperCase()), /"deny"/, 'Windows paths match without case');
  assert.equal(read(small), '');
  assert.equal(read(other), '');
  assert.equal(read(path.join(results, 'missing.txt')), '');
  assert.equal(read(big, {}, path.join(temporary, 'other.jsonl')), '');
  assert.equal(read(big, {}, null), '');
  for (const config of [{ enabled: false }, { host: 'codex' }, { host: 'generic' }]) {
    enable(config);
    assert.equal(read(big), '', JSON.stringify(config));
  }
});

test('worker gate ignores other agents, disabled boss and other hosts, and gates an old stored full rules field', () => {
  const file = transcript([]);
  enable({ rules: 'tiny' });
  for (const type of ['general-purpose', 'custom-agent', '../sonnet-worker', undefined]) {
    assert.equal(invoke(agent.main, JSON.stringify({ cwd: project, transcript_path: file, tool_input: { subagent_type: type } })).stdout, '');
  }
  for (const config of [{ enabled: false, rules: 'tiny' }, { host: 'codex', rules: 'tiny' }, { host: 'generic', rules: 'tiny' }]) {
    enable(config);
    assert.equal(invoke(agent.main, agentInput(file)).stdout, '');
  }
  enable({ rules: 'full', terse: true });
  assert.match(invoke(agent.main, agentInput(file)).stdout, /"deny"/);
});

test('worker gate recognizes every worker shipped by this install and fails open at its time budget', t => {
  enable({ rules: 'tiny' });
  const file = transcript([{ content: 'no rules loaded' }]);
  t.mock.method(hosts, 'rules', () => hosts.RULES_LOADED + '\nrules');
  for (const name of fs.readdirSync(path.join(__dirname, '../agents')).filter(name => name.endsWith('.md'))) {
    assert.equal(JSON.parse(invoke(agent.main, agentInput(file, name.slice(0, -3))).stdout).hookSpecificOutput.permissionDecision, 'deny', name);
  }
  let now = 0;
  t.mock.method(Date, 'now', () => now += 4000);
  assert.equal(invoke(agent.main, agentInput(file)).stdout, '');
});

test('worker gate fails open on malformed input, unreadable transcript and read or rules errors', t => {
  enable({ rules: 'tiny' });
  for (const data of ['{bad', 'null', 'x'.repeat(1024 * 1024 + 1), agentInput(), agentInput(path.join(temporary, 'missing')), agentInput(temporary)]) {
    assert.equal(invoke(agent.main, data).stdout, '');
  }
  const file = transcript([]);
  t.mock.method(hosts, 'rules', () => { throw new Error('rules unavailable'); });
  assert.equal(invoke(agent.main, agentInput(file)).stdout, '');
  t.mock.method(lib, 'readInput', () => { throw new Error('stdin unavailable'); });
  assert.equal(invoke(agent.main, agentInput(file)).stdout, '');
});

test('worker gate reads only the last 8 MB of huge transcripts and discards a partial first line', t => {
  enable({ rules: 'tiny' });
  const file = transcript([{ content: hosts.RULES_LOADED }]);
  fs.appendFileSync(file, 'x'.repeat(agent.TAIL_BYTES + 100) + '\n');
  const original = fs.readSync, stat = fs.statSync(file), reads = [];
  const fd = lib.openRegular;
  let transcriptFd;
  t.mock.method(lib, 'openRegular', name => { const value = fd(name); if (name === file) transcriptFd = value; return value; });
  t.mock.method(fs, 'readSync', (handle, bytes, start, length, offset) => {
    if (handle === transcriptFd && offset !== null) reads.push({ length, offset });
    return original(handle, bytes, start, length, offset);
  });
  const result = invoke(agent.main, agentInput(file));
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(reads, [{ length: agent.TAIL_BYTES, offset: stat.size - agent.TAIL_BYTES }]);
  fs.appendFileSync(file, JSON.stringify({ content: hosts.RULES_LOADED }) + '\n');
  assert.equal(invoke(agent.main, agentInput(file)).stdout, '');
});

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
  lib.writeState({ claude: limits(80).claude });
  const result = start(input());
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const hosts = require('../scripts/hosts');
  assert.ok(result.stdout.startsWith(hosts.RULES_LOADED + '\n' + hosts.rules('claude-code', { ...lib.findProjectConfig(project), rules: 'full' })));
  assert.doesNotMatch(result.stdout, /Codex host:/);
  assert.match(result.stdout, /critical: architecture=/);
  assert.match(result.stdout, /\[quota-boss\] Claude 5h 80% wk 49% \| Codex 5h 0% wk 2% \| profile balanced \| mode claude-save/);
});

test('a broken providers.json keeps the table on built-in providers and warns in hooks and route', () => {
  enable();
  codexLog();
  lib.writeState({ claude: limits(80).claude });
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

test('session ignores old stored consensus and terse fields: consensus stays, no terse line', () => {
  const hosts = require('../scripts/hosts');
  lib.writeState({ claude: limits(80).claude });
  for (const consensus of [undefined, true, false]) {
    for (const terse of [false, true]) {
      enable({ rules: 'full', consensus, terse });
      const result = start(input());
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.ok(result.stdout.startsWith(hosts.RULES_LOADED + '\n' + hosts.rules('claude-code', { ...lib.findProjectConfig(project), rules: 'full' })));
      assert.ok(result.stdout.includes('use `consensus` before deciding'));
      assert.doesNotMatch(result.stdout, /Keep answers terse/);
      assert.match(result.stdout, /critical: architecture=/);
    }
  }
});

test('session read errors do not crash and tell an active boss the table is missing', () => {
  enable();
  lib.writeState({ claude: limits(80).claude });
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
  lib.writeState({ claude: limits(80).claude });
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
    assert.ok(result.stdout.startsWith(require('../scripts/hosts').RULES_LOADED + '\n'));
    assert.match(result.stdout, /^critical:/m);
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

test('saving session and changed-mode prompt show large hints and retain the previous pool', t => {
  const now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(lib, 'currentBossModel', () => 'claude-opus-5-5');
  t.mock.method(lib, 'currentBossEffort', () => null);
  enable();
  codexLog();
  lib.writeState({ claude: limits(75).claude, sessions: { 'session-1': { mode: 'normal', pool: 'codex', updated_at: now - 1000 } } });
  const p = lib.findProjectConfig(), config = lib.loadConfig(p, { tolerant: true });
  const { state, limits: quota } = require('../scripts/session-routing').readLimits(config, now);
  const { routeTable, formatTable } = require('../scripts/route');
  const expected = formatTable(routeTable({ ...config, ...p, bossModel: 'claude-opus-5-5', bossEffort: null,
    size: 'medium', limits: quota, history: state.history, selfTests: state.selfTests,
    outcomes: lib.readOutcomes(now, config.thresholds), runs: require('../scripts/latency').readRuns(now), now, previousPool: 'codex' }), { ladder: false });
  assert.match(require('../scripts/session-routing').build(p, config).table, /implementation=Opus 5\.5\(self\)\[large:GPT-6\.2-Sol\(codex-worker,low,model=gpt-6\.2-sol\)\]/);
  const changed = invoke(prompt.main, input());
  assert.ok(changed.stdout.includes('. New routing:\n' + expected + '\n'));
  assert.match(changed.stdout, /\[large:/);
  assert.doesNotMatch(changed.stdout.split('\n').filter(line => /^(critical|normal|trivial):/.test(line)).join('\n'), />/);
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
  lib.writeState({ claude: limits(80).claude });
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
  // A background task result must pass: nobody may be there to send it again.
  assert.doesNotMatch(send({ prompt: '<task-notification>' + String.fromCharCode(10) + '<task-id>b1</task-id>' }).stdout, /"block"/);
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

test('suggestions come last at the session start and are dropped first when the budget is nearly full', t => {
  const context = require('../scripts/context'), suggest = require('../scripts/suggest');
  enable();
  const tip = { id: 'profile-frugal', text: 'Claude week is 85% used', command: 'set profile frugal' };
  t.mock.method(suggest, 'suggestions', () => [tip]);
  let room = 0, slack = 0;
  t.mock.method(context, 'sessionStartText', (project, source, cwd, now, budget) => { room = budget; return 'n'.repeat(Math.max(0, budget - slack)); });
  const full = invoke(session.main, input());
  assert.ok(Buffer.byteLength(full.stdout) <= context.HOOK_BUDGET, 'session start has ' + Buffer.byteLength(full.stdout) + ' bytes');
  assert.ok(room > 0);
  assert.doesNotMatch(full.stdout, /Suggestion: Claude week/);
  slack = 200;
  const fits = invoke(session.main, input());
  assert.ok(Buffer.byteLength(fits.stdout) <= context.HOOK_BUDGET);
  assert.match(fits.stdout, /n\n\[quota-boss\] Suggestion: Claude week is 85% used\. Propose to the user: quota-boss set profile frugal\n$/);
});

test('a shown suggestion returns only after a day or after its condition went away and came back', t => {
  const suggest = require('../scripts/suggest');
  enable();
  const tip = { id: 'provider-off:grok', text: 'the grok CLI is not installed', command: 'use grok off' };
  let list = [tip], now = Date.UTC(2026, 10, 17, 12);
  t.mock.method(suggest, 'suggestions', () => list);
  t.mock.method(Date, 'now', () => now);
  const shows = () => /Suggestion: the grok CLI/.test(invoke(session.main, input()).stdout);
  assert.equal(shows(), true);
  assert.equal(shows(), false, 'not again in the same day');
  now += 23 * 3600000;
  assert.equal(shows(), false);
  now += 3600000;
  assert.equal(shows(), true, 'again after 24 hours');
  list = [];
  assert.equal(shows(), false);
  list = [tip];
  assert.equal(shows(), true, 'again when the condition comes back');
});

test('new providers show on every Claude session start until a switch answers', () => {
  const { markKnown } = require('../scripts/new-providers');
  const cli = require('../scripts/quota-boss');
  enable({ rules: 'tiny' });
  markKnown(Object.keys(lib.BUILTIN_PROVIDERS.providers).filter(id => id !== 'junie-lite'));
  const show = source => invoke(session.main, JSON.stringify({ cwd: project, session_id: 'new-provider', source })).stdout;
  for (const source of ['startup', 'clear', 'compact', 'resume']) {
    assert.match(show(source), /Suggestion: Ask the user: "Turn on Junie Lite\? Free, no limit published\."/);
  }
  cli.run(['use', 'junie-lite', 'off']);
  assert.doesNotMatch(show('resume'), /Turn on Junie Lite/);
});

test('the handoff pointers stay within the room they are given', () => {
  const context = require('../scripts/context');
  enable();
  const config = lib.findProjectConfig(project);
  context.save('Goal: huge\n' + 'x'.repeat(5000), config, project);
  assert.equal(context.sessionStartText(config, 'startup', project, Date.now(), 20), '');
  assert.match(context.sessionStartText(config, 'startup', project, Date.now(), 1000), /A recent handoff exists/);
  assert.equal(context.sessionStartText(config, 'clear', project, Date.now(), 20), '');
  assert.deepEqual(Object.values(lib.readState().pendingHandoffs).length, 1, 'the notes still arrive with the first prompt');
});

});
