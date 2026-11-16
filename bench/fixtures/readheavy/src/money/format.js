'use strict';

const { signed, integer, text } = require('../util/validate');
const { currencyCode } = require('./currency');

// Receipt output is deliberately independent of the host locale.
function decimal(cents) {
  signed(cents, 'cents');
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  return (cents < 0 ? '-' : '') + whole + '.' + fraction;
}

function formatCents(cents, code = 'USD') {
  currencyCode(code);
  return code + ' ' + decimal(cents);
}

function quantityLabel(quantity, noun) {
  integer(quantity, 'quantity');
  text(noun, 'noun');
  return quantity + ' ' + noun + (quantity === 1 ? '' : 's');
}

function amountRow(label, cents, code) {
  return text(label, 'label') + ': ' + formatCents(cents, code);
}

function padAmount(cents, width) {
  integer(width, 'width');
  return decimal(cents).padStart(width, ' ');
}

function joinRows(rows) {
  if (!Array.isArray(rows) || !rows.every(row => typeof row === 'string')) {
    throw new TypeError('rows must contain strings');
  }
  return rows.join('\n');
}

module.exports = {
  decimal, formatCents, quantityLabel, amountRow, padAmount, joinRows,
};
