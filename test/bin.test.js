'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isInstallerArgs } = require('../bin/quota-boss.js');
const { isolateCommand } = require('./fixtures/isolated-command');

const root = path.join(__dirname, '..');
const binFile = path.join(root, 'bin', 'quota-boss.js');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function isolated(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = isolateCommand({ ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CODEX_HOME: path.join(dir, 'codex'), QUOTA_BOSS_HOME: path.join(dir, 'qb') }, dir);
  return { dir, env };
}
const run = (args, env, cwd = root) => spawnSync(process.execPath, [binFile, ...args], { env, cwd, encoding: 'utf8', input: '' });

test('package.json declares the bin entry, can be published without dependencies, and the file exists with a node shebang and LF endings', () => {
  assert.deepEqual(pkg.bin, { 'quota-boss': 'bin/quota-boss.js' });
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.dependencies, undefined);
  const text = fs.readFileSync(binFile, 'utf8');
  assert.ok(text.startsWith('#!/usr/bin/env node\n'));
  assert.ok(!text.includes('\r'));
});

test('npm pack includes runtime files and excludes repository tooling and tests', t => {
  const { env } = isolated(t);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, env, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0 || !result.stdout) return t.skip('npm pack unavailable: ' + (result.stderr || '').slice(0, 100));
  const files = JSON.parse(result.stdout)[0].files.map(f => f.path);
  for (const file of ['bin/quota-boss.js', 'install.js', 'scripts/quota-boss.js', 'package.json', 'templates/BOOT.md', 'templates/RULES.md']) {
    assert.ok(files.includes(file), file);
  }
  for (const file of files) {
    assert.doesNotMatch(file, /^(?:test|\.github)\//);
    assert.ok(!['.gitattributes', 'CONTRIBUTING.md', 'scripts/free-models.js'].includes(file), file);
  }
  assert.deepEqual(files.filter(file => file.startsWith('templates/')), ['templates/BOOT.md', 'templates/RULES.md']);
});

test('isInstallerArgs treats no arguments and installer flags as install', () => {
  assert.equal(isInstallerArgs([]), true);
  for (const flag of ['--dry-run', '--force', '--no-mcp', '--mcp', '--uninstall']) assert.equal(isInstallerArgs([flag]), true, flag);
  assert.equal(isInstallerArgs(['--uninstall', '--force', '--dry-run']), true);
});

test('isInstallerArgs handles --scan with its value, a missing value, repeats and flag-like values', () => {
  assert.equal(isInstallerArgs(['--uninstall', '--scan', 'some dir']), true);
  assert.equal(isInstallerArgs(['--scan', 'status']), true, 'the value is consumed even when it looks like a command');
  assert.equal(isInstallerArgs(['--scan']), true, 'install.js reports the missing value');
  assert.equal(isInstallerArgs(['--scan', 'a', '--scan', 'b']), true, 'install.js rejects repeats');
  assert.equal(isInstallerArgs(['--scan', '--force']), true);
  assert.equal(isInstallerArgs(['--scan', 'a', 'status']), false);
});

test('isInstallerArgs sends commands, unknown flags and mixed arguments to the CLI', () => {
  for (const args of [['status'], ['doctor', '--probe'], ['--help'], ['--unknown'], ['--force', 'status'], ['status', '--force'], [''], ['--DRY-RUN']]) {
    assert.equal(isInstallerArgs(args), false, JSON.stringify(args));
  }
});

test('no arguments dispatch to the installer: --dry-run prints targets inside the isolated home and writes nothing', t => {
  const { dir, env } = isolated(t);
  const result = run(['--dry-run'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\] Write /);
  for (const line of result.stdout.split('\n').filter(l => l.startsWith('[dry-run] Write '))) {
    assert.ok(line.toLowerCase().includes(dir.toLowerCase()), 'target outside the temp home: ' + line);
  }
  assert.equal(fs.existsSync(path.join(dir, 'qb')), false);
  assert.equal(fs.existsSync(path.join(dir, 'claude')), false);
});

test('install then uninstall through the bin entry works from another working directory', t => {
  const { dir, env } = isolated(t);
  const install = run(['--no-mcp'], env, dir);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /Quota Boss installed at /);
  assert.ok(fs.existsSync(path.join(dir, 'qb', 'install-manifest.json')));
  const uninstall = run(['--uninstall'], env, dir);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /uninstalled/);
});

test('install adds the one quota-boss command in a home folder on PATH and uninstall removes it', t => {
  const { dir, env } = isolated(t);
  const bin = process.platform === 'win32' ? path.join(env.APPDATA, 'npm') : path.join(dir, '.local', 'bin');
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path');
  const withBin = { ...env, [key]: bin + path.delimiter + env[key] };
  const launcher = path.join(bin, process.platform === 'win32' ? 'quota-boss.cmd' : 'quota-boss');
  const without = run(['--no-mcp'], env, dir);
  assert.equal(without.status, 0, without.stderr);
  assert.match(without.stdout, /Run Quota Boss with: node "[^"]+\/scripts\/quota-boss\.js" <command>/);
  const install = run(['--no-mcp'], withBin, dir);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /Add the quota-boss command in /);
  assert.ok(fs.readFileSync(launcher, 'utf8').includes(path.join(dir, 'qb', 'scripts', 'quota-boss.js')));
  const uninstall = run(['--uninstall'], withBin, dir);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(fs.existsSync(launcher), false);
});

test('a command argument dispatches to the CLI and keeps its exit code', t => {
  const { env } = isolated(t);
  const ok = run(['status'], env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Quota Boss (on|off)/);
  const bad = run(['definitely-not-a-command'], env);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /Quota Boss help/);
});

test('--scan without a value and --scan without --uninstall fail with a message and a non-zero exit', t => {
  const { dir, env } = isolated(t);
  const missing = run(['--uninstall', '--scan'], env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--scan requires one directory/);
  const noUninstall = run(['--scan', dir], env);
  assert.equal(noUninstall.status, 1);
  assert.match(noUninstall.stderr, /--scan requires --uninstall/);
  assert.equal(fs.existsSync(path.join(dir, 'qb')), false);
});

test('--uninstall --scan <path> with spaces in the path is accepted as installer arguments', t => {
  const { dir, env } = isolated(t);
  const scan = path.join(dir, 'a folder');
  fs.mkdirSync(scan);
  const result = run(['--uninstall', '--dry-run', '--scan', scan], env);
  assert.equal(result.status, 0, result.stderr);
});

test('commands run the installed copy when there is one, so only one version ever runs', t => {
  const { dir, env } = isolated(t);
  const scripts = path.join(dir, 'qb', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'quota-boss.js'), 'console.log("INSTALLED " + process.argv.slice(2).join(" "))\n');
  const result = run(['status'], env, dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'INSTALLED status');
});
