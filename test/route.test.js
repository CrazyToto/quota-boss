'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('../scripts/lib');

test.describe('route', () => {
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

const { route, formatTable } = require('../scripts/route');

function select(result, tier, category) { return result.rows.find(row => row.tier === tier && row.category === category); }

test('route variants never change home files, including history and oversized usage', () => {
  enable({ host: 'codex' });
  codexLog();
  lib.writeJson(lib.getPaths().stateFile, { bossModel: 'claude-opus-5-6', history: {} });
  lib.atomicWrite(lib.getPaths().usageFile, (JSON.stringify({ t: Date.now(), provider: 'claude', amount: 1, unit: 'calls' }) + '\n').repeat(5000));
  const snapshot = directory => fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name), stat = fs.statSync(file);
    return [[file, stat.size, stat.mtimeMs], ...(entry.isDirectory() ? snapshot(file) : [])];
  });
  const before = snapshot(process.env.QUOTA_BOSS_HOME);
  const cli = require('../scripts/quota-boss');
  for (const flags of [[], ['--explain'], ['--size', 'small'], ['--size', 'medium'], ['--size', 'large', 'implementation', 'normal'], ['--explain', '--size', 'large', 'research']]) {
    assert.equal(typeof cli.run(['route', ...flags]), 'string');
    assert.deepEqual(snapshot(process.env.QUOTA_BOSS_HOME), before);
  }
});

test('session table prints the unknown boss note exactly once before its rows', () => {
  enable();
  const result = invoke(require('../scripts/hook-session').main, JSON.stringify({ cwd: project, model: 'claude-opus-5-6' }));
  assert.equal(result.status, 0);
  assert.equal((result.stdout.match(/Note: boss model /g) || []).length, 1);
  assert.match(result.stdout, /Note: boss model claude-opus-5-6[^\n]+\ncritical:/);
});

test('unknown boss maps by pool family and highest version, or the default pick', () => {
  const { formatExplain, bossModelId } = require('../scripts/route');
  const config = lib.loadConfig();
  for (const [host, reported, expected, label] of [
    ['claude-code', 'claude-opus-5-6', 'claude-opus-5-5', 'Opus 5.5'],
    ['codex', 'gpt-6.2-sol', 'gpt-6.1-sol', 'GPT-6.1-Sol']
  ]) {
    const result = route({ ...config, host, bossModel: reported, size: 'small' });
    assert.ok(result.candidates.some(c => c.model === expected && c.via === 'self'));
    assert.equal(result.note, 'Note: boss model ' + reported + ' is not in the registry; routing assumes ' + label + '. Add it to config/models.json to route exactly.');
    assert.ok(formatTable(result).startsWith(result.note + '\n'));
    assert.ok(formatExplain(result).startsWith(result.note + '\n'));
    const known = route({ ...config, host, bossModel: expected });
    assert.equal(known.note, null);
    const fallback = route({ ...config, host, bossModel: 'unknown' });
    assert.deepEqual(fallback.rows, route({ ...config, host }).rows);
    assert.match(fallback.note, /boss model unknown/);
  }
  assert.equal(bossModelId('gpt-99-sol', [
    { id: 'gpt-6.9-sol', pool: 'codex' }, { id: 'gpt-6.10-sol', pool: 'codex' }, { id: 'claude-sol-100', pool: 'claude' }
  ], 'codex'), 'gpt-6.10-sol');
  const unsafe = route({ ...config, bossModel: 'bad\n\x1b[31m<id>' });
  assert.equal(unsafe.note.split('\n').length, 1);
  assert.doesNotMatch(unsafe.note, /\x1b/);
});

test('critical uses probability floors and utility; manual research stays optional', () => {
  const config = lib.loadConfig();
  // With nothing used at all, Sonnet 5.5 at high (measured cost 1.1) ties with GPT-6.1 Sol at high (1.65) for implementation. A little Claude use decides it.
  const result = route({ ...config, limits: limits(10, 10, 0, 0) });
  assert.equal(result.rows.length, 18);
  assert.equal(select(result, 'critical', 'architecture').model, 'claude-opus-5-5');
  const implementation = select(result, 'critical', 'implementation');
  assert.equal(implementation.model, 'gpt-6.1-sol');
  assert.equal(implementation.via, 'codex-worker');
  assert.equal(implementation.effort, 'high');
  assert.equal(result.rows.some(row => row.pool === 'perplexity'), false);
  assert.equal(result.options.length, 3);
  assert.ok(result.options.every(row => row.category === 'research' && row.via === 'researcher (manual)'));
  assert.equal(select(result, 'critical', 'research').belowThreshold, true);
  assert.ok(formatTable(result).split('\n').length <= 6);
});

