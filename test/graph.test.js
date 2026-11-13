'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const graph = require('../scripts/graph');
const wrapper = require('../scripts/graph-refresh');
const neutral = path.dirname(require.resolve('../scripts/graph'));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-graph-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project');
  fs.mkdirSync(path.join(directory, 'graphify-out'), { recursive: true });
  const file = path.join(directory, 'graphify-out', 'graph.json');
  const lock = path.join(directory, 'graphify-out', graph.LOCK_NAME);
  fs.writeFileSync(file, '{}');
  const now = Date.now();
  const age = (target, ms) => fs.utimesSync(target, new Date(now - ms), new Date(now - ms));
  age(file, graph.STALE_MS + 1000);
  const calls = [];
  const proc = new EventEmitter();
  proc.unref = () => calls.push('unref');
  const options = { now, platform: process.platform, env: {},
    find: name => path.join(root, name + (process.platform === 'win32' ? '.exe' : '')),
    spawn: (...args) => { calls.push(args); return proc; },
    spawnSync: (...args) => { calls.push(args); return { status: 0, stdout: '.git/info/exclude\n' }; } };
  return { root, directory, file, lock, age, calls, proc, options };
}

test('setup builds locally with a bounded executable and preserves Git excludes', t => {
  const f = fixture(t);
  const exclude = path.join(f.directory, '.git', 'info', 'exclude');
  assert.match(graph.setupGraph(f.directory, f.options), /built locally; no Claude usage/);
  assert.equal(fs.readFileSync(exclude, 'utf8'), 'graphify-out/\n');
  fs.writeFileSync(exclude, '# keep\nother');
  graph.excludeOutput(f.directory, f.options);
  graph.excludeOutput(f.directory, f.options);
  assert.equal(fs.readFileSync(exclude, 'utf8'), '# keep\nother\ngraphify-out/\n');
  const [file, args, opts] = f.calls.find(call => call[1]?.[0] === 'update');
  assert.equal(file, f.options.find('graphify'));
  assert.deepEqual(args, ['update', f.directory]);
  assert.equal(opts.cwd, neutral);
  assert.equal(opts.timeout, graph.REFRESH_LIMIT_MS);
  assert.equal(opts.shell, false);
  assert.deepEqual(f.calls[0][1], ['rev-parse', '--git-path', 'info/exclude']);
  assert.equal(f.calls[0][2].cwd, f.directory);
});

test('excludes use worktree Git paths and preserve existing duplicate-free content', t => {
  const f = fixture(t);
  const exclude = path.join(f.root, 'git-worktree', 'info', 'exclude');
  f.options.spawnSync = () => ({ status: 0, stdout: exclude + '\n' });
  graph.excludeOutput(f.directory, f.options);
  fs.writeFileSync(exclude, '# keep\ngraphify-out/');
  graph.excludeOutput(f.directory, f.options);
  assert.equal(fs.readFileSync(exclude, 'utf8'), '# keep\ngraphify-out/');
});

test('setup reports update failures and continues outside Git and after filesystem errors', t => {
  const f = fixture(t);
  f.options.spawnSync = () => ({ status: 1, stderr: 'not a git repository' });
  assert.match(graph.setupGraph(f.directory, f.options), /Could not build/);
  assert.equal(fs.existsSync(path.join(f.directory, '.git')), false);
  assert.equal(graph.excludeOutput(f.directory, f.options), null);
  f.options.spawnSync = () => { throw new Error('spawn failed'); };
  assert.match(graph.setupGraph(f.directory, f.options), /Could not build/);
  fs.writeFileSync(path.join(f.directory, '.git'), 'blocked');
  f.options.spawnSync = (file, args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? '.git/info/exclude\n' : '' });
  const result = graph.setupGraph(f.directory, f.options);
  assert.match(result, /Could not exclude/);
  assert.match(result, /built locally/);
});

test('stale graph launches a detached Node wrapper, and a second session respects its lock', t => {
  const f = fixture(t);
  graph.refreshIfStale(f.directory, f.options);
  assert.equal(f.calls.length, 2);
  const [file, args, opts] = f.calls[0];
  assert.equal(file, process.execPath);
  assert.equal(args[0], require.resolve('../scripts/graph-refresh'));
  assert.equal(args[1], f.directory);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), args[2]);
  assert.equal(opts.detached, true);
  assert.equal(opts.stdio, 'ignore');
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.cwd, neutral);
  assert.equal(opts.shell, false);
  assert.equal(f.calls[1], 'unref');
  graph.refreshIfStale(f.directory, f.options);
  assert.equal(f.calls.length, 2);
});

