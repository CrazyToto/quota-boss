'use strict';
// Hidden acceptance checks. Usage: node bench/hidden-check.js <small|medium|mixed> <run folder>. Prints "passed/total" last.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [task, dir] = process.argv.slice(2);
let passed = 0;
let total = 0;
const check = (name, fn) => {
  total++;
  try { fn(); passed++; } catch (error) { console.error('FAIL ' + name + ': ' + String(error && error.message).slice(0, 100)); }
};
const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(JSON.stringify(a) + ' != ' + JSON.stringify(b)); };
const load = file => require(path.join(dir, file));

function small() {
  const { clamp } = load('src/math.js');
  check('below', () => eq(clamp(-1, 0, 5), 0));
  check('above', () => eq(clamp(9, 0, 5), 5));
  check('inside', () => eq(clamp(3, 0, 5), 3));
  check('edge', () => eq(clamp(5, 0, 5), 5));
  check('range', () => { try { clamp(1, 5, 0); } catch (e) { if (e instanceof RangeError) return; throw e; } throw new Error('no throw'); });
}

function medium() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-bench-'));
  try {
    const file = path.join(tmp, 'tasks.json');
    const { createStore } = load('src/store.js');
    const { summary } = load('src/report.js');
    const store = createStore(file);
    const a = store.add('first');
    const b = store.add('second');
    check('add shape', () => eq(a, { id: 1, title: 'first', done: false }));
    check('next id', () => eq(b.id, 2));
    check('complete', () => { store.complete(1); eq(store.list({ done: true }).map(t => t.id), [1]); });
    check('open filter', () => eq(store.list({ done: false }).map(t => t.id), [2]));
    check('complete unknown throws', () => { let thrown = false; try { store.complete(99); } catch { thrown = true; } if (!thrown) throw new Error('no throw'); });
    check('remove true', () => eq(store.remove(2), true));
    check('remove false', () => eq(store.remove(2), false));
    check('id not reused', () => eq(store.add('third').id, 3));
    check('persisted, id not reused after reopen', () => { const again = createStore(file); again.remove(3); eq(again.add('fourth').id, 4); eq(createStore(file).list({}).map(t => t.id), [1, 4]); });
    check('summary', () => eq(summary([{ done: true }, { done: false }, { done: false }]), { total: 3, done: 1, open: 2, percentDone: 33 }));
    check('summary empty', () => eq(summary([]), { total: 0, done: 0, open: 0, percentDone: 0 }));
    const cli = (...args) => spawnSync(process.execPath, [path.join(dir, 'src/cli.js'), path.join(tmp, 'c.json'), ...args], { encoding: 'utf8', timeout: 30000 });
    check('cli add', () => eq(cli('add', 'write', 'docs').status, 0));
    check('cli list', () => { const r = cli('list'); if (!/^1 \[_\] write docs$/m.test(r.stdout)) throw new Error(r.stdout); });
    check('cli complete', () => eq(cli('complete', '1').status, 0));
    check('cli list done', () => { const r = cli('list', '--done'); if (!/^1 \[x\] write docs$/m.test(r.stdout)) throw new Error(r.stdout); });
    check('cli report', () => { const r = cli('report'); if (r.stdout.trim() !== 'total=1 done=1 open=0 percent=100') throw new Error(r.stdout); });
    check('cli bad id', () => { const r = cli('complete', '42'); eq(r.status, 1); if (!r.stderr.trim()) throw new Error('no stderr'); });
    check('cli unknown command', () => { const r = cli('frobnicate'); eq(r.status, 1); if (!r.stderr.trim()) throw new Error('no stderr'); });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The trivial parts of the mixed task.
function trivial() {
  check('rename alignRight', () => {
    const format = load('src/format.js');
    eq(format.alignRight('7', 3), '  7');
    eq('padLeft' in format, false);
    if (/padLeft/.test(fs.readFileSync(path.join(dir, 'src/format.js'), 'utf8'))) throw new Error('padLeft still in src/format.js');
  });
  check('jsdoc in math.js', () => {
    const text = fs.readFileSync(path.join(dir, 'src/math.js'), 'utf8');
    for (const name of ['add', 'mean']) if (!new RegExp('\\*/\\s*function ' + name + '\\b').test(text)) throw new Error('no JSDoc above ' + name);
  });
  check('package.json fields', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    eq(pkg.description, 'Small task tracker');
    eq(String(pkg.bin && pkg.bin.tasks).replace(/^\.\//, ''), 'src/cli.js');
    eq(pkg.scripts && pkg.scripts.test, 'node --test');
  });
  check('README usage', () => {
    const text = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    const usage = text.split(/^## Usage\s*$/m)[1];
    if (!usage) throw new Error('no "## Usage" heading');
    for (const command of ['add', 'list', 'complete', 'remove', 'report']) if (!new RegExp('node src/cli\\.js \\S+ ' + command + '\\b').test(usage)) throw new Error('no example for ' + command);
  });
}

if (task === 'small') small();
else if (task === 'medium') medium();
else if (task === 'mixed') { medium(); trivial(); }
else { console.error('Usage: node bench/hidden-check.js <small|medium|mixed> <run folder>'); process.exit(2); }
console.log(passed + '/' + total);