test('frugal tasks use cheap models above the probability floor with effort from margin', () => {
  // Explicit costs/scores keep this algorithm test independent of the tunable registry.
  const models = { models: {
    'claude-haiku-5-5': { pool: 'claude', label: 'Haiku', agentModel: 'haiku', cost: 1,
      scores: { architecture: 5, implementation: 6, mechanical: 8, research: 6 } },
    'gpt-6-luna': { pool: 'codex', label: 'Luna', cost: 2,
      scores: { architecture: 5, implementation: 7, mechanical: 8, research: 7 } }
  } };
  const thresholds = { bossFactor: 1.5, difficulty: { normal: 6.5, trivial: 4.5 },
    minP: { normal: 0.55, trivial: 0.4 }, alpha: { normal: { frugal: 1.5 }, trivial: { frugal: 0.7 } } };
  const result = route({ models, thresholds, profile: 'frugal', limits: limits(0, 0, 0, 0) });
  assert.equal(select(result, 'normal', 'mechanical').model, 'claude-haiku-5-5');
  assert.equal(select(result, 'normal', 'implementation').model, 'gpt-6-luna');
  assert.equal(select(result, 'normal', 'implementation').effort, 'medium');
  assert.equal(select(result, 'trivial', 'architecture').model, 'claude-haiku-5-5');
  assert.equal(select(result, 'normal', 'mechanical').via, 'haiku-worker');
  assert.equal(select(result, 'normal', 'research').via, 'gpt-advisor');
});

test('weaker Claude models get workers that can edit, and every route they use appears in the table', () => {
  const models = { models: {
    'claude-haiku-5-5': { pool: 'claude', label: 'Haiku', agentModel: 'haiku', cost: 0.25,
      scores: { mechanical: 8, implementation: 8, research: 8 } },
    'claude-sonnet-5-5': { pool: 'claude', label: 'Sonnet', agentModel: 'sonnet', cost: 0.25,
      scores: { architecture: 9, debugging: 9 } }
  } };
  const result = route({ models, limits: limits(0, 0, 0, 0) });
  assert.equal(select(result, 'trivial', 'mechanical').via, 'haiku-worker');
  assert.equal(select(result, 'trivial', 'implementation').via, 'haiku-worker');
  assert.equal(select(result, 'trivial', 'research').via, 'researcher');
  assert.equal(select(result, 'normal', 'debugging').via, 'sonnet-worker');
  const table = formatTable(result);
  for (const worker of ['haiku-worker', 'researcher', 'sonnet-worker']) assert.ok(table.includes('(' + worker + ')'), worker);
});

test('a CLI relay counts against Claude, so direct Haiku beats a free relay on trivial jobs', () => {
  const free = lib.BUILTIN_PROVIDERS.providers['kilo-free'];
  const providers = { ...lib.BUILTIN_PROVIDERS,
    providers: { ...lib.BUILTIN_PROVIDERS.providers, 'kilo-free': { ...free, enabled: true, trainsOnData: false } } };
  const models = { categories: ['mechanical'], models: {
    'claude-haiku-5-5': { pool: 'claude', label: 'Haiku', agentModel: 'haiku', cost: 0.25, scores: { mechanical: 8 } },
    relayed: { pool: 'kilo-free', label: 'Free', cost: 0, scores: { mechanical: 8 } }
  } };
  const pick = thresholds => select(route({ models, providers, thresholds, limits: limits(0, 0, 0, 0) }), 'trivial', 'mechanical');
  assert.equal(pick({}).via, 'haiku-worker');
  assert.equal(pick({ relayCost: { trivial: 0.000001 } }).via, 'haiku-worker');
  assert.equal(pick({ relayCost: { trivial: 0.000001 }, thinEvidenceFactor: 1 }).via, 'cli-worker:kilo-free');
});

const LEVELS = ['low', 'medium', 'high', 'xhigh'];
const codexFamily = { categories: ['implementation', 'mechanical'], models: {
  astra: { pool: 'codex', label: 'Astra', cost: 32, efforts: LEVELS, scores: { architecture: 9, review: 9, implementation: 9, mechanical: 8 } },
  sol: { pool: 'codex', label: 'Sol', cost: 5, efforts: LEVELS, scores: { architecture: 9, review: 8, implementation: 9, mechanical: 8 } },
  luna: { pool: 'codex', label: 'Luna', cost: 0.32, efforts: LEVELS, minEffort: 'high', scores: { architecture: 4, review: 4, implementation: 5, mechanical: 8 } }
} };
const viaOf = (result, model) => [...new Set(result.candidates.filter(c => c.model === model).map(c => c.via))];

