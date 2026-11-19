'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const help = require('../scripts/provider-help');
const defaults = require('../config/providers.json');
const { PRESETS } = require('../scripts/add-api');

const config = providers => ({ providers: { providers } });

test('provider help omits the Junie billing key', () => {
  assert.doesNotMatch(help.guide(config(defaults.providers)), /JUNIE_API_KEY/i);
  assert.doesNotMatch(JSON.stringify(help.PROVIDER_HELP), /JUNIE_API_KEY/i);
});

test('every normal choice explains what it is, on, off, the catch and what you need', () => {
  for (const [id, provider] of Object.entries(defaults.providers)) {
    if (provider.kind === 'local') continue;
    assert.ok(Object.hasOwn(help.PROVIDER_HELP, id), id);
  }
  for (const id of Object.keys(PRESETS)) assert.ok(Object.hasOwn(help.PROVIDER_HELP, id), id);
  for (const [id, entry] of Object.entries(help.PROVIDER_HELP)) {
    for (const field of ['what', 'on', 'off', 'catch', 'needs']) assert.ok(entry[field]?.length > 5, id + ' ' + field);
  }
});

test('the guide shows the current state and keeps local models out', () => {
  const text = help.guide(config({ ...defaults.providers, codex: { enabled: false } }));
  assert.match(text, /- codex \[off\]: ChatGPT does coding tasks/);
  assert.match(text, /- perplexity \[on\]/);
  assert.doesNotMatch(text, /workers\./);
  assert.match(text, /- copilot \[off\]/);
  assert.match(text, /- cohere \[not added\]/);
  assert.match(text, /You need: A Copilot plan\. Verified GitHub Education students/);
  assert.doesNotMatch(text, /ollama/i);
});

test('added APIs show up, presets as themselves and others with general help', () => {
  const custom = { custom: true, enabled: true };
  const text = help.guide(config({ ...defaults.providers, cohere: custom, acme: custom }));
  assert.match(text, /- cohere \[on\]: Cohere/);
  assert.match(text, /- acme \[on\]: An API you added yourself/);
});

test('switching a provider says what that means', () => {
  assert.match(help.switchEffect('copilot', true), /One more limit/);
  assert.match(help.switchEffect('copilot', false), /Nothing is lost/);
  assert.equal(help.switchEffect('acme', true), '');
});

test('Antigravity carries an account warning everywhere it is offered', () => {
  assert.match(help.guide(config({ ...defaults.providers })), /Warning: Account risk/);
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
  assert.match(help.guide(config({ ...defaults.providers, acme: { custom: true, enabled: true } })), /never use a subscription login/i);
});

test('the Codex host description leaves the worker warning to its switch', () => {
  assert.match(help.SCRIPTED_CLAUDE_WARNING, /API key/);
  assert.equal(require('../scripts/setup-text').TEXT.hosts.codex, 'You work in Codex.');
});

test('docs-only providers explain the self-test gate when enabled', () => {
  for (const id of ['grok', 'antigravity', 'junie-lite', 'jetbrains']) {
    for (const text of [help.switchEffect(id, true)]) {
      assert.ok(text.includes(id === 'junie-lite' ? 'Tested end to end by the maintainer.'
        : "Not run end to end by the maintainer yet, built from the vendor's documentation."));
      assert.ok(text.includes('Quota Boss gives it no work until its self-test (quota-boss providers test ' + id + ') passes.'));
    }
    assert.doesNotMatch(help.switchEffect(id, false), /end to end/);
  }
  assert.doesNotMatch(help.switchEffect('copilot', true), /Not run end to end/);
});

test('both Junie providers say plainly what is known about training and how to turn data sharing off', () => {
  for (const id of ['junie-lite', 'jetbrains']) {
    const text = help.PROVIDER_HELP[id].warning;
    assert.match(text, /do not say whether/);
    assert.ok(text.includes('https://www.jetbrains.com/legal/docs/terms/product_data_collection_faq/'));
    assert.ok(text.includes('Settings | Appearance & Behavior | System Settings | Data Sharing'));
    assert.equal(defaults.providers[id].trainsOnData, false); assert.equal(defaults.providers[id].enabled, false);
    assert.equal(defaults.providers[id].evidence, 'docs'); assert.equal(defaults.providers[id].cli.promptVia, 'stdin');
  }
  assert.ok(defaults.providers['junie-lite'].cli.args.includes('--model=junie-lite'));
  assert.match(help.PROVIDER_HELP['junie-lite'].what, /free/i);
});
