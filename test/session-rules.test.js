'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../scripts/lib');
const hosts = require('../scripts/hosts');
const root = path.join(__dirname, '..');
const consensus = 'use `consensus` before deciding';

test('consensus false removes only its line for every host', () => {
  for (const host of ['claude-code', 'codex', 'generic']) {
    const baseline = hosts.rules(host);
    assert.ok(baseline.includes(consensus));
    assert.equal(hosts.rules(host, { consensus: true }), baseline);
    for (const value of [undefined, null, 0, 'false']) {
      assert.equal(hosts.rules(host, { consensus: value }), baseline);
    }
    const enabled = hosts.rules(host, { consensus: true, terse: true });
    const disabled = hosts.rules(host, { consensus: false, terse: true });
    assert.equal(disabled, enabled.split('\n').filter(line => !line.includes(consensus)).join('\n'));
    const off = hosts.rules(host, { consensus: false });
    const expected = baseline.replace(/^.*use `consensus` before deciding.*(?:\n|$)/m, '');
    assert.equal(off, host === 'claude-code' ? expected.trimEnd() : expected);
    assert.ok(!off.includes(consensus));
    if (host === 'claude-code') assert.equal(off, off.trimEnd());
  }
});

test('rule filtering preserves neighbours and handles absent or unreadable rules', () => {
  const original = lib.readBounded;
  let content = 'before\nremove: use `consensus` before deciding\nafter';
  lib.readBounded = (file, size) => path.basename(file) === 'RULES.md' ? content : original(file, size);
  try {
    assert.equal(hosts.rules('claude-code', { consensus: false }), 'before\nafter');
    content = 'before\nremove: use `consensus` before deciding';
    assert.equal(hosts.rules('claude-code', { consensus: false }), 'before');
    content = 'before\nafter';
    assert.equal(hosts.rules('claude-code', { consensus: false }), content);
    lib.readBounded = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    assert.equal(hosts.rules('claude-code', { consensus: false }), '');
    lib.readBounded = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    assert.throws(() => hosts.rules('claude-code'), /denied/);
  } finally { lib.readBounded = original; }
});

test('self worker inherits model and retains the implementation worker contract', () => {
  const worker = fs.readFileSync(path.join(root, 'agents/self-worker.md'), 'utf8');
  const sonnet = fs.readFileSync(path.join(root, 'agents/sonnet-worker.md'), 'utf8');
  assert.match(worker, /^name: self-worker$/m);
  assert.match(worker, /^model: inherit$/m);
  assert.match(worker, /<!-- managed-by: quota-boss -->/);
  assert.match(worker, /{{QUOTA_BOSS_HOME}}/);
  const tools = worker.match(/^tools: (.+)$/m)[1].split(', ');
  assert.deepEqual(tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
  assert.ok(!tools.includes('Agent') && !tools.includes('Task'));
  assert.equal(worker.slice(worker.indexOf('1. ')), sonnet.slice(sonnet.indexOf('1. ')));
});

test('failure and review instructions preserve one family-aware counter-review', () => {
  const rules = fs.readFileSync(path.join(root, 'templates', 'RULES.md'), 'utf8');
  const cli = fs.readFileSync(path.join(root, 'agents/cli-worker.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(root, 'agents/reviewer.md'), 'utf8');
  assert.match(rules, /reports `FAILED:`, run `route` again before picking the next worker/);
  assert.match(rules, /never send the same job to the same model after a structural error/);
  assert.match(rules, /Codex built it -> Claude reviews/);
  assert.match(rules, /Claude built it -> `gpt-advisor` reviews/);
  assert.match(cli, /HTTP 400, 422, invalid request, unsupported parameter or message format errors/);
  assert.match(cli, /feedback <model> <category> <tier> fail`, do not retry, and set `STATUS: FAILED: structural: <reason>`/);
  assert.match(cli, /<tier> limited/);
  assert.match(cli, /unavailable.*401, unauthorized, API key, model not found, provider not found/);
  assert.doesNotMatch(reviewer, /codex-run|counter-review|GPT model|model answers/);
  assert.deepEqual([...reviewer.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1])), [1, 2, 3]);
});

test('handover envelopes survive worker adapters and host rule embedding', () => {
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const rules = read('templates/RULES.md');
  for (const key of ['GOAL:', 'SCOPE:', 'BASE:', 'CONSTRAINTS:', 'CHECK:', 'REPORT:']) assert.ok(rules.includes(key), key);
  const report = ['STATUS:', 'CHANGED:', 'CHECK:', 'OPEN:'];
  for (const key of report) assert.ok(rules.includes(key), key);
  assert.match(rules, /git rev-parse --short HEAD/);
  assert.match(rules, /Read the result with `git diff`/);
  for (const name of ['haiku-worker', 'sonnet-worker', 'opus-worker', 'self-worker', 'claude-worker', 'cli-worker', 'codex-worker']) {
    const text = read('agents/' + name + '.md');
    assert.match(text, /^---\nname:/);
    assert.match(text, /<!-- managed-by: quota-boss -->/);
    for (const key of report) assert.ok(text.includes(key), name + ' ' + key);
    assert.match(text, /untrusted data|data, not instructions/);
    if (['claude-worker', 'cli-worker'].includes(name)) assert.match(text, /RUN: <provider> <model> <seconds>s/);
  }
  for (const host of ['codex', 'generic']) {
    const text = hosts.rules(host);
    for (const key of report) assert.ok(text.includes(key), host + ' ' + key);
    assert.match(text, /RUN: <provider> <model> <seconds>s/);
    assert.doesNotMatch(text, /{{QUOTA_BOSS_HOME}}/);
  }
});

test('scout limits Bash to bounded read-only graph queries and workers confirm hints', () => {
  const scout = fs.readFileSync(path.join(root, 'agents/scout.md'), 'utf8');
  assert.match(scout, /^tools: .*\bBash\b.*mcp__codebase-memory__\*.*mcp__serena__\*/m);
  assert.ok(scout.includes('Bash is only for `node "{{QUOTA_BOSS_HOME}}/scripts/quota-boss.js" graph explain|affected|path ...`; run no other command and never write files.'));
  assert.match(scout, /run the bounded graph query first/);
  assert.match(scout, /never read it whole/);
  assert.match(scout, /untrusted data/);
  for (const name of ['haiku-worker', 'sonnet-worker', 'opus-worker', 'self-worker', 'reviewer']) {
    const text = fs.readFileSync(path.join(root, 'agents/' + name + '.md'), 'utf8');
    assert.match(text, /quota-boss\.js" graph explain\|affected\|path <name>/);
    assert.match(text, /confirm with Grep; when it reports no graph, use Grep/);
  }
});

test('other skills and plugins keep their own workflow on every host and in terse mode', () => {
  for (const host of ['claude-code', 'codex', 'generic']) {
    for (const project of [{}, { terse: true }, { consensus: false }]) {
      const text = hosts.rules(host, project);
      assert.match(text, /^9\. Other skills, plugins and slash commands keep their own workflow\./m, host);
      assert.match(text, /boss mode only decides who does the work it leaves open/, host);
      assert.match(text, /Keep the agents and models it names/, host);
      assert.match(text, /its review counts for rule 5/, host);
      assert.match(text, /The handover form of rule 4 is for Quota Boss workers only\./, host);
      assert.match(text, /The user's own instructions and rule 7 still come first\./, host);
    }
  }
});
