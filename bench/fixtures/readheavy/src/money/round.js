'use strict';

const { integer, signed } = require('../util/validate');

// Integer ratios avoid carrying fractional cents between modules.
function roundRatio(numerator, denominator) {
  signed(numerator, 'numerator');
  integer(denominator, 'denominator', 1);
  return Math.round(numerator / denominator);
}

function multiplyRatio(cents, numerator, denominator) {
  signed(cents, 'cents');
  integer(numerator, 'ratio numerator');
  integer(denominator, 'ratio denominator', 1);
  const product = cents * numerator;
  signed(product, 'ratio product');
  return roundRatio(product, denominator);
}

function sumCents(values) {
  let total = 0;
  for (const value of values) {
    signed(value, 'amount');
    total += value;
    signed(total, 'running total');
  }
  return total;
}

// Used for positive balances only; signed credits have their own flow.
function capDeduction(balance, requested) {
  integer(balance, 'balance');
  integer(requested, 'deduction');
  return Math.min(balance, requested);
}

function remaining(balance, deduction) {
  return balance - capDeduction(balance, deduction);
}

module.exports = {
  roundRatio, multiplyRatio, sumCents, capDeduction, remaining,
};
