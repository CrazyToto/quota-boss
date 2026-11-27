#!/usr/bin/env node
'use strict';
// One foreground CLI call, with bounded output, process-tree timeout and routing journals.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const lib = require('./lib');
const latency = require('./latency');
const { resolveWorkdir } = require('./worktree');

const MAX_PROMPT = 200 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_CHARS = 256 * 1024;
const NO_WORK = /auto-rejecting|rejected permission/i;
const AUTH_MISSING = /^Cannot find authorization\. Please authenticate before running Junie\.\r?$/m;
// Junie reports request errors (a refused license, limits) only in its JSON result, not on stdout or in the exit code.
const JUNIE_LICENSE = /\b492\b|untrusted license|no (?:valid |active )?licen[cs]e/i;
const JUNIE_REPORT_MAX = 8 * 1024 * 1024;
// Devin prints these at the start of a line and can still exit 0 (texts from the CLI 3000.14, 2026-11-27).
const DEVIN_AUTH = /^(?:Not logged in\b|Authentication required\b)/m;
const DEVIN_LIMIT = /^(?:You've reached your monthly usage limit|Your organization has reached its monthly usage limit|(?:Organization )?usage limit reached|Usage paused|Monthly ACU limit reached|Quota exhausted)\b/mi;
// A CLI with settleMinutes is stopped once it has changed files and the work tree then stays the same that long:
// Devin sometimes keeps running for half an hour after its last edit.
const SETTLE_POLL_MS = 30 * 1000;
const COPILOT_EVENTS_MAX = 32 * 1024 * 1024;
// Booked when a credit counter has no meter reading: about a median Copilot worker job (4.6-10 credits seen).
const CREDIT_ESTIMATE = 5;
const CLAUDE_CLI = { command: 'claude', args: ['-p', '--model', '{model}', '--effort', '{effort}', '--output-format', 'json', '--permission-mode', 'acceptEdits'] };
const USAGE = 'Usage: cli-run.js --provider <id> [--model <registry-id>] [--effort <level>] [--category <c> --tier <t>] [--cwd <dir>] [--expect-changes] [--prompt-file <name>] [--input <file|YouTube URL>] < prompt';
// The Gemini API CLI sends a file inline only up to 14 MB; bigger files need its upload step.
const MAX_INPUT = 14 * 1024 * 1024;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// File types per declared input; anything else (and hidden files such as .env or .git) never leaves the machine.
const INPUT_TYPES = { image: ['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif'], pdf: ['pdf'],
  video: ['mp4', 'mpeg', 'mpg', 'mov', 'avi', 'flv', 'webm', 'wmv', '3gp'], audio: ['wav', 'mp3', 'aiff', 'aac', 'ogg', 'flac', 'm4a'] };

/** A public YouTube watch or short link, as the plain watch URL; extra parameters such as &t= are dropped. */
function youtube(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const id = ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) && url.pathname === '/watch' ? url.searchParams.get('v')
    : url.hostname === 'youtu.be' ? url.pathname.slice(1) : null;
  return id && VIDEO_ID.test(id) ? 'https://www.youtube.com/watch?v=' + id : null;
}
const CONTEXT_ERROR = /context length|maximum context|too many tokens/i;
// A provider limit is a quota (an account or rate counter that resets) or an outage (the service is overloaded or down).
const QUOTA_ERROR = /\b429\b|rate limit|too many requests|quota|per-day|per day|usage limit|request too large|credits/i;
const OUTAGE_ERROR = /\b(?:500|502|503|504|529)\b|overloaded|high demand|service unavailable|bad gateway|temporarily unavailable/i;
function limitCause(text) {
  return OUTAGE_ERROR.test(text) && !QUOTA_ERROR.test(text) ? 'outage' : 'quota';
}
const FAILURES = [
  ['context', CONTEXT_ERROR, 'context length exceeded'],
  ['structural', /\b(?:HTTP|status|error)[^\n]{0,20}\b(?:400|422)\b|invalid request|unsupported parameter|message format/i, 'invalid request'],
  ['limited', /rate limit|usage limit|\b(?:HTTP|status|error)[^\n]{0,20}\b(?:429|500|502|503|504|529)\b|too many requests|quota exceeded|request too large|overloaded|high demand/i, 'provider limit'],
  ['unavailable', /\b(?:HTTP|status|error)[^\n]{0,20}\b401\b|unauthorized|api key|model not found|provider not found/i, 'provider unavailable'],
];

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || Object.hasOwn(options, key)) throw new Error(USAGE);
    if (key === 'expect-changes') { options[key] = true; continue; }
    if (!['provider', 'model', 'effort', 'category', 'tier', 'cwd', 'prompt-file', 'input'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(USAGE);
    options[key] = argv[++i];
  }
  if (!lib.validProviderId(options.provider)) throw new Error('Invalid --provider.');
  if (options.model !== undefined && !lib.validUseModelId(options.model)) throw new Error('Invalid --model.');
  if (options.effort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(options.effort)) throw new Error('Invalid --effort.');
  if (options.category !== undefined && !lib.CATEGORIES.includes(options.category)) throw new Error('Invalid --category.');
  if (options.tier !== undefined && !lib.TIERS.includes(options.tier)) throw new Error('Invalid --tier.');
  return options;
}

