'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const savings = require('../scripts/savings');
const cli = require('../scripts/quota-boss');
const now = Date.parse('2026-11-10T12:00:00Z');
const iso = seconds => new Date(now + seconds * 1000).toISOString();
const config = { models: { models: { opus: { cost: 10 }, gpt: { cost: 2 }, haiku: { cost: 1 } } }, thresholds: {} };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-savings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { claudeDir: path.join(dir, 'claude'), codexDir: path.join(dir, 'codex'), quotaBossHome: path.join(dir, 'quota') };
  paths.usageFile = path.join(paths.quotaBossHome, 'usage.jsonl');
  const root = path.join(dir, 'Project');
  const options = { paths, root, config, now, days: 30, all: false, platform: process.platform };
  function write(file, entries) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Array.isArray(entries) ? entries.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n' : JSON.stringify(entries));
    return file;
  }
  function claude(entries, suffix = 'main.jsonl', project = root) {
    return write(path.join(paths.claudeDir, 'projects', savings.encodedProject(project), suffix), entries);
  }
  function codex(entries, name = 'one') {
    return write(path.join(paths.codexDir, 'sessions', '2026', '11', '10', 'rollout-' + name + '.jsonl'), entries);
  }
  return { dir, paths, root, options, write, claude, codex };
}
function assistant(id, model = 'opus', tokens = 100, seconds = -60, extra = {}) {
  return { type: 'assistant', timestamp: iso(seconds), message: { id, model,
    usage: { input_tokens: tokens, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 10 },
    content: 'SECRET MESSAGE TEXT', ...extra } };
}
function token(seconds, used, reset = 42, usage = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, reasoning_output_tokens: 60 }) {
  return { type: 'event_msg', timestamp: iso(seconds), payload: { type: 'token_count',
    info: { total_token_usage: usage }, rate_limits: { primary: { used_percent: used, resets_at: reset }, secondary: { used_percent: used * 2, resets_at: reset } } } };
}
function rollout(root, source = 'cli', reset = 42) {
  return [
    { type: 'session_meta', timestamp: iso(-120), payload: { cwd: root, originator: source === 'exec' ? 'codex_exec' : 'codex_cli_rs', source, model: 'fallback', id: 'SECRET-SESSION-ID', account_id: 'SECRET-ACCOUNT-ID' } },
    { type: 'turn_context', timestamp: iso(-110), payload: { model: 'old' } },
    token(-100, 10), { type: 'turn_context', timestamp: iso(-90), payload: { model: 'gpt' } }, token(-10, 13, reset)
  ];
}

test('Claude deduplicates by id using last usage, skips synthetic/malformed and filters timestamps', t => {
  const f = fixture(t);
  f.claude([assistant('same', 'opus', 500), '{bad json', null, assistant('same', 'opus', 200),
    assistant('fake', '<synthetic>'), assistant('old', 'opus', 500, -31 * 86400), assistant('future', 'opus', 500, 20),
    { type: 'user', message: { model: 'opus', usage: { input_tokens: 9000 } } }, assistant('no-model', undefined, 900, -30, { model: null })]);
  const { jobs } = savings.collect(f.options);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].tokens.input, 200);
  assert.equal(jobs[0].weighted, 278);
  assert.equal(jobs[0].units, 0.00278);
  assert.equal(jobs[0].role, 'boss');
  assert.equal(savings.collect({ ...f.options, days: 1 }).jobs.length, 1);
});

test('last duplicate timestamp decides inclusion and exact cutoff is included', t => {
  const f = fixture(t);
  f.claude([assistant('a'), assistant('a', 'opus', 100, -31 * 86400), assistant('b', 'opus', 100, -30 * 86400)]);
  assert.equal(savings.collect(f.options).jobs[0].tokens.input, 100);
  assert.equal(savings.collect({ ...f.options, days: 29 }).jobs.length, 0);
});

test('subagent metadata, missing metadata, sanitized role, duration and models', t => {
  const f = fixture(t);
  f.claude([assistant('a', 'haiku', 100, -90), assistant('b', 'haiku', 100, -30)], 'session/subagents/agent-one.jsonl');
  f.claude({ agentType: 'haiku-worker\n<>' }, 'session/subagents/agent-one.meta.json');
  f.claude([assistant('c', 'unlisted')], 'session/subagents/agent-two.jsonl');
  const jobs = savings.collect(f.options).jobs;
  assert.deepEqual(jobs.map(j => j.role).sort(), ['worker:haiku-worker', 'worker:unknown']);
  assert.equal(jobs.find(j => j.model === 'haiku').seconds, 60);
  assert.equal(jobs.find(j => j.model === 'unlisted').units, 178 / 1e6);
  const output = savings.savings(f.options);
  assert.match(output, /Unknown models \(cost 1\): unlisted/);
  assert.match(output, /no boss sessions found/);
});