test('only the boss is self, so an overqualified Codex boss hands work down to subagents', () => {
  const astra = route({ models: codexFamily, host: 'codex', bossModel: 'astra', limits: limits(0, 0, 0, 0) });
  assert.deepEqual(viaOf(astra, 'astra'), ['self']);
  assert.deepEqual(viaOf(astra, 'sol'), ['codex-subagent']);
  const normal = select(astra, 'normal', 'implementation');
  assert.deepEqual([normal.model, normal.via, normal.effort], ['sol', 'codex-subagent', 'low']);
  const trivial = select(astra, 'trivial', 'mechanical');
  assert.deepEqual([trivial.model, trivial.via, trivial.effort], ['luna', 'codex-subagent', 'high'], 'the vendor says to start Luna at high');
  assert.match(formatTable(astra), /Sol\(codex-subagent,low,model=sol\)/, 'the boss needs the exact id to spawn it');

  const sol = route({ models: codexFamily, host: 'codex', bossModel: 'sol', limits: limits(0, 0, 0, 0) });
  const own = select(sol, 'normal', 'implementation');
  assert.deepEqual([own.model, own.via, own.effort], ['sol', 'self', null], 'the boss cannot change its own effort per job');
});

test('without a reported boss the cheap near-best model is assumed, and an unregistered boss uses that default', () => {
  const unknown = route({ models: codexFamily, host: 'codex', limits: limits(0, 0, 0, 0) });
  assert.deepEqual(viaOf(unknown, 'sol'), ['self']);
  assert.deepEqual(viaOf(unknown, 'astra'), ['codex-subagent']);
  const other = route({ models: codexFamily, host: 'codex', bossModel: 'not-in-the-registry', limits: limits(0, 0, 0, 0) });
  assert.deepEqual(other.rows, unknown.rows);
  assert.match(other.note, /is not in the registry/);
});

test('a Sonnet boss sends the hardest work up to opus-worker, and Claude workers get an effort', () => {
  const models = { categories: ['architecture', 'implementation'], models: {
    'claude-opus-5-5': { pool: 'claude', label: 'Opus', agentModel: 'opus', cost: 10, efforts: LEVELS, scores: { architecture: 10, review: 10, implementation: 9 } },
    'claude-sonnet-5-5': { pool: 'claude', label: 'Sonnet', agentModel: 'sonnet', cost: 5, efforts: LEVELS, scores: { architecture: 8, review: 8, implementation: 9 } },
    'claude-haiku-5-5': { pool: 'claude', label: 'Haiku', agentModel: 'haiku', cost: 0.32, efforts: LEVELS, scores: { architecture: 5, review: 5, implementation: 6 } }
  } };
  const sonnet = route({ models, bossModel: 'claude-sonnet-5-5', limits: limits(0, 0, 0, 0) });
  assert.deepEqual(viaOf(sonnet, 'claude-opus-5-5'), ['opus-worker']);
  assert.deepEqual(viaOf(sonnet, 'claude-haiku-5-5'), ['haiku-worker']);
  const hard = select(sonnet, 'critical', 'architecture');
  assert.deepEqual([hard.model, hard.via, hard.effort], ['claude-opus-5-5', 'opus-worker', 'high']);
  assert.match(formatTable(sonnet), /opus-worker/);
  const easy = select(sonnet, 'trivial', 'implementation');
  assert.deepEqual([easy.model, easy.via, easy.effort], ['claude-haiku-5-5', 'haiku-worker', 'medium']);

  const unknown = route({ models, limits: limits(0, 0, 0, 0) });
  assert.deepEqual(viaOf(unknown, 'claude-opus-5-5'), ['self']);
  assert.equal(select(unknown, 'critical', 'architecture').effort, null);
});

