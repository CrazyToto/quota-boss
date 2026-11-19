#!/usr/bin/env node
'use strict';

const path = require('node:path');
const lib = require('./lib');
const hosts = require('./hosts');
const diagnostics = require('./diagnostics');
const settings = require('./settings');
const suggest = require('./suggest');
const tools = require('./tools');
const addApi = require('./add-api');
const local = require('./local');
const providerHelp = require('./provider-help');
const setupWizard = require('./setup-wizard');
const context = require('./context');
const latency = require('./latency');
const { route, routeTable, formatTable, formatExplain } = require('./route');
const USAGES = {
  'worktree': 'worktree add <name> [--scope <p1,p2,...>] [--plan <file>] | merge <name> [<name>...] | list | remove <name> [--force] | clean [--force]',
  'graph': 'graph <explain|affected|path> <name> [<name>]',
  'verify': 'verify [--fresh] [--log <model> <category> <tier> [--effort <level>]] -- <command...>',
  'setup': 'setup',
  'handoff': 'handoff save|list|show [<name>]',
  'on': 'on [--host claude-code|codex|generic] [quality|balanced|frugal]',
  'off': 'off',
  'status': 'status',
  'settings': 'settings',
  'route': 'route [--explain] [--size small|medium|large] [--needs text,image,pdf,video,audio] [--context <tokens>] [category] [tier]',
  'use': 'use [<provider-id|model-id> on|off [--project] [--no-test]]',
  'providers': 'providers [guide|show <id> [--model <registry-model-id>]|test <id> [--model <registry-id>] [--effort <level>]]',
  'cap': 'cap <id> <fiveHour|daily|weekly|monthly> <1-100|off> [--project]',
  'usage': 'usage <id> <amount> <calls|tokens|usd>',
  'timing': 'timing <model> <category|-> <tier|-> <seconds> ok|fail',
  'rules': 'rules --host <host>',
  'doctor': 'doctor [--probe|--report]',
  'tools': 'tools [install <id...>|logins]',
  'add-api': 'add-api [<preset>|<id> <provider/model> --trains <yes|no> [--free] [--budget <amount> <unit> <window>]]',
  'remove-api': 'remove-api <id>',
  'local': 'local [on <model>|off]',
  'savings': 'savings [--days N] [--all] [--details]',
  'feedback': 'feedback <model> <category> <tier> <pass|fail|unavailable|limited> [--effort <level>]',
  'set': 'set <name> <value> (profile quality|balanced|frugal; training on|off; statusline always|boss; context <tokens>|off)',
  'help': 'help',
};
const usage = command => 'Usage: quota-boss ' + USAGES[command];
const HELP = 'Quota Boss help\n\nStart:\n  setup                            guided setup, step by step\n  on [quality|balanced|frugal]     turn boss mode on for this project\n  off                              turn it off\n  status                           remaining quota and current mode\n  doctor [--report]                check installation or print a redacted issue report\n\nSettings:\n  settings                         every setting, what it does and its values\n  set <name> <value>               change one setting, e.g. set profile frugal\n\nProviders:\n  use                              list subscriptions, free offers and models\n  use <id> on|off [--project]      switch one provider or model\n  cap <id> <window> <percent|off>  keep part of a quota for yourself\n  add-api, remove-api              add or remove an API or free offer\n  local on <model>|off             use a local model through Ollama\n\nReports:\n  savings [--details]              what delegation saved\n  route                            which model gets which kind of job right now';
const SET_NAMES = { profile: 'profile', training: 'allow-training', statusline: 'statusline', context: 'context' };
// Settings removed in 0.2.0 and what replaces them. Stored values are ignored.
const REMOVED_SETTINGS = {
  'short-answers': 'replies always use the normal format.',
  rules: 'Claude Code always starts with tiny rules and loads the full rules when it needs them.',
  consensus: 'the consensus option is always offered for critical architecture work while Codex is on (quota-boss use codex on|off).',
  split: 'the benchmark showed no gain, so large jobs go to one worker.',
  research: 'large research is always handed to a worker while Claude is saving.',
  'codex-tasks': 'switch Codex with quota-boss use codex on|off.',
  'gpt-reviews': 'switch Codex with quota-boss use codex on|off.',
  perplexity: 'switch Perplexity with quota-boss use perplexity on|off.',
};

function checkProfile(profile) {
  if (!lib.PROFILES.includes(profile)) throw new Error('Profile must be quality, balanced, or frugal.');
}

