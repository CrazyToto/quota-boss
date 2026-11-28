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
const zenFree = { ...zero, tool_call: true };
const paid = { cost: { input: 1, output: 2 } };
const offer = (id, extra = {}) => ({ id, pricing: { prompt: '0', completion: '0' }, context_length: 64000, supported_parameters: ['tools'], ...extra });
const recent = (release_date, extra = {}) => ({ ...paid, tool_call: true, release_date, limit: { context: 128000 }, ...extra });

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

test('a deprecated preset is retired and counts as needing attention', () => {
  const presets = { zen: { model: 'opencode/old', keyless: true } };
  const result = check(presets, { opencode: { models: { old: { ...paid, status: 'deprecated' } } } });
  assert.deepEqual(result.presets, [{ id: 'zen', model: 'opencode/old', status: 'retired' }]);
  assert.equal(result.attention, 1);
  assert.match(format(result), /retired\s+zen opencode\/old/);
});

test('candidate filters exclude paid, short, tool-less and covered models', () => {
  const dev = { opencode: { models: { yes: zenFree, paid: { ...paid, tool_call: true }, covered: zenFree,
    retired: { ...zenFree, status: 'deprecated' }, noTools: zero, falseTools: { ...zero, tool_call: false },
    stringTools: { ...zero, tool_call: 'true' }, unknown: {}, string: { tool_call: true, cost: { input: '0', output: '0' } } } }, other: { models: { no: zero } } };
  const router = { data: [offer('yes:free'), offer('covered:free'), offer('paid:free', { pricing: { prompt: '1', completion: '0' } }),
    offer('short:free', { context_length: 63999 }), offer('no-tools:free', { supported_parameters: [] }), offer('plain'),
    offer('invalid:free', { pricing: { prompt: '', completion: '0' } }), offer('string:free', { context_length: '64000' })] };
  const result = check({ a: { model: 'opencode/covered' }, b: { model: 'openrouter/covered:free' } }, dev, router);
  assert.deepEqual(result.zen.map(row => row.model), ['opencode/yes']);
  assert.deepEqual(result.openrouter.map(row => row.model), ['openrouter/yes:free']);
});

test('new routing models filter by table coverage, date, capabilities, name and vendor', () => {
  const model = recent('2026-11-28');
  const dev = {
    openai: { models: { 'GPT-6-2-SOL': model, newest: model, old: recent('2026-07-30'),
      edge: recent('2026-07-31'), future: recent('2026-11-29'), invalid: recent('2026-09-31'),
      timestamp: recent('2026-11-28T00:00:00Z'), deprecated: { ...model, status: 'deprecated' },
      noTools: { ...model, tool_call: false }, malformed: null,
      ...Object.fromEntries('LATEST healthcare preview image video audio tts embedding realtime search'.split(' ').map(suffix => ['new-' + suffix, model])) } },
    xai: { models: { 'grok-build-0-1': model } },
    deepseek: { models: { 'swe.2.1': model, 'swe-2-1-medium': model, 'swe-2-flash': model, fresh: recent('2026-08-01') } },
    other: { models: { ignored: model } }
  };
  const result = check({}, dev, undefined, Date.UTC(2026, 10, 28, 12));
  assert.deepEqual(result.newModels.map(row => row.model), ['openai/newest', 'deepseek/fresh', 'openai/edge']);
  assert.equal(result.attention, 0);
  assert.match(format(result), /New models not in the routing table\n  openai\/newest  2026-11-28  1\/2 \$\/M  128k ctx/);
});

test('new routing model report sanitizes ids and shows at most 25 rows', () => {
  const models = Object.fromEntries(Array.from({ length: 26 }, (_, i) => ['model-' + i, recent('2026-11-27')]));
  models['bad\n`'] = recent('2026-11-28', { cost: { input: 'invalid', output: 0 } });
  const result = check({}, { google: { models } }, undefined, Date.UTC(2026, 10, 28));
  assert.equal(result.newModels.length, 27);
  const output = format(result);
  assert.match(output, /google\/bad\?\?  2026-11-28  \?\/0 \$\/M  128k ctx/);
  assert.equal(output.match(/^  google\//gm).length, 25);
  assert.match(output, /\(2 more\)/);
});

test('sort, cap and sanitize all printed fields', () => {
  const models = Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['m' + String(i).padStart(2, '0'), { ...zenFree, limit: { context: 64000 } }]));
  models['bad\n`\u001b'] = { ...zenFree, limit: { context: 128000 } };
  models['z'.repeat(200)] = zenFree;
  const result = check({ 'bad\n`': { model: 'missing/evil\n`\u0000' } }, { opencode: { models } }, { data: Array.from({ length: 17 }, (_, i) => offer('m' + i + ':free')) });
  assert.equal(result.zen[0].context, 128000);
  assert.equal(result.zen[1].model, 'opencode/m00');
  const text = format(result);
  assert.match(text, /opencode\/bad\?\?\?/);
  assert.match(text, /\(4 more\)/);
  assert.match(text, /\(2 more\)/);
  assert.doesNotMatch(text, /[`\u001b\u0000]/);
  assert.match(text, /bad\?\? missing\/evil\?\?\?/);
  assert.ok(format(check({}, { opencode: { models: { ['z'.repeat(200)]: zenFree } } })).includes('opencode/' + 'z'.repeat(111) + '  0k ctx'));
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
  (dev.openai ||= { models: {} }).models['fixture-new-model'] = recent(new Date().toISOString().slice(0, 10));
  const full = write('full.json', JSON.stringify(dev));
  assert.equal(command([full, router]).code, 0);
  assert.match(command([full, router]).text, /openai\/fixture-new-model/);
  assert.equal(command([empty]).code, 1);
  for (const [args, code] of [[[full, router], 0], [[empty], 1], [[], 2], [[bad], 2]]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../tools/free-models.js'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, code, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /\n\s+at /);
    if (!code) assert.match(result.stdout, /All free presets are still listed\./);
  }
});

test('checker has no network imports or fetch calls', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/free-models.js'), 'utf8');
  assert.doesNotMatch(source, /require\s*\(\s*['"](?:node:)?(?:http|https|net)['"]|\bfetch\s*\(/);
});
