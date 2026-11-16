'use strict';

const { text } = require('../util/validate');
const { rateSnapshot, convert, convertFields } = require('../money/currency');

// All monetary fields in this snapshot are already in the billing currency.
function buildInvoice(order, currency) {
  const snapshot = rateSnapshot(currency.code, currency);
  const amounts = convertFields(order.amounts, snapshot);
  const lines = order.cart.lines.map(line => ({
    sku: line.sku,
    name: line.name,
    quantity: line.quantity,
    unit: convert(line.unit, snapshot),
    subtotal: convert(line.subtotal, snapshot),
    discount: convert(line.discount, snapshot),
    net: convert(line.net, snapshot),
  }));
  return {
    id: text(order.id, 'invoice id'),
    currency: snapshot,
    lines,
    amounts,
    delivery: {
      country: order.delivery.country,
      service: order.delivery.service,
    },
    taxLabel: order.tax.label,
  };
}

function invoiceSummary(invoice) {
  return {
    id: invoice.id,
    currency: invoice.currency.code,
    lines: invoice.lines.length,
    total: invoice.amounts.total,
  };
}

function copyInvoice(invoice) {
  return {
    ...invoice,
    currency: { ...invoice.currency },
    lines: invoice.lines.map(line => ({ ...line })),
    amounts: { ...invoice.amounts },
    delivery: { ...invoice.delivery },
  };
}

module.exports = { buildInvoice, invoiceSummary, copyInvoice };
