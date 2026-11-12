'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { route, formatTable, successProbability, projectWindow, poolPrice } = require('../scripts/route');
const thresholds = require('../config/thresholds.json');
const now = Date.UTC(2026, 10, 8, 12);
const model = (pool, cost, score, extra = {}) => ({ pool, cost, label: pool + score, scores: { implementation: score }, ...extra });
const models = { categories: ['implementation'], models: {
  cheap: model('codex', 1, 7), strong: model('claude', 3, 9)
} };
const select = (input = {}, tier = 'normal') => route({ models, thresholds, now, ...input }).rows.find(r => r.tier === tier);
const outcome = (result, extra = {}) => ({ t: now - 1000, model: 'cheap', category: 'implementation', tier: 'normal', result, ...extra });

test('verified failures shift the choice; passes and off-tier evidence use the specified posterior', () => {
  assert.equal(select().model, 'cheap');
  assert.equal(select({ outcomes: [outcome('fail'), outcome('fail')] }).model, 'strong');
  const candidate = { ...models.models.cheap, id: 'cheap' };
  const prior = successProbability(candidate, 'implementation', 'normal', [], thresholds, now);
  const P = successProbability(candidate, 'implementation', 'normal', [outcome('pass'), outcome('fail', { tier: 'critical' })], thresholds, now);
  assert.ok(Math.abs(P - (prior * thresholds.n0 + 1) / (thresholds.n0 + 2)) < 1e-12);
  assert.equal(successProbability(candidate, 'implementation', 'normal', [outcome('fail', { t: now - 91 * 86400000 })], thresholds, now), prior);
});

test('pace projects usage to reset and prices an impending quota shortage', () => {
  const history = [{ t: now - 60 * 60000, u5: 10 }, { t: now, u5: 40 }];
  const window = { used_percent: 40, window_minutes: 300, resets_at: now / 1000 + 180 * 60 };
  const projection = projectWindow(window, 'used_percent', history, 'u5', now);
  assert.equal(projection.rate, 0.5);
  const confidence = Math.min(1, 60 / thresholds.history.paceMinutes);
  const projected = Math.min(200, 40 + 0.5 * 180 * confidence);
  const pressure = Math.min(1.5, (40 + Math.max(0, projected - 100)) / 100);
  assert.equal(projection.projected, projected);
  assert.equal(projection.pressure, pressure);
  assert.ok(Math.abs(poolPrice('codex', { codex: { primary: window } }, { codex: history }, thresholds, now) - (1 + 3 * pressure ** 2)) < 1e-12);
  // A full observation interval can project overshoot; pressure stays bounded.
  const sustained = [{ t: now - 120 * 60000, u5: 0 }, { t: now, u5: 90 }];
  const shortage = projectWindow({ ...window, used_percent: 90 }, 'used_percent', sustained, 'u5', now);
  assert.equal(shortage.projected, 200);
  assert.equal(shortage.pressure, 1.5);
});

test('idle quota near reset receives the use-it-or-lose-it pressure discount', () => {
  const history = [{ t: now - 30 * 60000, u5: 20 }, { t: now, u5: 20 }];
  const soon = { used_percent: 20, window_minutes: 300, resets_at: now / 1000 + 30 * 60 };
  const later = { ...soon, resets_at: now / 1000 + 90 * 60 };
  const discounted = projectWindow(soon, 'used_percent', history, 'u5', now);
  assert.equal(discounted.discounted, true);
  assert.equal(discounted.pressure, 0.1);
  assert.equal(projectWindow(later, 'used_percent', history, 'u5', now).pressure, 0.2);
  assert.ok(Math.abs(poolPrice('codex', { codex: { primary: soon } }, { codex: history }, thresholds, now) - 1.03) < 1e-12);
});

test('reset counters discard the previous burn segment and unknown quota has a neutral price', () => {
  const window = { used_percent: 2, resets_at: now / 1000 + 150 * 60, window_minutes: 300 };
  const history = [{ t: now - 90 * 60000, u5: 80 }, { t: now - 60 * 60000, u5: 95 },
    { t: now - 30 * 60000, u5: 1 }, { t: now, u5: 2 }];
  assert.equal(projectWindow(window, 'used_percent', history, 'u5', now).rate, 1 / 30);
  assert.equal(poolPrice('codex', {}, {}, thresholds, now), 1.3);
  const expired = projectWindow({ ...window, resets_at: now / 1000 - 1 }, 'used_percent', history, 'u5', now);
  assert.equal(expired.used, 0);
});

