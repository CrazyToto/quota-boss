'use strict';
const lib = require('./lib');
const { route, routeTable, formatTable } = require('./route');
const latency = require('./latency');

/** Fresh compact table and limits shared by SessionStart and on-demand Claude rules. */
function readLimits(config, now = Date.now()) {
  const codex = config.providers.providers.codex?.enabled === false ? null : lib.readCodexLimits(now, config.thresholds);
  const state = lib.readState();
  return { state, limits: lib.readProviderLimits(config.providers, { claude: state.claude, codex }, now) };
}
/** True while the Claude pool is saving: then the boss needs the table from the start to hand work down. */
function claudeSaving(config, now = Date.now()) {
  return lib.computeModes(readLimits(config, now).limits, config.thresholds, now, config.providers).claudeMode !== 'normal';
}
function build(project, config, input = {}, codexHost = false, now = Date.now()) {
  const { state, limits } = readLimits(config, now);
  const bossModel = lib.cleanModelId(codexHost ? input?.model : input?.model?.id ?? input?.model) ?? lib.currentBossModel(project, state);
  const routing = codexHost || project.host === 'codex' ? route : routeTable;
  const table = formatTable(routing({ ...config, ...project, bossModel, bossEffort: lib.currentBossEffort(project, state, bossModel), size: config.thresholds.gate?.defaultSize ?? 'medium', limits, history: state.history, selfTests: state.selfTests, outcomes: lib.readOutcomes(now, config.thresholds), runs: latency.readRuns(now), now }), { ladder: false });
  return { table, limits: lib.formatLimits(limits, project.profile, config.thresholds, now, config.providers) };
}
module.exports = { build, readLimits, claudeSaving };
