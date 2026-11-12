'use strict';

const hosts = require('./hosts');
const lib = require('./lib');
const context = require('./context');
const graph = require('./graph');
const { route, formatTable } = require('./route');
const latency = require('./latency');

/** Print trusted session rules and sanitized routing context when the project opts in. */
function main() {
  try {
    const input = lib.readInput();
    const project = lib.findProjectConfig(input?.cwd);
    if (!project.enabled || project.host !== 'claude-code') return;
    const config = lib.loadConfig(project);
    const now = Date.now();
    const codex = config.providers.providers.codex?.enabled === false ? null : lib.readCodexLimits(now, config.thresholds);
    const state = lib.readState();
    const limits = lib.readProviderLimits(config.providers, { claude: state.claude, codex }, now);
    const bossModel = lib.cleanModelId(input?.model?.id ?? input?.model) ?? lib.currentBossModel(project, state);
    let table = formatTable(route({ ...config, ...project, bossModel, bossEffort: lib.currentBossEffort(project, state, bossModel), size: config.thresholds.gate?.defaultSize ?? 'medium', limits, history: state.history, selfTests: state.selfTests, outcomes: lib.readOutcomes(now, config.thresholds), runs: latency.readRuns(now), now }));
    const fixed = [hosts.rules('claude-code', project), graph.sessionText(project.directory), lib.formatLimits(limits, project.profile, config.thresholds, now, config.providers)];
    // Above the host's limit only a short preview reaches the boss, so the table and the notes wait for the first prompt
    // when they do not fit beside the rules.
    const size = parts => Buffer.byteLength(parts.filter(Boolean).join('\n')) + 1;
    const late = size([...fixed, table]) > context.HOOK_BUDGET;
    if (context.deferTable(project, input?.cwd, late) && late) table = '[quota-boss] The routing table arrives with the user\'s first message.';
    const notes = context.sessionStartText(project, input?.source, input?.cwd, now, context.HOOK_BUDGET - size([...fixed, table]) - 1);
    process.stdout.write([fixed[0], fixed[1], notes, table, fixed[2]].filter(Boolean).join('\n') + '\n');
  } catch { /* Hook failures must not interrupt Claude Code. */ }
}

if (require.main === module) {
  process.stdout.on('error', () => {});
  main();
}
module.exports = { main };
