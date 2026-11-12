'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const cli = require('../scripts/quota-boss');
const { doctor } = require('../scripts/diagnostics');
const { install, offerTools, setupNext } = require('../install');
const { SCRIPTED_CLAUDE_WARNING } = require('../scripts/provider-help');

test.describe('Codex-only installs', () => {
  let root, cwd, saved;
  test.beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-codex-only-'));
    cwd = process.cwd();
    saved = { ...process.env };
    process.env.QUOTA_BOSS_HOME = path.join(root, 'boss with spaces');
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
    process.env.CODEX_HOME = path.join(root, 'codex');
    process.chdir(root);
  });
  test.afterEach(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const present of [false, true]) {
    test('installer hint with Claude present=' + present, () => {
      const find = () => present ? process.execPath : null;
      install({ args: ['--no-mcp'], env: process.env, findExecutable: find, log: () => {} });
      const lines = [];
      offerTools({ interactive: false, say: line => lines.push(line), options: { env: process.env, findExecutable: find } });
      // Without Claude the final "Next:" line names the terminal setup, so this hint stays silent.
      assert.deepEqual(lines, present ? ['Run /boss-setup to check and install provider CLIs.'] : []);
      assert.equal(setupNext({ env: process.env, findExecutable: find }), present ? null
        : 'Next: in your project folder run: node "' + process.env.QUOTA_BOSS_HOME.replace(/\\/g, '/') + '/scripts/quota-boss.js" setup');
    });
  }
  for (const host of ['codex', 'generic', 'claude-code']) {
    for (const present of [false, true]) {
      test('on host=' + host + ', Claude present=' + present, t => {
        t.mock.method(lib, 'findExecutable', () => present ? process.execPath : null);
        const output = cli.run(['on', '--host', host]);
        const disabled = host !== 'claude-code' && !present;
        assert.equal(lib.loadConfig().providers.providers.claude.enabled === false, disabled);
        assert.equal(output.includes('Claude CLI not found, so Claude is off as a worker.'), disabled);
        assert.equal(output.includes(SCRIPTED_CLAUDE_WARNING), host === 'codex' && present);
        assert.doesNotMatch(cli.run(['on']), /Claude CLI not found/);
        if (disabled) assert.doesNotMatch(cli.run(['route']), /claude-worker/);
      });
    }
  }
  test('provider write errors propagate from on', t => {
    t.mock.method(lib, 'findExecutable', () => null);
    const lock = lib.withLock;
    t.mock.method(lib, 'withLock', (file, ...args) => file.endsWith('providers.json') ? null : lock(file, ...args));
    assert.throws(() => cli.run(['on', '--host', 'codex']), /Provider config is busy/);
  });
  for (const host of ['codex', 'generic', 'claude-code']) {
    for (const enabled of [false, true]) {
      for (const present of [false, true]) {
        test('doctor host=' + host + ', enabled=' + enabled + ', present=' + present, t => {
          t.mock.method(lib, 'findExecutable', () => process.execPath);
          cli.run(['on', '--host', host]);
          cli.run(['use', 'claude', enabled ? 'on' : 'off']);
          const output = doctor(false, {
            findExecutable: name => name === 'claude' && !present ? null : process.execPath,
            spawnSync: () => ({ status: 0, stdout: 'CLI 1.2.3' }),
          });
          assert.equal(output.includes('Problem: claude CLI not found.'), !present && (enabled || host === 'claude-code'));
          assert.equal(output.includes('claude: not installed (Claude is off as a worker)'), !present && !enabled && host !== 'claude-code');
          assert.equal(output.includes(', or quota-boss use claude off'), !present && enabled && host !== 'claude-code');
        });
      }
    }
  }
});