test('current project, Windows case-insensitive matching, --all and descendant cwd', t => {
  const f = fixture(t);
  f.claude([assistant('a')], 'main.jsonl', f.root.toUpperCase());
  f.claude([assistant('b')], 'main.jsonl', path.join(f.dir, 'Elsewhere'));
  f.codex(rollout(path.join(f.root.toUpperCase(), 'child')));
  f.codex(rollout(f.root + '-other'), 'other');
  assert.equal(savings.collect({ ...f.options, platform: 'win32' }).jobs.length, 2);
  assert.equal(savings.collect({ ...f.options, all: true }).jobs.length, 4);
  assert.equal(savings.sameProject('C--Work-Project', 'c:\\work\\project', 'win32'), true);
  assert.equal(savings.sameProject('C--Work-Project', 'c:\\work\\project', 'linux'), false);
});

test('Codex interactive versus exec, latest model, final cumulative usage and no cache/reasoning double count', t => {
  const f = fixture(t);
  f.codex(rollout(f.root));
  f.codex(rollout(f.root, 'exec'), 'worker');
  const jobs = savings.collect(f.options).jobs;
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(j => j.role).sort(), ['boss', 'worker:codex-exec']);
  for (const job of jobs) {
    assert.equal(job.model, 'gpt');
    assert.deepEqual(job.tokens, { input: 200, cached: 800, output: 100 });
    assert.equal(job.weighted, 1080);
    assert.equal(job.units, 0.00216);
    assert.equal(job.seconds, 110);
    assert.deepEqual(job.windows.primary, { delta: 3, reset: false, resetsAt: 42, from: 10, to: 13 });
  }
});

test('Codex metadata model fallback, missing fields and date cutoff', t => {
  const f = fixture(t);
  const entries = rollout(f.root).filter(e => e.type !== 'turn_context');
  f.codex(entries);
  assert.equal(savings.collect(f.options).jobs[0].model, 'fallback');
  delete entries[0].payload.model;
  f.codex(entries);
  assert.equal(savings.collect(f.options).jobs[0].model, 'unknown');
  entries[entries.length - 1].timestamp = iso(-31 * 86400);
  f.codex(entries);
  assert.equal(savings.collect(f.options).jobs.length, 0);
  f.codex(['malformed', { type: 'session_meta', payload: {} }, token(-1, 1)]);
  assert.equal(savings.collect(f.options).jobs.length, 0);
});

test('window resets, missing counters and decreases are omitted or clamped correctly', t => {
  const f = fixture(t);
  f.codex(rollout(f.root, 'exec', 99));
  f.codex(rollout(f.root), 'boss');
  const output = savings.savings(f.options);
  assert.match(output, /boss: 3.0% \/ 6.0%; 0 runs left out/);
  assert.match(output, /workers: 0.0% \/ 0.0%; 1 runs left out of one or both sums \(1 window reset\)/);
  assert.deepEqual(savings.windowDelta({ used_percent: 20, resets_at: 1 }, { used_percent: 10, resets_at: 1 }), { delta: 0, reset: false, resetsAt: 1, from: 20, to: 10 });
  assert.deepEqual(savings.windowDelta({}, {}), { delta: null, reset: false });
});

test('configured weights override defaults and model costs resolve exactly', () => {
  assert.equal(savings.weighted('codex', { input: 10, cached: 100, output: 20 }, { savings: { codex: { output: 2 } } }), 60);
  assert.equal(savings.weighted('claude', { input: 10 }, { savings: { claude: { input: -1 } } }), 10);
  assert.equal(savings.price('opus', config), 10);
  assert.equal(savings.price('opus[1m]', config), 1);
});

test('global counters and successful runs, median, cutoff, malformed and future entries', t => {
  const f = fixture(t);
  f.write(f.paths.usageFile, [{ t: now, provider: 'api', unit: 'calls', amount: 2 },
    { t: now, provider: 'api', unit: 'tokens', amount: 100 }, { t: now, provider: 'api', unit: 'usd', amount: 0.25 },
    { t: now, provider: 'claude', unit: 'calls', amount: 99 }, { t: now - 86400000 * 31, provider: 'api', unit: 'calls', amount: 50 },
    { t: now + 1, provider: 'api', unit: 'calls', amount: 50 }, '{broken']);
  const run = { t: now, model: 'gpt', category: 'review', tier: 'normal', ok: true, seconds: 10 };
  f.write(path.join(f.paths.quotaBossHome, 'runs.jsonl'), [run, { ...run, seconds: 30 }, { ...run, seconds: 999, ok: false },
    { ...run, seconds: -1 }, { ...run, t: now + 1 }, { ...run, t: now - 31 * 86400000 }, '{bad']);
  const before = fs.readFileSync(f.paths.usageFile);
  const result = savings.collect(f.options);
  assert.equal(result.usage.length, 3);
  assert.equal(result.runs.length, 2);
  assert.match(savings.formatReport(result, f.options), /api: 2 \| 100 \| 0.25/);
  assert.match(savings.formatReport(result, f.options), /gpt \/ normal: 2 \| 20/);
  assert.deepEqual(fs.readFileSync(f.paths.usageFile), before);
});

