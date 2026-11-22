'use strict';
const path = require('node:path');
const fs = require('node:fs');
const lib = require('./lib');
const START = '<!-- quota-boss:start -->';
const END = '<!-- quota-boss:end -->';
const RULES_LOADED = '[quota-boss] Boss rules loaded.';
// PreToolUse: worker handover gate (Agent, Task) and the saved-output read guard (Read).
const PRE_TOOL_MATCHER = 'Agent|Task|Read|Bash';
const LEGACY_PRE_TOOL_MATCHERS = ['Agent|Task', 'Agent|Task|Read'];
function boot() {
  return lib.substituteHome(lib.readBounded(path.join(__dirname, '..', 'templates', 'BOOT.md'), 65536).trim());
}
function checkHost(host) {
  if (!lib.HOSTS.includes(host)) throw new Error('Host must be claude-code, codex, or generic.');
  return host;
}
function rules(host, project = {}) {
  checkHost(host);
  let text = '';
  try { text = lib.readBounded(path.join(__dirname, '..', 'templates', 'RULES.md'), 1024 * 1024).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Each host reads only its own worker list: the other hosts' lines cost tokens in every session.
  const other = host === 'claude-code' ? '   - Codex host:' : '   - Claude Code host:';
  let skipping = false;
  text = text.split('\n').filter(line => (skipping = line.startsWith(other) || skipping && line.startsWith('     '), !skipping)).join('\n');
  text = lib.substituteHome(text);
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
  // Claude Code always starts with tiny rules; only the session hook asks for the full text while Claude is saving.
  if (host === 'claude-code' && project.rules !== 'full') {
    const config = lib.loadConfig(project, { tolerant: true });
    const routing = require('./session-routing').build(project, config);
    text = [RULES_LOADED, text, routing.table, routing.limits].filter(Boolean).join('\n');
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
// A Codex boss keeps most work itself, so AGENTS.md holds only the boot lines; the full rules come with `rules --host codex`
// before the first delegation. The 13 KB of rules in every turn cost a Codex boss 25-35% more than boss off (2026-11-19 bench).
function codexBoot() {
  const home = lib.trustedHomeText();
  let text = boot().replace('rules --host claude-code', 'rules --host codex')
    .replace('it has the routing table, the handover form and the checks', 'it has the worker steps, the handover form and the checks')
    .replace(/ For discovery that needs several searches, `scout` or Explore[^\n]*/, '')
    + '\nThe routing table is attached at session start. If a command launch is refused (for example CreateProcessAsUserW failed: 5), run it once more with another shell, on Windows C:\\Windows\\System32\\cmd.exe, and keep using that shell.';
  if (/^[A-Za-z0-9_:\/.\-]+$/.test(home)) text = text.split('"' + home + '/scripts/quota-boss.js"').join(home + '/scripts/quota-boss.js');
  return text;
}
function managedBlock() { return START + '\n' + codexBoot() + '\n' + END; }
module.exports = { writeAgents, scanAgents, checkHost, rules, boot, RULES_LOADED, PRE_TOOL_MATCHER, LEGACY_PRE_TOOL_MATCHERS, agentsText, managedBlock, START, END };
