'use strict';
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');
const hosts = require('./hosts');
const TAIL_BYTES = 8 * 1024 * 1024;
const DENY_LIMIT = 9850; // JSON-escaped reason; the wrapper adds under 100 characters

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
// A saved tool output (Claude Code persists large results) read whole lands in the session at full size.
const SAVED_OUTPUT_BYTES = 40 * 1024, MAX_SCAN_BYTES = 16 * 1024 * 1024, READ_DEFAULT_LINES = 2000;
function sameFile(a, b) {
  const norm = value => { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
  return norm(a) === norm(b);
}
/** Returns the denial reason for a whole read of a large saved output of this session, else null. */
function savedOutputReason(input) {
  const file = input?.tool_input?.file_path, transcript = input?.transcript_path;
  if (typeof file !== 'string' || typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return null;
  const folder = path.dirname(file);
  if (path.basename(folder).toLowerCase() !== 'tool-results' || !sameFile(path.dirname(folder), transcript.slice(0, -6))) return null;
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (size < SAVED_OUTPUT_BYTES) return null;
  // Count what the requested line range really holds, so a range that covers the whole file is not a way around the guard.
  const { offset, limit } = input.tool_input;
  if (offset !== undefined || limit !== undefined) {
    if (size > MAX_SCAN_BYTES) return null;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const start = Math.max(0, (Number.isInteger(offset) ? offset : 1) - 1);
    const count = Number.isInteger(limit) && limit > 0 ? limit : READ_DEFAULT_LINES;
    size = Buffer.byteLength(text.split('\n').slice(start, start + count).join('\n'));
    if (size < SAVED_OUTPUT_BYTES) return null;
  }
  return '[quota-boss] This read covers ' + Math.round(size / 1024) + ' KB of a saved command output and would add all of it to the session. Grep it for what you need, read only the lines you need with offset and limit, or read only the source files the task needs.';
}
function main() {
  try {
    const deadline = Date.now() + 3000;
    const input = lib.readInput();
    if (input?.tool_name === 'Read') {
      const reason = savedOutputReason(input);
      const project = reason && lib.findProjectConfig(input.cwd);
      if (project?.enabled && project.host === 'claude-code') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
      return;
    }
    const project = lib.findProjectConfig(input?.cwd);
    if (!project.enabled || project.host !== 'claude-code' || project.rules !== 'tiny') return;
    const agents = fs.readdirSync(path.join(__dirname, '..', 'agents'), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => entry.name.slice(0, -3));
    if (!agents.includes(input?.tool_input?.subagent_type) || loaded(input.transcript_path, deadline)) return;
    let reason = hosts.rules('claude-code', project) + '\nSend this job again in the handover form from these rules.';
    // Claude Code caps model-visible hook text at 10,000 characters; a long install path can push the rules past it.
    if (JSON.stringify(reason).length > DENY_LIMIT) reason = 'Load the boss rules first: run node "' + lib.substituteHome('{{QUOTA_BOSS_HOME}}')
      + '/scripts/quota-boss.js" rules --host claude-code, then send this job again in the handover form from these rules.';
    if (Date.now() > deadline) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  } catch { /* Hook failures must not interrupt Claude Code. */ }
}
if (require.main === module) {
  process.stdout.on('error', () => {});
  main();
}
module.exports = { main, loaded, savedOutputReason, TAIL_BYTES, SAVED_OUTPUT_BYTES, DENY_LIMIT };
