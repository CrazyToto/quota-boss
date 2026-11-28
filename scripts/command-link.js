'use strict';
// The one `quota-boss` command. The installer writes a small launcher into a folder of the user's own
// home that is already on PATH, so the command runs the installed copy and nothing else. An older
// `npm install -g quota-boss` copy is removed, so only one version exists.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('./lib');

const MARK = 'managed-by: quota-boss';
const NAME = 'quota-boss';

function api(platform) { return platform === 'win32' ? path.win32 : path.posix; }
function same(a, b, platform) {
  const p = api(platform);
  const norm = value => { const v = p.resolve(value).replace(/[\\/]+$/, ''); return platform === 'win32' ? v.toLowerCase() : v; };
  return norm(a) === norm(b);
}
function pathDirs(env, platform) {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path');
  return String(key ? env[key] : '').split(platform === 'win32' ? ';' : ':')
    .map(item => item.replace(/^"|"$/g, '')).filter(dir => dir && api(platform).isAbsolute(dir));
}
/** Folders in the user's own home where a launcher may go, best first. Never a system folder. */
function candidates(env, platform, home = os.homedir()) {
  const p = api(platform);
  if (platform === 'win32') {
    const appData = lib.envValue(env, 'APPDATA', platform);
    return appData && p.isAbsolute(appData) ? [p.join(appData, 'npm')] : [];
  }
  return [p.join(home, '.local', 'bin'), p.join(home, 'bin')];
}
/** The first candidate that is on PATH, or null. */
function target(env, platform, home) {
  const dirs = pathDirs(env, platform);
  return candidates(env, platform, home).find(dir => dirs.some(entry => same(entry, dir, platform))) || null;
}
function files(dir, platform) {
  const p = api(platform);
  return platform === 'win32' ? [p.join(dir, NAME + '.cmd'), p.join(dir, NAME)] : [p.join(dir, NAME)];
}
function read(file) {
  try { const stat = fs.lstatSync(file); return stat.isFile() ? lib.readBounded(file, 65536) : null; } catch { return null; }
}
const ours = file => (read(file) || '').includes(MARK);
/** True for a launcher npm wrote for a global quota-boss package (a link or a shim into it). */
function npmShim(file) {
  let real;
  try { real = fs.realpathSync(file); } catch { return false; }
  if (/node_modules[\\/]quota-boss[\\/]bin[\\/]quota-boss\.js$/i.test(real)) return true;
  const text = read(file);
  return !!text && !text.includes(MARK) && /node_modules[\\/]quota-boss[\\/]bin[\\/]quota-boss\.js/i.test(text);
}
/**
 * A Windows path for a .cmd file. cmd.exe reads batch files in the OEM code page, so a home folder
 * with letters like ü goes through its environment variable; null when the rest is still not ASCII.
 */
