'use strict';

const path = require('node:path');
const lib = require('./lib');

const TOLERANCE = { trivial: 120, normal: 600, critical: 1800 };
const WEIGHT = { trivial: 0.5, normal: 0.25, critical: 0 };
const MIN_SAMPLES = 3;
const MAX_DAYS = 30;

function recordRun(entry) {
  try {
    const file = path.join(lib.getPaths().quotaBossHome, 'runs.jsonl');
    lib.checkParents(file, true);
    lib.appendRegular(file, JSON.stringify(entry) + '\n');
  } catch { /* latency learning is best-effort */ }
}

function readRuns(now = Date.now()) {
  let text;
  try { text = lib.logTail(path.join(lib.getPaths().quotaBossHome, 'runs.jsonl'), 2 * 1024 * 1024); }
  catch { return []; }
  const oldest = now - MAX_DAYS * 86400000;
  return text.split('\n').filter(line => line.length <= 1024).flatMap(line => {
    try {
      const entry = JSON.parse(line);
      return entry && entry.ok === true && Number.isFinite(entry.seconds) && entry.seconds > 0
        && typeof entry.model === 'string' && lib.TIERS.includes(entry.tier)
        && Number.isFinite(entry.t) && entry.t >= oldest && entry.t <= now ? [entry] : [];
    } catch { return []; }
  });
}

function medianSeconds(runs, model, category, tier) {
  const valid = (Array.isArray(runs) ? runs : []).filter(run => run?.model === model && run.tier === tier);
  const categorized = valid.filter(run => run.category === category);
  const selected = categorized.length >= MIN_SAMPLES ? categorized : valid.length >= MIN_SAMPLES ? valid : [];
  if (selected.length < MIN_SAMPLES) return null;
  const values = selected.map(run => run.seconds).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function speedFactor(seconds, tier, thresholds = {}) {
  if (seconds === null) return 1;
  const tolerance = Number.isFinite(thresholds.latency?.tolerance?.[tier]) && thresholds.latency.tolerance[tier] > 0
    ? thresholds.latency.tolerance[tier] : TOLERANCE[tier];
  const weight = Number.isFinite(thresholds.latency?.weight?.[tier]) && thresholds.latency.weight[tier] >= 0
    ? thresholds.latency.weight[tier] : WEIGHT[tier];
  const ratio = seconds / tolerance;
  return ratio <= 1 ? 1 : 1 / (1 + weight * (ratio - 1));
}

module.exports = { TOLERANCE, WEIGHT, MIN_SAMPLES, MAX_DAYS, recordRun, readRuns, medianSeconds, speedFactor };
