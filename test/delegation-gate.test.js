'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { route, formatExplain, formatTable } = require('../scripts/route');
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

test('omitted, undefined, null and invalid size preserve routing without gate fields', () => {
  const baseline = route({ models: registry, thresholds, now });
  for (const size of [undefined, null, 'huge', {}, 1]) {
    const result = route({ models: registry, thresholds, now, size });
    assert.deepEqual(result.rows, baseline.rows);
    assert.ok(result.candidates.every(c => !Object.hasOwn(c, 'gate')));
  }
});

test('Claude boss keeps small implementation and delegates medium and large to Codex', () => {
  for (const size of ['small', 'medium', 'large']) {
    const result = route({ models: registry, thresholds, now, host: 'claude-code', bossModel: 'claude-opus-5-5', size });
    const winner = result.rows.find(c => c.tier === 'normal' && c.category === 'implementation');
    assert.equal(winner.pool, size === 'small' ? 'claude' : 'codex');
    if (size === 'small') {
      assert.equal(winner.via, 'self');
      assert.equal(normal(result).find(c => c.model === 'gpt-6.1-sol').reason, 'lost: handover costs more than it saves (small)');
    }
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
    const bossSide = 0.55 * B + (1 - c.P) * B + (pool === 'claude' ? workerCost : 0.117);
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
  const c = worker(run({ runs }));
  assert.equal(c.reason, 'lost: handover too slow (medium)');
  assert.equal(c.gate.extraSeconds, 900);
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
  const gate = { size: { medium: 2 }, margin: 1, maxTotalRatio: 2, handover: { 'claude-code': { fixed: 0.1, perSize: 0.2 } }, reread: 0.5, workSeconds: 200, handoverSeconds: { 'claude-code': 77 }, maxExtraSeconds: { medium: 76 } };
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
    assert.match(hosts.rules(host), /table assumes a medium job;.*route --size small\|large <category> <tier>/);
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
});

test('time limit is tight with quota to spare and loose while the boss pool saves', () => {
  const runs = Array.from({ length: 3 }, () => ({ model: 'worker', category: 'implementation', tier: 'normal', seconds: 250 }));
  const spare = worker(run({ runs }));
  assert.equal(spare.gate.extraSeconds, 150);
  assert.equal(spare.reason, 'lost: handover too slow (medium)');
  const saving = worker(run({ runs, limits: { claude: { five_hour: { used_percentage: 70 } } } }));
  assert.equal(saving.gate.extraSeconds, 150);
  assert.doesNotMatch(String(saving.reason), /lost/);
  const large = worker(run({ runs: runs.map(r => ({ ...r, seconds: 200 })), size: 'large' }));
  assert.equal(large.gate.extraSeconds, 200);
  assert.doesNotMatch(String(large.reason), /lost/);
});