function cmdPath(value, env) {
  let text = path.win32.resolve(value);
  const lower = text.toLowerCase();
  const bases = ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']
    .map(name => [name, lib.envValue(env, name, 'win32')])
    .filter(([, base]) => base && path.win32.isAbsolute(base) && !/[%"]/.test(base))
    .map(([name, base]) => [name, path.win32.resolve(base).replace(/\\+$/, '')])
    .filter(([, base]) => lower === base.toLowerCase() || lower.startsWith(base.toLowerCase() + '\\'))
    .sort((a, b) => b[1].length - a[1].length);
  // A literal % would be expanded by cmd.exe, so it is doubled.
  const escape = value => value.replace(/%/g, '%%');
  if (/[^\x20-\x7e]/.test(text) && bases.length) text = '%' + bases[0][0] + '%' + escape(text.slice(bases[0][1].length));
  else text = escape(text);
  return /[^\x20-\x7e]/.test(text) ? null : text;
}
/**
 * Launcher text, or null when it cannot be written safely. The .cmd runs on one line, so cmd.exe never
 * reads on in a launcher that an update rewrote, and `call exit /b` keeps the exit code.
 */
function contents(file, node, script, platform = process.platform, env = process.env) {
  if (/\.cmd$/i.test(file)) {
    const n = cmdPath(node, env), s = cmdPath(script, env);
    return n && s ? '@echo off\r\nrem ' + MARK + '\r\n"' + n + '" "' + s + '" %* & call exit /b %%errorlevel%%\r\n' : null;
  }
  const quote = value => "'" + (platform === 'win32' ? value.replace(/\\/g, '/') : value).replace(/'/g, "'\\''") + "'";
  return '#!/bin/sh\n# ' + MARK + '\nexec ' + quote(node) + ' ' + quote(script) + ' "$@"\n';
}

/**
 * Write the launcher. Returns the folder, or null when no folder of the user's home is on PATH or it
 * cannot be written. A file of the same name that is not ours is never replaced, except npm's launcher
 * while the old global copy it belongs to is still there (`npmCopy`).
 */
function ensure({ quotaBossHome, env = process.env, platform = process.platform, home = os.homedir(), node = process.execPath, npmCopy = false, dry = false, say = () => {} } = {}) {
  const dir = target(env, platform, home);
  if (!dir) return null;
  const script = api(platform).join(quotaBossHome, 'scripts', 'quota-boss.js');
  try { lib.trustedHomeText(node); lib.trustedHomeText(script); lib.trustedHomeText(dir); } catch { return null; }
  const list = files(dir, platform);
  const texts = list.map(file => contents(file, node, script, platform, env));
  if (texts.some(text => text === null)) { say('The quota-boss command was not added: the install path cannot be written into a Windows launcher.'); return null; }
  const present = file => { try { fs.lstatSync(file); return true; } catch { return false; } };
  const blocked = list.find(file => present(file) && !ours(file) && !(npmCopy && npmShim(file)));
  if (blocked) { say('Kept ' + blocked + ': it is not from Quota Boss, so the quota-boss command was not added there.'); return null; }
  let wrote = false;
  list.forEach((file, index) => {
    const text = texts[index];
    if (read(file) === text) return;
    wrote = true;
    if (dry) return;
    fs.mkdirSync(dir, { recursive: true });
    // An npm launcher can be a symlink into the old package: replace the link, never write through it.
    try { if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file); } catch {}
    lib.atomicWrite(file, text);
    if (platform !== 'win32') fs.chmodSync(file, 0o755);
  });
  if (wrote) say((dry ? '[dry-run] ' : '') + 'Add the quota-boss command in ' + dir);
  return dir;
}

/** Remove our launchers from every candidate folder. */
function remove({ env = process.env, platform = process.platform, home = os.homedir(), dry = false, say = () => {} } = {}) {
  for (const dir of candidates(env, platform, home)) for (const file of files(dir, platform)) {
    if (!ours(file)) continue;
    say((dry ? '[dry-run] ' : '') + 'Remove ' + file);
    if (!dry) fs.unlinkSync(file);
  }
}

/**
 * The old global npm copy: npm's own global folder (`npm root -g`) holds a quota-boss package.
 * Asking npm finds exactly the copy `npm uninstall -g` removes, never npx's temporary one.
 */
function npmGlobal({ env = process.env, platform = process.platform, run = lib.runExecutable, find = lib.npmCommand } = {}) {
  const npm = find('npm', env, platform);
  if (!npm) return null;
  const result = run(npm.file, [...npm.args, 'root', '-g'], { platform, env, encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
  const root = result && !result.error && result.status === 0 ? String(result.stdout || '').trim().split(/\r?\n/).pop() : '';
  if (!root || !api(platform).isAbsolute(root) || /[\\/]_npx[\\/]/.test(root)) return null;
  const manifest = api(platform).join(root, NAME, 'package.json');
  try { return JSON.parse(lib.readBounded(manifest, 65536)).name === NAME ? { npm, root } : null; } catch { return null; }
}
/** Remove the old global npm copy found by npmGlobal. Returns a message. */
function removeNpmGlobal(copy, { env = process.env, platform = process.platform, dry = false, run = lib.runExecutable } = {}) {
  if (dry) return '[dry-run] Remove the old global npm copy of Quota Boss (npm uninstall -g quota-boss).';
  const result = run(copy.npm.file, [...copy.npm.args, 'uninstall', '-g', NAME], { platform, env, encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
  if (!result || result.error || result.status !== 0) return 'Could not remove the old global npm copy of Quota Boss. Run: npm uninstall -g quota-boss';
  return 'Removed the old global npm copy of Quota Boss, so only one version is left.';
}

module.exports = { MARK, candidates, target, files, contents, cmdPath, npmShim, ensure, remove, npmGlobal, removeNpmGlobal };