test('a Claude model with no worker is usable only as the boss itself', () => {
  const models = { categories: ['implementation'], models: {
    'claude-opus-5-5': { pool: 'claude', label: 'Opus', agentModel: 'opus', cost: 10, scores: { architecture: 10, review: 10, implementation: 9 } },
    'claude-fable-5-2': { pool: 'claude', label: 'Fable', agentModel: 'fable', cost: 17, scores: { architecture: 10, review: 10, implementation: 10 } }
  } };
  const opus = route({ models, bossModel: 'claude-opus-5-5', limits: limits(0, 0, 0, 0) });
  assert.ok(opus.candidates.filter(c => c.model === 'claude-fable-5-2').every(c => c.reason === 'worker unavailable'));
  assert.deepEqual(viaOf(route({ models, limits: limits(0, 0, 0, 0) }), 'claude-opus-5-5'), ['self'], 'on a tie the cheaper model is the assumed boss');
  assert.deepEqual(viaOf(route({ models, bossModel: 'claude-fable-5-2', limits: limits(0, 0, 0, 0) }), 'claude-fable-5-2'), ['self']);
  const codexBoss = route({ models, host: 'codex', limits: limits(0, 0, 0, 0) });
  assert.ok(codexBoss.candidates.filter(c => c.model === 'claude-fable-5-2').every(c => c.reason === 'worker unavailable'), 'claude-worker cannot run Fable');
  assert.deepEqual(viaOf(codexBoss, 'claude-opus-5-5'), ['claude-worker']);
});

test('an Opus entry without agentModel still gets a worker under a weaker boss', () => {
  const models = { categories: ['architecture'], models: {
    'claude-opus-5-5': { pool: 'claude', label: 'Opus', cost: 10, scores: { architecture: 10, review: 10 } },
    'claude-sonnet-5-5': { pool: 'claude', label: 'Sonnet', cost: 5, scores: { architecture: 8, review: 8 } }
  } };
  assert.deepEqual(viaOf(route({ models, bossModel: 'claude-sonnet-5-5', limits: limits(0, 0, 0, 0) }), 'claude-opus-5-5'), ['opus-worker']);
});

test('measured effort costs apply only to the measured model and can be overridden', () => {
  const sol = 'gpt-6.1-sol';
  const pick = (thresholds = {}, id = sol) => select(route({ thresholds: { relayCost: { normal: 0.000001 }, ...thresholds }, limits: limits(0, 0, 0, 0),
    models: { categories: ['implementation'], models: { [id]: { pool: 'codex', label: 'M', cost: 1, scores: { implementation: 9 }, efforts: ['high'] } } } }), 'normal', 'implementation');
  const near = (a, b, ratio = 1) => assert.ok(Math.abs(a.utility / b.utility - ratio) < 0.001);
  near(pick(), pick({ effortCostByModel: { [sol]: { high: 1.65 } } }));
  near(pick({ effortCostByModel: { [sol]: { high: 2 } } }), pick({ effortCostByModel: { [sol]: { high: 4 } } }), 2);
  assert.equal(pick({ effortCost: { high: 9 } }).utility, pick().utility, 'the flat estimate does not replace a measured value');
  near(pick({ effortCostByModel: { [sol]: { high: 'bad' } } }), pick({ effortCostByModel: { [sol]: { high: 1.25 } } }));
  near(pick({}, 'other'), pick({ effortCost: { high: 1.25 } }, 'other'));
  near(pick({ effortCost: { high: 2 } }, 'other'), pick({ effortCost: { high: 4 } }, 'other'), 2);
});

test('effort scales the cost of a route and stays inside the levels a model declares', () => {
  const pick = (efforts, thresholds = {}, tier = 'normal') => select(route({ thresholds, limits: limits(0, 0, 0, 0),
    models: { categories: ['implementation'], models: { m: { pool: 'codex', label: 'M', cost: 1, scores: { implementation: 9 }, ...(efforts ? { efforts } : {}) } } } }), tier, 'implementation');
  const relay = { relayCost: { normal: 0.000001 } };
  const cheap = pick(LEVELS, { ...relay, effortCost: { low: 0.5 } }), dear = pick(LEVELS, { ...relay, effortCost: { low: 1 } });
  assert.equal(cheap.effort, 'low');
  assert.ok(Math.abs(cheap.utility / dear.utility - 2) < 0.001);
  assert.equal(pick(undefined, { ...relay, effortCost: { low: 0.5 } }).utility, pick(undefined, { ...relay, effortCost: { low: 1 } }).utility, 'models without metadata keep their plain cost');
  assert.equal(pick(['high']).effort, 'high');
  assert.equal(pick(['high']).ladder.length, 1);
  assert.equal(pick(['low', 'medium'], {}, 'critical').effort, 'medium', 'the strongest declared level when the wanted one is missing');
  assert.deepEqual(pick([...LEVELS, 'max', 'ultra'], {}, 'critical').ladder.map(step => step.effort), ['high', 'xhigh'], 'max and ultra are never routed');
});