test('fresh, absent and report-only graphs never refresh; abandoned locks can be claimed', t => {
  const f = fixture(t);
  f.age(f.file, graph.STALE_MS - 1000);
  graph.refreshIfStale(f.directory, f.options);
  assert.deepEqual(f.calls, []);
  fs.unlinkSync(f.file);
  fs.writeFileSync(path.join(f.directory, 'graphify-out', 'GRAPH_REPORT.md'), 'orientation');
  graph.refreshIfStale(f.directory, f.options);
  assert.deepEqual(f.calls, []);
  fs.writeFileSync(f.file, '{}');
  f.age(f.file, graph.STALE_MS + 1000);
  fs.writeFileSync(f.lock, 'abandoned');
  f.age(f.lock, graph.REFRESH_LIMIT_MS + 1000);
  graph.refreshIfStale(f.directory, f.options);
  assert.equal(f.calls.length, 2);
  assert.notEqual(fs.readFileSync(f.lock, 'utf8'), 'abandoned');
});

test('missing and untrusted PATH programs never refresh or receive Bash guidance', t => {
  const f = fixture(t);
  const name = process.platform === 'win32' ? 'graphify.exe' : 'graphify';
  fs.writeFileSync(path.join(f.directory, name), '', { mode: 0o755 });
  for (const value of ['', '.', 'relative', f.directory]) {
    const options = { ...f.options, find: undefined, env: { PATH: value } };
    graph.refreshIfStale(f.directory, options);
    const text = graph.sessionText(f.directory, options);
    assert.match(text, /GRAPH_REPORT.md is for orientation only/);
    assert.match(text, /Never read graphify-out\/graph.json whole/);
    assert.doesNotMatch(text, /Bash|explain/);
  }
  assert.deepEqual(f.calls, []);
});

test('trusted PATH enables concise CLI guidance with no mandatory report reading', t => {
  const f = fixture(t);
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'graphify.exe' : 'graphify'), '', { mode: 0o755 });
  const text = graph.sessionText(f.directory, { ...f.options, find: undefined, env: { PATH: bin } });
  assert.match(text, /quota-boss\.js" graph explain\|affected\|path.*Bash/);
  assert.match(text, /hints.*Grep.*Never read/);
  assert.doesNotMatch(text, /REPORT|scout/);
  assert.equal(f.calls.length, 2);
});

test('refresh errors are silent and failed spawns release their lock', t => {
  const f = fixture(t);
  let output = '';
  const stdout = process.stdout.write, stderr = process.stderr.write;
  process.stdout.write = process.stderr.write = text => { output += text; return true; };
  try {
    graph.refreshIfStale(f.directory, { ...f.options, spawn: () => { throw new Error('EPERM'); } });
    assert.equal(graph.sessionText(f.directory, { ...f.options, find: () => { throw new Error('lookup'); } }), '');
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
  assert.equal(output, '');
  graph.refreshIfStale(f.directory, { ...f.options, spawn: () => { throw new Error('EPERM'); } });
  assert.equal(fs.existsSync(f.lock), false);
  graph.refreshIfStale(f.directory, f.options);
  f.proc.emit('error', new Error('spawn failed'));
  assert.equal(fs.existsSync(f.lock), false);
  assert.doesNotThrow(() => graph.refreshIfStale(f.directory, { ...f.options, find: () => { throw new Error('lookup'); } }));
  assert.equal(graph.sessionText(f.directory, { ...f.options, find: () => { throw new Error('lookup'); } }), '');
  fs.unlinkSync(f.file);
  fs.rmSync(path.dirname(f.file), { recursive: true });
  assert.equal(graph.sessionText(f.directory, f.options), '');
});

test('a contended acquisition guard returns immediately and filesystem failures stay silent', t => {
  const f = fixture(t);
  const claim = f.lock + '.claim.lock';
  fs.writeFileSync(claim, JSON.stringify({ pid: process.pid, nonce: 'busy' }));
  graph.refreshIfStale(f.directory, f.options);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.lock), false);
  fs.unlinkSync(claim);
  fs.mkdirSync(f.lock);
  assert.doesNotThrow(() => graph.refreshIfStale(f.directory, f.options));
  assert.deepEqual(f.calls, []);
});

