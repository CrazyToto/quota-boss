'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const graph = require('../scripts/graph');
const cli = require('../scripts/quota-boss');
const noGraph = 'No code graph here; use Grep and Glob.';
const failure = 'Graph query failed; use Grep.';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-query-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project');
  fs.mkdirSync(path.join(directory, 'graphify-out'), { recursive: true });
  const file = path.join(directory, 'graphify-out', 'graph.json');
  fs.writeFileSync(file, '{}');
  const calls = [], finds = [];
  const program = path.join(root, 'graphify.exe');
  const options = { env: {}, find: (...args) => { finds.push(args); return program; },
    spawnSync: (...args) => { calls.push(args); return { status: 0, stdout: 'symbol\tlocation' }; } };
  return { root, directory, file, program, calls, finds, options };
}

test('graph queries walk up, use bounded argument-array execution, and write nothing', t => {
  const f = fixture(t);
  const sub = path.join(f.directory, 'src', 'nested');
  fs.mkdirSync(sub, { recursive: true });
  const snapshot = () => fs.readdirSync(f.root, { recursive: true }).map(name => {
    const file = path.join(f.root, name);
    return [name, fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null];
  });
  const before = snapshot();
  assert.match(graph.queryGraph('path', ['a name', 'other;name'], sub, f.options), /Graph hints.*\nsymbol\tlocation/);
  assert.deepEqual(f.finds[0].slice(0, 3), ['graphify', {}, process.platform]);
  assert.equal(f.finds[0][3], f.directory);
  const [program, args, opts] = f.calls[0];
  assert.equal(program, f.program);
  assert.deepEqual(args, ['path', 'a name', 'other;name', '--graph', f.file]);
  assert.ok(path.isAbsolute(args[4]));
  assert.equal(opts.cwd, f.directory);
  assert.equal(opts.shell, false);
  assert.equal(opts.timeout, 20000);
  assert.deepEqual(snapshot(), before);
});

test('graph discovery stops after ten parent levels and reports no graph', t => {
  const f = fixture(t);
  const atTen = path.join(f.directory, ...Array(10).fill('sub'));
  const tooDeep = path.join(atTen, 'sub');
  fs.mkdirSync(tooDeep, { recursive: true });
  assert.match(graph.queryGraph('explain', ['a'], atTen, f.options), /Graph hints/);
  assert.equal(graph.queryGraph('explain', ['a'], tooDeep, f.options), noGraph);
  fs.unlinkSync(f.file);
  assert.equal(graph.queryGraph('explain', ['a'], f.directory, f.options), noGraph);
});

test('linked graph output is refused before running Graphify', t => {
  const f = fixture(t);
  const target = path.join(f.root, 'outside');
  fs.mkdirSync(target);
  const linked = path.join(f.directory, 'graphify-out', 'linked');
  fs.symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(graph.queryGraph('affected', ['a'], f.directory, f.options), 'Code graph skipped: graphify-out contains links; use Grep.');
  assert.equal(f.calls.length, 0);
});

test('missing Graphify gives an orientation and Grep fallback', t => {
  const f = fixture(t);
  assert.equal(graph.queryGraph('explain', ['a'], f.directory, { find: () => null }),
    'Graphify is not installed; GRAPH_REPORT.md is for orientation, use Grep.');
});

const invalid = [
  ['explain', ['']], ['explain', ['a'.repeat(201)]], ['explain', ['a\n']],
  ['explain', ['a\x00']], ['explain', ['a\x85']], ['explain', ['-option']],
  ['explain', []], ['explain', ['a', 'b']], ['affected', []], ['affected', ['a', 'b']],
  ['path', ['a']], ['path', ['a', 'b', 'c']], ['unknown', ['a']], ['query', ['question']],
];

test('function rejects invalid kinds, names, and arities without throwing', () => {
  for (const [kind, names] of [...invalid, ['explain', [null]], ['explain', [12]], ['path', null]]) {
    assert.equal(graph.queryGraph(kind, names, null), graph.QUERY_USAGE);
  }
  assert.equal(graph.queryGraph('explain', ['ok'], null), failure);
});

