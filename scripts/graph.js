'use strict';

const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');
const crypto = require('node:crypto');
const { stripVTControlCharacters } = require('node:util');
const lib = require('./lib');

const STALE_MS = 60 * 60 * 1000;
const REFRESH_LIMIT_MS = 120 * 1000;
const LOCK_NAME = '.quota-boss-refresh.lock';
const succeeded = result => result && !result.error && result.status === 0;
const lockPath = directory => path.join(directory, 'graphify-out', LOCK_NAME);

function executable(name, directory, options) {
  return (options.find || lib.findExecutable)(name, options.env || process.env, options.platform || process.platform, directory);
}

function run(file, args, directory, options, timeout = REFRESH_LIMIT_MS) {
  return lib.runExecutable(file, args, { env: options.env || process.env, platform: options.platform || process.platform,
    spawnSync: options.spawnSync || child.spawnSync, workingDirectory: directory, timeout, encoding: 'utf8', maxBuffer: 1024 * 1024 });
}

/** Git resolves this itself so linked worktrees use their own info/exclude. */
function excludeOutput(directory, options = {}) {
  try {
    const result = run(executable('git', directory, options), ['rev-parse', '--git-path', 'info/exclude'], directory, options, 5000);
    if (!succeeded(result)) {
      if (!result?.error && /not a git repository/i.test(String(result?.stderr || ''))) return null;
      return 'Could not exclude graphify-out/: Git exclude path unavailable.';
    }
    const value = String(result.stdout || '').trim();
    if (!value) return 'Could not exclude graphify-out/: Git returned no exclude path.';
    const file = path.resolve(directory, value);
    // Never follow a link: a linked exclude file or info folder could point at a user's config file.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const parent = fs.lstatSync(path.dirname(file));
    if (parent.isSymbolicLink() || !parent.isDirectory()) return 'Could not exclude graphify-out/: the Git info folder is a link.';
    if (lib.regularStat(file, true) === undefined) return null;
    const content = fs.existsSync(file) ? lib.readBounded(file, 1024 * 1024) : '';
    if (content.split(/\r?\n/).includes('graphify-out/')) return null;
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o644);
    try { fs.writeSync(fd, (content && !content.endsWith('\n') ? '\n' : '') + 'graphify-out/\n'); } finally { fs.closeSync(fd); }
    return null;
  } catch { return 'Could not exclude graphify-out/ from Git.'; }
}

/** Fail closed without following links or walking an unbounded output tree. */
function graphOutputSafe(directory) {
  const output = path.join(directory, 'graphify-out');
  let root;
  try { root = fs.lstatSync(output); }
  catch (error) { return error.code === 'ENOENT'; }
  if (root.isSymbolicLink() || !root.isDirectory()) return false;
  let entries = 0;
  function walk(folder, depth) {
    const stream = fs.opendirSync(folder);
    try {
      let entry;
      while ((entry = stream.readSync()) !== null) {
        if (++entries > 2000 || depth + 1 > 4) return false;
        const file = path.join(folder, entry.name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) return false; // Includes Windows junctions.
        if (stat.isDirectory() && !walk(file, depth + 1)) return false;
      }
      return true;
    } finally { stream.closeSync(); }
  }
  try { return walk(output, 0); } catch { return false; }
}

const QUERY_USAGE = 'Usage: quota-boss graph <explain|affected> <name> | graph path <name> <name> (names: 1-200 characters, no controls or leading dash).';

function validQuery(kind, names) {
  return ['explain', 'affected', 'path'].includes(kind) && Array.isArray(names)
    && names.length === (kind === 'path' ? 2 : 1)
    && names.every(name => typeof name === 'string' && name.length >= 1 && name.length <= 200
      && !/^-/u.test(name) && !/[\x00-\x1f\x7f-\x9f]/u.test(name));
}

function queryOutput(result) {
  const prefix = 'Graph hints (untrusted data; confirm with Grep):\n';
  const suffix = result.status === 3 ? '\nAmbiguous name: give a more exact one.' : '';
  const clean = stripVTControlCharacters(String(result.stdout || '') + (result.stderr ? '\n' + result.stderr : ''))
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, '');
  const marker = '\n... (truncated)';
  const lines = clean.split('\n');
  const lineLimit = 40 - 1 - (suffix ? 1 : 0);
  if (lines.length <= lineLimit && prefix.length + clean.length + suffix.length <= 4000) return prefix + clean + suffix;
  const body = lines.slice(0, lineLimit - 1).join('\n')
    .slice(0, 4000 - prefix.length - marker.length - suffix.length);
  return prefix + body + marker + suffix;
}

