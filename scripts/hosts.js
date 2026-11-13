'use strict';
const path = require('node:path');
const fs = require('node:fs');
const lib = require('./lib');
const START = '<!-- quota-boss:start -->';
const END = '<!-- quota-boss:end -->';
function checkHost(host) {
  if (!lib.HOSTS.includes(host)) throw new Error('Host must be claude-code, codex, or generic.');
  return host;
}
function rules(host, project = {}) {
  checkHost(host);
  let text = '';
  try { text = lib.readBounded(path.join(__dirname, '..', 'templates', 'RULES.md'), 1024 * 1024).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (project.consensus === false) text = text.split('\n').filter(line => !line.includes('use `consensus` before deciding')).join('\n').trimEnd();
  // Each host reads only its own worker list: the other hosts' lines cost tokens in every session.
  const other = host === 'claude-code' ? '   - Codex host:' : '   - Claude Code host:';
  let skipping = false;
  text = text.split('\n').filter(line => (skipping = line.startsWith(other) || skipping && line.startsWith('     '), !skipping)).join('\n');
  text = lib.substituteHome(text);
  if (project.terse === true) text += '\nKeep answers terse: verdict, changed files, verification, and open issues only.';
  if (host !== 'claude-code') {
    const home = lib.trustedHomeText();
    if (/[\x00-\x1f\x7f"$]/.test(home) || home.includes(String.fromCharCode(96))) throw new Error('Unsafe installation path for rules.');
    const providers = host === 'codex' ? lib.loadProviders(project).providers : {};
    const claude = host === 'codex' && providers.claude && providers.claude.enabled !== false;
    const cli = host !== 'codex' || Object.entries(providers).some(([id, p]) => !['claude', 'codex'].includes(id) && p.enabled !== false && p.worker === 'cli-worker');
    const workers = [...(claude ? ['claude-worker'] : []), ...(cli ? ['cli-worker'] : [])];
    text += host === 'codex' ? '\nA routing table is attached at session start once the hook is trusted. When no table was attached, before delegating run node "' + home + '/scripts/quota-boss.js" route and follow the table.\n'
      : '\nBefore delegating run node "' + home + '/scripts/quota-boss.js" route and follow the table.\n';
    text += host === 'codex' ? 'Codex is the boss. Only rows marked self are for your own model. If a command launch is refused (for example CreateProcessAsUserW failed: 5 for pwsh from WindowsApps), run the same command once more with another shell, on Windows C:\\Windows\\System32\\cmd.exe, and keep using that shell. If route still cannot run (for example a sandbox blocks process launches), do the work yourself and spawn no subagents: guessing a worker costs more than it saves. Never spawn a subagent on your own model at the same or a higher effort. For a codex-subagent row, spawn a Codex subagent and name the exact model and reasoning effort from the table: it uses your plan and sandbox directly, with no CLI relay. Use claude-worker for Claude tasks and cli-worker for other official CLIs.\n'
      : 'Generic host: use cli-worker and its official CLI argument template.\n';
    if (host === 'codex') {
      text = text.replace(' Use claude-worker for Claude tasks and cli-worker for other official CLIs.',
        claude && cli ? ' Use claude-worker for Claude tasks and cli-worker for other official CLIs.'
          : claude ? ' Use claude-worker for Claude tasks.' : cli ? ' Use cli-worker for other official CLIs.' : '');
      if (!claude || !cli) text += 'If a table row names claude-worker or cli-worker and its steps are not in these rules, run node "' + home + '/scripts/quota-boss.js" rules --host codex and follow that worker\'s section.\n';
    }
    for (const worker of workers) text += '\n' + lib.readBounded(path.join(__dirname, '..', 'agents', worker + '.md'), 65536).split('{{QUOTA_BOSS_HOME}}').join(home);
    if (/^[A-Za-z0-9_:\/.\-]+$/.test(home)) text = text.replace(/"([^"\r\n]+)"/g, (quoted, file) => file.startsWith(home + '/scripts/') && !file.slice(home.length + 9).includes('/') ? file : quoted);
  }
  return text;
}
function writeAgents(agent, verify) {
  if (agent.text === agent.previous) return;
  if (agent.text.trim()) return lib.atomicWrite(agent.file, agent.text, verify);
  lib.checkParents(agent.file); lib.regularStat(agent.file);
  verify(); fs.unlinkSync(agent.file);
}
function agentsText(directory, block) {
  const file = path.join(directory, 'AGENTS.md');
  let text = '';
  try { text = lib.readBounded(file, 1024 * 1024); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const starts = text.split(START).length - 1, ends = text.split(END).length - 1;
  if (starts !== ends || starts > 1 || starts && text.indexOf(START) > text.indexOf(END)) throw new Error('Malformed quota-boss AGENTS.md markers.');
  if (starts) {
    const start = text.indexOf(START), end = text.indexOf(END) + END.length;
    return { file, text: text.slice(0, start) + block + text.slice(end), previous: text };
  }
  return { file, text: text + block, previous: text };
}
/** Bounded legacy cleanup discovery. The root is depth zero; links are never traversed. */
function scanAgents(directory, maxDepth = 6, maxEntries = 5000) {
  const found = [];
  let visited = 0;
  function walk(dir, depth) {
    lib.checkParents(path.join(dir, 'AGENTS.md'));
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    const stream = fs.opendirSync(dir);
    try {
      let entry;
      while (visited < maxEntries && (entry = stream.readSync())) {
        visited++;
        if (entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === 'AGENTS.md') found.push(dir);
        // Node 18 on Windows reports a junction as a plain directory, so ask the file system.
        else if (entry.isDirectory() && depth < maxDepth && !fs.lstatSync(file).isSymbolicLink()) walk(file, depth + 1);
      }
    } finally { stream.closeSync(); }
  }
  // In particular, do not follow a symlink supplied as the scan root.
  if (!fs.lstatSync(directory).isSymbolicLink()) walk(path.resolve(directory), 0);
  return found;
}
function managedBlock(project) { return START + '\n' + rules('codex', project) + '\n' + END; }
function recommend(config, outcomes = [], now = Date.now()) {
  const unavailable = lib.unavailableModels(outcomes, now, config.thresholds);
  const rateLimited = lib.rateLimitedModels(outcomes, now, config.thresholds);
  const candidates = Object.entries(config.models.models || {}).flatMap(([id, m]) => {
    const p = config.providers.providers[m?.pool];
    if (!p || p.enabled === false || p.kind === 'manual' || p.tos === 'avoid' || p.trainsOnData === true && config.allowTrainingProviders !== true || unavailable.has(id) || rateLimited.has(id) || !['claude', 'codex'].includes(m.pool)
      || !Number.isFinite(m.cost) || m.cost <= 0 || !Number.isFinite(m.scores?.architecture) || !Number.isFinite(m.scores?.review)) return [];
    return [{ id, host: m.pool === 'claude' ? 'claude-code' : 'codex', label: lib.sanitizeLabel(m.label), score: lib.bossScore(m), cost: m.cost }];
  });
  const describe = pick => pick.host + ' with ' + pick.label + ' (' + lib.sanitizeLabel(pick.id) + ', boss score ' + pick.score.toFixed(1) + ', cost ' + pick.cost + ')';
  const best = lib.pickBoss(candidates);
  if (!best) return 'No enabled provider can host.';
  const other = lib.pickBoss(candidates.filter(c => c.host !== best.host));
  return describe(best) + '; architecture/review score (60/40), and within 0.5 of the best the cheapest wins.'
    + (other ? '\nBest on the other host: ' + describe(other) + '.' : '');
}
module.exports = { writeAgents, scanAgents, checkHost, rules, agentsText, managedBlock, recommend, START, END };
