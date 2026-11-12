'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const help = require('../scripts/provider-help');
const settings = require('../scripts/settings');
const defaults = require('../config/providers.json');
const { PRESETS } = require('../scripts/add-api');

const workers = { codex: true, gpt: false, perplexity: true };
const config = providers => ({ providers: { providers } });

test('every normal choice explains what it is, on, off, the catch and what you need', () => {
  const stubs = ['codex', 'perplexity', 'openrouter']; // shown as worker switches, or only useful through add-api
  for (const [id, provider] of Object.entries(defaults.providers)) {
    if (provider.kind === 'local' || stubs.includes(id)) continue;
    assert.ok(Object.hasOwn(help.PROVIDER_HELP, id), id);
  }
  for (const id of Object.keys(PRESETS)) assert.ok(Object.hasOwn(help.PROVIDER_HELP, id), id);
  for (const [id, entry] of Object.entries(help.PROVIDER_HELP)) {
    for (const field of ['what', 'on', 'off', 'catch', 'needs']) assert.ok(entry[field]?.length > 5, id + ' ' + field);
  }
});

test('the guide shows the current state and keeps local models out', () => {
  const text = help.guide(config({ ...defaults.providers }), workers);
  assert.match(text, /- workers\.codex \[on\]/);
  assert.match(text, /- workers\.gpt \[off\]/);
  assert.match(text, /- copilot \[off\]/);
  assert.match(text, /- cohere \[not added\]/);
  assert.match(text, /You need: A Copilot plan\. Verified GitHub Education students/);
  assert.doesNotMatch(text, /ollama/i);
});

test('added APIs show up, presets as themselves and others with general help', () => {
  const custom = { custom: true, enabled: true };
  const text = help.guide(config({ ...defaults.providers, cohere: custom, acme: custom }), workers);
  assert.match(text, /- cohere \[on\]: Cohere/);
  assert.match(text, /- acme \[on\]: An API you added yourself/);
});

test('explain gives the provider its own text and unknown providers the general help', () => {
  assert.match(settings.explain('providers.opencode-free'), /catch: Free models may train/);
  assert.match(settings.explain('providers.acme'), /Available providers/);
});

test('switching a provider says what that means', () => {
  assert.match(help.switchEffect('copilot', true), /One more limit/);
  assert.match(help.switchEffect('copilot', false), /Nothing is lost/);
  assert.equal(help.switchEffect('acme', true), '');
});

test('Antigravity carries an account warning everywhere it is offered', () => {
  assert.match(help.guide(config({ ...defaults.providers }), workers), /Warning: Account risk/);
  assert.match(help.explain('antigravity'), /warning: Account risk/);
  assert.match(help.switchEffect('antigravity', true), /Warning: Account risk/);
  assert.doesNotMatch(help.switchEffect('antigravity', false), /Warning/);
  assert.equal(defaults.providers.antigravity.enabled, false);
});

test('the README links to provider terms documentation and OpenCode is for API keys only', () => {
  const readme = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'README.md'), 'utf8');
  const providers = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'docs/PROVIDERS.md'), 'utf8');
  assert.match(providers, /## Provider terms/);
  assert.ok(readme.includes('docs/PROVIDERS.md#provider-terms'));
  assert.doesNotMatch(readme, /stays within the providers' terms/);
  for (const name of ['GitHub', 'Google', 'xAI', 'Mistral', 'OpenRouter', 'Cloudflare', 'Cohere', 'NVIDIA', 'Z\\.ai']) assert.match(readme, new RegExp('Not affiliated[\\s\\S]*' + name));
  assert.match(help.guide(config({ ...defaults.providers, acme: { custom: true, enabled: true } }), workers), /never use a subscription login/i);
});

test('the Codex host description leaves the worker warning to its switch', () => {
  assert.match(help.SCRIPTED_CLAUDE_WARNING, /API key/);
  assert.equal(require('../scripts/setup-text').TEXT.hosts.codex, 'You work in Codex.');
});

test('docs-only providers explain the self-test gate when enabled', () => {
  for (const id of ['grok', 'antigravity']) {
    for (const text of [help.explain(id), help.switchEffect(id, true)]) {
      assert.ok(text.includes("Not run end to end by the maintainer yet, built from the vendor's documentation."));
      assert.ok(text.includes('Quota Boss gives it no work until quota-boss providers test ' + id + ' passes.'));
    }
    assert.doesNotMatch(help.switchEffect(id, false), /Not run end to end/);
  }
  assert.doesNotMatch(help.explain('copilot'), /Not run end to end/);
});
