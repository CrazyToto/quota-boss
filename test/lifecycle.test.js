'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('install, doctor, route, upgrade and uninstall preserve user files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, QUOTA_BOSS_SKIP_MCP: '1' };
  for (const [key, dir] of Object.entries({ HOME: 'home', USERPROFILE: 'home', CLAUDE_CONFIG_DIR: 'claude', CODEX_HOME: 'codex', QUOTA_BOSS_HOME: 'boss', npm_config_cache: 'npm' })) {
    env[key] = path.join(root, dir); fs.mkdirSync(env[key], { recursive: true });
  }
  const original = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] }, statusLine: { type: 'command', command: 'echo user-status' } }, null, 2) + '\n';
  const settings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settings, original);
  for (const dir of ['agents', 'commands']) {
    fs.mkdirSync(path.join(env.CLAUDE_CONFIG_DIR, dir));
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, dir, 'user.md'), 'User file\n');
  }
  const installer = path.resolve(__dirname, '..', 'install.js');
  const installed = path.join(env.QUOTA_BOSS_HOME, 'scripts', 'quota-boss.js');
  const run = (script, args = []) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    if (result.error?.code === 'EPERM') { t.skip('Subprocess spawning is not permitted (EPERM)'); return null; }
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  if (run(installer, ['--no-mcp']) === null) return;
  const output = run(installed, ['doctor']);
  if (output === null) return;
  assert.doesNotMatch(output, /Problem:.*hooks/);
  if (run(installed, ['route']) === null) return;
  const before = JSON.parse(fs.readFileSync(settings));
  const config = path.join(env.QUOTA_BOSS_HOME, 'config', 'thresholds.json');
  const edit = '{"userNote":"keep me"}\n';
  fs.writeFileSync(config, edit);
  if (run(installer, ['--no-mcp']) === null) return;
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)), before);
  assert.equal(fs.readFileSync(config, 'utf8'), edit);
  assert.ok(fs.existsSync(config + '.new'));
  if (run(installer, ['--uninstall', '--no-mcp']) === null) return;
  assert.equal(fs.readFileSync(settings, 'utf8'), original);
  for (const dir of ['agents', 'commands']) {
    assert.deepEqual(fs.readdirSync(path.join(env.CLAUDE_CONFIG_DIR, dir)), ['user.md']);
    assert.equal(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, dir, 'user.md'), 'utf8'), 'User file\n');
  }
  assert.equal(fs.readFileSync(config, 'utf8'), edit);
});
