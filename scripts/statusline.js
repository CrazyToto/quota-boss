'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('./lib');
const context = require('./context');

function colored(value, window, thresholds) {
  if (value === undefined) return '?';
  const fallback = { claude: [60, 85], claudeWeekly: [80, 95], codex: [80, 95], codexWeekly: [85, 97] };
  const group = thresholds[window] || {};
  const first = window.startsWith('claude') ? group.save : group.tight;
  const second = window.startsWith('claude') ? group.emergency : group.exhausted;
  const low = typeof first === 'number' ? first : fallback[window][0];
  const high = typeof second === 'number' ? second : fallback[window][1];
  const color = value >= high ? 31 : value >= low ? 33 : 32;
  return '\x1b[' + color + 'm' + value + '%\x1b[0m';
}

/** Render the quota status line using only validated numbers and project enums. */
function formatStatus(limits, project, thresholds, now = Date.now(), providers, contextText = '') {
  const value = lib.limitValues(limits);
  const reset = lib.formatReset(limits.claude?.five_hour?.resets_at, now);
  const modes = lib.computeModes(limits, thresholds, now, providers);
  let line = 'C 5h ' + colored(value.c5h, 'claude', thresholds) + (reset ? ' ↻' + reset : '')
    + ' · wk ' + colored(value.cWeek, 'claudeWeekly', thresholds)
    + ' │ X 5h ' + colored(value.x5h, 'codex', thresholds) + ' · wk ' + colored(value.xWeek, 'codexWeekly', thresholds);
  const bossOn = project.enabled === true;
  if (bossOn) line += ' │ boss on:' + (lib.PROFILES.includes(project.profile) ? project.profile : 'balanced');
  if (modes.codexUnknown) line += ' │ codex data unknown';
  if (modes.codexStale) line += ' │ codex numbers ' + modes.codexAge + ' old';
  if (!bossOn) return line;
  const extra = providers && lib.formatProvidersCompact(providers, limits);
  if (extra) line += ' │ ' + extra;
  if (contextText) line += ' │ ' + contextText;
  return line;
}

/** Persist quota updates and safely compose the previous user-owned status command. */
function main() {
  try {
    const raw = lib.readStdin();
    const input = JSON.parse(raw || '{}');
    const project = lib.findProjectConfig(input?.cwd);
    const config = lib.loadConfig(project, { tolerant: true });
    const now = Date.now();
    const codex = config.providers.providers.codex?.enabled === false ? null : lib.readCodexLimits(now, config.thresholds);
    const state = lib.updateState(current => {
      const claude = lib.updateClaudeLimits(current.claude, input, now);
      const bossModel = lib.cleanModelId(input?.model?.id);
      return { claude, ...(bossModel ? { bossModel, bossModels: lib.recordBossModel(current.bossModels, project.directory, bossModel, now) } : {}), ...(input?.rate_limits ? { history: lib.recordUsageHistory(current.history, 'claude', claude, now, config.thresholds) } : {}),
        ...(project.enabled === true ? { contexts: context.recordContext(current.contexts, input, context.projectId(project, input?.cwd), now) } : {}) };
    }) || lib.readState();
    const limits = lib.readProviderLimits(config.providers, { claude: state.claude, codex }, now);
    const sessions = state.contexts && typeof state.contexts === 'object' ? state.contexts : {};
    const measured = project.enabled === true && typeof input?.session_id === 'string' && Object.hasOwn(sessions, input.session_id) ? sessions[input.session_id] : null;
    const visible = project.enabled === true || lib.showsWithoutBoss();
    const line = visible ? formatStatus(limits, project, config.thresholds, now, config.providers, context.statusSegment(measured, lib.normalizeProject(project).contextSuggest)) + '\n' : '';
    const wrapper = lib.readJson(path.join(lib.getPaths().quotaBossHome, 'wrapped-statusline.json'));
    let prefix = '';
    if (typeof wrapper?.command === 'string' && wrapper.command.trim()) {
      // The sole shell exception: execute the user's saved status line verbatim.
      const result = spawnSync(wrapper.command, [], { ...lib.childProcessOptions(), shell: true, input: raw, encoding: 'utf8', timeout: 2000, maxBuffer: 65536 });
      if (!result.error && result.status === 0 && result.stdout?.trim()) prefix = result.stdout.trimEnd() + '\n';
    }
    process.stdout.write(prefix + line);
  } catch {
    try { if (lib.showsWithoutBoss()) process.stdout.write('C 5h ? · wk ? │ X 5h ? · wk ?\n'); } catch { /* Exit successfully even with a closed output pipe. */ }
  }
}

if (require.main === module) {
  process.stdout.on('error', () => {});
  main();
}
module.exports = { formatStatus, main };