function providerReport(config, limits, models = {}, selfTests = {}) {
  const context = lib.providerContext(config, limits);
  const format = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 + '%' : '?';
  const lines = ['id | kind | enabled | source | used | cap | effective | trainsOnData | tos'];
  for (const [id, p] of Object.entries(config.providers)) {
    const usage = context.usage[id];
    const windows = usage ? Object.keys(usage.effective) : [];
    const values = field => windows.map(w => w + '=' + format(field(w))).join(',') || '?';
    lines.push([id, p.kind, p.enabled !== false ? 'yes' : 'no', p.quota.source,
      usage ? values(w => usage.windows[w]?.used_percent) : '-',
      Object.entries(config.caps?.[id] ?? {}).map(([w, cap]) => w + '=' + (cap === null ? 'off' : format(cap))).join(',') || 'off',
      usage ? values(w => usage.effective[w]?.used_percent) : '-', p.trainsOnData === true ? 'yes' : 'no', p.tos ?? 'official-cli'].join(' | ') + (p.evidence === 'docs' ? ' | ' + require('./self-test').evidenceStatus(id, models, selfTests, p.cli?.command) : ''));
  }
  return lines.join('\n');
}
function statuslineCommand(rest) {
  const command = 'set';
  if (rest.length > 1 || (rest.length && !['always', 'boss'].includes(rest[0]))) throw new Error(usage(command));
  if (rest.length) lib.writeJson(lib.statuslineFile(), { showWithoutBoss: rest[0] === 'always' });
  return lib.showsWithoutBoss()
    ? 'Status line: the Claude and Codex numbers also show where boss mode is off. Hide them with: quota-boss set statusline boss'
    : 'Status line: shown only where boss mode is on. Keep the Claude and Codex numbers everywhere with: quota-boss set statusline always';
}
function rawProviders(project = {}) {
  return lib.mergeProviders(lib.BUILTIN_PROVIDERS,
    lib.readProviderConfig(path.join(lib.getPaths().quotaBossHome, 'config', 'providers.json')), project);
}
function refreshCodexAgents() {
  const notes = [];
  const result = lib.withLock(lib.getPaths().projectsFile, verify => {
    for (const [directory, raw] of Object.entries(lib.readProjects())) {
      if (!raw?.enabled || raw.host !== 'codex') continue;
      try {
        lib.checkParents(path.join(directory, 'AGENTS.md'));
        if (!require('node:fs').lstatSync(directory).isDirectory()) throw new Error('Project directory is unavailable.');
        const project = lib.findProjectConfig(directory);
        hosts.writeAgents(hosts.agentsText(directory, hosts.managedBlock(project)), verify);
      } catch (error) {
        notes.push('Note: Skipped AGENTS.md refresh for ' + lib.sanitizeLabel(path.basename(directory)) + ': ' + lib.sanitizeLabel(error.message));
      }
    }
    return true;
  });
  if (result === null) notes.push('Note: Skipped AGENTS.md refresh: project registry is busy; retry the switch.');
  return notes.length ? '\n' + notes.join('\n') : '';
}
function useReport(active, config) {
  const global = lib.readUse(), local = active.use;
  const lines = ['Subscriptions'];
  const raw = rawProviders(active);
  const now = Date.now();
  const limits = lib.readProviderLimits(raw, { claude: lib.readState().claude, codex: lib.readCodexLimits(now, config.thresholds) }, now);
  const context = lib.providerContext(raw, limits);
  const off = new Set([...global.modelsOff, ...local.modelsOff]);
  for (const subscription of [true, false]) {
    if (!subscription) lines.push('Free, API, local and manual');
    for (const [id] of Object.entries(config.providers.providers).filter(([, p]) => (p.kind === 'subscription') === subscription)) {
      const reason = raw.providers[id].enabled === false ? 'off'
        : global.only && !global.only.includes(id) || local.only && !local.only.includes(id) ? 'off (only filter)'
          : local.providersOff.includes(id) ? 'off (this project)' : 'on';
      const windows = Object.entries(context.usage[id]?.effective || {}).filter(([, w]) => Number.isFinite(w.used_percent))
        .map(([name, w]) => ({ fiveHour: '5h', daily: 'day', weekly: 'week', monthly: 'month' }[name] ?? name) + ' ' + Math.max(0, Math.round((100 - w.used_percent) * 100) / 100) + '% left');
      lines.push(('  ' + id.padEnd(16) + reason.padEnd(20) + windows.join(', ')).trimEnd());
      // Model ids are what `use` takes, so they are listed where a provider offers a choice or one is off.
      const models = Object.entries(config.models.models).filter(([, m]) => m?.pool === id)
        .map(([model, entry]) => lib.sanitizeLabel(model) + (off.has(model) || entry.enabled === false ? ' (off)' : ''));
      if (models.length < 2 && !models.some(model => model.endsWith('(off)'))) continue;
      let line = '';
      for (const model of models) {
        if (line && line.length + model.length > 100) { lines.push('      ' + line); line = ''; }
        line += (line ? ', ' : '') + model;
      }
      lines.push('      ' + line);
    }
  }
  lines.push('Switch: quota-boss use <provider-id|model-id> on|off [--project]');
  return lines.join('\n');
}
function useCommand(command, rest, { interactive = !!(process.stdin.isTTY && process.stdout.isTTY), say = console.log, toolsOptions, confirmed = false, ask } = {}) {
  const active = lib.findProjectConfig(), config = lib.loadConfig(active);
  if (!rest.length) return useReport(active, config);
  const noTest = rest.at(-1) === '--no-test';
  if (noTest) rest = rest.slice(0, -1);
  const project = rest.at(-1) === '--project';
  if (project) rest = rest.slice(0, -1);
  if (rest.includes('--project') || !rest.length) throw new Error(usage(command));
  const [id, action] = rest;
  const raw = rawProviders(active);
  const provider = lib.validProviderId(id) && Object.hasOwn(raw.providers, id);
  const checkId = value => {
    if (!(lib.validProviderId(value) && Object.hasOwn(raw.providers, value))
      && !(lib.validUseModelId(value) && Object.hasOwn(config.models.models, value))) {
      throw new Error(value + ' is neither a provider id nor a model id. See quota-boss use.');
    }
  };
  if (rest.length !== 2 || !['on', 'off'].includes(action)) throw new Error(usage(command));
  checkId(id);
  if (noTest && (project || !provider || action !== 'on')) throw new Error(usage(command));
  if (provider && action === 'on' && !project && raw.providers[id].kind === 'local') throw new Error('Local models have their own switch: quota-boss local on <model>');
  const update = value => {
    const next = lib.normalizeUse(value);
    const key = provider ? 'providersOff' : 'modelsOff';
    next[key] = next[key].filter(value => value !== id);
    if (action === 'off') next[key].push(id);
    // A stored only filter (removed in 0.2.0) keeps excluding; turning a provider on lets in that one provider only.
    if (provider && action === 'on' && next.only && !next.only.includes(id)) next.only.push(id);
    return next;
  };
  const saveGlobal = () => {
    const saved = lib.withLock(lib.useFile(), verify => {
      const { providersOff, ...next } = update(lib.readUse());
      lib.atomicWrite(lib.useFile(), JSON.stringify(next, null, 2) + '\n', verify); return true;
    });
    if (saved === null) throw new Error('Use config is busy; retry.');
  };
  let output;
  if (provider && !project) {
    output = providerCommand('provider-switch', [action === 'on' ? 'enable' : 'disable', id]);
    if (action === 'on' && lib.readUse().only?.includes(id) === false) saveGlobal();
  } else if (project) {
    lib.updateProjects(entries => {
      const current = lib.findProjectConfig();
      // Old worker switches already sit in current.use as providersOff, so the saved entry drops them.
      const { workers, ...raw } = current.raw;
      return { ...entries, [lib.projectKey(current.directory)]: { ...raw, ...lib.normalizeProject(current), use: update(current.use) } };
    });
  } else saveGlobal();
  output = output || id + ' ' + action + (project ? ' (this project)' : '');
  if (action === 'on') {
    const global = lib.readUse();
    const pool = provider ? id : config.models.models[id]?.pool;
    const fixes = [];
    if ((raw.providers[pool]?.enabled === false || global.only?.includes(pool) === false) && (project || !provider)) fixes.push(raw.providers[pool].kind === 'local'
      ? 'quota-boss local on <model>' : 'quota-boss use ' + pool + ' on');
    if (!provider && global.modelsOff.includes(id) && project) fixes.push('quota-boss use ' + id + ' on');
    if (fixes.length) output += '\nStill off globally. Turn it on with: ' + fixes.join('; ');
    if (!project && active.use.only?.includes(pool) === false) output += '\nStill off by the project only filter. Turn it on with: quota-boss use ' + pool + ' on --project';
  }
  const hostPool = active.host === 'claude-code' ? 'claude' : active.host === 'codex' ? 'codex' : null;
  const boss = lib.delegationBoss(config.models, active);
  const changedOff = action === 'off' && (provider ? id === hostPool : id === boss);
  if (changedOff) output += '\nThe boss itself keeps running on its model; this only stops delegation to it.';
  if (provider && !project && action === 'on' && raw.providers[id].cli) {
    const definition = raw.providers[id];
    const gated = definition.evidence === 'docs';
    if (noTest) return output + (gated ? '\nSelf-test skipped: run quota-boss providers test ' + id + ' before it gets work.' : '');
    const tool = tools.enabledIds({ providers: { providers: { [id]: { ...definition, enabled: true } } } })[0];
    if (!interactive) return output + '\nTo finish, run quota-boss use ' + id + ' on in a terminal.';
    const { selfTest, validSelfTest } = require('./self-test');
    const enabled = lib.loadConfig({});
    const models = Object.entries(enabled.models.models).filter(([, model]) => model.pool === id && model.enabled !== false);
    const verified = () => {
      const cli = lib.cliFingerprint(definition.cli.command, toolsOptions?.find || lib.findExecutable);
      const tests = lib.readState().selfTests;
      return models.length > 0 && models.every(([key]) => validSelfTest(tests?.[key], cli));
    };
    const test = changed => {
      if ((!gated && !changed) || !models.length || definition.tos === 'avoid' || (!changed && verified())) return;
      say('Running the self-test (real calls that count against the limit). Skip with --no-test.');
      output += '\n' + selfTest(id, { ...toolsOptions, findExecutable: toolsOptions?.find, config: enabled });
    };
    if (tool) tools.activate(tool, { say, options: toolsOptions, test, verified, confirmed, ...(ask ? { ask } : {}) });
    else test(false);
  }
  return output + (provider && !project ? '' : refreshCodexAgents());
}
function providerCommand(command, rest) {
  const active = lib.findProjectConfig();
  const config = lib.loadConfig(active);
  const userFile = path.join(lib.getPaths().quotaBossHome, 'config', 'providers.json');
  const checkId = id => {
    if (!lib.validProviderId(id) || !Object.hasOwn(config.providers.providers, id)) throw new Error('Unknown provider id.');
  };
  if (command === 'providers' && rest.length === 0) {
    const now = Date.now();
    const codex = config.providers.providers.codex?.enabled === false ? null : lib.readCodexLimits(now, config.thresholds);
    return providerReport(config.providers, lib.readProviderLimits(config.providers, { claude: lib.readState().claude, codex }, now), config.models, lib.readState().selfTests);
  }
  if (command === 'providers' && rest[0] === 'test') {
    if (rest.length < 2 || rest.length % 2 !== 0) throw new Error(usage(command));
    checkId(rest[1]);
    const flags = {};
    for (let i = 2; i < rest.length; i += 2) {
      if (!['--model', '--effort'].includes(rest[i]) || Object.hasOwn(flags, rest[i])) throw new Error(usage(command));
      flags[rest[i]] = rest[i + 1];
    }
    return require('./self-test').selfTest(rest[1], { config, model: flags['--model'], effort: flags['--effort'] });
  }
  if (command === 'providers' && rest[0] === 'guide' && rest.length === 1) {
    return providerHelp.guide(config);
  }
  if (command === 'providers' && rest[0] === 'show' && rest.length >= 2 && rest.length % 2 === 0) {
    checkId(rest[1]);
    const flags = {};
    for (let index = 2; index < rest.length; index += 2) {
      if (!['--model', '--effort'].includes(rest[index]) || Object.hasOwn(flags, rest[index])) throw new Error(usage(command));
      flags[rest[index]] = rest[index + 1];
    }
    const provider = config.providers.providers[rest[1]];
    const asked = flags['--model'];
    const model = asked !== undefined && Object.hasOwn(config.models.models, asked) ? config.models.models[asked] : null;
    if (asked !== undefined && (!model || model.pool !== rest[1])) throw new Error('Unknown model for provider.');
    if (model?.cliModel !== undefined && !lib.validCliModel(model.cliModel)) throw new Error('Invalid model CLI name.');
    // Without a model id, a provider with a default still prints runnable arguments.
    if (!provider.cli || !model && !provider.cli.defaultModel) return JSON.stringify(provider, null, 2);
    return JSON.stringify({ ...provider, cli: { ...provider.cli, args: lib.cliArgsForModel(provider.cli, model?.cliModel, flags['--effort']) } }, null, 2);
  }
  if (command === 'provider-switch') {
    if (rest.length !== 2 || !['enable', 'disable'].includes(rest[0])) throw new Error(usage(command));
    const [action, id] = rest;
    checkId(id);
    if (action === 'enable' && config.providers.providers[id].kind === 'local') throw new Error('Local models have their own switch: quota-boss local on <model>');
    const before = settings.snapshot(active);
    const saved = lib.withLock(userFile, verify => {
      const user = lib.readProviderConfig(userFile);
      const next = { ...user, providers: { ...user.providers, [id]: { ...user.providers?.[id], enabled: action === 'enable' } } };
      lib.mergeProviders(lib.BUILTIN_PROVIDERS, next);
      verify(); lib.atomicWrite(userFile, JSON.stringify(next, null, 2) + '\n', verify); return true;
    });
    if (saved === null) throw new Error('Provider config is busy; retry.');
    return 'Provider ' + id + ' ' + (action === 'enable' ? 'enabled' : 'disabled') + '\n' + settings.effect('providers', rest, before, settings.snapshot(active)) + refreshCodexAgents();
  }
  if (command === 'cap') {
    const projectFlags = rest.filter(a => a === '--project').length;
    const project = projectFlags > 0;
    if (project) rest = rest.filter(a => a !== '--project');
    if (rest.length !== 3 || projectFlags > 1) throw new Error(usage(command));
    const [id, window, value] = rest;
    checkId(id);
    if (!Object.hasOwn(lib.QUOTA_WINDOWS, window) || value !== 'off' && !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new Error(usage(command));
    const cap = value === 'off' ? null : Number(value);
    if (cap !== null && (!Number.isFinite(cap) || cap < 1 || cap > 100)) throw new Error('Cap must be 1-100 or off.');
    const directory = active.file ? active.directory : process.cwd();
    const before = settings.snapshot(active);
    if (project) {
      lib.updateProjects(entries => {
        const effective = lib.findProjectConfig();
        const key = lib.projectKey(directory);
        const raw = effective.raw;
        const next = { ...raw, ...lib.normalizeProject(effective), caps: lib.mergeCaps(effective.caps, { [id]: { [window]: cap } }) };
        lib.mergeProviders(config.providers, {}, next);
        return { ...entries, [key]: next };
      });
    } else {
      const result = lib.withLock(userFile, verify => {
        const raw = lib.readProviderConfig(userFile);
        const next = { ...raw, caps: lib.mergeCaps(raw.caps ?? {}, { [id]: { [window]: cap } }) };
        lib.mergeProviders(lib.BUILTIN_PROVIDERS, next);
        verify(); lib.atomicWrite(userFile, JSON.stringify(next, null, 2) + '\n', verify); return true;
      });
      if (result === null) throw new Error('Provider config is busy; retry.');
    }
    return 'Cap ' + id + ' ' + window + '=' + (cap === null ? 'off' : cap + '%') + (project ? ' (project)' : '') + '\n' + settings.effect(command, [...rest, ...(project ? ['--project'] : [])], before, settings.snapshot());
  }
  if (command === 'usage') {
    if (rest.length !== 3) throw new Error(usage(command));
    const [id, amount, unit] = rest;
    checkId(id);
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(amount)) throw new Error('Invalid usage amount.');
    lib.appendUsage(id, Number(amount), unit, config.providers);
    return 'Usage recorded: ' + id + ' ' + amount + ' ' + unit;
  }
  if (command === 'timing') {
    if (rest.length !== 5) throw new Error(usage(command));
    const [model, rawCategory, rawTier, rawSeconds, result] = rest;
    if (!/^[a-z0-9][a-z0-9.\-]{1,63}$/.test(model)) throw new Error('Invalid model.');
    if (rawCategory !== '-' && !lib.CATEGORIES.includes(rawCategory)) throw new Error('Invalid category.');
    if (rawTier !== '-' && !lib.TIERS.includes(rawTier)) throw new Error('Invalid tier.');
    if (!/^\d+$/.test(rawSeconds) || Number(rawSeconds) > 86400) throw new Error('Invalid seconds.');
    if (!['ok', 'fail'].includes(result)) throw new Error('Invalid timing result.');
    const seconds = Number(rawSeconds);
    // The routing table shows labels, so a worker often only knows its provider. A name that matches
    // no model would be stored but never used, so it is resolved here or refused.
    const resolved = resolveModel(config.models.models, model);
    if (!resolved) throw new Error('Unknown model, or a provider with several models: pass the model id.');
    latency.recordRun({ t: Date.now(), model: resolved, category: rawCategory === '-' ? null : rawCategory,
      tier: rawTier === '-' ? null : rawTier, seconds, ok: result === 'ok' });
    return 'Timing recorded: ' + resolved + ' ' + seconds + 's';
  }
  throw new Error(usage(command));
}

