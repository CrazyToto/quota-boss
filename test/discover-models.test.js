'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { discover, parseDevin, parseTabList, parseKilo, parseCodex, selectedModel, matches } = require('../scripts/discover-models');

const config = () => ({
  providers: { providers: {
    devin: { cli: { command: 'devin', args: ['--model', 'swe-2-flash-medium', '-p', '{prompt}'] } },
    antigravity: { cli: { command: 'agy', args: ['-p', '{prompt}', '--model', '{model}-{effort}'] } },
    copilot: { cli: { command: 'copilot', args: ['-p', '{prompt}'] } },
    'kilo-free': { cli: { command: 'kilo', args: ['-m', 'kilo/kilo-auto/free'] } },
    codex: {},
  } },
  models: { models: {
    flash: { pool: 'devin' },
    swe21: { pool: 'devin', cliModel: 'swe-2-1-medium', enabled: false },
    gone: { pool: 'devin', cliModel: 'swe-9' },
    goneOff: { pool: 'devin', cliModel: 'swe-8', enabled: false },
    argon: { pool: 'antigravity', cliModel: 'gemini-4-argon' },
    hydrogen: { pool: 'antigravity', cliModel: 'gemini-4-hydrogen', enabled: false },
    'kilo-free': { pool: 'kilo-free' },
    'gpt-6.2-sol': { pool: 'codex', enabled: false },
    'gpt-6.2-astra': { pool: 'codex' },
  } },
});
const devinJson = JSON.stringify({ families: [
  { variants: [{ model_uid: 'swe-2-flash-medium', cost_summary: '' }, { model_uid: 'swe-2-flash-max-lightning', cost_summary: '$1 / 1M Input' }] },
  { variants: [{ model_uid: 'swe-2-1-medium', cost_summary: '$2 / 1M Input' }, { model_uid: 'swe-2-1-high', cost_summary: '$2 / 1M Input' }] },
  { variants: [{ model_uid: 'kimi-k3-1-pro-high', cost_summary: 'Free' }, { model_uid: '../bad id' }, null] },
] });
const run = stdout => () => ({ status: 0, stdout });
const kiloText = `kilo/amazon/nova-pro
{
  "id": "amazon/nova-pro",
  "status": "active",
  "cost": {
    "input": 0.7999999999999999,
    "output": 3.1999999999999997
  }
}
kilo/kilo-auto/free
{
  "id": "kilo-auto/free",
  "status": "active",
  "cost": {
    "input": 0,
    "output": 0
  }
}
kilo/old
{
  "status": "deprecated"
}
kilo/future
{
  "cost": { "input": 0 }
}
`.replace(/\n/g, '\r\n');
const codexJson = '{"models":[{"slug":"gpt-6.2-sol","visibility":"list"},{"slug":"gpt-6.2-astra","visibility":"hide"},{"slug":"bad id","visibility":"list"}]}';

test('Kilo parses verbose CRLF blocks and uses the full slug for table matching', () => {
  assert.deepEqual(parseKilo(kiloText), [
    { id: 'kilo/amazon/nova-pro', billing: 'per-token' },
    { id: 'kilo/kilo-auto/free', billing: 'included' },
    { id: 'kilo/future', billing: 'unknown' },
  ]);
  assert.deepEqual(parseKilo('x/free\n{\n}\npriced\n{\n  "cost": {"input":"0","output":0}\n}\nkilo/kilo-auto/frontier\n{\n  "cost": {"input":0,"output":0}\n}\n').map(m => m.billing),
    ['included', 'per-token', 'unknown'], 'a zero-price router is not free');
  const { rows, text } = discover('kilo-free', { config: config(), find: c => c, run: (exe, args) => {
    assert.equal(exe, 'kilo');
    assert.deepEqual(args, ['models', 'kilo', '--verbose']);
    return { status: 0, stdout: kiloText };
  } });
  assert.deepEqual(rows.routed.map(r => r.id), ['kilo-free']);
  assert.deepEqual(rows.unknown, ['kilo/amazon/nova-pro', 'kilo/future']);
  assert.deepEqual(rows.unknownIncluded, []);
  assert.match(text, /new, priced \(needs your OK and a table entry\): 1 models$/m);
});

