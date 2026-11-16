'use strict';

const { integer, choice, record } = require('../util/validate');
const { multiplyRatio } = require('./round');

const CODES = ['USD', 'EUR', 'GBP'];

function currencyCode(code) {
  return choice(code, CODES, 'currency');
}

// A rate snapshot always describes USD cents -> target cents.
function rateSnapshot(code = 'USD', rate = { numerator: 1, denominator: 1 }) {
  currencyCode(code);
  record(rate, 'rate');
  integer(rate.numerator, 'rate numerator', 1);
  integer(rate.denominator, 'rate denominator', 1);
  if (code === 'USD' && rate.numerator !== rate.denominator) {
    throw new RangeError('USD rate must be identity');
  }
  return {
    code,
    numerator: rate.numerator,
    denominator: rate.denominator,
  };
}

function convert(cents, snapshot) {
  currencyCode(snapshot.code);
  return multiplyRatio(cents, snapshot.numerator, snapshot.denominator);
}

function convertFields(amounts, snapshot) {
  const result = {};
  for (const [key, cents] of Object.entries(amounts)) {
    result[key] = convert(cents, snapshot);
  }
  return result;
}

function sameRate(left, right) {
  return left.code === right.code &&
    left.numerator * right.denominator ===
    right.numerator * left.denominator;
}

function supportedCurrencies() {
  return [...CODES];
}

module.exports = {
  currencyCode, rateSnapshot, convert, convertFields, sameRate,
  supportedCurrencies,
};
