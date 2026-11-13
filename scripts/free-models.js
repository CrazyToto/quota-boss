'use strict';

const fs = require('node:fs');
const { PRESETS } = require('./add-api');
const USAGE = 'Usage: quota-boss free-models <models-dev.json> [<openrouter.json>]';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value);
const safe = value => String(value).replace(/[^A-Za-z0-9._:/@+-]/g, '?').slice(0, 120);
const context = value => number(value) && value >= 0 ? value : 0;
const price = value => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const routerFree = model => object(model.pricing) && price(model.pricing.prompt) === 0 && price(model.pricing.completion) === 0;

function check(presets, modelsDev, openRouter) {
  const dev = object(modelsDev) ? modelsDev : {};
  const router = new Map();
  for (const model of Array.isArray(openRouter?.data) ? openRouter.data : []) {
    if (object(model) && typeof model.id === 'string') router.set(model.id, model);
  }
  const rows = [], covered = new Set();
  for (const [id, preset] of Object.entries(object(presets) ? presets : {})) {
    if (!object(preset)) continue;
    const entries = [[id, preset], ...(Array.isArray(preset.extraModels) ? preset.extraModels : [])
      .filter(object).map(extra => [id + '-' + (typeof extra.suffix === 'string' ? extra.suffix : ''), extra])];
    for (const [entryId, entry] of entries) {
      if (typeof entry.model !== 'string' || !entry.model.includes('/')) continue;
      covered.add(entry.model);
      const slash = entry.model.indexOf('/'), provider = entry.model.slice(0, slash), modelId = entry.model.slice(slash + 1);
      const models = object(dev[provider]) && object(dev[provider].models) ? dev[provider].models : {};
      const listed = Object.hasOwn(models, modelId) && object(models[modelId]) ? models[modelId] : null;
      const preferred = provider === 'openrouter' ? router.get(modelId) : null;
      let status = listed || preferred ? 'ok' : 'missing';
      if (status === 'ok' && (preset.keyless === true || entry.keyless === true || modelId.endsWith(':free'))) {
        const cost = listed?.cost;
        const paid = preferred ? [preferred.pricing?.prompt, preferred.pricing?.completion].some(value => price(value) !== null && price(value) !== 0)
          : object(cost) && [cost.input, cost.output].some(value => number(value) && value > 0);
        if (paid) status = 'not free';
      }
      rows.push({ id: entryId, model: entry.model, status });
    }
  }
  const zen = [], openrouter = [];
  const zenModels = object(dev.opencode) && object(dev.opencode.models) ? dev.opencode.models : {};
  for (const [id, model] of Object.entries(zenModels)) {
    if (object(model) && object(model.cost) && model.cost.input === 0 && model.cost.output === 0 && !covered.has('opencode/' + id)) {
      zen.push({ model: 'opencode/' + id, context: context(model.limit?.context) });
    }
  }
  for (const [id, model] of router) {
    if (id.endsWith(':free') && routerFree(model) && Array.isArray(model.supported_parameters) && model.supported_parameters.includes('tools')
      && number(model.context_length) && model.context_length >= 64000 && !covered.has('openrouter/' + id)) {
      openrouter.push({ model: 'openrouter/' + id, context: model.context_length });
    }
  }
  const sort = items => items.sort((a, b) => b.context - a.context || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return { presets: rows, zen: sort(zen), openrouter: sort(openrouter), attention: rows.filter(row => row.status !== 'ok').length };
}

function format(result) {
  const lines = ['Free presets', ...result.presets.map(row => '  ' + row.status.padEnd(8) + ' ' + safe(row.id) + ' ' + safe(row.model))];
  for (const [title, items] of [['OpenCode Zen (no key)', result.zen], ['OpenRouter :free', result.openrouter]]) {
    lines.push('New candidates: ' + title);
    lines.push(...items.slice(0, 15).map(item => '  ' + safe(item.model) + '  ' + Math.round(item.context / 1000) + 'k ctx'));
    if (items.length > 15) lines.push('  (' + (items.length - 15) + ' more)');
  }
  lines.push(result.attention ? result.attention + ' presets need attention.' : 'All free presets are still listed.');
  return lines.join('\n');
}

function read(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error('size');
    // Bound the read even if the file grows after the size check.
    const chunks = []; let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(65536), count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > 50 * 1024 * 1024) throw new Error('size');
      chunks.push(chunk.subarray(0, count));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function command(args) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 2) return { text: USAGE, code: 2 };
  let dev, router;
  try { dev = read(args[0]); if (args.length === 2) router = read(args[1]); }
  catch { return { text: 'Cannot read model lists: use local JSON files no larger than 50 MB.', code: 2 }; }
  if (!object(dev) || (args.length === 2 && (!object(router) || !Array.isArray(router.data)))) {
    return { text: 'Invalid model list shape: expected a models.dev object and OpenRouter data array.', code: 2 };
  }
  const result = check(PRESETS, dev, router);
  return { text: format(result), code: result.attention ? 1 : 0 };
}

module.exports = { check, format, command };