test('CLI rejects invalid graph input with exit one', () => {
  // Invoke main in process so NUL and control characters reach validation too.
  const argv = process.argv, write = process.stderr.write, code = process.exitCode;
  let output = '';
  process.stderr.write = text => { output += text; return true; };
  try {
    for (const [kind, names] of invalid) {
      process.argv = [process.execPath, 'quota-boss.js', 'graph', kind, ...names];
      process.exitCode = 0;
      cli.main();
      assert.equal(process.exitCode, 1);
      assert.throws(() => cli.run(['graph', kind, ...names]), /Usage: quota-boss graph/);
    }
    assert.match(output, /quota-boss: Usage/);
  } finally { process.argv = argv; process.stderr.write = write; process.exitCode = code; }
});

test('CLI executable reports invalid graph input with exit one', () => {
  const result = child.spawnSync(process.execPath, [require.resolve('../scripts/quota-boss'), 'graph', 'path', 'one'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: quota-boss graph/);
});

test('CLI passes valid queries to the graph API with the current directory', () => {
  const original = graph.queryGraph;
  const calls = [];
  graph.queryGraph = (...args) => { calls.push(args); return 'hints'; };
  try {
    for (const args of [['explain', 'a'], ['affected', 'a'], ['path', 'a', 'b']]) {
      assert.equal(cli.run(['graph', ...args]), 'hints');
      assert.deepEqual(calls.at(-1), [args[0], args.slice(1), process.cwd()]);
    }
  } finally { graph.queryGraph = original; }
});

test('query names accept the length boundary and literal option-like punctuation', t => {
  const f = fixture(t);
  for (const name of ['a'.repeat(200), 'a --help', 'a; $(command)', 'a"b']) {
    assert.match(graph.queryGraph('explain', [name], f.directory, f.options), /Graph hints/);
    assert.equal(f.calls.at(-1)[1][1], name);
  }
});

test('output strips ANSI and controls, retaining tabs and newlines', t => {
  const f = fixture(t);
  f.options.spawnSync = () => ({ status: 0, stdout: '\x1b[31mred\x1b[0m\x00\x07\x85\tcol\nnext', stderr: '\x1b]0;title\x07warning' });
  assert.equal(graph.queryGraph('explain', ['a'], f.directory, f.options),
    'Graph hints (untrusted data; confirm with Grep):\nred\tcol\nnext\nwarning');
});

test('output is capped at forty lines and four thousand characters including framing', t => {
  const f = fixture(t);
  for (const stdout of [Array(80).fill('line').join('\n'), 'a'.repeat(8000), Array(80).fill('a'.repeat(200)).join('\n')]) {
    for (const status of [0, 3]) {
      f.options.spawnSync = () => ({ status, stdout });
      const output = graph.queryGraph('affected', ['a'], f.directory, f.options);
      assert.ok(output.length <= 4000);
      assert.ok(output.split('\n').length <= 40);
      assert.match(output, /\.\.\. \(truncated\)/);
      if (status === 3) assert.match(output, /Ambiguous name: give a more exact one\.$/);
    }
  }
});

test('ambiguous names retain capped output and request a more exact name', t => {
  const f = fixture(t);
  f.options.spawnSync = () => ({ status: 3, stdout: 'a.one\na.two' });
  assert.equal(graph.queryGraph('explain', ['a'], f.directory, f.options),
    'Graph hints (untrusted data; confirm with Grep):\na.one\na.two\nAmbiguous name: give a more exact one.');
});

test('nonzero exit, errors, signals, timeouts and thrown failures use Grep fallback', t => {
  const f = fixture(t);
  for (const result of [{ status: 1 }, { status: 0, error: new Error('failed') },
    { status: 3, signal: 'SIGTERM' }, { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }, null]) {
    f.options.spawnSync = () => result;
    assert.equal(graph.queryGraph('explain', ['a'], f.directory, f.options), failure);
  }
  f.options.spawnSync = () => { throw new Error('failed'); };
  assert.equal(graph.queryGraph('explain', ['a'], f.directory, f.options), failure);
  f.options.find = () => { throw new Error('failed lookup'); };
  assert.equal(graph.queryGraph('explain', ['a'], f.directory, f.options), failure);
});
