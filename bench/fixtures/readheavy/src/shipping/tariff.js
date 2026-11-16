'use strict';

const { integer, choice } = require('../util/validate');
const { destination } = require('../tax/policy');

const ZONES = {
  US: { base: 400, perKg: 100, freeAt: 5000 },
  DE: { base: 900, perKg: 200, freeAt: 10000 },
  GB: { base: 800, perKg: 150, freeAt: 10000 },
};

function serviceName(service = 'standard') {
  return choice(service, ['standard', 'express'], 'service');
}

function tariffFor(country, service = 'standard') {
  destination(country);
  serviceName(service);
  const zone = ZONES[country];
  return {
    country,
    service,
    base: zone.base + (service === 'express' ? 600 : 0),
    perKg: zone.perKg,
    freeAt: zone.freeAt,
  };
}

// Carrier invoices use whole started kilograms, never fractional charges.
function weightCharge(kilograms, perKg) {
  if (!Number.isFinite(kilograms) || kilograms < 0) {
    throw new TypeError('kilograms must be a finite non-negative number');
  }
  integer(perKg, 'per kilogram charge');
  return integer(Math.ceil(kilograms) * perKg, 'weight charge');
}

function supportedServices() {
  return ['standard', 'express'];
}

function freeThreshold(country) {
  return tariffFor(country).freeAt;
}

function qualifiesForFree(cart, tariff) {
  // Eligibility is based on merchandise before promotions.
  return tariff.service === 'standard' && cart.subtotal >= tariff.freeAt;
}

module.exports = {
  serviceName, tariffFor, weightCharge, supportedServices, freeThreshold,
  qualifiesForFree,
};