test('Codex lists only visible slugs and matches table IDs without a CLI model', () => {
  assert.deepEqual(parseCodex(codexJson), [{ id: 'gpt-6.2-sol', billing: 'included' }]);
  const { rows } = discover('codex', { config: config(), find: c => c, run: (exe, args) => {
    assert.equal(exe, 'codex');
    assert.deepEqual(args, ['debug', 'models']);
    return { status: 0, stdout: codexJson };
  } });
  assert.deepEqual(rows.off.map(r => r.id), ['gpt-6.2-sol']);
  assert.deepEqual(rows.missing.map(r => r.id), ['gpt-6.2-astra']);
  assert.deepEqual(rows.unknown, []);
});

test('Devin JSON: a price means per-token, none or Free means included, bad ids are dropped', () => {
  assert.deepEqual(parseDevin(devinJson).map(m => m.id + ':' + m.billing), ['swe-2-flash-medium:included', 'swe-2-flash-max-lightning:per-token',
    'swe-2-1-medium:per-token', 'swe-2-1-high:per-token', 'kimi-k3-1-pro-high:included']);
  assert.deepEqual(parseDevin('{}'), []);
  assert.throws(() => parseDevin('not json'));
  const priced = { families: [{ variants: [{ model_uid: 'a', cost_summary: { per_token: 1 } }, { model_uid: 'b', cost_summary: null }] }] };
  assert.deepEqual(parseDevin(JSON.stringify(priced)).map(m => m.billing), ['per-token', 'included'], 'a price in another shape still counts');
});

test('Antigravity tab list skips the status line and duplicates', () => {
  const text = 'Fetching available models...\r\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\ngemini-4-hydrogen-high\tdup\nclaude-opus-4-6-thinking\tClaude\n';
  assert.deepEqual(parseTabList(text).map(m => m.id), ['gemini-4-hydrogen-high', 'claude-opus-4-6-thinking']);
});

test('the CLI model of an entry comes from cliModel or a fixed --model argument, never a template', () => {
  assert.equal(selectedModel({ cliModel: 'x' }, {}), 'x');
  assert.equal(selectedModel({}, { args: ['--model', 'swe-2-flash-medium'] }), 'swe-2-flash-medium');
  assert.equal(selectedModel({}, { args: ['--model={model}'] }), null);
  assert.equal(selectedModel({}, { args: ['--model=fixed'] }), 'fixed');
  assert.equal(matches('gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen'), true);
  assert.equal(matches('gemini-4-hydrogen-lite', 'gemini-4-hydrogen'), false);
});

test('the report sorts table models into routed, off and missing and names the rest by family', () => {
  const { rows, text } = discover('devin', { config: config(), run: run(devinJson), find: () => 'devin' });
  assert.deepEqual(rows.routed.map(r => r.id + ':' + r.billing), ['flash:included']);
  assert.deepEqual(rows.off.map(r => r.id + ':' + r.billing), ['swe21:per-token']);
  assert.deepEqual(rows.missing.map(r => r.id), ['gone', 'goneOff']);
  assert.match(text, /missing +goneOff \(swe-8\): not offered to this account$/m);
  assert.match(text, /off +swe21 \(swe-2-1-medium, priced per token\): quota-boss use swe21 on, if your plan includes it/);
  assert.match(text, /missing +gone .*quota-boss use gone off/);
  assert.deepEqual(rows.unknown, ['kimi-k3-1-pro-high']);
  assert.deepEqual(rows.unknownIncluded, ['kimi-k3-1-pro-high']);
  assert.match(text, /new, included in your plan: kimi-k3-1-pro$/m);
  const agy = discover('antigravity', { config: config(), run: run('gemini-4-hydrogen-high\tH\n'), find: () => 'agy' });
  assert.deepEqual([agy.rows.off.map(r => r.id), agy.rows.missing.map(r => r.id)], [['hydrogen'], ['argon']]);
});

