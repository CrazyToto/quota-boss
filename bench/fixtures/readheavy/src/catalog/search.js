'use strict';

const { integer, choice } = require('../util/validate');

// Search uses ASCII folding, matching the shop's imported SKU data.
function fold(value) {
  return String(value).replace(/[A-Z]/g, letter => letter.toLowerCase());
}

function search(catalog, query = '', options = {}) {
  const limit = integer(options.limit === undefined ? 20 : options.limit, 'limit');
  const sort = choice(options.sort || 'sku', ['sku', 'price'], 'sort');
  const terms = fold(query).trim().split(/\s+/).filter(Boolean);
  const products = catalog.list().filter(product => {
    if (options.inStock && product.stock === 0) return false;
    const haystack = fold(product.sku + ' ' + product.name);
    return terms.every(term => haystack.includes(term));
  });
  if (sort === 'price') {
    products.sort((left, right) => left.price - right.price || compareSku(left, right));
  }
  return products.slice(0, limit);
}

function compareSku(left, right) {
  if (left.sku < right.sku) return -1;
  if (left.sku > right.sku) return 1;
  return 0;
}

function facets(catalog) {
  const result = { physical: 0, digital: 0, available: 0 };
  for (const product of catalog.list()) {
    result[product.kind]++;
    if (product.stock > 0) result.available++;
  }
  return result;
}

function suggestions(catalog, prefix) {
  const start = fold(prefix);
  return catalog.list().filter(item => fold(item.sku).startsWith(start))
    .map(item => item.sku);
}

module.exports = { search, facets, suggestions };
