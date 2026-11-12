#!/usr/bin/env node
'use strict';
// Single, safe entry point for every Codex worker (codex-worker, gpt-advisor, reviewer, consensus).
// Runs `codex exec` non-interactively with the user's own Codex login, returns only a short report
// and records the run duration so routing can learn which models are slow.
//
//   node codex-run.js --model gpt-6.1-sol --effort medium --sandbox workspace-write \
//        [--resume <session-id>] [--category implementation --tier normal] < prompt.txt

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('./lib');
const latency = require('./latency');

const SANDBOXES = new Set(['read-only', 'workspace-write']); // never danger-full-access
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const MAX_PROMPT = 200 * 1024;
const MAX_REPORT_LINES = 60;
const TIMEOUT_MS = 45 * 60 * 1000;

function parseArgs(argv) {
  const options = { effort: 'medium', sandbox: 'read-only' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--model', '--effort', '--sandbox', '--resume', '--category', '--tier'].includes(key) || value === undefined) {
      throw new Error('Usage: codex-run.js --model <id> [--effort low|medium|high|xhigh] [--sandbox read-only|workspace-write] [--resume <id>] [--category <c> --tier <t>] < prompt');
    }
    options[key.slice(2)] = value;
  }
  if (!/^[a-z0-9][a-z0-9.\-]{1,63}$/.test(options.model || '')) throw new Error('Invalid --model.');
  if (!EFFORTS.has(options.effort)) throw new Error('Invalid --effort.');
  if (!SANDBOXES.has(options.sandbox)) throw new Error('Invalid --sandbox (read-only or workspace-write only).');
  if (options.resume !== undefined && !/^[A-Za-z0-9-]{8,64}$/.test(options.resume)) throw new Error('Invalid --resume id.');
  if (options.category !== undefined && !lib.CATEGORIES.includes(options.category)) throw new Error('Invalid --category.');
  if (options.tier !== undefined && !lib.TIERS.includes(options.tier)) throw new Error('Invalid --tier.');
  return options;
}

/** Resolve Codex without shells: npm's JS entry point via this Node binary, else the trusted PATH executable. */
function codexInvocation(env = process.env, platform = process.platform, cwd = process.cwd()) {
  const override = env.QUOTA_BOSS_CODEX_JS; // tests only: a JS file standing in for Codex
  if (override && path.isAbsolute(override)) return { file: process.execPath, prefix: [override] };
  const found = lib.findExecutable('codex', env, platform, cwd);
  if (!found) return null;
  if (platform === 'win32' && /\.cmd$/i.test(found)) {
    const entry = path.join(path.dirname(found), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try { if (fs.lstatSync(entry).isFile()) return { file: process.execPath, prefix: [entry] }; } catch { /* fall through */ }
  }
  return { executable: found, prefix: [] };
}

/** Codex's Windows sandbox cannot launch Microsoft Store app aliases, so its shell must not resolve to one. */
function withoutStoreAliases(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return env;
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path');
  if (!key) return env;
  return { ...env, [key]: env[key].split(';').filter(dir => !/[\\/]Microsoft[\\/]WindowsApps(?:[\\/"]|$)/i.test(dir)).join(';') };
}

/** Unlike lib.runExecutable, Codex must start in the project: that is the workspace its sandbox opens. */
function spawnPlan(invocation, args, env = process.env, platform = process.platform, cwd = process.cwd()) {
  const target = invocation.executable
    ? lib.executableInvocation(invocation.executable, args, platform, env)
    : { file: invocation.file, args: [...invocation.prefix, ...args], windowsVerbatimArguments: false };
  return { file: target.file, args: target.args,
    options: { ...lib.childProcessOptions(withoutStoreAliases(env, platform), platform), cwd, shell: false, windowsHide: true,
      windowsVerbatimArguments: target.windowsVerbatimArguments } };
}

function buildArgs(options, lastFile) {
  const common = ['-m', options.model, '-c', 'model_reasoning_effort=' + options.effort,
    '-c', 'approval_policy=never', '-c', 'sandbox_mode=' + options.sandbox,
    '--skip-git-repo-check', '--json', '-o', lastFile];
  return options.resume ? ['exec', 'resume', ...common, options.resume, '-'] : ['exec', ...common, '-'];
}

function sessionId(stdout) {
  for (const line of String(stdout || '').split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    const id = event?.thread_id || event?.session_id || event?.payload?.thread_id || event?.payload?.session_id;
    if (typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id)) return id;
  }
  return null;
}

function limitError(text) {
  const match = String(text || '').match(/usage limit|not supported when using Codex|requires a newer version/i);
  return match ? match[0] : null;
}

function shellBlocked(stdout) {
  return /CreateProcess\w* failed/.test(String(stdout || ''));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const prompt = fs.readFileSync(0, 'utf8');
  if (!prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT) throw new Error('Prompt on stdin must be 1 byte to 200 KiB.');
  const invocation = codexInvocation();
  if (!invocation) throw new Error('Codex CLI not found on the trusted PATH. Install: npm i -g @openai/codex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-boss-codex-'));
  const lastFile = path.join(dir, 'last.md');
  const started = Date.now();
  let result;
  try {
    const plan = spawnPlan(invocation, buildArgs(options, lastFile));
    result = spawnSync(plan.file, plan.args, { ...plan.options, input: prompt, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) { result = { status: null, error }; }
  const seconds = Math.round((Date.now() - started) / 1000);
  let last = '';
  try { last = fs.readFileSync(lastFile, 'utf8'); } catch { /* no final message */ }
  fs.rmSync(dir, { recursive: true, force: true });
  const ok = result.status === 0 && last.trim() !== '';
  const problem = ok ? null : limitError((result.stderr || '') + (result.stdout || '')) || (result.error ? 'could not start Codex' : 'exit ' + result.status);
  latency.recordRun({ t: Date.now(), model: options.model, category: options.category || null, tier: options.tier || null,
    seconds, ok, sandbox: options.sandbox });
  const lines = last.trim().split('\n');
  const report = lines.length > MAX_REPORT_LINES ? lines.slice(0, MAX_REPORT_LINES).concat('[... ' + (lines.length - MAX_REPORT_LINES) + ' more lines cut]') : lines;
  process.stdout.write([
    'codex-run: ' + (ok ? 'ok' : 'FAILED (' + problem + ')') + ' | model ' + options.model + ' @' + options.effort
      + ' | ' + options.sandbox + ' | ' + seconds + 's | session ' + (sessionId(result.stdout) || 'unknown'),
    ...(shellBlocked(result.stdout) ? ['Warning: Codex could not start a shell in its sandbox, so its commands and tests did not run. Verify outside Codex.'] : []),
    ...(ok ? report : []),
    ...(problem && /usage limit|not supported|newer version/i.test(problem)
      ? ['Hint: log it so routing avoids this model: quota-boss feedback ' + options.model + ' ' + (options.category || 'implementation') + ' ' + (options.tier || 'normal') + ' unavailable'] : []),
  ].join('\n') + '\n');
  process.exitCode = ok ? 0 : 1;
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write('codex-run: ' + error.message + '\n'); process.exitCode = 2; }
}
module.exports = { parseArgs, buildArgs, sessionId, codexInvocation, limitError, withoutStoreAliases, spawnPlan, shellBlocked };
