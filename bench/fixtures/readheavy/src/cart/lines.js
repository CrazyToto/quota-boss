'use strict';

const { array, integer, text } = require('../util/validate');

// Repeated SKUs represent a single stock request, in first-seen order.
function normalizeLines(requests) {
  array(requests, 'lines');
  const quantities = new Map();
  for (const request of requests) {
    const sku = text(request.sku, 'sku');
    const quantity = integer(request.quantity, 'quantity', 1);
    const combined = (quantities.get(sku) || 0) + quantity;
    integer(combined, 'combined quantity', 1);
    quantities.set(sku, combined);
  }
  return [...quantities].map(([sku, quantity]) => ({ sku, quantity }));
}

function resolveLines(catalog, requests) {
  return normalizeLines(requests).map(line => {
    const product = catalog.requireProduct(line.sku);
    if (line.quantity > product.stock) {
      throw new RangeError('insufficient stock for ' + line.sku);
    }
    return {
      ...line,
      name: product.name,
      unit: product.price,
      grams: product.grams,
      kind: product.kind,
      taxClass: product.taxClass,
    };
  });
}

function countUnits(lines) {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

function shippingWeight(lines) {
  return lines.reduce((sum, line) => {
    const grams = line.kind === 'physical' ? line.grams * line.quantity : 0;
    return integer(sum + grams, 'packed grams');
  }, 0);
}

module.exports = { normalizeLines, resolveLines, countUnits, shippingWeight };
