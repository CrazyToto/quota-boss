#!/usr/bin/env node
'use strict';
// Measures how the reasoning level changes usage: one fixed task per model and level, checked by a hidden test.
//   node bench/effort.js --host claude|codex --model <id> [--efforts low,medium,high,xhigh] [--n 2] [--out <dir>]
//   node bench/effort.js --report [--out <dir>]
// Spends real quota. Results go to <out>/effort.jsonl, one line per run.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROMPT = `Write the file schedule.js in the current folder (CommonJS, no dependencies). It exports one function: module.exports = { schedule }.

schedule(jobs) takes an array of jobs: { id: string, duration: integer >= 1, deadline: integer >= 0, weight: integer >= 0, after?: string[] }.
One machine runs the jobs one after another without idle time, starting at time 0. A job may start only when every job listed in its "after" has finished.
A job that finishes at time f costs weight * max(0, f - deadline). Return { order, cost }: "order" is the array of all ids in running order with the smallest possible total cost, and "cost" is that total.
When several orders have the smallest cost, return the lexicographically smallest one (compare the id sequences element by element with the < operator on strings).
Up to 16 jobs must be solved exactly in under 2 seconds. An empty array returns { order: [], cost: 0 }.
Throw a TypeError for a duplicate id, an id in "after" that no job has, or a duration, deadline or weight that is not an integer in its range. Throw a RangeError when the "after" relations contain a cycle.

