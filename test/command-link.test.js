'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const link = require('../scripts/command-link');

const win = process.platform === 'win32';
const delimiter = win ? ';' : ':';

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-link-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const appData = path.join(root, 'appdata');
  const dir = win ? path.join(appData, 'npm') : path.join(home, '.local', 'bin');
  const quotaBossHome = path.join(root, 'qb');
  fs.mkdirSync(path.join(quotaBossHome, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(quotaBossHome, 'scripts', 'quota-boss.js'), 'console.log("ARGS:" + JSON.stringify(process.argv.slice(2)))\n');
  const env = { PATH: [dir, path.dirname(process.execPath)].join(delimiter), APPDATA: appData };
  return { root, home, dir, quotaBossHome, env, opts: { quotaBossHome, env, home, platform: process.platform } };
}
const launcher = dir => path.join(dir, win ? 'quota-boss.cmd' : 'quota-boss');
const runLauncher = (file, args) => win
  ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', file, ...args], { encoding: 'utf8' })
  : spawnSync(file, args, { encoding: 'utf8' });

test('a folder of the home is used only when it is on PATH', t => {
  const { dir, env, home } = sandbox(t);
  assert.equal(link.target(env, process.platform, home), dir);
  assert.equal(link.target({ ...env, PATH: path.dirname(process.execPath) }, process.platform, home), null);
  assert.equal(link.ensure({ quotaBossHome: 'x', env: { ...env, PATH: '' }, home, platform: process.platform }), null);
  assert.deepEqual(link.candidates({ APPDATA: 'relative' }, 'win32'), []);
});

test('the launcher runs the installed copy with every argument, and a repeat install writes nothing', t => {
  const { dir, opts } = sandbox(t);
  const said = [];
  assert.equal(link.ensure({ ...opts, say: line => said.push(line) }), dir, 'the folder is created when missing');
  assert.match(said.join('\n'), /Add the quota-boss command in/);
  const result = runLauncher(launcher(dir), ['use', 'grok', 'on']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ARGS:\["use","grok","on"\]/);
  said.length = 0;
  link.ensure({ ...opts, say: line => said.push(line) });
  assert.deepEqual(said, []);
  if (win) assert.ok(fs.existsSync(path.join(dir, 'quota-boss')), 'Git Bash launcher');
});

test('a dry run writes nothing', t => {
  const { dir, opts } = sandbox(t);
  const said = [];
  link.ensure({ ...opts, dry: true, say: line => said.push(line) });
  assert.match(said[0], /^\[dry-run\] Add the quota-boss command/);
  assert.equal(fs.existsSync(dir), false);
});

