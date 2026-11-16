'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Tasks
const SMALL = 'In src/math.js add and export clamp(value, min, max). It returns min when value is below min, max when value is above max, otherwise value, and throws a RangeError when min is greater than max. Add tests to test/math.test.js and run the tests.';
const MEDIUM = 'Add a small task tracker to this project. src/store.js exports createStore(filePath) with add(title) returning {id, title, done: false}, list(filter) where filter.done true or false limits the result and an empty filter returns all, complete(id) which throws an Error for an unknown id, and remove(id) returning true or false. Tasks persist as JSON in filePath. Ids start at 1, increase by one and are never reused, not even after a remove and after reopening the file. src/report.js exports summary(tasks) returning {total, done, open, percentDone} where percentDone is a rounded integer and 0 for an empty list. src/cli.js runs as: node src/cli.js <file> add <title words...> | list [--done|--open] | complete <id> | remove <id> | report. list prints one line per task as "<id> [x] <title>" for done and "<id> [_] <title>" for open. report prints "total=N done=N open=N percent=N". An unknown command or unknown id prints a message on stderr and exits with code 1. Add tests under test/ for all three modules and run them.';
const TRIVIAL = ' Also do these small chores: rename padLeft in src/format.js to alignRight with the same behavior; add a JSDoc comment above every function in src/math.js; in package.json add "description": "Small task tracker" and "bin": {"tasks": "src/cli.js"}; write README.md with a "## Usage" section that shows one example line per CLI command in the form "node src/cli.js tasks.json <command> ...".';
const prompts = { small: SMALL, medium: MEDIUM, mixed: MEDIUM + TRIVIAL };

function setup(dir, task) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  const put = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  put('package.json', '{ "name": "bench-fixture", "version": "1.0.0", "private": true, "scripts": { "test": "node --test" } }\n');
  put('src/math.js', "'use strict';\nfunction add(a, b) { return a + b; }\nfunction mean(values) { return values.length ? values.reduce(add, 0) / values.length : 0; }\nmodule.exports = { add, mean };\n");
  put('src/format.js', "'use strict';\nfunction padLeft(text, width) { return String(text).padStart(width, ' '); }\nfunction percent(value) { return Math.round(value * 100) + '%'; }\nmodule.exports = { padLeft, percent };\n");
  put('test/math.test.js', "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { add, mean } = require('../src/math.js');\ntest('add', () => assert.equal(add(2, 3), 5));\ntest('mean', () => assert.equal(mean([2, 4]), 3));\n");
  if (fixtures[task]) {
    for (const [name, text] of Object.entries(fixtures[task])) put(name, text);
  }
}

const fixtures = {};
const bugSource = `function unique(values) { return [...new Set(values)].filter(Boolean); }
function average(values) { return values.reduce((a,b) => a+b, 0) / values.length; }
function sortNumbers(values) { return values.sort(); }
module.exports = { unique, average, sortNumbers };\n`;
const refSource = `function summarize(values) { const valid = values.filter(Number.isFinite); const total = valid.reduce((a,b) => a+b,0); const count = valid.length; const mean = count ? total/count : 0; const min = count ? Math.min(...valid) : null; const max = count ? Math.max(...valid) : null; return {count,total,mean,min,max}; }
module.exports = { summarize };\n`;
const docSource = `function greet(name) { return 'Hello, ' + name + '!'; }
function repeat(text, count) { return String(text).repeat(count); }
module.exports = { greet, repeat };\n`;
Object.assign(fixtures, {
  bugfix: {
    'src/collection.js': bugSource,
    'ISSUE.md': 'unique drops 0/false/empty strings. average([]) returns NaN instead of 0. sortNumbers sorts lexically and mutates its input. Fix all three while preserving other behavior.\n',
  },
  refactor: { 'src/stats.js': refSource },
  docs: { 'src/greetings.js': docSource },
});
Object.assign(prompts, {
  bugfix: 'Fix the three bugs described in ISSUE.md in src/collection.js. unique must preserve first occurrence order including falsy values; average([]) is 0; sortNumbers returns ascending numeric order without mutating input. Add regression tests and run them.',
  refactor: 'Refactor summarize in src/stats.js into named exported helpers selectFinite(values), totalOf(values), and boundsOf(values) returning {min,max} (null bounds for empty). summarize must call these helpers and preserve its exact behavior. Add tests and run them.',
  docs: 'Document src/greetings.js without changing behavior. Add a JSDoc block immediately above every exported function with @param for each parameter and @returns. Write README.md with ## Overview, ## API, and ## Examples. Include runnable JavaScript fenced examples using require(\'./src/greetings\') and node:assert to verify both exported functions. Add tests and run them.',
});

