'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const { doctor } = require('../scripts/diagnostics');
const hosts = require('../scripts/hosts');

function fixture(t, host, enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-doctor-'));
  const previous = { ...process.env }, cwd = process.cwd();
  for (const [key, dir] of Object.entries({ QUOTA_BOSS_HOME: 'boss', CLAUDE_CONFIG_DIR: 'claude', CODEX_HOME: 'codex' })) process.env[key] = path.join(root, dir);
  process.chdir(root);
  t.after(() => { process.chdir(cwd); process.env = previous; fs.rmSync(root, { recursive: true, force: true }); });
  lib.saveProject(root, { enabled, host });
  lib.writeJson(path.join(lib.getPaths().quotaBossHome, 'install-manifest.json'), { version: 1, home: lib.getPaths().quotaBossHome });
  lib.writeJson(path.join(lib.getPaths().quotaBossHome, 'config', 'providers.json'), { providers: { claude: { enabled: false }, codex: { enabled: false } } });
  const calls = [];
  const run = (missing = false) => doctor(false, { platform: 'linux', findExecutable: name => '/trusted/' + name,
    spawnSync: (cmd, args) => { calls.push([cmd, args]); return { status: missing ? 1 : 0, stdout: '1.2.3' }; } });
  return { root, run, calls };
}
function checkCount(output) {
  const problems = output.split('\n').filter(line => line.startsWith('Problem: '));
  for (const line of problems) assert.match(line, /^Problem: .+\. Fix: .+\.$/);
  assert.equal(output.split('\n').at(-1), problems.length ? problems.length + ' problem(s) found.' : 'No problems found.');
}
function snapshot(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(dir, entry.name), stat = fs.statSync(file);
    return [[file, stat.size, stat.mtimeMs], ...(entry.isDirectory() ? snapshot(file) : [])];
  });
}
test('Claude doctor checks hooks, status line, agents and host CLI, including when boss is off', t => {
  const f = fixture(t, 'generic', false), output = f.run(true);
  assert.match(output, /Problem: Quota Boss hooks are missing/);
  assert.match(output, /Problem: Quota Boss status line is missing/);
  assert.match(output, /Problem: Quota Boss agents are missing/);
  assert.match(output, /Problem: claude CLI not found/);
  assert.doesNotMatch(output, /Problem: codex CLI/);
  checkCount(output);
});
test('Codex doctor diagnoses missing, empty, malformed and valid managed blocks', t => {
  const f = fixture(t, 'codex');
  for (const text of ['', hosts.START + '\n' + hosts.END, hosts.START, hosts.END + hosts.START, hosts.START + hosts.END + hosts.START + hosts.END]) {
    fs.writeFileSync(path.join(f.root, 'AGENTS.md'), text);
    const output = f.run(true);
    assert.match(output, /Problem: Quota Boss managed block is (missing or empty|malformed)/);
    assert.match(output, /Problem: codex CLI not found/);
    assert.doesNotMatch(output, /Problem:.*(hooks|status line|agents are missing|claude CLI)/);
    checkCount(output);
  }
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), hosts.START + '\nrules\n' + hosts.END);
  assert.match(f.run(), /No problems found\.$/);
});
test('generic doctor requires no host CLI and is read-only without probe', t => {
  const f = fixture(t, 'generic'), before = snapshot(f.root), output = f.run(true);
  assert.doesNotMatch(output, /Problem:/);
  assert.match(output, /Config: OK/);
  checkCount(output);
  assert.deepEqual(snapshot(f.root), before);
  assert.ok(f.calls.every(([, args]) => args[0] === '--version' || args[0] === 'mcp'));
});
test('enabled providers require their CLI even on generic host', t => {
  const f = fixture(t, 'generic');
  lib.writeJson(path.join(lib.getPaths().quotaBossHome, 'config', 'providers.json'), { providers: { claude: { enabled: false }, codex: { enabled: true } } });
  assert.match(f.run(true), /Problem: codex CLI not found\. Fix: npm install -g @openai\/codex\./);
});
test('doctor names invalid JSON and semantic config files, and counts one config problem', t => {
  const f = fixture(t, 'generic');
  for (const [name, data] of [['models', '{bad'], ['models', '{"models":[]}'], ['models', JSON.stringify({ models: { bad: { pool: 'codex' } } })], ['thresholds', JSON.stringify({ claude: { soft: 'bad' } })], ['providers', '{bad']]) {
    const file = path.join(lib.getPaths().quotaBossHome, 'config', name + '.json');
    lib.atomicWrite(file, data);
    const output = f.run();
    assert.match(output, new RegExp('Problem: Config: invalid .*' + name + '\\.json'));
    assert.equal(output.split('\n').filter(line => line.startsWith('Problem: Config:')).length, 1);
    checkCount(output);
    fs.unlinkSync(file);
  }
});
test('doctor reports the same unknown boss assumption as route', t => {
  const f = fixture(t, 'claude-code');
  lib.writeJson(path.join(lib.getPaths().quotaBossHome, 'config', 'providers.json'), { providers: { claude: { enabled: true }, codex: { enabled: false } } });
  lib.writeJson(lib.getPaths().stateFile, { bossModel: 'claude-opus-5-6' });
  const before = snapshot(f.root), output = f.run();
  assert.match(output, /Problem: boss model claude-opus-5-6 is not in the registry; routing assumes Opus 5.5\. Fix: add it to config\/models.json to route exactly\./);
  assert.deepEqual(snapshot(f.root), before);
  checkCount(output);
});

