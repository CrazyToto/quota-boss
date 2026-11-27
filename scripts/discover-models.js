'use strict';
// Asks a provider's own CLI which models the signed-in account offers and compares them with the routing table.
// refresh() stores the result, and loadConfig turns the plan's models on and the ones the account lacks off, so a paid
// plan routes its normal models without any switch, as Codex or Claude do. A manual use switch still wins.

const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');
const lib = require('./lib');

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_BYTES = 4 * 1024 * 1024;

/** `devin models list --format json`: families with variants; a price means per-token billing, none means included. */
function parseDevin(text) {
  const data = JSON.parse(text);
  const listed = [];
  for (const family of Array.isArray(data?.families) ? data.families : []) {
    for (const variant of Array.isArray(family?.variants) ? family.variants : []) {
      if (typeof variant?.model_uid !== 'string' || !SLUG.test(variant.model_uid)) continue;
      // A price in any shape other than text counts as a price, so a changed CLI never makes a priced model look included.
      const raw = variant.cost_summary;
      const cost = raw == null ? '' : typeof raw === 'string' ? raw.trim() : 'priced';
      listed.push({ id: variant.model_uid, billing: !cost || /^free\b/i.test(cost) ? 'included' : 'per-token' });
    }
  }
  return listed;
}
/** `agy models`: one `<slug>\t<label>` line per model after a status line. */
function parseTabList(text) {
  return String(text).split(/\r?\n/).map(line => line.split('\t')[0].trim()).filter(id => SLUG.test(id) && !/\s/.test(id))
    .filter((id, index, all) => all.indexOf(id) === index && String(text).includes(id + '\t'))
    .map(id => ({ id, billing: 'unknown' }));
}
/** `devin auth status`: only the Plan line is read, never the name or email next to it. Only a known paid plan counts as
 *  paid; a trial, an expired or an unknown plan is treated like the free one, so no priced model goes on by guess. */
function parseDevinPlan(text) {
  const match = /^[ \t]*Plan:[ \t]*(\S[^\r\n]*)$/m.exec(String(text));
  if (!match) return null;
  const plan = match[1].trim();
  return /^free\b/i.test(plan) ? 'free' : /^(?:pro|max|core|plus|teams?|business|enterprise)\b(?!.*\b(?:trial|expired|cancel\w*|inactive)\b)/i.test(plan) ? 'paid' : null;
}
// Keyed by the CLI command, so a renamed or copied provider with the same CLI is covered too.
const LISTERS = {
  devin: { args: ['models', 'list', '--format', 'json'], parse: parseDevin, source: 'devin models list', plan: { args: ['auth', 'status'], parse: parseDevinPlan } },
  agy: { args: ['models'], parse: parseTabList, source: 'agy models' },
};

/** The CLI model a table entry selects: its cliModel, else the fixed `--model` value in the provider's arguments. */
function selectedModel(model, cli) {
  if (model.cliModel) return model.cliModel;
  const args = Array.isArray(cli?.args) ? cli.args : [];
  const flag = args.findIndex(arg => arg === '--model' || arg === '-m');
  const value = flag >= 0 ? args[flag + 1] : args.find(arg => /^--model=/.test(arg))?.slice(8);
  return typeof value === 'string' && !value.includes('{') ? value : null;
}
/** A listed id matches a CLI model exactly or as `<model>-<effort>` (Antigravity and Devin name efforts in the slug). */
function matches(listedId, cliModel) {
  return listedId === cliModel || listedId.startsWith(cliModel + '-') && lib.EFFORT_ORDER.includes(listedId.slice(cliModel.length + 1));
}

// Effort and speed variants of one model, so a list of hundreds of slugs reads as a few model names.
const VARIANT = /-(?:none|minimal|low|medium|high|xhigh|max|lightning|fast|priority|thinking|1m)$/;
function family(id) {
  let base = id;
  while (VARIANT.test(base)) base = base.replace(VARIANT, '');
  return base || id;
}

function compare(providerId, listed, config) {
  const provider = config.providers.providers[providerId];
  const rows = { routed: [], off: [], missing: [] };
  const used = new Set();
  for (const [id, model] of Object.entries(config.models.models)) {
    if (model?.pool !== providerId) continue;
    const cliModel = selectedModel(model, provider.cli);
    if (!cliModel) continue;
    const hits = listed.filter(item => matches(item.id, cliModel));
    for (const hit of hits) used.add(hit.id);
    if (!hits.length) { rows.missing.push({ id, cliModel, off: model.enabled === false }); continue; }
    const billing = hits.every(hit => hit.billing === 'per-token') ? 'per-token' : hits.some(hit => hit.billing === 'included') ? 'included' : 'unknown';
    rows[model.enabled === false ? 'off' : 'routed'].push({ id, cliModel, billing });
  }
  rows.unknown = listed.filter(item => !used.has(item.id)).map(item => item.id);
  return rows;
}

