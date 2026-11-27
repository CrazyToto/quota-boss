'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const runner = require('../scripts/cli-run');
const { route } = require('../scripts/route');

const T0 = Date.UTC(2026, 10, 21, 10, 30);
const MIN = 60000;
const fail = (model, t, kind, extra = {}) => ({ t, model, category: 'mechanical', tier: 'trivial', result: 'fail', kind, ...extra });
const pass = (model, t, extra = {}) => ({ t, model, category: 'mechanical', tier: 'trivial', result: 'pass', ...extra });

function isolatedHome(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-cooldown-'));
  const previous = process.env.QUOTA_BOSS_HOME;
  process.env.QUOTA_BOSS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.QUOTA_BOSS_HOME; else process.env.QUOTA_BOSS_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test('reset hints: OpenRouter daily counter, headers, Retry-After, durations and ISO times', () => {
  const midnight = Date.UTC(2026, 10, 22);
  assert.equal(lib.resetHint('Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', T0), midnight);
  // A reset header wins over the daily guess; seconds and milliseconds both work.
  assert.equal(lib.resetHint('free-models-per-day "X-RateLimit-Reset":"' + (T0 + 3 * MIN) + '"', T0), T0 + 3 * MIN);
  assert.equal(lib.resetHint('x-ratelimit-reset: ' + Math.round((T0 + 120000) / 1000), T0), T0 + 120000);
  assert.equal(lib.resetHint("You've reached your monthly usage limit. Wait for the limit to reset next month.", T0), Date.UTC(2026, 11, 1));
  assert.equal(lib.resetHint('monthly usage limit', T0), null);
  assert.equal(lib.resetHint('Retry-After: 90', T0), T0 + 90000);
  assert.equal(lib.resetHint('please retry after 30 seconds', T0), T0 + 30000);
  assert.equal(lib.resetHint('Retry after 2 minutes', T0), T0 + 2 * MIN);
  assert.equal(lib.resetHint('retry-after: 5m', T0), T0 + 5 * MIN);
  assert.equal(lib.resetHint('retry after 3 hours', T0), T0 + 180 * MIN);
  assert.equal(lib.resetHint("You've hit your usage limit. Try again in 2h 5m.", T0), T0 + (2 * 60 + 5) * MIN);
  assert.equal(lib.resetHint('try again in 1 day, 3 hours and 10 minutes', T0), T0 + (24 * 60 + 3 * 60 + 10) * MIN);
  assert.equal(lib.resetHint('Try again in 2h5m', T0), T0 + 125 * MIN);
  assert.equal(lib.resetHint('quota resets at 2026-11-22T19:00:00Z', T0), Date.UTC(2026, 10, 22, 19));
  assert.equal(lib.resetHint('resets at 2026-11-22T20:00+01:00', T0), Date.UTC(2026, 10, 22, 19));
  // Nothing usable: no hint, a time in the past, or more than 8 days ahead.
  for (const text of ['', 'HTTP 429', 'Processed 429 files', 'try again later', 'resets at 2026-11-20T00:00:00Z',
    'try again in 9 days', 'Retry-After: 9999999', 'x-ratelimit-reset: 1000', 'try again in 0 minutes', null, undefined])
    assert.equal(lib.resetHint(text, T0), null, String(text));
});

test('a breaker pauses a model, doubles the pause per failure in a row and closes on a pass', () => {
  const one = lib.cooldowns([fail('m', T0, 'quota')], T0 + MIN).models.get('m');
  assert.deepEqual({ ...one }, { until: T0 + 15 * MIN, kind: 'quota', streak: 1, since: T0, halfOpen: false });
  // Outages start shorter than quota.
  assert.equal(lib.cooldowns([fail('m', T0, 'outage')], T0).models.get('m').until, T0 + 5 * MIN);
  const twice = [fail('m', T0, 'quota'), fail('m', T0 + 20 * MIN, 'quota')];
  assert.equal(lib.cooldowns(twice, T0 + 21 * MIN).models.get('m').until, T0 + 50 * MIN);
  // The old 'limited' result and timeouts take part too; a quality failure does not pause.
  const mixed = [{ t: T0, model: 'm', category: 'review', tier: 'normal', result: 'limited' }, fail('m', T0 + 20 * MIN, 'timeout'), fail('m', T0 + 21 * MIN, 'check-fail')];
  assert.equal(lib.cooldowns(mixed, T0 + 22 * MIN).models.get('m').streak, 2);
  // A timeout is a heavy job, not a quota: it keeps its base pause instead of doubling.
  assert.equal(lib.cooldowns(mixed, T0 + 22 * MIN).models.get('m').until, T0 + 35 * MIN);
  // Failures while the model is already paused (other runs, manual feedback) do not grow the streak.
  const during = [fail('m', T0, 'quota'), fail('m', T0 + MIN, 'quota'), fail('m', T0 + 2 * MIN, 'quota')];
  assert.deepEqual([lib.cooldowns(during, T0 + 3 * MIN).models.get('m').streak, lib.cooldowns(during, T0 + 3 * MIN).models.get('m').until], [1, T0 + 17 * MIN]);
  assert.equal(lib.cooldowns([fail('m', T0, 'structural'), fail('m', T0, 'context'), fail('m', T0)], T0 + 1).models.size, 0);
  // The cap holds however long the streak.
  const many = Array.from({ length: 10 }, (_, i) => fail('m', T0 + i * 7 * 60 * MIN, 'quota'));
  const last = T0 + 9 * 7 * 60 * MIN;
  assert.equal(lib.cooldowns(many, last + MIN).models.get('m').streak, 10);
  assert.equal(lib.cooldowns(many, last + MIN).models.get('m').until, last + 6 * 60 * MIN);
  assert.equal(lib.cooldowns(many, last + MIN, { cooldownMaxMinutes: 60 }).models.get('m').until, last + 60 * MIN);
  assert.equal(lib.cooldowns([fail('m', T0, 'outage')], T0, { cooldownMinutes: { outage: 2 } }).models.get('m').until, T0 + 2 * MIN);
  // A pass closes it; a later failure starts over at the base.
  const closed = [...twice, pass('m', T0 + 60 * MIN), fail('m', T0 + 70 * MIN, 'quota')];
  assert.deepEqual([lib.cooldowns(closed, T0 + 71 * MIN).models.get('m').streak, lib.cooldowns(closed, T0 + 71 * MIN).models.get('m').until], [1, T0 + 85 * MIN]);
  assert.equal(lib.cooldowns([...twice, pass('m', T0 + 60 * MIN)], T0 + 61 * MIN).models.size, 0);
  // Order in the journal does not matter.
  assert.equal(lib.cooldowns([...twice].reverse(), T0 + 21 * MIN).models.get('m').until, T0 + 50 * MIN);
  // Benchmarks never teach the router.
  assert.equal(lib.cooldowns([fail('m', T0, 'quota', { bench: 'b1' })], T0 + 1).models.size, 0);
});

test('after its pause a model is half-open, and rateLimitedModels lists only open breakers', () => {
  const outcomes = [fail('m', T0, 'quota')];
  assert.equal(lib.cooldowns(outcomes, T0 + 14 * MIN).models.get('m').halfOpen, false);
  assert.ok(lib.rateLimitedModels(outcomes, T0 + 14 * MIN).has('m'));
  assert.equal(lib.cooldowns(outcomes, T0 + 15 * MIN).models.get('m').halfOpen, true);
  assert.equal(lib.rateLimitedModels(outcomes, T0 + 15 * MIN).size, 0);
  // A failed probe pauses it twice as long.
  const probed = [...outcomes, fail('m', T0 + 16 * MIN, 'quota')];
  assert.equal(lib.cooldowns(probed, T0 + 17 * MIN).models.get('m').until, T0 + 46 * MIN);
});

test('a quota failure with a reset time pauses the whole pool until then; an outage stays with its model', () => {
  const registry = { a: { pool: 'openrouter-free' }, b: { pool: 'openrouter-free' }, c: { pool: 'other' } };
  const midnight = Date.UTC(2026, 10, 22);
  const quota = [fail('a', T0, 'quota', { until: midnight })];
  let state = lib.cooldowns(quota, T0 + MIN, {}, registry);
  assert.equal(state.pools.get('openrouter-free').until, midnight);
  assert.equal(state.models.get('a').until, midnight);
  assert.equal(state.models.has('b'), false);
  assert.equal(lib.cooldowns(quota, midnight, {}, registry).pools.size, 0);
  // Without a reset time, or for an outage, only the model pauses.
  assert.equal(lib.cooldowns([fail('a', T0, 'quota')], T0 + 1, {}, registry).pools.size, 0);
  assert.equal(lib.cooldowns([fail('a', T0, 'outage', { until: T0 + 60 * MIN })], T0 + 1, {}, registry).pools.size, 0);
  // A later pass in the same pool proves the account works again; a pass elsewhere does not.
  assert.equal(lib.cooldowns([...quota, pass('b', T0 + 2 * MIN)], T0 + 3 * MIN, {}, registry).pools.size, 0);
  assert.equal(lib.cooldowns([...quota, pass('c', T0 + 2 * MIN)], T0 + 3 * MIN, {}, registry).pools.size, 1);
  // A newer account limit after a pass counts again, even if it ends sooner than the old one.
  const again = [...quota, pass('b', T0 + 2 * MIN), fail('b', T0 + 3 * MIN, 'quota', { until: T0 + 120 * MIN })];
  assert.equal(lib.cooldowns(again, T0 + 4 * MIN, {}, registry).pools.get('openrouter-free').until, T0 + 120 * MIN);
  // A short per-model rate limit (under an hour) pauses only that model, not its pool.
  state = lib.cooldowns([fail('a', T0, 'quota', { until: T0 + 30 * MIN })], T0 + MIN, {}, registry);
  assert.deepEqual([state.pools.size, state.models.get('a').until], [0, T0 + 30 * MIN]);
  // The later reset time of two wins; unknown models have no pool.
  state = lib.cooldowns([...quota, fail('b', T0 + MIN, 'quota', { until: T0 + 30 * MIN })], T0 + 2 * MIN, {}, registry);
  assert.equal(state.pools.get('openrouter-free').until, midnight);
  assert.equal(lib.cooldowns([fail('x', T0, 'quota', { until: midnight })], T0 + 1, {}, registry).pools.size, 0);
});

test('a probe lease counts only while fresh and newer than the failure it probes', () => {
  const state = { since: T0 };
  assert.equal(lib.activeProbe({ m: T0 + MIN }, 'm', state, T0 + 2 * MIN), true);
  assert.equal(lib.activeProbe({ m: T0 + MIN }, 'm', state, T0 + MIN + lib.PROBE_LEASE_MS), false);
  assert.equal(lib.activeProbe({ m: T0 - MIN }, 'm', state, T0 + MIN), false);
  assert.equal(lib.activeProbe({ m: T0 + 5 * MIN }, 'm', state, T0 + MIN), false);
  for (const probes of [{}, null, { m: 'x' }, { other: T0 }]) assert.equal(lib.activeProbe(probes, 'm', state, T0 + MIN), false);
});

test('claimProbe and releaseProbe keep one lease per model in state and drop stale ones', t => {
  isolatedHome(t);
  lib.updateState(() => ({ probes: { old: T0 - lib.PROBE_LEASE_MS - 1 } }));
  const claimed = lib.claimProbe('m', T0);
  assert.equal(claimed, T0);
  assert.deepEqual(lib.readState().probes, { m: T0 });
  // A second run does not take over a fresh lease, and a release only drops its own lease.
  assert.equal(lib.claimProbe('m', T0 + MIN), null);
  lib.releaseProbe('m', T0 + MIN);
  assert.deepEqual(lib.readState().probes, { m: T0 });
  lib.releaseProbe('m', claimed);
  assert.deepEqual(lib.readState().probes, {});
  // A lease left behind by a crashed run expires.
  lib.claimProbe('m', T0);
  assert.equal(lib.claimProbe('m', T0 + lib.PROBE_LEASE_MS), T0 + lib.PROBE_LEASE_MS);
  assert.deepEqual(lib.readState().probes, { m: T0 + lib.PROBE_LEASE_MS });
});

test('feedback takes a reset time only for a transient result within 8 days', t => {
  isolatedHome(t);
  const models = { models: { m: { pool: 'claude' } } };
  const base = { model: 'm', category: 'mechanical', tier: 'trivial' };
  const entry = lib.appendOutcome({ ...base, result: 'fail', kind: 'quota', until: '2026-11-22T19:00:00Z' }, models, [], T0);
  assert.equal(entry.until, Date.UTC(2026, 10, 22, 19));
  assert.equal(lib.validOutcome(entry), true);
  assert.equal(lib.appendOutcome({ ...base, result: 'limited', until: T0 + MIN }, models, [], T0).until, T0 + MIN);
  for (const value of [{ result: 'pass' }, { result: 'fail' }, { result: 'fail', kind: 'check-fail' }, { result: 'unavailable' }])
    assert.throws(() => lib.appendOutcome({ ...base, ...value, until: T0 + MIN }, models, [], T0), /--until needs/);
  for (const until of ['soon', T0 - 1, T0, T0 + 9 * 86400000, NaN])
    assert.throws(() => lib.appendOutcome({ ...base, result: 'fail', kind: 'quota', until }, models, [], T0), /within the next 8 days/);
  assert.equal(lib.appendOutcome({ ...base, result: 'fail', kind: 'quota', until: null }, models, [], T0).until, undefined);
  // Journal records with a broken reset time are ignored.
  for (const until of [T0, T0 + 9 * 86400000, 'x']) assert.equal(lib.validOutcome(fail('m', T0, 'quota', { until })), false);
  assert.equal(lib.validOutcome({ ...pass('m', T0), until: T0 + MIN }), false);
});

function routing(outcomes, now, probes = {}) {
  const providers = { providers: { ...lib.BUILTIN_PROVIDERS.providers,
    copilot: { ...lib.BUILTIN_PROVIDERS.providers.copilot, enabled: true } } };
  const models = { categories: ['mechanical'], models: {
    cp: { pool: 'copilot', label: 'Copilot A', cost: 0.1, scores: { mechanical: 8 } },
    cq: { pool: 'copilot', label: 'Copilot B', cost: 0.1, scores: { mechanical: 8 } } } };
  return route({ models, providers, host: 'claude-code', outcomes, now, probes, findExecutable: () => process.execPath, codexModels: [] });
}
const reasonOf = (result, model) => result.candidates.find(c => c.model === model && c.tier === 'trivial').reason;

test('routing skips paused models and pools, names the reset time, and lets one probe through', () => {
  const now = T0 + MIN;
  assert.match(reasonOf(routing([fail('cp', T0, 'outage')], now), 'cp'), /^cooling down: outage until 2026-11-21 10:35 UTC$/);
  assert.doesNotMatch(reasonOf(routing([fail('cp', T0, 'outage')], now), 'cq'), /cooling/);
  const daily = [fail('cp', T0, 'quota', { until: Date.UTC(2026, 10, 22) })];
  for (const model of ['cp', 'cq']) assert.equal(reasonOf(routing(daily, now), model), 'cooling down: copilot quota until 2026-11-22 00:00 UTC');
  // Half-open: the model is usable and marked as a probe, unless another run holds the lease.
  const later = T0 + 20 * MIN;
  const open = routing([fail('cp', T0, 'quota')], later);
  assert.doesNotMatch(reasonOf(open, 'cp'), /cooling/);
  assert.equal(open.candidates.find(c => c.model === 'cp' && c.tier === 'trivial').probe, true);
  assert.equal(reasonOf(routing([fail('cp', T0, 'quota')], later, { cp: later - MIN }), 'cp'), 'cooling down: probe running');
  assert.doesNotMatch(reasonOf(routing([fail('cp', T0, 'quota')], later, { cp: T0 - MIN }), 'cp'), /cooling/);
});

test('sticky last-good route: on a near tie the model that last passed this job keeps it, and a probe yields', () => {
  const now = T0 + 60 * MIN;
  const winner = result => result.rows.find(r => r.tier === 'trivial' && r.category === 'mechanical').model;
  const plain = winner(routing([], now));
  const other = plain === 'cp' ? 'cq' : 'cp';
  assert.equal(winner(routing([pass(other, T0)], now)), other);
  assert.equal(winner(routing([pass(plain, T0), pass(other, T0 + MIN)], now)), other);
  // A pass in another category does not make it sticky here.
  assert.equal(winner(routing([{ ...pass(other, T0), category: 'review' }], now)), plain);
  // A half-open equal does not take the job from a healthy one.
  assert.equal(winner(routing([fail(plain, T0, 'quota')], now)), other);
});

test('cli-run reads OpenRouter\'s daily limit as a quota pause until 00:00 UTC and tells outages apart', async () => {
  const cfg = { providers: { providers: { trial: { label: 'Trial', kind: 'free', enabled: true, worker: 'cli-worker',
    cli: { command: 'trial', args: ['-p', '{prompt}', '--model', '{model}'], defaultModel: 'default' } } } },
  models: { models: { tiny: { pool: 'trial', cliModel: 'vendor/tiny' } } } };
  const runWith = async (stderr, extra = {}) => {
    const records = { feedback: [], claims: [], releases: [] };
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const deps = { prompt: 'p', env: { PATH: path.dirname(process.execPath) }, platform: process.platform,
      findProjectConfig: () => ({ directory: process.cwd() }), loadConfig: () => cfg, findExecutable: () => process.execPath,
      now: () => T0, gitStatus: () => '', recordRun: () => {}, appendUsage: () => {},
      appendOutcome: (...args) => records.feedback.push(args[0]),
      claimProbe: (model, t) => { records.claims.push([model, t]); return t; }, releaseProbe: (...args) => records.releases.push(args),
      spawn() {
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 1; child.kill = () => {};
        queueMicrotask(() => { child.stderr.end(stderr); child.stdout.end(''); setImmediate(() => child.emit('close', 1)); });
        return child;
      }, ...extra };
    return { result: await runner.run(['--provider', 'trial', '--model', 'tiny'], deps), records };
  };
  const daily = await runWith('Error: 429 Rate limit exceeded: free-models-per-day.');
  assert.deepEqual(daily.records.feedback[0], { model: 'tiny', category: 'mechanical', tier: 'trivial', result: 'fail', kind: 'quota', until: Date.UTC(2026, 10, 22) });
  assert.match(daily.result.report, /^cli-run: FAILED \(limited: provider limit\) .*\| quota until 2026-11-22 00:00 UTC \|/);
  const plain = await runWith("You've hit your usage limit. Try again in 2h.");
  assert.deepEqual(plain.records.feedback[0], { model: 'tiny', category: 'mechanical', tier: 'trivial', result: 'fail', kind: 'quota', until: T0 + 120 * MIN });
  const gateway = await runWith('HTTP 502 bad gateway');
  assert.equal(gateway.records.feedback[0].kind, 'outage');
  const outage = await runWith('HTTP 503 service unavailable');
  assert.deepEqual(outage.records.feedback[0], { model: 'tiny', category: 'mechanical', tier: 'trivial', result: 'fail', kind: 'outage' });
  assert.match(outage.result.report, /\| outage \|/);
  assert.equal(daily.records.claims.length + outage.records.claims.length, 0);
  // A half-open model claims the probe lease for its run and gives it back afterwards.
  const probed = await runWith('HTTP 503', { readOutcomes: () => [fail('tiny', T0 - 20 * MIN, 'quota')] });
  assert.deepEqual(probed.records.claims, [['tiny', T0]]);
  assert.deepEqual(probed.records.releases, [['tiny', T0]]);
  // A broken journal never blocks the run.
  const broken = await runWith('HTTP 503', { readOutcomes: () => { throw new Error('disk'); } });
  assert.match(broken.result.report, /feedback recorded/);
});
