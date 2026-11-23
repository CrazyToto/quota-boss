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
  assert.match(output, /Unknown models \(priced at 1\): unlisted/);
  assert.match(output, /No boss sessions found, so there is nothing to compare/);
  assert.match(output, /haiku +1 +0.000 +60s/);
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
  const output = savings.savings({ ...f.options, details: true });
  assert.match(output, /boss: 3.0% \/ 6.0%\n/);
  assert.match(output, /workers: 0.0% \/ 0.0%; 1 runs not counted \(1 crossed a window reset\)/);
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
  const report = savings.formatReport(result, { ...f.options, details: true });
  assert.match(report, /api: 2 \| 100 \| 0.25/);
  assert.match(report, /gpt \/ normal: 2 \| 20s/);
  assert.doesNotMatch(savings.formatReport(result, f.options), /api: 2/);
  assert.deepEqual(fs.readFileSync(f.paths.usageFile), before);
});

test('details show pass rates per model and category from feedback, replacing the removed stats command', t => {
  const f = fixture(t);
  const outcome = { t: now - 1000, model: 'gpt', category: 'review', tier: 'normal', result: 'pass' };
  f.write(path.join(f.paths.quotaBossHome, 'outcomes.jsonl'), [outcome, outcome, { ...outcome, result: 'fail' }, { ...outcome, result: 'unavailable' },
    { ...outcome, model: 'opus', category: 'architecture', result: 'fail' }, { ...outcome, bench: 'run-1' },
    { ...outcome, t: now - 91 * 86400000 }, { ...outcome, category: 'invented' }, '{bad']);
  const result = savings.collect({ ...f.options, days: 365 });
  assert.equal(result.outcomes.length, 5);
  const report = savings.formatReport(result, { ...f.options, details: true });
  assert.match(report, /Results \(all projects\): model \/ category \| pass rate \| pass \| fail/);
  assert.match(report, /gpt \/ review: 67% \| 2 \| 1/);
  assert.match(report, /opus \/ architecture: 0% \| 0 \| 1/);
  assert.doesNotMatch(savings.formatReport(result, f.options), /Results \(all projects\)/);
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
  assert.equal(savings.savings(f.options), 'Quota Boss savings - last 30 days, project Project\nNo sessions found in this window.\nUnits are relative model prices from local transcripts, not a bill.');
  f.claude([assistant('SECRET-SESSION-ID', 'opus', 1000000)]);
  f.codex(rollout(f.root, 'exec'));
  const output = savings.savings(f.options);
  assert.equal(output, savings.savings(f.options));
  assert.match(output, /^Quota Boss savings - since 2026-11-10 \(1 day\), project Project\n/);
  assert.match(output, /About 0% less Claude usage than doing everything with opus\n/);
  assert.match(output, /Claude used {2}10\.0 units\n  opus alone {3}10\.0 units \(estimate, same tokens assumed\)\n  Codex used {3}0\.002 units\n  all pools {4}10\.0 units, 0% cheaper in total/);
  assert.match(output, /More: savings --details$/);
  const detailed = savings.savings({ ...f.options, details: true });
  assert.match(detailed, /claude: .*1.0M\/10/);
  assert.ok(detailed.indexOf('claude:') < detailed.indexOf('codex:'));
  assert.doesNotMatch(detailed, /More: savings --details/);
  for (const sensitive of ['SECRET-SESSION-ID', 'SECRET-ACCOUNT-ID', 'SECRET MESSAGE TEXT', f.paths.claudeDir, f.paths.codexDir, 'rollout-one']) assert.ok(!output.includes(sensitive));
  assert.ok(output.split('\n').length <= 40);
});

