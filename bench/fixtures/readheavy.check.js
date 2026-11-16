'use strict';

module.exports = function (dir, { check, eq, throwsType, load }) {
  // Load within each check so a broken public module yields counted failures.
  const catalog = () => load('src/catalog/products.js').createCatalog([
    { sku: 'MUG', name: 'Stoneware Mug', price: 2000, stock: 20, grams: 750 },
    { sku: 'KIT', name: 'Tea Kit', price: 2000, stock: 20, grams: 1250 },
    { sku: 'PDF', name: 'Recipe Book', price: 1000, stock: 99, kind: 'digital' },
    { sku: 'ODD', name: 'Small Guide', price: 101, stock: 99, kind: 'digital' },
  ]);
  const order = (options = {}) => load('src/orders/checkout.js').checkout(catalog(), {
    id: 'C-1', lines: [{ sku: 'PDF', quantity: 1 }], ...options,
  });
  const foreign = (code, numerator, denominator, options = {}) => order({
    currency: code, rate: { numerator, denominator }, ...options,
  });
  const receipt = invoice => load('src/invoice/render.js').renderReceipt(invoice);

  // Signed half-cent symptoms across three consumers of the common money path.
  check('refund-half', () => {
    const refunds = load('src/orders/refund.js');
    eq(refunds.refundAmount(101, 1, 2), -51);
    eq(refunds.refundRequest([
      { sku: 'ODD', charged: 303, quantity: 2 },
    ], { ODD: 1 }), { entries: [{ sku: 'ODD', quantity: 1, cents: -152 }], total: -152 });
  });
  check('credit-half', () => {
    const products = load('src/catalog/products.js').createCatalog([
      { sku: 'NOTE', name: 'Notebook Download', price: 103, stock: 10, kind: 'digital' },
    ]);
    const invoice = load('src/orders/checkout.js').checkout(products, {
      id: 'C-2', lines: [{ sku: 'NOTE', quantity: 2 }], coupon: 'SAVE10',
    }).invoice;
    const credit = load('src/invoice/credit.js');
    const note = credit.creditNote(invoice, { NOTE: 1 });
    eq(note.total, -93);
    eq(credit.creditSummary(note), 'Credit C-2: USD -0.93');
  });
  check('credit-fx', () => {
    const money = load('src/money/currency.js');
    const rate = money.rateSnapshot('EUR', { numerator: 1, denominator: 2 });
    eq(money.convert(-101, rate), -51);
    eq(money.convert(-103, rate), -52);
    eq(money.convert(101, rate), 51);
  });

  check('parcel-light', () => {
    const cart = load('src/cart/pricing.js').priceCart(catalog(), [{ sku: 'MUG', quantity: 1 }]);
    eq(load('src/shipping/quote.js').quoteShipping(cart), {
      country: 'US', service: 'standard', cents: 500, reason: 'tariff', grams: 750,
    });
  });
  check('parcel-step', () => {
    const cart = load('src/cart/pricing.js').priceCart(catalog(), [{ sku: 'KIT', quantity: 1 }]);
    const quotes = load('src/shipping/quote.js').deliveryChoices(cart);
    eq(quotes.map(quote => quote.cents), [600, 1200]);
    eq(quotes.map(quote => quote.grams), [1250, 1250]);
  });
  check('parcel-order', () => {
    const result = order({ lines: [{ sku: 'MUG', quantity: 1 }] });
    eq(result.amounts.shipping, 500);
    eq(result.amounts.total, 2500);
    eq(result.invoice.amounts.total, 2500);
  });

  check('receipt-eur', () => {
    const result = foreign('EUR', 9, 10);
    eq(receipt(result.invoice), [
      'Order C-1', 'PDF 1 unit - EUR 9.00', 'Subtotal: EUR 9.00',
      'Discount: EUR 0.00', 'Shipping: EUR 0.00', 'Sales tax: EUR 0.00',
      'Total: EUR 9.00',
    ].join('\n'));
    eq(result.invoice.amounts.total, 900);
  });
  check('receipt-gbp', () => {
    const result = foreign('GBP', 4, 5, { coupon: 'SAVE10' });
    eq(load('src/orders/checkout.js').confirmation(result).body, [
      'Order C-1', 'PDF 1 unit - GBP 7.20', 'Subtotal: GBP 8.00',
      'Discount: GBP 0.80', 'Shipping: GBP 0.00', 'Sales tax: GBP 0.00',
      'Total: GBP 7.20',
    ].join('\n'));
    eq(result.invoice.amounts.total, 720);
  });
  check('receipt-tax', () => {
    const invoice = foreign('EUR', 3, 2, { country: 'DE', lines: [
      { sku: 'PDF', quantity: 2 }, { sku: 'ODD', quantity: 1 },
    ] }).invoice;
    // Serialization is the persistence boundary between building and printing.
    eq(receipt(JSON.parse(JSON.stringify(invoice))), [
      'Order C-1', 'PDF 2 units - EUR 30.00', 'ODD 1 unit - EUR 1.52',
      'Subtotal: EUR 31.52', 'Discount: EUR 0.00', 'Shipping: EUR 0.00',
      'VAT: EUR 5.99', 'Total: EUR 37.50',
    ].join('\n'));
  });

  check('free-policy', () => {
    const result = order({ lines: [
      { sku: 'MUG', quantity: 2 }, { sku: 'PDF', quantity: 1 },
    ], coupon: 'SAVE10' });
    eq([result.cart.subtotal, result.cart.net], [5000, 4500]);
    eq([result.delivery.cents, result.delivery.reason], [0, 'threshold']);
    eq(result.amounts.total, 4500);
  });
  check('tariff-callers', () => {
    const estimates = load('src/shipping/estimate.js');
    eq(estimates.retailEstimate(0.75, 'US'), 500);
    eq(estimates.wholesaleEstimate(1.25, 3, 'US'), 1800);
    eq(estimates.estimateProducts([{ grams: 750, quantity: 2 }], 'DE'), 1300);
  });

  check('stock', () => {
    const products = catalog();
    const pricing = load('src/cart/pricing.js');
    const lines = [{ sku: 'MUG', quantity: 2 }, { sku: 'MUG', quantity: 1 }];
    const before = JSON.stringify(lines);
    const cart = pricing.priceCart(products, lines);
    eq([cart.lines.length, cart.units, cart.grams, cart.subtotal], [1, 3, 2250, 6000]);
    eq(JSON.stringify(lines), before);
    eq(products.get('MUG').stock, 20);
    throwsType(() => pricing.priceCart(products, [{ sku: 'MUG', quantity: 21 }]), RangeError);
    throwsType(() => pricing.priceCart(products, [{ sku: 'MUG', quantity: 1.5 }]), TypeError);
  });
  check('coupon', () => {
    const promo = load('src/cart/promotions.js');
    eq(promo.promotionDiscount(101, 'SAVE10'), 10);
    eq(promo.promotionDiscount(100, 'FIVE'), 100);
    eq(promo.spreadDiscount([101, 202, 303], 101), [17, 34, 50]);
    eq(promo.spreadDiscount([0, 0], 0), [0, 0]);
    throwsType(() => promo.promotionDiscount(100, 'OTHER'), RangeError);
  });
  check('tax', () => {
    const result = order({ country: 'DE', lines: [{ sku: 'PDF', quantity: 1 }] });
    eq([result.tax.merchandise, result.tax.shipping, result.tax.total], [190, 0, 190]);
    eq(result.amounts.total, 1190);
    eq(load('src/tax/calculate.js').taxAmount(101, 5000), 51);
    eq(order({ lines: [] }).amounts.total, 0);
  });
  check('snapshots', () => {
    const eur = foreign('EUR', 9, 10).invoice;
    const usd = order().invoice;
    eq(load('src/report/sales.js').salesByCurrency([usd, eur, eur]), [
      { currency: 'EUR', orders: 2, units: 2, total: 1800, tax: 0 },
      { currency: 'USD', orders: 1, units: 1, total: 1000, tax: 0 },
    ]);
    const copy = load('src/invoice/build.js').copyInvoice(eur);
    copy.amounts.total = 1;
    copy.lines[0].net = 1;
    eq([eur.amounts.total, eur.lines[0].net], [900, 900]);
    eq(receipt(usd).split('\n').at(-1), 'Total: USD 10.00');
    const format = load('src/money/format.js');
    eq([format.formatCents(-5), format.formatCents(0)], ['USD -0.05', 'USD 0.00']);
  });
};
