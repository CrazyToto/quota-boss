'use strict';
// Boss on/off benchmark on a fresh fixture. One run appends one line to <out>/results.jsonl.
// Usage: node bench/run.js --host claude|codex|junie|devin|agy --arm off|on|on:<profile> --task <task> [--model <id>] [--effort <level>] [--claude-mode normal|save|emergency] [--hint <sentence>] [--label <name>] [--n <k>] [--reps <k>] [--out <dir>]
// Uses the installed quota-boss (~/.claude/quota-boss) and the real CLIs, so every run spends real quota.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const USAGE = 'Usage: node bench/run.js --host claude|codex|junie|devin|agy --arm off|on|on:<profile> --task <task> [--model <id>] [--effort <level>] [--claude-mode normal|save|emergency] [--hint <sentence>] [--label <name>] [--n <k>] [--reps <k>] [--out <dir>]';
const { prompts, setup } = require('./tasks');
const { find: findTranscript, analyze: analyzeTranscript } = require('./transcript');
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
const claudeMode = args['claude-mode'] === undefined ? null : args['claude-mode'];
if (claudeMode !== null && !['normal', 'save', 'emergency'].includes(claudeMode)) { console.error(USAGE); process.exit(2); }
// A simulated Claude 5h use typical for the mode, so the router prices Claude as it would at that use.
const modeEnv = claudeMode ? { QUOTA_BOSS_CLAUDE_5H: String({ normal: 10, save: 75, emergency: 90 }[claudeMode]) } : {};
const reps = Number(args.reps || 1);
if (!Number.isInteger(reps) || reps < 1) throw new Error('reps must be a positive integer');
if (reps > 1) {
 for (let i = 0; i < reps; i++) main([...argv.filter((_, j) => !['--reps', '--n'].includes(argv[j - j % 2])), '--n', String(Number(args.n || 1) + i)], execute);
 return;
}
const task = args.task;
// Junie and Devin are worker CLIs, not boss hosts, so they run only the off arm (solo quality of one model).
const solo = ['junie', 'devin', 'agy'].includes(host);
if (!['claude', 'codex', 'junie', 'devin', 'agy'].includes(host) || !['on', 'off'].includes(mode) || (solo && mode !== 'off') || !Object.hasOwn(prompts, task)) { console.error(USAGE); process.exit(2); }
const model = args.model || { claude: 'opus', codex: 'gpt-6.1-sol', junie: 'junie-lite', devin: 'swe-2-flash-medium', agy: 'gemini-4-hydrogen-medium' }[host];
const effort = args.effort || (host === 'codex' ? 'medium' : '');
const label = (args.label || `${host}-${model}-${arm}${claudeMode ? '-' + claudeMode : ''}`);
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

// --hint appends one sentence for a probe run (for example a forced delegation); it is kept in the result line.
const hint = args.hint === undefined ? null : String(args.hint);
const prompt = prompts[task] + (hint ? ' ' + hint : '') + ' Reply in one short sentence.';