function report(providerId, rows, source, providerOff = false) {
  const note = billing => billing === 'per-token' ? ', priced per token' : billing === 'included' ? ', no price shown' : '';
  const lines = ['Models your ' + providerId + ' account offers (' + source + ')'];
  if (providerOff) lines.push('  ' + providerId + ' itself is off, so nothing here is routed yet: quota-boss use ' + providerId + ' on');
  for (const row of rows.routed) lines.push('  routed   ' + row.id + ' (' + row.cliModel + note(row.billing) + ')');
  for (const row of rows.off) lines.push('  off      ' + row.id + ' (' + row.cliModel + note(row.billing) + '): quota-boss use ' + row.id + ' on, if your plan includes it');
  for (const row of rows.missing) lines.push('  missing  ' + row.id + ' (' + row.cliModel + '): not offered to this account' + (row.off ? '' : '; quota-boss use ' + row.id + ' off'));
  if (rows.unknown.length) {
    const families = [...new Set(rows.unknown.map(family))];
    lines.push('  not in the table, so not routed: ' + families.slice(0, 12).join(', ') + (families.length > 12 ? ' and ' + (families.length - 12) + ' more' : ''));
  }
  if (!rows.routed.length && !rows.off.length && !rows.missing.length && !rows.unknown.length) lines.push('  The CLI listed no models.');
  return lines.join('\n');
}

function listerOf(provider) {
  const command = provider?.cli?.command;
  return typeof command === 'string' ? LISTERS[path.basename(command).replace(/\.(cmd|exe|bat)$/i, '').toLowerCase()] ?? null : null;
}
const RUN = { encoding: 'utf8', timeout: 60 * 1000, maxBuffer: MAX_BYTES, windowsHide: true };
/** Runs the provider's list command (and its plan command, if any). Returns { listed, plan, lister } or throws a short reason. */
function list(providerId, config, run, find) {
  const provider = config.providers.providers[providerId];
  const lister = listerOf(provider);
  if (!lister) throw new Error(providerId + ' has no command that lists the models of your account.');
  const executable = find(provider.cli.command);
  const result = run(executable, lister.args, RUN);
  if (result.error || result.status !== 0) {
    throw new Error(lister.source + ' failed' + (result.error ? ': ' + lib.sanitizeLabel(result.error.message) : ' (exit ' + result.status + ')') + '. Is the CLI installed and signed in?');
  }
  let listed;
  try { listed = lister.parse(result.stdout ?? ''); } catch { throw new Error(lister.source + ' printed something Quota Boss cannot read.'); }
  let plan = null;
  if (lister.plan) {
    try {
      const status = run(executable, lister.plan.args, RUN);
      if (!status.error && status.status === 0) plan = lister.plan.parse(status.stdout ?? '');
    } catch { plan = null; }
  }
  return { listed, plan, lister };
}

/** Which table models of a provider its account has. Every listed model without a price goes on; a priced one stays off
 *  on every plan, because no usage is visible to stop it before billing beyond the allowance starts: only
 *  `use <model> on` turns it on. null when nothing in the list matches the table: that is a changed CLI, not a plan. */
function planState(providerId, listed, plan, config) {
  const rows = compare(providerId, listed, config);
  const found = [...rows.routed, ...rows.off];
  if (!found.length) return null;
  const included = row => row.billing !== 'per-token';
  return { ...(plan ? { plan } : {}), on: found.filter(included).map(row => row.id).sort(),
    off: [...found.filter(row => !included(row)).map(row => row.id), ...rows.missing.map(row => row.id)].sort() };
}

const DAY_MS = 24 * 3600 * 1000, CLAIM_MS = 15 * 60 * 1000;
/** The package version, or for an installed copy without package.json the time its scripts were copied. */
function version() {
  const value = String(lib.readJson(path.join(__dirname, '..', 'package.json'), {})?.version ?? '').slice(0, 40);
  if (value) return value;
  try { return 'copied-' + Math.round(fs.statSync(__filename).mtimeMs); } catch { return ''; }
}
/** Writes under a lock onto the file as it is now, so a slower run never drops what a faster one stored meanwhile. */
function save(file, { updates = {}, checkedAt, claimedAt, wait = 2000 } = {}) {
  const saved = lib.withLock(file, verify => {
    const latest = lib.readPlanModels(file);
    const providers = Object.assign(Object.create(null), latest.providers, updates);
    const value = { version: checkedAt ? version() : latest.version, checkedAt: checkedAt ?? latest.checkedAt, claimedAt: claimedAt ?? latest.claimedAt, providers };
    lib.atomicWrite(file, JSON.stringify(value, null, 2) + '\n', verify);
    return true;
  }, wait);
  if (saved === null) throw new Error('The plan model file is busy; retry.');
}