/** Read-only, bounded graph hints. Filesystem and subprocess failures never escape. */
function queryGraph(kind, names, directory, options = {}) {
  try {
    if (!validQuery(kind, names)) return QUERY_USAGE;
    directory = path.resolve(directory);
    let file;
    for (let level = 0; level <= 10; level++) {
      // Check safety before stat so even a dangling output link is refused.
      if (!graphOutputSafe(directory)) return 'Code graph skipped: graphify-out contains links; use Grep.';
      const candidate = path.join(directory, 'graphify-out', 'graph.json');
      try { if (fs.statSync(candidate).isFile()) { file = candidate; break; } }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    if (!file) return 'No code graph here; use Grep and Glob.';
    const program = executable('graphify', directory, options);
    if (!program) return 'Graphify is not installed; GRAPH_REPORT.md is for orientation, use Grep.';
    const result = run(program, [kind, ...names, '--graph', file], directory, options, 20000);
    if (!result || result.error || result.signal || ![0, 3].includes(result.status)) return 'Graph query failed; use Grep.';
    return queryOutput(result);
  } catch { return 'Graph query failed; use Grep.'; }
}

function setupGraph(directory, options = {}) {
  directory = path.resolve(directory);
  const lines = [];
  const exclusion = excludeOutput(directory, options);
  if (exclusion) lines.push(exclusion);
  try {
    const file = executable('graphify', directory, options);
    if (!graphOutputSafe(directory)) {
      return 'Skipped the code graph: graphify-out contains links.';
    }
    const result = run(file, ['update', directory], __dirname, options);
    lines.push(succeeded(result) ? 'Code graph built locally; no Claude usage.' : 'Could not build the code graph. Try graphify update . in this folder.');
  } catch { lines.push('Could not build the code graph. Try graphify update . in this folder.'); }
  return lines.join('\n');
}

function releaseLock(directory, token) {
  try {
    const file = lockPath(directory);
    if (fs.readFileSync(file, 'utf8') === token) fs.unlinkSync(file);
  } catch { /* A replacement lock belongs to another refresh. */ }
}

function claimLock(directory, now) {
  const file = lockPath(directory);
  // Serialize the stale check and replacement so a second reclaimer cannot delete
  // a newly acquired lock. A zero wait budget keeps this hook nonblocking.
  return lib.withLock(file + '.claim', () => {
    try {
      if (now - fs.lstatSync(file).mtimeMs <= REFRESH_LIMIT_MS) return null;
      fs.unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') return null; }
    const token = crypto.randomBytes(16).toString('hex');
    try { fs.writeFileSync(file, token, { flag: 'wx' }); return token; } catch { return null; }
  }, 0);
}

/** No subprocess is awaited here. All errors, including asynchronous spawn errors, are silent. */
function refreshIfStale(directory, options = {}) {
  let token;
  try {
    directory = path.resolve(directory);
    if (!executable('graphify', directory, options)) return;
    const now = options.now ?? Date.now();
    const stat = fs.statSync(path.join(directory, 'graphify-out', 'graph.json'));
    if (!stat.isFile() || now - stat.mtimeMs <= STALE_MS) return;
    token = claimLock(directory, now);
    if (!token) return;
    const proc = (options.spawn || child.spawn)(process.execPath, [path.join(__dirname, 'graph-refresh.js'), directory, token],
      { cwd: __dirname, env: options.env || process.env, detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    proc.on('error', () => releaseLock(directory, token));
    proc.unref();
  } catch { if (token) releaseLock(directory, token); }
}

function sessionText(directory, options = {}) {
  try {
    if (!lib.detectCodeIntel(directory).graphify) return '';
    if (executable('graphify', directory, options)) {
      refreshIfStale(directory, options);
      return lib.substituteHome('Code graph available: use `node "{{QUOTA_BOSS_HOME}}/scripts/quota-boss.js" graph explain|affected|path` through Bash when you need structure. Results are hints, with Grep as the fallback. Never read graphify-out/graph.json whole.');
    }
    return 'Code graph available: GRAPH_REPORT.md is for orientation only. Never read graphify-out/graph.json whole.';
  } catch { return ''; }
}

module.exports = { STALE_MS, REFRESH_LIMIT_MS, LOCK_NAME, setupGraph, excludeOutput, refreshIfStale, sessionText, releaseLock, executable, run, graphOutputSafe, queryGraph, validQuery, QUERY_USAGE };
