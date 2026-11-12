'use strict';
const path = require('node:path');
const lib = require('./lib');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const MATCHER = 'startup|resume|clear|compact';
function command(home) { return '"' + lib.trustedHomeText(process.execPath) + '" "' + lib.trustedHomeText(home) + '/scripts/hook-session.js" --host codex'; }
function ours(hook, home) {
  if (hook?.type !== 'command' || typeof hook.command !== 'string') return false;
  const suffix = ' "' + lib.trustedHomeText(home) + '/scripts/hook-session.js" --host codex';
  const normalized = hook.command.replace(/\\/g, '/');
  return normalized.endsWith(suffix) && /^"[^"\r\n]+"$/.test(normalized.slice(0, -suffix.length));
}
function validate(value) {
  if (!object(value) || value.hooks !== undefined && !object(value.hooks)) throw new Error('Expected hooks.json and hooks to be objects.');
  for (const entries of Object.values(value.hooks || {})) {
    if (!Array.isArray(entries) || entries.some(entry => !object(entry) || !Array.isArray(entry.hooks)
      || entry.matcher !== undefined && typeof entry.matcher !== 'string'
      || entry.hooks.some(hook => !object(hook) || typeof hook.type !== 'string' || hook.type === 'command' && typeof hook.command !== 'string')))
      throw new Error('Unexpected hooks.json event or handler shape.');
  }
  return value;
}
function snapshot(file) {
  lib.checkParents(file);
  const before = lib.regularStat(file, true);
  if (!before) return { bytes: null };
  const bytes = lib.readBounded(file, 4 * 1024 * 1024), after = lib.regularStat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('hooks.json changed while reading; retry.');
  return { bytes, dev: after.dev, ino: after.ino, mtime: after.mtimeMs, size: after.size };
}
/** Merge only our SessionStart handler; retain empty files because their ownership is unknown. */
function update(add, paths = lib.getPaths(), dry = false) {
  const home = paths.quotaBossHome, file = path.join(path.resolve(paths.codexDir), 'hooks.json');
  try {
    lib.trustedHomeText(home);
    try { lib.checkParents(file); } catch (error) { if (!add && error.code === 'ENOENT') return { changed: false }; throw error; }
    const transform = () => {
      const before = snapshot(file), value = validate(before.bytes === null ? {} : JSON.parse(before.bytes));
      const entries = value.hooks?.SessionStart || [];
      // Codex runs hooks in PowerShell on Windows, where a command that starts with a quoted path needs the call operator.
      const handler = { type: 'command', command: command(home), ...(process.platform === 'win32' ? { commandWindows: '& ' + command(home) } : {}), statusMessage: 'Quota Boss routing table', timeout: 20, additionalContextLimit: 8000 };
      const found = entries.some(entry => entry.hooks.some(hook => ours(hook, home)));
      if (add && entries.flatMap(entry => entry.hooks).filter(hook => ours(hook, home)).length === 1
        && entries.some(entry => entry.matcher === MATCHER && entry.hooks.some(hook => ours(hook, home)
          && Object.keys(hook).length === Object.keys(handler).length && Object.entries(handler).every(([key, val]) => hook[key] === val)))) return { changed: false };
      if (!add && !found) return { changed: false };
      if (found) {
        value.hooks.SessionStart = entries.flatMap(entry => {
          if (!entry.hooks.some(hook => ours(hook, home))) return [entry];
          const hooks = entry.hooks.filter(hook => !ours(hook, home));
          return hooks.length ? [{ ...entry, hooks }] : [];
        });
      }
      if (add) {
        value.hooks ||= {};
        value.hooks.SessionStart ||= [];
        value.hooks.SessionStart.push({ matcher: MATCHER, hooks: [handler] });
      } else {
        if (!value.hooks.SessionStart.length) delete value.hooks.SessionStart;
        if (!Object.keys(value.hooks).length) delete value.hooks;
      }
      if (!dry) lib.atomicWrite(file, JSON.stringify(value, null, 2) + '\n', () => {
        verify();
        if (JSON.stringify(snapshot(file)) !== JSON.stringify(before)) throw new Error('hooks.json changed during commit; retry.');
      });
      return { changed: true };
    };
    let verify = () => {};
    const result = dry ? transform() : lib.withLock(file, check => { verify = check; return transform(); }, 2000, file + '.quota-boss.lock');
    return result || { changed: false, message: 'hooks.json is locked by another writer; retry.' };
  } catch (error) { return { changed: false, message: String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ') }; }
}
function present(paths = lib.getPaths()) {
  try {
    const value = validate(JSON.parse(snapshot(path.join(path.resolve(paths.codexDir), 'hooks.json')).bytes));
    return (value.hooks?.SessionStart || []).some(entry => entry.hooks.some(hook => ours(hook, paths.quotaBossHome)));
  } catch { return false; }
}
module.exports = { update, present };