/** A public YouTube link (video), or a regular file of a declared type inside the working directory (after links are resolved), at most 14 MiB. */
function inputArgument(input, cwd, deps = {}, kinds = Object.keys(INPUT_TYPES)) {
  const link = youtube(input);
  if (link) {
    if (!kinds.includes('video')) throw new Error('This provider takes no video input.');
    return link;
  }
  if (/^https?:/i.test(input)) throw new Error('Only YouTube links are accepted as URL input.');
  // Lexical checks first, so a network share or device path is never even probed (on Windows that could send credentials).
  const lexical = path.relative(path.resolve(cwd), path.resolve(cwd, input));
  if (/^[\\/]{2}/.test(input) || !lexical || lexical === '..' || lexical.startsWith('..' + path.sep) || path.isAbsolute(lexical)) throw new Error('Input file must be inside the working directory.');
  // A CLI may trim names or read an alternate data stream (name:stream), and then open another file than the one checked.
  if (lexical.split(path.sep).some(part => part !== part.trim() || part.includes(':'))) throw new Error('Input file name must not have spaces at its ends or a colon.');
  const realpath = deps.realpath || fs.realpathSync, stat = deps.stat || fs.statSync;
  let root, file;
  try { root = realpath(cwd); file = realpath(path.resolve(cwd, input)); } catch { throw new Error('Input file not found.'); }
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Input file must be inside the working directory.');
  if (relative.split(path.sep).some(part => part.startsWith('.'))) throw new Error('Hidden files and folders are never sent as input.');
  const type = path.extname(file).slice(1).toLowerCase();
  if (!kinds.some(kind => (INPUT_TYPES[kind] || []).includes(type))) throw new Error('This provider takes no .' + (type || '(none)') + ' input; it takes: ' + kinds.join(', ') + '.');
  const info = stat(file);
  if (!info.isFile()) throw new Error('Input must be a regular file.');
  if (info.size > MAX_INPUT) throw new Error('Input file is larger than 14 MiB.');
  return file;
}

/** Fill {input}; without an input the placeholder goes, and so does the flag right before it. */
function withInput(args, input, cwd, deps, kinds) {
  const at = args.indexOf('{input}');
  if (at < 0) {
    if (input !== undefined) throw new Error('This provider takes no --input.');
    return args;
  }
  return input !== undefined ? args.map((arg, index) => index === at ? inputArgument(input, cwd, deps, kinds) : arg) : lib.dropInput(args);
}

