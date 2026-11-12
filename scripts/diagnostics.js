'use strict';
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');
const lib = require('./lib');
const latency = require('./latency');
function version(text) { return typeof text === 'string' ? text.match(/\b\d+\.\d+\.\d+\b/)?.[0] : undefined; }
function older(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
/** `opencode models` lists only providers that can answer, so one free call shows missing keys and retired models. */
function openCodeOffers(providers, listModels) {
  const offers = Object.entries(providers).filter(([, p]) => p?.enabled !== false && p?.cli?.command === 'opencode' && p.cli.args?.[1] === '-m' && typeof p.cli.args[2] === 'string');
  for (let i = offers.length - 1; i >= 0; i--) {
    const [id, p] = offers[i];
    const model = p.cli.args[2].includes('{model}') ? p.cli.defaultModel : p.cli.args[2];
    if (!model) offers.splice(i, 1);
    else offers[i] = [id, model];
  }
  if (!offers.length) return [];
  const listed = listModels();
  const models = new Set(String(listed.stdout).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map(line => line.trim()).filter(line => /^[^\s/]+\/\S+$/.test(line)));
  // An empty or unreadable listing says nothing about keys or models.
  if (listed.error || listed.status !== 0 || !models.size) return ['OpenCode offers: could not check. Is OpenCode installed?'];
  const known = new Set([...models].map(model => model.split('/')[0]));
  return offers.map(([id, model]) => {
    const name = lib.sanitizeLabel(id), provider = model.split('/')[0];
    const state = models.has(model) ? 'OK' : known.has(provider) ? 'model no longer offered, remove it with: quota-boss remove-api ' + name
      : provider === 'opencode' ? 'not listed by OpenCode, check with: opencode models'
      : 'no key stored, add one with: opencode auth login -p ' + lib.sanitizeLabel(provider);
    return 'OpenCode offer ' + name + ': ' + state;
  });
}

function skillCount(folder) {
  let dir, count = 0;
  try {
    if (!fs.lstatSync(folder).isDirectory()) return 0;
    dir = fs.opendirSync(folder);
    for (let i = 0; i < 500; i++) {
      const entry = dir.readSync();
      if (!entry) break;
      if (!entry.isDirectory()) continue;
      try { if (fs.lstatSync(path.join(folder, entry.name, 'SKILL.md')).isFile()) count++; } catch {}
    }
  } catch { /* Unreadable optional folders contribute nothing. */ }
  finally { if (dir) dir.closeSync(); }
  return count;
}

const plural = (count, noun) => count + ' ' + noun + (count === 1 ? '' : 's');

function startupLines(project, paths, settings, listed) {
  const { count, median } = require('./context').sessionStarts(project);
  const lines = [count ? 'Session start: about ' + Math.round(median / 1000) + 'k tokens (median of ' + count + ' sessions in this project). Every message reads them again.'
    : 'Session start: not measured yet (open a boss-mode session in Claude Code first).'];
  const parts = [];
  if (!listed.error && listed.status === 0 && typeof listed.stdout === 'string') {
    const servers = listed.stdout.slice(0, 65536).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).filter(line => /^\s*\S.*:\s+\S.*\s-\s+\S/.test(line)); // "name: target - status"; names may contain spaces
    parts.push(plural(servers.length, 'MCP server'));
  }
  parts.push(plural(skillCount(path.join(paths.claudeDir, 'skills')) + skillCount(path.join(project.directory, '.claude', 'skills')), 'skill'));
  const plugins = settings?.enabledPlugins;
  parts.push(plural(plugins && typeof plugins === 'object' && !Array.isArray(plugins) ? Object.values(plugins).filter(value => value === true).length : 0, 'plugin'));
  let bytes = 0;
  for (const file of [path.join(paths.claudeDir, 'CLAUDE.md'), path.join(project.directory, 'CLAUDE.md'), path.join(project.directory, '.claude', 'CLAUDE.md')]) {
    try { const stat = fs.lstatSync(file); if (stat.isFile()) bytes += stat.size; } catch {}
  }
  parts.push('CLAUDE.md files about ' + (bytes / 4000).toFixed(1) + 'k tokens');
  lines.push('Loaded at start: ' + parts.join(', ') + '. Quota Boss itself adds about 3k to 4k.');
  if (median >= 30000) lines.push('Tip: type /context in Claude Code to see what fills the start, and turn off what you do not use with /mcp and /plugin.');
  return lines;
}

