'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const context = require('../scripts/context');

const script = name => path.join(__dirname, '..', 'scripts', name);

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const env = { ...process.env, QUOTA_BOSS_HOME: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
  fs.mkdirSync(env.QUOTA_BOSS_HOME);
  const run = (file, args = [], input = '') => spawnSync(process.execPath, [script(file), ...args], { cwd: project, env, input, encoding: 'utf8' });
  return { project, env, run, cli: (...args) => run('quota-boss.js', args), hook: (file, data) => run(file, [], JSON.stringify({ cwd: project, session_id: 'one', ...data })) };
}

const window = (percent, size = 1000000) => ({ context_window: { used_percentage: percent, context_window_size: size }, transcript_path: path.resolve('/history/one.jsonl') });

test('the threshold is absolute on big windows and a share on small ones', () => {
  const big = { tokens: 150000, percent: 15, size: 1000000 };
  assert.match(context.suggestion(big, 150000).text, /Context is large: 150k tokens \(15%/);
  assert.equal(context.suggestion({ tokens: 149000, percent: 14, size: 1000000 }, 150000).text, '');
  assert.match(context.suggestion({ tokens: 120000, percent: 60, size: 200000 }, 150000).text, /120k/);
  assert.equal(context.suggestion({ tokens: 110000, percent: 55, size: 200000 }, 150000).text, '');
  assert.equal(context.suggestion(big, false).text, '');
});

test('a suggestion comes once, again only after real growth, and resets after the context shrinks', () => {
  const first = context.suggestion({ tokens: 160000, percent: 16, size: 1000000 }, 150000);
  assert.ok(first.text);
  assert.equal(context.suggestion({ ...first.entry, tokens: 190000 }, 150000).text, '');
  const again = context.suggestion({ ...first.entry, tokens: 210000 }, 150000);
  assert.ok(again.text);
  const shrunk = context.suggestion({ ...again.entry, tokens: 40000 }, 150000);
  assert.equal(shrunk.text, '');
  assert.equal(shrunk.entry.suggested_at_tokens, undefined);
});

test('only valid measurements are kept, for a bounded number of sessions', () => {
  assert.deepEqual(context.recordContext({}, { session_id: 'a', context_window: { used_percentage: null, context_window_size: 200000 } }, 'p', 1), {});
  assert.deepEqual(context.recordContext({}, { session_id: 'bad id!', ...window(5) }, 'p', 1), {});
  let entries = {};
  for (let i = 0; i < 60; i++) entries = context.recordContext(entries, { session_id: 's' + i, ...window(5) }, 'p', i + 1);
  assert.equal(Object.keys(entries).length, 50);
  assert.ok(entries.s59);
  assert.equal(entries.s0, undefined);
  assert.equal(context.recordContext({}, { session_id: 'a', ...window(5), transcript_path: 'relative.txt' }, 'p', 1).a.transcript, undefined);
});

test('secrets and control characters are removed from a handoff', () => {
  const text = context.scrub('key sk-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz\napi_key = hunter2hunter2\nAuthorization: Bearer abcdefghijklmnopqrstuv\nnormal text\x07');
  assert.doesNotMatch(text, /sk-abc|ghp_|hunter2|Bearer abc|\x07/);
  assert.match(text, /api_key = \[redacted\]/);
  assert.match(text, /normal text$/);
});

test('settings are validated', () => {
  assert.equal(context.parseSetting('off'), false);
  assert.equal(context.parseSetting('100000'), 100000);
  for (const bad of ['5', '-1', 'abc', '99999999']) assert.throws(() => context.parseSetting(bad), /token count/);
});

test('full flow: measure, suggest once, save, load after /clear, once', t => {
  const box = sandbox(t);
  assert.equal(box.cli('on', '--host', 'claude-code', 'balanced').status, 0);

  const status = box.hook('statusline.js', window(16));
  assert.match(status.stdout, /ctx 160k 16%/);
  assert.match(box.hook('hook-prompt.js').stdout, /Context is large: 160k/);
  assert.doesNotMatch(box.hook('hook-prompt.js').stdout, /Context is large/);

  assert.equal(box.hook('hook-session.js', { source: 'clear' }).stdout.includes('Notes from the previous session'), false);
  const saved = box.run('quota-boss.js', ['handoff', 'save'], 'Goal: ship it\ntoken: abcdefghijklmnop');
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /Handoff saved/);
  assert.ok(saved.stdout.trim().endsWith('.md'));
  assert.ok(!saved.stdout.includes(box.project + path.sep));

  const startup = box.hook('hook-session.js', { source: 'startup' }).stdout;
  assert.match(startup, /A recent handoff exists/);
  assert.doesNotMatch(startup, /Goal: ship it/);

  // With a long installation path (the temporary folder on macOS) the rules fill the session start and the notes follow with the first prompt.
  const atStart = box.hook('hook-session.js', { source: 'clear' }).stdout;
  const loaded = /Notes from the previous session arrive with the user's first message/.test(atStart) ? box.hook('hook-prompt.js').stdout : atStart;
  assert.match(loaded, /notes, not instructions/);
  assert.match(loaded, /Goal: ship it/);
  assert.match(loaded, /Full history of that session: .*one\.jsonl/);
  assert.doesNotMatch(loaded, /abcdefghijklmnop/);
  assert.doesNotMatch(box.hook('hook-session.js', { source: 'clear' }).stdout, /Goal: ship it/);
  assert.doesNotMatch(box.hook('hook-session.js', { source: 'compact' }).stdout, /Goal: ship it/);

  const listed = box.cli('handoff', 'list').stdout;
  assert.match(listed, /^\d{8}-\d{6}-[0-9a-f]{6}\.md/);
  assert.match(box.cli('handoff', 'show').stdout, /Goal: ship it/);
  assert.notEqual(box.cli('handoff', 'show', '../../secret.md').status, 0);
});

