#!/usr/bin/env node
'use strict';
// One foreground CLI call, with bounded output, process-tree timeout and routing journals.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const lib = require('./lib');
const latency = require('./latency');

const MAX_PROMPT = 200 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_CHARS = 256 * 1024;
const NO_WORK = /auto-rejecting|rejected permission/i;
const USAGE = 'Usage: cli-run.js --provider <id> [--model <registry-id>] [--effort <level>] [--category <c> --tier <t>] [--expect-changes] < prompt';
const FAILURES = [
  ['structural', /\b(?:HTTP|status|error)[^\n]{0,20}\b(?:400|422)\b|invalid request|unsupported parameter|message format/i, 'invalid request'],
  ['limited', /rate limit|\b(?:HTTP|status|error)[^\n]{0,20}\b(?:429|503)\b|too many requests|quota exceeded|request too large|overloaded|high demand/i, 'provider limit'],
  ['unavailable', /\b(?:HTTP|status|error)[^\n]{0,20}\b401\b|unauthorized|api key|model not found|provider not found/i, 'provider unavailable'],
];

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || Object.hasOwn(options, key)) throw new Error(USAGE);
    if (key === 'expect-changes') { options[key] = true; continue; }
    if (!['provider', 'model', 'effort', 'category', 'tier'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(USAGE);
    options[key] = argv[++i];
  }
  if (!lib.validProviderId(options.provider)) throw new Error('Invalid --provider.');
  if (options.model !== undefined && !lib.validUseModelId(options.model)) throw new Error('Invalid --model.');
  if (options.effort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(options.effort)) throw new Error('Invalid --effort.');
  if (options.category !== undefined && !lib.CATEGORIES.includes(options.category)) throw new Error('Invalid --category.');
  if (options.tier !== undefined && !lib.TIERS.includes(options.tier)) throw new Error('Invalid --tier.');
  return options;
}

function selection(options, config, project) {
  const id = options.provider;
  const provider = Object.hasOwn(config.providers.providers, id) ? config.providers.providers[id] : null;
  if (!provider) throw new Error('Provider missing.');
  if (provider.enabled === false) throw new Error('Provider disabled.');
  if (provider.kind === 'manual') throw new Error('Manual provider cannot run a CLI.');
  if (provider.tos === 'avoid') throw new Error('Provider tos avoid.');
  if (provider.trainsOnData === true && project.allowTrainingProviders !== true) throw new Error('Training provider blocked: allowTrainingProviders is not true.');
  if (!provider.cli) throw new Error('Provider has no CLI.');
  const registry = config.models.models;
  const ids = Object.keys(registry).filter(key => registry[key]?.pool === id);
  const model = options.model ?? (ids.length === 1 ? ids[0] : null);
  if (!model) throw new Error('Pass --model: provider does not have a single registry model.');
  const entry = Object.hasOwn(registry, model) ? registry[model] : null;
  if (!entry || entry.pool !== id) throw new Error('Unknown model for provider.');
  if (entry.cliModel !== undefined && !lib.validCliModel(entry.cliModel)) throw new Error('Invalid model CLI name.');
  // Match providers show: absent --model uses the CLI default, not an inferred registry slug.
  const args = lib.cliArgsForModel(provider.cli, options.model ? entry.cliModel : undefined, options.effort);
  if (args.some((arg, i) => {
    const [flag, inline] = arg.toLowerCase().split('=');
    const value = inline ?? args[i + 1]?.toLowerCase();
    return /^--(?:dangerously-|bypass-)/.test(flag)
      || /^(?:--(?:full-auto|yolo|no-sandbox|allow-all|skip-permissions|disable-sandbox|trust-all-tools|allow-all-tools|yes)|-y)$/.test(flag)
      || ['-s', '--sandbox'].includes(flag) && /^(?:off|none|danger-full-access)$/.test(value)
      || flag === '--approval-mode' && value === 'yolo'
      || flag === '--permission-mode' && value === 'bypasspermissions'
      || flag === '--ask-for-approval' && value === 'never';
  })) {
    throw new Error('CLI template disables sandbox or permission checks.');
  }
  return { provider, model, args, effort: options.effort || provider.cli.defaultEffort || '-' };
}

