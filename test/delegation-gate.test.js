'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { route, routeTable, formatExplain, formatTable } = require('../scripts/route');
const lib = require('../scripts/lib');
const cli = require('../scripts/quota-boss');
const hosts = require('../scripts/hosts');
const thresholds = require('../config/thresholds.json');
const registry = require('../config/models.json');
const now = Date.UTC(2026, 10, 10);
const normal = result => result.candidates.filter(c => c.tier === 'normal' && c.category === 'implementation');
const own = result => normal(result).find(c => c.via === 'self');
const worker = result => normal(result).find(c => c.model === 'worker');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const model = (pool, cost) => ({ pool, cost, label: pool, agentModel: 'haiku', scores: { implementation: 9 }, efforts: ['low', 'medium', 'high', 'xhigh'] });
const fixture = (pool = 'codex') => ({ categories: ['implementation'], models: { boss: model('claude', 10), worker: model(pool, 1) } });
const run = (extra = {}) => route({ models: fixture(), bossModel: 'boss', thresholds, now, size: 'medium', ...extra });
// A more capable worker passes the calibrated cost gate so latency tests isolate the time limit.
const timeModels = fixture();
timeModels.models.boss.scores.implementation = 8;
const savingParams = { models: registry, thresholds, now, host: 'claude-code', bossModel: 'claude-opus-5-5',
  size: 'medium', limits: { claude: { five_hour: { used_percentage: 75 } } } };

test('omitted, undefined, null and invalid size preserve routing without gate fields', () => {
  const baseline = route({ models: registry, thresholds, now });
  for (const size of [undefined, null, 'huge', {}, 1]) {
    const result = route({ models: registry, thresholds, now, size });
    assert.deepEqual(result.rows, baseline.rows);
    assert.ok(result.candidates.every(c => !Object.hasOwn(c, 'gate')));
  }
});

test('calibrated Claude boss keeps small and medium normal implementation and delegates large to Codex', () => {
  // The saving-mode benchmark found no Claude saving on medium jobs; large jobs saved about 33%.
  for (const limits of [{}, savingParams.limits]) for (const size of ['small', 'medium', 'large']) {
    const result = route({ ...savingParams, limits, size });
    const winner = result.rows.find(c => c.tier === 'normal' && c.category === 'implementation');
    assert.equal(winner.model, size === 'large' ? 'gpt-6.2-sol' : 'claude-opus-5-5');
    if (size !== 'large') {
      assert.equal(winner.via, 'self');
      assert.equal(normal(result).find(c => c.model === 'gpt-6.2-sol').reason, 'lost: handover costs more than it saves (' + size + ')');
    } else assert.equal(winner.via, 'codex-worker');
  }
});

test('built-in handover defaults match the shipped calibration', () => {
  const { handover, ...gate } = thresholds.gate;
  assert.deepEqual(handover, { 'claude-code': { fixed: 0.2, perSize: 0.35, jobs: { 'normal.implementation': { fixed: 0.5 } } },
    codex: { fixed: 1.5, perSize: 0.4 }, generic: { fixed: 0.5, perSize: 0.35 } });
  for (const host of ['claude-code', 'codex', 'generic']) for (const size of ['small', 'medium', 'large']) {
    const params = { ...savingParams, host, size, bossModel: host === 'codex' ? 'gpt-6.1-sol' : savingParams.bossModel };
    assert.deepEqual(route({ ...params, thresholds: { ...thresholds, gate } }), route(params));
  }
});

test('at 75% Claude use only normal implementation gets the calibrated handover cost', () => {
  const result = route(savingParams);
  const h = thresholds.gate.handover['claude-code'];
  const baseline = route({ ...savingParams, thresholds: { ...thresholds, gate: { ...thresholds.gate,
    handover: { ...thresholds.gate.handover, 'claude-code': { ...h, jobs: {} } } } } });
  const calibrated = row => row.tier === 'normal' && row.category === 'implementation';
  assert.equal(result.rows.find(calibrated).via, 'self');
  assert.equal(baseline.rows.find(calibrated).via, 'codex-worker');
  assert.deepEqual(result.rows.filter(row => !calibrated(row)), baseline.rows.filter(row => !calibrated(row)));
  assert.deepEqual(result.candidates.filter(row => !calibrated(row)), baseline.candidates.filter(row => !calibrated(row)));
  for (const [tier, category] of [['normal', 'mechanical'], ['trivial', 'implementation']]) {
    assert.equal(result.rows.find(row => row.tier === tier && row.category === category).via, 'codex-worker');
  }
  assert.equal(route({ ...savingParams, size: 'large' }).rows.find(calibrated).via, 'codex-worker');
  assert.equal(routeTable(savingParams).rows.find(calibrated).large.via, 'codex-worker');
});

