'use strict';
/** Price a list of {sku, qty} lines against an inventory without changing stock. */
function quote(inventory, lines, options = {}) {
  const out = lines.map(({ sku, qty }) => {
    const it = inventory.get(sku);
    if (!it) throw new Error(`unknown sku ${sku}`);
    if (!Number.isInteger(qty) || qty <= 0) throw new TypeError(`invalid qty for ${sku}`);
    if (qty > it.qty) throw new RangeError(`not enough stock for ${sku}`);
    let total = it.price * qty;
    if (qty >= 10) total -= Math.round(total * 0.1);
    return { sku, qty, unit: it.price, total };
  });
  const subtotal = out.reduce((s, l) => s + l.total, 0);
  let discount = 0;
  const { coupon } = options;
  if (coupon === 'SAVE5') discount = Math.min(500, subtotal);
  else if (coupon === 'HALF') discount = Math.round(subtotal * 0.5);
  else if (coupon !== undefined && coupon !== null) throw new Error(`unknown coupon ${coupon}`);
  const tax = Math.round((subtotal - discount) * 0.08);
  return { lines: out, subtotal, discount, tax, total: subtotal - discount + tax };
}
module.exports = { quote };