test('oversized files, non-regular entries and missing directories are silently skipped', t => {
  const f = fixture(t);
  const file = f.claude([assistant('a')]);
  fs.truncateSync(file, savings.MAX_BYTES + 1);
  f.claude([assistant('valid')], 'valid.jsonl');
  fs.mkdirSync(path.join(path.dirname(file), 'directory.jsonl'));
  assert.equal(savings.collect(f.options).jobs.length, 1);
  assert.equal(savings.collect({ ...f.options, all: true }).jobs.length, 1);
});

test('symlink files and directories are skipped when the platform allows creation', t => {
  const f = fixture(t);
  const target = f.write(path.join(f.dir, 'target.jsonl'), [assistant('a')]);
  const project = path.join(f.paths.claudeDir, 'projects', savings.encodedProject(f.root));
  fs.mkdirSync(project, { recursive: true });
  try { fs.symlinkSync(target, path.join(project, 'link.jsonl')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink creation unavailable'); throw error; }
  assert.equal(savings.collect(f.options).jobs.length, 0);
});

test('empty report, stable ordering, compact totals, boss estimate and no sensitive output', t => {
  const f = fixture(t);
  assert.equal(savings.savings(f.options), 'Savings: last 30 days, project Project\nNo sessions found in this window.\nNumbers come from local transcripts; cost units are relative prices, not a bill.');
  f.claude([assistant('SECRET-SESSION-ID', 'opus', 1000000)]);
  f.codex(rollout(f.root, 'exec'));
  const output = savings.savings(f.options);
  assert.equal(output, savings.savings(f.options));
  assert.match(output, /claude: .*1.0M\/10/);
  assert.match(output, /rough estimate, same token count assumed/);
  assert.match(output, /total 10.012 units, 0\.1% more than actual/);
  assert.ok(output.indexOf('claude:') < output.indexOf('codex:'));
  for (const sensitive of ['SECRET-SESSION-ID', 'SECRET-ACCOUNT-ID', 'SECRET MESSAGE TEXT', f.paths.claudeDir, f.paths.codexDir, 'rollout-one']) assert.ok(!output.includes(sensitive));
  assert.ok(output.split('\n').length <= 40);
});

test('argument parser accepts either flag order and rejects every unsupported form with USAGE', () => {
  assert.deepEqual(savings.parseArgs([], 'USAGE'), { days: 30, all: false });
  for (const args of [['--all', '--days', '7'], ['--days', '7', '--all']]) assert.deepEqual(savings.parseArgs(args, 'USAGE'), { days: 7, all: true });
  for (const args of [['--days'], ['--days', '0'], ['--days', '-1'], ['--days', '1.5'], ['--days', '366'], ['--days', 'NaN'], ['--days', '01'], ['--wat'], ['extra'], ['--all', '--all'], ['--days', '7', '--days', '8']]) {
    assert.throws(() => savings.parseArgs(args, 'USAGE'), /^Error: USAGE$/);
    assert.throws(() => cli.run(['savings', ...args]), /Usage: quota-boss/);
  }
});

test('CLI uses isolated home paths, both flag orders and no writes', t => {
  const f = fixture(t), original = {};
  const vars = { HOME: f.dir, USERPROFILE: f.dir, CLAUDE_CONFIG_DIR: f.paths.claudeDir, CODEX_HOME: f.paths.codexDir, QUOTA_BOSS_HOME: f.paths.quotaBossHome };
  for (const [key, value] of Object.entries(vars)) { original[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const args of [['savings', '--days', '7', '--all'], ['savings', '--all', '--days', '7']]) {
    const output = cli.run(args);
    assert.match(output, /^Savings: last 7 days, all projects/);
    assert.match(output, /No sessions found in this window/);
  }
  assert.equal(fs.existsSync(f.paths.quotaBossHome), false);
});

test('shared scan budget never reads more than 2000 files', t => {
  const f = fixture(t), io = savings.reader();
  const file = f.write(path.join(f.dir, 'small'), { safe: true });
  for (let i = 0; i < savings.MAX_FILES; i++) assert.ok(io.read(file));
  assert.equal(io.read(file), '');
});

test('multi-model Claude file counts once per pool and report stays bounded with many groups', t => {
  const f = fixture(t);
  f.claude([assistant('a', 'opus'), assistant('b', 'haiku')]);
  assert.match(savings.savings(f.options), /claude: .* \| 1\n/);
  for (let i = 0; i < 15; i++) {
    f.claude([assistant('worker', 'model-' + i)], 'session/subagents/agent-' + i + '.jsonl');
  }
  f.write(f.paths.usageFile, Array.from({ length: 15 }, (_, i) => ({ t: now, provider: 'provider-' + i, unit: 'calls', amount: 1 })));
  f.write(path.join(f.paths.quotaBossHome, 'runs.jsonl'), Array.from({ length: 15 }, (_, i) => ({ t: now, model: 'model-' + i, tier: 'normal', ok: true, seconds: 10 })));
  const report = savings.savings(f.options);
  assert.ok(report.split('\n').length <= 40);
  assert.match(report, /more groups omitted/);
  assert.match(report, /worker:unknown \/ model-/);
});

test('usage journal above compaction threshold remains unchanged and oversized Codex logs are skipped', t => {
  const f = fixture(t);
  const entry = { t: now, provider: 'api', unit: 'calls', amount: 1 };
  f.write(f.paths.usageFile, Array(5000).fill(entry));
  const before = fs.readFileSync(f.paths.usageFile);
  assert.ok(before.length > 256 * 1024);
  const file = f.codex(rollout(f.root));
  fs.truncateSync(file, savings.MAX_BYTES + 1);
  const result = savings.collect(f.options);
  assert.equal(result.jobs.length, 0);
  assert.equal(result.usage.length, 5000);
  assert.deepEqual(fs.readFileSync(f.paths.usageFile), before);
});

test('Codex object source classifies as worker, and each window is omitted independently', t => {
  const f = fixture(t), entries = rollout(f.root);
  entries[0].payload.source = { subagent: 'redacted' };
  entries[entries.length - 1].payload.rate_limits.primary.resets_at = 55;
  f.codex(entries);
  const job = savings.collect(f.options).jobs[0];
  assert.equal(job.role, 'worker:codex-exec');
  assert.deepEqual(job.windows.primary, { delta: null, reset: true });
  assert.equal(job.windows.secondary.delta, 6);
  assert.equal(job.windows.secondary.reset, false);
  assert.match(savings.savings(f.options), /workers: 0.0% \/ 6.0%; 1 runs left out/);
});

test('overlapping Codex runs in one window count once, separate runs and windows add up', () => {
  const run = (start, end, from, to, resetsAt = 7) => ({ start, end, windows: { primary: { delta: to - from, reset: false, resetsAt, from, to } } });
  // A nested auto-review inside a worker run and a parallel sibling share the same percent rise.
  assert.equal(savings.windowUse([run(0, 100, 10, 20), run(10, 50, 12, 18), run(90, 120, 19, 22)], 'primary'), 12);
  // Runs apart in time add their own rises; another window adds separately.
  assert.equal(savings.windowUse([run(0, 10, 1, 3), run(20, 30, 5, 6), run(0, 10, 50, 54, 8)], 'primary'), 7);
  // Unusable or reset windows are skipped.
  assert.equal(savings.windowUse([{ start: 0, end: 1, windows: { primary: { delta: null, reset: true } } }], 'primary'), 0);
});

test('stale transcripts and old Codex day folders are skipped before reading', () => {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-savings-old-'));
  try {
    const now = Date.UTC(2026, 10, 10, 12);
    const claudeDir = path.join(root, 'claude'), codexDir = path.join(root, 'codex'), home = path.join(root, 'qb');
    const project = path.join(root, 'proj');
    const dir = path.join(claudeDir, 'projects', savings.encodedProject(project));
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(home, { recursive: true });
    const line = { type: 'assistant', timestamp: new Date(now - 3600000).toISOString(),
      message: { id: 'm1', model: 'opus', usage: { input_tokens: 1000, output_tokens: 10 } } };
    const old = path.join(dir, 'old.jsonl');
    fs.writeFileSync(old, JSON.stringify(line) + '\n');
    fs.utimesSync(old, new Date(now - 40 * 86400000), new Date(now - 40 * 86400000));
    const day = path.join(codexDir, 'sessions', '2026', '09', '01');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: project, originator: 'codex_exec' } }) + '\n'
      + JSON.stringify({ type: 'event_msg', timestamp: new Date(now - 3600000).toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5, output_tokens: 1 } } } }) + '\n');
    const data = savings.collect({ paths: { claudeDir, codexDir, quotaBossHome: home }, root: project, all: false,
      platform: process.platform, now, days: 30, config: { models: { models: {} }, thresholds: {} } });
    assert.equal(data.jobs.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
