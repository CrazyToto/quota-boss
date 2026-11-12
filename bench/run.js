'use strict';
// Boss on/off benchmark on a fresh fixture. One run appends one line to <out>/results.jsonl.
// Usage: node bench/run.js --host claude|codex --mode on|off --task small|medium|mixed [--model <id>] [--effort <level>] [--label <name>] [--n <k>] [--out <dir>]
// Uses the installed quota-boss (~/.claude/quota-boss) and the real CLIs, so every run spends real quota.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const USAGE = 'Usage: node bench/run.js --host claude|codex --mode on|off --task small|medium|mixed [--model <id>] [--effort <level>] [--label <name>] [--n <k>] [--out <dir>]';
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!key.startsWith('--') || process.argv[i + 1] === undefined) { console.error(USAGE); process.exit(2); }
  args[key.slice(2)] = process.argv[i + 1];
}
const host = args.host;
const mode = args.mode;
const task = args.task;
if (!['claude', 'codex'].includes(host) || !['on', 'off'].includes(mode) || !['small', 'medium', 'mixed'].includes(task)) { console.error(USAGE); process.exit(2); }
const model = args.model || (host === 'claude' ? 'opus' : 'gpt-6.1-sol');
const effort = args.effort || (host === 'codex' ? 'medium' : '');
const label = args.label || `${host}-${model}-${mode}`;
const n = args.n || '1';
const out = path.resolve(args.out || path.join(os.tmpdir(), 'quota-boss-bench'));
const runName = `${label}-${task}-${n}`.replace(/[^A-Za-z0-9._-]/g, '_');
const dir = path.join(out, 'runs', runName);
const qb = path.join(os.homedir(), '.claude', 'quota-boss', 'scripts', 'quota-boss.js');

// USD per million tokens (input, cached input, output); see docs/MODELS.md. Unknown models are priced as GPT-6.1 Sol.
const PRICES = {
  'gpt-6.1-sol': [2, 0.1, 10], 'gpt-6.1-terra': [1, 0.05, 5], 'gpt-6-luna': [0.1, 0.01, 0.5], 'gpt-6-sol': [2, 0.2, 10],
};

// Fixture
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
const put = (name, text) => fs.writeFileSync(path.join(dir, name), text);
put('package.json', '{ "name": "bench-fixture", "version": "1.0.0", "private": true, "scripts": { "test": "node --test" } }\n');
put('src/math.js', "'use strict';\nfunction add(a, b) { return a + b; }\nfunction mean(values) { return values.length ? values.reduce(add, 0) / values.length : 0; }\nmodule.exports = { add, mean };\n");
put('src/format.js', "'use strict';\nfunction padLeft(text, width) { return String(text).padStart(width, ' '); }\nfunction percent(value) { return Math.round(value * 100) + '%'; }\nmodule.exports = { padLeft, percent };\n");
put('test/math.test.js', "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { add, mean } = require('../src/math.js');\ntest('add', () => assert.equal(add(2, 3), 5));\ntest('mean', () => assert.equal(mean([2, 4]), 3));\n");
const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
git('init', '-q', '.');
git('add', '-A');
git('-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'base');

// Tasks
const SMALL = 'In src/math.js add and export clamp(value, min, max). It returns min when value is below min, max when value is above max, otherwise value, and throws a RangeError when min is greater than max. Add tests to test/math.test.js and run the tests.';
const MEDIUM = 'Add a small task tracker to this project. src/store.js exports createStore(filePath) with add(title) returning {id, title, done: false}, list(filter) where filter.done true or false limits the result and an empty filter returns all, complete(id) which throws an Error for an unknown id, and remove(id) returning true or false. Tasks persist as JSON in filePath. Ids start at 1, increase by one and are never reused, not even after a remove and after reopening the file. src/report.js exports summary(tasks) returning {total, done, open, percentDone} where percentDone is a rounded integer and 0 for an empty list. src/cli.js runs as: node src/cli.js <file> add <title words...> | list [--done|--open] | complete <id> | remove <id> | report. list prints one line per task as "<id> [x] <title>" for done and "<id> [_] <title>" for open. report prints "total=N done=N open=N percent=N". An unknown command or unknown id prints a message on stderr and exits with code 1. Add tests under test/ for all three modules and run them.';
const TRIVIAL = ' Also do these small chores: rename padLeft in src/format.js to alignRight with the same behavior; add a JSDoc comment above every function in src/math.js; in package.json add "description": "Small task tracker" and "bin": {"tasks": "src/cli.js"}; write README.md with a "## Usage" section that shows one example line per CLI command in the form "node src/cli.js tasks.json <command> ...".';
const prompt = (task === 'small' ? SMALL : task === 'medium' ? MEDIUM : MEDIUM + TRIVIAL) + ' Reply in one short sentence.';

const quota = (...a) => spawnSync(process.execPath, [qb, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, QUOTA_BOSS_BOSS_MODEL: host === 'codex' ? model : '' } });
if (mode === 'on') {
  const on = quota('on', '--host', host === 'codex' ? 'codex' : 'claude-code', 'balanced');
  if (on.status !== 0) { console.error('quota-boss on failed: ' + (on.stdout + on.stderr).slice(0, 300)); process.exit(1); }
}