test('job handover overrides change only their tier and category and support either cost', () => {
  const h = thresholds.gate.handover['claude-code'];
  const baseline = route(savingParams);
  const matches = row => row.tier === 'normal' && row.category === 'mechanical';
  for (const job of [{ fixed: 0.9 }, { perSize: 0.9 }, { fixed: 0, perSize: 0 }]) {
    const result = route({ ...savingParams, thresholds: { ...thresholds, gate: { ...thresholds.gate,
      handover: { ...thresholds.gate.handover, 'claude-code': { ...h, jobs: { ...h.jobs, 'normal.mechanical': job } } } } } });
    assert.notDeepEqual(result.candidates.filter(matches), baseline.candidates.filter(matches));
    for (const key of ['rows', 'candidates', 'options']) {
      assert.deepEqual(result[key].filter(row => !matches(row)), baseline[key].filter(row => !matches(row)));
    }
    const c = result.candidates.find(row => matches(row) && row.model === 'gpt-6.1-sol');
    const before = baseline.candidates.find(row => matches(row) && row.model === c.model);
    const boss = baseline.candidates.find(row => matches(row) && row.via === 'self');
    close(c.gate.bossSide - before.gate.bossSide,
      ((job.fixed ?? h.fixed) + (job.perSize ?? h.perSize) - h.fixed - h.perSize) * boss.jobCost * boss.price);
  }
});

test('invalid or negative job costs fall back independently to host handover costs', () => {
  const h = { fixed: 0.3, perSize: 0.25 };
  const withJob = job => run({ thresholds: { ...thresholds, gate: { ...thresholds.gate,
    handover: { 'claude-code': { ...h, jobs: { 'normal.implementation': job } } } } } });
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, -0.1, '0.5', {}, []]) {
    assert.deepEqual(withJob(bad), withJob({}));
    assert.deepEqual(withJob({ fixed: bad, perSize: bad }), withJob({}));
    assert.deepEqual(withJob({ fixed: bad, perSize: 0.1 }), withJob({ fixed: h.fixed, perSize: 0.1 }));
    assert.deepEqual(withJob({ fixed: 0.1, perSize: bad }), withJob({ fixed: 0.1, perSize: h.perSize }));
  }
});

test('routeTable attaches the matching large choice only when a medium self row changes via', () => {
  const result = routeTable(savingParams);
  const medium = route(savingParams), large = route({ ...savingParams, size: 'large' });
  assert.ok(result.rows.some(row => row.large));
  assert.ok(result.rows.some(row => row.via === 'self' && !row.large));
  assert.ok(result.rows.some(row => row.via !== 'self'));
  for (const row of result.rows) {
    const alternative = large.rows.find(item => item.tier === row.tier && item.category === row.category);
    const { large: hint, ...primary } = row;
    assert.deepEqual(primary, medium.rows.find(item => item.tier === row.tier && item.category === row.category));
    if (row.via === 'self' && alternative && alternative.via !== row.via) assert.deepEqual(hint, alternative);
    else assert.ok(!Object.hasOwn(row, 'large'));
  }
  for (const key of ['candidates', 'options', 'mode', 'note']) assert.deepEqual(result[key], medium[key]);
});

test('routeTable preserves non-medium routing and is pure and deterministic', t => {
  for (const size of [undefined, null, 'small', 'large', 'huge']) {
    const params = { ...savingParams, size };
    assert.deepEqual(routeTable(params), route(params));
  }
  assert.deepEqual(routeTable(), route());
  assert.deepEqual(routeTable({ size: 'medium' }).rows, []);
  const before = JSON.stringify(savingParams);
  const expected = routeTable(savingParams);
  t.mock.method(Date, 'now', () => { throw new Error('Routing must use the supplied clock'); });
  assert.deepEqual(routeTable(savingParams), expected);
  assert.equal(JSON.stringify(savingParams), before);
});