test('profile alpha changes the normal-tier choice without changing probability or price', () => {
  const quality = select({ profile: 'quality' });
  const frugal = select({ profile: 'frugal' });
  assert.equal(quality.model, 'strong');
  assert.equal(frugal.model, 'cheap');
  const a = route({ models, thresholds, now, profile: 'quality' }).candidates;
  const b = route({ models, thresholds, now, profile: 'frugal' }).candidates;
  assert.deepEqual(a.map(c => [c.P, c.price]), b.map(c => [c.P, c.price]));
});

test('ladder raises effort on the primary before switching to a different pool', () => {
  const row = select();
  assert.equal(row.effort, 'medium');
  assert.deepEqual(row.ladder.map(s => [s.model, s.effort]), [['cheap', 'medium'], ['cheap', 'high'], ['strong', null]]);
  assert.match(formatTable({ rows: [row], options: [] }), /codex7>codex7\+>claude9/);
  const strongCodex = { categories: ['implementation'], models: { x: model('codex', 1, 9), y: model('claude', 2, 10) } };
  assert.equal(select({ models: strongCodex }).effort, 'low');
  const critical = select({ models: strongCodex, workers: { codex: true }, outcomes: [outcome('unavailable', { model: 'y' })] }, 'critical');
  assert.equal(critical.effort, 'high');
  assert.ok(critical.ladder.length <= 2);
});

test('unavailable is global across tasks for 24 hours and never appears in a ladder', () => {
  const unavailable = outcome('unavailable', { category: 'research', tier: 'trivial' });
  const result = route({ models, thresholds, now, outcomes: [unavailable] });
  assert.ok(result.rows.every(r => r.model !== 'cheap' && r.ladder.every(s => s.model !== 'cheap')));
  assert.ok(result.candidates.filter(c => c.model === 'cheap').every(c => /24h exclusion/.test(c.reason)));
  assert.equal(select({ outcomes: [{ ...unavailable, t: now - 24 * 3600000 }] }).model, 'cheap');
});

test('emergency excludes delegated work; only critical self can fall back when no alternative qualifies', () => {
  const registry = { categories: ['implementation'], models: {
    boss: model('claude', 10, 10, { agentModel: 'opus' }),
    helper: model('claude', 1, 10, { agentModel: 'haiku' }), x: model('codex', 1, 7)
  } };
  const limits = { claude: { five_hour: { used_percentage: 90 } } };
  const result = route({ models: registry, thresholds, now, limits });
  assert.equal(result.rows.find(r => r.tier === 'critical').model, 'boss');
  assert.ok(result.rows.filter(r => r.tier !== 'critical').every(r => r.pool === 'codex'));
  const blocked = route({ models: registry, thresholds, now, limits: { ...limits, codex: { primary: { used_percent: 99 } } } });
  assert.deepEqual(blocked.rows.map(r => [r.tier, r.model]), [['critical', 'boss']]);
  const weakBoss = { categories: ['implementation'], models: {
    boss: model('claude', 10, 8), x: model('codex', 1, 9)
  } };
  const fallback = select({ models: weakBoss, limits }, 'critical');
  assert.equal(fallback.model, 'x');
  assert.equal(fallback.belowThreshold, true);
});

test('minP fallback chooses best probability and utility ties prefer P then previous pool', () => {
  const low = { categories: ['implementation'], models: { a: model('codex', 1, 3), b: model('claude', 10, 4) } };
  assert.equal(select({ models: low }).model, 'b');
  assert.equal(select({ models: low }).belowThreshold, true);
  const tie = { categories: ['implementation'], models: { a: model('codex', 1, 8), b: model('claude', 1.01, 8) } };
  assert.equal(select({ models: tie, previousPool: 'claude' }).model, 'b');
  const highP = { categories: ['implementation'], models: { a: model('codex', 1, 7), b: model('claude', 1, 8) } };
  const cheapP = 1 / (1 + Math.exp(-0.55));
  const strongP = 1 / (1 + Math.exp(-1.65));
  highP.models.b.cost = (strongP / cheapP) ** 2 * 1.01;
  assert.equal(select({ models: highP, previousPool: 'codex' }).model, 'b');
});

test('bossFactor applies only to delegated Claude work and tunables alter scoring', () => {
  const registry = { categories: ['implementation'], models: {
    boss: model('claude', 1, 8, { agentModel: 'opus' }), helper: model('claude', 1, 8, { agentModel: 'sonnet' })
  } };
  const candidates = route({ models: registry, thresholds, now }).candidates.filter(c => c.tier === 'normal');
  assert.equal(candidates[1].price / candidates[0].price, thresholds.bossFactor);
  assert.ok(select({ thresholds: { ...thresholds, minP: { normal: 0.99 } } }).belowThreshold);
});

