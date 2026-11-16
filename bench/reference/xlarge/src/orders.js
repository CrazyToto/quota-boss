'use strict';
const { quote } = require('./pricing.js');
/** Create orders backed by inventory and previously saved orders. */
function createOrders(inventory, saved = []) {
  const orders = new Map(saved.map(order => [order.id, JSON.parse(JSON.stringify(order))]));
  let next = Math.max(0, ...saved.map(order => Number(order.id.slice(4)))) + 1;
  return {
    place(lines, options = {}) {
      const priced = quote(inventory, lines, options);
      const quantities = new Map();
      for (const { sku, qty } of lines) quantities.set(sku, (quantities.get(sku) || 0) + qty);
      for (const [sku, qty] of quantities) if (qty > inventory.get(sku).qty) throw new RangeError(`not enough stock for ${sku}`);
      for (const [sku, qty] of quantities) inventory.adjust(sku, -qty);
      const order = { id: 'ORD-' + String(next++).padStart(4, '0'), ...priced, status: 'open' };
      orders.set(order.id, order);
      return order;
    },
    cancel(id) {
      const order = orders.get(id);
      if (!order) throw new Error(`unknown order ${id}`);
      if (order.status === 'cancelled') throw new Error(`already cancelled ${id}`);
      for (const { sku, qty } of order.lines) inventory.adjust(sku, qty);
      order.status = 'cancelled';
      return order;
    },
    get: id => orders.get(id),
    list: () => [...orders.values()].sort((a, b) => a.id.localeCompare(b.id)),
    toJSON: () => [...orders.values()],
  };
}
module.exports = { createOrders };