test('the shipped registry keeps real prices and sends ordinary work to a capable model', () => {
  const registry = require('../config/models.json');
  const shipped = registry.models;
  assert.ok(shipped['gpt-6.1-sol'].cost / shipped['gpt-6-luna'].cost >= 15, 'Luna costs about a twentieth of Sol');
  assert.ok(shipped['gpt-6.1-sol'].cost < shipped['gpt-6-sol'].cost, 'the newer Sol is cheaper on cached input');
  assert.ok(shipped['gpt-5.6-sol'].cost > shipped['gpt-6.1-sol'].cost, 'the old Sol costs more than the new one');
  for (const [id, model] of Object.entries(shipped)) {
    if (model.pool !== 'claude' && model.pool !== 'codex') continue;
    assert.ok(Array.isArray(model.efforts) && !model.efforts.includes('max') && !model.efforts.includes('ultra'), id);
  }
  const boss = route({ models: registry, host: 'codex', bossModel: 'gpt-6-astra', limits: limits(0, 0, 0, 0) });
  assert.notEqual(select(boss, 'normal', 'implementation').model, 'gpt-6-astra');
  assert.notEqual(select(route({ models: registry, limits: limits(0, 0, 0, 0) }), 'normal', 'implementation').model, 'gpt-6-luna');
  assert.equal(select(boss, 'normal', 'implementation').via, 'codex-subagent', 'a Codex boss stays on its own plan');
  assert.equal(select(boss, 'trivial', 'mechanical').via, 'codex-subagent');
});

test('a Codex boss pays for a fresh Claude CLI but not the Claude boss surcharge on its own subagents', () => {
  const models = { categories: ['mechanical'], models: {
    boss: { pool: 'codex', label: 'Boss', cost: 32, scores: { architecture: 9, review: 9, mechanical: 8 } },
    small: { pool: 'codex', label: 'Small', cost: 1, scores: { architecture: 1, review: 1, mechanical: 8 } },
    'claude-haiku-5-5': { pool: 'claude', label: 'Haiku', agentModel: 'haiku', cost: 1, scores: { mechanical: 8 } }
  } };
  const pick = thresholds => route({ models, thresholds, host: 'codex', bossModel: 'boss', limits: limits(0, 0, 0, 0) }).candidates
    .filter(c => c.tier === 'trivial');
  const utility = (rows, model) => rows.find(c => c.model === model).utility;
  const rows = pick({ freshCliCost: { trivial: 1 }, bossFactor: 9 });
  assert.equal(rows.find(c => c.won).model, 'small');
  assert.ok(Math.abs(utility(rows, 'small') / utility(rows, 'claude-haiku-5-5') - 2) < 0.001, 'a Claude CLI job pays for its fresh start');
  assert.equal(utility(pick({ freshCliCost: { trivial: 1 }, bossFactor: 1 }), 'small'), utility(rows, 'small'), 'the boss surcharge is Claude-only');
});

test('a failed route escalates one step instead of jumping to the strongest model', () => {
  const models = { categories: ['mechanical'], models: {
    'gpt-5.6-luna': { pool: 'codex', label: 'Luna', cost: 0.5, scores: { mechanical: 7 } },
    'claude-haiku-5-5': { pool: 'claude', label: 'Haiku', agentModel: 'haiku', cost: 1, scores: { mechanical: 8 } },
    'claude-opus-5-5': { pool: 'claude', label: 'Opus', agentModel: 'opus', cost: 10, scores: { mechanical: 9 } }
  } };
  const row = select(route({ models, limits: limits(0, 0, 0, 0) }), 'normal', 'mechanical');
  assert.equal(row.model, 'gpt-5.6-luna');
  assert.equal(row.ladder.at(-1).model, 'claude-haiku-5-5');
});

test('emergency excludes Claude for normal and trivial and prefers qualified critical alternatives', () => {
  const result = route({ ...lib.loadConfig(), limits: limits(85, 0, 0, 0) });
  assert.equal(result.mode, 'emergency');
  assert.ok(result.rows.filter(row => row.tier !== 'critical').every(row => row.pool === 'codex'));
  // Score 9 is below the v2 critical probability floor; the boss may fall back to self.
  assert.equal(select(result, 'critical', 'architecture').pool, 'claude');
  const qualifying = route({ ...lib.loadConfig(), thresholds: { ...lib.loadConfig().thresholds, minP: { critical: 0.6 } }, limits: limits(85, 0, 0, 0) });
  assert.equal(select(qualifying, 'critical', 'architecture').pool, 'codex');
  assert.equal(select(result, 'critical', 'research').belowThreshold, true);
  const bossOnly = route({ ...lib.loadConfig(), limits: limits(85, 0, 0, 0), workers: { codex: false, gpt: false, perplexity: false } });
  assert.equal(bossOnly.rows.length, 6);
  assert.ok(bossOnly.rows.every(row => row.pool === 'claude' && row.tier === 'critical' && row.via === 'self'));
  assert.ok(bossOnly.rows.every(row => row.price === Infinity && row.utility === 0));
});

