'use strict';

const hosts = require('./hosts');
const lib = require('./lib');
const context = require('./context');
const graph = require('./graph');
const routing = require('./session-routing');
const suggest = require('./suggest');

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
    const size = parts => Buffer.byteLength(parts.filter(Boolean).join('\n')) + 1;
    // Setting suggestions are optional and come last: any failure or a full budget simply drops them. A suggestion shown
    // here returns only after a day or when its condition comes back; quota-boss status always lists the current ones.
    const tips = parts => {
      try {
        const all = suggest.suggestions(suggest.gather(project, config, now), now), shown = [], kept = [];
        for (const s of suggest.due(all, now)) {
          const line = suggest.lines([s])[0];
          if (size([...parts, ...kept, line]) > context.HOOK_BUDGET) continue;
          kept.push(line); shown.push(s);
        }
        suggest.remember(all, shown, now);
        return kept.join('\n');
      } catch { return ''; }
    };
    // Tiny start only while Claude quota is normal: a saving boss must see the table at once to hand work down.
    const tiny = !codexHost && project.rules === 'tiny';
    const saving = tiny && routing.claudeSaving(config, now);
    if (tiny && !saving) {
      const fixed = [hosts.boot(), graph.sessionText(project.directory), config.warning];
      const notes = context.sessionStartText(project, input?.source, input?.cwd, now, context.HOOK_BUDGET - size(fixed) - 1);
      process.stdout.write([...fixed, notes, tips([...fixed, notes])].filter(Boolean).join('\n') + '\n');
      return;
    }
    let { table, limits } = routing.build(project, config, input, codexHost, now);
    // Codex starts get no suggestions on purpose: they stay the bare table and limits, and quota-boss status lists them.
    if (codexHost) {
      const warning = config.warning ? config.warning + '\n' : '';
      const output = warning + table + '\n' + limits + '\n';
      process.stdout.write(Buffer.byteLength(output) > 8000 ? warning + '[quota-boss] Run node "' + lib.trustedHomeText() + '/scripts/quota-boss.js" route before delegating.\n' : output);
      return;
    }
    // A saving tiny project gets the full start, marked as loaded so the worker gate lets the first delegation through.
    const rules = saving ? hosts.RULES_LOADED + '\n' + hosts.rules('claude-code', { ...project, rules: 'full' }) : hosts.rules('claude-code', project);
    const fixed = [rules, graph.sessionText(project.directory), [limits, config.warning].filter(Boolean).join('\n')];
    // Above the host's limit only a short preview reaches the boss, so the table and the notes wait for the first prompt
    // when they do not fit beside the rules.
    const late = size([...fixed, table]) > context.HOOK_BUDGET;
    if (context.deferTable(project, input?.cwd, late, input?.session_id) && late) table = '[quota-boss] The routing table arrives with the user\'s first message.';
    const notes = context.sessionStartText(project, input?.source, input?.cwd, now, context.HOOK_BUDGET - size([...fixed, table]) - 1);
    const advice = tips([...fixed, table, notes]);
    process.stdout.write([fixed[0], fixed[1], notes, table, fixed[2], advice].filter(Boolean).join('\n') + '\n');
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
