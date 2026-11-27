'use strict';
// Asks a provider's own CLI which models the signed-in account offers and compares them with the routing table.
// Only a report: nothing is turned on, because a listed model can still bill per token beyond the plan.

const path = require('node:path');
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
      const cost = typeof variant.cost_summary === 'string' ? variant.cost_summary.trim() : '';
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
// Keyed by the CLI command, so a renamed or copied provider with the same CLI is covered too.
const LISTERS = {
  devin: { args: ['models', 'list', '--format', 'json'], parse: parseDevin, source: 'devin models list' },
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

/** Runs the provider's list command. Returns { rows, text } or throws with a short reason. */
function discover(providerId, { config = lib.loadConfig(), run = lib.runExecutable, find = lib.findExecutable } = {}) {
  const provider = config.providers.providers[providerId];
  const command = provider?.cli?.command;
  const lister = command && LISTERS[path.basename(command).replace(/\.(cmd|exe|bat)$/i, '')];
  if (!lister) throw new Error(providerId + ' has no command that lists the models of your account.');
  const result = run(find(command), lister.args, { encoding: 'utf8', timeout: 60 * 1000, maxBuffer: MAX_BYTES });
  if (result.error || result.status !== 0) {
    throw new Error(lister.source + ' failed' + (result.error ? ': ' + lib.sanitizeLabel(result.error.message) : ' (exit ' + result.status + ')') + '. Is the CLI installed and signed in?');
  }
  let listed;
  try { listed = lister.parse(result.stdout ?? ''); } catch { throw new Error(lister.source + ' printed something Quota Boss cannot read.'); }
  const rows = compare(providerId, listed, config);
  return { rows, text: report(providerId, rows, lister.source, provider.enabled === false) };
}

module.exports = { discover, compare, parseDevin, parseTabList, selectedModel, matches, LISTERS };
