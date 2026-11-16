'use strict';

const { integer, text } = require('../util/validate');
const { roundRatio, sumCents } = require('../money/round');
const { formatCents } = require('../money/format');

// Credits operate on persisted billing-currency lines, never on USD prices.
function creditNote(invoice, quantities) {
  const known = new Set(invoice.lines.map(line => line.sku));
  for (const sku of Object.keys(quantities)) {
    if (!known.has(sku)) throw new Error('unknown credit sku ' + sku);
  }
  const lines = [];
  for (const line of invoice.lines) {
    if (!Object.hasOwn(quantities, line.sku)) continue;
    const quantity = integer(quantities[line.sku], 'credit quantity');
    integer(line.quantity, 'purchased quantity', 1);
    integer(line.net, 'line net');
    if (quantity > line.quantity) throw new RangeError('credit exceeds quantity');
    lines.push({
      sku: line.sku,
      quantity,
      cents: roundRatio(-line.net * quantity, line.quantity),
    });
  }
  return {
    invoiceId: text(invoice.id, 'invoice id'),
    currency: invoice.currency.code,
    lines,
    total: sumCents(lines.map(line => line.cents)),
  };
}

function creditSummary(note) {
  return 'Credit ' + note.invoiceId + ': ' + formatCents(note.total, note.currency);
}

function creditedUnits(note) {
  return note.lines.reduce((sum, line) => sum + line.quantity, 0);
}

function isEmptyCredit(note) {
  return creditedUnits(note) === 0;
}

module.exports = { creditNote, creditSummary, creditedUnits, isEmptyCredit };
