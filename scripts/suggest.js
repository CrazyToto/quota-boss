'use strict';
const path = require('path');
const lib = require('./lib');
const newProviders = require('./new-providers');

// Few, high-confidence rules. Nothing changes automatically: the boss proposes the command to the user once.
const MAX = 2;
const DAY = 86400000;
const ID = /^[a-z][a-z0-9-]{1,31}$/;

/** Used percent of a window, or undefined when unknown or already reset (stale data must not suggest anything). */
function used(window, now) {
  const value = window?.used_percent;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const reset = Number(window?.resets_at);
  return Number.isFinite(reset) && reset > 0 && reset * 1000 <= now ? undefined : value;
}
function hostPool(host) { return host === 'codex' ? 'codex' : host === 'claude-code' ? 'claude' : null; }

/** Pure: snapshot-like data in, at most two { id, text, command } out. Broken input gives []. */
function suggestions(snap, now = Date.now()) {
  try {
    const project = snap?.project ?? {}, config = snap?.config ?? {}, limits = snap?.limits ?? {};
    if (!Number.isFinite(now)) return [];
    const out = [];
    const providers = config.providers?.providers ?? {}, models = config.models?.models ?? {};
    for (const { id, reason } of config.providers?.retired ?? []) {
      out.push({ id: 'retired:' + id, text: reason, command: 'remove-api ' + id });
    }
    const claude = lib.providerWindows('claude', limits);
    const week = used(claude.weekly, now);
    if (week !== undefined && week >= 80 && project.profile !== 'frugal') {
      out.push({ id: 'profile-frugal', text: 'Claude week is ' + Math.round(week) + '% used', command: 'set profile frugal' });
    }
    // Rule 2 needs every Claude window known: an unknown window could be the full one.
    const values = Object.values(claude).map(w => used(w, now));
    if (project.profile === 'frugal' && values.length && values.every(v => v !== undefined && v <= 40)) {
      out.push({ id: 'profile-balanced', text: 'every Claude window is at most 40% used, so frugal saves nothing', command: 'set profile balanced' });
    }
    // Ask about unanswered providers added by an update.
    const added = newProviders.suggestion(snap?.newProviders);
    if (added) out.push(added);
    const own = hostPool(project.host);
    const candidate = id => ID.test(id) && id !== 'claude' && id !== own && Object.hasOwn(providers, id) && providers[id]?.enabled !== false;
    const off = (id, text) => {
      if (candidate(id) && !out.some(s => s.id === 'provider-off:' + id)) out.push({ id: 'provider-off:' + id, text, command: 'use ' + id + ' off' });
    };
    // Rule 3: repeated failures without a single pass in the last 7 days.
    const stats = {};
    for (const o of Array.isArray(snap?.outcomes) ? snap.outcomes : []) {
      if (!o || !Number.isFinite(o.t) || o.t > now || o.t < now - 7 * DAY || typeof o.model !== 'string' || !Object.hasOwn(models, o.model)) continue;
      const pool = models[o.model]?.pool;
      if (typeof pool !== 'string') continue;
      const s = stats[pool] ??= { fail: 0, pass: 0 };
      if (o.result === 'pass') s.pass++;
      else if (o.result === 'fail' && !lib.transientOutcome(o) && o.kind !== 'not-run' || o.result === 'unavailable') s.fail++;
    }
    for (const [id, s] of Object.entries(stats).sort(([a], [b]) => a.localeCompare(b))) {
      if (s.fail >= 3 && s.pass === 0) off(id, id + ' failed ' + s.fail + ' recent jobs and passed none in 7 days');
    }
    // Rule 4: a CLI that is known to be missing (PATH lookup or the routing table's own reason).
    const missing = new Set(Array.isArray(snap?.missing) ? snap.missing : []);
    const rows = Array.isArray(snap?.result?.candidates) ? snap.result.candidates : [];
    const pools = new Map();
    for (const c of rows) if (c && typeof c.pool === 'string') pools.set(c.pool, (pools.get(c.pool) ?? true) && c.reason === 'CLI not installed');
    for (const [pool, all] of pools) if (all) missing.add(pool);
    for (const id of [...missing].sort()) off(id, 'the ' + id + ' CLI is not installed');
    // Rule 5: on and installed, but without a passed self-test routing gives it no work.
    for (const id of (Array.isArray(snap?.untested) ? snap.untested : []).filter(id => candidate(id) && !missing.has(id)).sort())
      out.push({ id: 'self-test:' + id, text: id + ' is on but has not passed its self-test, so it gets no work', command: 'providers test ' + id });
    return out.slice(0, MAX);
  } catch { return []; }
}

