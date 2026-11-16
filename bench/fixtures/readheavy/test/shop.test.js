'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalog } = require('../src/catalog/products');
const { search } = require('../src/catalog/search');
const { priceCart } = require('../src/cart/pricing');
const { promotionDiscount, spreadDiscount } = require('../src/cart/promotions');
const { taxAmount } = require('../src/tax/calculate');
const { retailEstimate } = require('../src/shipping/estimate');
const { checkout, confirmation } = require('../src/orders/checkout');
const { refundAmount } = require('../src/orders/refund');
const { salesByCurrency } = require('../src/report/sales');

function catalog() {
  return createCatalog([
    { sku: 'BOOK', name: 'Pocket Book', price: 1200, stock: 9, grams: 250 },
    { sku: 'PDF', name: 'Digital Book', price: 1000, stock: 50, kind: 'digital' },
  ]);
}

test('catalog search returns independent product records', () => {
  const products = catalog();
  const results = search(products, 'book', { sort: 'price' });
  assert.deepEqual(results.map(item => item.sku), ['PDF', 'BOOK']);
  results[0].price = 1;
  assert.equal(products.get('PDF').price, 1000);
});

test('cart merges repeated requests and leaves stock alone', () => {
  const products = catalog();
  const cart = priceCart(products, [
    { sku: 'BOOK', quantity: 1 }, { sku: 'BOOK', quantity: 2 },
  ]);
  assert.equal(cart.subtotal, 3600);
  assert.equal(cart.grams, 750);
  assert.equal(cart.lines.length, 1);
  assert.equal(products.get('BOOK').stock, 9);
});

test('coupons allocate every cent', () => {
  assert.equal(promotionDiscount(1200, 'SAVE10'), 120);
  assert.equal(promotionDiscount(100, 'FIVE'), 100);
  assert.deepEqual(spreadDiscount([100, 200, 300], 60), [10, 20, 30]);
});

test('positive tax fractions and warehouse estimates', () => {
  assert.equal(taxAmount(101, 5000), 51);
  assert.equal(retailEstimate(0.75, 'US'), 500);
});

test('digital USD checkout can be printed and reported', () => {
  const order = checkout(catalog(), {
    id: 'O-1', lines: [{ sku: 'PDF', quantity: 1 }],
  });
  assert.equal(order.amounts.total, 1000);
  assert.equal(order.delivery.reason, 'no-parcel');
  assert.match(confirmation(order).body, /Total: USD 10\.00$/);
  assert.deepEqual(salesByCurrency([order.invoice]), [
    { currency: 'USD', orders: 1, units: 1, total: 1000, tax: 0 },
  ]);
});

test('whole-cent returns reject impossible quantities', () => {
  assert.equal(refundAmount(1200, 1, 3), -400);
  assert.throws(() => refundAmount(1200, 4, 3), RangeError);
});
