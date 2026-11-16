'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = function (dir, { check, eq }) {
  // Parse data rather than require it: malformed submissions must still get nine checks.
  let answers = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'answers.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) answers = parsed;
  } catch { /* Missing or invalid JSON fails each check below. */ }

  const expected = {
    q1: 8192,
    q2: 'rfc3339',
    q3: 2400,
    q4: 'ndjson',
    q5: 3,
    q6: 1875,
    q7: 'QV_ELEASE_SCOPE',
    q8: ['cache.trustMtime', 'network.legacyProxy', 'output.colorMode'],
  };
  const entry = key => {
    const value = answers && answers[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('missing or invalid ' + key);
    }
    return value;
  };
  const normalize = (value, model) => {
    if (typeof model === 'number') {
      if (!Number.isInteger(value)) throw new Error('answer must be an integer');
      return value;
    }
    if (typeof model === 'string') {
      if (typeof value !== 'string') throw new Error('answer must be a string');
      return value.trim().toLowerCase();
    }
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
      throw new Error('answer must be a list of strings');
    }
    // Compare as a sorted list, preserving duplicates so extras cannot pass.
    return value.map(item => item.trim().toLowerCase()).sort();
  };

  for (const [key, value] of Object.entries(expected)) {
    check(key, () => eq(normalize(entry(key).answer, value), normalize(value, value)));
  }
  check('sources', () => {
    const docs = fs.realpathSync(path.join(dir, 'docs'));
    for (const key of Object.keys(expected)) {
      const source = entry(key).source;
      // Accept portable relative paths only; reject traversal, drives and backslashes.
      if (typeof source !== 'string' || !/^docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(source)) {
        throw new Error('invalid source for ' + key);
      }
      const file = fs.realpathSync(path.resolve(dir, source));
      const relative = path.relative(docs, file);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.statSync(file).isFile()) {
        throw new Error('source must be an existing file under docs/ for ' + key);
      }
    }
  });
};
