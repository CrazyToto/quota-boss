'use strict';

const { integer, array } = require('../util/validate');
const { multiplyRatio, capDeduction, sumCents } = require('../money/round');

const COUPONS = {
  SAVE10: { numerator: 10, denominator: 100 },
  FIVE: { cents: 500 },
};

function promotionDiscount(subtotal, code = '') {
  integer(subtotal, 'subtotal');
  if (code === '') return 0;
  const offer = Object.hasOwn(COUPONS, code) ? COUPONS[code] : undefined;
  if (!offer) throw new RangeError('unknown coupon ' + code);
  const requested = offer.cents === undefined
    ? multiplyRatio(subtotal, offer.numerator, offer.denominator)
    : offer.cents;
  return capDeduction(subtotal, requested);
}

// Proportional floors plus largest remainders preserve the coupon total.
function spreadDiscount(subtotals, discount) {
  array(subtotals, 'subtotals').forEach(value => integer(value, 'subtotal'));
  integer(discount, 'discount');
  const total = sumCents(subtotals);
  if (discount > total) throw new RangeError('discount exceeds subtotal');
  if (!total) return subtotals.map(() => 0);
  const shares = subtotals.map((value, index) => {
    const product = integer(value * discount, 'allocation product');
    return { index, cents: Math.floor(product / total), remainder: product % total };
  });
  let left = discount - sumCents(shares.map(share => share.cents));
  const priority = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const share of priority) {
    if (left === 0) break;
    share.cents++;
    left--;
  }
  return shares.map(share => share.cents);
}

function couponCodes() {
  return Object.keys(COUPONS).sort();
}

module.exports = { promotionDiscount, spreadDiscount, couponCodes };