test('a provider without a list command, a failed run or unreadable output gives a short error', () => {
  assert.throws(() => discover('copilot', { config: config(), run: run(''), find: () => 'copilot' }), /no command that lists/);
  assert.throws(() => discover('devin', { config: config(), run: () => ({ status: 1, stdout: '' }), find: () => 'devin' }), /devin models list failed \(exit 1\)\. Is the CLI installed and signed in\?/);
  assert.throws(() => discover('devin', { config: config(), run: () => ({ status: null, error: new Error('ENOENT') }), find: () => null }), /failed: ENOENT/);
  assert.throws(() => discover('devin', { config: config(), run: run('<html>'), find: () => 'devin' }), /cannot read/);
  for (const [id, bad] of [['kilo-free', 'kilo/bad\n{\n  invalid\n}\n'], ['codex', '{"models":']]) {
    assert.throws(() => discover(id, { config: config(), run: run(bad), find: c => c }), /printed something Quota Boss cannot read/);
  }
  assert.match(discover('devin', { config: config(), run: run('{}'), find: () => 'devin' }).text, /missing/);
});

test('cli-run never runs an off model and picks the single on model without --model', () => {
  const { selection } = require('../scripts/cli-run');
  const cfg = { providers: { providers: { devin: { cli: { command: 'devin', args: ['--model', 'swe-2-flash-medium', '-p', '{prompt}'] } } } },
    models: { models: { flash: { pool: 'devin' }, paid: { pool: 'devin', cliModel: 'swe-2-1-medium', enabled: false } } } };
  assert.throws(() => selection({ provider: 'devin', model: 'paid' }, cfg, {}), /Model paid is off\. Turn it on with quota-boss use paid on/);
  assert.doesNotThrow(() => selection({ provider: 'devin' }, cfg, {}));
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const { refresh, refreshIfStale, planState, parseDevinPlan, changeLines } = require('../scripts/discover-models');
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-plans-')), 'plan-models.json');
const status = plan => 'Logged in (via Devin).\n\nUser:\n  Email:             someone@example.com\n\nAccount:\n  Tier:              Devin ' + plan + '\n  Plan:              ' + plan + '\n';
const devinRun = plan => (exe, args) => ({ status: 0, stdout: args[0] === 'auth' ? status(plan) : devinJson });

test('the Devin plan comes only from the Plan line', () => {
  assert.equal(parseDevinPlan(status('Free')), 'free');
  assert.equal(parseDevinPlan(status('Pro')), 'paid');
  assert.equal(parseDevinPlan(status('Teams')), 'paid');
  for (const plan of ['Trial', 'Pro Trial', 'Expired', 'None', '-', 'Pro (cancelled)']) assert.equal(parseDevinPlan(status(plan)), null, plan);
  assert.equal(parseDevinPlan('Email: plan@x.com\nTier: Free'), null);
  assert.equal(parseDevinPlan(''), null);
});

test('every plan turns on only the listed models without a price', () => {
  const cfg = config();
  const listed = JSON.parse(JSON.stringify(require('../scripts/discover-models').parseDevin(devinJson)));
  assert.deepEqual(planState('devin', listed, 'free', cfg), { plan: 'free', on: ['flash'], off: ['gone', 'goneOff', 'swe21'] });
  assert.deepEqual(planState('devin', listed, null, cfg), { on: ['flash'], off: ['gone', 'goneOff', 'swe21'] });
  assert.deepEqual(planState('devin', listed, 'paid', cfg), { plan: 'paid', on: ['flash'], off: ['gone', 'goneOff', 'swe21'] });
  assert.equal(planState('devin', [{ id: 'other-model', billing: 'included' }], 'paid', cfg), null);
  // Unknown billing stays off for any lister that does not vouch that its list holds only the plan's models.
  assert.deepEqual(planState('devin', [{ id: 'swe-2-flash-medium', billing: 'unknown' }], 'paid', cfg).on, []);
});

test('refresh stores each provider, reports what changed and keeps the old state when a CLI fails', () => {
  const file = tempFile(), use = lib.normalizeUse({});
  const agyRun = (exe, args) => ({ status: 0, stdout: 'gemini-4-hydrogen-high\tH\n' });
  const run = (exe, args) => exe === 'agy' ? agyRun(exe, args) : devinRun('Pro')(exe, args);
  const first = refresh({ config: config(), run, find: command => ['devin', 'agy'].includes(command) ? command : null, file, use, now: 1000 });
  assert.deepEqual(first.changes.map(c => c.provider + ':' + c.plan + ':' + c.on.join(',') + ':' + c.off.join(',')),
    ['devin:paid:flash:gone,goneOff,swe21', 'antigravity:null:hydrogen:argon']);
  assert.deepEqual(changeLines(first.changes), ['devin (paid plan): on flash; off gone, goneOff, swe21; new in your plan, not routed yet: kimi-k3-1-pro', 'antigravity: on hydrogen; off argon']);
  const saved = lib.readPlanModels(file);
  assert.equal(saved.checkedAt, 1000);
  assert.deepEqual(saved.providers.devin, { plan: 'paid', on: ['flash'], off: ['gone', 'goneOff', 'swe21'], new: ['kimi-k3-1-pro'] });
  const failing = refresh({ config: config(), run: (exe, args) => exe === 'agy' ? { status: 1, stdout: '' } : devinRun('Pro')(exe, args), find: c => c, file, use, now: 2000 });
  assert.deepEqual(failing.changes, []);
  assert.match(failing.errors.antigravity, /agy models failed/);
  assert.deepEqual(lib.readPlanModels(file).providers.antigravity, { on: ['hydrogen'], off: ['argon'], new: [] });
  const off = config(); off.providers.providers.devin.enabled = false;
  const downgraded = refresh({ config: off, run: devinRun('Free'), find: c => c, file, use, now: 3000 });
  assert.deepEqual(downgraded.changes, []);
  assert.equal(lib.readPlanModels(file).providers.devin.plan, 'paid', 'an off provider is not asked');
  const free = refresh({ config: config(), run: devinRun('Free'), find: c => c === 'agy' ? null : c, file, use, now: 4000 });
  assert.deepEqual(changeLines(free.changes), ['devin (free plan): no model changed']);
});

test('Codex refresh stores new families and reports only additions without model switches', () => {
  const file = tempFile(), use = lib.normalizeUse({});
  const find = cmd => cmd === 'codex' ? cmd : null;
  const refreshCodex = (slugs, prefs = use) => refresh({ config: config(), find, file, use: prefs,
    run: run(JSON.stringify({ models: ['gpt-6.2-sol', ...slugs].map(slug => ({ slug, visibility: 'list' })) })) });
  assert.deepEqual(refreshCodex(['new-a'], lib.normalizeUse({ providersOff: ['codex'] })).listings, {});
  const first = refreshCodex(['new-b-high', 'new-a', 'new-b-low']);
  assert.deepEqual(first.changes, [{ provider: 'codex', plan: null, on: [], off: [], new: ['new-a', 'new-b'] }]);
  assert.deepEqual(changeLines(first.changes), ['codex: new in your plan, not routed yet: new-a, new-b']);
  assert.deepEqual(lib.readPlanModels(file).providers.codex, { on: [], off: [], new: ['new-a', 'new-b'] });
  assert.deepEqual(refreshCodex(['new-a', 'new-b']).changes, []);
  assert.deepEqual(refreshCodex(['new-b', 'new-c']).changes, [{ provider: 'codex', plan: null, on: [], off: [], new: ['new-c'] }]);
  assert.deepEqual(lib.readPlanModels(file).providers.codex, { on: [], off: [], new: ['new-b', 'new-c'] });
  const many = Array.from({ length: 51 }, (_, i) => 'extra-' + (100 + i));
  assert.deepEqual(refreshCodex([...many].reverse()).changes[0].new, many.slice(0, 50));
  assert.deepEqual(lib.readPlanModels(file).providers.codex.new, many.slice(0, 50));
});

test('refresh records a newly included family even when no table model matches', () => {
  const file = tempFile(), use = lib.normalizeUse({});
  const result = refresh({ config: config(), file, use, find: () => 'agy', only: 'antigravity',
    run: run('unrouted-high\tUnrouted\n') });
  assert.deepEqual(result.changes, [{ provider: 'antigravity', plan: null, on: [], off: [], new: ['unrouted'] }]);
  assert.deepEqual(lib.readPlanModels(file).providers.antigravity, { on: [], off: [], new: ['unrouted'] });
});

test('detected plan models switch shipped values, and a manual on or off still wins', () => {
  const registry = () => ({ a: { pool: 'devin', enabled: false }, b: { pool: 'devin' }, c: { pool: 'devin', enabled: false }, d: { pool: 'other', enabled: false }, e: { pool: 'devin' } });
  const plans = { providers: { devin: { on: ['a', 'c', 'd'], off: ['b', 'e'], new: ['f'] } } };
  const one = registry();
  one.f = { pool: 'devin', enabled: false };
  lib.applyPlanModels(one, plans, new Set(['e']), new Set(['c']));
  assert.deepEqual(Object.fromEntries(Object.entries(one).map(([id, m]) => [id, m.enabled !== false])), { a: true, b: false, c: false, d: false, e: true, f: false });
  assert.deepEqual(lib.readPlanModels(tempFile()).providers, Object.create(null));
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ checkedAt: 'x', providers: {
    devin: { plan: 'gold', on: ['ok', '../bad', 5], off: 'x', new: ['kilo/kilo-auto/free', '../bad', 5, 'bad id', 'a'.repeat(129)] },
    'bad id': { on: ['a'] },
  } }));
  const read = lib.readPlanModels(file);
  assert.equal(read.checkedAt, 0);
  assert.deepEqual({ ...read.providers }, { devin: { on: ['ok'], off: [], new: ['kilo/kilo-auto/free'] } });
});

