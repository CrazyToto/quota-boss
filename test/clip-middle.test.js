'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../scripts/lib');

test('short and non-string output passes through unchanged', () => {
  assert.equal(lib.clipMiddle('abc'), 'abc');
  assert.equal(lib.clipMiddle('x'.repeat(lib.OUTPUT_CAP)), 'x'.repeat(lib.OUTPUT_CAP));
  assert.equal(lib.clipMiddle(''), '');
  assert.equal(lib.clipMiddle(undefined), undefined);
});

test('long output keeps the first 3/4 and the last 1/4 of the limit', () => {
  const text = 'H'.repeat(5000) + 'M'.repeat(10000) + 'T'.repeat(2000);
  const clipped = lib.clipMiddle(text, 4000);
  assert.ok(clipped.startsWith('H'.repeat(3000) + '\n[... 13000 characters cut]\n'));
  assert.ok(clipped.endsWith('\n' + 'T'.repeat(1000)));
  assert.equal(clipped.length, 4000 + '\n[... 13000 characters cut]\n'.length);
});

test('default cap is 6000 characters plus the cut marker', () => {
  const clipped = lib.clipMiddle('a'.repeat(6001));
  assert.equal(clipped, 'a'.repeat(4500) + '\n[... 1 characters cut]\n' + 'a'.repeat(1500));
});
