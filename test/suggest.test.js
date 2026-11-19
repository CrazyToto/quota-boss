'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { suggestions, lines, statusLines, due, remember } = require('../scripts/suggest');

const NOW = Date.UTC(2026, 10, 17, 12);
const DAY = 86400000;

function snap({ profile = 'balanced', host = 'claude-code', c5h = 10, cWeek = 20, outcomes = [], missing = [], enabled = {}, result, newProviders, untested } = {}) {
  const providers = { claude: { enabled: true }, codex: { enabled: true }, grok: { enabled: true, cli: { command: 'grok' } },
    perplexity: { enabled: true }, copilot: { enabled: false, cli: { command: 'copilot' } } };
  for (const [id, on] of Object.entries(enabled)) providers[id] = { ...providers[id], enabled: on };
  return { project: { profile, host }, now: NOW,
    config: { providers: { providers }, models: { models: { opus: { pool: 'claude' }, gpt: { pool: 'codex' }, 'grok-4': { pool: 'grok' },
      sonar: { pool: 'perplexity' }, 'copilot-x': { pool: 'copilot' } } } },
    limits: { claude: { five_hour: { used_percentage: c5h }, seven_day: { used_percentage: cWeek } } },
    outcomes, missing, result, newProviders, untested };
}
const fails = (model, n, result = 'fail', age = DAY) => Array.from({ length: n }, (_, i) => ({ t: NOW - age - i * 1000, model, result }));
const ids = list => list.map(s => s.id);

test('rule 1: Claude week at 80% suggests frugal, 79% does not', () => {
  const [s] = suggestions(snap({ cWeek: 85 }), NOW);
  assert.deepEqual(s, { id: 'profile-frugal', text: 'Claude week is 85% used', command: 'set profile frugal' });
  assert.deepEqual(ids(suggestions(snap({ cWeek: 80 }), NOW)), ['profile-frugal']);
  assert.deepEqual(suggestions(snap({ cWeek: 79 }), NOW), []);
  assert.deepEqual(suggestions(snap({ cWeek: 95, profile: 'frugal', c5h: 10 }), NOW), []);
  assert.deepEqual(ids(suggestions(snap({ cWeek: 90, profile: 'quality' }), NOW)), ['profile-frugal']);
});

test('rule 1 ignores a weekly window that has already reset', () => {
  const s = snap({ cWeek: 90 });
  s.limits.claude.seven_day.resets_at = (NOW - 1000) / 1000;
  assert.deepEqual(suggestions(s, NOW), []);
});

test('rule 2: frugal with every Claude window at most 40% suggests balanced', () => {
  assert.deepEqual(ids(suggestions(snap({ profile: 'frugal', c5h: 40, cWeek: 40 }), NOW)), ['profile-balanced']);
  assert.deepEqual(suggestions(snap({ profile: 'frugal', c5h: 41, cWeek: 10 }), NOW), []);
  assert.deepEqual(suggestions(snap({ profile: 'frugal', c5h: 10, cWeek: 41 }), NOW), []);
  assert.deepEqual(suggestions(snap({ profile: 'balanced', c5h: 1, cWeek: 1 }), NOW), []);
  const unknown = snap({ profile: 'frugal' });
  unknown.limits = {};
  assert.deepEqual(suggestions(unknown, NOW), []);
});

test('rule 3: three recent failures and no pass suggests turning the provider off', () => {
  const [s] = suggestions(snap({ outcomes: fails('grok-4', 3) }), NOW);
  assert.deepEqual(s, { id: 'provider-off:grok', text: 'grok failed 3 recent jobs and passed none in 7 days', command: 'use grok off' });
  assert.deepEqual(suggestions(snap({ outcomes: [...fails('grok-4', 2), ...fails('grok-4', 1, 'unavailable')] }), NOW).map(s => s.command), ['use grok off']);
  assert.deepEqual(suggestions(snap({ outcomes: fails('grok-4', 2) }), NOW), []);
  assert.deepEqual(suggestions(snap({ outcomes: fails('grok-4', 3, 'limited') }), NOW), []);
});