const quota = (...a) => execute(process.execPath, [qb, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, QUOTA_BOSS_BOSS_MODEL: host === 'codex' ? model : '', ...modeEnv } });
let previousProfile;
try {
{
  const status = quota('settings');
  previousProfile = /^profile\s*\|\s*(quality|balanced|frugal)\b/m.exec(status.stdout || '')?.[1];
  if (!previousProfile) throw new Error('Could not determine previous profile');
  // --project: on, off and profile are global by default, and a bench must only change its own fixture.
  const on = mode === 'off' ? quota('off', '--project') : quota('on', '--host', host === 'codex' ? 'codex' : 'claude-code', ...(profile ? [profile] : []), '--project');
  if (on.status !== 0) throw new Error('quota-boss setup failed: ' + (on.stdout + on.stderr).slice(0, 300));
}

// The boss may log feedback during the run; QUOTA_BOSS_BENCH tags it (see below).
const outcomes = path.join(os.homedir(), '.claude', 'quota-boss', 'outcomes.jsonl');
const outcomesSize = fs.existsSync(outcomes) ? fs.statSync(outcomes).size : 0;
// Subscription windows per pool before and after the run (percent used, as `quota-boss status` reports them).
// Other sessions running at the same time are included, so run benchmarks alone.
const pools = () => {
  const m = /Claude 5h (\d+)% wk (\d+)%.*?Codex 5h (\d+)% wk (\d+)%/.exec(quota('status').stdout || '');
  return m ? { claude5h: +m[1], claudeWeek: +m[2], codex5h: +m[3], codexWeek: +m[4] } : null;
};
const poolsBefore = pools();
const started = Date.now();
let run;
if (host === 'claude') {
  const cli = ['-p', '--model', model, '--output-format', 'json', '--permission-mode', 'acceptEdits',
    // Common shell helpers too, the same for every arm: denied `cd <run dir> && ...` or `| tail` calls cost boss turns in every arm (v2-s4: up to 5 per run).
    '--allowedTools', 'Bash(node:*) Bash(git:*) Bash(npm:*) Bash(cd:*) Bash(cat:*) Bash(ls:*) Bash(head:*) Bash(tail:*) Bash(grep:*) Bash(wc:*) Bash(mkdir:*) Bash(printf:*) Bash(echo:*) PowerShell(node:*) PowerShell(git:*) PowerShell(Select-Object:*) Read Edit Write Glob Grep Agent',
    // A scheduled wakeup keeps a -p run alive until the timeout after the answer is done.
    '--disallowedTools', 'ScheduleWakeup', '--max-budget-usd', '8'];
  if (effort) cli.push('--effort', effort);
  run = execute('claude', cli, { cwd: dir, input: prompt, encoding: 'utf8', timeout: 1800000, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, CLAUDECODE: '', QUOTA_BOSS_BENCH: runName, ...modeEnv } });
} else if (host === 'junie') {
  // The native exe on Windows (the .bat shim re-parses arguments); the token billing variables are dropped as for workers.
  const { nativeLauncher, childEnv } = require('../scripts/lib.js');
  const native = nativeLauncher('junie', process.env, process.platform, dir);
  const cli = ['--input-format=text', '--output-format=json', '--skip-update-check', `--model=${model}`, ...(effort ? [`--effort=${effort}`] : [])];
  run = execute(native ? native.file : 'junie', cli, { cwd: dir, input: prompt, encoding: 'utf8', shell: !native && process.platform === 'win32', timeout: 1800000, maxBuffer: 128 * 1024 * 1024, env: childEnv('junie', process.env, native) });
} else if (host === 'devin') {
  // The same switches as the devin preset: free model, no trust prompt, edits without asking. Plain text output, no usage.
  const bin = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'devin', 'cli', 'bin') : null;
  const env = { ...process.env, ...(bin ? { PATH: bin + path.delimiter + (process.env.PATH || '') } : {}) };
  run = execute('devin', ['--respect-workspace-trust', 'false', '--permission-mode', 'accept-edits', '--model', model, '-p', prompt], { cwd: dir, encoding: 'utf8', timeout: 1800000, maxBuffer: 128 * 1024 * 1024, env });
} else if (host === 'agy') {
  // The same switches as the antigravity preset: headless prompt, edits without asking, the model slug carries the effort.
  const bin = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin') : null;
  const env = { ...process.env, ...(bin ? { PATH: bin + path.delimiter + (process.env.PATH || '') } : {}) };
  run = execute('agy', ['-p', prompt, '--mode', 'auto', '--model', model], { cwd: dir, encoding: 'utf8', timeout: 1800000, maxBuffer: 128 * 1024 * 1024, env });
} else {
  run = execute('codex', ['exec', '--json', '--skip-git-repo-check', '-C', `"${dir}"`, '-s', 'workspace-write', '-m', model, '-c', `model_reasoning_effort=${effort}`, '-'],
    { input: prompt, encoding: 'utf8', shell: true, timeout: 1800000, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, QUOTA_BOSS_BOSS_MODEL: model, QUOTA_BOSS_BENCH: runName, ...modeEnv } });
}
const seconds = Math.round((Date.now() - started) / 1000);
if (run.error) {
  // No result line for a run that never started (for example `claude` installed only as a .cmd shim on Windows).

  throw new Error(`Could not start ${host}: ${run.error.message}`);
}
fs.writeFileSync(path.join(out, `stdout-${runName}.txt`), String(run.stdout || ''));
fs.writeFileSync(path.join(out, `stderr-${runName}.txt`), String(run.stderr || ''));