test('complete Claude installation has no problems and doctor leaves it untouched', t => {
  const f = fixture(t, 'claude-code'), paths = lib.getPaths();
  const command = name => 'node "' + lib.trustedHomeText(paths.quotaBossHome) + '/scripts/' + name + '"';
  lib.writeJson(path.join(paths.claudeDir, 'settings.json'), {
    hooks: Object.fromEntries([['SessionStart', 'hook-session.js'], ['UserPromptSubmit', 'hook-prompt.js']].map(([event, name]) => [event, [{ hooks: [{ command: command(name) }] }]])),
    statusLine: { command: command('statusline.js') }
  });
  fs.mkdirSync(path.join(paths.claudeDir, 'agents'));
  for (const name of fs.readdirSync(path.join(__dirname, '..', 'agents'))) fs.writeFileSync(path.join(paths.claudeDir, 'agents', name), 'agent');
  const before = snapshot(f.root), output = f.run();
  assert.match(output, /No problems found\.$/);
  assert.deepEqual(snapshot(f.root), before);
});


test('Claude doctor reports measured startup inventory without extra calls or writes', t => {
  const f = fixture(t, 'claude-code'), paths = lib.getPaths();
  const id = lib.projectHash(f.root);
  lib.writeJson(paths.stateFile, { contexts: Object.fromEntries(Array.from({ length: 18 }, (_, i) => ['s' + i, { project: id, start: 45000, updated_at: i }]).concat([['elsewhere', { project: 'other', start: 999999 }]])) });
  for (const folder of [path.join(paths.claudeDir, 'skills', 'global'), path.join(f.root, '.claude', 'skills', 'local')]) {
    fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'SKILL.md'), 'skill');
  }
  fs.mkdirSync(path.join(paths.claudeDir, 'skills', 'empty'));
  fs.writeFileSync(path.join(paths.claudeDir, 'skills', 'not-a-directory'), 'skill');
  fs.writeFileSync(path.join(paths.claudeDir, 'CLAUDE.md'), 'x'.repeat(800));
  fs.writeFileSync(path.join(f.root, 'CLAUDE.md'), 'x'.repeat(400));
  fs.writeFileSync(path.join(f.root, '.claude', 'CLAUDE.md'), 'x'.repeat(400));
  lib.writeJson(path.join(paths.claudeDir, 'settings.json'), { enabledPlugins: { one: true, two: true, disabled: false, invalid: 'true' } });
  let lists = 0;
  const before = snapshot(f.root);
  const output = doctor(false, { platform: 'linux', findExecutable: name => '/trusted/' + name,
    spawnSync: (cmd, args) => {
      if (args.join(' ') === 'mcp list') { lists++; return { status: 0, stdout: 'Checking MCP server health...\n\u001b[32mserena: command - Connected\u001b[0m\nclaude.ai Example Docs: https://example.com - Failed\n' }; }
      return { status: 0, stdout: '1.2.3' };
    } });
  assert.equal(lists, 1);
  assert.match(output, /Session start: about 45k tokens \(median of 18 sessions in this project\). Every message reads them again\./);
  assert.match(output, /Loaded at start: 2 MCP servers, 2 skills, 2 plugins, CLAUDE.md files about 0.4k tokens. Quota Boss itself adds about 3k to 4k\./);
  assert.match(output, /Tip: type \/context/);
  assert.deepEqual(snapshot(f.root), before);
  checkCount(output);
});

test('startup measurements handle missing data, failed MCP lists, and the tip boundary', t => {
  const f = fixture(t, 'claude-code'), paths = lib.getPaths();
  assert.match(f.run(true), /Session start: not measured yet \(open a boss-mode session in Claude Code first\)./);
  assert.match(f.run(true), /Loaded at start: 0 skills, 0 plugins/);
  assert.doesNotMatch(f.run(true), /Tip: type \/context/);
  for (const start of [29999, 30000]) {
    lib.writeJson(paths.stateFile, { contexts: { one: { project: lib.projectHash(f.root), start } } });
    const output = f.run(true);
    assert.equal(output.includes('Tip: type /context'), start >= 30000);
    assert.doesNotMatch(output, /Loaded at start: \d+ MCP servers/);
    checkCount(output);
  }
  lib.saveProject(f.root, { enabled: true, host: 'codex' });
  assert.doesNotMatch(f.run(), /Session start:|Loaded at start:|Tip: type \/context/);
});

test('doctor ignores linked CLAUDE.md files', t => {
  const f = fixture(t, 'claude-code'), paths = lib.getPaths();
  const target = path.join(f.root, 'instructions'); fs.writeFileSync(target, 'x'.repeat(8000));
  try { fs.symlinkSync(target, path.join(f.root, 'CLAUDE.md')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Creating symlinks is unavailable'); return; } throw error; }
  assert.match(f.run(), /CLAUDE.md files about 0.0k tokens/);
});


test('doctor examines at most five hundred entries per skills folder', t => {
  const f = fixture(t, 'claude-code'), paths = lib.getPaths();
  const folder = path.join(paths.claudeDir, 'skills');
  fs.mkdirSync(folder, { recursive: true });
  const original = fs.opendirSync, stat = fs.lstatSync;
  let reads = 0, closed = false;
  fs.opendirSync = file => file === folder ? {
    readSync: () => { reads++; return { name: 'skill', isDirectory: () => true }; },
    closeSync: () => { closed = true; }
  } : original(file);
  fs.lstatSync = file => file === path.join(folder, 'skill', 'SKILL.md') ? { isFile: () => true } : stat(file);
  try { assert.match(f.run(), /Loaded at start: 0 MCP servers, 500 skills/); }
  finally { fs.opendirSync = original; fs.lstatSync = stat; }
  assert.equal(reads, 500);
  assert.equal(closed, true);
});
