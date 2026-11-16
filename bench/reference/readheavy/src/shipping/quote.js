'use strict';

const { integer } = require('../util/validate');
const { tariffFor, weightCharge, qualifiesForFree } = require('./tariff');

function quoteShipping(cart, country = 'US', service = 'standard') {
  const tariff = tariffFor(country, service);
  integer(cart.grams, 'packed grams');
  integer(cart.subtotal, 'subtotal');
  if (cart.grams === 0) {
    return { country, service, cents: 0, reason: 'no-parcel', grams: 0 };
  }
  if (qualifiesForFree(cart, tariff)) {
    return { country, service, cents: 0, reason: 'threshold', grams: cart.grams };
  }
  const variable = weightCharge(cart.grams / 1000, tariff.perKg);
  return {
    country,
    service,
    cents: integer(tariff.base + variable, 'shipping cents'),
    reason: 'tariff',
    grams: cart.grams,
  };
}

function deliveryChoices(cart, country = 'US') {
  return ['standard', 'express'].map(service => quoteShipping(cart, country, service));
}

function shippingSummary(delivery) {
  return {
    country: delivery.country,
    service: delivery.service,
    cents: delivery.cents,
    free: delivery.cents === 0,
  };
}

module.exports = {
  qualifiesForFree, quoteShipping, deliveryChoices, shippingSummary,
};
