'use strict';

const { integer, signed } = require('../util/validate');
const { roundRatio, sumCents } = require('../money/round');
const { lineRate, shippingRate, taxLabel } = require('./policy');

function taxAmount(cents, basisPoints) {
  signed(cents, 'cents');
  integer(basisPoints, 'basis points');
  return roundRatio(cents * basisPoints, 10000);
}

// Round each line separately, matching the accounting export contract.
function calculateTax(cart, delivery, country) {
  const lines = cart.lines.map(line => ({
    sku: line.sku,
    basis: line.net,
    rate: lineRate(country, line.taxClass),
    tax: taxAmount(line.net, lineRate(country, line.taxClass)),
  }));
  const shipping = taxAmount(delivery.cents, shippingRate(country));
  return {
    label: taxLabel(country),
    lines,
    merchandise: sumCents(lines.map(line => line.tax)),
    shipping,
    total: sumCents([...lines.map(line => line.tax), shipping]),
  };
}

function taxableBasis(cart) {
  return sumCents(cart.lines.filter(line => line.taxClass === 'standard')
    .map(line => line.net));
}

function taxRows(tax) {
  return tax.lines.map(line => ({
    sku: line.sku,
    basis: line.basis,
    basisPoints: line.rate,
    cents: line.tax,
  }));
}

module.exports = { taxAmount, calculateTax, taxableBasis, taxRows };
