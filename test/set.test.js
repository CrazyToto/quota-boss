'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const cli = require('../scripts/quota-boss');

const choices = { profile: 'frugal', 'short-answers': 'on', consensus: 'off', training: 'on',
  'codex-tasks': 'off', 'gpt-reviews': 'off', perplexity: 'off', statusline: 'always', context: '100000' };
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
        const worker = { 'codex-tasks': 'codex', 'gpt-reviews': 'gpt', perplexity: 'perplexity' }[name];
        assert.equal(worker ? project.workers[worker] : project[{ 'short-answers': 'terse', training: 'allowTrainingProviders' }[name] || name], value === 'on');
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
  test('all removed forms fail without writes, and context still reports', () => {
    const removed = [['profile', 'frugal'], ['terse', 'on'], ['consensus', 'on'], ['allow-training', 'on'],
      ['workers', 'codex=on'], ['statusline'], ['statusline', 'always'], ['context', '100000'], ['context', 'off'],
      ['providers', 'enable', 'grok'], ['providers', 'disable', 'claude']];
    for (const args of removed) assert.throws(() => cli.run(args), undefined, args.join(' '));
    assert.match(cli.run(['context']), /Change with: quota-boss set context/);
    assert.equal(fs.existsSync(lib.getPaths().projectsFile), false);
    assert.equal(fs.existsSync(path.join(process.env.QUOTA_BOSS_HOME, 'config', 'providers.json')), false);
  });
  test('help groups public commands and hides worker commands; unknown and empty commands fail with help', () => {
    const help = cli.run(['help']);
    for (const group of ['Start:', 'Settings:', 'Providers and models:', 'Reports:']) assert.ok(help.includes(group));
    for (const name of ['usage', 'timing', 'feedback', 'rules', 'graph', 'verify', 'handoff']) assert.doesNotMatch(help, new RegExp('\\b' + name + '\\b'));
    for (const args of [[], ['missing']]) assert.throws(() => cli.run(args), { message: help });
  });
  test('wrong arguments show only the relevant usage line', () => {
    assert.throws(() => cli.run(['cap', 'codex']), { message: 'Usage: quota-boss cap <id> <fiveHour|daily|weekly|monthly> <1-100|off> [--project]' });
    assert.throws(() => cli.run(['settings', 'extra']), { message: 'Usage: quota-boss settings' });
    assert.throws(() => cli.run(['providers', 'enable', 'claude']), error => error.message.startsWith('Usage: quota-boss providers ') && !error.message.includes('enable'));
  });
  test('settings shows all exact change commands and explain accepts only public setting names', () => {
    const output = cli.run(['settings']);
    for (const name of Object.keys(choices)) {
      assert.ok(output.split('\n').some(line => line.startsWith(name + ' ') && line.includes('set ' + name + ' ')), name);
      assert.doesNotMatch(cli.run(['explain', name]), /undefined/);
    }
    assert.match(output, /on \/ off/); assert.match(output, /on --host <claude-code\|codex\|generic>/);
    assert.match(output, /use <id> on\|off/); assert.match(output, /cap <provider>/);
    for (const name of ['terse', 'allowTrainingProviders', 'workers.codex', 'workers.gpt', 'workers.perplexity']) assert.throws(() => cli.run(['explain', name]), /Unknown setting/);
    for (const name of ['enabled', 'host', 'providers.claude', 'caps.codex.weekly']) assert.doesNotMatch(cli.run(['explain', name]), /undefined/);
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
