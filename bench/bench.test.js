'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setup } = require('./tasks');
const { main, parseArm } = require('./run');
const { blind, shuffle, review, extractJson } = require('./review');
const { report, stats } = require('./report');

function temporary(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const references = {
  bugfix: ['src/collection.js', `function unique(v){return [...new Set(v)];} function average(v){return v.length?v.reduce((a,b)=>a+b,0)/v.length:0;} function sortNumbers(v){return [...v].sort((a,b)=>a-b);} module.exports={unique,average,sortNumbers};`],
  refactor: ['src/stats.js', `function selectFinite(v){return v.filter(Number.isFinite);} function totalOf(v){return v.reduce((a,b)=>a+b,0);} function boundsOf(v){return {min:v.length?Math.min(...v):null,max:v.length?Math.max(...v):null};} function summarize(v){v=selectFinite(v);const total=totalOf(v);return {count:v.length,total,mean:v.length?total/v.length:0,...boundsOf(v)};} module.exports={selectFinite,totalOf,boundsOf,summarize};`],
  docs: ['src/greetings.js', `/** Say hello. @param {string} name Name. @returns {string} Greeting. */
function greet(name){return 'Hello, '+name+'!';}
/** Repeat. @param {string} text Text. @param {number} count Count. @returns {string} Text. */
function repeat(text,count){return String(text).repeat(count);} module.exports={greet,repeat};`],
};

for (const task of Object.keys(references)) {
  test(task + ' hidden checks', t => {
    const d = temporary(t);
    setup(d, task);
    const check = () => spawnSync(process.execPath, [path.join(__dirname, 'hidden-check.js'), task, d], { encoding: 'utf8' });
    let r = check();
    assert.match(r.stderr, /FAIL/);
    assert.notEqual(...r.stdout.trim().split('/'));
    fs.writeFileSync(path.join(d, references[task][0]), references[task][1]);
    if (task === 'docs') {
      fs.writeFileSync(path.join(d, 'README.md'), '## Overview\nHello\n## API\nFunctions\n## Examples\n```js\nconst {greet,repeat}=require("./src/greetings"); const assert=require("node:assert/strict"); assert.equal(greet("Ada"),"Hello, Ada!"); assert.equal(repeat("a",2),"aa");\n```\n');
    }
    r = check();
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    const [a, b] = r.stdout.trim().split('/').map(Number);
    assert.equal(a, b);
    assert.ok(b >= 6 && b <= 15);
  });
}

test('arms', () => {
  for (const arm of ['off', 'on', 'on:quality', 'on:frugal']) assert.equal(parseArm(arm).arm, arm);
  for (const arm of ['', 'bad', 'on:bad']) assert.throws(() => parseArm(arm));
});

test('blinding and shuffle', () => {
  const diff = 'diff --git a/AGENTS.md b/AGENTS.md\n+secret\ndiff --git a/.quota-boss/x b/.quota-boss/x\n+trace\ndiff --git a/src/x b/src/x\n+quota-boss on:quality\n+opus my-label claude on:quality\n';
  const b = blind(diff, { arm: 'on:quality', label: 'my-label', host: 'claude', model: 'opus' });
  for (const s of ['secret', 'trace', 'quota-boss', 'opus', 'my-label', 'claude', 'on:quality']) assert.ok(!b.includes(s), s);
  assert.deepEqual(shuffle([1, 2, 3, 4], 42), shuffle([1, 2, 3, 4], 42));
});

test('fake runs repetitions and profile restoration', t => {
  const d = temporary(t), calls = [];
  const fake = (command, args, options) => {
    calls.push([command, args]);
    if (args.includes('settings')) return { status: 0, stdout: 'profile       | frugal | set profile' };
    if (command === 'claude') return { status: 0, stdout: JSON.stringify({ total_cost_usd: 1 }) };
    return { status: 0, stdout: '', stderr: '' };
  };
  main(['--host', 'claude', '--arm', 'on:quality', '--task', 'small', '--reps', '2', '--out', d], fake);
  const rows = fs.readFileSync(path.join(d, 'results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].runName, rows[1].runName);
  assert.equal(rows[0].arm, 'on:quality');
  assert.equal(calls.filter(x => x[1].join(' ').includes('set profile frugal')).length, 2);
  assert.equal(calls.filter(x => x[0] === 'claude').length, 2);
});

test('report known statistics and joins', t => {
  const d = temporary(t);
  const r = [];
  for (const arm of ['off', 'on']) {
    for (const n of [1, 2, 3]) {
      r.push({
        runName: arm + n,
        task: 'small',
        arm,
        host: 'claude',
        model: 'fake',
        n,
        claude: { usd: n * (arm === 'off' ? 1 : 2) },
        codexUsd: 0,
        seconds: n,
        hidden: '4/5',
        ownPass: 2,
        ownFail: 1,
      });
    }
  }
  fs.writeFileSync(path.join(d, 'results.jsonl'), r.map(JSON.stringify).join('\n'));
  fs.writeFileSync(path.join(d, 'review-map.json'), JSON.stringify({ packets: { p: 'off1' } }));
  fs.writeFileSync(path.join(d, 'reviews.jsonl'), JSON.stringify({ packetId: 'p', correctness: 6, testQuality: 9, codeQuality: 9 }));
  const a = report(d);
  assert.equal(a[0].metrics.totalUsd.mean, 2);
  assert.equal(a[0].metrics.reviewScore.mean, 8);
  assert.equal(a[1].totalUsdRatioToOff.mean, 2);
  assert.ok(a[1].totalUsdRatioToOff.ci[0] <= 2 && a[1].totalUsdRatioToOff.ci[1] >= 2);
  for (const g of a) {
    const s = g.metrics.totalUsd;
    assert.ok(s.ci[0] <= s.mean && s.ci[1] >= s.mean);
  }
  assert.deepEqual(a, report(d));
  assert.deepEqual(stats([1, 2, 3]), stats([1, 2, 3]));
});

test('empty and missing CLI data', t => {
  const d = temporary(t);
  for (const file of ['report.js', 'review.js']) {
    const r = spawnSync(process.execPath, [path.join(__dirname, file), '--out', d, '--dry-run'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Missing|Empty/);
  }
  fs.writeFileSync(path.join(d, 'results.jsonl'), '');
  assert.throws(() => report(d), /Empty/);
});

test('review dry run and injectable judge', async t => {
  const d = temporary(t), name = 'anonymous', cwd = path.join(d, 'runs', name);
  setup(cwd, 'small');
  const git = args => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  fs.writeFileSync(path.join(cwd, 'new.js'), '// new code\n');
  fs.writeFileSync(path.join(d, 'results.jsonl'), JSON.stringify({ runName: name, task: 'small', arm: 'off', model: 'fake', host: 'claude' }) + '\n');
  const map = await review(d);
  assert.ok(map.seed);
  assert.match(fs.readFileSync(path.join(d, 'review-packets', 'packet-0001.txt'), 'utf8'), /new code/);
  assert.ok(!fs.existsSync(path.join(d, 'reviews.jsonl')));
  await review(d, { dryRun: false, invoke: async () => ({ correctness: 8, testQuality: 7, codeQuality: 9, sentence: 'Good work.' }) });
  const score = JSON.parse(fs.readFileSync(path.join(d, 'reviews.jsonl'), 'utf8'));
  assert.equal(score.packetId, 'packet-0001');
  assert.ok(!('arm' in score));
});

test('judge JSON extraction', () => {
  const score = { correctness: 8, testQuality: 7, codeQuality: 9, sentence: 'Good work.' };
  const text = JSON.stringify(score);
  assert.deepEqual(extractJson(text), score);
  assert.deepEqual(extractJson('```json\n' + text + '\n```'), score);
  assert.deepEqual(extractJson('Here is my review: ' + text + ' Thanks.'), score);
  assert.deepEqual(extractJson('Braces {1} in prose, then ' + text), score);
  assert.throws(() => extractJson('No structured answer here.'), /no JSON object/);
});

test('failed fake host restores profile', t => {
  const d = temporary(t), calls = [];
  const fake = (command, args) => {
    calls.push(args);
    if (args.includes('settings')) return { status: 0, stdout: 'profile | balanced | change' };
    if (command === 'claude') return { error: new Error('fake launch failure') };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.throws(() => main(['--host', 'claude', '--arm', 'on:quality', '--task', 'docs', '--out', d], fake), /fake launch failure/);
  assert.ok(calls.some(a => a.slice(1).join(' ') === 'set profile balanced'));
  assert.ok(!fs.existsSync(path.join(d, 'results.jsonl')));
});

test('legacy mode alias and default balanced profile use fakes', t => {
  for (const mode of ['off', 'on']) {
    const d = path.join(temporary(t), mode), calls = [];
    const fake = (command, args) => {
      calls.push([command, args]);
      if (args.includes('settings')) return { status: 0, stdout: 'profile | quality | change' };
      return { status: 0, stdout: command === 'codex' ? '{}' : '', stderr: '' };
    };
    main(['--host', 'codex', '--mode', mode, '--task', 'bugfix', '--out', d], fake);
    const r = JSON.parse(fs.readFileSync(path.join(d, 'results.jsonl'), 'utf8'));
    assert.equal(r.arm, mode);
    if (mode === 'on') assert.ok(calls.some(x => x[1].slice(1).join(' ') === 'on --host codex balanced'));
    else assert.ok(!calls.some(x => x[1][1] === 'on'));
  }
});
