'use strict';

const lib = require('./lib');
const context = require('./context');
const { route, formatTable } = require('./route');
const latency = require('./latency');

/** Print quota context and refresh routing only after a known session mode changes. */
function main() {
  try {
    const input = lib.readInput();
    const project = lib.findProjectConfig(input?.cwd);
    if (!project.enabled || project.host !== 'claude-code') return;
    const now = Date.now();
    if (lib.normalizeProject(project).contextSuggest !== false && context.validSession(input?.session_id)
      && !(typeof input.prompt === 'string' && input.prompt.trim().startsWith('/'))) {
      // Read without the lock: the state is written only in the rare case that the prompt is stopped.
      const current = lib.readState();
      const entry = Object.hasOwn(current.contexts || {}, input.session_id) ? current.contexts[input.session_id] : undefined;
      const warned = Object.hasOwn(current.coldWarned || {}, input.session_id) ? current.coldWarned[input.session_id] : undefined;
      const reason = context.coldStart(input.transcript_path, entry, warned, now);
      if (reason) {
        lib.updateState(latest => ({ coldWarned: context.recordColdWarning(latest.coldWarned, input.session_id, now) }));
        process.stdout.write(JSON.stringify({ decision: 'block', reason }));
        return;
      }
    }
    const config = lib.loadConfig(project);
    const codex = config.providers.providers.codex?.enabled === false ? null : lib.readCodexLimits(now, config.thresholds);
    const state = lib.readState();
    const limits = lib.readProviderLimits(config.providers, { claude: state.claude, codex }, now);
    const mode = lib.computeModes(limits, config.thresholds, now, config.providers).mode;
    const lines = [lib.formatLimits(limits, project.profile, config.thresholds, now, config.providers)];
    const table = previousPool => { const bossModel = lib.currentBossModel(project, state); return formatTable(route({ ...config, ...project, bossModel, bossEffort: lib.currentBossEffort(project, state, bossModel), size: config.thresholds.gate?.defaultSize ?? 'medium', limits, history: state.history, selfTests: state.selfTests, outcomes: lib.readOutcomes(now, config.thresholds), runs: latency.readRuns(now), now, previousPool })); };
    let tableShown = false;
    if (typeof input?.session_id === 'string' && input.session_id.length > 0 && input.session_id.length <= 256) {
      lib.updateState(current => {
  const entries = current.sessions && typeof current.sessions === 'object' && !Array.isArray(current.sessions) ? current.sessions : {};
        const previous = Object.hasOwn(entries, input.session_id) ? entries[input.session_id] : null;
        if (previous && previous.mode !== mode) {
          lines.push('[quota-boss] mode changed -> ' + lib.formatMode(mode) + '. New routing:');
          lines.push(table(previous.pool));
          tableShown = true;
        }
        const sessions = Object.entries(entries).filter(([id, entry]) => id !== input.session_id && entry && typeof entry.updated_at === 'number');
        sessions.push([input.session_id, { mode, updated_at: now }]);
        sessions.sort((a, b) => a[1].updated_at - b[1].updated_at);
        const contexts = current.contexts && typeof current.contexts === 'object' && !Array.isArray(current.contexts) ? current.contexts : {};
        const measured = Object.hasOwn(contexts, input.session_id) ? context.suggestion(contexts[input.session_id], lib.normalizeProject(project).contextSuggest) : null;
        if (measured?.text) lines.push(measured.text);
        return { sessions: Object.fromEntries(sessions.slice(-50)), ...(measured ? { contexts: { ...contexts, [input.session_id]: measured.entry } } : {}) };
      });
    }
    // What did not fit into the session start beside the rules arrives here, once.
    if (context.deferTable(project, input?.cwd, false) && !tableShown) lines.push(table());
    const notes = context.pendingHandoffText(project, input?.cwd, context.HOOK_BUDGET - Buffer.byteLength(lines.join('\n')) - 2, now);
    if (notes) lines.push(notes);
    process.stdout.write(lines.join('\n') + '\n');
  } catch { /* Hook failures must not interrupt Claude Code. */ }
}

if (require.main === module) {
  process.stdout.on('error', () => {});
  main();
}
module.exports = { main };