function resolveModel(registry, name) {
  if (Object.hasOwn(registry, name)) return name;
  const ofProvider = Object.keys(registry).filter(id => registry[id]?.pool === name);
  if (ofProvider.length === 1) return ofProvider[0];
  // The table shows labels such as "Opus 5.5" and Claude knows its alias "opus"; accept one that fits exactly one model.
  const word = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const byLabel = word(name) ? Object.keys(registry).filter(id => [registry[id]?.label, registry[id]?.agentModel]
    .some(alias => alias && word(alias) === word(name))) : [];
  return byLabel.length === 1 ? byLabel[0] : null;
}

/** Execute a project CLI command and return human-readable output; invalid input throws. */
function run(args = process.argv.slice(2), options) {
  let [command, ...rest] = args;
  if (command === 'worktree') return require('./worktree').run(rest);
  if (command === 'help') { if (rest.length) throw new Error(usage(command)); return HELP; }
  const setting = command === 'set' ? rest[0] : null;
  if (setting !== null) {
    if (Object.hasOwn(REMOVED_SETTINGS, setting)) throw new Error(setting + ' was removed in 0.2.0: ' + REMOVED_SETTINGS[setting]);
    if (!Object.hasOwn(SET_NAMES, setting)) throw new Error('Valid settings: ' + Object.keys(SET_NAMES).join(', '));
    const values = setting === 'profile' ? ['quality', 'balanced', 'frugal'] : setting === 'statusline' ? ['always', 'boss'] : ['on', 'off'];
    if (rest.length !== 2 || setting !== 'context' && !values.includes(rest[1])) throw new Error('Valid values for ' + setting + ': ' + (setting === 'context' ? '<tokens>|off' : values.join('|')));
    command = SET_NAMES[setting]; rest = rest.slice(1);
  } else if (['profile', 'allow-training', 'statusline', 'context'].includes(command)) throw new Error(HELP);
  if (command === 'use') return useCommand(command, rest, options);
  if (command === 'graph') {
    const graph = require('./graph');
    const [kind, ...names] = rest;
    if (!graph.validQuery(kind, names)) throw new Error(graph.QUERY_USAGE);
    return graph.queryGraph(kind, names, process.cwd());
  }
  if (command === 'settings') {
    if (rest.length) throw new Error(usage(command));
    return settings.table();
  }
  if (command === 'rules' && setting === null) {
    if (rest.length !== 2 || rest[0] !== '--host') throw new Error(usage(command));
    return hosts.rules(hosts.checkHost(rest[1]), lib.findProjectConfig());
  }
  if (command === 'doctor') {
    if (rest.length > 1 || rest.length && !['--probe', '--report'].includes(rest[0])) throw new Error(usage(command));
    return rest[0] === '--report' ? diagnostics.report() : diagnostics.doctor(rest.length === 1);
  }
  if (command === 'setup') return setupWizard.setup(rest, run);
  if (command === 'handoff') return context.handoffCommand(rest, lib.findProjectConfig());
  if (command === 'statusline') return statuslineCommand(rest);
  if (command === 'tools') return tools.command(rest, lib.loadConfig());
  if (command === 'add-api') return addApi.add(rest);
  if (command === 'remove-api') return addApi.remove(rest);
  if (command === 'local') {
    const output = local.command(rest, lib.loadConfig());
    return output + (rest.length ? refreshCodexAgents() : '');
  }
  if (command === 'savings') {
    const savings = require('./savings');
    return savings.savings(savings.parseArgs(rest, usage(command)));
  }
  if (['providers', 'cap', 'usage', 'timing'].includes(command)) return providerCommand(command, rest);
  const active = lib.findProjectConfig();
  let project = lib.normalizeProject(active);
  if (command === 'on') {
    const flags = rest.filter(a => a === '--host').length;
    if (flags > 1) throw new Error(usage(command));
    const index = rest.indexOf('--host');
    if (index >= 0) { project.host = hosts.checkHost(rest[index + 1]); rest.splice(index, 2); }
    if (rest.length > 1) throw new Error(usage(command));
    if (rest.length) { checkProfile(rest[0]); project.profile = rest[0]; }
    project.enabled = true;
  } else if (command === 'off') {
    if (rest.length) throw new Error(usage(command));
    project.enabled = false;
  } else if (command === 'profile') {
    if (rest.length !== 1) throw new Error(usage(command));
    checkProfile(rest[0]);
    project.profile = rest[0];
  } else if (command === 'allow-training') {
    if (rest.length !== 1 || !['on', 'off'].includes(rest[0])) throw new Error(usage(command));
    project.allowTrainingProviders = rest[0] === 'on';
  } else if (command === 'context') {
    if (rest.length !== 1) throw new Error(usage(command));
    project.contextSuggest = context.parseSetting(rest[0]);
  } else if (command === 'feedback') {
    if (rest.length !== 4 && (rest.length !== 6 || rest[4] !== '--effort' || rest[5].startsWith('--'))) throw new Error(usage(command));
    const [name, category, tier, result, , effort] = rest;
    const config = lib.loadConfig();
    const model = resolveModel(config.models.models, name) ?? name;
    lib.appendOutcome({ model, category, tier, result, effort }, config.models, lib.readCodexModels(true));
    return 'Feedback recorded: ' + lib.sanitizeLabel(model) + ' ' + category + ' ' + tier + ' ' + result + (effort ? ' at ' + effort : '');
  } else if (['status', 'route'].includes(command)) {
    if (command !== 'route' && rest.length) throw new Error(usage(command));
    let explain = false, size, needs, contextTokens;
    const filters = [...rest];
    if (command === 'route') while (filters[0]?.startsWith('--')) {
      const flag = filters.shift();
      if (flag === '--explain' && !explain) explain = true;
      else if (flag === '--size' && size === undefined) {
        size = filters.shift();
        if (!['small', 'medium', 'large'].includes(size)) throw new Error(usage(command));
      } else if (flag === '--needs' && needs === undefined) {
        needs = (filters.shift() || '').split(',');
        if (needs.some(input => !['text', 'image', 'pdf', 'video', 'audio'].includes(input))) throw new Error(usage(command));
      } else if (flag === '--context' && contextTokens === undefined) {
        const value = filters.shift();
        contextTokens = Number(value);
        if (!/^[1-9]\d*$/.test(value || '') || !Number.isSafeInteger(contextTokens)) throw new Error(usage(command));
      } else throw new Error(usage(command));
    }
    if (command === 'route' && (filters.length > 2 || filters.length > 0 && !lib.CATEGORIES.includes(filters[0])
      || filters.length > 1 && !lib.TIERS.includes(filters[1]))) throw new Error(usage(command));
    const active = lib.findProjectConfig();
    const config = lib.loadConfig(active, { tolerant: command === 'route' });
    const now = Date.now();
    const codex = config.providers.providers.codex?.enabled === false ? null : lib.readCodexLimits(now, config.thresholds, command === 'route');
    const state = lib.readState();
    const limits = lib.readProviderLimits(config.providers, { claude: state.claude, codex }, now, command === 'route');
    if (command === 'route') {
      const bossModel = lib.currentBossModel(active, state);
      const routing = size === undefined && !explain && active.host !== 'codex' ? routeTable : route;
      const result = routing({ ...config, ...active, bossModel, bossEffort: lib.currentBossEffort(active, state, bossModel), size: size ?? config.thresholds.gate?.defaultSize ?? 'medium', needs, context: contextTokens, limits, history: state.history, selfTests: state.selfTests, outcomes: lib.readOutcomes(now, config.thresholds), runs: latency.readRuns(now), now });
      const match = row => (!filters[0] || row.category === filters[0]) && (!filters[1] || row.tier === filters[1]);
      for (const key of ['rows', 'options', 'candidates']) result[key] = result[key].filter(match);
      return (config.warning ? config.warning + '\n' : '') + (explain ? formatExplain(result) : formatTable(result));
    }
    return 'Quota Boss ' + (active.enabled ? 'on' : 'off') + ' | profile ' + active.profile
      + ' | host ' + active.host
      + '\n' + lib.formatLimits(limits, active.profile, config.thresholds, now, config.providers)
      + lib.providerWarnings(config.models, config.providers).map(w => '\n' + w).join('')
      + suggest.statusLines(active, now).map(line => '\n' + line.replace('[quota-boss] ', '').replace('. Propose to the user: ', '. Change with: ')).join('');
  } else throw new Error(HELP);
  const directory = lib.projectKey(process.cwd());
  const before = settings.snapshot();
  let agent;
  lib.updateProjects(entries => {
    const effective = lib.findProjectConfig();
    const current = lib.normalizeProject(effective);
    const fields = command === 'on' ? ['enabled', ...(args.includes('--host') ? ['host'] : []), ...(rest.length ? ['profile'] : [])]
      : command === 'off' ? ['enabled'] : command === 'profile' ? ['profile']
        : [command === 'allow-training' ? 'allowTrainingProviders' : 'contextSuggest'];
    for (const field of fields) current[field] = project[field];
    project = current;
    agent = hosts.agentsText(directory, project.enabled && project.host === 'codex' ? hosts.managedBlock(project) : '');
    return { ...entries, [directory]: { ...effective.raw, ...project,
      managedAgents: effective.raw.managedAgents === true || project.enabled && project.host === 'codex' } };
  }, lib.getPaths().projectsFile, (_next, verify) => {
    hosts.writeAgents(agent, verify);
  });
  let claudeNotice = '';
  if (command === 'on' && project.host !== 'claude-code' && lib.loadConfig().providers.providers.claude?.enabled !== false && !lib.findExecutable('claude')) {
    // The provider switch refreshes registered Codex blocks again with the final state.
    useCommand('use', ['claude', 'off']);
    claudeNotice = '\nClaude CLI not found, so Claude is off as a worker. Turn it on later with: quota-boss use claude on';
  }
  const after = settings.snapshot();
  let hookNotice = '';
  if (command === 'on' && project.host === 'codex') {
    const result = require('./codex-hooks').update(true);
    if (result.message) hookNotice = '\nNote: Could not install Codex SessionStart hook: ' + result.message;
    else if (result.changed) hookNotice = '\nCodex skips new hooks until you trust them: type /hooks in Codex once; until then the boss runs route itself.';
  }
  return 'Quota Boss ' + (project.enabled ? 'on' : 'off') + ' | profile ' + project.profile
    + '\n' + settings.effect(command, rest, before, after) + claudeNotice + hookNotice
    + (command === 'on' && project.host === 'codex' && lib.loadConfig().providers.providers.claude?.enabled !== false ? '\nWarning: ' + providerHelp.SCRIPTED_CLAUDE_WARNING : '');
}

