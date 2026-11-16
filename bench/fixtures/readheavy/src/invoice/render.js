'use strict';

const { convert } = require('../money/currency');
const { formatCents, quantityLabel, joinRows } = require('../money/format');

function receiptAmount(cents, invoice) {
  const billed = convert(cents, invoice.currency);
  return formatCents(billed, invoice.currency.code);
}

function receiptLines(invoice) {
  return invoice.lines.map(line => {
    const quantity = quantityLabel(line.quantity, 'unit');
    return line.sku + ' ' + quantity + ' - ' + receiptAmount(line.net, invoice);
  });
}

function receiptTotals(invoice) {
  const values = invoice.amounts;
  return [
    'Subtotal: ' + receiptAmount(values.subtotal, invoice),
    'Discount: ' + receiptAmount(values.discount, invoice),
    'Shipping: ' + receiptAmount(values.shipping, invoice),
    invoice.taxLabel + ': ' + receiptAmount(values.tax, invoice),
    'Total: ' + receiptAmount(values.total, invoice),
  ];
}

// A receipt can be regenerated from a stored invoice without a catalog.
function renderReceipt(invoice) {
  return joinRows([
    'Order ' + invoice.id,
    ...receiptLines(invoice),
    ...receiptTotals(invoice),
  ]);
}

function deliveryLabel(invoice) {
  return invoice.delivery.service + ' / ' + invoice.delivery.country;
}

function receiptDocument(invoice) {
  return { title: 'Receipt ' + invoice.id, text: renderReceipt(invoice) };
}

module.exports = {
  renderReceipt, receiptLines, receiptTotals, deliveryLabel, receiptDocument,
};
