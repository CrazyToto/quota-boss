'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const MAX_LOG_BYTES = 512 * 1024;
const CATEGORIES = ['architecture', 'debugging', 'implementation', 'review', 'research', 'mechanical'];
const TIERS = ['critical', 'normal', 'trivial'];
const RESULTS = ['pass', 'fail', 'unavailable', 'limited'];
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const RATE_LIMIT_MINUTES = 15;
const PROFILES = ['quality', 'balanced', 'frugal'];
const HOSTS = ['claude-code', 'codex', 'generic'];
const WORKERS = ['codex', 'gpt', 'perplexity'];
const CONTEXT_SUGGEST_DEFAULT = 100000, CONTEXT_SUGGEST_MIN = 20000, CONTEXT_SUGGEST_MAX = 2000000;

/** Resolve runtime paths without accessing credentials. */
function getPaths() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const codexDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const quotaBossHome = path.resolve(process.env.QUOTA_BOSS_HOME || process.env.HARNESS_HOME || path.join(claudeDir, 'quota-boss'));
  return { claudeDir, codexDir, quotaBossHome, projectsFile: path.join(quotaBossHome, 'projects.json'), stateFile: path.join(quotaBossHome, 'state.json'), outcomesFile: path.join(quotaBossHome, 'outcomes.jsonl'), usageFile: path.join(quotaBossHome, 'usage.jsonl'),
    defaultConfigDir: path.join(__dirname, '..', 'config') };
}

/** Read JSON safely, returning fallback for missing, invalid, or oversized files. */
function readJson(file, fallback = null, maxBytes = 4 * 1024 * 1024) {
  try {
    const text = readBounded(file, maxBytes);
    return JSON.parse(text);
  } catch { return fallback; }
}