test('formatTable renders a sanitized large hint without its ladder or nested hints', () => {
  const large = { tier: 'normal', category: 'implementation', model: 'gpt-6.1-sol', label: 'GPT-6.1-Sol\n<script>!',
    via: 'codex-worker', effort: 'low', ladder: [{ label: 'Hidden ladder', model: 'other' }], large: { label: 'Hidden hint' } };
  const row = { tier: 'normal', category: 'implementation', model: 'claude-opus-5-5', label: 'Opus 5.5', via: 'self', effort: null, large };
  const expected = 'normal: implementation=Opus 5.5(self)[large:' + lib.sanitizeLabel(large.label) + '(codex-worker,low,model=gpt-6.1-sol)]';
  assert.equal(formatTable({ rows: [row] }), expected);
  assert.equal(formatTable({ rows: [row] }, { ladder: false }), expected);
  for (const invalid of [null, {}, { ...large, tier: 'bad' }, { ...large, category: 'bad' }, { ...large, via: 'bad\nworker' },
    { ...large, effort: 'ultra' }, { ...large, model: 'bad\nmodel' }]) {
    assert.equal(formatTable({ rows: [{ ...row, large: invalid }] }), 'normal: implementation=Opus 5.5(self)');
  }
});

test('Codex boss keeps medium implementation', () => {
  const result = route({ models: registry, thresholds, now, host: 'codex', bossModel: 'gpt-6.1-sol', size: 'medium' });
  assert.equal(result.rows.find(c => c.tier === 'normal' && c.category === 'implementation').via, 'self');
});

test('same-pool and other-pool costs count worker and relay exactly once', () => {
  for (const pool of ['claude', 'codex']) {
    const result = run({ models: fixture(pool) });
    const boss = own(result), c = worker(result), B = 13;
    const selfCost = 13 * (2 - boss.P);
    const workerCost = 1.3 * 0.85 * (pool === 'claude' ? 1.95 : 1.3);
    // Calibrated fixed 0.5 + perSize 0.35 for one medium job.
    const bossSide = 0.85 * B + (1 - c.P) * B + (pool === 'claude' ? workerCost : 0.117);
    close(c.gate.bossSide, bossSide);
    close(c.gate.total, bossSide + (pool === 'claude' ? 0 : workerCost));
    close(c.gate.selfCost, selfCost);
    close(boss.gate.selfCost, selfCost);
    assert.equal(c.gate.extraSeconds, 50);
    assert.equal(c.reason.startsWith('lost: handover'), pool === 'claude' ? bossSide > 0.8 * selfCost : bossSide > 0.8 * selfCost || c.gate.total > 1.3 * selfCost);
  }
});

test('other pool must save boss quota and respect total ceiling; same pool uses margin', () => {
  const gate = { handover: { 'claude-code': { fixed: 0, perSize: 0 } }, reread: 0, margin: 1, maxTotalRatio: 1 };
  const expensive = fixture(); expensive.models.worker.cost = 100;
  const c = worker(run({ models: expensive, thresholds: { ...thresholds, gate } }));
  assert.ok(c.gate.bossSide < c.gate.selfCost);
  assert.ok(c.gate.total > c.gate.selfCost);
  assert.match(c.reason, /handover costs/);
  const same = worker(run({ models: fixture('claude'), thresholds: { ...thresholds, gate: { ...gate, margin: 0.1 } } }));
  assert.match(same.reason, /handover costs/);
});

test('slow worker fails time only after passing costs', () => {
  const runs = Array.from({ length: 3 }, () => ({ model: 'worker', category: 'implementation', tier: 'normal', seconds: 1000 }));
  const c = worker(run({ runs, models: timeModels }));
  assert.ok(c.gate.bossSide <= thresholds.gate.margin * c.gate.selfCost);
  assert.ok(c.gate.total <= thresholds.gate.maxTotalRatio * c.gate.selfCost);
  assert.equal(c.reason, 'lost: handover too slow (medium)');
  // handover 50 + worker 1000 - boss 50 (Claude Code boss speed)
  assert.equal(c.gate.extraSeconds, 1000);
  const costly = worker(run({ runs, size: 'small' }));
  assert.equal(costly.reason, 'lost: handover costs more than it saves (small)');
});

