'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const runner = require('../scripts/cli-run');

function harness(t, id = 'copilot', maxParallel) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-slots-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const children = [], feedback = [];
  let clock = 100000;
  const provider = { maxParallel, cli: { command: 'trial', args: ['{prompt}'] } };
  const deps = {
    prompt: 'work', env: {}, nativeLauncher: () => null, findExecutable: () => process.execPath,
    findProjectConfig: () => ({ directory: process.cwd() }),
    loadConfig: () => ({ providers: { providers: { [id]: provider } }, models: { models: { tiny: { pool: id } } } }),
    getPaths: () => ({ quotaBossHome: home }), now: () => clock, pidAlive: () => true,
    sleep: async ms => { clock += ms; },
    recordRun() {}, appendOutcome: value => feedback.push(value),
    spawn() {
      const child = new EventEmitter();
      child.pid = process.pid; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      children.push(child);
      return child;
    },
  };
  return { home, deps, children, feedback, run: () => runner.run(['--provider', id], deps),
    folder: path.join(home, 'slots', id) };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('Copilot third run waits for one of the default two slots', async t => {
  const h = harness(t);
  const first = h.run(), second = h.run();
  await tick();
  let wake;
  h.deps.sleep = ms => { assert.equal(ms, 2000); return new Promise(resolve => { wake = resolve; }); };
  const third = h.run();
  await tick();
  assert.equal(h.children.length, 2);
  assert.equal(fs.readdirSync(h.folder).filter(name => name.endsWith('.json')).length, 2);
  h.children[0].emit('close', 0); await first;
  wake(); await tick();
  assert.equal(h.children.length, 3);
  h.children[1].emit('close', 0); h.children[2].emit('close', 0);
  await Promise.all([second, third]);
  assert.deepEqual(fs.readdirSync(h.folder), []);
});

for (const stale of ['dead pid', 'expired']) test('reclaims a slot with ' + stale, async t => {
  const h = harness(t, 'trial', 1);
  fs.mkdirSync(h.folder, { recursive: true });
  fs.writeFileSync(path.join(h.folder, '0.json'), JSON.stringify({ pid: 123, started: stale === 'expired' ? -600000 : 100000 }));
  h.deps.pidAlive = () => stale !== 'dead pid';
  const running = h.run(); await tick();
  assert.equal(h.children.length, 1);
  h.children[0].emit('close', 0); assert.equal((await running).code, 0);
});

test('releases the slot when execution throws', async t => {
  const h = harness(t);
  h.deps.setTimeout = () => { throw new Error('timer failed'); };
  // execute catches launch errors; a throwing cancellation rejects its Promise.
  h.deps.clearTimeout = () => { throw new Error('cancel failed'); };
  await assert.rejects(h.run(), /cancel failed/);
  assert.deepEqual(fs.readdirSync(h.folder), []);
});

test('busy slots time out with timeout feedback and an English message', async t => {
  const h = harness(t, 'copilot', 1);
  fs.mkdirSync(h.folder, { recursive: true });
  fs.writeFileSync(path.join(h.folder, '0.json'), JSON.stringify({ pid: process.pid, started: 100000 }));
  const result = await h.run();
  assert.equal(result.code, 1); assert.match(result.report, /timeout: All 1 copilot slots busy/);
  assert.equal(h.feedback[0].kind, 'timeout'); assert.equal(h.children.length, 0);
});

for (const cap of [undefined, 0, -1, 1.5, '2', null]) test('uncapped trial takes no slot for maxParallel ' + cap, async t => {
  const h = harness(t, 'trial', cap);
  h.deps.getPaths = () => { assert.fail('uncapped provider accessed state'); };
  const running = h.run(); await tick();
  h.children[0].emit('close', 0); assert.equal((await running).code, 0);
  assert.equal(fs.existsSync(path.join(h.home, 'slots')), false);
});

test('Copilot accepts an explicit cap of four', async t => {
  const h = harness(t, 'copilot', 4);
  const runs = Array.from({ length: 4 }, () => h.run()); await tick();
  assert.equal(h.children.length, 4);
  assert.equal(fs.readdirSync(h.folder).length, 4);
  let wake;
  h.deps.sleep = () => new Promise(resolve => { wake = resolve; });
  const fifth = h.run(); await tick();
  assert.equal(h.children.length, 4);
  h.children[0].emit('close', 0); await runs[0];
  wake(); await tick();
  assert.equal(h.children.length, 5);
  for (const child of h.children.slice(1)) child.emit('close', 0);
  await Promise.all(runs);
  await fifth;
  assert.deepEqual(fs.readdirSync(h.folder), []);
});

test('an expired owner cannot release a replacement slot', async t => {
  const h = harness(t, 'trial', 1);
  const running = h.run(); await tick();
  const replacement = JSON.stringify({ pid: process.pid, started: 100001, nonce: 'replacement' });
  fs.writeFileSync(path.join(h.folder, '0.json'), replacement);
  h.children[0].emit('close', 0); await running;
  assert.equal(fs.readFileSync(path.join(h.folder, '0.json'), 'utf8'), replacement);
});