test('rule 3: a pass in the last 7 days resets, older outcomes do not count', () => {
  assert.deepEqual(suggestions(snap({ outcomes: [...fails('grok-4', 5), ...fails('grok-4', 1, 'pass')] }), NOW), []);
  assert.deepEqual(ids(suggestions(snap({ outcomes: [...fails('grok-4', 3), ...fails('grok-4', 1, 'pass', 8 * DAY)] }), NOW)), ['provider-off:grok']);
  assert.deepEqual(suggestions(snap({ outcomes: fails('grok-4', 3, 'fail', 8 * DAY) }), NOW), []);
  assert.deepEqual(suggestions(snap({ outcomes: fails('unknown-model', 5) }), NOW), []);
  assert.deepEqual(suggestions(snap({ outcomes: fails('grok-4', 3, 'fail', -DAY) }), NOW), [], 'future outcomes are ignored');
});

test('rule 3 never suggests claude, the host pool or a disabled provider', () => {
  assert.deepEqual(suggestions(snap({ outcomes: fails('opus', 5) }), NOW), []);
  assert.deepEqual(suggestions(snap({ outcomes: fails('copilot-x', 5) }), NOW), []);
  assert.deepEqual(suggestions(snap({ outcomes: fails('grok-4', 5), enabled: { grok: false } }), NOW), []);
  assert.deepEqual(ids(suggestions(snap({ outcomes: fails('gpt', 3) }), NOW)), ['provider-off:codex']);
  assert.deepEqual(suggestions(snap({ outcomes: fails('gpt', 3), host: 'codex' }), NOW), []);
});

test('rule 4: a missing CLI suggests turning the provider off, once per provider', () => {
  const [s] = suggestions(snap({ missing: ['grok'] }), NOW);
  assert.deepEqual(s, { id: 'provider-off:grok', text: 'the grok CLI is not installed', command: 'use grok off' });
  assert.deepEqual(ids(suggestions(snap({ missing: ['grok'], outcomes: fails('grok-4', 3) }), NOW)), ['provider-off:grok']);
  assert.deepEqual(suggestions(snap({ missing: ['copilot', 'claude', 'nope'] }), NOW), []);
  assert.deepEqual(suggestions(snap({ missing: ['codex'], host: 'codex' }), NOW), []);
});

test('rule 5: an enabled, installed provider without a passed self-test suggests running it', () => {
  const [s] = suggestions(snap({ untested: ['grok'] }), NOW);
  assert.deepEqual(s, { id: 'self-test:grok', text: 'grok is on but has not passed its self-test, so it gets no work', command: 'providers test grok' });
  assert.deepEqual(ids(suggestions(snap({ untested: ['grok'], missing: ['grok'] }), NOW)), ['provider-off:grok'], 'a missing CLI comes first');
  assert.deepEqual(suggestions(snap({ untested: ['copilot', 'claude', 'nope'] }), NOW), []);
});

test('rule 4 reads the routing table: only when every row of the pool lacks the CLI', () => {
  const rows = reasons => ({ candidates: reasons.map(reason => ({ pool: 'grok', reason })) });
  assert.deepEqual(ids(suggestions(snap({ result: rows(['CLI not installed', 'CLI not installed']) }), NOW)), ['provider-off:grok']);
  assert.deepEqual(suggestions(snap({ result: rows(['CLI not installed', '']) }), NOW), []);
});

test('at most two suggestions, profile first', () => {
  const list = suggestions(snap({ cWeek: 90, missing: ['grok'], outcomes: fails('gpt', 4) }), NOW);
  assert.deepEqual(ids(list), ['profile-frugal', 'provider-off:codex']);
});

test('broken input gives no suggestions', () => {
  for (const value of [undefined, null, 1, 'x', [], {}, { project: null, config: 5, limits: 'x', outcomes: 'y', missing: 3 },
    { limits: { claude: { seven_day: { used_percentage: 'NaN' } } } }, { outcomes: [null, 1, { t: 'x' }] }]) {
    assert.deepEqual(suggestions(value, NOW), []);
  }
  assert.deepEqual(suggestions(snap({ cWeek: 90 }), NaN), []);
  const hostile = snap({ cWeek: 90 });
  Object.defineProperty(hostile, 'limits', { get() { throw new Error('boom'); } });
  assert.deepEqual(suggestions(hostile, NOW), []);
});

test('lines use the one-line suggestion form', () => {
  assert.deepEqual(lines(suggestions(snap({ cWeek: 85 }), NOW)),
    ['[quota-boss] Suggestion: Claude week is 85% used. Propose to the user: quota-boss set profile frugal']);
  assert.deepEqual(lines([]), []);
});

