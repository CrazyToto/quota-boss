'use strict';
// Built-in providers that an update adds are offered once. state.json keeps the ids the user was already offered
// (knownProviders); nothing is switched without the user's answer.
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');
const { PROVIDER_HELP } = require('./provider-help');

const home = () => lib.getPaths().quotaBossHome;
const providerIds = file => { const value = lib.readJson(file, null)?.providers; return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : null; };
const known = () => { const value = lib.readState().knownProviders; return Array.isArray(value) ? value.filter(lib.validProviderId) : null; };
const nameOf = id => PROVIDER_HELP[id].name;

/** Providers the user switched on or off on purpose. Older installs copied every provider they shipped into the user
 *  file, but those are known from the baseline anyway, so an entry there for a new id is a real choice. */
function chosen() {
  const user = lib.readJson(path.join(home(), 'config', 'providers.json'), {})?.providers ?? {};
  const use = lib.readUse();
  return new Set([...Object.keys(user).filter(id => typeof user[id]?.enabled === 'boolean'), ...use.providersOff, ...(use.only ?? [])]);
}

/** New shipped providers with help text that were never offered or switched. Without a record nothing is new. */
function pending() {
  const seen = known();
  if (!seen) return [];
  const switched = chosen();
  return Object.keys(lib.BUILTIN_PROVIDERS.providers).filter(id => Object.hasOwn(PROVIDER_HELP, id) && !seen.includes(id) && !switched.has(id));
}

function markKnown(ids) {
  lib.updateState(state => ({ knownProviders: [...new Set([...(Array.isArray(state.knownProviders) ? state.knownProviders : []), ...ids])] }));
}

/** Before install overwrites defaults/: was this a fresh install, and which providers did the previous version ship? */
function beforeInstall() {
  const dir = home();
  if (!fs.existsSync(path.join(dir, 'install-manifest.json'))) return { fresh: true, ids: null };
  return { fresh: false, ids: providerIds(path.join(dir, 'defaults', 'providers.json')) ?? providerIds(path.join(dir, 'config', 'providers.json')) };
}

/** A fresh install (or one whose previous version is unknown) knows every shipped provider; an update knows what it shipped before. */
function recordInstall(before) {
  if (known()) return;
  const shipped = Object.keys(lib.BUILTIN_PROVIDERS.providers);
  markKnown(before.fresh || !before.ids ? shipped : before.ids.filter(lib.validProviderId));
}

/** Ask on a terminal and run the same activation as the use command. */
function offer({ ask = lib.askLine, say = console.log, interactive = !!(process.stdin.isTTY && process.stdout.isTTY),
  toolsOptions, use = (id, action) => require('./quota-boss').run(['use', id, action], { interactive, say, toolsOptions }) } = {}) {
  const ids = pending();
  if (!ids.length) return;
  if (!interactive) { say('New providers since your last version: ' + ids.map(nameOf).join(', ') + '. To turn them on, run: quota-boss setup'); return; }
  say('New providers since your last version:');
  const answered = [];
  for (const id of ids) {
    say(nameOf(id) + ': ' + PROVIDER_HELP[id].what);
    const answer = String(ask('Turn on ' + nameOf(id) + '? [y/n] ')).trim();
    if (!/^(y(es)?|n(o)?)$/i.test(answer)) continue;
    const action = /^y/i.test(answer) ? 'on' : 'off';
    try {
      say(use(id, action));
      answered.push(id);
    } catch (error) { say('Could not turn ' + action + ' ' + id + ': ' + error.message); }
  }
  // A yes that could not be saved is asked again next time.
  if (answered.length) markKnown(answered);
}

/** The session-start suggestion while new providers are still unanswered. */
function suggestion(ids) {
  const pending = (Array.isArray(ids) ? ids : []).filter(id => lib.validProviderId(id) && Object.hasOwn(PROVIDER_HELP, id));
  if (!pending.length) return null;
  const text = pending.map(id => {
    const name = id === 'junie-lite' ? 'Junie Lite' : nameOf(id);
    const detail = id === 'junie-lite' ? ' Free, no limit published.' : '';
    return 'Ask the user: "Turn on ' + name + '?' + detail + '" If yes, run quota-boss use ' + id +
      ' on in a terminal. If no, run quota-boss use ' + id + ' off.';
  }).join(' ');
  return { id: 'new-providers', text };
}

module.exports = { pending, markKnown, beforeInstall, recordInstall, offer, suggestion };