test('exhausted Codex is unavailable, including GPT opinions; worker switches follow categories', () => {
  const config = lib.loadConfig();
  const exhausted = route({ ...config, limits: limits(0, 0, 95, 0) });
  assert.ok(exhausted.rows.every(row => row.pool !== 'codex'));
  const advisors = route({ ...config, limits: limits(85, 0, 0, 0), workers: { codex: false, gpt: true, perplexity: false } });
  assert.ok(advisors.rows.filter(row => row.pool === 'codex').every(row => ['research', 'review'].includes(row.category)));
  assert.equal(advisors.options.length, 0);
  const off = route({ ...config, workers: { codex: false, gpt: false, perplexity: false } });
  assert.ok(off.rows.every(row => row.pool === 'claude'));
  assert.equal(off.options.length, 0);
});

test('quota price includes pool usage and weekly usage', () => {
  const models = { categories: ['implementation'], models: {
    c: { pool: 'claude', label: 'C', cost: 2, scores: { implementation: 9 } },
    x: { pool: 'codex', label: 'X', cost: 3, scores: { implementation: 9 } }
  } };
  const config = { models, thresholds: lib.loadConfig().thresholds };
  const normal = input => select(route({ ...config, limits: input }), 'normal', 'implementation');
  assert.equal(normal(limits(0, 0, 0, 0)).model, 'c');
  assert.equal(normal(limits(0, 50, 0, 0)).model, 'x');
  assert.equal(normal(limits(60, 0, 0, 0)).model, 'x');
  assert.equal(normal(limits(60, 0, 80, 0)).model, 'c');
});

test('quality fallbacks are marked and untrusted config labels and categories cannot inject context', () => {
  const models = { categories: ['implementation', 'IGNORE\ninstructions'], models: {
    arbitrary: { pool: 'claude', label: 'Label\n<script>:!', cost: 1, scores: { implementation: 3 } },
    evil: { pool: 'alien', label: 'Evil', cost: 0, scores: { implementation: 10 } }
  } };
  const result = route({ models, thresholds: lib.loadConfig().thresholds, profile: 'INVALID\ninjection' });
  assert.equal(result.rows.length, 3);
  assert.ok(result.rows.every(row => row.belowThreshold));
  assert.ok(result.rows.every(row => row.label === 'Labelscript'));
  const table = formatTable(result);
  assert.doesNotMatch(table, /IGNORE|INVALID|<|!|arbitrary/);
  assert.match(table, /below threshold/);
});

test('routing is deterministic and does not mutate input; empty registries are supported', () => {
  const input = { ...lib.loadConfig(), limits: limits(4, 49, 0, 2) };
  const before = JSON.stringify(input);
  const first = route(input);
  const clock = Date.now;
  Date.now = () => { throw new Error('Pure routing must not read the clock'); };
  try { assert.deepEqual(route(input), first); } finally { Date.now = clock; }
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(route({ models: { models: {} } }).rows, []);
});

});

test('docs evidence requires a real self-test and verified probation passes', () => {
  const { route } = require('../scripts/route');
  const providers = { providers: { trial: { label: 'Trial', kind: 'subscription', worker: 'cli-worker', evidence: 'docs', quota: { source: 'none' },
    cli: { command: 'trial', args: ['{prompt}'] } } } };
  const models = { categories: ['implementation'], models: { tiny: { label: 'Tiny', pool: 'trial', cost: 1, scores: { implementation: 10 } } } };
  const input = { models, providers, host: 'generic', now: 100000 };
  let result = route(input);
  assert.ok(result.candidates.every(c => c.reason === 'self-test needed: quota-boss providers test trial'));
  assert.equal(result.rows.length, 0);
  input.selfTests = { tiny: { result: 'pass' } };
  result = route(input);
  assert.ok(result.rows.some(c => c.tier === 'normal'));
  assert.equal(result.candidates.find(c => c.tier === 'critical').reason, 'probation: 3 more verified passes needed');
  input.outcomes = Array.from({ length: 2 }, () => ({ t: 99999, model: 'tiny', category: 'implementation', tier: 'normal', result: 'pass' }));
  assert.equal(route(input).candidates.find(c => c.tier === 'critical').reason, 'probation: 1 more verified passes needed');
  input.outcomes.push({ ...input.outcomes[0] });
  assert.ok(route(input).rows.some(c => c.tier === 'critical'));
  input.thresholds = { probationPasses: 4 };
  assert.equal(route(input).candidates.find(c => c.tier === 'critical').reason, 'probation: 1 more verified passes needed');
  delete providers.providers.trial.evidence; delete input.selfTests;
  input.outcomes = [];
  assert.ok(route(input).rows.some(c => c.tier === 'critical'));
  providers.providers.trial.evidence = 'real';
  assert.ok(route(input).rows.some(c => c.tier === 'critical'));
});

