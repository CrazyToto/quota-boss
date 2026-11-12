'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const latency = require('../scripts/latency');
const { route } = require('../scripts/route');
const quotaBoss = require('../scripts/quota-boss');

const now = Date.now();
const run = (model, category, tier, seconds, extra = {}) => ({ t: now, model, category, tier, seconds, ok: true, ...extra });

test('median never mixes difficulty tiers and category needs three samples', () => {
  const runs = [
    run('model', 'implementation', 'normal', 10),
    run('model', 'implementation', 'normal', 20),
    run('model', 'implementation', 'normal', 30),
    run('model', 'implementation', 'critical', 100),
    run('model', 'implementation', 'critical', 110),
    run('model', 'implementation', 'critical', 120),
    run('model', 'review', 'normal', 40),
    run('model', 'review', 'normal', 50),
    run('model', 'review', 'normal', 60),
  ];
  assert.equal(latency.medianSeconds(runs, 'model', 'implementation', 'normal'), 20);
  assert.equal(latency.medianSeconds(runs, 'model', 'review', 'normal'), 50);
  assert.equal(latency.medianSeconds(runs.slice(0, 2), 'model', 'implementation', 'normal'), null);
  assert.equal(latency.medianSeconds(runs.slice(0, 6), 'model', 'implementation', 'normal'), 20);
});

test('readRuns drops invalid, failed, old, future and oversized entries', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-latency-'));
  const previous = process.env.QUOTA_BOSS_HOME;
  process.env.QUOTA_BOSS_HOME = home;
  try {
    const file = path.join(home, 'runs.jsonl');
    const valid = run('model', 'implementation', 'normal', 12);
    fs.writeFileSync(file, [JSON.stringify(valid), JSON.stringify({ ...valid, ok: false }),
      JSON.stringify({ ...valid, t: now - 31 * 86400000 }), JSON.stringify({ ...valid, t: now + 1 }),
      '{bad', 'x'.repeat(1025)].join('\n') + '\n');
    assert.deepEqual(latency.readRuns(now), [valid]);
  } finally {
    if (previous === undefined) delete process.env.QUOTA_BOSS_HOME; else process.env.QUOTA_BOSS_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('speedFactor applies tolerance, weights, critical exemption and overrides', () => {
  assert.equal(latency.speedFactor(null, 'normal'), 1);
  assert.equal(latency.speedFactor(600, 'normal'), 1);
  assert.ok(latency.speedFactor(1200, 'normal') < 1);
  assert.equal(latency.speedFactor(99999, 'critical'), 1);
  assert.equal(latency.speedFactor(200, 'trivial', { latency: { tolerance: { trivial: 100 }, weight: { trivial: 1 } } }), 0.5);
});

test('routing applies latency only to the matching tier', () => {
  const models = { categories: ['implementation'], models: {
    fast: { pool: 'claude', label: 'Fast', cost: 1, scores: { implementation: 8 } },
    slow: { pool: 'codex', label: 'Slow', cost: 0.5, scores: { implementation: 8 } }
  } };
  const limits = { claude: { five_hour: { used_percentage: 0 }, seven_day: { used_percentage: 0 } },
    codex: { primary: { used_percent: 0 }, secondary: { used_percent: 0 } } };
  const runs = Array.from({ length: 3 }, (_, i) => run('slow', 'implementation', 'normal', 3600 + i));
  const workers = { codex: true, gpt: true, perplexity: false };
  const winners = result => Object.fromEntries(result.rows.map(row => [row.tier, row.model]));
  const baseline = winners(route({ models, limits, workers }));
  assert.equal(baseline.normal, 'slow');
  const slowNormal = winners(route({ models, limits, runs, workers }));
  assert.deepEqual(slowNormal, { ...baseline, normal: 'fast' });
  const criticalRuns = Array.from({ length: 3 }, (_, i) => run('slow', 'implementation', 'critical', 3600 + i));
  assert.deepEqual(winners(route({ models, limits, runs: criticalRuns, workers })), baseline);
});

test('timing rejects invalid input', () => {
  assert.throws(() => quotaBoss.run(['timing', 'bad model', 'implementation', 'normal', '1', 'ok']), /Invalid model/);
  assert.throws(() => quotaBoss.run(['timing', 'model', 'bad', 'normal', '1', 'ok']), /Invalid category/);
  assert.throws(() => quotaBoss.run(['timing', 'model', '-', '-', '86401', 'ok']), /Invalid seconds/);
  assert.throws(() => quotaBoss.run(['timing', 'model', '-', '-', '1', 'maybe']), /Invalid timing result/);
  assert.throws(() => quotaBoss.run(['timing', 'no-such-model', '-', '-', '1', 'ok']), /Unknown model/);
});
