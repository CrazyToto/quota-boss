'use strict';
const path = require('node:path');
const lib = require('./lib');
const { route, poolPrice } = require('./route');
const latency = require('./latency');
const providerHelp = require('./provider-help');
// Shipped help is trusted text. User configuration can change values, never instructions.
// Installed copies keep the shipped help in defaults/, because an older config/ copy is never overwritten.
const shippedHelp = path.join(__dirname, '..', 'defaults', 'settings-help.json');
const HELP = lib.readJson(require('node:fs').existsSync(shippedHelp) ? shippedHelp : path.join(__dirname, '..', 'config', 'settings-help.json'), {});
function helpFor(key) {
  if (Object.hasOwn(HELP, key)) return HELP[key];
  if (/^providers\.[a-z][a-z0-9-]{1,31}(?:\.enabled)?$/.test(key)) return HELP['providers.enabled'];
  if (/^caps\.[a-z][a-z0-9-]{1,31}\.(fiveHour|daily|weekly|monthly)$/.test(key)) return HELP.caps;
  throw new Error('Unknown setting. Use quota-boss settings for setting names.');
}
function explain(key) {
  const provider = key.startsWith('providers.') ? key.slice('providers.'.length) : null;
  if (provider && Object.hasOwn(providerHelp.PROVIDER_HELP, provider)) return providerHelp.explain(provider);
  const h = helpFor(key);
  return h.title + '\n' + Object.entries(h).map(([k, v]) => k + ': ' + v).join('\n');
}
function snapshot(project = lib.findProjectConfig()) {
  const config = lib.loadConfig(project), now = Date.now();
  const codex = config.providers.providers.codex?.enabled === false ? null : lib.readCodexLimits(now, config.thresholds);
  const state = lib.readState();
  const limits = lib.readProviderLimits(config.providers, { claude: state.claude, codex }, now);
  const bossModel = lib.currentBossModel(project, state);
  const result = route({ ...config, ...project, bossModel, bossEffort: lib.currentBossEffort(project, state, bossModel), size: config.thresholds.gate?.defaultSize ?? 'medium', limits, now, history: state.history, selfTests: state.selfTests, outcomes: lib.readOutcomes(now, config.thresholds), runs: latency.readRuns(now) });
  return { project, config, limits, result, now, history: state.history };
}
function entries(project, config) {
  const values = { enabled: project.enabled, profile: project.profile, host: project.host,
    'codex-tasks': project.workers.codex, 'gpt-reviews': project.workers.gpt, perplexity: project.workers.perplexity,
    training: project.allowTrainingProviders, 'short-answers': project.terse, consensus: project.consensus,
    statusline: lib.showsWithoutBoss() ? 'always' : 'boss', context: project.contextSuggest === false ? 'off' : project.contextSuggest };
  return Object.entries(values).map(([key, value]) => ({ key, value, help: helpFor(key) }));
}
/** One compact line per provider instead of one row per provider x cap window. */
function providerLines(config) {
  // Local models stay out of the normal choices until someone turned them on through `local on`.
  const providers = Object.entries(config.providers.providers).filter(([, p]) => p.kind !== 'local' || p.enabled !== false);
  const idWidth = Math.max(...providers.map(([id]) => id.length), 8);
  const lines = ['Providers (global): use <id> on|off  -  ' + HELP['providers.enabled'].what];
  for (const [id, provider] of providers) {
    const caps = Object.entries(config.providers.caps?.[id] || {})
      .filter(([, value]) => typeof value === 'number').map(([window, value]) => window + ' ' + value + '%');
    lines.push('  ' + id.padEnd(idWidth) + ' ' + (provider.enabled !== false ? 'on ' : 'off') + ' | caps: '
      + (caps.length ? caps.join(', ') : 'none') + (provider.trainsOnData ? ' | trains on your data' : '')
      + (provider.kind === 'manual' ? ' | manual: you paste the prompt yourself'
        : provider.tos === 'avoid' ? ' | never auto-routed (tos: avoid)' : ''));
  }
  lines.push('  Caps: ' + HELP.caps.what + ' Set with: cap <provider> <fiveHour|daily|weekly|monthly> <1-100|off>');
  return lines;
}
function table(project = lib.findProjectConfig()) {
  const config = lib.loadConfig(project);
  const rows = entries(project, config);
  const keyWidth = Math.max('Setting'.length, ...rows.map(r => r.key.length));
  const valueWidth = Math.max('Current'.length, ...rows.map(r => String(r.value).length));
  const changes = { enabled: 'on / off', host: 'on --host <claude-code|codex|generic>', profile: 'set profile <quality|balanced|frugal>', statusline: 'set statusline <always|boss>', context: 'set context <tokens>|off' };
  const output = ['Setting'.padEnd(keyWidth) + ' | ' + 'Current'.padEnd(valueWidth) + ' | Change with'];
  for (const r of rows) output.push(r.key.padEnd(keyWidth) + ' | ' + (typeof r.value === 'boolean' ? r.value ? 'on' : 'off' : String(r.value)).padEnd(valueWidth) + ' | ' + (changes[r.key] || 'set ' + r.key + ' <on|off>'));
  output.push('', ...providerLines(config), '');
  output.push('Use `explain <setting>` for when to choose it.');
  return output.join('\n');
}
function count(s) {
  const pools = {};
  if (s.project.enabled) for (const r of s.result.rows) pools[r.pool] = (pools[r.pool] || 0) + 1;
  return Object.entries(pools).map(([p, n]) => p + '=' + n).join(', ') || 'none';
}
function effect(command, args, before, after) {
  const project = after.project;
  let text;
  if (command === 'cap') {
    const [id, window] = args.filter(a => a !== '--project');
    const cap = after.config.providers.caps?.[id]?.[window] ?? 100;
    const source = after.config.providers.providers[id];
    const used = lib.providerWindows(id, after.limits)[window]?.used_percent;
    const context = lib.providerContext(after.config.providers, after.limits, after.history);
    const price = poolPrice(id, context.limits, context.history, after.config.thresholds, after.now, lib.computeModes(after.limits, after.config.thresholds, after.now, after.config.providers));
    text = lib.sanitizeLabel(source.label) + ' may now use at most ' + cap + '% of its ' + window + ' window for delegation. ';
    text += typeof used === 'number' && Number.isFinite(used)
      ? 'At ' + Number(used.toFixed(2)) + '% used, ' + (used >= cap ? 'delegation is blocked by this cap.' : 'the quota price is ' + (Number.isFinite(price) ? price.toFixed(2) + '×' : 'unavailable') + ' and rises with quota pressure.')
      : 'Current usage is unknown; delegation becomes more expensive as usage approaches the cap.';
    if (source.quota.source === 'none') text += ' No quota source is configured, so this cap cannot yet be measured or enforced.';
    if (!args.includes('--project') && Object.hasOwn(project.caps?.[id] ?? {}, window)) {
      const inherited = project.caps[id][window];
      text += ' The project override remains ' + (inherited === null ? 'off (100%)' : inherited + '%') + '.';
    }
    if (source.enabled === false) text += ' This provider is disabled and cannot receive tasks.';
    if (id === (project.host === 'codex' ? 'codex' : project.host === 'claude-code' ? 'claude' : null)) text += ' The boss can still do its own work.';
  } else if (command === 'providers') {
    const p = after.config.providers.providers[args[1]];
    text = args[1] + ' is now ' + (p.enabled !== false ? 'enabled globally.' : 'disabled globally.') + providerHelp.switchEffect(args[1], p.enabled !== false);
    if (p.enabled !== false && p.trainsOnData && !project.allowTrainingProviders) text += ' This project still blocks it because training providers are off.';
    if (p.enabled !== false && p.tos === 'avoid') text += ' Its ToS tag still prevents automatic routing.';
  } else if (command === 'allow-training') {
    const training = Object.values(after.config.providers.providers).filter(p => p.enabled !== false && p.trainsOnData).length;
    text = project.allowTrainingProviders ? training + ' enabled training providers may now receive this project’s tasks.' : 'All training providers are blocked for this project.';
  } else if (command === 'terse') text = project.terse ? 'Replies now use the 4-part short format to save output tokens.' : 'Replies can include fuller explanations; no short-answer rule is added.';
  else if (command === 'consensus') text = project.consensus ? 'Independent critical advice is available in ' + after.result.rows.filter(r => r.options.includes('consensus')).length + ' route rows; each use costs an extra Codex answer.' : 'The consensus option is off: it is hidden from the route table and removed from the session rules. Critical changes still get the counter-review from templates/RULES.md.';
  else if (command === 'on' || command === 'off') text = project.enabled ? 'Routing is on for ' + project.host + ' with the ' + project.profile + ' profile; it applies on the next message/session.' : 'Routing hooks are off and the managed Codex rules block is removed for this project.';
  else if (command === 'context') text = project.contextSuggest === false ? 'A fresh session is no longer suggested.' : 'A fresh session is suggested from ' + project.contextSuggest + ' tokens of context; a smaller context costs less on every step.';
  else if (command === 'profile') text = 'The ' + project.profile + ' profile uses quality weights ' + lib.TIERS.map(t => t + '=' + (after.config.thresholds.alpha?.[t]?.[project.profile] ?? '?')).join(', ') + '; higher weights favor reliable answers over quota savings.';
  else if (command === 'workers') {
    const [worker] = args[0].split('=');
    text = helpFor({ codex: 'codex-tasks', gpt: 'gpt-reviews', perplexity: 'perplexity' }[worker]).title + ' is ' + (project.workers[worker] ? 'enabled' : 'disabled') + '; ' + Object.values(project.workers).filter(Boolean).length + ' of ' + lib.WORKERS.length + ' worker switches are on.';
    if (worker === 'codex' || worker === 'gpt') text += ' Codex task and GPT opinion switches overlap for review/research; either can keep those routes available.';
  }
  return 'Effect: ' + text + ' Suggested task slots by provider: ' + count(before) + ' → ' + count(after) + ' (routing suggestions, not calls made).';
}
module.exports = { HELP, helpFor, explain, entries, table, snapshot, effect };
