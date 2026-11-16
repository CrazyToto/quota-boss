#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { createInventory } = require('./inventory.js');
const { quote } = require('./pricing.js');
const { formatCents, stockReport } = require('./report.js');

function run(argv) {
  const [db, cmd, ...args] = argv;
  if (!db || !cmd) throw new Error('usage: cli.js <db.json> import|list|quote|report ...');
  const inv = createInventory(fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf8')) : []);
  const out = [];
  if (cmd === 'import') {
    if (args.length !== 1) throw new Error('usage: import <file.csv>');
    const r = inv.importCsv(fs.readFileSync(args[0], 'utf8'));
    fs.writeFileSync(db, JSON.stringify(inv.toJSON(), null, 2));
    out.push(`added=${r.added} errors=${r.errors.length}`, ...r.errors.map((e) => `line ${e.line}: ${e.message}`));
  } else if (cmd === 'list') {
    for (const i of inv.list()) out.push(`${i.sku} ${i.qty} ${formatCents(i.price)} ${i.name}`);
  } else if (cmd === 'quote') {
    const lines = [];
    let coupon;
    for (let k = 0; k < args.length; k++) {
      if (args[k] === '--coupon') { coupon = args[++k]; if (!coupon) throw new Error('--coupon needs a code'); continue; }
      const m = /^([^:]+):(\d+)$/.exec(args[k]);
      if (!m) throw new Error(`bad argument ${args[k]}`);
      lines.push({ sku: m[1], qty: Number(m[2]) });
    }
    if (!lines.length) throw new Error('usage: quote <sku>:<qty>... [--coupon CODE]');
    out.push(`total=${formatCents(quote(inv, lines, { coupon }).total)}`);
  } else if (cmd === 'report') {
    const r = stockReport(inv.list());
    out.push(`items=${r.items} units=${r.units} value=${formatCents(r.value)} low=${r.low.join(',') || '-'}`);
  } else throw new Error(`unknown command ${cmd}`);
  return out;
}
try { for (const l of run(process.argv.slice(2))) console.log(l); }
catch (e) { console.error(e.message); process.exit(1); }