Write only schedule.js. Do not write tests or other files and do not run anything. Answer with one short sentence when the file is written.`;

// ---- Hidden check -------------------------------------------------------------------------------------------------
function reference(jobs) {
  const n = jobs.length; const index = new Map(jobs.map((j, i) => [j.id, i]));
  const pre = jobs.map(j => (j.after || []).reduce((m, id) => m | (1 << index.get(id)), 0));
  const full = (1 << n) - 1; const best = new Float64Array(full + 1).fill(Infinity); const time = new Int32Array(full + 1);
  for (let mask = 1; mask <= full; mask++) { const low = 31 - Math.clz32(mask & -mask); time[mask] = time[mask & (mask - 1)] + jobs[low].duration; }
  const step = (mask, j) => jobs[j].weight * Math.max(0, time[mask] + jobs[j].duration - jobs[j].deadline);
  best[full] = 0;
  for (let mask = full - 1; mask >= 0; mask--) {
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j) || (pre[j] & mask) !== pre[j]) continue;
      const c = step(mask, j) + best[mask | (1 << j)];
      if (c < best[mask]) best[mask] = c;
    }
  }
  const order = [];
  for (let mask = 0; mask !== full;) {
    let pick = -1;
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j) || (pre[j] & mask) !== pre[j] || step(mask, j) + best[mask | (1 << j)] !== best[mask]) continue;
      if (pick < 0 || jobs[j].id < jobs[pick].id) pick = j;
    }
    order.push(jobs[pick].id); mask |= 1 << pick;
  }
  return { order, cost: best[0] };
}

function bruteForce(jobs) {
  let best = null;
  (function walk(order, done, time, cost) {
    if (order.length === jobs.length) {
      const smaller = best && cost === best.cost && (() => { for (let i = 0; i < order.length; i++) if (order[i] !== best.order[i]) return order[i] < best.order[i]; return false; })();
      if (!best || cost < best.cost || smaller) best = { order: [...order], cost };
      return;
    }
    for (const j of jobs) {
      if (done.has(j.id) || (j.after || []).some(id => !done.has(id))) continue;
      const f = time + j.duration;
      order.push(j.id); done.add(j.id);
      walk(order, done, f, cost + j.weight * Math.max(0, f - j.deadline));
      order.pop(); done.delete(j.id);
    }
  })([], new Set(), 0, 0);
  return best;
}

function randomJobs(rand, n) {
  // Ids such as j10 and j2 sort differently as strings and as numbers; later jobs may depend on earlier ones, so no cycle.
  const ids = Array.from({ length: n }, (_, i) => `j${i * 7 % 17}`).sort(() => rand() - 0.5);
  return ids.map((id, i) => ({
    id, duration: 1 + Math.floor(rand() * 6), deadline: Math.floor(rand() * n * 3), weight: Math.floor(rand() * 4),
    ...(rand() < 0.8 ? { after: ids.slice(0, i).filter(() => rand() < 0.25) } : {}),
  }));
}

function hiddenCheck(file) {
  let seed = 12345; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const fails = []; const same = (a, b) => a && a.cost === b.cost && Array.isArray(a.order) && a.order.join() === b.order.join();
  let schedule;
  try { schedule = require(file).schedule; if (typeof schedule !== 'function') throw new Error('no schedule export'); } catch (e) { return { passed: 0, total: 1, fails: [`load: ${e.message}`] }; }
  let total = 0; const expect = (name, ok) => { total++; if (!ok) fails.push(name); };
  const attempt = fn => { try { return { value: fn() }; } catch (error) { return { error }; } };
  expect('empty', same(attempt(() => schedule([])).value, { order: [], cost: 0 }));
  let small = true;
  for (let i = 0; i < 120 && small; i++) {
    const jobs = randomJobs(rand, 1 + i % 7); const want = bruteForce(jobs);
    if (!same(reference(jobs), want)) throw new Error('reference disagrees with brute force');
    small = same(attempt(() => schedule(JSON.parse(JSON.stringify(jobs)))).value, want);
  }
  expect('small instances against brute force', small);
  let large = true; let slowest = 0;
  for (let i = 0; i < 4 && large; i++) {
    const jobs = randomJobs(rand, 13 + i); const started = Date.now();
    const got = attempt(() => schedule(JSON.parse(JSON.stringify(jobs)))).value;
    slowest = Math.max(slowest, Date.now() - started); large = same(got, reference(jobs));
  }
  expect('13 to 16 jobs', large);
  expect('16 jobs under 2 seconds', slowest < 2000);
  const job = (id, extra) => ({ id, duration: 1, deadline: 0, weight: 1, ...extra });
  const throws = (name, type, jobs) => expect(name, attempt(() => schedule(jobs)).error instanceof type && attempt(() => schedule(jobs)).error.constructor === type);
  throws('duplicate id', TypeError, [job('a'), job('a')]);
  throws('unknown id in after', TypeError, [job('a', { after: ['x'] })]);
  throws('zero duration', TypeError, [job('a', { duration: 0 })]);
  throws('fractional deadline', TypeError, [job('a', { deadline: 1.5 })]);
  throws('negative weight', TypeError, [job('a', { weight: -1 })]);
  throws('cycle', RangeError, [job('a', { after: ['b'] }), job('b', { after: ['a'] })]);
  throws('self cycle', RangeError, [job('a', { after: ['a'] })]);
  return { passed: total - fails.length, total, fails };
}

// ---- Runs -----------------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const out = flag('out', path.join(os.tmpdir(), 'quota-boss-bench'));
const results = path.join(out, 'effort.jsonl');
// One agent turn mix as in docs/MODELS.md: 38k input, 80% of it cached at 0.1 of the input price.
const INPUT_UNITS = 38000 * (0.2 + 0.8 * 0.1);
const OUTPUT_PRICE = { claude: 5, codex: 6 };

function report() {
  const rows = fs.existsSync(results) ? fs.readFileSync(results, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const groups = new Map();
  for (const r of rows) { const key = `${r.model} ${r.effort}`; groups.set(key, [...(groups.get(key) || []), r]); }
  const mean = (list, f) => list.reduce((s, x) => s + f(x), 0) / list.length;
  const units = (host, output) => INPUT_UNITS + output * OUTPUT_PRICE[host];
  console.log('model | effort | runs | passed | output | seconds | output vs medium | cost vs medium');
  for (const [key, list] of groups) {
    const base = groups.get(`${list[0].model} medium`); const output = mean(list, x => x.output);
    const baseOutput = base ? mean(base, x => x.output) : null;
    console.log([list[0].model, list[0].effort, list.length, list.filter(x => x.passed === x.total).length, Math.round(output), Math.round(mean(list, x => x.seconds)),
      baseOutput ? (output / baseOutput).toFixed(2) : '-', baseOutput ? (units(list[0].host, output) / units(list[0].host, baseOutput)).toFixed(2) : '-'].join(' | '));
  }
}

function runOnce(host, model, effort, name) {
  const dir = path.join(out, name); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const started = Date.now(); let run;
  if (host === 'claude') {
    run = spawnSync('claude', ['-p', '--safe-mode', '--model', model, '--effort', effort, '--output-format', 'json', '--tools', 'Write', '--permission-mode', 'acceptEdits', '--no-session-persistence'],
      { cwd: dir, input: PROMPT, encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CLAUDECODE: '' } });
  } else {
    run = spawnSync('codex', ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-C', `"${dir}"`, '-s', 'workspace-write', '-m', model, '-c', `model_reasoning_effort=${effort}`, '-'],
      { input: PROMPT, encoding: 'utf8', shell: true, timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  if (run.error) throw new Error(`Could not start ${host}: ${run.error.message}`);
  fs.writeFileSync(path.join(out, `${name}.stdout.txt`), String(run.stdout || '') + '\n--- stderr ---\n' + String(run.stderr || ''));
  const row = { at: new Date().toISOString(), host, model, effort, seconds, input: 0, cached: 0, output: 0, reasoning: null };
  if (host === 'claude') {
    try {
      const r = JSON.parse(String(run.stdout || '').trim().split('\n').pop()); const u = r.usage || {};
      Object.assign(row, { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), cached: u.cache_read_input_tokens || 0,
        output: u.output_tokens || 0, usd: r.total_cost_usd, turns: r.num_turns, models: Object.keys(r.modelUsage || {}) });
    } catch { row.error = 'no JSON result'; }
  } else {
    for (const line of String(run.stdout || '').split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const u = e.type === 'turn.completed' && e.usage; if (!u) continue;
      row.input += u.input_tokens || 0; row.cached += u.cached_input_tokens || 0; row.output += u.output_tokens || 0;
      if (u.reasoning_output_tokens !== undefined) row.reasoning = (row.reasoning || 0) + u.reasoning_output_tokens;
    }
    if (!row.output) row.error = 'no usage event';
  }
  const file = path.join(dir, 'schedule.js');
  const check = fs.existsSync(file)
    ? spawnSync(process.execPath, [__filename, '--check', file], { encoding: 'utf8', timeout: 120000 })
    : { stdout: JSON.stringify({ passed: 0, total: 1, fails: ['schedule.js missing'] }) };
  try { Object.assign(row, JSON.parse(check.stdout)); } catch { Object.assign(row, { passed: 0, total: 1, fails: ['check crashed or timed out'] }); }
  fs.appendFileSync(results, JSON.stringify(row) + '\n');
  console.log(`${model} ${effort}: output ${row.output}, ${seconds}s, check ${row.passed}/${row.total}${row.fails.length ? ` (${row.fails.join('; ')})` : ''}${row.error ? `, ${row.error}` : ''}`);
}

if (args.includes('--check')) {
  console.log(JSON.stringify(hiddenCheck(path.resolve(flag('check')))));
} else if (args.includes('--report')) {
  report();
} else {
  const host = flag('host'); const model = flag('model');
  if (!['claude', 'codex'].includes(host) || !model) { console.error('Usage: node bench/effort.js --host claude|codex --model <id> [--efforts low,medium,high,xhigh] [--n 2] [--out <dir>] | --report'); process.exit(1); }
  fs.mkdirSync(out, { recursive: true });
  const efforts = flag('efforts', 'low,medium,high,xhigh').split(',');
  for (let i = 1; i <= Number(flag('n', 2)); i++) for (const effort of efforts) runOnce(host, model, effort, `effort-${model.replace(/[^\w.-]/g, '_')}-${effort}-${i}`);
  report();
}
