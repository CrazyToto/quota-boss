'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('../scripts/lib');

test.describe('pplx', () => {
let temporary;
let project;
let savedEnv;
let savedCwd;

test.beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-test-'));
  project = path.join(temporary, 'project');
  fs.mkdirSync(project);
  savedCwd = process.cwd();
  savedEnv = Object.fromEntries(['QUOTA_BOSS_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'QUOTA_BOSS_NO_CLIPBOARD'].map(key => [key, process.env[key]]));
  process.env.QUOTA_BOSS_HOME = path.join(temporary, 'quota-boss');
  process.env.CLAUDE_CONFIG_DIR = path.join(temporary, 'claude');
  process.env.CODEX_HOME = path.join(temporary, 'codex');
  process.env.QUOTA_BOSS_NO_CLIPBOARD = '1';
  process.chdir(project);
});

test.afterEach(() => {
  process.chdir(savedCwd);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});

function enable(config = {}) {
  lib.saveProject(project, { enabled: true, profile: 'balanced', ...config });
}

function limits(c5h = 4, cWeek = 49, x5h = 0, xWeek = 2) {
  return { claude: { five_hour: { used_percentage: c5h }, seven_day: { used_percentage: cWeek } },
    codex: { primary: { used_percent: x5h }, secondary: { used_percent: xWeek } } };
}

function codexLog(used = 0, weekly = 2) {
  const file = path.join(process.env.CODEX_HOME, 'sessions', 'nested', 'log.jsonl');
  lib.atomicWrite(file, JSON.stringify({ timestamp: new Date().toISOString(), payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: used, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 },
    secondary: { used_percent: weekly, window_minutes: 10080, resets_at: Date.now() / 1000 + 86400 } } } }) + '\n');
  return file;
}

function invoke(main, input = '', args = []) {
  let stdout = '';
  let stderr = '';
  const original = { read: fs.readSync, out: process.stdout.write, err: process.stderr.write,
    argv: process.argv, exitCode: process.exitCode };
  const bytes = Buffer.from(input);
  let offset = 0;
  fs.readSync = (fd, buffer, start, length, position) => {
    if (fd !== 0) return original.read(fd, buffer, start, length, position);
    const count = bytes.copy(buffer, start, offset, offset + length);
    offset += count;
    return count;
  };
  process.stdout.write = chunk => { stdout += String(chunk); return true; };
  process.stderr.write = chunk => { stderr += String(chunk); return true; };
  process.argv = [process.execPath, 'quota-boss-test', ...args];
  process.exitCode = 0;
  try { main(); return { stdout, stderr, status: process.exitCode }; }
  finally {
    fs.readSync = original.read;
    process.stdout.write = original.out;
    process.stderr.write = original.err;
    process.argv = original.argv;
    process.exitCode = original.exitCode;
  }
}

const bridge = require('../scripts/pplx');

function command(args, input = '') { return invoke(bridge.main, input, args); }
function pending() { return path.join(process.env.QUOTA_BOSS_HOME, 'pplx', 'pending.md'); }

test('ask saves prompt and model hint with clipboard explicitly disabled', () => {
  assert.equal(process.env.QUOTA_BOSS_NO_CLIPBOARD, '1');
  assert.equal(bridge.copyPrompt('must not copy'), false);
  const result = command(['ask', '--model', 'Pro', 'Explain', 'atomic', 'writes']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(fs.readFileSync(pending(), 'utf8'), /Model hint: Pro\n\nExplain atomic writes/);
  assert.match(result.stdout, /Open Perplexity/);
  assert.ok(result.stdout.includes('node "' + path.join(__dirname, '..', 'scripts', 'pplx.js') + '" result'));
  assert.doesNotMatch(result.stdout, /copied to clipboard/);
  assert.deepEqual(fs.readdirSync(path.dirname(pending())), ['pending.md']);
});

test('stdin prompt and multiline answer round-trip and pending is cleared only after saving', () => {
  const prompt = 'Research this\nInclude sources; $(do not execute)';
  assert.equal(command(['ask'], prompt).status, 0);
  assert.match(fs.readFileSync(pending(), 'utf8'), /Include sources; \$\(do not execute\)/);
  const answer = 'Answer line one\nAnswer line two\n';
  const result = command(['result'], answer);
  assert.equal(result.status, 0);
  const file = result.stdout.trim();
  assert.equal(path.dirname(file), path.dirname(pending()));
  assert.match(path.basename(file), /^\d+\.md$/);
  assert.equal(fs.readFileSync(file, 'utf8'), answer);
  assert.equal(fs.existsSync(pending()), false);
  const second = command(['result'], 'Another answer');
  assert.notEqual(second.stdout, result.stdout);
  assert.equal(fs.readFileSync(second.stdout.trim(), 'utf8'), 'Another answer');
});

test('empty answer preserves pending and bad commands fail without touching clipboard', () => {
  command(['ask', 'Pending question']);
  for (const [args, stdin] of [[['result'], '  \n'], [['result', 'extra'], 'answer'], [['ask', '--model'], ''],
    [['ask', '--unknown'], ''], [['ask'], ''], [['unknown'], '']]) {
    const result = command(args, stdin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^pplx: /);
    assert.equal(result.stdout, '');
  }
  assert.match(fs.readFileSync(pending(), 'utf8'), /Pending question/);
});

test('oversized stdin is rejected before writing pending', () => {
  const result = command(['ask'], 'x'.repeat(1024 * 1024 + 1));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Input too large/);
  assert.equal(fs.existsSync(pending()), false);
});

});
