'use strict';

const { integer } = require('../util/validate');
const { tariffFor, weightCharge } = require('./tariff');

// Planning tools already receive kilograms from warehouse scales.
function retailEstimate(kilograms, country = 'US') {
  const tariff = tariffFor(country, 'standard');
  return tariff.base + weightCharge(kilograms, tariff.perKg);
}

function wholesaleEstimate(kilograms, parcels, country = 'US') {
  integer(parcels, 'parcels', 1);
  const tariff = tariffFor(country, 'standard');
  // The scale reading is per parcel, not a shipment-wide weight.
  const perParcel = tariff.base + weightCharge(kilograms, tariff.perKg);
  return integer(perParcel * parcels, 'shipment estimate');
}

function estimateProducts(products, country = 'US') {
  let grams = 0;
  for (const product of products) {
    integer(product.grams, 'product grams');
    integer(product.quantity, 'product quantity', 1);
    grams = integer(grams + product.grams * product.quantity, 'shipment grams');
  }
  return retailEstimate(grams / 1000, country);
}

function compareDestinations(kilograms) {
  return ['US', 'DE', 'GB'].map(country => ({
    country,
    cents: retailEstimate(kilograms, country),
  }));
}

function budgetRemaining(budget, estimate) {
  integer(budget, 'budget');
  integer(estimate, 'estimate');
  return Math.max(0, budget - estimate);
}

module.exports = {
  retailEstimate, wholesaleEstimate, estimateProducts,
  compareDestinations, budgetRemaining,
};