/** One line per suggestion, in the form the boss reads at session start. */
function lines(list) {
  return list.map(s => '[quota-boss] Suggestion: ' + s.text + (s.command ? '. Propose to the user: quota-boss ' + s.command : ''));
}

// Session starts repeat a suggestion only after a day, or after its condition went away and came back. status shows all.
const shownFile = () => path.join(lib.getPaths().quotaBossHome, 'suggestions.json');
function readShown() {
  const value = lib.readJson(shownFile(), {});
  const shown = value && typeof value === 'object' && !Array.isArray(value) && value.shown && typeof value.shown === 'object' && !Array.isArray(value.shown) ? value.shown : {};
  return Object.fromEntries(Object.entries(shown).filter(([, t]) => Number.isFinite(t)));
}
/** The suggestions a session start may show now. */
function due(list, now = Date.now()) {
  const shown = readShown();
  return list.filter(s => s.id === 'new-providers' || !(Object.hasOwn(shown, s.id) && shown[s.id] <= now && now - shown[s.id] < DAY));
}
/** Remember what a session start showed. Ids whose condition went away are forgotten, so they show again when it returns. */
function remember(current, shown, now = Date.now()) {
  const ids = new Set(current.map(s => s.id)), stored = readShown();
  const next = Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id)));
  for (const s of shown) next[s.id] = now;
  if (JSON.stringify(next) === JSON.stringify(stored)) return;
  lib.withLock(shownFile(), verify => { lib.atomicWrite(shownFile(), JSON.stringify({ shown: next }) + '\n', verify); return true; });
}

/** Reads the stored data the rules need. Only local files and a PATH lookup, never a CLI call or the network. */
function gather(project, config, now = Date.now()) {
  const { limits } = require('./session-routing').readLimits(config, now);
  const providers = config.providers?.providers ?? {}, own = hostPool(project.host);
  const missing = Object.entries(providers).filter(([id, p]) => p?.enabled !== false && id !== 'claude' && id !== own
    && typeof p?.cli?.command === 'string' && !lib.findExecutable(p.cli.command)).map(([id]) => id);
  const selfTests = lib.readState().selfTests, { evidenceStatus } = require('./self-test');
  const untested = Object.entries(providers).filter(([id, p]) => p?.enabled !== false && p?.evidence === 'docs' && !['free', 'local'].includes(p?.kind) && typeof p?.cli?.command === 'string'
    && Object.values(config.models?.models ?? {}).some(m => m?.pool === id && m.enabled !== false)
    && !missing.includes(id) && !evidenceStatus(id, config.models, selfTests, p.cli.command).startsWith('self-test passed')).map(([id]) => id);
  return { project, config, limits, outcomes: lib.readOutcomes(now, config.thresholds), missing, untested, newProviders: newProviders.pending() };
}

/** Suggestion lines for a project, e.g. for quota-boss status. Never throws. */
function statusLines(project = lib.findProjectConfig(), now = Date.now()) {
  try { return lines(suggestions(gather(project, lib.loadConfig(project, { tolerant: true }), now), now)); }
  catch { return []; }
}

module.exports = { suggestions, lines, gather, statusLines, due, remember };