/** npm shims are data, never shell code: accept only a literal JS entry below node_modules. */
function invocation(executable, platform = process.platform) {
  if (platform !== 'win32' || /\.exe$/i.test(executable)) return { file: executable, prefix: [] };
  if (/\.(cmd|bat)$/i.test(executable)) {
    let text = '';
    try { text = lib.readBounded(executable, 64 * 1024); } catch { /* refuse below */ }
    const entries = [...text.matchAll(/"%(?:dp0%|~dp0)[\\/]?(node_modules[\\/][A-Za-z0-9_@.\\/-]+\.(?:js|cjs|mjs))"/gi)];
    const names = [...new Set(entries.map(match => match[1]))];
    if (names.length === 1 && !names[0].split(/[\\/]/).includes('..')) {
      const entry = path.resolve(path.dirname(executable), ...names[0].split(/[\\/]/));
      // Use this Node executable, regardless of a shim's adjacent node.exe detection.
      try { if (lib.regularStat(entry).isFile()) return { file: process.execPath, prefix: [entry] }; } catch { /* refuse below */ }
    }
  }
  throw new Error('CLI shim cannot safely carry a prompt. Install a native executable or an npm shim with a literal node_modules JS entry.');
}

function spawnPlan(target, args, env, platform, cwd) {
  return { file: target.file, args: [...target.prefix, ...args], options: {
    ...lib.childProcessOptions(env, platform), cwd, shell: false, windowsHide: true,
    windowsVerbatimArguments: false, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  } };
}