/** `verify --log <model> <category> <tier> [--effort <level>]` records the check's pass or fail as feedback. */
function verifyLog(args) {
  const fresh = args[0] === '--fresh' ? ['--fresh'] : [];
  const rest = args.slice(fresh.length);
  if (rest[0] !== '--log') return { args };
  const effortGiven = rest[4] === '--effort';
  // Categories and tiers never share a word, so either order is unambiguous.
  const [, name, first, second] = rest, effort = effortGiven ? rest[5] : undefined;
  const [category, tier] = lib.TIERS.includes(first) ? [second, first] : [first, second];
  const after = rest.slice(effortGiven ? 6 : 4);
  if (!name || !lib.CATEGORIES.includes(category) || !lib.TIERS.includes(tier)
    || effortGiven && !lib.EFFORT_ORDER.includes(effort) || after[0] !== '--') throw new Error(usage('verify'));
  const config = lib.loadConfig();
  const model = resolveModel(config.models.models, name) ?? name;
  const cache = lib.readCodexModels(true);
  if (!Object.hasOwn(config.models.models, model) && !cache.some(m => m?.slug === model)) {
    throw new Error('Unknown model for --log: pass a model id or a label from the table.');
  }
  const log = code => {
    const result = code === 0 ? 'pass' : 'fail';
    try {
      lib.appendOutcome({ model, category, tier, result, effort }, config.models, cache);
      process.stdout.write('[quota-boss] Feedback recorded: ' + lib.sanitizeLabel(model) + ' ' + result + '.\n');
    } catch (error) { process.stderr.write('[quota-boss] Could not record feedback: ' + error.message + '\n'); }
  };
  return { args: [...fresh, ...after], log };
}

/** Run the CLI, reporting bad input with exit status one. */
function main() {
  if (process.argv[2] === 'verify') {
    let args = process.argv.slice(3), log;
    try { ({ args, log } = verifyLog(args)); }
    catch (error) { process.stderr.write('quota-boss: ' + error.message + '\n'); process.exitCode = 1; return; }
    lib.verifyCommand(args, log).then(code => { process.exitCode = code; }, error => {
      process.stderr.write('quota-boss: ' + error.message + '\n'); process.exitCode = 1;
    });
    return;
  }
  try { process.stdout.write(run() + '\n'); }
  catch (error) { process.stderr.write('quota-boss: ' + error.message + '\n'); process.exitCode = error.exitCode || 1; }
}

if (require.main === module) main();
module.exports = { run, main };