test('wrapper applies the time limit and cleans its lock on success, failure and exceptions', t => {
  const f = fixture(t);
  for (const result of [{ status: 0 }, { status: 1 }, { error: new Error('ETIMEDOUT') }, null]) {
    fs.writeFileSync(f.lock, 'owner');
    let seen;
    wrapper.main(f.directory, 'owner', { ...f.options, spawnSync: (file, args, options) => {
      seen = { file, args, options };
      if (result === null) throw new Error('spawn');
      return result;
    } });
    assert.equal(seen.options.timeout, 120000);
    assert.equal(seen.options.cwd, neutral);
    assert.deepEqual(seen.args, ['update', f.directory]);
    assert.equal(fs.existsSync(f.lock), false);
  }
  fs.writeFileSync(f.lock, 'replacement');
  wrapper.main(f.directory, 'old-owner', f.options);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), 'replacement');
  assert.deepEqual(f.calls, []);
  wrapper.main(f.directory, 'replacement', { ...f.options, find: () => null });
  assert.equal(fs.existsSync(f.lock), false);
  fs.writeFileSync(f.lock, 'owner');
  wrapper.main(f.directory, 'owner', { ...f.options, find: () => { throw new Error('lookup'); } });
  assert.equal(fs.existsSync(f.lock), false);
});

test('relative project paths become absolute for setup, the detached wrapper and refresh', t => {
  const f = fixture(t);
  const relative = path.relative(process.cwd(), f.directory);
  const lookups = [];
  const options = { ...f.options, find: (name, env, platform, directory) => {
    lookups.push(directory);
    return f.options.find(name);
  } };
  graph.setupGraph(relative, options);
  graph.refreshIfStale(relative, options);
  const launch = f.calls.find(call => call[0] === process.execPath);
  assert.equal(launch[1][1], f.directory);
  assert.equal(launch[2].cwd, neutral);
  wrapper.main(relative, fs.readFileSync(f.lock, 'utf8'), options);
  const updates = f.calls.filter(call => call[1]?.[0] === 'update');
  assert.equal(updates.length, 2);
  for (const [, args, opts] of updates) {
    assert.deepEqual(args, ['update', f.directory]);
    assert.equal(opts.cwd, neutral);
    assert.equal(opts.shell, false);
  }
  assert.ok(lookups.every(directory => directory === f.directory));
  assert.equal(fs.existsSync(f.lock), false);
});

test('setup allows missing graphify-out and an empty output directory', t => {
  const f = fixture(t);
  fs.rmSync(path.dirname(f.file), { recursive: true });
  assert.equal(graph.graphOutputSafe(f.directory), true);
  assert.match(graph.setupGraph(f.directory, f.options), /built locally/);
  fs.mkdirSync(path.dirname(f.file));
  assert.equal(graph.graphOutputSafe(f.directory), true);
  assert.match(graph.setupGraph(f.directory, f.options), /built locally/);
  assert.equal(f.calls.filter(call => call[1]?.[0] === 'update').length, 2);
});

const skippedGraph = 'Skipped the code graph: graphify-out contains links.';

function assertUnsafe(f) {
  assert.equal(graph.graphOutputSafe(f.directory), false);
  assert.equal(graph.setupGraph(f.directory, f.options), skippedGraph);
  assert.equal(f.calls.filter(call => call[1]?.[0] === 'update').length, 0);
  fs.writeFileSync(f.lock, 'owner');
  let output = '';
  const stdout = process.stdout.write, stderr = process.stderr.write;
  process.stdout.write = process.stderr.write = text => { output += text; return true; };
  try { assert.doesNotThrow(() => wrapper.main(f.directory, 'owner', f.options)); }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
  assert.equal(output, '');
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(f.calls.filter(call => call[1]?.[0] === 'update').length, 0);
}

function symlink(t, target, file, type) {
  try { fs.symlinkSync(target, file, type); return true; }
  catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('Creating symlinks requires permission on this system.');
    return false;
  }
}