test('the background check runs once a day and after an update, never twice at once, and only for a listing provider', () => {
  const file = tempFile(), use = lib.normalizeUse({});
  let spawned = 0;
  const spawn = () => { spawned++; return { on() {}, unref() {} }; };
  const version = require('../package.json').version;
  const day = 24 * 3600 * 1000;
  assert.equal(refreshIfStale({ config: config(), now: day * 10, spawn, file, use }), true);
  assert.equal(refreshIfStale({ config: config(), now: day * 10 + 1000, spawn, file, use }), false, 'claimed a moment ago');
  fs.writeFileSync(file, JSON.stringify({ version, checkedAt: day * 10 }));
  assert.equal(refreshIfStale({ config: config(), now: day * 10.5, spawn, file, use }), false, 'fresh');
  fs.writeFileSync(file, JSON.stringify({ version: '0.0.1', checkedAt: day * 10 }));
  assert.equal(refreshIfStale({ config: config(), now: day * 10.5, spawn, file, use }), true, 'updated since');
  const none = config();
  for (const provider of Object.values(none.providers.providers)) provider.enabled = false;
  assert.equal(refreshIfStale({ config: none, now: day * 20, spawn, file, use }), false);
  none.providers.providers.codex = { enabled: true };
  assert.equal(refreshIfStale({ config: none, now: day * 20, spawn, file, use }), false, 'a report-only list alone starts nothing');
  assert.equal(spawned, 2);
});

test('a slower refresh keeps what another run stored meanwhile', () => {
  const file = tempFile(), use = lib.normalizeUse({});
  let once = true;
  const run = (exe, args) => {
    if (once) { once = false; refresh({ config: config(), only: 'antigravity', run: () => ({ status: 0, stdout: 'gemini-4-hydrogen-high\tH\n' }), find: c => c, file, use }); }
    return devinRun('Free')(exe, args);
  };
  refresh({ config: config(), run, find: c => c === 'devin' ? c : null, file, use, now: 5000 });
  const saved = lib.readPlanModels(file);
  assert.deepEqual(Object.keys(saved.providers).sort(), ['antigravity', 'devin']);
  assert.equal(saved.checkedAt, 5000);
});
