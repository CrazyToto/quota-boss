'use strict';

const { integer, text } = require('../util/validate');
const { roundRatio, sumCents } = require('../money/round');

// Refund amounts are ledger entries: negative means money leaves the shop.
function refundAmount(chargedCents, returnedUnits, purchasedUnits) {
  integer(chargedCents, 'charged cents');
  integer(purchasedUnits, 'purchased units', 1);
  integer(returnedUnits, 'returned units');
  if (returnedUnits > purchasedUnits) {
    throw new RangeError('cannot return more units than purchased');
  }
  return roundRatio(-chargedCents * returnedUnits, purchasedUnits);
}

function refundLine(line, returnedUnits) {
  return {
    sku: text(line.sku, 'sku'),
    quantity: returnedUnits,
    cents: refundAmount(line.charged, returnedUnits, line.quantity),
  };
}

function refundRequest(lines, quantities) {
  const known = new Set(lines.map(line => line.sku));
  for (const sku of Object.keys(quantities)) {
    if (!known.has(sku)) throw new Error('unknown return sku ' + sku);
  }
  const entries = [];
  for (const line of lines) {
    if (!Object.hasOwn(quantities, line.sku)) continue;
    entries.push(refundLine(line, quantities[line.sku]));
  }
  return { entries, total: sumCents(entries.map(entry => entry.cents)) };
}

function remainingCharge(chargedCents, refundCents) {
  integer(chargedCents, 'charged cents');
  if (!Number.isSafeInteger(refundCents) || refundCents > 0 || -refundCents > chargedCents) {
    throw new RangeError('refund must be within the original charge');
  }
  return chargedCents + refundCents;
}

module.exports = { refundAmount, refundLine, refundRequest, remainingCharge };
