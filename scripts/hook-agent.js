'use strict';
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');
const hosts = require('./hosts');
const TAIL_BYTES = 8 * 1024 * 1024;

/** A marker from before compaction no longer counts. Never read more than the tail. */
function loaded(file, deadline) {
  if (typeof file !== 'string' || !file) throw new Error('Missing transcript');
  const fd = lib.openRegular(file);
  try {
    const size = fs.fstatSync(fd).size, offset = Math.max(0, size - TAIL_BYTES);
    const bytes = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const count = fs.readSync(fd, bytes, 0, bytes.length, offset);
    const lines = bytes.subarray(0, count).toString('utf8').split('\n');
    if (offset) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (Date.now() > deadline) throw new Error('Transcript scan timed out');
      let line;
      try { line = JSON.parse(lines[i]); } catch { /* Ignore malformed boundary records. */ }
      if (line?.subtype === 'compact_boundary' || line?.isCompactSummary === true) return false;
      if (lines[i].includes(hosts.RULES_LOADED)) return true;
    }
    return false;
  } finally { fs.closeSync(fd); }
}
function main() {
  try {
    const deadline = Date.now() + 3000;
    const input = lib.readInput();
    const project = lib.findProjectConfig(input?.cwd);
    if (!project.enabled || project.host !== 'claude-code' || project.rules !== 'tiny') return;
    const agents = fs.readdirSync(path.join(__dirname, '..', 'agents'), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => entry.name.slice(0, -3));
    if (!agents.includes(input?.tool_input?.subagent_type) || loaded(input.transcript_path, deadline)) return;
    const reason = hosts.rules('claude-code', project) + '\nSend this job again in the handover form from these rules.';
    if (Date.now() > deadline) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  } catch { /* Hook failures must not interrupt Claude Code. */ }
}
if (require.main === module) {
  process.stdout.on('error', () => {});
  main();
}
module.exports = { main, loaded, TAIL_BYTES };