test('below-minimum or unusable boss gives no gate', () => {
  const below = fixture(); below.models.boss.scores.implementation = 0;
  for (const extra of [{ models: below }, { outcomes: [{ t: now, model: 'boss', category: 'implementation', tier: 'normal', result: 'unavailable' }] }]) {
    assert.ok(run(extra).candidates.every(c => !c.gate));
  }
});

test('gate overrides affect size, costs, time and limits', () => {
  const gate = { size: { medium: 2 }, margin: 1, maxTotalRatio: 2, handover: { 'claude-code': { fixed: 0.1, perSize: 0.2 } }, reread: 0.5, workSeconds: 200, bossSeconds: { 'claude-code': 200 }, handoverSeconds: { 'claude-code': 77 }, maxExtraSeconds: { medium: 76 } };
  const result = run({ thresholds: { ...thresholds, gate } });
  const c = worker(result);
  close(c.gate.selfCost, 2 * 13 * (2 - own(result).P));
  close(c.gate.bossSide, 0.5 * 13 + (1 - c.P) * 2 * 13 + 0.117);
  close(c.gate.total, c.gate.bossSide + 2.5 * 0.85 * 1.3);
  assert.equal(c.gate.extraSeconds, 77);
  assert.equal(c.reason, 'lost: handover too slow (medium)');
  const invalid = run({ thresholds: { ...thresholds, gate: { margin: NaN, workSeconds: Infinity, size: { medium: 'bad' } } } });
  assert.deepEqual(worker(invalid).gate, worker(run()).gate);
  const clamped = worker(run({ thresholds: { ...thresholds, gate: { margin: -1, maxTotalRatio: -1 } } }));
  assert.match(clamped.reason, /handover costs/);
});

test('boss effort changes self cost, keeps display effort null, and ignores invalid levels', () => {
  const base = own(run());
  assert.equal(base.chargedEffort, null);
  for (const bad of ['ultra', 'HIGH', {}, 7]) assert.deepEqual(own(run({ bossEffort: bad })), base);
  const high = own(run({ bossEffort: 'high' }));
  close(high.jobCost, base.jobCost * 1.25);
  assert.equal(high.effort, null);
  assert.equal(high.chargedEffort, 'high');
  close(own(run({ bossEffort: 'max' })).jobCost, own(run({ bossEffort: 'xhigh' })).jobCost);
  const codex = extra => own(route({ models: registry, thresholds, now, host: 'codex', bossModel: 'gpt-6.1-sol', ...extra }));
  close(codex({ bossEffort: 'high' }).jobCost, codex({}).jobCost * 1.65);
  close(codex({ bossEffort: 'max' }).jobCost, codex({}).jobCost * 3.4);
  assert.doesNotMatch(formatTable({ rows: [high] }), /self,high/);
});

test('all host rules include the size instruction from the shared rules', () => {
  for (const host of ['claude-code', 'codex', 'generic']) {
    assert.match(hosts.rules(host), /table assumes a medium job;.*\[large:\.\.\.\].*worker for a clearly large job/);
    assert.match(hosts.rules(host), /other clearly small or large jobs run `route --size small\|large <category> <tier>` before choosing who does it/);
  }
});

test('explanation includes gate numbers and boss effort', () => {
  const text = formatExplain(run({ bossEffort: 'high' }));
  assert.match(text, /boss effort high/);
  assert.match(text, /gate medium: self=\d+\.\d{3}/);
  assert.match(text, /gate medium: boss=\d+\.\d{3} total=\d+\.\d{3} self=\d+\.\d{3} extra=50s/);
});

