'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { rows, random, runName } = require('./review');

function mean(a) {
  return a.reduce((s, x) => s + x, 0) / a.length;
}

function stats(a) {
  a = a.filter(Number.isFinite);
  if (!a.length) return { n: 0, mean: null, ci: null };
  const r = random(1729), samples = [];
  for (let i = 0; i < 2000; i++) samples.push(mean(a.map(() => a[Math.floor(r() * a.length)])));
  samples.sort((a, b) => a - b);
  return { n: a.length, mean: mean(a), ci: [samples[49], samples[1949]] };
}

function ratio(a, b) {
  if (!a.length || !b.length || mean(b) === 0) return null;
  const r = random(991), s = [];
  for (let i = 0; i < 2000; i++) {
    const denominator = mean(b.map(() => b[Math.floor(r() * b.length)]));
    if (denominator) s.push(mean(a.map(() => a[Math.floor(r() * a.length)])) / denominator);
  }
  s.sort((a, b) => a - b);
  return {
    mean: mean(a) / mean(b),
    ci: s.length ? [s[Math.floor(s.length * .025)], s[Math.floor(s.length * .975)]] : null,
  };
}

function report(out) {
  const results = rows(path.join(out, 'results.jsonl'));
  const reviewFile = path.join(out, 'reviews.jsonl'), scores = new Map();
  if (fs.existsSync(reviewFile) && fs.readFileSync(reviewFile, 'utf8').trim()) {
    const map = JSON.parse(fs.readFileSync(path.join(out, 'review-map.json'), 'utf8')).packets;
    for (const r of rows(reviewFile)) {
      const name = map[r.packetId];
      if (!name) throw new Error('Unknown review packet: ' + r.packetId);
      scores.set(name, mean([r.correctness, r.testQuality, r.codeQuality]));
    }
  }
  const groups = new Map();
  for (const r of results) {
    const arm = r.arm || r.mode, key = JSON.stringify([r.task, arm, r.host, r.model]);
    if (!groups.has(key)) groups.set(key, { task: r.task, arm, host: r.host, model: r.model, values: [] });
    const hidden = /^(\d+)\/(\d+)$/.exec(r.hidden || '');
    const claude = r.claude?.usd ?? (r.host === 'codex' ? 0 : NaN), codex = r.codexUsd ?? NaN;
    groups.get(key).values.push({
      claudeUsd: claude,
      codexUsd: codex,
      totalUsd: claude + codex,
      seconds: r.seconds,
      hiddenPassRate: hidden && +hidden[2] ? +hidden[1] / +hidden[2] : NaN,
      ownTestCount: Number.isFinite(r.ownPass) && Number.isFinite(r.ownFail) ? r.ownPass + r.ownFail : NaN,
      reviewScore: scores.get(runName(r)),
    });
  }
  return [...groups.values()].map(g => {
    const metrics = {};
    for (const k of Object.keys(g.values[0])) metrics[k] = stats(g.values.map(v => v[k]));
    const off = [...groups.values()].find(x => x.task === g.task && x.host === g.host && x.model === g.model && x.arm === 'off');
    return {
      task: g.task,
      arm: g.arm,
      host: g.host,
      model: g.model,
      n: g.values.length,
      metrics,
      totalUsdRatioToOff: off ? ratio(g.values.map(v => v.totalUsd).filter(Number.isFinite), off.values.map(v => v.totalUsd).filter(Number.isFinite)) : null,
    };
  });
}

function markdown(groups) {
  const keys = Object.keys(groups[0].metrics);
  const fmt = s => !s || s.mean === null ? 'NA' : `${s.mean.toFixed(4)} [${s.ci ? s.ci.map(x => x.toFixed(4)).join(', ') : 'NA'}]${s.n !== undefined ? ' n=' + s.n : ''}`;
  return [
    '| Task | Arm | Host | Model | n | ' + keys.join(' | ') + ' | USD / off |',
    '|' + Array(keys.length + 6).fill('---').join('|') + '|',
    ...groups.map(g => `| ${g.task} | ${g.arm} | ${g.host} | ${g.model} | ${g.n} | ${keys.map(k => fmt(g.metrics[k])).join(' | ')} | ${fmt(g.totalUsdRatioToOff)} |`),
  ].join('\n');
}

module.exports = { stats, ratio, report, markdown };
if (require.main === module) {
  try {
    const a = process.argv.slice(2), i = a.indexOf('--out');
    if (i < 0 || !a[i + 1]) throw new Error('Usage: node bench/report.js --out <dir> [--json]');
    const r = report(path.resolve(a[i + 1]));
    console.log(a.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
