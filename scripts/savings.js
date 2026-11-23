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
  let days = 30, all = false, details = false, seenDays = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all' && !all) all = true;
    else if (args[i] === '--details' && !details) details = true;
    else if (args[i] === '--days' && !seenDays && /^[1-9]\d{0,2}$/.test(args[i + 1]) && Number(args[i + 1]) <= 365) {
      days = Number(args[++i]); seenDays = true;
    } else throw new Error(usage);
  }
  return { days, all, details };
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
// Models with no public price, billed like a listed model (docs/BENCHMARKS.md does the same).
const PRICED_AS = { 'codex-auto-review': 'gpt-6.1-sol' };
function priceModel(model, config) {
  const models = config.models?.models || {};
  return !Object.hasOwn(models, model) && Object.hasOwn(PRICED_AS, model) ? PRICED_AS[model] : model;
}
function price(model, config) {
  model = priceModel(model, config);
  const cost = Object.hasOwn(config.models?.models || {}, model) ? config.models.models[model]?.cost : undefined;
  return Number.isFinite(cost) && cost >= 0 ? cost : 1;
}

// The rules call a job large from about 5 new or rewritten files or 200 changed lines (templates/RULES.md).
const LARGE_FILES = 5, LARGE_LINES = 200;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const lineCount = text => typeof text === 'string' && text ? text.split('\n').length : 0;
/** Files the boss wrote whole (new or rewritten), lines it changed, whether it handed any work out, and whether it asked the route gate. */
function bossWork(entries, options) {
  const seen = new Set(), files = new Set();
  let lines = 0, delegated = false, routed = false;
  for (const entry of entries) {
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content) || !inWindow(timestamp(entry), options.now, options.days)) continue;
    for (const block of entry.message.content) {
      if (block?.type !== 'tool_use' || seen.has(block.id)) continue;
      if (typeof block.id === 'string') seen.add(block.id);
      const input = block.input || {};
      if (EDIT_TOOLS.has(block.name) && typeof (input.file_path ?? input.notebook_path) === 'string') {
        if (block.name === 'Write') files.add(input.file_path);
        lines += block.name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits.reduce((n, e) => n + lineCount(e?.new_string), 0)
          : lineCount(input.content ?? input.new_string ?? input.new_source);
      } else if (block.name === 'Agent' || block.name === 'Task') delegated = true;
      else if (typeof input.command === 'string') {
        if (/(codex-run|cli-run|run-cli)\.js/.test(input.command)) delegated = true;
        if (/quota-boss\.js"?\s+route\b/.test(input.command)) routed = true;
      }
    }
  }
  return { files: files.size, lines, delegated, routed };
}
function claudeJob(entries, role, options) {
  const messages = new Map();
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type !== 'assistant' || !message?.usage || typeof message.model !== 'string' || message.model === '<synthetic>') continue;
    messages.set(typeof message.id === 'string' && message.id ? message.id : Symbol(), entry);
  }
  const models = new Map();
  let start = Infinity, first = 0;
  for (const entry of messages.values()) {
    if (!inWindow(timestamp(entry), options.now, options.days)) continue;
    const { model, usage } = entry.message;
    // First request = the worker's startup cost (system prompt, tools, spec).
    if (timestamp(entry) < start) first = number(usage.input_tokens) + number(usage.cache_creation_input_tokens) + number(usage.cache_read_input_tokens);
    start = Math.min(start, timestamp(entry));
    const tokens = models.get(model) || { input: 0, cache_creation: 0, cache_read: 0, output: 0 };
    tokens.input += number(usage.input_tokens);
    tokens.cache_creation += number(usage.cache_creation_input_tokens);
    tokens.cache_read += number(usage.cache_read_input_tokens);
    tokens.output += number(usage.output_tokens);
    models.set(model, tokens);
  }
  const work = role === 'boss' && models.size ? bossWork(entries, options) : undefined;
  return [...models].map(([model, tokens], i) => ({ pool: 'claude', role, model, tokens,
    input: tokens.input + tokens.cache_creation + tokens.cache_read, output: tokens.output, seconds: duration(entries), start, ...(!i ? { first } : {}), ...(work && !i ? { work } : {}) }));
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
  const opening = counts[0].payload.info?.last_token_usage || counts[0].payload.info?.total_token_usage;
  const windows = {};
  for (const key of ['primary', 'secondary']) windows[key] = windowDelta(counts[0].payload.rate_limits?.[key], last.payload.rate_limits?.[key]);
  return [{ pool: 'codex', role, model, tokens, input: tokens.input + cached, output: tokens.output, seconds: duration(entries), windows,
    first: number(opening?.input_tokens), reasoning: Math.min(tokens.output, number(usage.reasoning_output_tokens)), start: timestamp(counts[0]), end: timestamp(last) }];
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
  const outcomes = jsonLines(io.read(paths.outcomesFile || path.join(paths.quotaBossHome, 'outcomes.jsonl')))
    .filter(e => lib.validOutcome(e) && !e.bench && inWindow(e.t, now, Math.min(days, 90)));
  return { jobs, usage, runs, outcomes };
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
const LABELS = { 'codex-auto-review': 'Codex auto-review' };
function modelLabel(model, config) {
  const entry = config.models?.models?.[model];
  return lib.sanitizeLabel(LABELS[model] || (typeof entry?.label === 'string' ? entry.label : model)) || 'unknown';
}
function units(n) {
  return n >= 100 ? String(Math.round(n)) : n >= 1 ? n.toFixed(1) : n.toFixed(3);
}
function time(seconds) {
  if (seconds === '?') return '?';
  return seconds < 90 ? seconds + 's' : seconds < 5400 ? (seconds / 60).toFixed(1) + ' min' : (seconds / 3600).toFixed(1) + ' h';
}
function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  return rows.map(r => ('  ' + r.map((cell, i) => i ? cell.padStart(widths[i]) : cell.padEnd(widths[i])).join('  ')).trimEnd());
}
const share = (part, total) => (total ? 100 * part / total : 0).toFixed(0) + '%';
const POOLS = { claude: 'Claude', codex: 'Codex' };
// "last 30 days" overstates the evidence when the data starts later, so name the real start.
function span(jobs, options) {
  const starts = jobs.map(j => j.start).filter(Number.isFinite);
  const first = starts.length ? Math.min(...starts) : NaN;
  if (!Number.isFinite(options.now) || !Number.isFinite(first) || first < options.now - (options.days - 1) * 86400000) return 'last ' + options.days + ' days';
  const days = Math.max(1, Math.ceil((options.now - first) / 86400000));
  return 'since ' + new Date(first).toISOString().slice(0, 10) + ' (' + days + (days === 1 ? ' day' : ' days') + ')';
}
const byUnits = groups => groups.sort((a, b) => sum(b[1], 'units') - sum(a[1], 'units') || a[0].localeCompare(b[0]));
function formatReport(data, options) {
  const { jobs, usage, runs } = data;
  const config = options.config || {};
  const scope = options.all ? 'all projects' : 'project ' + lib.sanitizeLabel(path.basename(options.root));
  const lines = ['Quota Boss savings - ' + span(jobs, options) + ', ' + scope];
  const footer = 'Units are relative model prices from local transcripts, not a bill.';
  if (!jobs.length && !usage.length && !runs.length && !(options.details && data.outcomes?.length)) return [...lines, 'No sessions found in this window.', footer].join('\n');
  const total = sum(jobs, 'units'), bosses = jobs.filter(j => j.role === 'boss'), workers = jobs.filter(j => j.role !== 'boss');
  const bossModels = byUnits(grouped(bosses, j => j.model));
  lines.push('');
  if (!bossModels.length) lines.push('No boss sessions found, so there is nothing to compare.');
  else {
    const model = bossModels[0][0], label = modelLabel(model, config);
    const pool = bossModels[0][1][0].pool, poolName = POOLS[pool] || pool;
    const estimate = sum(bosses, 'units') + sum(workers, 'weighted') / 1e6 * price(model, config);
    const poolActual = sum(jobs.filter(j => j.pool === pool), 'units');
    if (!workers.length) lines.push('No worker jobs yet: the boss (' + label + ') did everything.');
    else {
      // Lead with the pool the boss draws from: its limit is the one that runs out first.
      const poolSaved = estimate ? 100 * (estimate - poolActual) / estimate : 0;
      const saved = estimate ? 100 * (estimate - total) / estimate : 0;
      lines.push('About ' + Math.abs(poolSaved).toFixed(0) + '% ' + (poolSaved >= 0 ? 'less' : 'more') + ' ' + poolName + ' usage than doing everything with ' + label);
      if (poolSaved > 0 && poolActual > 0) lines.push('  = about ' + (estimate / poolActual).toFixed(1) + 'x the work per ' + poolName + ' limit');
      const rows = [[poolName + ' used', units(poolActual) + ' units'], [label + ' alone', units(estimate) + ' units (estimate, same tokens assumed)']];
      for (const [other, group] of grouped(jobs.filter(j => j.pool !== pool), j => j.pool)) rows.push([(POOLS[other] || other) + ' used', units(sum(group, 'units')) + ' units']);
      rows.push(['all pools', units(total) + ' units, ' + Math.abs(saved).toFixed(0) + '% ' + (saved >= 0 ? 'cheaper' : 'more expensive') + ' in total']);
      const width = Math.max(...rows.map(r => r[0].length));
      lines.push(...rows.map(([name, value]) => '  ' + name.padEnd(width) + '  ' + value));
    }
  }
  const bossLabel = bossModels.length ? ' (' + bossModels.slice(0, 2).map(([m]) => modelLabel(m, config)).join(', ') + ')' : '';
  lines.push('', 'Who did the work', ...table([
    ['boss' + bossLabel, units(sum(bosses, 'units')) + ' units', share(sum(bosses, 'units'), total)],
    ['workers', units(sum(workers, 'units')) + ' units', share(sum(workers, 'units'), total)]
  ]));
  if (workers.length) {
    const groups = byUnits(grouped(workers, j => modelLabel(j.model, config)));
    lines.push('', ...table([['Workers', 'jobs', 'units', 'median time'], ...groups.slice(0, 5).map(([label, group]) =>
      [label, String(new Set(group.map(j => j.jobId)).size), units(sum(group, 'units')), time(median(group.map(j => j.seconds)))])]));
    if (groups.length > 5) lines.push('  ... ' + (groups.length - 5) + ' more (savings --details)');
    const codex = workers.filter(j => j.windows);
    if (codex.length) lines.push('', 'Codex subscription used by workers: ' + windowUse(codex, 'secondary').toFixed(0) + '% of one week');
  }
  const unknown = [...new Set(jobs.map(j => j.model))].filter(model => !Object.hasOwn(config.models?.models || {}, priceModel(model, config))).sort();
  if (unknown.length) lines.push('', 'Unknown models (priced at 1): ' + unknown.slice(0, 5).map(lib.sanitizeLabel).join(', ') + (unknown.length > 5 ? ', ...' : ''));
  if (options.details) lines.push('', ...details(data, bosses, workers, total));
  lines.push('', footer);
  if (!options.details) lines.push('More: savings --details');
  return lines.join('\n');
}
function details(data, bosses, workers, total) {
  const { jobs, usage, runs } = data, lines = [];
  function section(title, rows, limit = 8) {
    lines.push(title, ...rows.slice(0, limit));
    if (rows.length > limit) lines.push('... ' + (rows.length - limit) + ' more');
    if (!rows.length) lines.push('(none)');
  }
  // Cache hit = input read from cache; output share = output of all tokens (reasoning is part of output, Codex only).
  const cacheHit = group => percent(group.reduce((n, j) => n + number(j.tokens?.cache_read ?? j.tokens?.cached), 0), sum(group, 'input'));
  section('Per pool: units | share | tokens in/out | cache hit | output share (reasoning) | sessions and jobs', grouped(jobs, j => j.pool).map(([key, group]) =>
    key + ': ' + units(sum(group, 'units')) + ' | ' + percent(sum(group, 'units'), total) + ' | ' + compact(sum(group, 'input')) + '/' + compact(sum(group, 'output'))
      + ' | ' + cacheHit(group) + ' | ' + percent(sum(group, 'output'), sum(group, 'input') + sum(group, 'output'))
      + (group.some(j => j.reasoning) ? ' (' + percent(sum(group, 'reasoning'), sum(group, 'output')) + ')' : '') + ' | ' + new Set(group.map(j => j.jobId)).size));
  section('Per worker agent: agent / model | jobs | units | median time | median first call in | cache hit', byUnits(grouped(workers, j => j.role + ' / ' + j.model)).map(([, group]) =>
    lib.sanitizeLabel(group[0].role.replace('worker:', '')) + ' / ' + lib.sanitizeLabel(group[0].model) + ': ' + group.length + ' | ' + units(sum(group, 'units')) + ' | ' + time(median(group.map(j => j.seconds)))
      + ' | ' + (group.some(j => j.first) ? compact(median(group.filter(j => j.first).map(j => j.first))) : '-') + ' | ' + cacheHit(group)));
  lines.push('Codex quota: 5h / week percentage points added up over the period (a 5h sum above 100% means several full windows; parallel runs count once; other Codex use at the same time is included)');
  for (const [label, group] of [['boss', bosses], ['workers', workers]]) {
    const codex = group.filter(j => j.windows);
    if (!codex.length) continue;
    const delta = key => windowUse(codex, key).toFixed(1) + '%';
    const omitted = codex.filter(j => Object.values(j.windows).some(w => w.delta === null)).length;
    const resets = codex.filter(j => Object.values(j.windows).some(w => w.reset)).length;
    lines.push(label + ': ' + delta('primary') + ' / ' + delta('secondary') + (omitted ? '; ' + omitted + ' runs not counted (' + resets + ' crossed a window reset)' : ''));
  }
  section('Other providers: calls | tokens | usd', grouped(usage, e => e.provider).map(([id, group]) =>
    lib.sanitizeLabel(id) + ': ' + ['calls', 'tokens', 'usd'].map(unit => group.filter(e => e.unit === unit).reduce((n, e) => n + e.amount, 0) || '-').join(' | ')));
  section('Time per job (all projects): model / tier | count | median time', grouped(runs, e => e.model + ' / ' + e.tier).map(([, group]) =>
    lib.sanitizeLabel(group[0].model) + ' / ' + group[0].tier + ': ' + group.length + ' | ' + time(median(group.map(e => e.seconds)))));
  const kept = bosses.filter(j => j.work && !j.work.delegated && (j.work.files >= LARGE_FILES || j.work.lines >= LARGE_LINES))
    .sort((a, b) => b.start - a.start);
  // Shown only when it happened, so a healthy report stays short.
  if (kept.length) section('Large work the boss kept (' + LARGE_FILES + '+ files or ' + LARGE_LINES + '+ lines, no worker): start | files | lines | why', kept.map(j =>
    new Date(j.start).toISOString().slice(0, 16).replace('T', ' ') + ' | ' + j.work.files + ' | ' + j.work.lines + ' | ' + (j.work.routed ? 'route checked, kept' : 'no route call')));
  const results = grouped(data.outcomes || [], e => lib.sanitizeLabel(e.model) + ' / ' + e.category)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  section('Results (all projects): model / category | pass rate | pass | fail', results.map(([key, group]) => {
    const count = result => group.filter(e => e.result === result && !lib.transientOutcome(e) && e.kind !== 'not-run').length, pass = count('pass'), fail = count('fail');
    return key + ': ' + (pass + fail ? Math.round(100 * pass / (pass + fail)) + '%' : '?') + ' | ' + pass + ' | ' + fail;
  }));
  return lines;
}
function savings(options = {}) {
  const project = options.root ? null : lib.findProjectConfig();
  const settings = { days: 30, all: false, now: Date.now(), paths: lib.getPaths(), platform: process.platform,
    root: project?.file ? project.directory : process.cwd(), ...options };
  settings.config = options.config || lib.loadConfig(project || undefined);
  return formatReport(collect(settings), settings);
}

module.exports = { MAX_BYTES, MAX_FILES, DEFAULT_WEIGHTS, parseArgs, encodedProject, sameProject, reader, jsonLines,
  duration, weighted, PRICED_AS, price, claudeJob, codexJob, windowDelta, windowUse, collect, median, formatReport, savings };
