'use strict';

const { choice } = require('../util/validate');

// The shop only serves these destinations; rates are basis points.
const RULES = {
  US: { standard: 0, exempt: 0, shipping: 0 },
  DE: { standard: 1900, exempt: 0, shipping: 1900 },
  GB: { standard: 2000, exempt: 0, shipping: 2000 },
};

function destination(country = 'US') {
  return choice(country, Object.keys(RULES), 'destination');
}

function ratesFor(country) {
  return { ...RULES[destination(country)] };
}

function lineRate(country, taxClass) {
  choice(taxClass, ['standard', 'exempt'], 'tax class');
  return ratesFor(country)[taxClass];
}

function shippingRate(country) {
  return ratesFor(country).shipping;
}

function taxLabel(country) {
  destination(country);
  return country === 'US' ? 'Sales tax' : 'VAT';
}

function taxSummary(country) {
  return {
    country: destination(country),
    label: taxLabel(country),
    rates: ratesFor(country),
  };
}

module.exports = {
  destination, ratesFor, lineRate, shippingRate, taxLabel, taxSummary,
};
