'use strict';
// Boss on/off benchmark on a fresh fixture. One run appends one line to <out>/results.jsonl.
// Usage: node bench/run.js --host claude|codex --arm off|on|on:<profile> --task small|medium|mixed|bugfix|refactor|docs [--model <id>] [--effort <level>] [--label <name>] [--n <k>] [--reps <k>] [--out <dir>]
// Uses the installed quota-boss (~/.claude/quota-boss) and the real CLIs, so every run spends real quota.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const USAGE = 'Usage: node bench/run.js --host claude|codex --arm off|on|on:<profile> --task small|medium|mixed|bugfix|refactor|docs [--model <id>] [--effort <level>] [--label <name>] [--n <k>] [--reps <k>] [--out <dir>]';
const { prompts, setup } = require('./tasks');
function parseArm(value) {
 if (!/^(off|on|on:(quality|balanced|frugal))$/.test(value || '')) throw new Error('Invalid arm: ' + value);
 return { arm: value, mode: value === 'off' ? 'off' : 'on', profile: value.split(':')[1] || 'balanced' };
}
function main(argv = process.argv.slice(2), execute = spawnSync) {
const args = {};
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i];
  if (!key.startsWith('--') || argv[i + 1] === undefined) { console.error(USAGE); process.exit(2); }
  args[key.slice(2)] = argv[i + 1];
}
const host = args.host;
const { arm, mode, profile } = parseArm(args.arm || args.mode);
const reps = Number(args.reps || 1);
if (!Number.isInteger(reps) || reps < 1) throw new Error('reps must be a positive integer');
if (reps > 1) {
 for (let i = 0; i < reps; i++) main([...argv.filter((_, j) => !['--reps', '--n'].includes(argv[j - j % 2])), '--n', String(Number(args.n || 1) + i)], execute);
 return;
}
const task = args.task;
if (!['claude', 'codex'].includes(host) || !['on', 'off'].includes(mode) || !Object.hasOwn(prompts, task)) { console.error(USAGE); process.exit(2); }
const model = args.model || (host === 'claude' ? 'opus' : 'gpt-6.1-sol');
const effort = args.effort || (host === 'codex' ? 'medium' : '');
const label = args.label || `${host}-${model}-${arm}`;
const n = args.n || '1';
if (!Number.isInteger(Number(n)) || Number(n) < 1) throw new Error('n must be a positive integer');
const out = path.resolve(args.out || path.join(os.tmpdir(), 'quota-boss-bench'));
const runName = `${label}-${task}-${n}`.replace(/[^A-Za-z0-9._-]/g, '_');
const dir = path.join(out, 'runs', runName);
const qb = path.join(os.homedir(), '.claude', 'quota-boss', 'scripts', 'quota-boss.js');

// USD per million tokens (input, cached input, output); see docs/MODELS.md. Unknown models are priced as GPT-6.1 Sol.
const PRICES = {
  'gpt-6.1-sol': [2, 0.1, 10], 'gpt-6.1-terra': [1, 0.05, 5], 'gpt-6-luna': [0.1, 0.01, 0.5], 'gpt-6-sol': [2, 0.2, 10],
};

// Fresh independent fixture
if (fs.existsSync(dir)) throw new Error('Run already exists: ' + runName);
setup(dir, task);
const git = (...a) => { const r = execute('git', a, { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) throw new Error('Fixture git setup failed: ' + (r.stderr || r.error)); return r; };
git('init', '-q', '.');
git('add', '-A');
git('-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'base');

const prompt = prompts[task] + ' Reply in one short sentence.';

const quota = (...a) => execute(process.execPath, [qb, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, QUOTA_BOSS_BOSS_MODEL: host === 'codex' ? model : '' } });
let previousProfile;
try {
{
  const status = quota('settings');
  previousProfile = /^profile\s*\|\s*(quality|balanced|frugal)\b/m.exec(status.stdout || '')?.[1];
  if (!previousProfile) throw new Error('Could not determine previous profile');
  const on = mode === 'off' ? quota('off') : quota('on', '--host', host === 'codex' ? 'codex' : 'claude-code', profile);
  if (on.status !== 0) throw new Error('quota-boss setup failed: ' + (on.stdout + on.stderr).slice(0, 300));
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
  run = execute('claude', cli, { cwd: dir, input: prompt, encoding: 'utf8', timeout: 1800000, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, CLAUDECODE: '' } });
} else {
  run = execute('codex', ['exec', '--json', '--skip-git-repo-check', '-C', `"${dir}"`, '-s', 'workspace-write', '-m', model, '-c', `model_reasoning_effort=${effort}`, '-'],
    { input: prompt, encoding: 'utf8', shell: true, timeout: 1800000, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, QUOTA_BOSS_BOSS_MODEL: model } });
}
const seconds = Math.round((Date.now() - started) / 1000);
if (run.error) {
  // No result line for a run that never started (for example `claude` installed only as a .cmd shim on Windows).

  throw new Error(`Could not start ${host}: ${run.error.message}`);
}
fs.writeFileSync(path.join(out, `stdout-${runName}.txt`), String(run.stdout || ''));
fs.writeFileSync(path.join(out, `stderr-${runName}.txt`), String(run.stderr || ''));

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

const check = execute(process.execPath, [path.join(__dirname, 'hidden-check.js'), task, dir], { encoding: 'utf8', timeout: 120000 });
const hidden = String(check.stdout || '').trim().split('\n').pop();
const hiddenFails = String(check.stderr || '').trim().split('\n').filter(Boolean);
const own = execute(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: 120000 });
const count = name => { const m = String(own.stdout || '').match(new RegExp(`(?:#|ℹ) ${name} (\\d+)`)); return m ? +m[1] : null; };
const codexUsd = +sessions.reduce((t, s) => t + s.usd, 0).toFixed(4);

const line = {
  date: new Date().toISOString(), runName, arm, label, host, model, effort: effort || null, mode, task, n: +n, exit: run.status, seconds, hidden, hiddenFails,
  ownPass: count('pass'), ownFail: count('fail'), claude, codexUsd, codexSessions: sessions, feedback,
};
fs.appendFileSync(path.join(out, 'results.jsonl'), JSON.stringify(line) + '\n');
console.log(`done ${runName} ${seconds}s hidden=${hidden} claudeUsd=${claude ? claude.usd : 0} codexUsd=${codexUsd}`);

} finally { if (previousProfile) { const off = quota('off'); const restored = quota('set', 'profile', previousProfile); if (off.status !== 0 || restored.status !== 0) throw new Error('Could not restore quota-boss profile'); } }
}
module.exports = { main, parseArm };
if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