test.describe('boss effort sources and CLI', () => {
  let dir, env;
  const keys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'QUOTA_BOSS_HOME', 'QUOTA_BOSS_BOSS_EFFORT', 'CLAUDE_CODE_EFFORT_LEVEL'];
  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-gate-'));
    env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    for (const key of keys.slice(0, 5)) process.env[key] = dir;
  });
  test.afterEach(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('environment overrides are lowercased and invalid values return null', () => {
    for (const host of ['claude-code', 'codex', 'generic']) {
      process.env.QUOTA_BOSS_BOSS_EFFORT = 'MAX';
      assert.equal(lib.currentBossEffort({ host }, {}, 'boss'), 'max');
      process.env.QUOTA_BOSS_BOSS_EFFORT = 'ultra';
      assert.equal(lib.currentBossEffort({ host }, {}, 'boss'), null);
    }
    delete process.env.QUOTA_BOSS_BOSS_EFFORT;
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'High';
    assert.equal(lib.currentBossEffort({ host: 'claude-code' }, {}, 'boss'), 'high');
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'bad';
    assert.equal(lib.currentBossEffort({ host: 'claude-code' }, {}, 'boss'), null);
  });
  test('Codex config uses only the top of file', () => {
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, 'model = "boss"\nmodel_reasoning_effort = "LOW"\n[profiles.other]\nmodel_reasoning_effort = "high"\n');
    assert.equal(lib.currentBossEffort({ host: 'codex' }), 'low');
    fs.writeFileSync(file, '[profiles.other]\nmodel_reasoning_effort = "high"\n');
    assert.equal(lib.currentBossEffort({ host: 'codex' }), null);
    fs.writeFileSync(file, 'model_reasoning_effort = "ultra"\n');
    assert.equal(lib.currentBossEffort({ host: 'codex' }), null);
  });
  test('Codex uses last turn in newest interactive project session, skipping workers', () => {
    const sessions = path.join(dir, 'sessions'); fs.mkdirSync(sessions);
    const log = (name, source, cwd, efforts) => {
      const file = path.join(sessions, name + '.jsonl');
      fs.writeFileSync(file, [JSON.stringify({ type: 'session_meta', payload: { source } }), ...efforts.map(effort => JSON.stringify({ type: 'turn_context', payload: { model: 'boss', cwd, effort } }))].join('\n') + '\n');
      const t = now + name.charCodeAt(0) * 1000; fs.utimesSync(file, t / 1000, t / 1000);
    };
    log('a', 'cli', dir, ['low', 'HIGH']);
    log('b', 'exec', dir, ['max']);
    log('c', { subagent: 'review' }, dir, ['max']);
    log('d', 'cli', path.join(os.tmpdir(), 'another-project'), ['max']);
    assert.equal(lib.currentBossEffort({ host: 'codex', directory: dir }), 'high');
    assert.equal(lib.currentBossModel({ host: 'codex', directory: dir }, {}), 'boss');
    const missing = path.join(sessions, 'e.jsonl');
    fs.writeFileSync(missing, JSON.stringify({ type: 'turn_context', payload: { cwd: dir, effort: 'medium' } }) + '\n');
    fs.utimesSync(missing, (now + 200000) / 1000, (now + 200000) / 1000);
    assert.equal(lib.currentBossEffort({ host: 'codex', directory: dir }), 'medium');
    fs.unlinkSync(missing);
    log('e', 'cli', dir, ['ultra']);
    assert.equal(lib.currentBossEffort({ host: 'codex', directory: dir }), null);
  });
  test('Claude settings prefer model effort, then top-level effort, and tolerate bad files', () => {
    const file = path.join(dir, 'settings.json');
    const project = { host: 'claude-code' };
    fs.writeFileSync(file, JSON.stringify({ modelSettings: { boss: { effortLevel: 'XHIGH' } }, effortLevel: 'medium' }));
    assert.equal(lib.currentBossEffort(project, {}, 'boss'), 'xhigh');
    assert.equal(lib.currentBossEffort(project, {}, 'other'), 'medium');
    fs.writeFileSync(file, JSON.stringify({ effortLevel: 'ultra' }));
    assert.equal(lib.currentBossEffort(project, {}, 'boss'), null);
    fs.writeFileSync(file, '{broken');
    assert.equal(lib.currentBossEffort(project, {}, 'boss'), null);
    fs.writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
    assert.equal(lib.currentBossEffort(project, {}, 'boss'), null);
    fs.unlinkSync(file);
    assert.equal(lib.currentBossEffort(project, {}, 'boss'), null);
  });
  test('CLI accepts size and explain in either order before category and tier', () => {
    for (const args of [['--size', 'small', '--explain'], ['--explain', '--size', 'large', 'implementation', 'normal']]) {
      assert.match(cli.run(['route', ...args]), /gate (small|large):/);
    }
    for (const args of [['--size', 'huge'], ['--size'], ['implementation', '--size', 'small']]) {
      assert.throws(() => cli.run(['route', ...args]), /Usage:/);
    }
  });
  test('CLI adds large hints only to default plain tables and preserves Codex host tables', t => {
    let project = lib.normalizeProject({ host: 'claude-code' });
    t.mock.method(lib, 'findProjectConfig', () => project);
    t.mock.method(lib, 'currentBossModel', () => project.host === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5');
    t.mock.method(lib, 'currentBossEffort', () => null);
    t.mock.method(lib, 'readProviderLimits', () => savingParams.limits);
    assert.match(cli.run(['route', 'implementation', 'normal']), /implementation=Opus 5\.5\(self\).*\[large:GPT-6\.2-Sol\(codex-worker,low,model=gpt-6\.2-sol\)\]/);
    for (const size of ['small', 'medium', 'large']) {
      assert.doesNotMatch(cli.run(['route', '--size', size]), /\[large:/);
    }
    assert.doesNotMatch(cli.run(['route', '--explain']), /\[large:/);
    project = lib.normalizeProject({ host: 'codex' });
    assert.equal(cli.run(['route']), cli.run(['route', '--size', 'medium']));
    assert.doesNotMatch(cli.run(['route']), /\[large:/);
  });
});

test('time limit is tight with quota to spare and loose while the boss pool saves', () => {
  const runs = Array.from({ length: 3 }, () => ({ model: 'worker', category: 'implementation', tier: 'normal', seconds: 150 }));
  const spare = worker(run({ runs, models: timeModels }));
  assert.equal(spare.gate.extraSeconds, 150);
  assert.equal(spare.reason, 'lost: handover too slow (medium)');
  const saving = worker(run({ runs, models: timeModels, limits: { claude: { five_hour: { used_percentage: 70 } } } }));
  assert.equal(saving.gate.extraSeconds, 150);
  assert.doesNotMatch(String(saving.reason), /lost/);
  const large = worker(run({ runs: runs.map(r => ({ ...r, seconds: 110 })), size: 'large' }));
  // 50 handover + 3 * 110 worker - 3 * 50 boss
  assert.equal(large.gate.extraSeconds, 230);
  assert.doesNotMatch(String(large.reason), /lost/);
});

test('an unmeasured worker is assumed as fast as the boss, and bossSeconds sets the boss speed', () => {
  // Without latency data only the handover time is extra, so cheap unmeasured workers are not ruled out by time.
  assert.equal(worker(run()).gate.extraSeconds, 50);
  const runs = Array.from({ length: 3 }, () => ({ model: 'worker', category: 'implementation', tier: 'normal', seconds: 120 }));
  assert.equal(worker(run({ runs })).gate.extraSeconds, 120);
  const slowBoss = worker(run({ runs, thresholds: { ...thresholds, gate: { bossSeconds: { 'claude-code': 150 } } } }));
  assert.equal(slowBoss.gate.extraSeconds, 20);
});

test('workSeconds and bossSeconds act on their own side, and a measured boss wins over bossSeconds', () => {
  const gate = { workSeconds: 300, bossSeconds: { 'claude-code': 100 } };
  // 50 handover + 300 unmeasured worker - 100 boss
  assert.equal(worker(run({ thresholds: { ...thresholds, gate } })).gate.extraSeconds, 250);
  const bossRuns = Array.from({ length: 3 }, () => ({ model: 'boss', category: 'implementation', tier: 'normal', seconds: 40 }));
  assert.equal(worker(run({ runs: bossRuns, thresholds: { ...thresholds, gate } })).gate.extraSeconds, 310);
});