test('statusLines never throws', () => {
  assert.ok(Array.isArray(statusLines({ host: 'claude-code', profile: 'balanced', providers: 5 })));
});

test('unknown or null window values are unknown, never 0', () => {
  for (const value of [null, '', '50', true, NaN]) {
    assert.deepEqual(suggestions(snap({ profile: 'frugal', c5h: value, cWeek: 10 }), NOW), [], 'rule 2 with 5h ' + value);
    assert.deepEqual(suggestions(snap({ profile: 'frugal', c5h: 10, cWeek: value }), NOW), [], 'rule 2 with week ' + value);
  }
  const reset = snap({ profile: 'frugal', c5h: 10, cWeek: 10 });
  reset.limits.claude.five_hour.resets_at = (NOW - 1000) / 1000;
  assert.deepEqual(suggestions(reset, NOW), [], 'a window that already reset is unknown');
  assert.deepEqual(suggestions(snap({ cWeek: null }), NOW), []);
});

test('due hides a suggestion shown in the last 24 hours; remember forgets one whose condition went away', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const saved = process.env.QUOTA_BOSS_HOME, home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-boss-suggest-'));
  process.env.QUOTA_BOSS_HOME = home;
  try {
    const a = { id: 'profile-frugal', text: 'a', command: 'set profile frugal' }, b = { id: 'provider-off:grok', text: 'b', command: 'use grok off' };
    assert.deepEqual(due([a, b], NOW), [a, b]);
    remember([a, b], [a], NOW);
    assert.deepEqual(due([a, b], NOW + DAY - 1), [b], 'b was not shown, so it stays due');
    assert.deepEqual(due([a, b], NOW + DAY), [a, b]);
    remember([b], [], NOW + 1000);
    assert.deepEqual(due([a], NOW + 2000), [a], 'a went away and came back');
    fs.writeFileSync(path.join(home, 'suggestions.json'), '{bad');
    assert.deepEqual(due([a], NOW), [a], 'a broken file shows everything');
  } finally {
    if (saved === undefined) delete process.env.QUOTA_BOSS_HOME; else process.env.QUOTA_BOSS_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('providers new since an update are suggested until they are answered, explicit switches never', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const lib = require('../scripts/lib'), added = require('../scripts/new-providers');
  const [line] = lines(suggestions(snap({ newProviders: ['junie-lite', 'jetbrains'] }), NOW));
  assert.match(line, /Ask the user: "Turn on Junie Lite\? Free, no limit published\." If yes, run quota-boss use junie-lite on in a terminal\. If no, run quota-boss use junie-lite off\./);
  assert.match(line, /Turn on JetBrains AI \(Junie\)\?/);
  assert.deepEqual(suggestions(snap({ newProviders: ['bad id', 'no-help', 5] }), NOW), []);
  assert.deepEqual(ids(suggestions(snap({ cWeek: 90, newProviders: ['junie-lite'], missing: ['grok'] }), NOW)), ['profile-frugal', 'new-providers']);
  const saved = process.env.QUOTA_BOSS_HOME, home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-boss-suggest-'));
  process.env.QUOTA_BOSS_HOME = home;
  try {
    const shown = () => ids(suggestions(snap({ newProviders: added.pending() }), NOW));
    assert.deepEqual(shown(), [], 'without a record nothing is new');
    const old = Object.keys(lib.BUILTIN_PROVIDERS.providers).filter(id => !['junie-lite', 'jetbrains'].includes(id));
    added.markKnown(old);
    assert.deepEqual(added.pending(), ['junie-lite', 'jetbrains']);
    assert.deepEqual(shown(), ['new-providers']);
    for (const [index, source] of ['startup', 'clear', 'compact', 'resume'].entries()) {
      const now = NOW + index;
      const list = suggestions(snap({ newProviders: added.pending() }), now);
      const current = due(list, now);
      assert.deepEqual(ids(current), ['new-providers'], source);
      remember(list, current, now);
    }
    lib.writeJson(path.join(home, 'config', 'providers.json'), { providers: { jetbrains: { enabled: false } } });
    assert.deepEqual(added.pending(), ['junie-lite'], 'a provider switched on purpose is never new');
    added.markKnown(['junie-lite']);
    assert.deepEqual(shown(), [], 'an answered provider is not suggested again');
  } finally {
    if (saved === undefined) delete process.env.QUOTA_BOSS_HOME; else process.env.QUOTA_BOSS_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