for (const kind of ['top-level file', 'nested file', 'directory', 'output root', 'dangling file', 'junction', 'output junction']) {
  test(`setup and refresh skip a linked ${kind} without writing outside the project`, t => {
    const f = fixture(t);
    const outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside);
    const victim = path.join(outside, 'victim.js');
    fs.writeFileSync(victim, 'keep');
    const output = path.dirname(f.file);
    let target = victim, file = path.join(output, 'linked.js'), type = 'file';
    if (kind === 'nested file') {
      const nested = path.join(output, 'nested', 'deeper');
      fs.mkdirSync(nested, { recursive: true });
      file = path.join(nested, 'linked.js');
    } else if (kind === 'directory' || kind === 'junction') {
      target = outside;
      file = path.join(output, 'linked-dir');
      type = kind === 'junction' ? 'junction' : 'dir';
    } else if (kind === 'output root' || kind === 'output junction') {
      fs.rmSync(output, { recursive: true });
      fs.writeFileSync(path.join(outside, 'graph.json'), '{}');
      target = outside;
      file = output;
      type = kind === 'output junction' ? 'junction' : 'dir';
    } else if (kind === 'dangling file') {
      target = path.join(outside, 'absent');
    }
    if (!symlink(t, target, file, type)) return;
    assertUnsafe(f);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(outside, 'absent')), false);
  });
}

test('the hook does not scan output; the wrapper detects a link added after launch and releases its lock', t => {
  const f = fixture(t);
  const open = fs.opendirSync;
  fs.opendirSync = () => { throw new Error('The hook must not scan.'); };
  try { graph.refreshIfStale(f.directory, f.options); }
  finally { fs.opendirSync = open; }
  assert.equal(f.calls.length, 2);
  const token = fs.readFileSync(f.lock, 'utf8');
  const outside = path.join(f.root, 'victim');
  fs.writeFileSync(outside, 'keep');
  if (!symlink(t, outside, path.join(path.dirname(f.file), 'late-link'), 'file')) return;
  wrapper.main(f.directory, token, f.options);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(f.calls.length, 2);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('the output walk accepts depth four and rejects depth five', t => {
  const f = fixture(t);
  const fourth = path.join(path.dirname(f.file), 'one', 'two', 'three', 'four');
  fs.mkdirSync(fourth, { recursive: true });
  fs.writeFileSync(path.join(path.dirname(fourth), 'leaf'), 'ok');
  assert.equal(graph.graphOutputSafe(f.directory), true);
  assert.match(graph.setupGraph(f.directory, f.options), /built locally/);
  fs.writeFileSync(f.lock, 'owner');
  wrapper.main(f.directory, 'owner', f.options);
  assert.equal(f.calls.filter(call => call[1]?.[0] === 'update').length, 2);
  f.calls.length = 0;
  fs.writeFileSync(path.join(fourth, 'too-deep'), 'blocked');
  assertUnsafe(f);
});

test('the output walk accepts 2000 entries and rejects 2001 across directories', t => {
  const f = fixture(t);
  const output = path.dirname(f.file);
  const nested = path.join(output, 'nested');
  fs.mkdirSync(nested);
  // graph.json, nested/, its 1997 files and the wrapper lock total 2000.
  for (let i = 0; i < 1997; i++) fs.writeFileSync(path.join(nested, `entry-${i}`), '');
  fs.writeFileSync(f.lock, 'owner');
  assert.equal(graph.graphOutputSafe(f.directory), true);
  assert.match(graph.setupGraph(f.directory, f.options), /built locally/);
  wrapper.main(f.directory, 'owner', f.options);
  assert.equal(f.calls.filter(call => call[1]?.[0] === 'update').length, 2);
  f.calls.length = 0;
  fs.writeFileSync(f.lock, 'owner');
  fs.writeFileSync(path.join(output, 'one-too-many'), '');
  assertUnsafe(f);
});

for (const operation of ['lstat root', 'lstat entry', 'open', 'read', 'close']) {
  for (const code of ['EACCES', 'ENOENT']) {
    if (operation === 'lstat root' && code === 'ENOENT') continue;
    test(`output ${operation} errors (${code}) skip setup and refresh with lock cleanup`, t => {
      const f = fixture(t);
      const output = path.dirname(f.file);
      const lstat = fs.lstatSync, open = fs.opendirSync;
      const fail = () => { const error = new Error('injected walk error'); error.code = code; throw error; };
      fs.lstatSync = (file, ...args) => {
        if (operation === 'lstat root' && file === output || operation === 'lstat entry' && file === f.file) fail();
        return lstat(file, ...args);
      };
      fs.opendirSync = (...args) => {
        if (operation === 'open') fail();
        const stream = open(...args);
        return {
          readSync: () => operation === 'read' ? fail() : stream.readSync(),
          closeSync: () => { stream.closeSync(); if (operation === 'close') fail(); }
        };
      };
      try { assertUnsafe(f); }
      finally { fs.lstatSync = lstat; fs.opendirSync = open; }
    });
  }
}

test('a non-directory output root is unsafe and setup still returns normally', t => {
  const f = fixture(t);
  const output = path.dirname(f.file);
  fs.rmSync(output, { recursive: true });
  fs.writeFileSync(output, 'blocked');
  assert.equal(graph.graphOutputSafe(f.directory), false);
  assert.equal(graph.setupGraph(f.directory, f.options), skippedGraph);
  assert.equal(f.calls.filter(call => call[1]?.[0] === 'update').length, 0);
  assert.doesNotThrow(() => wrapper.main(f.directory, 'owner', f.options));
});

test('unsafe setup reports one plain line despite exclude failures; refresh preserves a replacement lock', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, '.git'), 'blocked');
  const open = fs.opendirSync;
  fs.opendirSync = () => { throw new Error('cannot inspect output'); };
  try {
    assert.equal(graph.setupGraph(f.directory, f.options), skippedGraph);
    fs.writeFileSync(f.lock, 'replacement');
    wrapper.main(f.directory, 'old-owner', f.options);
    assert.equal(fs.readFileSync(f.lock, 'utf8'), 'replacement');
    assert.equal(f.calls.filter(call => call[1]?.[0] === 'update').length, 0);
  } finally { fs.opendirSync = open; }
});