function selection(options, config, project) {
  const id = options.provider;
  const provider = Object.hasOwn(config.providers.providers, id) ? config.providers.providers[id] : null;
  if (!provider) throw new Error('Provider missing.');
  if (provider.enabled === false) throw new Error('Provider disabled.');
  if (provider.kind === 'manual') throw new Error('Manual provider cannot run a CLI.');
  if (provider.tos === 'avoid') throw new Error('Provider tos avoid.');
  if (provider.trainsOnData === true && project.allowTrainingProviders !== true) throw new Error('Training provider blocked: allowTrainingProviders is not true.');
  const claude = id === 'claude' && !provider.cli;
  const cli = provider.cli || (claude ? CLAUDE_CLI : null);
  if (!cli) throw new Error('Provider has no CLI.');
  const registry = config.models.models;
  const ids = Object.keys(registry).filter(key => registry[key]?.pool === id && registry[key].enabled !== false);
  const model = options.model ?? (!claude && ids.length === 1 ? ids[0] : null);
  if (!model) throw new Error('Pass --model: provider does not have a single registry model.');
  const entry = Object.hasOwn(registry, model) ? registry[model] : null;
  if (!entry || entry.pool !== id) throw new Error('Unknown model for provider.');
  // An off model (a paid-plan model before quota-boss use <model> on, or one switched off) never runs.
  if (entry.enabled === false) throw new Error('Model ' + model + ' is off. Turn it on with quota-boss use ' + model + ' on.');
  const cliModel = claude ? entry.cliModel ?? model : entry.cliModel;
  if ((claude || entry.cliModel !== undefined) && !lib.validCliModel(cliModel)) throw new Error('Invalid model CLI name.');
  // Match providers show: absent --model uses the CLI default, not an inferred registry slug.
  const args = lib.cliArgsForModel(cli, claude || options.model ? cliModel : undefined, options.effort);
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
  return { provider, cli, claude, model, args, stdin: claude || cli.promptVia === 'stdin', effort: options.effort || cli.defaultEffort || '-' };
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

function spawnPlan(target, args, env, platform, cwd, input) {
  return { file: target.file, args: [...target.prefix, ...args], ...(input !== undefined ? { input } : {}), options: {
    ...lib.childProcessOptions(env, platform, cwd), shell: false, windowsHide: true,
    windowsVerbatimArguments: false, detached: platform !== 'win32', stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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
    let child, killer, timer, reapTimer, poller, settled = false;
    const result = { status: null, stdout: '', stderr: '', stderrMatches: new Set(), noWork: false, timedOut: false };
    const windows = { stdout: '', stderr: '' };
    const finish = () => {
      if (settled) return;
      settled = true; cancel(timer); cancel(reapTimer);
      if (poller) (deps.clearInterval || clearInterval)(poller);
      if (result.timedOut || result.settled) {
        // Pipes inherited by an orphan must not keep this runner alive after the watchdog.
        child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref?.();
        try { killer?.kill?.('SIGKILL'); } catch { /* already gone */ }
      }
      resolve(result);
    };
    const collect = (stream, data) => {
      const text = String(data);
      const scan = windows[stream] + text;
      if ((!deps.claude || stream === 'stderr') && NO_WORK.test(scan)) result.noWork = true;
      if (stream === 'stderr') for (const [kind, pattern] of FAILURES) if (pattern.test(scan)) result.stderrMatches.add(kind);
      windows[stream] = scan.slice(-512);
      if (plan.input !== undefined && stream === 'stdout' && result.stdout.length + text.length > TAIL_CHARS) result.stdoutTruncated = true;
      result[stream] = (result[stream] + text).slice(-TAIL_CHARS);
    };
    const kill = (done = false) => {
      if (done === true) result.settled = true; else result.timedOut = true;
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
      if (deps.settle) {
        const { ms, poll, before } = deps.settle, now = deps.now || Date.now;
        let last = before, changedAt = null;
        poller = (deps.setInterval || setInterval)(() => {
          if (settled || result.timedOut || result.settled) return;
          const current = poll();
          if (current === null) return;
          if (current !== last) { last = current; changedAt = now(); return; }
          if (current !== before && changedAt !== null && now() - changedAt >= ms) { cancel(timer); kill(true); }
        }, SETTLE_POLL_MS);
      }
      if (plan.input !== undefined) {
        child.stdin.on('error', () => {});
        try { child.stdin.end(plan.input); } catch { /* close decides, including EPIPE */ }
      }
    } catch (error) { result.error = error; finish(); }
  });
}

function classify(result, expectChanges, before, after, env, claude = false, junie = false, devin = false) {
  if (result.timedOut) return { kind: 'timeout', reason: '10-minute timeout' };
  if (devin) {
    const text = ['stdout', 'stderr'].map(stream => (result[stream] || '').slice(-TAIL_CHARS)).join('\n');
    if (DEVIN_AUTH.test(text)) return { kind: 'unavailable', reason: 'not logged in' };
    if (DEVIN_LIMIT.test(text)) return { kind: 'limited', reason: 'provider limit', cause: 'quota' };
  }
  // Stopped after its edits settled: the exit code is the kill, and the boss's checks judge the work.
  if (result.settled) return before !== null && after !== null && before === after ? { kind: 'no-work', reason: 'git fingerprint unchanged' } : { kind: 'ok', reason: '' };
  if (result.noWork || (!claude && NO_WORK.test(result.stdout || '')) || NO_WORK.test(result.stderr || '')) return { kind: 'no-work', reason: 'permission rejected' };
  if (result.error) return { kind: 'failed', reason: 'could not run CLI' + (result.error.code ? ' (' + result.error.code + ')' : '') };
  // Junie prints its login hint and still exits 0, so this one exact line counts even on success.
  if (junie && ['stdout', 'stderr'].some(stream => AUTH_MISSING.test(result[stream] || ''))) return { kind: 'unavailable', reason: 'not logged in' };
  const junieErrors = junie && Array.isArray(result.junie?.errors) ? result.junie.errors.filter(item => typeof item === 'string').join('\n') : '';
  if (junieErrors) {
    if (JUNIE_LICENSE.test(junieErrors)) return { kind: 'unavailable', reason: 'JetBrains license not accepted' };
    for (const [kind, pattern, reason] of FAILURES) if (pattern.test(junieErrors)) return { kind, reason };
  }
  let envelopeError;
  if (claude && result.claude && (result.claude.is_error === true || result.claude.subtype !== 'success')) {
    const status = result.claude.api_error_status, subtype = result.claude.subtype;
    const kind = CONTEXT_ERROR.test(result.claude.result || '') || CONTEXT_ERROR.test(result.stderr || '') ? 'context' : [400, 422].includes(status) ? 'structural' : [429, 500, 502, 503, 504, 529].includes(status) ? 'limited'
      : [401, 403].includes(status) ? 'unavailable' : null;
    const reason = clean(Number.isFinite(status) ? 'api_error_status ' + status
      : typeof subtype === 'string' && subtype !== 'success' ? subtype : 'error', env).replace(/\s+/g, ' ').trim().slice(0, 160);
    envelopeError = { kind: kind || 'failed', reason: reason && reason !== 'success' ? reason : 'error',
      ...(kind === 'limited' && Number.isFinite(status) ? { cause: status === 429 ? 'quota' : 'outage' } : {}) };
    if (kind) return envelopeError;
  }
  if (result.status !== 0) {
    for (const stream of claude ? ['stderr'] : ['stderr', 'stdout']) for (const [kind, pattern, reason] of FAILURES) {
      if ((stream === 'stderr' && result.stderrMatches?.has(kind)) || pattern.test((result[stream] || '').slice(-TAIL_CHARS))) return { kind, reason: envelopeError?.reason || reason };
    }
  }
  if (envelopeError) return envelopeError;
  if (result.status !== 0) return { kind: 'failed', reason: 'exit ' + result.status };
  if (claude && !result.claude) return { kind: 'failed', reason: 'unparseable JSON result' };
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

async function takeSlot(id, provider, deps) {
  const cap = Number.isSafeInteger(provider.maxParallel) && provider.maxParallel > 0 ? provider.maxParallel : id === 'copilot' ? 2 : 0;
  if (!cap) return { release() {} };
  const now = deps.now || Date.now;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const pidAlive = deps.pidAlive || (pid => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  });
  const folder = path.join((deps.getPaths || lib.getPaths)().quotaBossHome, 'slots', id);
  const guard = path.join(folder, 'guard');
  const deadline = now() + TIMEOUT_MS;
  while (true) {
    const slot = lib.withLock(guard, () => {
      for (let i = 0; i < cap; i++) {
        const file = path.join(folder, i + '.json');
        const old = lib.readJson(file);
        const stat = lib.regularStat(file, true);
        if (stat) {
          const started = Number.isFinite(old?.started) ? old.started : stat.mtimeMs;
          const dead = Number.isInteger(old?.pid) && old.pid > 0 && !pidAlive(old.pid);
          if (!dead && now() - started <= TIMEOUT_MS + 60000) continue;
          fs.unlinkSync(file);
        }
        const encoded = JSON.stringify({ pid: process.pid, started: now(), nonce: crypto.randomBytes(16).toString('hex') });
        const fd = lib.openRegular(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, true);
        try { fs.writeFileSync(fd, encoded); } finally { fs.closeSync(fd); }
        return { release() {
          lib.withLock(guard, () => {
            if (JSON.stringify(lib.readJson(file)) === encoded) fs.unlinkSync(file);
          });
        } };
      }
      return null;
    });
    if (slot) return slot;
    if (now() >= deadline) return { timeout: 'All ' + cap + ' ' + id + ' slots busy', release() {} };
    await sleep(Math.min(2000, deadline - now()));
  }
}

async function run(argv, deps = {}) {
  const options = parseArgs(argv);
  // Read first, so a prompt file never outlives a run that fails on its settings.
  const prompt = deps.prompt ?? (options['prompt-file'] ? lib.takePrompt(options['prompt-file'], MAX_PROMPT) : lib.readStdin(MAX_PROMPT));
  const project = (deps.findProjectConfig || lib.findProjectConfig)();
  const config = (deps.loadConfig || lib.loadConfig)(project);
  const selected = selection(options, config, project);
  const env = deps.env || process.env, platform = deps.platform || process.platform;
  const cwd = options.cwd === undefined ? path.resolve(project.directory) : resolveWorkdir(options.cwd, process.cwd(), deps);
  if (Buffer.byteLength(prompt) < 1 || Buffer.byteLength(prompt) > MAX_PROMPT || prompt.includes('\0')) throw new Error('Prompt on stdin must be 1 byte to 200 KiB, without NUL.');
  const fullPrompt = 'Your working directory is ' + cwd + ' and every file is inside it. Use relative file paths.\n\n' + prompt;
  const promptKiB = platform === 'win32' ? 24 : 100;
  if (!selected.stdin && Buffer.byteLength(fullPrompt) > promptKiB * 1024) throw new Error('Final prompt exceeds the ' + promptKiB + ' KiB argv limit on ' + platform + '.');
  // A Windows .bat launcher is replaced by the native exe it would start, with the environment it would set.
  const native = (deps.nativeLauncher || lib.nativeLauncher)(selected.cli.command, env, platform, cwd);
  const executable = native ? native.file : (deps.findExecutable || lib.findExecutable)(selected.cli.command, env, platform, cwd);
  if (!executable) throw new Error('CLI not found on the trusted PATH.');
  const target = invocation(executable, platform);
  // The prompt goes in first: the full prompt has a prefix, so it can never become the bare {input} argument.
  const args = withInput(selected.args.map(arg => arg.replaceAll('{prompt}', () => fullPrompt)), options.input, cwd, deps, selected.cli.inputs || []);
  const junie = path.basename(String(selected.cli?.command)).replace(/\.(exe|bat|cmd)$/i, '').toLowerCase() === 'junie';
  const devin = path.basename(String(selected.cli?.command)).replace(/\.(exe|bat|cmd)$/i, '').toLowerCase() === 'devin';
  // With --output-format=json Junie writes its result (errors, models used, tokens) to a private temp file and stdout
  // keeps the readable answer. A user CLI with text output or its own output file is left as it is.
  const junieReport = junie && args.includes('--output-format=json') && !args.some(arg => arg.startsWith('--json-output-file'))
    ? path.join((deps.tmpdir || os.tmpdir)(), 'quota-boss-junie-' + crypto.randomBytes(8).toString('hex') + '.json') : null;
  if (junieReport) args.push('--json-output-file=' + junieReport);
  // Copilot keeps each session's events, with its AI credit meter, under COPILOT_HOME. A session id of our own finds
  // them after the run, so the counter books what GitHub bills instead of one call per launch.
  const copilot = path.basename(String(selected.cli?.command)).replace(/\.(exe|bat|cmd)$/i, '').toLowerCase() === 'copilot';
  const copilotSession = copilot && !args.some(arg => /^(?:--session-id|--resume|--continue|-r)(?:=|$)/.test(arg)) ? crypto.randomUUID() : null;
  if (copilotSession) args.push('--session-id', copilotSession);
  const status = deps.gitStatus || (() => gitStatus(cwd, env, platform, deps.spawnSync));
  const before = options['expect-changes'] ? status() : null;
  const slot = await takeSlot(options.provider, selected.provider, deps);
  const now = deps.now || Date.now;
  const started = now();
  // A model whose pause just ended is half-open: this run is its one probe, so other routes wait for the result.
  let probe = null;
  const releaseProbe = () => {
    if (probe !== null) { try { (deps.releaseProbe || lib.releaseProbe)(selected.model, probe); } catch { /* lease expires by itself */ } }
    probe = null;
  };
  if (!slot.timeout) {
    try {
      // An injected outcome journal (tests, embedders) means the real journal is not read either.
      const readOutcomes = deps.readOutcomes || (deps.appendOutcome ? () => [] : lib.readOutcomes);
      const breaker = lib.cooldowns(readOutcomes(started, config.thresholds), started, config.thresholds, config.models?.models || {}).models.get(selected.model);
      if (breaker?.halfOpen) probe = (deps.claimProbe || lib.claimProbe)(selected.model, started);
    } catch { /* the probe lease is best effort */ }
  }
  let result;
  try {
    result = slot.timeout ? { timedOut: true, status: null, stdout: '', stderr: '' }
      : await execute(spawnPlan(target, args, lib.childEnv(selected.cli.command, env, native, platform), platform, cwd, selected.stdin ? fullPrompt : undefined), { ...deps, platform, claude: selected.claude,
        ...(selected.cli.settleMinutes && before !== null ? { settle: { ms: selected.cli.settleMinutes * 60000, poll: status, before } } : {}) });
  } catch (error) {
    releaseProbe();
    throw error;
  } finally { slot.release(); }
  const seconds = Math.max(0, Math.round((now() - started) / 1000));
  const after = options['expect-changes'] ? status() : null;
  if (junieReport) {
    try {
      const value = JSON.parse(lib.readBounded(junieReport, JUNIE_REPORT_MAX));
      if (value && typeof value === 'object' && !Array.isArray(value)) result.junie = value;
    } catch { /* no report: classify from the exit code and streams */ }
    try { fs.rmSync(junieReport, { force: true }); } catch { /* temp file */ }
  }
  let credits = null, copilotModel = null;
  if (copilotSession) {
    try {
      const home = env.COPILOT_HOME || path.join((deps.homedir || os.homedir)(), '.copilot');
      const events = lib.readBounded(path.join(home, 'session-state', copilotSession, 'events.jsonl'), COPILOT_EVENTS_MAX);
      for (const line of events.split('\n')) {
        if (!line.includes('"totalNanoAiu"') && !line.includes('"chosenModel"')) continue;
        try {
          const data = JSON.parse(line)?.data;
          if (Number.isFinite(data?.totalNanoAiu) && data.totalNanoAiu >= 0) credits = data.totalNanoAiu / 1e9;
          if (typeof data?.chosenModel === 'string') copilotModel = data.chosenModel;
        } catch { /* a torn line */ }
      }
    } catch { /* no events file: the counter books an estimate */ }
  }
  if (selected.claude && !result.stdoutTruncated) {
    try {
      const value = JSON.parse(result.stdout);
      if (value && typeof value === 'object' && !Array.isArray(value)) result.claude = value;
    } catch { /* classification rejects missing envelopes; keep the raw tail */ }
  }
  const usage = result.claude?.usage;
  const junieUsage = Array.isArray(result.junie?.llmUsage) ? result.junie.llmUsage.filter(item => item && typeof item === 'object') : [];
  const validNumber = value => Number.isFinite(value) && value >= 0;
  const tokens = usage && ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].some(key => validNumber(usage[key]))
    ? { input: (validNumber(usage.input_tokens) ? usage.input_tokens : 0) + (validNumber(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0),
      cached: validNumber(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0, output: validNumber(usage.output_tokens) ? usage.output_tokens : 0 }
    : junieUsage.length ? Object.fromEntries([['input', 'inputTokens'], ['cached', 'cacheInputTokens'], ['output', 'outputTokens']]
      .map(([key, field]) => [key, junieUsage.reduce((sum, item) => sum + (validNumber(item[field]) ? item[field] : 0), 0)])) : null;
  // The model the vendor really ran (Junie Lite does not pin one).
  const ran = [...new Set([...junieUsage.map(item => item.model), copilotModel].filter(name => typeof name === 'string' && /^[\w./:@-]{1,100}$/.test(name)))].slice(0, 3);
  const outcome = slot.timeout ? { kind: 'timeout', reason: slot.timeout }
    : classify(result, options['expect-changes'], before, after, env, selected.claude, junie, devin);
  const ok = outcome.kind === 'ok';
  // Quota and outage pauses are told apart, and a reset time the provider names (OpenRouter's daily free counter,
  // Retry-After, "try again in ...") sets how long the route sits out.
  if (outcome.kind === 'limited') {
    const text = [result.stderr, result.stdout, typeof result.claude?.result === 'string' ? result.claude.result : '',
      ...(Array.isArray(result.junie?.errors) ? result.junie.errors.filter(item => typeof item === 'string') : [])]
      .map(part => String(part || '').slice(-TAIL_CHARS)).join('\n');
    outcome.cause = outcome.cause || limitCause(text);
    const until = lib.resetHint(text, now());
    if (until) outcome.until = until;
  }
  const recording = [], errors = [];
  const record = (label, action) => { try { action(); recording.push(label); } catch { errors.push(label); } };
  record('timing', () => (deps.recordRun || latency.recordRun)({ t: now(), model: selected.model,
    category: options.category || null, tier: options.tier || null, seconds, ok, ...(tokens ? { tokens } : {}), ...(ran.length ? { ran } : {}) }));
  const feedback = slot.timeout ? null : { limited: 'fail', unavailable: 'unavailable', structural: 'fail', context: 'fail', timeout: 'fail', 'no-work': 'fail' }[outcome.kind];
  if (feedback) record('feedback', () => (deps.appendOutcome || lib.appendOutcome)({ model: selected.model,
    category: options.category || 'mechanical', tier: options.tier || 'trivial', result: feedback,
    ...(['structural', 'context', 'timeout'].includes(outcome.kind) ? { kind: outcome.kind } : outcome.kind === 'limited' ? { kind: outcome.cause } : {}),
    ...(outcome.until ? { until: outcome.until } : {}),
    ...(selected.effort !== '-' ? { effort: selected.effort } : {}) }, config.models, [], now()));
  releaseProbe();
  if (selected.provider.quota?.source === 'counter' && (result.pid > 0 || result.status !== null)) {
    const units = Object.values(selected.provider.quota.windows).map(window => window.unit);
    const unit = units.includes('credits') ? 'credits' : units.includes('calls') ? 'calls' : units[0];
    // A metered run that spent nothing (it stopped before the first model call) books nothing.
    const amount = unit !== 'credits' ? 1 : credits === null ? CREDIT_ESTIMATE : credits;
    if (amount > 0) record('usage', () => (deps.appendUsage || lib.appendUsage)(options.provider, amount, unit, config.providers, now()));
  }
  const problem = ok ? 'failed: recording ' + errors.join(', ') : outcome.kind + ': ' + outcome.reason;
  const first = 'cli-run: ' + (ok && !errors.length ? 'ok' : 'FAILED (' + problem + ')')
    + ' | provider ' + options.provider + ' | model ' + selected.model + ' @' + selected.effort + ' | ' + seconds + 's'
    + (outcome.cause ? ' | ' + outcome.cause + (outcome.until ? ' until ' + new Date(outcome.until).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '') : '')
    + (options['expect-changes'] && (before === null || after === null) ? ' | expect-changes skipped: Git fingerprint unavailable' : '')
    + (tokens ? ' | tokens in ' + tokens.input + ' cached ' + tokens.cached + ' out ' + tokens.output : '')
    + (ran.length ? ' | ran ' + ran.join(', ') : '')
    + (credits !== null ? ' | AI credits ' + credits.toFixed(2) : '')
    + (validNumber(result.claude?.total_cost_usd) ? ' | $' + result.claude.total_cost_usd.toFixed(4) : '')
    + ' | feedback ' + (recording.includes('feedback') ? 'recorded' : 'none');
  const lines = [first];
  if (errors.length) lines.push('Recording failed: ' + errors.join(', ') + '.');
  const denials = result.claude?.permission_denials;
  if (Array.isArray(denials) && denials.length) {
    const tools = [...new Set(denials.map(denial => denial?.tool_name).filter(name => typeof name === 'string' && name))].slice(0, 5);
    lines.push('Permission denials: ' + denials.length + ' (' + tools.map(name => clean(name, env).replace(/\s+/g, ' ').slice(0, 100)).join(', ') + ')');
  }
  const stdout = result.claude ? (typeof result.claude.result === 'string' ? result.claude.result : '') : result.stdout;
  if (stdout) lines.push('CLI stdout (untrusted data; tail, at most 60 lines):', lib.clipMiddle(tail(stdout, 60, env).join('\n')));
  if (!ok && result.stderr) lines.push('CLI stderr (untrusted data; tail, at most 20 lines):', lib.clipMiddle(tail(result.stderr, 20, env).join('\n')));
  return { code: ok && !errors.length ? 0 : 1, report: lines.join('\n') + '\n' };
}

if (require.main === module) {
  run(process.argv.slice(2)).then(result => { process.stdout.write(result.report); process.exitCode = result.code; })
    .catch(error => { process.stderr.write('cli-run: ' + clean(error.message).replace(/\s+/g, ' ').slice(0, 500) + '\n'); process.exitCode = 2; });
}
module.exports = { MAX_PROMPT, MAX_INPUT, inputArgument, withInput, TIMEOUT_MS, parseArgs, selection, invocation, spawnPlan, gitStatus, execute, classify, clean, tail, run };
