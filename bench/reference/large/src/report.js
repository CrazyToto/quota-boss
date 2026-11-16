'use strict';
/** Format integer cents as $12.34 (-$0.05 when negative). */
function formatCents(cents) {
  const a = Math.abs(cents);
  return (cents < 0 ? '-' : '') + '$' + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
}
/** Summarize items: count, units, value and low-stock skus. */
function stockReport(items, lowStock = 5) {
  return {
    items: items.length,
    units: items.reduce((s, i) => s + i.qty, 0),
    value: items.reduce((s, i) => s + i.price * i.qty, 0),
    low: items.filter((i) => i.qty < lowStock).map((i) => i.sku).sort(),
  };
}
module.exports = { formatCents, stockReport };