test.describe('same-pool delegation only when clearly cheaper', () => {
  const pool = (extra = {}) => ({ categories: ['implementation'], models: {
    boss: model('codex', 10, 9),
    half: model('codex', 5, 9),
    over: model('codex', 5.1, 9.5),
    ...extra
  } });
  const row = (input = {}) => route({ models: pool(), thresholds, now, host: 'codex', bossModel: 'boss', ...input }).rows.find(r => r.tier === 'normal');
  const reasons = (input = {}) => Object.fromEntries(route({ models: pool(), thresholds, now, host: 'codex', bossModel: 'boss', ...input })
    .candidates.filter(c => c.tier === 'normal').map(c => [c.model, c.reason]));

  test('a worker at exactly half the boss cost may win, one just above loses with a stated reason', () => {
    const r = reasons();
    assert.match(r.over, /^lost: same pool, costs more than 0\.5 of the boss$/);
    assert.doesNotMatch(r.half, /same pool/);
    assert.equal(row().model, 'half');
  });
  test('without a cheap enough worker the row stays with the boss', () => {
    const result = route({ models: { categories: ['implementation'], models: { boss: model('codex', 10, 9), sol: model('codex', 6, 9.5) } }, thresholds, now, host: 'codex', bossModel: 'boss' });
    const normal = result.rows.find(r => r.tier === 'normal');
    assert.equal(normal.via, 'self');
    assert.ok(normal.ladder.every(step => step.model !== 'sol'), 'a blocked worker is not an escalation step either');
  });
  test('effort counts toward the worker cost', () => {
    const efforts = { efforts: ['low', 'medium', 'high'] };
    const result = route({ models: { categories: ['implementation'], models: { boss: model('codex', 10, 9), w: model('codex', 4.5, 9, { ...efforts, minEffort: 'high' }) } },
      thresholds: { ...thresholds, effortCost: { low: 1, medium: 1, high: 1.25 } }, now, host: 'codex', bossModel: 'boss' });
    assert.match(result.candidates.find(c => c.tier === 'normal' && c.model === 'w').reason, /same pool/);
  });
  test('samePoolRatio is configurable and clamped to 0..1', () => {
    assert.doesNotMatch(reasons({ thresholds: { ...thresholds, samePoolRatio: 0.6 } }).over, /same pool/);
    assert.match(reasons({ thresholds: { ...thresholds, samePoolRatio: 0 } }).half, /same pool/);
    assert.match(reasons({ thresholds: { ...thresholds, samePoolRatio: -3 } }).half, /costs more than 0 of/);
    assert.doesNotMatch(reasons({ thresholds: { ...thresholds, samePoolRatio: 7 } }).over, /same pool/);
    assert.match(reasons({ thresholds: { ...thresholds, samePoolRatio: 'x' } }).over, /costs more than 0\.5 of/);
  });
  test('other pools are never blocked, however expensive', () => {
    const result = route({ models: pool({ c: model('claude', 50, 9.9, { agentModel: 'sonnet' }) }), thresholds, now, host: 'codex', bossModel: 'boss' });
    assert.doesNotMatch(result.candidates.find(c => c.tier === 'normal' && c.model === 'c').reason, /same pool/);
  });
  test('the rule needs a usable boss: below minP or unknown boss leaves workers alone', () => {
    const weak = route({ models: { categories: ['implementation'], models: { boss: model('codex', 10, 1), sol: model('codex', 9, 9) } }, thresholds, now, host: 'codex', bossModel: 'boss' });
    assert.equal(weak.rows.find(r => r.tier === 'normal').model, 'sol');
    const generic = route({ models: pool(), thresholds, now, host: 'generic' });
    assert.ok(generic.candidates.every(c => !/same pool/.test(c.reason)));
  });
  test('a Claude boss still hands normal work to Codex and keeps Haiku', () => {
    const mixed = { categories: ['implementation'], models: { opus: model('claude', 10, 9.5, { agentModel: 'opus' }),
      haiku: model('claude', 0.32, 9, { agentModel: 'haiku' }), sonnet: model('claude', 6, 9.5, { agentModel: 'sonnet' }), gpt: model('codex', 5, 9) } };
    const result = route({ models: mixed, thresholds, now, bossModel: 'opus' });
    const reason = id => result.candidates.find(c => c.tier === 'normal' && c.model === id).reason;
    assert.match(reason('sonnet'), /same pool/);
    assert.doesNotMatch(reason('haiku'), /same pool/);
    assert.doesNotMatch(reason('gpt'), /same pool/);
  });
});
