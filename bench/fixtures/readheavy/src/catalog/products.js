'use strict';

const { integer, text, choice, array, record } = require('../util/validate');

function normalizeProduct(input) {
  record(input, 'product');
  const sku = text(input.sku, 'sku');
  if (!/^[A-Z][A-Z0-9-]*$/.test(sku)) {
    throw new TypeError('sku must be uppercase letters, digits or hyphens');
  }
  const kind = choice(input.kind || 'physical', ['physical', 'digital'], 'kind');
  const grams = integer(input.grams === undefined ? 0 : input.grams, 'grams');
  if (kind === 'physical' && grams === 0) {
    throw new RangeError('physical products need a shipping weight');
  }
  if (kind === 'digital' && grams !== 0) {
    throw new RangeError('digital products cannot have a shipping weight');
  }
  return {
    sku,
    name: text(input.name, 'name'),
    price: integer(input.price, 'price'),
    stock: integer(input.stock, 'stock'),
    grams,
    kind,
    taxClass: choice(input.taxClass || 'standard', ['standard', 'exempt'], 'tax class'),
  };
}

function createCatalog(products = []) {
  array(products, 'products');
  const records = new Map();
  for (const input of products) {
    const product = normalizeProduct(input);
    if (records.has(product.sku)) throw new Error('duplicate sku ' + product.sku);
    records.set(product.sku, product);
  }
  function get(sku) {
    const product = records.get(sku);
    return product ? { ...product } : undefined;
  }
  function list() {
    return [...records.keys()].sort().map(get);
  }
  function requireProduct(sku) {
    const product = get(sku);
    if (!product) throw new Error('unknown sku ' + sku);
    return product;
  }
  return { get, list, requireProduct };
}

module.exports = { normalizeProduct, createCatalog };