/** Read a complete small file with a hard byte limit, including concurrent growth. */
function readBounded(file, maxBytes) {
  const fd = openRegular(file);
  try {
    const size = fs.fstatSync(fd).size;
    if (size > maxBytes) throw new Error('File too large');
    const buffer = Buffer.alloc(Math.min(size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes || length > size) { const error = new Error('File grew during read'); error.code = 'FILE_CHANGED'; throw error; }
    return buffer.toString('utf8', 0, length);
  } finally { fs.closeSync(fd); }
}

/**
 * A link of the system itself: directly in the root directory, owned by root, and the root directory belongs to root and
 * others cannot write it. macOS has /var and /tmp as such links, and some Linux systems /home. Links deeper down never
 * pass, so a link inside a checkout stays refused also when root runs the tool. Windows reports no owner, so no link passes.
 */
function systemLink(stat, container, topLevel, platform = process.platform) {
  return platform !== 'win32' && topLevel && stat.isSymbolicLink() && stat.uid === 0 && container.uid === 0 && container.isDirectory() && (container.mode & 0o022) === 0;
}
/** Reject linked parents and special files before any open (including FIFOs). */
function checkParents(file, create = false, depth = 0) {
  const parent = path.dirname(path.resolve(file));
  const container = path.dirname(parent);
  if (parent !== container) checkParents(parent, create, depth);
  let stat;
  try { stat = fs.lstatSync(parent); } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    fs.mkdirSync(parent);
    return;
  }
  if (stat.isSymbolicLink() && depth < 8 && systemLink(stat, fs.lstatSync(container), container === path.dirname(container))) {
    // The path the link points to passes the same check, component by component, and must exist.
    checkParents(path.join(path.resolve(container, fs.readlinkSync(parent)), '.child'), false, depth + 1);
    stat = fs.statSync(parent);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe parent directory: ' + parent);
}
function regularStat(file, missing = false) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Expected regular file, refusing symlink or special file: ' + file);
    return stat;
  } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
}
function openRegular(file, flags = fs.constants.O_RDONLY, create = false) {
  checkParents(file, create);
  const before = regularStat(file, create);
  const fd = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), 0o600);
  try {
    const after = fs.fstatSync(fd);
    const current = regularStat(file);
    if (!after.isFile() || before && !(flags & fs.constants.O_EXCL) && (before.dev !== after.dev || before.ino !== after.ino)
      || current.dev !== after.dev || current.ino !== after.ino) {
      const error = new Error('File changed while opening: ' + file); error.code = 'FILE_CHANGED'; throw error;
    }
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}
/** Atomically replace a regular file using an exclusively created sibling. */
function atomicWrite(file, text, beforeCommit) {
  checkParents(file, true);
  regularStat(file, true);
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(12).toString('hex');
  let fd;
  try {
    fd = openRegular(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, true);
    fs.writeFileSync(fd, text, { encoding: 'utf8' });
    fs.fsyncSync(fd);
    const written = fs.fstatSync(fd);
    fs.closeSync(fd); fd = undefined;
    checkParents(file); regularStat(file, true);
    const ready = regularStat(temporary);
    if (written.dev !== ready.dev || written.ino !== ready.ino) throw new Error('Temporary file changed.');
    if (beforeCommit) beforeCommit();
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function appendRegular(file, text) {
  const fd = openRegular(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, true);
  try { fs.writeSync(fd, text, null, 'utf8'); } finally { fs.closeSync(fd); }
}
/** Ownership survives pauses: only a confirmed dead PID can be reclaimed. */
/** Windows keeps a deleted file in its folder while another process still reads it. An empty leftover expires like any abandoned claim. */
function removeClaimFolder(folder) {
  for (let attempt = 0; ; attempt++) {
    try { fs.rmdirSync(folder); return; } catch (error) {
      if (error.code === 'ENOENT') return;
      if (!['ENOTEMPTY', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
      if (attempt >= 5) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

/** A sandbox or read-only home refused the write; reads may carry on without it. */
function writeDenied(error) { return ['EPERM', 'EACCES', 'EROFS'].includes(error?.code); }

function withLock(file, action, timeout = 200, lock = file + '.lock') {
  checkParents(file, true);
  const token = { pid: process.pid, nonce: crypto.randomBytes(16).toString('hex') };
  const encoded = JSON.stringify(token);
  const deadline = performance.now() + timeout;
  const owned = () => { try { return readBounded(lock, 4096) === encoded; } catch { return false; } };
  let pendingDelete = 0;
  while (true) {
    let fd, opening = true;
    try {
      fd = openRegular(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, true);
      opening = false;
      fs.writeFileSync(fd, encoded); fs.closeSync(fd); fd = undefined;
      if (!owned()) throw new Error('Lock ownership changed during acquisition.');
      try { return action(() => { if (!owned()) throw new Error('Lock ownership lost.'); }); }
      finally { if (owned()) fs.unlinkSync(lock); }
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      // Windows refuses to create a name whose old file is deleted but still open in another process. That passes in
      // milliseconds, while a real refusal (sandbox, read-only home) stays and is thrown after a few tries.
      if (opening && error.code === 'EPERM' && process.platform === 'win32' && pendingDelete++ < 8) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      if (error.code === 'FILE_CHANGED' || error.code === 'ENOENT') { if (performance.now() >= deadline) return null; continue; }
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = regularStat(lock);
        const old = readBounded(lock, 4096);
        let owner; try { owner = JSON.parse(old); } catch {}
        let dead = false;
        if (Number.isInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
        } else dead = Date.now() - stat.mtimeMs > 30000;
        if (dead) {
          // Serialize reclamation of this particular token. Acquisitions with a new token
          // cannot be renamed by a contender still holding an old observation.
          const claim = lock + '.reclaim-' + crypto.createHash('sha256').update(old).digest('hex');
          const ownerFile = path.join(claim, 'owner.json');
          const claimOwned = () => { try { return readBounded(ownerFile, 4096) === encoded; } catch { return false; } };
          let claimed = false, reclaimed = false;
          try {
            try {
              fs.mkdirSync(claim);
              const ownerFd = openRegular(ownerFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, true);
              try { fs.writeFileSync(ownerFd, encoded); } finally { fs.closeSync(ownerFd); }
              claimed = true;
            } catch (e) {
              if (e.code !== 'EEXIST') throw e;
              const observed = fs.lstatSync(claim);
              if (observed.isSymbolicLink() || !observed.isDirectory()) throw new Error('Unsafe reclamation claim.');
              let claimBytes = null, claimOwner;
              try { claimBytes = readBounded(ownerFile, 4096); claimOwner = JSON.parse(claimBytes); }
              catch (readError) { if (readError.code !== 'ENOENT' && !(readError instanceof SyntaxError)) throw readError; }
              let ownerDead = false;
              if (Number.isInteger(claimOwner?.pid) && claimOwner.pid > 0) {
                try { process.kill(claimOwner.pid, 0); } catch (pidError) { ownerDead = pidError.code === 'ESRCH'; }
              }
              if (ownerDead || Date.now() - observed.mtimeMs > 10000) {
                const current = fs.lstatSync(claim);
                let currentBytes = null;
                try { currentBytes = readBounded(ownerFile, 4096); } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
                if (current.dev === observed.dev && current.ino === observed.ino && currentBytes === claimBytes) {
                  const abandoned = claim + '.stale-' + token.nonce;
                  fs.renameSync(claim, abandoned);
                  // Only known ownership metadata may be removed; never recurse through claims.
                  try { fs.unlinkSync(path.join(abandoned, 'owner.json')); } catch (removeError) { if (removeError.code !== 'ENOENT') throw removeError; }
                  removeClaimFolder(abandoned);
                }
              }
            }
            if (claimed && claimOwned() && readBounded(lock, 4096) === old) {
              const stale = lock + '.stale-' + token.nonce;
              if (!claimOwned()) throw new Error('Reclamation ownership lost.');
              fs.renameSync(lock, stale);
              try { if (readBounded(stale, 4096) !== old) throw new Error('Stale lock changed.'); }
              finally { fs.unlinkSync(stale); }
              reclaimed = true;
            }
          } catch (e) { if (!['EEXIST', 'ENOENT'].includes(e.code)) throw e; }
          finally { if (claimed && claimOwned()) { fs.unlinkSync(ownerFile); removeClaimFolder(claim); } }
          // Recovery can use up the whole wait; giving up now would drop the update although the lock is free.
          if (!reclaimed && performance.now() >= deadline) return null;
          continue;
        }
      } catch (e) { if (['ENOENT', 'FILE_CHANGED'].includes(e.code)) { if (performance.now() >= deadline) return null; continue; } throw e; }
      if (performance.now() >= deadline) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** Atomically save a JSON value. */
function writeJson(file, value) { atomicWrite(file, JSON.stringify(value, null, 2) + '\n'); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
const CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,127}$/;
const validCliModel = value => typeof value === 'string' && CLI_MODEL.test(value);

const CLI_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

function cliArgsForModel(cli, cliModel, effort) {
  if (effort !== undefined && effort !== null && !CLI_EFFORTS.includes(effort)) throw new Error('Invalid effort.');
  const level = effort || cli.defaultEffort;
  // Without a level the flag goes too, because some models refuse it (Copilot's auto does).
  const args = level ? cli.args.map(arg => arg.replaceAll('{effort}', level))
    : cli.args.filter((arg, index) => !arg.includes('{effort}') && !(arg.startsWith('-') && cli.args[index + 1]?.includes('{effort}')));
  if (args.some(arg => arg.includes('{model}'))) {
    const selected = cliModel || cli.defaultModel;
    if (!selected) throw new Error('This provider CLI has no model to select.');
    return args.map(arg => arg.replaceAll('{model}', selected));
  }
  if (cliModel) {
    const flag = args.findIndex(arg => arg === '-m' || arg === '--model');
    if (flag < 0 || flag + 1 >= args.length) throw new Error('This provider CLI cannot select a model.');
    args[flag + 1] = cliModel;
  }
  return args;
}

/** Load shipped defaults and shallow user overrides; merge model entries by key. */
function loadConfig(project = findProjectConfig()) {
  const paths = getPaths();
  const load = name => {
    // Installed copies keep shipped values in defaults/, so new models reach users who edited their config.
    const shipped = path.join(__dirname, '..', 'defaults', name + '.json');
    const base = object(readJson(fs.existsSync(shipped) ? shipped : path.join(paths.defaultConfigDir, name + '.json'), {}));
    const user = object(readJson(path.join(paths.quotaBossHome, 'config', name + '.json'), {}));
    const merged = { ...base, ...user };
    if (name === 'models') merged.models = { ...object(base.models), ...object(user.models) };
    return merged;
  };
  const models = load('models');
  const globalUse = readUse(), projectUse = normalizeUse(project?.use);
  const off = new Set([...globalUse.modelsOff, ...projectUse.modelsOff]);
  // route treats the resolved boss as self, never as a delegate. Keep that identity available.
  const boss = off.size ? delegationBoss(models, project) : null;
  for (const id of off) if (id !== boss && Object.hasOwn(models.models, id) && models.models[id]) {
    models.models[id] = { ...models.models[id], enabled: false };
  }
  return { models, thresholds: load('thresholds'), providers: loadProviders(project) };
}

const USE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function validUseModelId(id) { return typeof id === 'string' && USE_MODEL_ID.test(id); }
function useFile() { return path.join(getPaths().quotaBossHome, 'config', 'use.json'); }
function normalizeUse(value) {
  const use = object(value);
  const ids = (value, valid) => [...new Set((Array.isArray(value) ? value : []).filter(valid))];
  const only = ids(use.only, validProviderId);
  return { ...(only.length ? { only } : {}),
    providersOff: ids(use.providersOff, validProviderId), modelsOff: ids(use.modelsOff, validUseModelId) };
}
function readUse() { return normalizeUse(readJson(useFile(), {})); }
function delegationBoss(models, project) {
  const host = normalizeProject(project).host;
  const pool = host === 'claude-code' ? 'claude' : host === 'codex' ? 'codex' : null;
  return require('./route').bossModelId(currentBossModel(project), Object.entries(object(models.models))
    .filter(([, m]) => m && m.enabled !== false && Number.isFinite(m.cost) && m.cost >= 0 && (m.cliModel === undefined || validCliModel(m.cliModel)))
    .map(([id, model]) => ({ ...model, id })), pool);
}

function statuslineFile() { return path.join(getPaths().quotaBossHome, 'config', 'statusline.json'); }
/** Personal choice for the whole machine: keep the Claude and Codex numbers visible where boss mode is off. */
function showsWithoutBoss() { return object(readJson(statuslineFile(), {})).showWithoutBoss === true; }

/** Normalize project enums and worker switches before using them in context. */
function normalizeProject(value) {
  const config = object(value);
  const workers = object(config.workers);
  return { enabled: config.enabled === true,
    host: HOSTS.includes(config.host) ? config.host : 'claude-code',
    terse: config.terse === true,
    allowTrainingProviders: config.allowTrainingProviders === true,
    consensus: config.consensus !== false,
    contextSuggest: config.contextSuggest === false || Number.isInteger(config.contextSuggest) && config.contextSuggest >= CONTEXT_SUGGEST_MIN && config.contextSuggest <= CONTEXT_SUGGEST_MAX ? config.contextSuggest : CONTEXT_SUGGEST_DEFAULT,
    profile: PROFILES.includes(config.profile) ? config.profile : 'balanced',
    workers: Object.fromEntries(WORKERS.map(key => [key, workers[key] === undefined || workers[key] === true])),
    use: normalizeUse(config.use),
    caps: config.caps === undefined ? {} : validateCaps(config.caps) };
}

const MAX_PROJECT_BYTES = 1024 * 1024;
function projectKey(directory, platform = process.platform) {
  const real = fs.realpathSync(directory);
  return platform === 'win32' ? real.toLowerCase() : real;
}
function readProjects(file = getPaths().projectsFile) {
  let value;
  try { value = JSON.parse(readBounded(file, MAX_PROJECT_BYTES)); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  return requireObject(value, 'Project registry');
}
function updateProjects(update, file = getPaths().projectsFile, apply) {
  const result = withLock(file, verify => {
    const next = update(readProjects(file), verify);
    requireObject(next, 'Project registry');
    const text = JSON.stringify(next, null, 2) + '\n';
    if (Buffer.byteLength(text) > MAX_PROJECT_BYTES) throw new Error('Project registry exceeds 1 MiB.');
    verify();
    if (apply) apply(next, verify);
    atomicWrite(file, text, verify); return next;
  });
  if (result === null) throw new Error('Project registry is busy; retry.');
  return result;
}
function saveProject(directory, value) {
  const key = projectKey(directory);
  return updateProjects(entries => ({ ...entries, [key]: value }))[key];
}
/** Only the nearest registered real path supplies project policy. No checkout config reads. */
function findProjectConfig(cwd = process.cwd()) {
  const entries = readProjects();
  let directory = projectKey(typeof cwd === 'string' && cwd ? cwd : process.cwd());
  const initial = directory;
  while (true) {
    if (Object.hasOwn(entries, directory)) return { ...normalizeProject(entries[directory]), directory, file: getPaths().projectsFile, raw: entries[directory] };
    const parent = path.dirname(directory);
    if (parent === directory) return { ...normalizeProject(null), directory: initial, file: null, raw: {} };
    directory = parent;
  }
}
function ignoredProjectFiles(cwd = process.cwd()) {
  const found = [];
  let dir = path.resolve(cwd);
  while (true) {
    for (const name of ['quota-boss.json', 'harness.json']) {
      const file = path.join(dir, '.claude', name);
      try { fs.lstatSync(file); found.push(file); } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e; }
    }
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  return found;
}
/** Read persisted state, treating corrupt data as empty state. */
function readState() { return object(readJson(getPaths().stateFile, {})); }
function updateState(update) {
  const file = getPaths().stateFile;
  return withLock(file, verify => {
    const current = readState();
    const next = { ...current, ...object(update(current)) };
    verify(); atomicWrite(file, JSON.stringify(next, null, 2) + '\n', verify); return next;
  });
}
function writeState(patch) { return updateState(() => patch); }
/** Strip untrusted label characters and cap context labels at forty characters. */
function sanitizeLabel(label) { return typeof label === 'string' ? label.replace(/[^\w .\-()/]/g, '').slice(0, 40) : ''; }
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function percentage(value) { const n = number(value); return n === undefined ? undefined : Math.max(0, Math.min(100, n)); }
function windowData(value, percentKey, now, expire) {
  const source = object(value);
  const result = {};
  const used = percentage(source[percentKey]);
  const reset = number(source.resets_at);
  const minutes = number(source.window_minutes);
  if (used !== undefined) result[percentKey] = expire && reset !== undefined && reset <= now / 1000 ? 0 : used;
  if (reset !== undefined) result.resets_at = reset;
  if (minutes !== undefined && minutes >= 0) result.window_minutes = minutes;
  return result;
}

/** Merge present Claude fields while retaining previous window values. */
function updateClaudeLimits(previous, input, now = Date.now()) {
  const old = object(previous);
  const incoming = object(object(input).rate_limits);
  const result = {};
  for (const key of ['five_hour', 'seven_day']) {
    result[key] = { ...windowData(old[key], 'used_percentage', now, false),
      ...windowData(incoming[key], 'used_percentage', now, false) };
  }
  const observed = ['five_hour', 'seven_day'].some(key => percentage(incoming[key]?.used_percentage) !== undefined);
  result.updated_at = observed ? now : number(old.updated_at) ?? 0;
  return result;
}

function newestLogs(directory) {
  let visited = 0;
  const entries = dir => {
    const result = [];
    let handle;
    try {
      handle = fs.opendirSync(dir);
      let entry;
      while (visited < 5000 && (entry = handle.readSync())) { visited++; result.push(entry); }
    } catch {} finally { if (handle) handle.closeSync(); }
    return result.sort((a, b) => b.name.localeCompare(a.name));
  };
  const root = entries(directory);
  const newest = [];
  for (const year of root.filter(e => e.isDirectory() && /^\d{4}$/.test(e.name))) {
    for (const month of entries(path.join(directory, year.name)).filter(e => e.isDirectory() && /^(0[1-9]|1[0-2])$/.test(e.name))) {
      for (const day of entries(path.join(directory, year.name, month.name)).filter(e => e.isDirectory() && /^(0[1-9]|[12]\d|3[01])$/.test(e.name))) {
        const dir = path.join(directory, year.name, month.name, day.name);
        for (const file of entries(dir).filter(e => e.isFile() && e.name.endsWith('.jsonl'))) {
          newest.push({ file: path.join(dir, file.name) });
          if (newest.length === 10) return newest;
        }
      }
    }
  }
  if (newest.length) return newest;
  // Other layouts retain mtime ordering, with a hard enumeration ceiling.
  visited = root.length;
  const pending = [{ dir: directory, list: root }];
  while (pending.length) {
    const { dir, list } = pending.pop();
    for (const entry of list) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && visited < 5000) pending.push({ dir: file, list: entries(file) });
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          newest.push({ file, mtime: fs.statSync(file).mtimeMs });
          newest.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
          if (newest.length > 10) newest.pop();
        } catch {}
      }
    }
  }
  return newest;
}

function logTail(file, maxBytes = MAX_LOG_BYTES, metadata) {
  const fd = openRegular(file);
  try {
    const size = fs.fstatSync(fd).size;
    if (metadata) metadata.truncated = size > maxBytes;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, start + length);
      if (!count) break;
      length += count;
    }
    const text = buffer.toString('utf8', 0, length);
    return start ? text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}

/**
 * Read only the last 512 KiB of at most ten newest Codex session logs. Sessions run side by side,
 * so the newest entry can sit in a log that started earlier: the event time decides, not the log.
 * The modified time cannot rule a log out, because Windows does not update it while Codex writes.
 */
function readCodexLimits(now = Date.now(), thresholds = {}, readOnly = false) {
  let best = null;
  let bestTime = -Infinity;
  for (const { file } of newestLogs(path.join(getPaths().codexDir, 'sessions'))) {
    let lines;
    try { lines = logTail(file).split('\n'); } catch { continue; }
    for (let index = lines.length - 1; index >= 0; index--) {
      let event;
      try { event = JSON.parse(lines[index]); } catch { continue; }
      if (event?.payload?.type !== 'token_count' || !event.payload.rate_limits) continue;
      const limits = object(event.payload.rate_limits);
      // Codex logs several limit buckets (e.g. "codex" and "premium"); only the general "codex"
      // bucket with real windows describes the plan quota. Skip other or empty buckets.
      if (limits.limit_id !== undefined && limits.limit_id !== 'codex') continue;
      if (!object(limits.primary).used_percent && !object(limits.secondary).used_percent
        && typeof object(limits.primary).used_percent !== 'number' && typeof object(limits.secondary).used_percent !== 'number') continue;
      const timestamp = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
      const result = { primary: windowData(limits.primary, 'used_percent', now, true),
        secondary: windowData(limits.secondary, 'used_percent', now, true),
        observed_at: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null };
      // Entries without a usable time, or dated in the future, only count when nothing else exists.
      const time = Number.isFinite(timestamp) && timestamp <= now ? timestamp : -Infinity;
      if (!best || time > bestTime) { best = result; bestTime = time; }
      break;
    }
  }
  if (best && bestTime > -Infinity && !readOnly) {
    // History only sharpens the projection. A sandbox that forbids writing here (Codex) must still get the limits.
    try { updateState(state => ({ history: recordUsageHistory(state.history, 'codex', best, bestTime, thresholds) })); }
    catch (error) { if (!writeDenied(error)) throw error; }
  }
  return best;
}

/** Claude reports ids such as "claude-opus-5-5[1m]"; the registry knows the plain id. */
function cleanModelId(value) {
  if (typeof value !== 'string') return null;
  const id = value.split('[')[0];
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) ? id : null;
}

/** Worker runs (`codex exec`) and subagents write session logs too, but they are not the boss. */
function isInteractiveCodexLog(file) {
  const fd = openRegular(file);
  try {
    const buffer = Buffer.alloc(65536);
    const head = buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, buffer.length, 0)).split('\n')[0];
    return !/"originator"\s*:\s*"codex_exec"|"source"\s*:\s*(?:"exec"|\{)/.test(head);
  } finally { fs.closeSync(fd); }
}

function isInsideDirectory(directory, parent, platform = process.platform) {
  const normal = value => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const child = normal(directory), root = normal(parent);
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Model and effort from interactive Codex logs for this project, else top-level config. */
function readCodexBossContext(project) {
  const directory = getPaths().codexDir;
  let sessionEffort;
  for (const { file } of newestLogs(path.join(directory, 'sessions'))) {
    try {
      if (!isInteractiveCodexLog(file)) continue;
      const lines = logTail(file).split('\n');
      for (let index = lines.length - 1; index >= 0; index--) {
        if (!lines[index].includes('turn_context')) continue;
        let event;
        try { event = JSON.parse(lines[index]); } catch { continue; }
        if (event?.type !== 'turn_context') continue;
        // The last turn says where this session runs. Another project's session is not this boss.
        if (project && !(typeof event.payload?.cwd === 'string' && isInsideDirectory(event.payload.cwd, project))) break;
        // Effort belongs to the newest session's last turn even if its model id is unavailable.
        if (sessionEffort === undefined) sessionEffort = validBossEffort(event.payload?.effort);
        const id = cleanModelId(event.payload?.model);
        if (id) return { model: id, effort: sessionEffort };
      }
    } catch { /* An unreadable log says nothing about the boss. */ }
  }
  try {
    // Only the top of the file counts: later tables hold the models of other profiles and providers.
    const top = readBounded(path.join(directory, 'config.toml'), 1024 * 1024).split(/^\s*\[/m)[0];
    return { model: cleanModelId(top.match(/^\s*model\s*=\s*"([^"\r\n]+)"/m)?.[1]),
      effort: sessionEffort !== undefined ? sessionEffort : validBossEffort(top.match(/^\s*model_reasoning_effort\s*=\s*"([^"\r\n]+)"/m)?.[1]) };
  } catch { return { model: null, effort: sessionEffort ?? null }; }
}

function readCodexBossModel(project) { return readCodexBossContext(project).model; }

function validBossEffort(value) {
  const level = typeof value === 'string' ? value.toLowerCase() : null;
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(level) ? level : null;
}

/** Read the boss's session effort without exposing settings or failing routing. */
function currentBossEffort(project, state, bossModel) {
  try {
    if (process.env.QUOTA_BOSS_BOSS_EFFORT !== undefined) return validBossEffort(process.env.QUOTA_BOSS_BOSS_EFFORT);
    const { host } = normalizeProject(project);
    if (host === 'codex') return readCodexBossContext(project?.directory).effort;
    if (host !== 'claude-code') return null;
    if (process.env.CLAUDE_CODE_EFFORT_LEVEL !== undefined) return validBossEffort(process.env.CLAUDE_CODE_EFFORT_LEVEL);
    const settings = readJson(path.join(getPaths().claudeDir, 'settings.json'), {}, 1024 * 1024);
    return validBossEffort(settings?.modelSettings?.[bossModel]?.effortLevel ?? settings?.effortLevel);
  } catch { return null; }
}

/** Stable id for a project folder; never derived from text inside the project. */
function projectHash(directory) {
  try { return crypto.createHash('sha256').update(projectKey(directory || process.cwd())).digest('hex').slice(0, 24); }
  catch { return null; }
}
const BOSS_MODELS_KEPT = 20;
/** Remember the boss model per project, so sessions on other models in other projects do not change this one's table. */
function recordBossModel(current, directory, model, now = Date.now()) {
  const kept = Object.entries(current && typeof current === 'object' ? current : {})
    .filter(([, entry]) => entry && typeof entry.model === 'string' && Number.isFinite(entry.at));
  const key = projectHash(directory);
  if (!key || !model) return Object.fromEntries(kept);
  return Object.fromEntries([[key, { model, at: now }], ...kept.filter(([id]) => id !== key)]
    .sort((a, b) => b[1].at - a[1].at).slice(0, BOSS_MODELS_KEPT));
}
/** The model the boss runs on, or null when the host does not tell. */
function currentBossModel(project, state = readState()) {
  const { host } = normalizeProject(project);
  if (host === 'codex') return cleanModelId(process.env.QUOTA_BOSS_BOSS_MODEL) || readCodexBossModel(project?.directory);
  if (host !== 'claude-code') return null;
  const own = state.bossModels && typeof state.bossModels === 'object' ? state.bossModels[projectHash(project?.directory)] : null;
  return cleanModelId(own?.model) ?? cleanModelId(state.bossModel);
}

/** A boss mostly plans and reviews, so those two scores decide. */
function bossScore(model) {
  const score = key => Math.max(0, Math.min(10, Number.isFinite(model.scores?.[key]) ? model.scores[key] : 0));
  return 0.6 * score('architecture') + 0.4 * score('review');
}

/** Candidates need id, score and cost. Within half a point of the best, the cheapest boss wins. */
function pickBoss(candidates) {
  const top = Math.max(...candidates.map(c => c.score));
  return candidates.filter(c => c.score >= top - 0.5).sort((a, b) => a.cost - b.cost || b.score - a.score || a.id.localeCompare(b.id))[0] ?? null;
}

/** Read user-visible cache models for the models CLI only. */
function readCodexModels(includeHidden = false) {
  const cache = readJson(path.join(getPaths().codexDir, 'models_cache.json'), {});
  return Array.isArray(cache?.models) ? cache.models.filter(item => item && (includeHidden || item.visibility === 'list') && typeof item.slug === 'string') : [];
}

/** Extract validated percentages from normalized quota windows. */
function limitValues(limits = {}) {
  const claude = object(limits.claude);
  const codex = object(limits.codex);
  return { c5h: percentage(claude.five_hour?.used_percentage), cWeek: percentage(claude.seven_day?.used_percentage),
    x5h: percentage(codex.primary?.used_percent),
    xWeek: percentage(codex.secondary?.used_percent) };
}

/** Compute independent quota modes and the combined routing label. */
function computeModes(limits = {}, thresholds = {}, now = Date.now(), providers) {
  const context = providers ? providerContext(providers, limits) : null;
  if (context) limits = context.limits;
  const { c5h, cWeek, x5h, xWeek } = limitValues(limits, now);
  const threshold = (group, key, fallback) => number(thresholds[group]?.[key]) ?? fallback;
  const hit = (value, group, key, fallback) => value !== undefined && value >= threshold(group, key, fallback);
  const claudeMode = hit(c5h, 'claude', 'emergency', 85) || hit(cWeek, 'claudeWeekly', 'emergency', 95) ? 'emergency'
    : hit(c5h, 'claude', 'save', 60) || hit(cWeek, 'claudeWeekly', 'save', 80) ? 'save' : 'normal';
  const codexMode = hit(x5h, 'codex', 'exhausted', 95) || hit(xWeek, 'codexWeekly', 'exhausted', 97) ? 'exhausted'
    : hit(x5h, 'codex', 'tight', 80) || hit(xWeek, 'codexWeekly', 'tight', 85) ? 'tight' : 'normal';
  const parts = [];
  if (claudeMode !== 'normal') parts.push(claudeMode);
  if (codexMode !== 'normal') parts.push('codex-' + codexMode);
  if (context) for (const [id, usage] of Object.entries(context.usage)) if (usage.capped) parts.push('capped:' + id);
  const observed = Date.parse(limits.codex?.observed_at);
  const staleMinutes = number(thresholds.staleCodexMinutes) ?? 360;
  return { claudeMode, codexMode, mode: parts.join('+') || 'normal',
    codexUnknown: (!context || !!context.usage.codex) && (x5h === undefined || xWeek === undefined),
    codexStale: (!context || !!context.usage.codex) && Number.isFinite(observed) && now - observed > staleMinutes * 60000,
    // Codex only reports its limits while it runs, so the numbers age until the next Codex call.
    codexAge: Number.isFinite(observed) && now >= observed ? (now - observed < 48 * 3600000 ? Math.round((now - observed) / 3600000) + 'h' : Math.round((now - observed) / 86400000) + 'd') : '' };
}

/** Format a reset in local time, adding the weekday when more than a day away. */
function formatReset(epochSec, now = Date.now()) {
  if (number(epochSec) === undefined) return '';
  const date = new Date(epochSec * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  const time = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  return (date.getTime() - now > 86400000 ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()] + ' ' : '') + time;
}

/** Produce a safe one-line quota and routing summary for hooks. */
function formatLimits(limits, profile, thresholds, now = Date.now(), providers) {
  const value = limitValues(limits);
  const percent = n => n === undefined ? '?' : n + '%';
  const modes = computeModes(limits, thresholds, now, providers);
  let line = '[quota-boss] Claude 5h ' + percent(value.c5h) + ' wk ' + percent(value.cWeek)
    + ' | Codex 5h ' + percent(value.x5h) + ' wk ' + percent(value.xWeek)
    + ' | profile ' + (PROFILES.includes(profile) ? profile : 'balanced') + ' | mode ' + formatMode(modes.mode);
  if (modes.codexUnknown) line += ' | codex data unknown';
  if (modes.codexStale) line += ' | codex numbers ' + modes.codexAge + ' old (refresh on the next Codex run)';
  const extra = providers && formatProvidersCompact(providers, limits);
  if (extra) line += ' | ' + extra;
  return line;
}

/** Read stdin with a fixed byte cap, including pipes whose reported size is zero. */
function readStdin(maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - total));
    const count = fs.readSync(0, buffer, 0, buffer.length, null);
    if (!count) return Buffer.concat(chunks, total).toString('utf8');
    total += count;
    if (total > maxBytes) throw new Error('Input too large');
    chunks.push(buffer.subarray(0, count));
  }
  throw new Error('Input too large');
}

/** Read bounded stdin JSON; invalid input throws for the hook boundary to suppress. */
function readInput() { return JSON.parse(readStdin() || '{}'); }


/** Hard ceilings remain in force even when retention is tuned. */
function historySettings(thresholds = {}) {
  const source = object(thresholds.history);
  const bounded = (key, fallback, min, max) => Math.max(min, Math.min(max, number(source[key]) ?? fallback));
  return { maxSamples: Math.floor(bounded('maxSamples', 48, 1, 48)),
    minIntervalMinutes: bounded('minIntervalMinutes', 5, 5, 1440),
    paceMinutes: bounded('paceMinutes', 120, 5, 120),
    paceHorizonMinutes: bounded('paceHorizonMinutes', 300, 5, 1440),
    outcomeLines: Math.floor(bounded('outcomeLines', 2000, 1, 2000)),
    outcomeDays: bounded('outcomeDays', 90, 1, 90),
    unavailableHours: bounded('unavailableHours', 24, 24, 24) };
}

/** Pure history update. Repeated observations do not create artificial burn samples. */
function recordUsageHistory(history, pool, limits, now = 0, thresholds = {}) {
  const result = { ...object(history) };
  if (!['claude', 'codex'].includes(pool) || !Number.isFinite(now)) return result;
  const settings = historySettings(thresholds);
  const values = limitValues({ [pool]: limits });
  const u5 = pool === 'claude' ? values.c5h : values.x5h;
  const uw = pool === 'claude' ? values.cWeek : values.xWeek;
  const samples = (Array.isArray(result[pool]) ? result[pool] : [])
    .filter(s => s && Number.isFinite(s.t)
      && (percentage(s.u5) !== undefined || percentage(s.uw) !== undefined))
    .map(s => ({ t: s.t, u5: percentage(s.u5) ?? null, uw: percentage(s.uw) ?? null }))
    .sort((a, b) => a.t - b.t);
  const spaced = [];
  for (const sample of samples) {
    if (!spaced.length || sample.t - spaced[spaced.length - 1].t >= settings.minIntervalMinutes * 60000) spaced.push(sample);
  }
  if ((u5 !== undefined || uw !== undefined)
    && (!spaced.length || now - spaced[spaced.length - 1].t >= settings.minIntervalMinutes * 60000)) {
    spaced.push({ t: now, u5: u5 ?? null, uw: uw ?? null });
  }
  if (spaced.length) result[pool] = spaced.slice(-settings.maxSamples);
  return result;
}

function validOutcome(value) {
  return value && Number.isFinite(value.t) && typeof value.model === 'string' && value.model.length > 0
    && value.model.length <= 256 && CATEGORIES.includes(value.category) && TIERS.includes(value.tier)
    && RESULTS.includes(value.result);
}

/** Pure retention filter; count physical records before discarding invalid/old entries. */
function recentOutcomes(outcomes = [], now = 0, thresholds = {}) {
  const settings = historySettings(thresholds);
  return (Array.isArray(outcomes) ? outcomes : []).slice(-settings.outcomeLines)
    .filter(value => validOutcome(value) && value.t <= now && value.t >= now - settings.outcomeDays * 86400000);
}

/** Tail reads are byte bounded as well as line and age bounded. Oversized lines are ignored. */
function readOutcomes(now = Date.now(), thresholds = {}) {
  let text;
  try { text = logTail(getPaths().outcomesFile, 2 * 1024 * 1024); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const values = lines.slice(-historySettings(thresholds).outcomeLines).map(line => {
    try { return line.length <= 1024 ? JSON.parse(line) : null; } catch { return null; }
  });
  return recentOutcomes(values, now, thresholds);
}

/** Feedback is an append-only journal; each validated record is one O_APPEND write. */
function appendOutcome(value, models, cache = [], now = Date.now()) {
  const entry = { t: now, model: value?.model, category: value?.category, tier: value?.tier, result: value?.result };
  if (!validOutcome(entry)) throw new Error('Feedback requires a model, valid category, tier, and pass|fail|unavailable|limited.');
  if (!Object.hasOwn(object(models?.models), entry.model) && !cache.some(m => m?.slug === entry.model)) {
    const word = String(entry.model).toLowerCase().replace(/[^a-z0-9]+/g, '');
    const near = word.length >= 3 ? Object.keys(object(models?.models)).filter(id => id.replace(/[^a-z0-9]/gi, '').toLowerCase().includes(word)).sort().slice(0, 3) : [];
    throw new Error('Feedback model must exist in the registry or Codex cache.' + (near.length ? ' Did you mean ' + near.join(' or ') + '?' : ' Run quota-boss models for the ids.'));
  }
  if (value.effort !== undefined) {
    if (!EFFORT_ORDER.includes(value.effort)) throw new Error('Feedback effort is invalid.');
    entry.effort = value.effort;
  }
  const file = getPaths().outcomesFile;
  appendRegular(file, JSON.stringify(entry) + '\n');
  return entry;
}

function unavailableModels(outcomes = [], now = 0, thresholds = {}) {
  return new Set(recentOutcomes(outcomes, now, thresholds)
    .filter(o => o.result === 'unavailable' && now - o.t < 24 * 3600000).map(o => o.model));
}

/** A rate limit passes quickly, so the model only sits out a short while instead of a whole day. */
function rateLimitedModels(outcomes = [], now = 0, thresholds = {}) {
  return new Set(recentOutcomes(outcomes, now, thresholds)
    .filter(o => o.result === 'limited' && now - o.t < RATE_LIMIT_MINUTES * 60000).map(o => o.model));
}


const PROVIDER_ID = /^[a-z][a-z0-9-]{1,31}$/;
const QUOTA_WINDOWS = { fiveHour: 300, daily: 1440, weekly: 10080, monthly: 44640 };
const USAGE_UNITS = ['calls', 'tokens', 'usd'];
// Installed defaults stay separate from the editable user config, including across CLI invocations.
const BUILTIN_PROVIDERS = readProviderConfig(fs.existsSync(path.join(__dirname, '..', 'defaults', 'providers.json'))
  ? path.join(__dirname, '..', 'defaults', 'providers.json') : path.join(__dirname, '..', 'config', 'providers.json'));
function validProviderId(id) { return typeof id === 'string' && PROVIDER_ID.test(id); }
function requireObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + ' must be an object.');
  return value;
}
function validateCaps(value) {
  requireObject(value, 'caps');
  for (const [id, windows] of Object.entries(value)) {
    if (!validProviderId(id)) throw new Error('Invalid provider id in caps.');
    requireObject(windows, 'cap windows');
    for (const [window, cap] of Object.entries(windows)) {
      if (!Object.hasOwn(QUOTA_WINDOWS, window) || cap !== null && (number(cap) === undefined || cap < 1 || cap > 100)) {
        throw new Error('Cap requires a valid window and 1-100 percent (or null for off).');
      }
    }
  }
  return value;
}
/** Validate all entries, including disabled examples, before trusting any provider fields. */
function validateProviders(config) {
  requireObject(config, 'Provider config');
  requireObject(config.providers, 'providers');
  validateCaps(config.caps === undefined ? {} : config.caps);
  for (const [id, p] of Object.entries(config.providers)) {
    if (!validProviderId(id)) throw new Error('Invalid provider id.');
    requireObject(p, 'Provider');
    if (!['subscription', 'api', 'manual', 'free', 'local'].includes(p.kind)) throw new Error('Invalid provider kind: ' + id);
    if (typeof p.label !== 'string' || !sanitizeLabel(p.label)) throw new Error('Provider label required: ' + id);
    if (p.evidence !== undefined && !['docs', 'real'].includes(p.evidence)) throw new Error('Invalid provider evidence: ' + id);
    if (p.tos !== undefined && !['official-cli', 'api', 'avoid'].includes(p.tos)) throw new Error('Invalid provider tos: ' + id);
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new Error('Provider enabled must be boolean: ' + id);
    if (p.trainsOnData !== undefined && typeof p.trainsOnData !== 'boolean') throw new Error('Provider trainsOnData must be boolean: ' + id);
    requireObject(p.quota, 'Provider quota');
    const source = p.quota.source;
    if (!['claude-statusline', 'codex-logs', 'counter', 'none'].includes(source)
      || source === 'claude-statusline' && id !== 'claude' || source === 'codex-logs' && id !== 'codex'
      || id === 'claude' && !['claude-statusline', 'counter'].includes(source) || id === 'codex' && source !== 'codex-logs') {
      throw new Error('Invalid provider quota source: ' + id);
    }
    if (p.worker !== undefined && !['codex-worker', 'claude-worker', 'researcher', 'cli-worker'].includes(p.worker)) throw new Error('Invalid provider worker: ' + id);
    if (id !== 'claude' && !p.worker) throw new Error('Provider worker required: ' + id);
    if (p.quota.windows !== undefined) {
      requireObject(p.quota.windows, 'Quota windows');
      if (source !== 'counter') throw new Error('Only counters accept quota windows.');
    }
    if (source === 'counter') {
      const windows = requireObject(p.quota.windows, 'Counter windows');
      if (!Object.keys(windows).length) throw new Error('Counter windows required.');
      for (const [window, budget] of Object.entries(windows)) {
        requireObject(budget, 'Counter budget');
        if (!Object.hasOwn(QUOTA_WINDOWS, window) || number(budget.budget) === undefined || budget.budget <= 0
          || budget.budget > 1e9 || !USAGE_UNITS.includes(budget.unit)) throw new Error('Invalid counter window, budget or unit.');
      }
    }
    if (p.cli !== undefined) {
      requireObject(p.cli, 'CLI template');
      if (p.worker !== 'cli-worker' || typeof p.cli.command !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(p.cli.command)
        || p.cli.defaultModel !== undefined && !validCliModel(p.cli.defaultModel)
        || p.cli.defaultEffort !== undefined && !CLI_EFFORTS.includes(p.cli.defaultEffort)
        || !Array.isArray(p.cli.args) || p.cli.args.length > 100
        || p.cli.args.some(a => typeof a !== 'string' || a.length > 4096 || /[\x00-\x1f\x7f]/.test(a))
        || !p.cli.args.some(a => a.includes('{prompt}'))) throw new Error('Invalid CLI argument template.');
    }
  }
  for (const id of Object.keys(config.caps ?? {})) {
    if (!Object.hasOwn(config.providers, id)) throw new Error('Unknown provider in caps: ' + id);
  }
  return config;
}
function mergeCaps(base, override) {
  validateCaps(base); validateCaps(override);
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(override)])]
    .map(id => [id, { ...object(base[id]), ...object(override[id]) }]));
}
/** Project reservations can only tighten global reservations, including null/off. */
function tightenCaps(global, project) {
  const merged = mergeCaps(global, project);
  for (const [id, windows] of Object.entries(merged)) for (const window of Object.keys(windows)) {
    const value = Math.min(global[id]?.[window] ?? 100, project[id]?.[window] ?? 100);
    windows[window] = value === 100 ? (global[id]?.[window] === 100 || project[id]?.[window] === 100 ? 100 : null) : value;
  }
  return merged;
}
/** Provider entries merge by id, preserving defaults for enable/disable overrides. */
function mergeProviders(base, override = {}, project = {}) {
  requireObject(override, 'Provider override');
  if (override.providers !== undefined) requireObject(override.providers, 'providers');
  if (override.caps !== undefined) validateCaps(override.caps);
  if (project.caps !== undefined) validateCaps(project.caps);
  const providers = structuredClone(base.providers);
  for (const [id, value] of Object.entries(override.providers ?? {})) {
    requireObject(value, 'Provider override');
    providers[id] = { ...object(providers[id]), ...value };
  }
  const caps = tightenCaps(mergeCaps(base.caps ?? {}, override.caps ?? {}), project.caps ?? {});
  for (const p of Object.values(providers)) {
    if (p.trainsOnData === undefined) p.trainsOnData = false;
    if (p.tos === undefined) p.tos = p.kind === 'api' ? 'api' : 'official-cli';
  }
  return validateProviders({ providers, caps });
}
function readProviderConfig(file) {
  try { return requireObject(JSON.parse(readBounded(file, 1024 * 1024)), 'Provider config'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function loadProviders(project = {}) {
  const paths = getPaths();
  const config = mergeProviders(BUILTIN_PROVIDERS,
    readProviderConfig(path.join(paths.quotaBossHome, 'config', 'providers.json')), project);
  const globalUse = readUse(), projectUse = normalizeUse(project.use);
  for (const [id, provider] of Object.entries(config.providers)) {
    if (globalUse.only && !globalUse.only.includes(id) || projectUse.providersOff.includes(id)
      || projectUse.only && !projectUse.only.includes(id)) provider.enabled = false;
  }
  if (project.host === 'codex' && config.providers.claude?.quota.source === 'claude-statusline') {
    const claude = readState().claude;
    const updated = claude?.updated_at;
    const known = percentage(claude?.five_hour?.used_percentage) !== undefined || percentage(claude?.seven_day?.used_percentage) !== undefined;
    if (!known || !Number.isFinite(updated) || updated > Date.now() || Date.now() - updated >= 1800000) {
      config.providers.claude = { ...config.providers.claude, quota: { source: 'counter', windows: { daily: { budget: 200, unit: 'calls' } } } };
    }
  }
  return config;
}
/** UTC fixed windows: epoch-aligned 5h, calendar days/months, Monday-start weeks. */
function counterWindow(window, now) {
  if (!Object.hasOwn(QUOTA_WINDOWS, window) || !Number.isFinite(now)) throw new Error('Invalid counter window or time.');
  const date = new Date(now);
  let start, end;
  if (window === 'monthly') {
    start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  } else {
    const length = QUOTA_WINDOWS[window] * 60000;
    const offset = window === 'weekly' ? 4 * 86400000 : 0;
    start = Math.floor((now - offset) / length) * length + offset;
    end = start + length;
  }
  return { start, end, minutes: (end - start) / 60000 };
}
function validUsage(entry) {
  return entry && number(entry.t) !== undefined && entry.t >= 0 && validProviderId(entry.provider)
    && number(entry.amount) !== undefined && entry.amount > 0 && entry.amount <= 1e9 && USAGE_UNITS.includes(entry.unit);
}
const USAGE_COMPACT_BYTES = 256 * 1024;
const MAX_USAGE_BYTES = 64 * 1024 * 1024;
/** Scan in bounded chunks and lines; never substitute invented usage for real records. */
function scanUsage(file, now) {
  let fd;
  try { fd = openRegular(file); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  try {
    if (fs.fstatSync(fd).size > MAX_USAGE_BYTES) throw new Error('Usage journal exceeds 64 MiB; archive expired usage.');
    const buffer = Buffer.alloc(65536), entries = [];
    let pending = '', oversized = false, total = 0, n;
    const accept = line => { try { const e = JSON.parse(line); if (validUsage(e)) entries.push(e); } catch {} };
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      if ((total += n) > MAX_USAGE_BYTES) throw new Error('Usage journal exceeds 64 MiB.');
      for (const part of buffer.toString('utf8', 0, n).split(/(?<=\n)/)) {
        if (!oversized) pending += part;
        if (pending.length > 1024) { oversized = true; pending = ''; }
        if (part.endsWith('\n')) { if (!oversized) accept(pending); pending = ''; oversized = false; }
      }
    }
    if (pending && !oversized) accept(pending);
    return entries;
  } finally { fs.closeSync(fd); }
}
function compactUsage(file, now, verify) {
  const entries = scanUsage(file, now);
  // Retain every record in any supported active window (including Claude's fallback),
  // and future records so a later observation cannot lose them.
  const start = Math.min(...Object.keys(QUOTA_WINDOWS).map(w => counterWindow(w, now).start));
  const retained = entries.filter(e => e.t >= start);
  atomicWrite(file, retained.map(e => JSON.stringify(e) + '\n').join(''), verify);
  return retained;
}
function readUsage(now = Date.now(), readOnly = false) {
  const file = getPaths().usageFile;
  let stat;
  try { stat = regularStat(file); } catch (e) { if (e.code === 'ENOENT') return { entries: [], truncated: false }; throw e; }
  let entries;
  if (stat.size > USAGE_COMPACT_BYTES && !readOnly) {
    try { entries = withLock(file, verify => compactUsage(file, now, verify)); }
    catch (error) { if (!writeDenied(error)) throw error; entries = scanUsage(file, now); }
    if (entries === null) throw new Error('Usage journal is busy; retry.');
  } else entries = scanUsage(file, now);
  return { entries: entries.filter(e => e.t <= now), truncated: false };
}
function appendUsage(id, amount, unit, config, now = Date.now()) {
  validateProviders(config);
  const entry = { t: now, provider: id, amount, unit };
  const provider = Object.hasOwn(config.providers, id) ? config.providers[id] : null;
  if (!validUsage(entry) || !provider || provider.enabled === false || !(id === 'claude' && unit === 'calls') && (provider.quota.source !== 'counter'
    || !Object.values(provider.quota.windows).some(w => w.unit === unit))) {
    throw new Error('Usage requires an enabled counter provider, amount 0 < x <= 1e9 and a configured calls|tokens|usd unit.');
  }
  const file = getPaths().usageFile;
  const saved = withLock(file, verify => {
    verify(); appendRegular(file, JSON.stringify(entry) + '\n');
    if (regularStat(file).size > USAGE_COMPACT_BYTES) compactUsage(file, now, verify);
    return true;
  });
  if (saved === null) throw new Error('Usage journal is busy; retry.');
  return entry;
}
/** Preserve the exact live sources while adding enabled counters. No network or CLI execution. */
function readProviderLimits(config, live = {}, now = Date.now(), readOnly = false) {
  validateProviders(config);
  const limits = {};
  const counters = Object.entries(config.providers).filter(([, p]) => p.enabled !== false && p.quota.source === 'counter');
  const usage = counters.length ? readUsage(now, readOnly) : { entries: [], truncated: false };
  for (const [id, p] of Object.entries(config.providers)) {
    if (p.enabled === false) continue;
    if (p.quota.source === 'claude-statusline' || p.quota.source === 'codex-logs') limits[id] = live[id];
    else if (p.quota.source === 'counter') {
      const windows = {};
      for (const [name, budget] of Object.entries(p.quota.windows)) {
        const w = counterWindow(name, now);
        const counted = usage.entries.filter(e => e.provider === id && e.unit === budget.unit && e.t >= w.start)
          .reduce((sum, e) => sum + e.amount, 0);
        const percent = Math.min(Number.MAX_VALUE, counted / budget.budget * 100);
        const used = percent;
        windows[name] = { used_percent: used, counted, resets_at: w.end / 1000, window_minutes: w.minutes };
      }
      limits[id] = { windows };
    }
  }
  return limits;
}
function providerWindows(id, limits) {
  if (limits[id]?.windows) return object(limits[id].windows);
  if (id === 'claude') return { fiveHour: { ...object(limits[id]?.five_hour), used_percent: limits[id]?.five_hour?.used_percentage },
    weekly: { ...object(limits[id]?.seven_day), used_percent: limits[id]?.seven_day?.used_percentage } };
  if (id === 'codex') return { fiveHour: object(limits[id]?.primary), weekly: object(limits[id]?.secondary) };
  return object(limits[id]?.windows);
}
/** Pure cap rescaling shared by modes, pricing and displays. Never clamp effective usage to 100. */
function providerContext(config = BUILTIN_PROVIDERS, limits = {}, history = {}) {
  validateProviders(config);
  const effective = {}, scaledHistory = {}, usage = {};
  for (const [id, provider] of Object.entries(config.providers)) {
    if (provider.enabled === false) continue;
    const windows = provider.quota.source === 'none' ? {} : providerWindows(id, limits);
    const scaled = {};
    let capped = false;
    for (const [name, window] of Object.entries(windows)) {
      if (!Object.hasOwn(QUOTA_WINDOWS, name)) continue;
      const data = object(window);
      const raw = number(data.used_percent);
      const used = raw === undefined ? undefined : Math.max(0, raw);
      const cap = config.caps?.[id]?.[name] ?? null;
      const value = used === undefined ? undefined : Math.min(Number.MAX_VALUE, used / (cap ?? 100) * 100);
      if (value !== undefined && value >= 100) capped = true;
      scaled[name] = { ...data, used_percent: value };
    }
    usage[id] = { provider, windows, effective: scaled, caps: config.caps?.[id] ?? {}, capped };
    if (id === 'claude') effective[id] = { five_hour: { ...(scaled.fiveHour || scaled.daily), used_percentage: (scaled.fiveHour || scaled.daily)?.used_percent },
      seven_day: { ...scaled.weekly, used_percentage: scaled.weekly?.used_percent } };
    else if (id === 'codex') effective[id] = { ...object(limits[id]), primary: scaled.fiveHour, secondary: scaled.weekly };
    else effective[id] = { windows: scaled };
    scaledHistory[id] = (Array.isArray(history[id]) ? history[id] : []).map(s => ({ ...s,
      u5: number(s?.u5) === undefined ? null : s.u5 * 100 / (config.caps?.[id]?.fiveHour ?? 100),
      uw: number(s?.uw) === undefined ? null : s.uw * 100 / (config.caps?.[id]?.weekly ?? 100) }));
  }
  return { limits: effective, history: scaledHistory, usage };
}
// Disabled providers are the normal state of optional offers (`providers` lists them), so only unknown pools warn.
function providerWarnings(models, config) {
  return [...new Set(Object.values(object(models.models)).map(m => m?.pool))]
    .filter(id => !Object.hasOwn(config.providers, id))
    .map(id => 'Warning: ignored models of unknown provider ' + (validProviderId(id) ? id : '(invalid id)'));
}
// Free offers cost the user nothing and routing already skips them when spent, so their percentages would only add noise.
function formatProvidersCompact(config, limits) {
  const { usage } = providerContext(config, limits);
  const parts = Object.entries(usage).filter(([, u]) => u.provider.kind !== 'free' && (u.capped || u.provider.quota.source === 'counter'
    || Object.values(u.caps).some(cap => cap !== null))).map(([id, u]) => {
    const values = Object.values(u.effective).map(w => number(w.used_percent)).filter(n => n !== undefined);
    return id + (u.capped ? ':capped' : ':' + (values.length ? Math.round(Math.max(...values)) + '%' : '?'));
  });
  // Keep prompt context bounded even with a large user registry.
  return parts.slice(0, 4).join(' ') + (parts.length > 4 ? ' +' + (parts.length - 4) : '');
}

function formatMode(mode) {
  const parts = mode.split('+');
  return parts.slice(0, 4).join('+') + (parts.length > 4 ? '+(' + (parts.length - 4) + ' more)' : '');
}

/** File-only discovery by default. Only doctor supplies registered MCP server names. */
function detectCodeIntel(projectDir, registeredServers = []) {
  const present = parts => { try { return fs.statSync(path.join(projectDir, ...parts)).isFile(); } catch { return false; } };
  const names = new Set(Array.isArray(registeredServers) ? registeredServers : []);
  return { graphify: present(['graphify-out', 'graph.json']) || present(['graphify-out', 'GRAPH_REPORT.md']) || present(['GRAPH_REPORT.md']),
    'codebase-memory': names.has('codebase-memory') || names.has('codebase-memory-mcp'),
    serena: names.has('serena'), gitnexus: names.has('gitnexus') };
}

function absoluteExecutablePath(value, platform) {
  if (typeof value !== 'string') return false;
  if (platform !== 'win32') return path.posix.isAbsolute(value);
  const root = path.win32.parse(value).root;
  return /^[a-z]:[\\/]/i.test(root) || root.startsWith('\\\\') && root.split(/[\\/]/).filter(Boolean).length >= 2;
}
/** PATH entries that are absolute and are neither cwd nor an alias of cwd. */
function trustedPathEntries(env, platform, cwd) {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path');
  const canonical = value => { try { const real = fs.realpathSync(value); return platform === 'win32' ? real.toLowerCase() : real; } catch { return null; } };
  const current = canonical(cwd);
  const entries = (env[key] || '').split(platform === 'win32' ? ';' : ':').filter(item => {
    const dir = item.replace(/^"|"$/g, '');
    return absoluteExecutablePath(dir, platform) && (current === null || canonical(dir) !== current);
  });
  return { key, entries };
}
/** Resolve only absolute PATH directories, excluding cwd and aliases of cwd. */
function findExecutable(name, env = process.env, platform = process.platform, cwd = process.cwd()) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return null;
  const p = platform === 'win32' ? path.win32 : path.posix;
  for (const item of trustedPathEntries(env, platform, cwd).entries) {
    const dir = item.replace(/^"|"$/g, '');
    const extensions = platform === 'win32' ? (/\.(exe|cmd|ps1)$/i.test(name) ? [''] : ['.exe', '.cmd', '.ps1']) : [''];
    for (const ext of extensions) {
      const file = p.join(dir, name + ext);
      try {
        regularStat(file);
        fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return fs.realpathSync(file);
      } catch {}
    }
  }
  return null;
}
function systemCmd(env = process.env) {
  // An inherited SystemRoot must not be able to select another cmd.exe.
  const root = env.SystemRoot || env.SYSTEMROOT || '';
  const file = path.win32.join(/^[a-z]:\\windows$/i.test(root) ? root : 'C:\\Windows', 'System32', 'cmd.exe');
  if (!absoluteExecutablePath(file, 'win32') || /[%!^&|<>"\r\n]/.test(file)) throw new Error('Unsafe cmd.exe path.');
  return file;
}
function executableInvocation(executable, args, platform = process.platform, env = process.env) {
  if (!absoluteExecutablePath(executable, platform) || !Array.isArray(args) || args.some(a => typeof a !== 'string' || /[\x00-\x1f\x7f]/.test(a))) throw new Error('An absolute executable and validated arguments are required.');
  if (platform === 'win32' && /\.cmd$/i.test(executable)) {
    const values = [executable, ...args];
    if (values.some(a => /[\x00-\x1f\x7f"%!^&|<>]/.test(a))) throw new Error('Unsafe Windows shim argument.');
    return { file: systemCmd(env), args: ['/d', '/s', '/c', '"' + values.map(a => '"' + a + '"').join(' ') + '"'], windowsVerbatimArguments: true };
  }
  if (platform === 'win32' && /\.ps1$/i.test(executable)) {
    return { file: path.win32.join(path.win32.dirname(systemCmd(env)), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-NonInteractive', '-File', executable, ...args], windowsVerbatimArguments: false };
  }
  if (platform === 'win32' && !/\.exe$/i.test(executable)) throw new Error('Expected an .exe or .cmd executable.');
  return { file: executable, args, windowsVerbatimArguments: false };
}
/** Default child working directory excludes the checkout; self-tests supply a fresh workspace. */
function childProcessOptions(env = process.env, platform = process.platform) {
  const home = path.resolve(env.QUOTA_BOSS_HOME || env.HARNESS_HOME || os.homedir());
  // Home can be absent during doctor before installation; use the trusted user home.
  let cwd = os.homedir();
  try { checkParents(path.join(home, '.child')); if (fs.lstatSync(home).isDirectory()) cwd = home; } catch {}
  const childEnv = { ...env };
  // A shim that looks up node on PATH must not find one in the checkout the lookup already rejected.
  const trusted = trustedPathEntries(env, platform, process.cwd());
  if (trusted.key) childEnv[trusted.key] = trusted.entries.join(platform === 'win32' ? ';' : ':');
  if (platform === 'win32') {
    for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete childEnv[key];
    childEnv.NoDefaultCurrentDirectoryInExePath = '1';
  }
  return { cwd, env: childEnv };
}
function runExecutable(executable, args, options = {}) {
  if (!executable) return { status: null, error: new Error('Executable unavailable on trusted PATH.') };
  const { platform = process.platform, env = process.env, spawnSync = require('node:child_process').spawnSync, workingDirectory, ...spawnOptions } = options;
  try {
    const invocation = executableInvocation(executable, args, platform, env);
    return spawnSync(invocation.file, invocation.args, { ...spawnOptions, ...childProcessOptions(env, platform), ...(workingDirectory ? { cwd: workingDirectory } : {}), shell: false, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
  } catch (error) { return { status: null, error }; }
}
function trustedHomeText(home = getPaths().quotaBossHome) {
  const value = path.resolve(home).replace(/\\/g, '/');
  if (/[\x00-\x1f\x7f"$%!^&|<>]/.test(value) || value.includes(String.fromCharCode(96))) throw new Error('Unsafe installation path for rules.');
  return value;
}
function substituteHome(text, home) {
  return text.split('{{QUOTA_BOSS_HOME}}').join(trustedHomeText(home)).split('{{HARNESS_HOME}}').join(trustedHomeText(home));
}

/** Windows only: runs a program in its own console window and waits until that window closes. */
function runInNewWindow(executable, args, options = {}) {
  const { env = process.env, spawnSync = require('node:child_process').spawnSync } = options;
  try {
    const values = [executable, ...args];
    if (!absoluteExecutablePath(executable, 'win32') || values.some(a => typeof a !== 'string' || /[\x00-\x1f\x7f"%!^&|<>]/.test(a))) throw new Error('Unsafe window launch.');
    const quoted = values.map(a => '"' + a + '"').join(' ');
    // `start` would leave a batch file's window open at a prompt, so a .cmd shim runs through its own cmd /c.
    const program = /\.cmd$/i.test(executable) ? '"' + systemCmd(env) + '" /d /c "' + quoted + '"' : quoted;
    return spawnSync(systemCmd(env), ['/d', '/s', '/c', '"start "Quota Boss login" /wait ' + program + '"'],
      { ...childProcessOptions(env, 'win32'), shell: false, windowsVerbatimArguments: true, stdio: 'ignore' });
  } catch (error) { return { status: null, error }; }
}

/** Read one line from the terminal; any read problem counts as an empty answer. */
function askLine(question) {
  process.stdout.write(question);
  const buffer = Buffer.alloc(512);
  try { return buffer.toString('utf8', 0, fs.readSync(0, buffer, 0, buffer.length, null)).trim(); } catch { return ''; }
}

module.exports = { systemLink, normalizeUse, readUse, useFile, validUseModelId, delegationBoss, revisionFingerprint, verifyCommand, shellCommand, projectHash, recordBossModel, EFFORT_ORDER, CONTEXT_SUGGEST_MIN, CONTEXT_SUGGEST_MAX, askLine, runInNewWindow, childProcessOptions, findExecutable, executableInvocation, runExecutable, systemCmd, trustedHomeText, substituteHome, checkParents, regularStat, openRegular, appendRegular, withLock, projectKey, readProjects, updateProjects, saveProject, ignoredProjectFiles, MAX_PROJECT_BYTES, tightenCaps, detectCodeIntel, HOSTS, newestLogs, updateState, BUILTIN_PROVIDERS, PROVIDER_ID, QUOTA_WINDOWS, USAGE_UNITS, validProviderId, validCliModel, cliArgsForModel, validateCaps, validateProviders, mergeProviders, mergeCaps, readProviderConfig, loadProviders, counterWindow, validUsage, readUsage, appendUsage, readProviderLimits, providerWindows, providerContext, providerWarnings, formatProvidersCompact, TIERS, RESULTS, historySettings, recordUsageHistory, validOutcome, recentOutcomes, readOutcomes, appendOutcome, unavailableModels, rateLimitedModels, CATEGORIES, PROFILES, WORKERS, MAX_LOG_BYTES, getPaths, readJson, readBounded,
  atomicWrite, writeJson, loadConfig, statuslineFile, showsWithoutBoss, normalizeProject, findProjectConfig, readState, writeState, logTail,
  sanitizeLabel, updateClaudeLimits, readCodexLimits, readCodexModels, readCodexBossModel, currentBossModel, currentBossEffort, cleanModelId, bossScore, pickBoss, limitValues,
  computeModes, formatMode, formatReset, formatLimits, readStdin, readInput };

/** Read-only revision evidence; Git never refreshes the index or writes objects. */
function revisionFingerprint(directory = process.cwd()) {
  const executable = findExecutable('git', process.env, process.platform, directory);
  const git = (args, cwd = directory, optional = false) => {
    const result = runExecutable(executable, ['--no-optional-locks', ...args], {
      workingDirectory: cwd, encoding: null, timeout: 30000, maxBuffer: 64 * 1024 * 1024
    });
    if (result.error || result.status !== 0) {
      if (optional && !result.error && result.status === 1) return null;
      throw new Error('Git fingerprint unavailable.');
    }
    return result.stdout;
  };
  const top = git(['rev-parse', '--show-toplevel']).toString('utf8').trimEnd();
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], top, true);
  const hash = crypto.createHash('sha256');
  const part = value => { const bytes = Buffer.from(value); hash.update(String(bytes.length) + ':'); hash.update(bytes); };
  part(head || 'NO_COMMIT');
  if (head) part(git(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv'], top));
  else {
    part(git(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'], top));
    part(git(['diff', '--binary', '--no-ext-diff', '--no-textconv'], top));
  }
  const files = git(['ls-files', '--others', '--exclude-standard', '-z'], top).toString('utf8').split('\0').filter(Boolean).sort();
  for (const file of files) {
    part(file);
    const absolute = path.join(top, file);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) part(fs.readlinkSync(absolute));
    else if (stat.isFile()) part(fs.readFileSync(absolute));
    else throw new Error('Untracked file cannot be fingerprinted.');
  }
  return { top, fingerprint: hash.digest('hex') };
}
function verificationEntries(file, now = Date.now()) {
  const entries = readJson(file, []);
  return (Array.isArray(entries) ? entries : []).filter(e => e && /^[a-f0-9]{64}$/.test(e.key)
    && typeof e.passedAt === 'string' && Number.isFinite(Date.parse(e.passedAt))
    && now - Date.parse(e.passedAt) >= 0 && now - Date.parse(e.passedAt) < 6 * 60 * 60 * 1000)
    .sort((a, b) => Date.parse(b.passedAt) - Date.parse(a.passedAt)).slice(0, 50);
}
function saveVerification(file, key, passed) {
  const saved = withLock(file, verify => {
    const entries = verificationEntries(file).filter(e => e.key !== key);
    if (passed) entries.unshift({ key, passedAt: new Date().toISOString() });
    atomicWrite(file, JSON.stringify(entries.slice(0, 50)) + '\n', verify);
    return true;
  });
  if (!saved) throw new Error('Verification evidence is busy.');
}
/** One argument is a shell command as written; several keep their boundaries, because the caller's shell already split them. */
function shellCommand(args, platform = process.platform) {
  if (args.length === 1) return args[0];
  const plain = /^[A-Za-z0-9_+=.,:/@-]+$/;
  const quote = platform === 'win32' ? a => '"' + a.replace(/"/g, '\\"') + '"' : a => "'" + a.replace(/'/g, "'\\''") + "'";
  return args.map(a => a !== '' && plain.test(a) ? a : quote(a)).join(' ');
}
async function verifyCommand(args) {
  const fresh = args[0] === '--fresh';
  const rest = fresh ? args.slice(1) : args;
  if (rest[0] !== '--' || !rest.slice(1).join(' ').trim()) throw new Error('Usage: quota-boss verify [--fresh] -- <command...>');
  const command = shellCommand(rest.slice(1));
  const file = path.join(getPaths().quotaBossHome, 'verification.json');
  let before, key, warned = false;
  const notice = message => { if (!warned) { process.stderr.write('[quota-boss] ' + message + '\n'); warned = true; } };
  try {
    before = revisionFingerprint();
    key = crypto.createHash('sha256').update(JSON.stringify([before.top, path.relative(before.top, fs.realpathSync(process.cwd())), command, before.fingerprint])).digest('hex');
    const entry = verificationEntries(file).find(e => e.key === key);
    if (!fresh && entry) {
      process.stdout.write('[quota-boss] Reused: "' + command + '" passed at ' + entry.passedAt + ' on this revision; not run again.\n');
      return 0;
    }
  } catch { notice('Revision fingerprint unavailable; running without evidence.'); }
  const code = await new Promise(resolve => {
    let proc;
    try { proc = require('node:child_process').spawn(command, { shell: process.platform === 'win32' ? systemCmd() : true, cwd: process.cwd(), stdio: 'inherit' }); }
    catch (error) { process.stderr.write('[quota-boss] Could not run command: ' + error.message + '\n'); resolve(1); return; }
    proc.once('error', error => { process.stderr.write('[quota-boss] Could not run command: ' + error.message + '\n'); resolve(1); });
    proc.once('close', (status, signal) => {
      if (signal) process.stderr.write('[quota-boss] Command terminated by signal ' + signal + '.\n');
      resolve(Number.isInteger(status) ? status : 1);
    });
  });
  if (key) {
    let passed = false;
    if (code === 0) {
      try { const after = revisionFingerprint(); passed = before.top === after.top && before.fingerprint === after.fingerprint; }
      catch { notice('Revision fingerprint unavailable; running without evidence.'); }
    }
    try { saveVerification(file, key, passed); }
    catch { notice('Could not save verification evidence.'); }
  }
  // A pipe through compact.js hides the exit code, so the result is also a line it keeps.
  process.stdout.write(code === 0 ? '[quota-boss] Check passed.\n' : '[quota-boss] Check failed with exit code ' + code + '.\n');
  return code;
}