test('argument parser accepts either flag order and rejects every unsupported form with USAGE', () => {
  assert.deepEqual(savings.parseArgs([], 'USAGE'), { days: 30, all: false, details: false });
  assert.deepEqual(savings.parseArgs(['--details', '--days', '3'], 'USAGE'), { days: 3, all: false, details: true });
  for (const args of [['--all', '--days', '7'], ['--days', '7', '--all']]) assert.deepEqual(savings.parseArgs(args, 'USAGE'), { days: 7, all: true, details: false });
  for (const args of [['--days'], ['--days', '0'], ['--days', '-1'], ['--days', '1.5'], ['--days', '366'], ['--days', 'NaN'], ['--days', '01'], ['--wat'], ['extra'], ['--all', '--all'], ['--details', '--details'], ['--details=1'], ['--days', '7', '--days', '8']]) {
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
    assert.match(output, /^Quota Boss savings - last 7 days, all projects/);
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
  assert.match(savings.savings({ ...f.options, details: true }), /claude: .* \| 1\n/);
  for (let i = 0; i < 15; i++) {
    f.claude([assistant('worker', 'model-' + i)], 'session/subagents/agent-' + i + '.jsonl');
  }
  f.write(f.paths.usageFile, Array.from({ length: 15 }, (_, i) => ({ t: now, provider: 'provider-' + i, unit: 'calls', amount: 1 })));
  f.write(path.join(f.paths.quotaBossHome, 'runs.jsonl'), Array.from({ length: 15 }, (_, i) => ({ t: now, model: 'model-' + i, tier: 'normal', ok: true, seconds: 10 })));
  const report = savings.savings(f.options);
  assert.ok(report.split('\n').length <= 40);
  assert.match(report, /\.\.\. 10 more \(savings --details\)/);
  assert.doesNotMatch(report, /provider-/);
  const detailed = savings.savings({ ...f.options, details: true });
  assert.ok(detailed.split('\n').length <= 60);
  assert.match(detailed, /\.\.\. \d+ more\n/);
  assert.match(detailed, /unknown \/ model-/);
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
  assert.match(savings.savings({ ...f.options, details: true }), /workers: 0.0% \/ 6.0%; 1 runs not counted/);
  assert.match(savings.savings(f.options), /Codex subscription used by workers: 6% of one week/);
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

test('codex-auto-review is priced as GPT-6.1-Sol and not listed as unknown', () => {
  const models = { models: { 'gpt-6.1-sol': { cost: 5 } } };
  assert.equal(savings.price('codex-auto-review', { models }), 5);
  assert.equal(savings.price('codex-auto-review', { models: { models: {} } }), 1);
  assert.equal(savings.price('codex-auto-review', { models: { models: { 'codex-auto-review': { cost: 2 }, 'gpt-6.1-sol': { cost: 5 } } } }), 2);
  assert.equal(savings.price('other-unlisted', { models }), 1);
});

test('headline leads with the boss pool, shows work per limit and the all-pools total', t => {
  const f = fixture(t);
  f.claude([assistant('boss', 'opus', 1000000)]);
  // A large Codex worker job that Opus would have done at five times the price.
  f.codex(rollout(f.root, 'exec').map(e => e.type === 'event_msg'
    ? token(Date.parse(e.timestamp) / 1000 - now / 1000, 10, 42, { input_tokens: 5000000, cached_input_tokens: 0, output_tokens: 0 }) : e));
  const output = savings.savings(f.options);
  // Claude: 10 actual vs 10 + 5M * 10 / 1M = 60 estimate -> 83% less Claude, 6.0x per Claude limit.
  assert.match(output, /About 83% less Claude usage than doing everything with opus\n  = about 6\.0x the work per Claude limit\n/);
  assert.match(output, /Codex used {3}10\.0 units\n  all pools {4}20\.0 units, 67% cheaper in total/);
});

test('a Codex boss leads with Codex usage', t => {
  const f = fixture(t);
  f.codex(rollout(f.root, 'cli').map(e => e.type === 'event_msg'
    ? token(Date.parse(e.timestamp) / 1000 - now / 1000, 10, 42, { input_tokens: 1000000, cached_input_tokens: 0, output_tokens: 0 }) : e));
  f.claude([assistant('w', 'haiku', 1000000)], 'session/subagents/agent-1.jsonl');
  const output = savings.savings(f.options);
  assert.match(output, /% less Codex usage than doing everything with gpt\n/);
  assert.match(output, /Codex used .*\n  gpt alone .*\n  Claude used /);
});

test('the header keeps "last N days" when data covers the whole window', t => {
  const f = fixture(t);
  f.claude([assistant('old', 'opus', 100, -29.5 * 86400), assistant('new', 'opus')]);
  assert.match(savings.savings(f.options), /^Quota Boss savings - last 30 days, project Project\n/);
  // With a 7-day window the old entry falls out, so the real start shows again.
  assert.match(savings.savings({ ...f.options, days: 7 }), /^Quota Boss savings - since 2026-11-10 \(1 day\)/);
});

test('details list large work the boss kept without a worker, so a delegation regression shows up', t => {
  const f = fixture(t);
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const writes = [1, 2, 3, 4, 5].map(n => use('w' + n, 'Write', { file_path: '/p/f' + n + '.js', content: 'a\nb' }));
  // Claude Code writes one line per content block with the same message id; a repeated tool_use id counts once.
  f.claude([assistant('m1', 'opus', 100, -300, { content: writes.slice(0, 3) }), assistant('m1', 'opus', 100, -300, { content: writes }),
    assistant('m2', 'opus', 100, -200, { content: [use('b1', 'Bash', { command: 'node "C:/q/scripts/quota-boss.js" route --size large' })] })], 'kept.jsonl');
  f.claude([assistant('m3', 'opus', 100, -300, { content: [use('e1', 'Edit', { file_path: '/p/a.js', old_string: 'x', new_string: 'y\n'.repeat(250) })] })], 'big-edit.jsonl');
  f.claude([assistant('m4', 'opus', 100, -300, { content: [...writes, use('a1', 'Agent', { subagent_type: 'codex-worker', prompt: 'p' })] })], 'handed.jsonl');
  f.claude([assistant('m5', 'opus', 100, -300, { content: writes.slice(0, 4) })], 'small.jsonl');
  // Small edits across many files are not new or rewritten files.
  const edits = [1, 2, 3, 4, 5].map(n => use('s' + n, 'Edit', { file_path: '/p/f' + n + '.js', old_string: 'a', new_string: 'b' }));
  f.claude([assistant('m6', 'opus', 100, -300, { content: edits })], 'small-edits.jsonl');
  const report = savings.formatReport(savings.collect(f.options), { ...f.options, details: true });
  const section = report.slice(report.indexOf('Large work the boss kept'));
  assert.match(section, /^Large work the boss kept \(5\+ files or 200\+ lines, no worker\): start \| files \| lines \| why/);
  assert.match(section, /\| 5 \| 10 \| route checked, kept/);
  assert.match(section, /\| 0 \| 251 \| no route call/);
  assert.equal(section.split('\nResults')[0].split('\n').length, 3);
  assert.doesNotMatch(savings.formatReport(savings.collect(f.options), f.options), /Large work/);
});

test('details show cache hit, output and reasoning share and the first-call size per worker', t => {
  const f = fixture(t);
  f.codex(rollout(f.root, 'exec'));
  const report = savings.savings({ ...f.options, details: true });
  // Codex: 1000 input of which 800 cached, 100 output of which 60 reasoning; first call 1000 in.
  assert.match(report, /codex: .* \| 1\.0k\/100 \| 80\.0% \| 9\.1% \(60\.0%\) \| 1\n/);
  assert.match(report, /: 1 \| .* \| 1\.0k \| 80\.0%\n/);
  const job = savings.collect(f.options).jobs[0];
  assert.equal(job.first, 1000);
  assert.equal(job.reasoning, 60);
  // Claude: the earliest message in the window sets the first call; a missing usage field counts as 0.
  const early = assistant('a', 'opus', 100, -50), late = assistant('b', 'opus', 900, -40);
  delete early.message.usage.cache_creation_input_tokens;
  assert.equal(savings.claudeJob([late, early], 'boss', f.options)[0].first, 130);
  assert.equal(savings.claudeJob([], 'boss', f.options).length, 0);
});