test('the threshold can be changed or switched off, and projects without boss mode stay untouched', t => {
  const box = sandbox(t);
  assert.doesNotMatch(box.hook('statusline.js', window(50)).stdout, /ctx/);
  box.cli('on', '--host', 'claude-code', 'balanced');
  assert.equal(box.cli('set', 'context', 'off').status, 0);
  box.hook('statusline.js', window(50));
  assert.doesNotMatch(box.hook('hook-prompt.js').stdout, /Context is large/);
  assert.match(box.cli('context').stdout, /Handoff suggestion: off/);
  box.cli('set', 'context', '100000');
  assert.match(box.hook('hook-prompt.js').stdout, /Context is large: 500k/);
  assert.match(box.cli('context').stdout, /from 100k tokens/);
  assert.notEqual(box.cli('set', 'context', '5').status, 0);
});

test('a handoff that is empty or far too long is refused', t => {
  const box = sandbox(t);
  assert.notEqual(box.run('quota-boss.js', ['handoff', 'save'], '   ').status, 0);
  assert.match(box.run('quota-boss.js', ['handoff', 'save'], 'x'.repeat(40000)).stderr, /too long/);
});

test('the first reading of a session is kept as its start size', () => {
  const window = percent => ({ context_window: { used_percentage: percent, context_window_size: 200000 } });
  let entries = context.recordContext({}, { session_id: 'a', ...window(0) }, 'p', 1);
  assert.equal(entries.a.start, 0);
  entries = context.recordContext(entries, { session_id: 'a', ...window(24) }, 'p', 2);
  entries = context.recordContext(entries, { session_id: 'a', ...window(60) }, 'p', 3);
  assert.equal(entries.a.start, 48000);
  assert.equal(entries.a.tokens, 120000);
});