/**
 * Asks every provider with a list command what the account has and stores it. A provider that is off, not installed or
 * fails keeps what was stored before. Returns { changes: [{ provider, plan, on, off }], listings, errors }.
 */
function refresh({ config = lib.loadConfig(undefined, { use: false, tolerant: true }), run = lib.runExecutable, find = lib.findExecutable,
  now = Date.now(), only = null, file = lib.planModelsFile(), use = lib.readUse() } = {}) {
  const old = lib.readPlanModels(file), next = Object.create(null), changes = [], listings = {}, errors = {};
  for (const [id, provider] of Object.entries(config.providers.providers)) {
    if (only ? id !== only : provider.enabled === false || use.providersOff.includes(id)) continue;
    if (!listerOf(provider) || !only && !find(provider.cli.command)) continue;
    try {
      const { listed, plan, lister } = list(id, config, run, find);
      listings[id] = { listed, source: lister.source };
      const state = planState(id, listed, plan, config);
      if (!state) continue;
      const before = old.providers[id] ?? { on: [], off: [] };
      const on = state.on.filter(model => !before.on.includes(model)), off = state.off.filter(model => !before.off.includes(model));
      if (on.length || off.length || before.plan !== state.plan) changes.push({ provider: id, plan: state.plan ?? null, on, off });
      next[id] = state;
    } catch (error) { errors[id] = String(error?.message ?? error); }
  }
  save(file, { updates: next, ...(only ? {} : { checkedAt: now }) });
  return { changes, listings, errors };
}

/** Session start: refresh in the background once a day and after an update, never twice at once. */
function refreshIfStale({ config, now = Date.now(), spawn = child.spawn, file = lib.planModelsFile(), use = lib.readUse() } = {}) {
  try {
    // Nothing to ask when no provider that can list its models is on.
    if (!Object.entries(config.providers.providers).some(([id, provider]) => provider.enabled !== false && !use.providersOff.includes(id) && listerOf(provider))) return false;
    const state = lib.readPlanModels(file);
    if (now - state.checkedAt < DAY_MS && state.version === version()) return false;
    if (now - state.claimedAt < CLAIM_MS) return false;
    // A short wait: the session start must not hang on a running refresh, which is fresh work anyway.
    save(file, { claimedAt: now, wait: 100 });
    const proc = spawn(process.execPath, [__filename, '--refresh'], { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    proc.on('error', () => {});
    proc.unref();
    return true;
  } catch { return false; }
}

/** One line per provider whose models changed, for setup and the models report. */
function changeLines(changes) {
  return changes.map(change => change.provider + (change.plan ? ' (' + change.plan + ' plan)' : '') + ':'
    + (change.on.length ? ' on ' + change.on.join(', ') : '') + (change.on.length && change.off.length ? ';' : '')
    + (change.off.length ? ' off ' + change.off.join(', ') : '') + (!change.on.length && !change.off.length ? ' no model changed' : ''));
}

/** quota-boss providers models <id>: with store, refreshes that provider first and reports with the result applied. */
function discover(providerId, { config = lib.loadConfig(), run = lib.runExecutable, find = lib.findExecutable, store = false, file } = {}) {
  let listed, source, changes = [];
  if (store) {
    const result = refresh({ only: providerId, run, find, ...(file ? { file } : {}) });
    if (!result.listings[providerId]) throw new Error(result.errors[providerId] ?? providerId + ' has no command that lists the models of your account.');
    ({ listed, source } = result.listings[providerId]);
    changes = result.changes;
    config = lib.loadConfig();
  } else ({ listed, lister: { source } } = list(providerId, config, run, find));
  const rows = compare(providerId, listed, config);
  const text = report(providerId, rows, source, config.providers.providers[providerId].enabled === false);
  return { rows, text: changes.length ? text + '\n  Changed for your plan: ' + changeLines(changes).join('; ') : text };
}

if (require.main === module && process.argv[2] === '--refresh') {
  try { refresh(); } catch { /* the next session start tries again */ }
}

module.exports = { discover, refresh, refreshIfStale, planState, changeLines, compare, parseDevin, parseDevinPlan, parseTabList, selectedModel, matches, LISTERS };
