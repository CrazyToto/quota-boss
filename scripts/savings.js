'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');
const latency = require('./latency');
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2000;
const DEFAULT_WEIGHTS = {
  claude: { input: 1, cache_creation: 1.25, cache_read: 0.1, output: 5 },
  codex: { input: 1, cached: 0.1, output: 8 }
};

function parseArgs(args, usage) {
  let days = 30, all = false, seenDays = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all' && !all) all = true;
    else if (args[i] === '--days' && !seenDays && /^[1-9]\d{0,2}$/.test(args[i + 1]) && Number(args[i + 1]) <= 365) {
      days = Number(args[++i]); seenDays = true;
    } else throw new Error(usage);
  }
  return { days, all };
}

const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
const timestamp = entry => typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
const inWindow = (t, now, days) => Number.isFinite(t) && t >= now - days * 86400000 && t <= now;
const encodedProject = root => root.replace(/[^A-Za-z0-9]/g, '-');
function sameProject(name, root, platform = process.platform) {
  const expected = encodedProject(root);
  return platform === 'win32' ? name.toLowerCase() === expected.toLowerCase() : name === expected;
}

// Share one budget across transcripts, sidecars and journals. Directory entries are
// bounded too, so an unrelated tree cannot make a report scan indefinitely.
function reader() {
  let files = 0, entries = 0;
  return {
    read(file) {
      if (files++ >= MAX_FILES) return '';
      try { return lib.readBounded(file, MAX_BYTES); } catch { return ''; }
    },
    list(dir, newestFirst = false) {
      const result = [];
      let handle;
      try {
        lib.checkParents(path.join(dir, '_'));
        handle = fs.opendirSync(dir);
        let entry;
        while (entries < MAX_FILES && (entry = handle.readSync())) {
          entries++;
          if (!entry.isSymbolicLink()) result.push(entry);
        }
      } catch { /* Missing, linked and unreadable directories are empty. */ }
      finally { if (handle) handle.closeSync(); }
      result.sort((a, b) => a.name.localeCompare(b.name));
      return newestFirst ? result.reverse() : result;
    }
  };
}
function jsonLines(text) {
  return text.split('\n').flatMap(line => {
    try { const value = JSON.parse(line); return value && typeof value === 'object' ? [value] : []; }
    catch { return []; }
  });
}
function duration(entries) {
  let first = Infinity, last = -Infinity;
  for (const entry of entries) {
    const t = timestamp(entry);
    if (Number.isFinite(t)) { first = Math.min(first, t); last = Math.max(last, t); }
  }
  return first === Infinity ? null : (last - first) / 1000;
}
function weighted(pool, tokens, thresholds = {}) {
  return Object.entries(DEFAULT_WEIGHTS[pool]).reduce((sum, [key, fallback]) => {
    const override = thresholds.savings?.[pool]?.[key];
    return sum + number(tokens[key]) * (Number.isFinite(override) && override >= 0 ? override : fallback);
  }, 0);
}
function price(model, config) {
  const cost = Object.hasOwn(config.models?.models || {}, model) ? config.models.models[model]?.cost : undefined;
  return Number.isFinite(cost) && cost >= 0 ? cost : 1;
}

