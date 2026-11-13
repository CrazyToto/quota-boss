'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const hosts = require('../scripts/hosts');
const cli = require('../scripts/quota-boss');

test.describe('headless host fixes', () => {
  let temporary, cwd, env, file;
  test.beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-headless-'));
    cwd = process.cwd();
    env = Object.fromEntries(['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'QUOTA_BOSS_HOME', 'QUOTA_BOSS_BOSS_MODEL'].map(k => [k, process.env[k]]));
    for (const key of Object.keys(env)) process.env[key] = temporary;
    delete process.env.QUOTA_BOSS_BOSS_MODEL;
    process.chdir(temporary); file = path.join(temporary, 'AGENTS.md');
  });
  test.afterEach(() => {
    process.chdir(cwd);
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  test('Codex override precedes config and cleans model IDs', () => {
    fs.writeFileSync(path.join(temporary, 'config.toml'), 'model = "detected"\n');
    for (const [value, expected] of [['gpt-6.1-sol', 'gpt-6.1-sol'], ['model[1m]', 'model']]) {
      process.env.QUOTA_BOSS_BOSS_MODEL = value;
      assert.equal(lib.currentBossModel({ host: 'codex' }, {}), expected);
      assert.equal(lib.currentBossModel({ host: 'claude-code' }, { bossModel: 'claude-model' }), 'claude-model');
      assert.equal(lib.currentBossModel({ host: 'generic' }, {}), null);
    }
  });
  test('invalid and absent overrides fall through to Codex detection', () => {
    fs.writeFileSync(path.join(temporary, 'config.toml'), 'model = "detected"\n');
    for (const value of ['', 'bad model', '-bad', 'bad\nmodel', 'x'.repeat(65)]) {
      process.env.QUOTA_BOSS_BOSS_MODEL = value;
      assert.equal(lib.currentBossModel({ host: 'codex' }, {}), 'detected');
    }
    delete process.env.QUOTA_BOSS_BOSS_MODEL;
    assert.equal(lib.currentBossModel({ host: 'codex' }, {}), 'detected');
  });
  for (const remainder of ['', ' \r\n\t']) test('off deletes block with remainder ' + JSON.stringify(remainder), () => {
    cli.run(['on', '--host', 'codex']);
    fs.appendFileSync(file, remainder);
    cli.run(['off']); assert.equal(fs.existsSync(file), false);
    assert.equal(lib.findProjectConfig().enabled, false);
    cli.run(['off']); assert.equal(fs.existsSync(file), false);
  });
  test('off preserves all outside project text', () => {
    cli.run(['on', '--host', 'codex']);
    fs.writeFileSync(file, 'Before\r\n' + fs.readFileSync(file, 'utf8') + '\tAfter');
    cli.run(['off']); assert.equal(fs.readFileSync(file, 'utf8'), 'Before\r\n\tAfter');
  });
  test('cleanup rejects nonregular files and lost locks before deleting', () => {
    fs.writeFileSync(file, hosts.START + hosts.END);
    const agent = hosts.agentsText(temporary, '');
    assert.throws(() => hosts.writeAgents(agent, () => { throw new Error('Lost lock'); }), /Lost lock/);
    assert.equal(fs.readFileSync(file, 'utf8'), agent.previous);
    fs.unlinkSync(file); fs.mkdirSync(file);
    assert.throws(() => hosts.writeAgents(agent, () => {}), /regular file/);
  });
  for (const home of ['C:/Users/x/.claude/quota-boss', 'C:/Users/with space/boss', 'C:/Users/x+(test)/boss']) test('rules quote paths correctly for ' + home, () => {
    process.env.QUOTA_BOSS_HOME = home;
    const original = lib.substituteHome(fs.readFileSync(path.join(__dirname, '..', 'templates', 'RULES.md'), 'utf8').trim());
    assert.equal(hosts.rules('claude-code'), original.split('\n').filter(line => !line.startsWith('   - Codex host:')).join('\n'));
    assert.ok(!hosts.rules('codex').includes('- Claude Code host:') && hosts.rules('codex').includes('- Codex host:'));
    for (const host of ['codex', 'generic']) {
      const text = hosts.rules(host);
      // The rules hold the resolved path: on Linux and macOS a Windows-style path lands below the working directory.
      const quoted = '"' + lib.trustedHomeText(home) + '/scripts/';
      if (home.includes('space') || home.includes('+')) assert.ok(text.includes(quoted));
      else {
        assert.ok(!text.includes(quoted));
        assert.ok(text.includes(home + '/scripts/quota-boss.js route'));
        if (host === 'generic') assert.ok(text.includes(home + '/scripts/cli-run.js'));
        else assert.ok(text.includes(home + '/scripts/quota-boss.js rules --host codex'));
        if (host === 'codex') assert.ok(text.includes(home + '/scripts/compact.js'));
      }
    }
  });
});
