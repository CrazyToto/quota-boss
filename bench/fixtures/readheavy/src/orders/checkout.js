'use strict';

const { text, record } = require('../util/validate');
const { priceCart } = require('../cart/pricing');
const { quoteShipping } = require('../shipping/quote');
const { calculateTax } = require('../tax/calculate');
const { rateSnapshot } = require('../money/currency');
const { sumCents } = require('../money/round');
const { buildInvoice } = require('../invoice/build');
const { renderReceipt } = require('../invoice/render');

// The caller owns persistence and inventory reservation.
function checkout(catalog, request) {
  record(request, 'checkout request');
  const id = text(request.id, 'order id');
  const country = request.country || 'US';
  const cart = priceCart(catalog, request.lines, request.coupon || '');
  const delivery = quoteShipping(cart, country, request.service || 'standard');
  const tax = calculateTax(cart, delivery, country);
  const currency = rateSnapshot(request.currency || 'USD', request.rate);
  const amounts = {
    subtotal: cart.subtotal,
    discount: cart.discount,
    net: cart.net,
    shipping: delivery.cents,
    tax: tax.total,
    total: sumCents([cart.net, delivery.cents, tax.total]),
  };
  const invoice = buildInvoice({ id, cart, delivery, tax, amounts }, currency);
  return { id, cart, delivery, tax, amounts, invoice };
}

function confirmation(order) {
  return {
    subject: 'Order ' + order.id,
    body: renderReceipt(order.invoice),
  };
}

function checkoutSummary(order) {
  return {
    id: order.id,
    currency: order.invoice.currency.code,
    total: order.invoice.amounts.total,
    units: order.cart.units,
    service: order.delivery.service,
  };
}

module.exports = { checkout, confirmation, checkoutSummary };
