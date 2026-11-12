'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isInstallerArgs } = require('../bin/quota-boss.js');

const root = path.join(__dirname, '..');
const binFile = path.join(root, 'bin', 'quota-boss.js');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function isolated(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CODEX_HOME: path.join(dir, 'codex'), QUOTA_BOSS_HOME: path.join(dir, 'qb') };
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

test('npm pack lists the bin file, the installer and the CLI', t => {
  const { env } = isolated(t);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, env, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0 || !result.stdout) return t.skip('npm pack unavailable: ' + (result.stderr || '').slice(0, 100));
  const files = JSON.parse(result.stdout)[0].files.map(f => f.path);
  for (const file of ['bin/quota-boss.js', 'install.js', 'scripts/quota-boss.js', 'package.json']) assert.ok(files.includes(file), file);
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
