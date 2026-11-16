'use strict';

const { integer } = require('../util/validate');
const { sumCents } = require('../money/round');
const { resolveLines, shippingWeight, countUnits } = require('./lines');
const { promotionDiscount, spreadDiscount } = require('./promotions');

function priceCart(catalog, requests, coupon = '') {
  const resolved = resolveLines(catalog, requests);
  const gross = resolved.map(line => ({
    ...line,
    subtotal: integer(line.unit * line.quantity, 'line subtotal'),
  }));
  const subtotal = sumCents(gross.map(line => line.subtotal));
  const discount = promotionDiscount(subtotal, coupon);
  const deductions = spreadDiscount(gross.map(line => line.subtotal), discount);
  const lines = gross.map((line, index) => ({
    ...line,
    discount: deductions[index],
    net: line.subtotal - deductions[index],
  }));
  return {
    lines,
    subtotal,
    discount,
    net: subtotal - discount,
    grams: shippingWeight(lines),
    units: countUnits(lines),
  };
}

function cartSummary(cart) {
  return {
    skus: cart.lines.map(line => line.sku),
    units: cart.units,
    subtotal: cart.subtotal,
    discount: cart.discount,
    net: cart.net,
  };
}

function physicalLines(cart) {
  return cart.lines.filter(line => line.kind === 'physical')
    .map(line => ({ ...line }));
}

module.exports = { priceCart, cartSummary, physicalLines };
