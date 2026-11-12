'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'quota-boss.js');

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-local-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  return dir;
}
const cli = (dir, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, QUOTA_BOSS_HOME: dir } });
const ollama = dir => JSON.parse(fs.readFileSync(path.join(dir, 'config', 'providers.json'), 'utf8')).providers.ollama;

test('local models are hidden from normal setup and the normal switch refuses them', () => {
  const dir = home();
  assert.doesNotMatch(cli(dir, 'settings').stdout, /ollama/);
  const refused = cli(dir, 'use', 'ollama', 'on');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /local on <model>/);
  assert.match(cli(dir, 'local').stdout, /off/);
});

test('turning local models on requires a real model and shows them afterwards', () => {
  const dir = home();
  const result = cli(dir, 'local', 'on', 'llama3.2:3b');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ollama pull llama3\.2:3b/);
  assert.deepEqual(ollama(dir).cli.args, ['run', 'llama3.2:3b', '{prompt}']);
  assert.equal(ollama(dir).enabled, true);
  assert.match(cli(dir, 'settings').stdout, /ollama/);
  assert.match(cli(dir, 'local').stdout, /model llama3\.2:3b/);
  assert.match(cli(dir, 'tools').stdout, /ollama/);
});

test('turning them off hides them again', () => {
  const dir = home();
  cli(dir, 'local', 'on', 'llama3.2:3b');
  assert.equal(cli(dir, 'local', 'off').status, 0);
  assert.equal(ollama(dir).enabled, false);
  assert.doesNotMatch(cli(dir, 'settings').stdout, /ollama/);
});

test('unsafe model names change nothing', () => {
  const dir = home();
  for (const model of ['--yolo', '<model>', 'a b', 'a;rm', '']) assert.notEqual(cli(dir, 'local', 'on', model).status, 0, model);
  assert.notEqual(cli(dir, 'local', 'on').status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'config', 'providers.json')), false);
});
