'use strict';
/** Add two numbers. */
function add(a, b) { return a + b; }
/** Arithmetic mean of an array, 0 when empty. */
function mean(values) { return values.length ? values.reduce(add, 0) / values.length : 0; }
module.exports = { add, mean };