// A large multi-file feature (10+ minutes for one strong model) with independent parts a boss can hand out.
const LARGE = [
  'Build a small inventory tool in this project. All money values are integer cents. Use only Node built-ins.',
  'src/csv.js exports parseCsv(text) and stringifyCsv(rows, columns). parseCsv uses the first line as the header and returns one object per data line, keyed by header names; it accepts \\n and \\r\\n line ends, skips empty lines, supports fields in double quotes that contain commas, newlines and doubled quotes (""), and throws an Error whose message contains "line N" (N = 1-based line number in the text) when a line has a different number of fields than the header. stringifyCsv returns the header line and one line per row, joined with \\n and without a trailing newline, and wraps a field in double quotes (doubling inner quotes) only when it contains a comma, a double quote or a newline.',
  'src/inventory.js exports createInventory(items = []). The inventory has addItem({sku, name, price, qty}), get(sku) (undefined when missing), adjust(sku, delta) returning the new qty, list() sorted by sku, toJSON() returning the item array, and importCsv(text). sku must match /^[A-Z]{3}-\\d{3}$/, name a non-empty string, price a positive integer, qty an integer >= 0; invalid values throw a TypeError, a duplicate sku throws an Error. adjust throws an Error for an unknown sku and a RangeError when the qty would drop below 0. importCsv reads the columns sku,name,price,qty (price and qty as numbers) and returns {added, errors} where errors is [{line, message}] with the 1-based line in the CSV text (the header is line 1); a bad row does not stop the import and adds nothing.',
  'src/pricing.js exports quote(inventory, lines, options = {}) where lines is [{sku, qty}]. It returns {lines: [{sku, qty, unit, total}], subtotal, discount, tax, total}. A line with qty >= 10 gets 10% off its total, rounded to the nearest cent. subtotal is the sum of line totals. options.coupon "SAVE5" takes 500 off the subtotal (never below 0), "HALF" takes 50% (rounded to the nearest cent); any other coupon throws an Error. tax is 8% of (subtotal - discount), rounded to the nearest cent; total = subtotal - discount + tax. An unknown sku throws an Error, a qty above the stock throws a RangeError, and a qty that is not a positive integer throws a TypeError. quote never changes stock.',
  'src/report.js exports formatCents(cents) returning "$12.34" style text ("-$0.05" for negative values) and stockReport(items, lowStock = 5) returning {items, units, value, low} where value is the sum of price * qty and low is the sorted skus with qty below lowStock.',
  'src/cli.js runs as: node src/cli.js <db.json> import <file.csv> | list | quote <sku>:<qty>... [--coupon CODE] | report. The inventory is stored as JSON in db.json (a missing file means an empty inventory). import prints "added=N errors=M" and then one line "line L: <message>" per error, and exits 0. list prints one line per item: "<sku> <qty> <price as formatCents> <name>". quote prints "total=<formatCents>" and exits 0. report prints "items=N units=N value=<formatCents> low=<skus joined with commas, or - when none>". Any error (unknown command, bad arguments, unknown sku, too little stock) prints a message on stderr and exits with code 1.',
  'Add tests under test/ for every module and run them.',
].join(' ');
const LARGE_CHORES = ' Also do these small chores: rename padLeft in src/format.js to alignRight with the same behavior; add a JSDoc comment above every function in src/math.js; in package.json add "description": "Small inventory tool" and "bin": {"inventory": "src/cli.js"}; write README.md with a "## Usage" section that shows one example line per CLI command in the form "node src/cli.js db.json <command> ...".';
prompts.large = LARGE + LARGE_CHORES;

module.exports = { prompts, setup, fixtures };