const { route, formatTable, projectWindow, successProbability, formatExplain } = require('../scripts/route');
const clock = 1000000000;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
function projection(W, L, used, thresholds = {}, rate = 0.1) {
  const history = [{ t: clock - 120 * 60000, uw: Math.max(0, used - rate * 120) }, { t: clock, uw: used }];
  return projectWindow({ used_percent: used, resets_at: clock / 1000 + L * 60, window_minutes: W },
    'used_percent', history, 'uw', clock, W, thresholds);
}

test('weekly projections blend recent pace with a trusted window average', () => {
  const weekly = projection(10080, 7200, 23);
  near(weekly.projected, 23 + 30 + 23 / 2880 * 6900);
  near(weekly.pressure, 0.3110416666666667);
  near(projection(300, 180, 23).projected, 23 + 0.1 * 180);
  near(projection(10080, 9840, 5, {}, 0.01).projected, 5 + 3 + 5 / 240 * 9540 * (240 / 1440));
  near(projection(10080, 200, 23).projected, 23 + 20);
  near(projection(10080, 7200, 23, { history: { paceHorizonMinutes: 60 } }).projected, 23 + 6 + 23 / 2880 * 7140);
  for (const [value, bounded] of [[-1, 5], [2000, 1440]]) {
    near(projection(10080, 7200, 23, { history: { paceHorizonMinutes: value } }).projected,
      projection(10080, 7200, 23, { history: { paceHorizonMinutes: bounded } }).projected);
    assert.equal(lib.historySettings({ history: { paceHorizonMinutes: value } }).paceHorizonMinutes, bounded);
  }
  near(projection(10080, 7200, 0).projected, 0);
  near(projection(10080, 7200, 23, {}, 0).projected, 23 + 23 / 2880 * 6900);
});

function effortCandidate({ category = 'architecture', tier = 'normal', thresholds = {}, outcomes = [], efforts = LEVELS_FOR_TEST,
  pool = 'codex', providers } = {}) {
  return route({ models: { categories: [category], models: { worker: { pool, label: 'Worker', cost: 1, efforts,
    scores: { architecture: 10, implementation: 10 } } } }, thresholds, outcomes, providers, now: clock })
    .candidates.find(c => c.tier === tier);
}
const LEVELS_FOR_TEST = ['low', 'medium', 'high', 'xhigh'];
const learnedAt = (result, effort, extra = {}) => ({ t: clock, model: 'worker', category: 'architecture', tier: 'normal', result, effort, ...extra });

test('category effort floors respect overrides, declared levels and CLI capabilities', () => {
  assert.equal(effortCandidate().effort, 'medium');
  assert.equal(effortCandidate({ category: 'implementation' }).effort, 'low');
  for (const [value, expected] of [['high', 'high'], ['low', 'low'], ['invalid', 'low']])
    assert.equal(effortCandidate({ thresholds: { minEffort: { architecture: value } } }).effort, expected);
  assert.equal(effortCandidate({ efforts: ['high'] }).effort, 'high');
  const providers = { providers: { trial: { label: 'Trial', kind: 'subscription', worker: 'cli-worker', cli: { command: 'trial', args: ['{prompt}'] }, quota: { source: 'none' } } } };
  assert.equal(effortCandidate({ pool: 'trial', providers }).effort, null);
});

