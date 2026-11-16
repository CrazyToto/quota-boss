'use strict';
const lib = require('./lib');
const { route, formatTable } = require('./route');
const latency = require('./latency');

/** Fresh compact table and limits shared by SessionStart and on-demand Claude rules. */
function build(project, config, input = {}, codexHost = false, now = Date.now()) {
  const codex = config.providers.providers.codex?.enabled === false ? null : lib.readCodexLimits(now, config.thresholds);
  const state = lib.readState();
  const limits = lib.readProviderLimits(config.providers, { claude: state.claude, codex }, now);
  const bossModel = lib.cleanModelId(codexHost ? input?.model : input?.model?.id ?? input?.model) ?? lib.currentBossModel(project, state);
  const table = formatTable(route({ ...config, ...project, bossModel, bossEffort: lib.currentBossEffort(project, state, bossModel), size: config.thresholds.gate?.defaultSize ?? 'medium', limits, history: state.history, selfTests: state.selfTests, outcomes: lib.readOutcomes(now, config.thresholds), runs: latency.readRuns(now), now }), { ladder: false });
  return { table, limits: lib.formatLimits(limits, project.profile, config.thresholds, now, config.providers) };
}
module.exports = { build };
