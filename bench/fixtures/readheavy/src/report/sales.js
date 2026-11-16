'use strict';

const { sumCents } = require('../money/round');
const { formatCents } = require('../money/format');

// Converted snapshots are grouped; totals in different currencies never mix.
function salesByCurrency(invoices) {
  const groups = new Map();
  for (const invoice of invoices) {
    const code = invoice.currency.code;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(invoice);
  }
  return [...groups.keys()].sort().map(code => {
    const group = groups.get(code);
    return {
      currency: code,
      orders: group.length,
      units: group.reduce((sum, invoice) => sum + countUnits(invoice), 0),
      total: sumCents(group.map(invoice => invoice.amounts.total)),
      tax: sumCents(group.map(invoice => invoice.amounts.tax)),
    };
  });
}

function countUnits(invoice) {
  return invoice.lines.reduce((sum, line) => sum + line.quantity, 0);
}

function salesText(invoices) {
  return salesByCurrency(invoices).map(group =>
    group.currency + ' orders=' + group.orders + ' total=' +
    formatCents(group.total, group.currency)).join('\n');
}

function topSkus(invoices) {
  const counts = new Map();
  for (const invoice of invoices) {
    for (const line of invoice.lines) {
      counts.set(line.sku, (counts.get(line.sku) || 0) + line.quantity);
    }
  }
  return [...counts].map(([sku, units]) => ({ sku, units }))
    .sort((a, b) => b.units - a.units || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

module.exports = { salesByCurrency, salesText, countUnits, topSkus };
