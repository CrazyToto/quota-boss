'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { discover, parseDevin, parseTabList, selectedModel, matches } = require('../scripts/discover-models');

const config = () => ({
  providers: { providers: {
    devin: { cli: { command: 'devin', args: ['--model', 'swe-2-flash-medium', '-p', '{prompt}'] } },
    antigravity: { cli: { command: 'agy', args: ['-p', '{prompt}', '--model', '{model}-{effort}'] } },
    copilot: { cli: { command: 'copilot', args: ['-p', '{prompt}'] } },
  } },
  models: { models: {
    flash: { pool: 'devin' },
    swe21: { pool: 'devin', cliModel: 'swe-2-1-medium', enabled: false },
    gone: { pool: 'devin', cliModel: 'swe-9' },
    goneOff: { pool: 'devin', cliModel: 'swe-8', enabled: false },
    argon: { pool: 'antigravity', cliModel: 'gemini-4-argon' },
    hydrogen: { pool: 'antigravity', cliModel: 'gemini-4-hydrogen', enabled: false },
  } },
});
const devinJson = JSON.stringify({ families: [
  { variants: [{ model_uid: 'swe-2-flash-medium', cost_summary: '' }, { model_uid: 'swe-2-flash-max-lightning', cost_summary: '$1 / 1M Input' }] },
  { variants: [{ model_uid: 'swe-2-1-medium', cost_summary: '$2 / 1M Input' }, { model_uid: 'swe-2-1-high', cost_summary: '$2 / 1M Input' }] },
  { variants: [{ model_uid: 'kimi-k3-1-pro-high', cost_summary: 'Free' }, { model_uid: '../bad id' }, null] },
] });
const run = stdout => () => ({ status: 0, stdout });

test('Devin JSON: a price means per-token, none or Free means included, bad ids are dropped', () => {
  assert.deepEqual(parseDevin(devinJson).map(m => m.id + ':' + m.billing), ['swe-2-flash-medium:included', 'swe-2-flash-max-lightning:per-token',
    'swe-2-1-medium:per-token', 'swe-2-1-high:per-token', 'kimi-k3-1-pro-high:included']);
  assert.deepEqual(parseDevin('{}'), []);
  assert.throws(() => parseDevin('not json'));
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
  assert.match(text, /not in the table, so not routed: swe-2-flash, swe-2-1, kimi-k3-1-pro$/m);
  const agy = discover('antigravity', { config: config(), run: run('gemini-4-hydrogen-high\tH\n'), find: () => 'agy' });
  assert.deepEqual([agy.rows.off.map(r => r.id), agy.rows.missing.map(r => r.id)], [['hydrogen'], ['argon']]);
});

test('a provider without a list command, a failed run or unreadable output gives a short error', () => {
  assert.throws(() => discover('copilot', { config: config(), run: run(''), find: () => 'copilot' }), /no command that lists/);
  assert.throws(() => discover('devin', { config: config(), run: () => ({ status: 1, stdout: '' }), find: () => 'devin' }), /devin models list failed \(exit 1\)\. Is the CLI installed and signed in\?/);
  assert.throws(() => discover('devin', { config: config(), run: () => ({ status: null, error: new Error('ENOENT') }), find: () => null }), /failed: ENOENT/);
  assert.throws(() => discover('devin', { config: config(), run: run('<html>'), find: () => 'devin' }), /cannot read/);
  assert.match(discover('devin', { config: config(), run: run('{}'), find: () => 'devin' }).text, /missing/);
});

test('cli-run never runs an off model and picks the single on model without --model', () => {
  const { selection } = require('../scripts/cli-run');
  const cfg = { providers: { providers: { devin: { cli: { command: 'devin', args: ['--model', 'swe-2-flash-medium', '-p', '{prompt}'] } } } },
    models: { models: { flash: { pool: 'devin' }, paid: { pool: 'devin', cliModel: 'swe-2-1-medium', enabled: false } } } };
  assert.throws(() => selection({ provider: 'devin', model: 'paid' }, cfg, {}), /Model paid is off\. Turn it on with quota-boss use paid on/);
  assert.doesNotThrow(() => selection({ provider: 'devin' }, cfg, {}));
});
