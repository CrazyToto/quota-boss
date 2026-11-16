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

const throwsType = (fn, type) => { try { fn(); } catch (e) { if (!type || e instanceof type) return e; throw new Error('wrong error ' + (e && e.name)); } throw new Error('no throw'); };
function large() {
  // A missing or broken module fails its own checks instead of the whole run.
  const optional = file => { try { return load(file); } catch { return {}; } };
  const csv = optional('src/csv.js'), { createInventory } = optional('src/inventory.js'), { quote } = optional('src/pricing.js'), report = optional('src/report.js');
  check('csv basic', () => eq(csv.parseCsv('a,b\n1,2\n'), [{ a: '1', b: '2' }]));
  check('csv crlf and empty lines', () => eq(csv.parseCsv('a,b\r\n\r\n1,2\r\n3,4'), [{ a: '1', b: '2' }, { a: '3', b: '4' }]));
  check('csv quotes', () => eq(csv.parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines",z'), [{ a: 'x, y', b: 'say "hi"' }, { a: 'two\nlines', b: 'z' }]));
  check('csv bad line', () => { const e = throwsType(() => csv.parseCsv('a,b\n1,2\n1,2,3'), Error); if (!/line 3\b/.test(e.message)) throw new Error(e.message); });
  check('csv stringify', () => eq(csv.stringifyCsv([{ a: 'x,y', b: 'q"t' }, { a: 'plain', b: 2 }], ['a', 'b']), 'a,b\n"x,y","q""t"\nplain,2'));
  check('csv round trip', () => { const rows = [{ a: 'one\ntwo', b: '"' }]; eq(csv.parseCsv(csv.stringifyCsv(rows, ['a', 'b'])), rows); });
  const item = { sku: 'ABC-001', name: 'Bolt', price: 250, qty: 40 };
  check('inventory add/get/list', () => { const inv = createInventory(); inv.addItem({ ...item, sku: 'ZZZ-009' }); inv.addItem(item); eq(inv.get('ABC-001'), item); eq(inv.list().map(i => i.sku), ['ABC-001', 'ZZZ-009']); eq(inv.get('NOP-000'), undefined); });
  check('inventory validation', () => { const inv = createInventory(); for (const bad of [{ ...item, sku: 'abc-001' }, { ...item, name: '' }, { ...item, price: 0 }, { ...item, price: 2.5 }, { ...item, qty: -1 }, { ...item, qty: 1.5 }]) throwsType(() => inv.addItem(bad), TypeError); eq(inv.list().length, 0); });
  check('inventory duplicate', () => { const inv = createInventory([item]); const e = throwsType(() => inv.addItem(item), Error); if (e instanceof TypeError) throw new Error('TypeError for duplicate'); });
  check('inventory adjust', () => { const inv = createInventory([item]); eq(inv.adjust('ABC-001', -15), 25); throwsType(() => inv.adjust('ABC-001', -26), RangeError); eq(inv.get('ABC-001').qty, 25); throwsType(() => inv.adjust('NOP-000', 1), Error); });
  check('inventory toJSON', () => eq(JSON.parse(JSON.stringify(createInventory([item]).toJSON())), [item]));
  check('inventory import', () => { const inv = createInventory(); const r = inv.importCsv('sku,name,price,qty\nABC-001,Bolt,250,40\nbad,Nut,10,1\nDEF-002,"Nut, small",10,3\nABC-001,Dup,1,1'); eq(r.added, 2); eq(r.errors.map(e => e.line), [3, 5]); if (!r.errors.every(e => typeof e.message === 'string' && e.message)) throw new Error('no message'); eq(inv.get('DEF-002'), { sku: 'DEF-002', name: 'Nut, small', price: 10, qty: 3 }); });
  const stock = () => createInventory([item, { sku: 'DEF-002', name: 'Nut', price: 999, qty: 5 }]);
  check('quote plain', () => eq(quote(stock(), [{ sku: 'DEF-002', qty: 2 }]), { lines: [{ sku: 'DEF-002', qty: 2, unit: 999, total: 1998 }], subtotal: 1998, discount: 0, tax: 160, total: 2158 }));
  check('quote bulk discount', () => { const q = quote(stock(), [{ sku: 'ABC-001', qty: 10 }]); eq(q.lines[0].total, 2250); eq(q.subtotal, 2250); eq(q.tax, 180); eq(q.total, 2430); });
  check('quote bulk rounding', () => eq(quote(createInventory([{ ...item, price: 333 }]), [{ sku: 'ABC-001', qty: 11 }]).lines[0].total, 3297));
  check('quote SAVE5', () => { const q = quote(stock(), [{ sku: 'DEF-002', qty: 2 }], { coupon: 'SAVE5' }); eq([q.discount, q.tax, q.total], [500, 120, 1618]); });
  check('quote SAVE5 floor', () => { const q = quote(createInventory([{ ...item, price: 300 }]), [{ sku: 'ABC-001', qty: 1 }], { coupon: 'SAVE5' }); eq([q.discount, q.tax, q.total], [300, 0, 0]); });
  check('quote HALF', () => { const q = quote(stock(), [{ sku: 'DEF-002', qty: 1 }], { coupon: 'HALF' }); eq([q.discount, q.tax, q.total], [500, 40, 539]); });
  check('quote errors', () => { const inv = stock(); throwsType(() => quote(inv, [{ sku: 'DEF-002', qty: 1 }], { coupon: 'NOPE' }), Error); throwsType(() => quote(inv, [{ sku: 'XYZ-123', qty: 1 }]), Error); throwsType(() => quote(inv, [{ sku: 'DEF-002', qty: 6 }]), RangeError); throwsType(() => quote(inv, [{ sku: 'DEF-002', qty: 0 }]), TypeError); throwsType(() => quote(inv, [{ sku: 'DEF-002', qty: 1.5 }]), TypeError); });
  check('quote keeps stock', () => { const inv = stock(); quote(inv, [{ sku: 'DEF-002', qty: 5 }]); eq(inv.get('DEF-002').qty, 5); });
  check('formatCents', () => eq([0, 5, 1234, 99999, -5].map(c => report.formatCents(c)), ['$0.00', '$0.05', '$12.34', '$999.99', '-$0.05']));
  check('stockReport', () => { eq(report.stockReport([item, { sku: 'DEF-002', name: 'Nut', price: 999, qty: 5 }, { sku: 'AAA-000', name: 'X', price: 1, qty: 0 }]), { items: 3, units: 45, value: 14995, low: ['AAA-000'] }); eq(report.stockReport([], 5), { items: 0, units: 0, value: 0, low: [] }); eq(report.stockReport([item], 50).low, ['ABC-001']); });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-bench-'));
  try {
    const db = path.join(tmp, 'db.json'), file = path.join(tmp, 'in.csv');
    fs.writeFileSync(file, 'sku,name,price,qty\nABC-001,Bolt,250,40\nDEF-002,Nut,999,3\nnope,Bad,1,1\n');
    const cli = (...args) => spawnSync(process.execPath, [path.join(dir, 'src/cli.js'), db, ...args], { encoding: 'utf8', timeout: 30000 });
    check('cli import', () => { const r = cli('import', file); eq(r.status, 0); const lines = r.stdout.trim().split(/\r?\n/); eq(lines[0], 'added=2 errors=1'); if (!/^line 4: \S/.test(lines[1] || '')) throw new Error(r.stdout); });
    check('cli list', () => { const r = cli('list'); eq(r.stdout.trim().split(/\r?\n/), ['ABC-001 40 $2.50 Bolt', 'DEF-002 3 $9.99 Nut']); });
    check('cli quote', () => { const r = cli('quote', 'ABC-001:10', 'DEF-002:1', '--coupon', 'SAVE5'); eq(r.status, 0); eq(r.stdout.trim(), 'total=$29.69'); });
    check('cli report', () => eq(cli('report').stdout.trim(), 'items=2 units=43 value=$129.97 low=DEF-002'));
    check('cli errors', () => { for (const args of [['frobnicate'], ['quote', 'DEF-002:9'], ['quote', 'XYZ-999:1'], ['quote', 'ABC-001']]) { const r = cli(...args); eq(r.status, 1); if (!r.stderr.trim()) throw new Error('no stderr for ' + args.join(' ')); } });
    check('cli empty db', () => { const r = spawnSync(process.execPath, [path.join(dir, 'src/cli.js'), path.join(tmp, 'none.json'), 'report'], { encoding: 'utf8', timeout: 30000 }); eq(r.stdout.trim(), 'items=0 units=0 value=$0.00 low=-'); });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The trivial parts of the mixed task.
function trivial(description = 'Small task tracker', bin = 'tasks', commands = ['add', 'list', 'complete', 'remove', 'report']) {
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
    eq(pkg.description, description);
    eq(String(pkg.bin && pkg.bin[bin]).replace(/^\.\//, ''), 'src/cli.js');
    eq(pkg.scripts && pkg.scripts.test, 'node --test');
  });
  check('README usage', () => {
    const text = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    const usage = text.split(/^## Usage\s*$/m)[1];
    if (!usage) throw new Error('no "## Usage" heading');
    for (const command of commands) if (!new RegExp('node src/cli\\.js \\S+ ' + command + '\\b').test(usage)) throw new Error('no example for ' + command);
  });
}

if (task === 'small') small();
else if (task === 'medium') medium();
else if (task === 'mixed') { medium(); trivial(); }
else if (task === 'large') { large(); trivial('Small inventory tool', 'inventory', ['import', 'list', 'quote', 'report']); }
else if (['bugfix','refactor','docs'].includes(task)) additions();
else { console.error('Usage: node bench/hidden-check.js <small|medium|mixed> <run folder>'); process.exit(2); }
console.log(passed + '/' + total);
function additions() {
 if (task === 'bugfix') {
  const m = load('src/collection.js');
  for (const [i, values] of [[], [0,false,'',null,0,false], [3,1,3,2]].entries()) check('unique '+i, () => eq(m.unique(values), [...new Set(values)]));
  for (const values of [[], [2,4], [-3,0,6]]) check('average '+values, () => eq(m.average(values), values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0));
  for (const values of [[], [10,2,-1,0], [3,3,1]]) check('sort '+values, () => { const copy = [...values]; eq(m.sortNumbers(values), [...values].sort((a,b)=>a-b)); eq(values, copy); });
 } else if (task === 'refactor') {
  const m = load('src/stats.js');
  for (const name of ['selectFinite','totalOf','boundsOf']) check('helper '+name, () => eq(typeof m[name], 'function'));
  check('helper behavior', () => { eq(m.selectFinite([1,NaN,'2',Infinity]),[1]); eq(m.totalOf([1,2]),3); eq(m.boundsOf([]),{min:null,max:null}); eq(m.boundsOf([2,-1]),{min:-1,max:2}); });
  check('helpers used', () => { const source = fs.readFileSync(path.join(dir,'src/stats.js'),'utf8'); for (const name of ['selectFinite','totalOf','boundsOf']) if ((source.match(new RegExp(name+'\\s*\\(', 'g')) || []).length < 2) throw new Error(name+' unused'); });
  for (const values of [[], [NaN,Infinity,'2'], [1], [-5,0,9], Array.from({length:100},(_,i)=>i-50)]) check('behavior '+values.length, () => { const v=values.filter(Number.isFinite), total=v.reduce((a,b)=>a+b,0); eq(m.summarize(values),{count:v.length,total,mean:v.length?total/v.length:0,min:v.length?Math.min(...v):null,max:v.length?Math.max(...v):null}); });
 } else {
  const source = fs.readFileSync(path.join(dir,'src/greetings.js'),'utf8');
  let readme=''; try { readme=fs.readFileSync(path.join(dir,'README.md'),'utf8'); } catch {}
  for (const heading of ['Overview','API','Examples']) check('heading '+heading, () => { if (!new RegExp('^## '+heading+'\\s*$','m').test(readme)) throw new Error('missing heading'); });
  for (const [name, fn] of Object.entries(load('src/greetings.js'))) check('JSDoc '+name, () => { const match = new RegExp('/\\*\\*((?:(?!\\*/)[^])*)\\*/\\s*function '+name+'\\s*\\(([^)]*)\\)').exec(source); if (!match || !/@returns\b/.test(match[1])) throw new Error('missing JSDoc returns'); for (const param of match[2].split(',').map(x=>x.trim()).filter(Boolean)) if (!new RegExp('@param\\s+(?:\\{[^}]+\\}\\s+)?'+param+'\\b').test(match[1])) throw new Error('missing param '+param); });
  check('examples run', () => { const blocks = [...readme.matchAll(/```(?:js|javascript)\s*\n([^]*?)```/g)].map(x=>x[1]); if (!blocks.length || !blocks.join('').includes('greet(') || !blocks.join('').includes('repeat(')) throw new Error('missing examples'); for (const input of blocks) { const r=spawnSync(process.execPath,['-e',input],{cwd:dir,encoding:'utf8',timeout:5000}); if(r.status!==0) throw new Error(r.stderr); } });
  check('behavior', () => { const m=load('src/greetings.js'); eq(m.greet('Ada'),'Hello, Ada!'); eq(m.repeat('ab',2),'abab'); });
 }
}
