'use strict';
const { parseRecords } = require('./csv.js');
/** Create an inventory holding the given items. */
function createInventory(items = []) {
  const map = new Map();
  const num = (s) => (String(s).trim() === '' ? NaN : Number(s));
  const inv = {
    addItem({ sku, name, price, qty } = {}) {
      if (typeof sku !== 'string' || !/^[A-Z]{3}-\d{3}$/.test(sku)) throw new TypeError('invalid sku');
      if (typeof name !== 'string' || !name) throw new TypeError('invalid name');
      if (!Number.isInteger(price) || price <= 0) throw new TypeError('invalid price');
      if (!Number.isInteger(qty) || qty < 0) throw new TypeError('invalid qty');
      if (map.has(sku)) throw new Error(`duplicate sku ${sku}`);
      map.set(sku, { sku, name, price, qty });
    },
    get: (sku) => map.get(sku),
    adjust(sku, delta) {
      const it = map.get(sku);
      if (!it) throw new Error(`unknown sku ${sku}`);
      if (it.qty + delta < 0) throw new RangeError(`not enough stock for ${sku}`);
      it.qty += delta;
      return it.qty;
    },
    list: () => [...map.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)),
    toJSON: () => [...map.values()],
    importCsv(text) {
      const [head, ...rows] = parseRecords(text);
      const res = { added: 0, errors: [] };
      if (!head) return res;
      for (const { line, fields } of rows) {
        try {
          if (fields.length !== head.fields.length) throw new Error(`expected ${head.fields.length} fields, got ${fields.length}`);
          const r = Object.fromEntries(head.fields.map((h, i) => [h, fields[i]]));
          inv.addItem({ sku: r.sku, name: r.name, price: num(r.price), qty: num(r.qty) });
          res.added++;
        } catch (e) { res.errors.push({ line, message: e.message }); }
      }
      return res;
    },
  };
  for (const it of items) inv.addItem(it);
  return inv;
}
module.exports = { createInventory };
