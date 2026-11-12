'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const run = require('../scripts/codex-run');

const script = path.join(__dirname, '..', 'scripts', 'codex-run.js');

function fakeCodex(dir, behaviour) {
  const file = path.join(dir, 'fake-codex.js');
  fs.writeFileSync(file, `
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify(args));
const input = fs.readFileSync(0, 'utf8');
const out = args[args.indexOf('-o') + 1];
if (${JSON.stringify(behaviour)} === 'limit') { process.stderr.write("ERROR: You've hit your usage limit."); process.exit(1); }
console.log(JSON.stringify({ type: 'thread.started', thread_id: '0199aaaa-bbbb-cccc-dddd-eeeeffff0000' }));
fs.writeFileSync(out, 'done: ' + input.trim() + '\\n' + Array.from({ length: 80 }, (_, i) => 'line ' + i).join('\\n'));
`);
  return file;
}

function exec(args, env, input = 'build it') {
  return spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });
}

test('parseArgs accepts only safe sandboxes, efforts and ids', () => {
  assert.equal(run.parseArgs(['--model', 'gpt-6.1-sol', '--sandbox', 'workspace-write']).sandbox, 'workspace-write');
  assert.throws(() => run.parseArgs(['--model', 'gpt-6.1-sol', '--sandbox', 'danger-full-access']), /sandbox/);
  assert.throws(() => run.parseArgs(['--model', 'gpt;rm -rf', '--sandbox', 'read-only']), /model/);
  assert.throws(() => run.parseArgs(['--model', 'gpt-6.1-sol', '--effort', 'ultra']), /effort/);
  assert.throws(() => run.parseArgs(['--model', 'gpt-6.1-sol', '--resume', '$(id)']), /resume/);
  assert.throws(() => run.parseArgs(['--model', 'gpt-6.1-sol', '--yolo', 'x']), /Usage/);
});

test('buildArgs never enables approvals bypass and puts resume ids after options', () => {
  const fresh = run.buildArgs({ model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only' }, 'out.md');
  assert.deepEqual(fresh.slice(0, 3), ['exec', '-m', 'gpt-6.1-sol']);
  assert.ok(fresh.includes('sandbox_mode=read-only') && fresh.includes('approval_policy=never'));
  assert.ok(!fresh.some(a => /dangerously|full-access/.test(a)));
  const resumed = run.buildArgs({ model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only', resume: '0199aaaa-bbbb' }, 'out.md');
  assert.deepEqual(resumed.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(resumed.slice(-2), ['0199aaaa-bbbb', '-']);
});

test('successful run prints one status line with session id, truncates the report and records the duration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-codex-run-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const result = exec(['--model', 'gpt-6.1-sol', '--sandbox', 'workspace-write', '--category', 'implementation', '--tier', 'normal'],
    { QUOTA_BOSS_CODEX_JS: fakeCodex(dir, 'ok'), QUOTA_BOSS_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.match(lines[0], /^codex-run: ok \| model gpt-6\.1-sol @medium \| workspace-write \| \d+s \| session 0199aaaa-bbbb-cccc-dddd-eeeeffff0000$/);
  assert.equal(lines[1], 'done: build it');
  assert.match(lines.at(-1), /more lines cut/);
  assert.ok(lines.length <= 62);
  const runs = fs.readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(runs[0].model, 'gpt-6.1-sol');
  assert.equal(runs[0].ok, true);
  assert.equal(typeof runs[0].seconds, 'number');
});

test('usage limit is reported as FAILED with a feedback hint and non-zero exit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-codex-run-'));
  const result = exec(['--model', 'gpt-6.1-sol'], { QUOTA_BOSS_CODEX_JS: fakeCodex(dir, 'limit'), QUOTA_BOSS_HOME: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^codex-run: FAILED \(usage limit\)/);
  assert.match(result.stdout, /feedback gpt-6\.1-sol implementation normal unavailable/);
});

test('Windows child PATH drops Microsoft Store aliases and keeps everything else', () => {
  const env = { Path: 'C:\\Program Files\\PowerShell\\7;C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps;"C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\Microsoft.PowerShell_8wekyb3d8bbwe";C:\\Windows\\System32' };
  assert.equal(run.withoutStoreAliases(env, 'win32').Path, 'C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32');
  assert.match(env.Path, /WindowsApps/);
  assert.equal(run.withoutStoreAliases(env, 'linux'), env);
  assert.deepEqual(run.withoutStoreAliases({ OTHER: 'x' }, 'win32'), { OTHER: 'x' });
});

test('Codex always starts in the project, for executables as well as the npm entry point', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-codex-project-'));
  const direct = run.spawnPlan({ executable: '/usr/local/bin/codex', prefix: [] }, ['exec', '-'], { PATH: '/usr/bin' }, 'linux', project);
  assert.equal(direct.file, '/usr/local/bin/codex');
  assert.deepEqual(direct.args, ['exec', '-']);
  assert.equal(direct.options.cwd, project);
  assert.equal(direct.options.shell, false);
  const viaNode = run.spawnPlan({ file: 'C:\\node\\node.exe', prefix: ['C:\\npm\\codex.js'] }, ['exec', '-'],
    { Path: 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps;C:\\node' }, 'win32', project);
  assert.deepEqual(viaNode.args, ['C:\\npm\\codex.js', 'exec', '-']);
  assert.equal(viaNode.options.cwd, project);
  assert.equal(viaNode.options.env.Path, 'C:\\node');
  assert.equal(viaNode.options.env.NoDefaultCurrentDirectoryInExePath, '1');
});

test('a blocked sandbox shell adds a warning without hiding the report', () => {
  assert.equal(run.shellBlocked('{"output":"CreateProcessAsUserW failed: 5"}'), true);
  assert.equal(run.shellBlocked('{"output":"all good"}'), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-codex-run-'));
  const file = fakeCodex(dir, 'ok');
  fs.appendFileSync(file, "console.log(JSON.stringify({ type: 'item', text: 'CreateProcessAsUserW failed: 5' }));\n");
  const result = exec(['--model', 'gpt-6.1-sol'], { QUOTA_BOSS_CODEX_JS: file, QUOTA_BOSS_HOME: dir });
  const lines = result.stdout.trim().split('\n');
  assert.match(lines[1], /^Warning: Codex could not start a shell/);
  assert.equal(lines[2], 'done: build it');
});

test('empty prompt is rejected before Codex starts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-codex-run-'));
  const result = exec(['--model', 'gpt-6.1-sol'], { QUOTA_BOSS_CODEX_JS: fakeCodex(dir, 'ok'), QUOTA_BOSS_HOME: dir }, '   ');
  assert.equal(result.status, 2);
  assert.equal(fs.existsSync(path.join(dir, 'args.json')), false);
});