// Feedback from this run carries its bench tag and stays in the log (the router skips tagged lines), so other
// sessions writing at the same time lose nothing.
let feedback = [];
if (fs.existsSync(outcomes) && fs.statSync(outcomes).size > outcomesSize) {
  feedback = fs.readFileSync(outcomes).subarray(outcomesSize).toString('utf8').split('\n').filter(l => l.includes('"bench":' + JSON.stringify(runName)));
}

// Claude usage from the result JSON (boss and every Claude subagent).
let claude = null;
if (host === 'claude') {
  try {
    const r = JSON.parse(String(run.stdout || '').trim().split('\n').pop());
    claude = {
      usd: r.total_cost_usd, turns: r.num_turns, subtype: r.subtype, denied: (r.permission_denials || []).length, sessionId: r.session_id,
      models: Object.fromEntries(Object.entries(r.modelUsage || {}).map(([k, v]) => [k, +(v.costUSD || 0).toFixed(4)])),
      tokens: Object.fromEntries(Object.entries(r.modelUsage || {}).map(([k, v]) => [k, { input: v.inputTokens || 0, cacheRead: v.cacheReadInputTokens || 0, cacheWrite: v.cacheCreationInputTokens || 0, output: v.outputTokens || 0 }])),
    };
    // What filled the boss context, from the session transcript (null when it cannot be found).
    try { const file = findTranscript(r.session_id); claude.boss = file ? analyzeTranscript(file) : null; } catch (e) { claude.boss = { error: e.message }; }
  } catch { claude = { error: 'no JSON result' }; }
}

// Junie: tokens and the models it really ran, from its JSON result.
let junie = null;
if (host === 'junie') {
  const text = String(run.stdout || '');
  try {
    const r = JSON.parse(text.slice(text.indexOf('{')));
    const list = Array.isArray(r.llmUsage) ? r.llmUsage : [];
    const sum = key => list.reduce((t, u) => t + (Number(u[key]) || 0), 0);
    junie = { input: sum('inputTokens'), cached: sum('cacheInputTokens'), output: sum('outputTokens'), calls: sum('calls'), usd: sum('cost'), models: [...new Set(list.map(u => u.model))], errors: r.errors || [] };
  } catch { junie = { error: 'no JSON result' }; }
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
  date: new Date().toISOString(), runName, arm, label, host, model, effort: effort || null, mode, claudeMode, hint, task, n: +n, exit: run.status, seconds, hidden, hiddenFails,
  ownPass: count('pass'), ownFail: count('fail'), claude, junie, codexUsd, codexSessions: sessions, feedback, poolsBefore, poolsAfter: pools(),
};
fs.appendFileSync(path.join(out, 'results.jsonl'), JSON.stringify(line) + '\n');
console.log(`done ${runName} ${seconds}s hidden=${hidden} claudeUsd=${claude ? claude.usd : 0} codexUsd=${codexUsd}`);

} finally { if (previousProfile) { const off = quota('off', '--project'); const restored = quota('set', 'profile', previousProfile, '--project'); if (off.status !== 0 || restored.status !== 0) throw new Error('Could not restore quota-boss profile'); } }
}
module.exports = { main, parseArm };
if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
