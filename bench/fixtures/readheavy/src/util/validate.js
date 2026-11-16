'use strict';

// Keep boundary validation consistent across the request pipeline.
function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(name + ' must be a safe integer >= ' + min);
  }
  return value;
}

function signed(value, name) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(name + ' must be a safe integer');
  }
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(name + ' must be non-empty text');
  }
  return value.trim();
}

function choice(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new RangeError('unsupported ' + name + ': ' + value);
  }
  return value;
}

function array(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(name + ' must be an array');
  }
  return value;
}

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(name + ' must be a record');
  }
  return value;
}

module.exports = { integer, signed, text, choice, array, record };