function doctor(probe = false, options = {}) {
  const run = options.spawnSync || child.spawnSync;
  const paths = lib.getPaths();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const find = options.findExecutable || (name => lib.findExecutable(name, env, platform));
  const call = (cmd, args, timeout = 5000, maxBuffer = 65536) => lib.runExecutable(find(cmd), args,
    { platform, env, spawnSync: run, encoding: 'utf8', timeout, maxBuffer });
  const lines = ['Node ' + process.versions.node + (Number(process.versions.node.split('.')[0]) >= 18 ? ' OK' : ' requires >=18')];
  let problems = 0;
  const oneLine = value => String(value).replace(/[\x00-\x1f\x7f]/g, ' ');
  const problem = (what, fix) => { problems++; lines.push('Problem: ' + oneLine(what) + '. Fix: ' + oneLine(fix) + '.'); };
  // install.js lives in the package checkout, rather than in the installed scripts directory.
  const installFix = 'node install.js';
  let project = { ...lib.normalizeProject(null), directory: process.cwd() };
  try { project = lib.findProjectConfig(); } catch { /* Report the named config error below. */ }
  const host = project.enabled ? project.host : 'claude-code';
  let initialConfig;
  try { initialConfig = lib.loadConfig(project); } catch { /* Validated below. */ }
  const settings = lib.readJson(path.join(paths.claudeDir, 'settings.json'), {});
  const commands = [settings?.statusLine?.command];
  for (const entries of Object.values(settings?.hooks || {})) if (Array.isArray(entries)) {
    for (const entry of entries) if (Array.isArray(entry?.hooks)) commands.push(...entry.hooks.map(hook => hook?.command));
  }
  if (host === 'claude-code') for (const command of commands) {
    if (typeof command !== 'string') continue;
    const normalized = command.replace(/\\/g, '/');
    if (!normalized.includes(lib.trustedHomeText(paths.quotaBossHome) + '/scripts/')
      && !/\/(quota-boss|harness)\/scripts\/(statusline|hook-)/.test(normalized)) continue;
    const node = command.match(/^"([^"]+)"\s/);
    if (node) {
      try { lib.regularStat(node[1]); }
      catch { problem('node path in settings no longer exists - rerun install', installFix); break; }
    }
  }
  if (host === 'claude-code') {
    const scriptPath = name => lib.trustedHomeText(paths.quotaBossHome) + '/scripts/' + name;
    const hasScript = (command, name) => typeof command === 'string' && command.replace(/\\/g, '/').includes(scriptPath(name));
    const hasHook = (event, name) => (Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : []).some(entry => Array.isArray(entry?.hooks) && entry.hooks.some(hook => hasScript(hook?.command, name)));
    const settingsName = path.join(paths.claudeDir, 'settings.json');
    if (!hasHook('SessionStart', 'hook-session.js') || !hasHook('UserPromptSubmit', 'hook-prompt.js')) problem('Quota Boss hooks are missing from ' + settingsName, installFix);
    if (!hasScript(settings?.statusLine?.command, 'statusline.js')) problem('Quota Boss status line is missing from ' + settingsName, installFix);
    const agents = ['opus-worker', 'sonnet-worker', 'haiku-worker', 'codex-worker', 'gpt-advisor', 'researcher', 'reviewer', 'claude-worker', 'cli-worker', 'consensus', 'scout', 'self-worker'];
    if (agents.some(name => !fs.existsSync(path.join(paths.claudeDir, 'agents', name + '.md')))) problem('Quota Boss agents are missing from ' + path.join(paths.claudeDir, 'agents'), installFix);
  } else if (host === 'codex') {
    if (!require('./codex-hooks').present()) lines.push('Info: Quota Boss SessionStart hook is missing from hooks.json; run quota-boss on --host codex.');
    const hosts = require('./hosts');
    try {
      const agent = hosts.agentsText(project.directory, '');
      if (!agent.previous.includes(hosts.START) || !agent.previous.slice(agent.previous.indexOf(hosts.START) + hosts.START.length, agent.previous.indexOf(hosts.END)).trim())
        problem('Quota Boss managed block is missing or empty in ' + agent.file, 'quota-boss on --host codex');
    } catch {
      problem('Quota Boss managed block is malformed in ' + path.join(project.directory, 'AGENTS.md'), 'repair the quota-boss markers in AGENTS.md, then run quota-boss on --host codex');
    }
  }
  const required = new Set(host === 'claude-code' ? ['claude'] : host === 'codex' ? ['codex'] : []);
  for (const [id, provider] of Object.entries(initialConfig?.providers.providers || {})) {
    if (provider.enabled === false || provider.kind === 'manual' || provider.tos === 'avoid') continue;
    const cmd = provider.cli?.command || (['claude', 'codex'].includes(id) ? id : null);
    if (cmd) required.add(cmd);
    if (cmd && !['claude', 'codex'].includes(cmd) && !find(cmd)) problem(lib.sanitizeLabel(cmd) + ' CLI not found', 'install the official CLI for provider ' + lib.sanitizeLabel(id));
  }
  if (host !== 'claude-code' && initialConfig?.providers.providers.claude?.enabled === false && !find('claude')) lines.push('claude: not installed (Claude is off as a worker)');
  const versions = {};
  for (const cmd of ['claude', 'codex'].filter(cmd => required.has(cmd))) {
    const result = call(cmd, ['--version']);
    versions[cmd] = !result.error && result.status === 0 ? version(result.stdout) : undefined;
    lines.push(cmd + ': ' + (versions[cmd] || 'unavailable'));
    if (required.has(cmd) && (result.error || result.status !== 0)) problem(cmd + ' CLI not found', 'npm install -g ' + (cmd === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code') + (cmd === 'claude' && host !== 'claude-code' ? ', or quota-boss use claude off' : ''));
  }
  const cache = lib.readJson(path.join(paths.codexDir, 'models_cache.json'), {});
  const cachedVersion = version(cache?.client_version);
  if (versions.codex && cachedVersion && older(versions.codex, cachedVersion)) problem('update Codex CLI (model cache requires ' + cachedVersion + ')', 'npm install -g @openai/codex');
  const mcp = call('claude', ['mcp', 'get', 'codex']);
  lines.push('Codex MCP bridge: ' + (!mcp.error && mcp.status === 0 ? 'registered (optional)' : 'not used (workers call `codex exec`)'));
  const listed = call('claude', ['mcp', 'list']);
  const servers = !listed.error && listed.status === 0 && typeof listed.stdout === 'string'
    ? listed.stdout.slice(0, 65536).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
      .map(line => line.match(/^\s*(codebase-memory(?:-mcp)?|serena|gitnexus)\s*:/)?.[1]).filter(Boolean) : [];
  const projectDir = project.directory;
  const intel = lib.detectCodeIntel(projectDir, servers);
  lines.push('Code intelligence: ' + Object.entries(intel).map(([name, present]) => name + '=' + (present ? 'present' : 'absent')).join(', '));
  if (listed.error || listed.status !== 0) lines.push('Code-intel MCP registration: unavailable (could not check).');
  if (!Object.values(intel).some(Boolean)) lines.push('Optional: uv tool install graphifyy && graphify install (Graphify, Apache-2.0). Suggestion only; nothing is installed.');
  if (host === 'claude-code') lines.push(...startupLines(project, paths, settings, listed));
  const manifest = lib.readJson(path.join(paths.quotaBossHome, 'install-manifest.json'));
  if (manifest?.version === 1 && manifest.home === paths.quotaBossHome) lines.push('Install manifest: OK');
  else problem('Install manifest is missing or invalid', installFix);
  for (const file of lib.ignoredProjectFiles()) lines.push('Repository config ' + path.basename(file) + ': ignored for security');
  let config;
  let invalidFile = paths.projectsFile;
  try {
    const project = lib.findProjectConfig();
    if (project.file) {
      const raw = project.raw;
      if (raw.host !== undefined && !lib.HOSTS.includes(raw.host) || raw.profile !== undefined && !lib.PROFILES.includes(raw.profile)
        || raw.allowTrainingProviders !== undefined && typeof raw.allowTrainingProviders !== 'boolean'
        || raw.consensus !== undefined && typeof raw.consensus !== 'boolean'
        || raw.enabled !== undefined && typeof raw.enabled !== 'boolean' || raw.terse !== undefined && typeof raw.terse !== 'boolean'
        || raw.workers !== undefined && (!raw.workers || typeof raw.workers !== 'object' || Array.isArray(raw.workers) || Object.values(raw.workers).some(v => typeof v !== 'boolean'))) throw new Error('Invalid project config');
    }
    for (const name of ['models', 'thresholds']) {
      for (const dir of [paths.defaultConfigDir, path.join(paths.quotaBossHome, 'config')]) {
        const file = path.join(dir, name + '.json');
        invalidFile = file;
        if (fs.existsSync(file)) {
          const raw = lib.readProviderConfig(file);
          if (name === 'models' && raw.models !== undefined && (!raw.models || typeof raw.models !== 'object' || Array.isArray(raw.models))) throw new Error('Invalid model config');
        }
      }
    }
    invalidFile = path.join(paths.quotaBossHome, 'config', 'providers.json');
    config = lib.loadConfig(project);
    invalidFile = path.join(paths.quotaBossHome, 'config', 'models.json');
    if (!config.models.models || Array.isArray(config.models.models) || typeof config.models.models !== 'object') throw new Error('Invalid model config');
    for (const [id, model] of Object.entries(config.models.models)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || !model || !lib.validProviderId(model.pool)
        || typeof model.label !== 'string' || !lib.sanitizeLabel(model.label)
        || !Number.isFinite(model.cost) || model.cost < 0
        || !model.scores || Array.isArray(model.scores) || typeof model.scores !== 'object'
        || Object.entries(model.scores).some(([category, score]) => !lib.CATEGORIES.includes(category) || !Number.isFinite(score) || score < 0 || score > 10)) throw new Error('Invalid model config');
    }
    if (config.models.categories !== undefined && (!Array.isArray(config.models.categories)
      || config.models.categories.some(c => !lib.CATEGORIES.includes(c)))) throw new Error('Invalid categories');
    invalidFile = path.join(paths.quotaBossHome, 'config', 'thresholds.json');
    for (const group of ['claude', 'claudeWeekly', 'codex', 'codexWeekly']) {
      const value = config.thresholds[group];
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.values(value).some(n => !Number.isFinite(n) || n < 0 || n > 100))) throw new Error('Invalid thresholds');
    }
    lines.push('Config: OK');
  } catch { config = null; problem('Config: invalid (' + invalidFile + '; ' + path.basename(invalidFile) + ')', 'fix or delete the file; defaults are in defaults/'); }
  if (config) lines.push(...openCodeOffers(config.providers.providers, () => call('opencode', ['models'], 20000, 4 * 1024 * 1024)));
  if (config) {
    const state = lib.readState();
    const note = require('./route').route({ ...config, ...project, bossModel: lib.currentBossModel(project, state) }).note;
    if (note) {
      const [what, fix] = note.slice(6).split('. Add it to ');
      problem(what, 'add it to ' + fix.replace(/\.$/, ''));
    }
    for (const [id, p] of Object.entries(config.providers.providers)) if (p.enabled !== false && p.evidence === 'docs')
      lines.push(id + ': ' + require('./self-test').evidenceStatus(id, config.models, state.selfTests));
  }
  if (!probe) lines.push('Probes skipped (use --probe to spend quota).');
  else if (config) {
    for (const [model, value] of Object.entries(config.models.models)) {
      if (value?.pool !== 'codex' || config.providers.providers.codex?.enabled === false || config.providers.providers.codex?.tos === 'avoid') continue;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) { lines.push('Probe: invalid model id skipped'); continue; }
      const result = call('codex', ['exec', '-m', model, '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', 'Reply with exactly: OK'], 90000);
      const available = !result.error && result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim() === 'OK';
      if (!available) lib.appendOutcome({ model, category: 'mechanical', tier: 'trivial', result: 'unavailable' }, config.models);
      lines.push('Probe ' + lib.sanitizeLabel(model) + ': ' + (available ? 'OK' : 'unavailable'));
    }
  }
  lines.push(problems ? problems + ' problem(s) found.' : 'No problems found.');
  return lines.join('\n');
}
function stats(days = 30, now = Date.now()) {
  const config = lib.loadConfig();
  const records = lib.readOutcomes(now, { history: { outcomeDays: Math.min(90, days) } }).filter(e => e.t >= now - days * 86400000);
  const providers = new Map(), models = new Map(), groups = new Map();
  for (const e of records) {
    const pool = config.models.models[e.model]?.pool;
    const provider = lib.validProviderId(pool) ? pool : 'unknown';
    providers.set(provider, (providers.get(provider) || 0) + 1);
    const label = lib.sanitizeLabel(e.model);
    models.set(label, (models.get(label) || 0) + 1);
    const key = label + ' / ' + e.category;
    const value = groups.get(key) || { pass: 0, fail: 0, unavailable: 0, limited: 0 };
    value[e.result]++;
    groups.set(key, value);
  }
  const lines = ['Stats: last ' + days + ' days (bounded local journals; outcomes retained up to 90 days)', 'Routing split (recorded outcomes):'];
  const split = (name, data) => { for (const [id, n] of [...data].sort()) lines.push(name + ' ' + id + ': ' + n + ' (' + (100 * n / records.length).toFixed(1) + '%)'); };
  split('provider', providers); split('model', models);
  lines.push('Pass rates (unavailable and limited excluded from denominator):');
  for (const [key, g] of [...groups].sort()) lines.push(key + ': ' + (g.pass + g.fail ? (100 * g.pass / (g.pass + g.fail)).toFixed(1) + '%' : '?') + ' pass=' + g.pass + ' fail=' + g.fail + ' unavailable=' + g.unavailable + ' limited=' + g.limited);
  const usage = lib.readUsage(now);
  const totals = new Map();
  for (const e of usage.entries.filter(e => e.t >= now - days * 86400000)) {
    const key = e.provider + ' ' + e.unit;
    totals.set(key, (totals.get(key) || 0) + e.amount);
  }
  lines.push('Usage counters' + (usage.truncated ? ' (truncated journal)' : '') + ':');
  for (const [key, n] of [...totals].sort()) lines.push(key + ': ' + n);
  lines.push('Latency (median of successful runs, by difficulty):');
  const runs = latency.readRuns(now).filter(run => run.t >= now - days * 86400000);
  const latencyGroups = new Map();
  for (const run of runs) {
    const key = lib.sanitizeLabel(run.model) + ' / ' + run.tier;
    const group = latencyGroups.get(key) || [];
    group.push(run.seconds);
    latencyGroups.set(key, group);
  }
  if (!latencyGroups.size) lines.push('No recorded runs.');
  else for (const [key, values] of [...latencyGroups].sort()) {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    lines.push(key + ': ' + median + 's (' + values.length + ' runs)');
  }
  if (!records.length) lines.push('No recorded outcomes.');
  return lines.join('\n');
}
module.exports = { doctor, stats, version, older, openCodeOffers };
