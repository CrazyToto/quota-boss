#!/usr/bin/env node
'use strict';
const lib = require('./lib');
/** Bounded plain-text evidence: failures, the first error with stack context, final summaries. */
function compact(text) {
  const lines = String(text).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').split(/\r?\n/).map(l => l.slice(0, 500));
  const failures = [], summaries = [];
  let error = -1;
  const fail = /^\s*(?:not ok\b|FAIL\b|FAILED\b|FAIL:|--- FAIL:|[×✕❯●]\s|(?:.*\s)?FAILED\b|failures:)/i;
  const summary = /^(?:\[quota-boss\] (?:Check|Reused)|# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|\s*(?:Test Suites:|Tests:|Test Files\s|Duration\s|Time:|test result:|=+.*(?:failed|passed|error)|Found \d+ errors?|\d+ (?:passed|failed)|✖ \d+ problems)|(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\)))/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\d+:\d+\s+(?:error|warning)\b/.test(line) || fail.test(line) || /\.(?:[cm]?[jt]sx?|py|rs|go)[:(]\d+.*(?:error|warning)/i.test(line)) failures.push(i);
    if (summary.test(line)) summaries.push(i);
    if (error < 0 && (/^\s*\d+:\d+\s+error\b/.test(line) || /\.go:\d+:/.test(line) || /(?:\b(?:\w*Error|error(?:\[E\d+\])?):|AssertionError|Assertion failed|Expected:|error TS\d+|^E\s|^panic:|^\s*error\s)/.test(line))) error = i;
  }
  const picked = new Set(failures.slice(0, 24));
  if (error >= 0) for (let i = error; i < Math.min(lines.length, error + 7); i++) if (lines[i].trim()) picked.add(i);
  for (const i of summaries.slice(-8)) picked.add(i);
  if (!picked.size) for (let i = Math.max(0, lines.length - 8); i < lines.length; i++) if (lines[i].trim()) picked.add(i);
  return [...picked].sort((a, b) => a - b).slice(0, 40).map(i => lines[i]).join('\n');
}
function main() {
  try { const output = compact(lib.readStdin(4 * 1024 * 1024)); if (output) process.stdout.write(output + '\n'); }
  catch { process.stderr.write('compact: input exceeds limit or cannot be read\n'); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = { compact, main };