test('the setup wizard continues and prints the skipped graph line once', t => {
  const f = fixture(t);
  fs.unlinkSync(f.file);
  const outside = path.join(f.root, 'victim');
  fs.writeFileSync(outside, 'keep');
  if (!symlink(t, outside, path.join(path.dirname(f.file), 'linked'), 'file')) return;
  const answers = ['', '', '', 'y', ...Array(8).fill(''), 'y'];
  const said = [], commands = [];
  const { setup } = require('../scripts/setup-wizard');
  const result = setup([], args => { commands.push(args); return ''; }, {
    interactive: true,
    options: f.options,
    project: { directory: f.directory, profile: 'balanced', host: 'claude-code',
      workers: { codex: true, gpt: true, perplexity: true }, allowTrainingProviders: false },
    config: { providers: { providers: { codex: { enabled: true } } } },
    tools: {
      check: ids => ids.map(id => ({ id, state: 'ok', installed: '1.0' })),
      installable: () => [],
      pendingLogins: () => [],
      storedKeys: () => '',
    },
    ask: () => { assert.ok(answers.length, 'unexpected setup prompt'); return answers.shift(); },
    say: line => said.push(line),
    clear: () => {},
  });
  assert.equal(result, '');
  assert.equal(answers.length, 0);
  assert.deepEqual(commands, [['on', '--host', 'claude-code', 'balanced']]);
  const output = said.join('\n');
  assert.equal(output.split('\n').filter(line => line === skippedGraph).length, 1);
  assert.match(output, /Your settings apply/);
  assert.equal(f.calls.filter(call => call[1]?.[0] === 'update').length, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('excludeOutput refuses a linked exclude file without changing its target', t => {
  const f = fixture(t);
  const exclude = path.join(f.directory, '.git', 'info', 'exclude');
  const target = path.join(f.root, 'private-config');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(target, '# private configuration\n');
  try { fs.symlinkSync(target, exclude, 'file'); }
  catch (error) { t.skip('Cannot create a file symlink: ' + error.message); return; }
  assert.match(graph.excludeOutput(f.directory, f.options), /Could not exclude graphify-out/);
  assert.equal(fs.readFileSync(target, 'utf8'), '# private configuration\n');
  assert.equal(fs.lstatSync(exclude).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(exclude), target);
});

test('a detected graph ignores its own output once and never follows a link', t => {
  const f = fixture(t);
  const ignore = path.join(f.directory, 'graphify-out', '.gitignore');
  graph.sessionText(f.directory, { ...f.options, find: undefined, env: { PATH: '' } });
  assert.equal(fs.readFileSync(ignore, 'utf8'), '*\n');
  fs.writeFileSync(ignore, '# mine\n');
  graph.sessionText(f.directory, { ...f.options, find: undefined, env: { PATH: '' } });
  assert.equal(fs.readFileSync(ignore, 'utf8'), '# mine\n');
  const target = path.join(f.root, 'target');
  fs.unlinkSync(ignore);
  try { fs.symlinkSync(target, ignore, 'file'); } catch { return; }
  graph.ignoreOwnOutput(f.directory);
  assert.equal(fs.existsSync(target), false);
  assert.equal(graph.ignoreOwnOutput(path.join(f.root, 'missing')), undefined);
});