test('effort learning raises only levels with repeated excess failures', () => {
  const fails = [learnedAt('fail', 'medium'), learnedAt('fail', 'medium')];
  assert.equal(effortCandidate({ outcomes: fails.slice(0, 1) }).effort, 'medium');
  assert.equal(effortCandidate({ outcomes: fails }).effort, 'high');
  assert.equal(effortCandidate({ outcomes: [...fails, learnedAt('pass', 'medium'), learnedAt('pass', 'medium')] }).effort, 'medium');
  const chain = [...fails, ...['high', 'xhigh'].flatMap(level => [learnedAt('fail', level), learnedAt('fail', level)])];
  assert.equal(effortCandidate({ outcomes: chain }).effort, 'xhigh');
  assert.equal(effortCandidate({ outcomes: fails, efforts: ['medium'] }).effort, 'medium');
  assert.equal(effortCandidate({ outcomes: [learnedAt('pass', 'low'), learnedAt('pass', 'low')] }).effort, 'medium');
  for (const extra of [{ tier: 'trivial' }, { category: 'implementation' }])
    assert.equal(effortCandidate({ outcomes: fails.map(e => ({ ...e, ...extra })) }).effort, 'medium');
});

test('success probability weights outcomes by candidate effort and direction', () => {
  const model = { id: 'worker', scores: { architecture: 8 } };
  const prior = successProbability(model, 'architecture', 'normal', [], {}, clock);
  for (const [result, level, weight] of [['fail', 'low', 0.5], ['fail', 'high', 1], ['pass', 'high', 0.5],
    ['pass', 'low', 1], ['fail', 'medium', 1], ['pass', undefined, 1], ['fail', 'unknown', 1]]) {
    const expected = result === 'pass' ? (prior * 6 + weight) / (6 + weight) : prior * 6 / (6 + 2 * weight);
    near(successProbability(model, 'architecture', 'normal', [learnedAt(result, level)], {}, clock, 'medium'), expected);
    const full = result === 'pass' ? (prior * 6 + 1) / 7 : prior * 6 / 8;
    near(successProbability(model, 'architecture', 'normal', [learnedAt(result, level)], {}, clock, null), full);
  }
});

function thinRoute(outcomes = [], thresholds = {}) {
  const providers = { providers: { ...lib.BUILTIN_PROVIDERS.providers,
    trial: { label: 'Trial', kind: 'subscription', worker: 'cli-worker', cli: { command: 'trial', args: ['{prompt}'] }, quota: { source: 'none' } } } };
  const models = { categories: ['implementation'], models: {
    free: { pool: 'trial', label: 'Free', cost: 0, scores: { implementation: 8 } },
    haiku: { pool: 'claude', agentModel: 'haiku', label: 'Haiku', cost: 0.25, scores: { implementation: 8 } },
    codex: { pool: 'codex', label: 'Codex', cost: 100, scores: { implementation: 8 } }
  } };
  return route({ models, providers, outcomes, thresholds: { relayCost: { trivial: 0.047 }, ...thresholds }, now: clock });
}
const freeCandidate = result => result.candidates.find(c => c.model === 'free' && c.tier === 'trivial');
const trivialWinner = result => result.rows.find(c => c.tier === 'trivial').model;
const freePass = extra => learnedAt('pass', undefined, { model: 'free', category: 'research', tier: 'critical', ...extra });

test('thin evidence discounts estimated pools until verified passes across categories accumulate', () => {
  const plain = thinRoute([], { thinEvidenceFactor: 1 });
  const lead = freeCandidate(plain).utility / plain.candidates.find(c => c.model === 'haiku' && c.tier === 'trivial').utility;
  assert.ok(lead > 1.15 && lead < 1.20);
  for (const count of [0, 2, 3]) {
    const result = thinRoute(Array.from({ length: count }, () => freePass()));
    assert.equal(trivialWinner(result), count < 3 ? 'haiku' : 'free');
    assert.equal(freeCandidate(result).thinEvidence, count < 3);
    assert.ok(result.candidates.filter(c => ['claude', 'codex'].includes(c.pool)).every(c => !c.thinEvidence));
  }
  for (const result of ['fail', 'unavailable', 'limited']) {
    const outcomes = Array.from({ length: 3 }, () => freePass({ result }));
    assert.equal(freeCandidate(thinRoute(outcomes)).thinEvidence, true);
  }
  assert.equal(trivialWinner(plain), 'free');
  near(freeCandidate(thinRoute([], { thinEvidenceFactor: -1 })).utility, freeCandidate(plain).utility * 0.1);
  near(freeCandidate(thinRoute([], { thinEvidenceFactor: 5 })).utility, freeCandidate(plain).utility);
  near(freeCandidate(thinRoute()).utility, freeCandidate(plain).utility * 0.75);
  assert.match(formatExplain(thinRoute()), /Free[^\n]* \| thin evidence(?:\n|$)/);
  assert.doesNotMatch(formatTable(thinRoute()), /thin evidence/);
  assert.equal(freeCandidate(thinRoute([freePass()], { probationPasses: 1 })).thinEvidence, false);
});