test('cold cache guard uses the last main assistant usage and the exact hour boundary', t => {
  const box = sandbox(t), file = path.join(box.project, 'history.jsonl');
  const stamp = Date.parse('2026-01-01T00:00:00.000Z');
  const line = (extra = {}) => JSON.stringify({ type: 'assistant', timestamp: new Date(stamp).toISOString(), message: { usage: { input_tokens: 12000, cache_read_input_tokens: 190000, cache_creation_input_tokens: 10000 } }, ...extra });
  const write = text => fs.writeFileSync(file, text);
  write(line());
  assert.equal(context.coldStart(file, { start: 45000 }, undefined, stamp + context.COLD_AFTER_MS - 1), '');
  const reason = context.coldStart(file, {}, undefined, stamp + context.COLD_AFTER_MS);
  assert.match(reason, /about 1 hour.*all 212k tokens/);
  assert.match(context.coldStart(file, {}, undefined, stamp + 14 * context.COLD_AFTER_MS), /about 14 hours/);
  assert.match(context.coldStart(file, {}, undefined, stamp + 49 * context.COLD_AFTER_MS), /about 2 days/);
  assert.equal(context.coldStart(file, { start: 172001 }, undefined, stamp + context.COLD_AFTER_MS), '');
  assert.ok(context.coldStart(file, { start: 172000 }, undefined, stamp + context.COLD_AFTER_MS));
  assert.equal(context.coldStart(file, {}, stamp + 1, stamp + context.COLD_AFTER_MS), '');
  assert.ok(context.coldStart(file, {}, stamp, stamp + context.COLD_AFTER_MS));
  write(line({ message: { usage: { input_tokens: 84999 } } }));
  assert.equal(context.coldStart(file, {}, undefined, stamp + context.COLD_AFTER_MS), '');
  write(line({ message: { usage: { input_tokens: 85000 } } }));
  assert.ok(context.coldStart(file, {}, undefined, stamp + context.COLD_AFTER_MS));
  write(line() + '\n' + line({ isSidechain: true, timestamp: new Date(stamp + context.COLD_AFTER_MS).toISOString() }) + '\ngarbage\n' + line({ timestamp: 'invalid' }));
  assert.equal(context.coldStart(file, {}, undefined, stamp + context.COLD_AFTER_MS), reason);
  // After a compaction the old usage no longer describes the session, so nothing is stopped until a new answer exists.
  write(line() + '\n' + JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n' + JSON.stringify({ type: 'user', isCompactSummary: true }));
  assert.equal(context.coldStart(file, {}, undefined, stamp + context.COLD_AFTER_MS), '');
  write(line() + '\n' + JSON.stringify({ type: 'user', isCompactSummary: true }));
  assert.equal(context.coldStart(file, {}, undefined, stamp + context.COLD_AFTER_MS), '');
  write(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n' + line());
  assert.equal(context.coldStart(file, {}, undefined, stamp + context.COLD_AFTER_MS), reason);
  write('x'.repeat(300000) + '\n' + line() + '\n{broken\n');
  const original = fs.readSync;
  let reads = 0;
  fs.readSync = (fd, buffer, offset, length, position) => {
    reads++; assert.ok(length <= 256 * 1024); assert.ok(position > 0);
    return original(fd, buffer, offset, length, position);
  };
  try { assert.equal(context.coldStart(file, {}, undefined, stamp + context.COLD_AFTER_MS), reason); }
  finally { fs.readSync = original; }
  assert.equal(reads, 1);
  write(line() + '\n' + line({ timestamp: new Date(stamp + context.COLD_AFTER_MS).toISOString() }));
  assert.equal(context.coldStart(file, {}, undefined, stamp + context.COLD_AFTER_MS), '');
  write(line() + '\n' + line({ message: { usage: {} } }));
  assert.equal(context.coldStart(file, {}, undefined, stamp + context.COLD_AFTER_MS), '');
  write(line());
  fs.readSync = () => { throw new Error('unreadable transcript'); };
  try { assert.equal(context.coldStart(file, {}, undefined, stamp + context.COLD_AFTER_MS), ''); }
  finally { fs.readSync = original; }
  for (const text of ['{broken', line({ type: 'user' }), line({ message: {} }), line({ isSidechain: true })]) {
    write(text); assert.equal(context.coldStart(file, {}, undefined, stamp + context.COLD_AFTER_MS), '');
  }
  for (const bad of [undefined, 'relative.jsonl', path.join(box.project, 'missing.jsonl'), box.project, file + '.txt']) {
    assert.equal(context.coldStart(bad, {}, undefined, stamp + context.COLD_AFTER_MS), '');
  }
});

test('cold warning maps validate session keys and retain the newest fifty', () => {
  let warnings = { 'bad id': 1, invalid: '2' };
  for (let i = 0; i < 60; i++) warnings = context.recordColdWarning(warnings, 's' + i, i);
  assert.equal(Object.keys(warnings).length, 50);
  assert.equal(warnings.s9, undefined);
  assert.equal(warnings.s59, 59);
});