test('a foreign quota-boss file is kept; an npm launcher of an old global copy is replaced', t => {
  const { dir, opts } = sandbox(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(launcher(dir), 'something else\n');
  const said = [];
  assert.equal(link.ensure({ ...opts, say: line => said.push(line) }), null);
  assert.match(said[0], /not from Quota Boss/);
  assert.equal(fs.readFileSync(launcher(dir), 'utf8'), 'something else\n');
  fs.writeFileSync(launcher(dir), win ? '@ECHO off\r\n"%dp0%\\node_modules\\quota-boss\\bin\\quota-boss.js" %*\r\n'
    : 'exec node "$basedir/../lib/node_modules/quota-boss/bin/quota-boss.js" "$@"\n');
  assert.equal(link.npmShim(launcher(dir)), true);
  assert.equal(link.ensure(opts), null, 'only while the old global copy is still there');
  assert.equal(link.ensure({ ...opts, npmCopy: true }), dir);
  assert.match(fs.readFileSync(launcher(dir), 'utf8'), /managed-by: quota-boss/);
});

test('an npm symlink into the old package is replaced, never written through', { skip: win }, t => {
  const { root, dir, opts } = sandbox(t);
  const pkg = path.join(root, 'lib', 'node_modules', 'quota-boss', 'bin');
  fs.mkdirSync(pkg, { recursive: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'quota-boss.js'), 'old\n');
  fs.symlinkSync(path.join(pkg, 'quota-boss.js'), launcher(dir));
  assert.equal(link.ensure({ ...opts, npmCopy: true }), dir);
  assert.equal(fs.readFileSync(path.join(pkg, 'quota-boss.js'), 'utf8'), 'old\n');
  assert.equal(fs.lstatSync(launcher(dir)).isSymbolicLink(), false);
});

test('uninstall removes only launchers Quota Boss wrote', t => {
  const { dir, opts } = sandbox(t);
  link.ensure(opts);
  const foreign = path.join(dir, win ? 'quota-boss.ps1' : 'other');
  fs.writeFileSync(foreign, 'x');
  link.remove(opts);
  assert.equal(fs.existsSync(launcher(dir)), false);
  assert.equal(fs.existsSync(foreign), true);
});

test('the old global npm copy is the one in npm root -g, never an npx copy, and is removed through npm', t => {
  const { root } = sandbox(t);
  const global = path.join(root, 'global');
  const npm = { file: '/npm', args: [] };
  const find = () => npm;
  const rootIs = dir => () => ({ status: 0, stdout: dir + '\n' });
  assert.equal(link.npmGlobal({ find, run: rootIs(global) }), null, 'nothing installed');
  fs.mkdirSync(path.join(global, 'quota-boss'), { recursive: true });
  fs.writeFileSync(path.join(global, 'quota-boss', 'package.json'), '{"name":"quota-boss"}');
  assert.deepEqual(link.npmGlobal({ find, run: rootIs(global) }), { npm, root: global });
  assert.equal(link.npmGlobal({ find: () => null }), null);
  assert.equal(link.npmGlobal({ find, run: () => ({ status: 1 }) }), null);
  const npx = path.join(root, '_npx', 'abc', 'node_modules');
  assert.equal(link.npmGlobal({ find, run: rootIs(npx) }), null);
  const copy = { npm, root: global };
  assert.match(link.removeNpmGlobal(copy, { dry: true }), /^\[dry-run\]/);
  const calls = [];
  assert.match(link.removeNpmGlobal(copy, { run: (file, args) => { calls.push([file, args]); return { status: 0 }; } }), /^Removed the old global npm copy/);
  assert.deepEqual(calls, [['/npm', ['uninstall', '-g', 'quota-boss']]]);
  assert.match(link.removeNpmGlobal(copy, { run: () => ({ status: 1 }) }), /Run: npm uninstall -g quota-boss/);
});

test('the Windows launcher runs on one line and keeps the exit code; a % in a path stays literal', () => {
  const text = link.contents('C:\\x\\quota-boss.cmd', 'C:/Program Files/nodejs/node.exe', 'C:/Users/a/.claude/quota-boss/scripts/quota-boss.js', 'win32', {});
  assert.equal(text, '@echo off\r\nrem managed-by: quota-boss\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a\\.claude\\quota-boss\\scripts\\quota-boss.js" %* & call exit /b %%errorlevel%%\r\n');
  assert.equal(link.cmdPath('C:\\Users\\a%b\\x.js', {}), 'C:\\Users\\a%%b\\x.js');
  assert.equal(link.cmdPath('C:\\Users\\J\u00fcrgen\\x.js', { USERPROFILE: 'C:\\Users\\J\u00fcrgen' }), '%USERPROFILE%\\x.js');
  assert.equal(link.cmdPath('C:\\Daten\\J\u00fcrgen\\x.js', { USERPROFILE: 'C:\\Users\\a' }), null);
  assert.equal(link.contents('/b/quota-boss', "/o'k/node", '/h/qb.js', 'linux'), "#!/bin/sh\n# managed-by: quota-boss\nexec '/o'\\''k/node' '/h/qb.js' \"$@\"\n");
  assert.equal(link.contents('/b/quota-boss', '/a\\b/node', '/h/qb.js', 'linux'), "#!/bin/sh\n# managed-by: quota-boss\nexec '/a\\b/node' '/h/qb.js' \"$@\"\n");
});

test('the launcher passes the exit code of the command back', { skip: !win && 'cmd.exe only' }, t => {
  const { dir, opts, quotaBossHome } = sandbox(t);
  fs.writeFileSync(path.join(quotaBossHome, 'scripts', 'quota-boss.js'), 'process.exit(7)\n');
  link.ensure(opts);
  assert.equal(runLauncher(launcher(dir), []).status, 7);
});
