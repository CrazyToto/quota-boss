'use strict';

const hosts = require('./hosts');
const lib = require('./lib');
const context = require('./context');
const graph = require('./graph');
const { route, formatTable } = require('./route');
const latency = require('./latency');

const FAILED = '[quota-boss] WARNING: Boss mode is ON, but the rules and the routing table could not be loaded. Run quota-boss doctor, and run quota-boss route before every delegation.';

/** Print trusted session rules and sanitized routing context when the project opts in. */
function main() {
  let active = false;
  try {
    const input = lib.readInput();
    const project = lib.findProjectConfig(input?.cwd);
    const codexHost = process.argv.slice(2).join(' ') === '--host codex';
    if (!project.enabled || project.host !== (codexHost ? 'codex' : 'claude-code')) return;
    active = true;
    const config = lib.loadConfig(project, { tolerant: true });
    const now = Date.now();
    const codex = config.providers.providers.codex?.enabled === false ? null : lib.readCodexLimits(now, config.thresholds);
    const state = lib.readState();
    const limits = lib.readProviderLimits(config.providers, { claude: state.claude, codex }, now);
    const bossModel = lib.cleanModelId(codexHost ? input?.model : input?.model?.id ?? input?.model) ?? lib.currentBossModel(project, state);
    let table = formatTable(route({ ...config, ...project, bossModel, bossEffort: lib.currentBossEffort(project, state, bossModel), size: config.thresholds.gate?.defaultSize ?? 'medium', limits, history: state.history, selfTests: state.selfTests, outcomes: lib.readOutcomes(now, config.thresholds), runs: latency.readRuns(now), now }));
    if (codexHost) {
      const warning = config.warning ? config.warning + '\n' : '';
      const output = warning + table + '\n' + lib.formatLimits(limits, project.profile, config.thresholds, now, config.providers) + '\n';
      process.stdout.write(Buffer.byteLength(output) > 8000 ? warning + '[quota-boss] Run node "' + lib.trustedHomeText() + '/scripts/quota-boss.js" route before delegating.\n' : output);
      return;
    }
    const fixed = [hosts.rules('claude-code', project), graph.sessionText(project.directory), [lib.formatLimits(limits, project.profile, config.thresholds, now, config.providers), config.warning].filter(Boolean).join('\n')];
    // Above the host's limit only a short preview reaches the boss, so the table and the notes wait for the first prompt
    // when they do not fit beside the rules.
    const size = parts => Buffer.byteLength(parts.filter(Boolean).join('\n')) + 1;
    const late = size([...fixed, table]) > context.HOOK_BUDGET;
    if (context.deferTable(project, input?.cwd, late) && late) table = '[quota-boss] The routing table arrives with the user\'s first message.';
    const notes = context.sessionStartText(project, input?.source, input?.cwd, now, context.HOOK_BUDGET - size([...fixed, table]) - 1);
    process.stdout.write([fixed[0], fixed[1], notes, table, fixed[2]].filter(Boolean).join('\n') + '\n');
  } catch {
    // Hook failures must not interrupt Claude Code, but an active boss must know the table is missing.
    if (active) try { process.stdout.write(FAILED + '\n'); } catch { /* stdout closed */ }
  }
}

if (require.main === module) {
  process.stdout.on('error', () => {});
  main();
}
module.exports = { main };
