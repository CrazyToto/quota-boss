'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const cli = require('../scripts/quota-boss');

const choices = { profile: 'frugal', training: 'on', statusline: 'always', context: '100000' };
const removedSettings = ['short-answers', 'rules', 'consensus', 'split', 'research', 'codex-tasks', 'gpt-reviews', 'perplexity'];
test.describe('set and public command help', () => {
  let root, cwd, env;
  test.beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-set-'));
    cwd = process.cwd();
    env = Object.fromEntries(['QUOTA_BOSS_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].map(k => [k, process.env[k]]));
    for (const key of Object.keys(env)) process.env[key] = path.join(root, key);
    fs.mkdirSync(path.join(root, 'project')); process.chdir(path.join(root, 'project'));
  });
  test.afterEach(() => {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [name, value] of Object.entries(choices)) {
    test(name + ' accepts its value and rejects invalid values before writing', () => {
      assert.throws(() => cli.run(['set', name, 'wrong']), name === 'context' ? /off or a token count/ : /Valid values/);
      assert.equal(fs.existsSync(lib.getPaths().projectsFile), false);
      assert.throws(() => cli.run(['set', name, value, 'extra']));
      const output = cli.run(['set', name, value]);
      const project = lib.findProjectConfig();
      if (name === 'statusline') { assert.equal(lib.showsWithoutBoss(), true); assert.equal(fs.existsSync(lib.getPaths().projectsFile), false); }
      else if (name === 'context') assert.equal(project.contextSuggest, 100000);
      else if (name === 'profile') assert.equal(project.profile, value);
      else {
        assert.equal(project.allowTrainingProviders, true);
        assert.match(output, /Effect:/);
      }
    });
  }
  test('unknown names list every valid name', () => {
    for (const args of [['set'], ['set', 'missing', 'on'], ['set', 'terse', 'on']]) {
      assert.throws(() => cli.run(args), error => Object.keys(choices).every(name => error.message.includes(name)));
    }
    assert.equal(fs.existsSync(lib.getPaths().projectsFile), false);
  });
  test('removed settings fail with their replacement and exit 1, without writes', () => {
    for (const name of removedSettings) {
      assert.throws(() => cli.run(['set', name, 'on']), error => error.message.startsWith(name + ' was removed in 0.2.0: ') && error.message.endsWith('.'), name);
    }
    assert.throws(() => cli.run(['set', 'split', 'on']), /^Error: split was removed in 0\.2\.0: the benchmark showed no gain/);
    assert.throws(() => cli.run(['set', 'codex-tasks', 'off']), /quota-boss use codex on\|off/);
    assert.throws(() => cli.run(['set', 'perplexity', 'off']), /quota-boss use perplexity on\|off/);
    assert.equal(fs.existsSync(lib.getPaths().projectsFile), false);
    const result = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '../scripts/quota-boss.js'), 'set', 'split', 'on'], { encoding: 'utf8', env: process.env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^quota-boss: split was removed in 0\.2\.0: /);
    assert.equal(fs.existsSync(lib.getPaths().projectsFile), false);
  });
  test('old stored fields of removed settings never cause an error, and old exclusions keep excluding', () => {
    const old = { enabled: true, rules: 'full', terse: true, consensus: false, split: true, research: false, workers: { codex: false, gpt: false, perplexity: false }, use: { only: ['claude'] } };
    lib.saveProject(process.cwd(), old);
    const project = lib.findProjectConfig();
    assert.equal(project.enabled, true);
    assert.equal(project.rules, 'tiny');
    for (const key of ['terse', 'consensus', 'split', 'research', 'workers']) assert.equal(Object.hasOwn(project, key), false, key);
    assert.deepEqual(project.use, { only: ['claude'], providersOff: ['codex', 'perplexity'], modelsOff: [] });
    for (const value of [undefined, null, 'bad', 'full', true]) assert.equal(lib.normalizeProject({ rules: value }).rules, 'tiny');
    assert.deepEqual(lib.normalizeUse({ only: ['claude'], providersOff: ['grok'] }), { only: ['claude'], providersOff: ['grok'], modelsOff: [] });
    assert.doesNotThrow(() => cli.run(['settings']));
    assert.doesNotThrow(() => cli.run(['status']));
    assert.match(cli.run(['set', 'profile', 'frugal']), /Effect:/);
    assert.equal(lib.findProjectConfig().profile, 'frugal');
  });
  test('all removed forms fail without writes', () => {
    const removed = [['profile', 'frugal'], ['terse', 'on'], ['consensus', 'on'], ['allow-training', 'on'],
      ['workers', 'codex=on'], ['statusline'], ['statusline', 'always'], ['context'], ['context', '100000'], ['context', 'off'],
      ['providers', 'enable', 'grok'], ['providers', 'disable', 'claude'], ['explain', 'profile'], ['only', 'claude'], ['only', 'off'],
      ['models'], ['stats'], ['boss'], ['free-models'], ['split', 'on'], ['research', 'on'], ['rules', 'full']];
    for (const args of removed) assert.throws(() => cli.run(args), undefined, args.join(' '));
    assert.equal(fs.existsSync(lib.getPaths().projectsFile), false);
    assert.equal(fs.existsSync(path.join(process.env.QUOTA_BOSS_HOME, 'config', 'providers.json')), false);
  });
  test('help groups public commands and hides worker commands; unknown and empty commands fail with help', () => {
    const help = cli.run(['help']);
    for (const group of ['Start:', 'Settings:', 'Providers:', 'Reports:']) assert.ok(help.includes(group));
    for (const name of ['usage', 'timing', 'feedback', 'rules', 'graph', 'verify', 'handoff', 'worktree', 'providers', 'tools']) assert.doesNotMatch(help, new RegExp('\b' + name + '\b'));
    const commands = help.split('\n').filter(line => line.startsWith('  ')).map(line => line.trim().split(/[\s,]+/)[0]);
    for (const removed of ['explain', 'only', 'models', 'stats', 'context', 'boss', 'free-models']) {
      assert.ok(!commands.includes(removed), removed);
      assert.doesNotMatch(help, new RegExp('(^|\s)' + removed + '(\s|$)', 'm'), removed);
    }
    for (const name of [...removedSettings, 'terse']) assert.doesNotMatch(help, new RegExp('set ' + name + '\b'));
    for (const kept of ['setup', 'on', 'off', 'status', 'doctor', 'settings', 'set', 'use', 'cap', 'add-api', 'local', 'savings', 'route']) assert.ok(commands.includes(kept), kept);
    assert.match(help, /remove-api/);
    for (const args of [[], ['missing']]) assert.throws(() => cli.run(args), { message: help });
  });
  test('wrong arguments show only the relevant usage line', () => {
    assert.throws(() => cli.run(['cap', 'codex']), { message: 'Usage: quota-boss cap <id> <fiveHour|daily|weekly|monthly> <1-100|off> [--project]' });
    assert.throws(() => cli.run(['settings', 'extra']), { message: 'Usage: quota-boss settings' });
    assert.throws(() => cli.run(['providers', 'enable', 'claude']), error => error.message.startsWith('Usage: quota-boss providers ') && !error.message.includes('enable'));
  });
  test('settings shows every kept setting with its change command and one-line help, and no removed one', () => {
    const output = cli.run(['settings']);
    const help = require('../scripts/settings').HELP;
    for (const name of Object.keys(choices)) {
      assert.ok(output.split('\n').some(line => line.startsWith(name + ' ') && line.includes('set ' + name + ' ')), name);
      assert.ok(output.includes(help[name].what), name);
    }
    for (const name of ['enabled', 'host']) assert.ok(output.includes(help[name].what), name);
    assert.doesNotMatch(output, /undefined|explain/);
    for (const name of removedSettings) assert.ok(!output.split('\n').some(line => line.startsWith(name + ' ')), name);
    assert.match(output, /on \/ off/); assert.match(output, /on --host <claude-code\|codex\|generic>/);
    assert.match(output, /use <id> on\|off/); assert.match(output, /cap <provider>/);
  });
  test('use refuses local providers and missing Claude uses the global provider switch', t => {
    assert.throws(() => cli.run(['use', 'ollama', 'on']), /Local models have their own switch: quota-boss local on <model>/);
    t.mock.method(lib, 'findExecutable', () => null);
    const output = cli.run(['on', '--host', 'generic']);
    assert.match(output, /Claude CLI not found/); assert.match(output, /quota-boss use claude on/);
    const file = path.join(process.env.QUOTA_BOSS_HOME, 'config', 'providers.json');
    assert.equal(lib.readJson(file).providers.claude.enabled, false);
    cli.run(['use', 'claude', 'on']); assert.equal(lib.readJson(file).providers.claude.enabled, true);
    cli.run(['use', 'claude', 'off']); assert.equal(lib.readJson(file).providers.claude.enabled, false);
  });
});
