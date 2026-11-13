'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { check, format, command } = require('../scripts/free-models');
const { PRESETS } = require('../scripts/add-api');
const zero = { cost: { input: 0, output: 0 } };
const paid = { cost: { input: 1, output: 2 } };
const offer = (id, extra = {}) => ({ id, pricing: { prompt: '0', completion: '0' }, context_length: 64000, supported_parameters: ['tools'], ...extra });

test('preset status, account tiers, extra models and first slash splitting', () => {
  const presets = { keyless: { model: 'opencode/a', keyless: true }, suffix: { model: 'openrouter/nvidia/a:free' },
    account: { model: 'nvidia/nvidia/a', extraModels: [{ suffix: 'extra', model: 'nvidia/extra' }] } };
  const dev = { opencode: { models: { a: paid } }, openrouter: { models: { 'nvidia/a:free': zero } }, nvidia: { models: { 'nvidia/a': paid } } };
  assert.deepEqual(check(presets, dev).presets.map(row => row.status), ['not free', 'ok', 'ok', 'missing']);
  assert.equal(check(presets, dev).presets[3].id, 'account-extra');
  assert.equal(check({ a: { model: 'opencode/a', keyless: true } }, { opencode: { models: { a: zero } } }).attention, 0);
  const router = { data: [offer('nvidia/a:free', { pricing: { prompt: '0.01', completion: '0' } })] };
  assert.equal(check(presets, dev, router).presets[1].status, 'not free');
  assert.equal(check(presets, {}, { data: [offer('nvidia/a:free')] }).presets[1].status, 'ok');
  assert.equal(check(presets, dev, { data: [] }).presets[1].status, 'ok');
  const charged = { openrouter: { models: { 'nvidia/a:free': paid } } };
  assert.equal(check(presets, charged).presets[1].status, 'not free');
  assert.equal(check(presets, charged, { data: [offer('nvidia/a:free')] }).presets[1].status, 'ok');
});

test('candidate filters exclude paid, short, tool-less and covered models', () => {
  const dev = { opencode: { models: { yes: zero, paid, covered: zero, unknown: {}, string: { cost: { input: '0', output: '0' } } } }, other: { models: { no: zero } } };
  const router = { data: [offer('yes:free'), offer('covered:free'), offer('paid:free', { pricing: { prompt: '1', completion: '0' } }),
    offer('short:free', { context_length: 63999 }), offer('no-tools:free', { supported_parameters: [] }), offer('plain'),
    offer('invalid:free', { pricing: { prompt: '', completion: '0' } }), offer('string:free', { context_length: '64000' })] };
  const result = check({ a: { model: 'opencode/covered' }, b: { model: 'openrouter/covered:free' } }, dev, router);
  assert.deepEqual(result.zen.map(row => row.model), ['opencode/yes']);
  assert.deepEqual(result.openrouter.map(row => row.model), ['openrouter/yes:free']);
});

test('sort, cap and sanitize all printed fields', () => {
  const models = Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['m' + String(i).padStart(2, '0'), { ...zero, limit: { context: 64000 } }]));
  models['bad\n`\u001b'] = { ...zero, limit: { context: 128000 } };
  models['z'.repeat(200)] = zero;
  const result = check({ 'bad\n`': { model: 'missing/evil\n`\u0000' } }, { opencode: { models } }, { data: Array.from({ length: 17 }, (_, i) => offer('m' + i + ':free')) });
  assert.equal(result.zen[0].context, 128000);
  assert.equal(result.zen[1].model, 'opencode/m00');
  const text = format(result);
  assert.match(text, /opencode\/bad\?\?\?/);
  assert.match(text, /\(4 more\)/);
  assert.match(text, /\(2 more\)/);
  assert.doesNotMatch(text, /[`\u001b\u0000]/);
  assert.match(text, /bad\?\? missing\/evil\?\?\?/);
  assert.ok(format(check({}, { opencode: { models: { ['z'.repeat(200)]: zero } } })).includes('opencode/' + 'z'.repeat(111) + '  0k ctx'));
});

test('malformed entries are ignored without crashing', () => {
  for (const dev of [null, [], { opencode: null }, { opencode: { models: [] } }, { opencode: { models: { a: null, b: [], c: 1 } } }]) {
    assert.equal(check({ bad: null, a: { model: 42, extraModels: [null] } }, dev, { data: [null, 1, [], { id: 3 }] }).zen.length, 0);
  }
});

test('local file errors, size ceiling, command codes and CLI dispatch', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-free-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, value); return file; };
  const empty = write('empty.json', '{}');
  const bad = write('bad.json', '{');
  const nonobject = write('array.json', '[]');
  const router = write('router.json', '{"data":[]}');
  for (const args of [[], [empty, empty, empty], [path.join(dir, 'missing')], [bad], [nonobject], [empty, empty], [empty, nonobject]]) {
    const result = command(args);
    assert.equal(result.code, 2);
    assert.equal(result.text.split('\n').length, 1);
  }
  const big = write('big.json', '');
  fs.truncateSync(big, 50 * 1024 * 1024 + 1);
  assert.equal(command([big]).code, 2);
  const dev = {};
  for (const preset of Object.values(PRESETS)) {
    for (const entry of [preset, ...(preset.extraModels || [])]) {
      const slash = entry.model.indexOf('/'), provider = entry.model.slice(0, slash), id = entry.model.slice(slash + 1);
      (dev[provider] ||= { models: {} }).models[id] = zero;
    }
  }
  const full = write('full.json', JSON.stringify(dev));
  assert.equal(command([full, router]).code, 0);
  assert.equal(command([empty]).code, 1);
  for (const [args, code] of [[[full, router], 0], [[empty], 1], [[], 2], [[bad], 2]]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/quota-boss.js'), 'free-models', ...args], { encoding: 'utf8' });
    assert.equal(result.status, code, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /\n\s+at /);
    if (!code) assert.match(result.stdout, /All free presets are still listed\./);
  }
});

test('checker has no network imports or fetch calls', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/free-models.js'), 'utf8');
  assert.doesNotMatch(source, /require\s*\(\s*['"](?:node:)?(?:http|https|net)['"]|\bfetch\s*\(/);
});