// The boss may log feedback during the run. Keep it in the result, not in the owner's outcome log.
const outcomes = path.join(os.homedir(), '.claude', 'quota-boss', 'outcomes.jsonl');
const outcomesSize = fs.existsSync(outcomes) ? fs.statSync(outcomes).size : 0;
const started = Date.now();
let run;
if (host === 'claude') {
  const cli = ['-p', '--model', model, '--output-format', 'json', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(node:*) Bash(git:*) Bash(npm:*) Read Edit Write Glob Grep Agent', '--max-budget-usd', '8'];
  if (effort) cli.push('--effort', effort);
  run = spawnSync('claude', cli, { cwd: dir, input: prompt, encoding: 'utf8', timeout: 1800000, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, CLAUDECODE: '' } });
} else {
  run = spawnSync('codex', ['exec', '--json', '--skip-git-repo-check', '-C', `"${dir}"`, '-s', 'workspace-write', '-m', model, '-c', `model_reasoning_effort=${effort}`, '-'],
    { input: prompt, encoding: 'utf8', shell: true, timeout: 1800000, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, QUOTA_BOSS_BOSS_MODEL: model } });
}
const seconds = Math.round((Date.now() - started) / 1000);
if (run.error) {
  // No result line for a run that never started (for example `claude` installed only as a .cmd shim on Windows).
  if (mode === 'on') quota('off');
  console.error(`Could not start ${host}: ${run.error.message}`);
  process.exit(1);
}
fs.writeFileSync(path.join(out, `stdout-${runName}.txt`), String(run.stdout || ''));
fs.writeFileSync(path.join(out, `stderr-${runName}.txt`), String(run.stderr || ''));
if (mode === 'on') quota('off');
let feedback = [];
if (fs.existsSync(outcomes) && fs.statSync(outcomes).size > outcomesSize) {
  const all = fs.readFileSync(outcomes);
  feedback = all.subarray(outcomesSize).toString('utf8').split('\n').filter(Boolean);
  fs.writeFileSync(outcomes, all.subarray(0, outcomesSize));
}

// Claude usage from the result JSON (boss and every Claude subagent).
let claude = null;
if (host === 'claude') {
  try {
    const r = JSON.parse(String(run.stdout || '').trim().split('\n').pop());
    claude = {
      usd: r.total_cost_usd, turns: r.num_turns, subtype: r.subtype, denied: (r.permission_denials || []).length, sessionId: r.session_id,
      models: Object.fromEntries(Object.entries(r.modelUsage || {}).map(([k, v]) => [k, +(v.costUSD || 0).toFixed(4)])),
    };
  } catch { claude = { error: 'no JSON result' }; }
}

// Every Codex session started during the run in this fixture: a Codex boss, its children, or Codex workers of a Claude boss.
const sessions = [];
(function walk(d, depth) {
  let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of list) {
    const p = path.join(d, x.name);
    if (x.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
    if (!x.name.endsWith('.jsonl') || fs.statSync(p).mtimeMs < started) continue;
    let meta = null; let usage = null; let m = null; let e2 = null;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'session_meta') meta = meta || e.payload;
      if (e.type === 'turn_context' && e.payload) { m = e.payload.model || m; e2 = e.payload.effort || e.payload.reasoning_effort || e2; }
      const t = e.payload && e.payload.info && e.payload.info.total_token_usage;
      if (t) usage = t;
    }
    if (!meta || Date.parse(meta.timestamp) < started - 5000 || !String(meta.cwd || '').toLowerCase().includes(runName.toLowerCase())) continue;
    const s = { model: m, effort: e2, input: usage ? usage.input_tokens : 0, cached: usage ? usage.cached_input_tokens : 0, output: usage ? usage.output_tokens : 0 };
    const [pi, pc, po] = PRICES[m] || PRICES['gpt-6.1-sol'];
    s.usd = +(((s.input - s.cached) * pi + s.cached * pc + s.output * po) / 1e6).toFixed(4);
    sessions.push(s);
  }
})(path.join(os.homedir(), '.codex', 'sessions'), 0);

const check = spawnSync(process.execPath, [path.join(__dirname, 'hidden-check.js'), task, dir], { encoding: 'utf8', timeout: 120000 });
const hidden = String(check.stdout || '').trim().split('\n').pop();
const hiddenFails = String(check.stderr || '').trim().split('\n').filter(Boolean);
const own = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: 120000 });
const count = name => { const m = String(own.stdout || '').match(new RegExp(`(?:#|ℹ) ${name} (\\d+)`)); return m ? +m[1] : null; };
const codexUsd = +sessions.reduce((t, s) => t + s.usd, 0).toFixed(4);

const line = {
  date: new Date().toISOString(), label, host, model, effort: effort || null, mode, task, n: +n, exit: run.status, seconds, hidden, hiddenFails,
  ownPass: count('pass'), ownFail: count('fail'), claude, codexUsd, codexSessions: sessions, feedback,
};
fs.appendFileSync(path.join(out, 'results.jsonl'), JSON.stringify(line) + '\n');
console.log(`done ${runName} ${seconds}s hidden=${hidden} claudeUsd=${claude ? claude.usd : 0} codexUsd=${codexUsd}`);