function claudeJob(entries, role, options) {
  const messages = new Map();
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type !== 'assistant' || !message?.usage || typeof message.model !== 'string' || message.model === '<synthetic>') continue;
    messages.set(typeof message.id === 'string' && message.id ? message.id : Symbol(), entry);
  }
  const models = new Map();
  for (const entry of messages.values()) {
    if (!inWindow(timestamp(entry), options.now, options.days)) continue;
    const { model, usage } = entry.message;
    const tokens = models.get(model) || { input: 0, cache_creation: 0, cache_read: 0, output: 0 };
    tokens.input += number(usage.input_tokens);
    tokens.cache_creation += number(usage.cache_creation_input_tokens);
    tokens.cache_read += number(usage.cache_read_input_tokens);
    tokens.output += number(usage.output_tokens);
    models.set(model, tokens);
  }
  return [...models].map(([model, tokens]) => ({ pool: 'claude', role, model, tokens,
    input: tokens.input + tokens.cache_creation + tokens.cache_read, output: tokens.output, seconds: duration(entries) }));
}
function windowDelta(first, last) {
  if (!first || !last || first.resets_at === undefined || last.resets_at === undefined
    || !Number.isFinite(first.used_percent) || !Number.isFinite(last.used_percent)) return { delta: null, reset: false };
  if (first.resets_at !== last.resets_at) return { delta: null, reset: true };
  return { delta: Math.max(0, last.used_percent - first.used_percent), reset: false,
    resetsAt: first.resets_at, from: first.used_percent, to: last.used_percent };
}
// These lib helpers are private at the base revision. Keep their semantics here
// without changing lib or its public interface; prefer exports when available.
function isInsideDirectory(directory, parent, platform = process.platform) {
  if (lib.isInsideDirectory) return lib.isInsideDirectory(directory, parent, platform);
  const normal = value => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const child = normal(directory), root = normal(parent);
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
function isInteractiveCodexLog(file, firstLine) {
  if (lib.isInteractiveCodexLog) return lib.isInteractiveCodexLog(file);
  return !/"originator"\s*:\s*"codex_exec"|"source"\s*:\s*(?:"exec"|\{)/.test(firstLine);
}
function codexJob(entries, role, options) {
  const meta = entries[0];
  if (meta?.type !== 'session_meta' || typeof meta.payload?.cwd !== 'string') return [];
  if (!options.all && !isInsideDirectory(meta.payload.cwd, options.root, options.platform)) return [];
  let model = typeof meta.payload.model === 'string' ? meta.payload.model : 'unknown';
  const counts = [];
  for (const entry of entries) {
    if (entry.type === 'turn_context' && typeof entry.payload?.model === 'string') model = entry.payload.model;
    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') counts.push(entry);
  }
  const last = counts[counts.length - 1];
  if (!last || !inWindow(timestamp(last), options.now, options.days) || !last.payload.info?.total_token_usage) return [];
  const usage = last.payload.info.total_token_usage;
  const cached = Math.min(number(usage.input_tokens), number(usage.cached_input_tokens));
  const tokens = { input: Math.max(0, number(usage.input_tokens) - cached), cached, output: number(usage.output_tokens) };
  const windows = {};
  for (const key of ['primary', 'secondary']) windows[key] = windowDelta(counts[0].payload.rate_limits?.[key], last.payload.rate_limits?.[key]);
  return [{ pool: 'codex', role, model, tokens, input: tokens.input + cached, output: tokens.output, seconds: duration(entries), windows,
    start: timestamp(counts[0]), end: timestamp(last) }];
}

function collect(options) {
  const { paths, root, all, platform, now, days, config } = options;
  const io = reader(), jobs = [];
  let jobId = 0;
  const addJob = records => {
    for (const record of records) jobs.push({ ...record, jobId });
    jobId++;
  };
  const cutoff = now - days * 86400000;
  const fresh = file => { try { return fs.statSync(file).mtimeMs >= cutoff; } catch { return false; } };
  const projects = path.join(paths.claudeDir, 'projects');
  for (const project of io.list(projects)) {
    if (!project.isDirectory() || !all && !sameProject(project.name, root, platform)) continue;
    const dir = path.join(projects, project.name);
    for (const entry of io.list(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl') && fresh(file)) addJob(claudeJob(jsonLines(io.read(file)), 'boss', options));
      if (!entry.isDirectory()) continue;
      const subdir = path.join(file, 'subagents');
      for (const agent of io.list(subdir)) {
        const agentFile = path.join(subdir, agent.name);
        if (!agent.isFile() || !/^agent-.*\.jsonl$/.test(agent.name) || !fresh(agentFile)) continue;
        const lines = jsonLines(io.read(agentFile));
        let meta; try { meta = JSON.parse(io.read(agentFile.replace(/\.jsonl$/, '.meta.json'))); } catch {}
        const role = 'worker:' + (lib.sanitizeLabel(meta?.agentType) || 'unknown');
        addJob(claudeJob(lines, role, options));
      }
    }
  }
  function codexWalk(dir, depth, parts) {
    for (const entry of io.list(dir, true)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3 && /^\d+$/.test(entry.name)) {
        const next = [...parts, Number(entry.name)];
        const [y, m = 12, d = 31] = next;
        if (Date.UTC(y, m - 1, d) + 2 * 86400000 < cutoff) break;
        codexWalk(file, depth + 1, next);
      }
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const text = io.read(file);
        if (!text) continue;
        try {
          const role = isInteractiveCodexLog(file, text.split('\n', 1)[0]) ? 'boss' : 'worker:codex-exec';
          addJob(codexJob(jsonLines(text), role, options));
        } catch { /* A concurrently removed log is skipped. */ }
      }
    }
  }
  codexWalk(path.join(paths.codexDir, 'sessions'), 0, []);
  for (const job of jobs) {
    job.weighted = weighted(job.pool, job.tokens, config.thresholds);
    job.units = job.weighted / 1e6 * price(job.model, config);
  }
  // readUsage can compact (write) its journal. Reuse its validator with a
  // strictly read-only bounded reader instead. Runs mirror readRuns' validation
  // and 30-day retention, while allowing injected paths and the same file cap.
  const usage = jsonLines(io.read(paths.usageFile || path.join(paths.quotaBossHome, 'usage.jsonl')))
    .filter(e => lib.validUsage(e) && inWindow(e.t, now, days) && !['claude', 'codex'].includes(e.provider));
  const runs = jsonLines(io.read(path.join(paths.quotaBossHome, 'runs.jsonl')))
    .filter(e => e.ok === true && Number.isFinite(e.seconds) && e.seconds > 0 && typeof e.model === 'string'
      && lib.TIERS.includes(e.tier) && inWindow(e.t, now, Math.min(days, latency.MAX_DAYS)));
  return { jobs, usage, runs };
}
function windowUse(jobs, key) {
  const runs = jobs.map(j => ({ ...j.windows[key], start: j.start, end: j.end }))
    .filter(w => w.delta !== null && Number.isFinite(w.start) && Number.isFinite(w.end));
  let total = 0;
  for (const [, group] of grouped(runs, w => String(w.resetsAt))) {
    group.sort((a, b) => a.start - b.start);
    let cluster = null;
    const close = () => { if (cluster) total += Math.max(0, cluster.to - cluster.from); };
    for (const run of group) {
      if (cluster && run.start <= cluster.end) {
        cluster.end = Math.max(cluster.end, run.end);
        cluster.from = Math.min(cluster.from, run.from); cluster.to = Math.max(cluster.to, run.to);
      } else { close(); cluster = { ...run }; }
    }
    close();
  }
  return total;
}
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return !sorted.length ? '?' : Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}
function compact(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
}
function grouped(values, key) {
  const groups = new Map();
  for (const value of values) {
    const id = key(value);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(value);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}
const sum = (values, key) => values.reduce((total, value) => total + number(value[key]), 0);
const percent = (part, total) => (total ? 100 * part / total : 0).toFixed(1) + '%';
function formatReport(data, options) {
  const { jobs, usage, runs } = data;
  const lines = ['Savings: last ' + options.days + ' days, ' + (options.all ? 'all projects' : 'project ' + lib.sanitizeLabel(path.basename(options.root)))];
  const footer = 'Numbers come from local transcripts; cost units are relative prices, not a bill.';
  if (!jobs.length && !usage.length && !runs.length) return [...lines, 'No sessions found in this window.', footer].join('\n');
  const total = sum(jobs, 'units'), bosses = jobs.filter(j => j.role === 'boss'), workers = jobs.filter(j => j.role !== 'boss');
  // Keep every section available while bounding the whole report to ~40 lines.
  function section(title, rows, limit = 5) {
    lines.push(title);
    lines.push(...rows.slice(0, limit));
    if (rows.length > limit) lines.push('... ' + (rows.length - limit) + ' more groups omitted');
    if (!rows.length) lines.push('(none)');
  }
  section('Per pool: cost units | share | tokens in/out | sessions/jobs', grouped(jobs, j => j.pool).map(([key, group]) =>
    key + ': ' + sum(group, 'units').toFixed(3) + ' | ' + percent(sum(group, 'units'), total) + ' | ' + compact(sum(group, 'input')) + '/' + compact(sum(group, 'output')) + ' | ' + new Set(group.map(j => j.jobId)).size));
  lines.push('Boss vs workers: boss ' + sum(bosses, 'units').toFixed(3) + ', workers ' + sum(workers, 'units').toFixed(3) + ', worker share ' + percent(sum(workers, 'units'), total));
  const byUnits = groups => groups.sort((a, b) => sum(b[1], 'units') - sum(a[1], 'units') || a[0].localeCompare(b[0]));
  section('Per worker type: role / model | jobs | units | median seconds/job', byUnits(grouped(workers, j => j.role + ' / ' + j.model)).map(([, group]) =>
    'worker:' + lib.sanitizeLabel(group[0].role.replace('worker:', '')) + ' / ' + lib.sanitizeLabel(group[0].model) + ': ' + group.length + ' | ' + sum(group, 'units').toFixed(3) + ' | ' + median(group.map(j => j.seconds))), 5);
  lines.push('Codex windows: 5h / week percentage points used, added up over the period, so the 5h sum can pass 100% (overlapping runs counted once; includes other Codex use at the same time)');
  for (const [label, group] of [['boss', bosses], ['workers', workers]]) {
    const codex = group.filter(j => j.windows);
    const delta = key => windowUse(codex, key).toFixed(1) + '%';
    const omitted = codex.filter(j => Object.values(j.windows).some(w => w.delta === null)).length;
    const resets = codex.filter(j => Object.values(j.windows).some(w => w.reset)).length;
    lines.push(label + ': ' + delta('primary') + ' / ' + delta('secondary') + '; ' + omitted + ' runs left out of one or both sums (' + resets + ' window reset)');
  }
  section('Other providers (global usage.jsonl): calls | tokens | usd', grouped(usage, e => e.provider).map(([id, group]) =>
    lib.sanitizeLabel(id) + ': ' + ['calls', 'tokens', 'usd'].map(unit => group.filter(e => e.unit === unit).reduce((n, e) => n + e.amount, 0)).join(' | ')), 4);
  section('Time per job (global runs.jsonl): model / tier | count | median seconds', grouped(runs, e => e.model + ' / ' + e.tier).map(([, group]) =>
    lib.sanitizeLabel(group[0].model) + ' / ' + group[0].tier + ': ' + group.length + ' | ' + median(group.map(e => e.seconds))), 4);
  const bossModels = grouped(bosses, j => j.model).sort((a, b) => sum(b[1], 'units') - sum(a[1], 'units') || a[0].localeCompare(b[0]));
  if (!bossModels.length) lines.push('If the boss had done the worker jobs: no boss sessions found');
  else {
    const model = bossModels[0][0], estimate = sum(bosses, 'units') + sum(workers, 'weighted') / 1e6 * price(model, options.config);
    const change = total ? 100 * (estimate - total) / total : 0;
    lines.push('If the boss had done the worker jobs (' + lib.sanitizeLabel(model) + '): total ' + estimate.toFixed(3) + ' units, '
      + Math.abs(change).toFixed(1) + '% ' + (change >= 0 ? 'more' : 'less') + ' than actual');
    lines.push('rough estimate, same token count assumed');
  }
  const unknown = [...new Set(jobs.map(j => j.model))].filter(model => !Object.hasOwn(options.config.models?.models || {}, model)).sort();
  if (unknown.length) lines.push('Unknown models (cost 1): ' + unknown.slice(0, 5).map(lib.sanitizeLabel).join(', ') + (unknown.length > 5 ? ', ...' : ''));
  lines.push(footer);
  return lines.join('\n');
}
function savings(options = {}) {
  const project = options.root ? null : lib.findProjectConfig();
  const settings = { days: 30, all: false, now: Date.now(), paths: lib.getPaths(), platform: process.platform,
    root: project?.file ? project.directory : process.cwd(), ...options };
  settings.config = options.config || lib.loadConfig(project || undefined);
  return formatReport(collect(settings), settings);
}

module.exports = { MAX_BYTES, MAX_FILES, DEFAULT_WEIGHTS, parseArgs, encodedProject, sameProject, reader, jsonLines,
  duration, weighted, price, claudeJob, codexJob, windowDelta, windowUse, collect, median, formatReport, savings };