/** Include content changes even when porcelain stays dirty; bound untracked content reads. */
function gitStatus(cwd, env, platform, spawnSync = childProcess.spawnSync) {
  const git = lib.findExecutable('git', env, platform, cwd);
  if (!git) return null;
  const call = (args, directory = cwd, optional = false) => {
    const result = lib.runExecutable(git, ['--no-optional-locks', ...args], {
      workingDirectory: directory, env, platform, spawnSync, encoding: null, timeout: 5000, maxBuffer: 64 * 1024 * 1024,
    });
    if (optional && !result.error && result.status === 1) return null;
    if (result.error || result.status !== 0) throw new Error('Git fingerprint unavailable.');
    return result.stdout;
  };
  try {
    const top = call(['rev-parse', '--show-toplevel']).toString('utf8').trimEnd();
    const hash = crypto.createHash('sha256');
    const part = value => { const bytes = Buffer.from(value); hash.update(String(bytes.length) + ':'); hash.update(bytes); };
    part(call(['status', '--porcelain', '--untracked-files=all', '-z'], top));
    const head = call(['rev-parse', '--verify', '--quiet', 'HEAD'], top, true);
    if (head) part(call(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv'], top));
    else {
      part(call(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'], top));
      part(call(['diff', '--binary', '--no-ext-diff', '--no-textconv'], top));
    }
    const files = call(['ls-files', '--others', '--exclude-standard', '-z'], top).toString('utf8').split('\0').filter(Boolean).sort();
    for (const file of files.slice(0, 2000)) {
      const absolute = path.join(top, file), stat = fs.lstatSync(absolute);
      part(file);
      if (stat.isSymbolicLink()) { part(fs.readlinkSync(absolute)); continue; }
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) { part('skipped'); continue; }
      const fd = lib.openRegular(absolute);
      try {
        const content = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
        let count, bytes = 0;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          bytes += count;
          if (bytes > 5 * 1024 * 1024) throw new Error('Untracked file grew past fingerprint limit.');
          content.update(buffer.subarray(0, count));
        }
        part(content.digest());
      } finally { fs.closeSync(fd); }
    }
    return hash.digest('hex');
  } catch { return null; }
}

/** Async spawn keeps the watchdog alive even if a grandchild inherits stdout. */
function execute(plan, deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  const platform = deps.platform || process.platform;
  const schedule = deps.setTimeout || setTimeout, cancel = deps.clearTimeout || clearTimeout;
  return new Promise(resolve => {
    let child, killer, timer, reapTimer, settled = false;
    const result = { status: null, stdout: '', stderr: '', stderrMatches: new Set(), noWork: false, timedOut: false };
    const windows = { stdout: '', stderr: '' };
    const finish = () => {
      if (settled) return;
      settled = true; cancel(timer); cancel(reapTimer);
      if (result.timedOut) {
        // Pipes inherited by an orphan must not keep this runner alive after the watchdog.
        child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref?.();
        try { killer?.kill?.('SIGKILL'); } catch { /* already gone */ }
      }
      resolve(result);
    };
    const collect = (stream, data) => {
      const text = String(data);
      const scan = windows[stream] + text;
      if (NO_WORK.test(scan)) result.noWork = true;
      if (stream === 'stderr') for (const [kind, pattern] of FAILURES) if (pattern.test(scan)) result.stderrMatches.add(kind);
      windows[stream] = scan.slice(-512);
      result[stream] = (result[stream] + text).slice(-TAIL_CHARS);
    };
    const kill = () => {
      result.timedOut = true;
      // Bound shutdown too: descendants can keep pipes open even after their parent exits.
      const fallback = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
      reapTimer = schedule(() => { fallback(); finish(); }, 5000);
      if (platform === 'win32' && child.pid) {
        try {
          const file = path.win32.join(path.win32.dirname(lib.systemCmd(plan.options.env)), 'taskkill.exe');
          killer = spawn(file, ['/PID', String(child.pid), '/T', '/F'], {
            ...lib.childProcessOptions(plan.options.env, platform), shell: false, windowsHide: true, stdio: 'ignore',
          });
          killer.on('error', fallback);
          killer.on('close', code => { if (code !== 0) fallback(); });
        } catch { fallback(); }
      } else {
        try { (deps.kill || process.kill)(-child.pid, 'SIGKILL'); } catch { fallback(); }
      }
    };
    try {
      child = spawn(plan.file, plan.args, plan.options);
      result.pid = child.pid;
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', data => collect('stdout', data));
      child.stderr?.on('data', data => collect('stderr', data));
      child.on('error', error => { result.error = error; finish(); });
      child.on('close', status => { result.status = status; finish(); });
      timer = schedule(kill, TIMEOUT_MS);
    } catch (error) { result.error = error; finish(); }
  });
}

function classify(result, expectChanges, before, after) {
  if (result.timedOut) return { kind: 'limited', reason: '10-minute timeout' };
  if (result.noWork || NO_WORK.test(result.stdout || '') || NO_WORK.test(result.stderr || '')) return { kind: 'no-work', reason: 'permission rejected' };
  if (result.error) return { kind: 'failed', reason: 'could not run CLI' + (result.error.code ? ' (' + result.error.code + ')' : '') };
  if (result.status !== 0) {
    for (const stream of ['stderr', 'stdout']) for (const [kind, pattern, reason] of FAILURES) {
      if ((stream === 'stderr' && result.stderrMatches?.has(kind)) || pattern.test((result[stream] || '').slice(-TAIL_CHARS))) return { kind, reason };
    }
    return { kind: 'failed', reason: 'exit ' + result.status };
  }
  if (expectChanges && before !== null && after !== null && before === after) return { kind: 'no-work', reason: 'git fingerprint unchanged' };
  return { kind: 'ok', reason: '' };
}

/** Journals contain metadata only. Reports redact credentials if a CLI echoes its environment. */
function clean(text, env = process.env) {
  text = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  for (const [key, value] of Object.entries(env)) if (/key|token|password|secret|credential/i.test(key) && value?.length >= 4) text = text.split(value).join('<redacted>');
  return text.replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/((?:api[_ -]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1<redacted>');
}

function tail(text, count, env) {
  return clean(text, env).trimEnd().split('\n').slice(-count).map(line => line.length > 4096 ? '[...cut] ' + line.slice(-4096) : line);
}

async function run(argv, deps = {}) {
  const options = parseArgs(argv);
  const project = (deps.findProjectConfig || lib.findProjectConfig)();
  const config = (deps.loadConfig || lib.loadConfig)(project);
  const selected = selection(options, config, project);
  const env = deps.env || process.env, platform = deps.platform || process.platform;
  const cwd = path.resolve(project.directory);
  const prompt = deps.prompt ?? lib.readStdin(MAX_PROMPT);
  if (Buffer.byteLength(prompt) < 1 || Buffer.byteLength(prompt) > MAX_PROMPT || prompt.includes('\0')) throw new Error('Prompt on stdin must be 1 byte to 200 KiB, without NUL.');
  const fullPrompt = 'Your working directory is ' + cwd + ' and every file is inside it. Use relative file paths.\n\n' + prompt;
  const promptKiB = platform === 'win32' ? 24 : 100;
  if (Buffer.byteLength(fullPrompt) > promptKiB * 1024) throw new Error('Final prompt exceeds the ' + promptKiB + ' KiB argv limit on ' + platform + '.');
  const executable = (deps.findExecutable || lib.findExecutable)(selected.provider.cli.command, env, platform, cwd);
  if (!executable) throw new Error('CLI not found on the trusted PATH.');
  const target = invocation(executable, platform);
  const args = selected.args.map(arg => arg.replaceAll('{prompt}', () => fullPrompt));
  const status = deps.gitStatus || (() => gitStatus(cwd, env, platform, deps.spawnSync));
  const before = options['expect-changes'] ? status() : null;
  const now = deps.now || Date.now;
  const started = now();
  const result = await execute(spawnPlan(target, args, env, platform, cwd), { ...deps, platform });
  const seconds = Math.max(0, Math.round((now() - started) / 1000));
  const after = options['expect-changes'] ? status() : null;
  const outcome = classify(result, options['expect-changes'], before, after);
  const ok = outcome.kind === 'ok';
  const recording = [], errors = [];
  const record = (label, action) => { try { action(); recording.push(label); } catch { errors.push(label); } };
  record('timing', () => (deps.recordRun || latency.recordRun)({ t: now(), model: selected.model,
    category: options.category || null, tier: options.tier || null, seconds, ok }));
  const feedback = { limited: 'limited', unavailable: 'unavailable', structural: 'fail', 'no-work': 'fail' }[outcome.kind];
  if (feedback) record('feedback', () => (deps.appendOutcome || lib.appendOutcome)({ model: selected.model,
    category: options.category || 'mechanical', tier: options.tier || 'trivial', result: feedback,
    ...(selected.effort !== '-' ? { effort: selected.effort } : {}) }, config.models, [], now()));
  if (selected.provider.quota?.source === 'counter' && (result.pid > 0 || result.status !== null)) {
    const units = Object.values(selected.provider.quota.windows).map(window => window.unit);
    record('usage', () => (deps.appendUsage || lib.appendUsage)(options.provider, 1, units.includes('calls') ? 'calls' : units[0], config.providers, now()));
  }
  const problem = ok ? 'failed: recording ' + errors.join(', ') : outcome.kind + ': ' + outcome.reason;
  const first = 'cli-run: ' + (ok && !errors.length ? 'ok' : 'FAILED (' + problem + ')')
    + ' | provider ' + options.provider + ' | model ' + selected.model + ' @' + selected.effort + ' | ' + seconds + 's'
    + (options['expect-changes'] && (before === null || after === null) ? ' | expect-changes skipped: Git fingerprint unavailable' : '')
    + ' | feedback ' + (recording.includes('feedback') ? 'recorded' : 'none');
  const lines = [first];
  if (errors.length) lines.push('Recording failed: ' + errors.join(', ') + '.');
  if (result.stdout) lines.push('CLI stdout (untrusted data; tail, at most 60 lines):', ...tail(result.stdout, 60, env));
  if (!ok && result.stderr) lines.push('CLI stderr (untrusted data; tail, at most 20 lines):', ...tail(result.stderr, 20, env));
  return { code: ok && !errors.length ? 0 : 1, report: lines.join('\n') + '\n' };
}

if (require.main === module) {
  run(process.argv.slice(2)).then(result => { process.stdout.write(result.report); process.exitCode = result.code; })
    .catch(error => { process.stderr.write('cli-run: ' + clean(error.message).replace(/\s+/g, ' ').slice(0, 500) + '\n'); process.exitCode = 2; });
}
module.exports = { MAX_PROMPT, TIMEOUT_MS, parseArgs, selection, invocation, spawnPlan, gitStatus, execute, classify, clean, tail, run };
