'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compact } = require('../scripts/compact');
for (const [file, expected] of Object.entries({
  node: ['not ok 2 - rejects invalid input', 'AssertionError', 'at check', '# fail 1'],
  jest: ['FAIL test/parser.test.js', '● parser rejects input', 'at parser', 'Tests: 1 failed'],
  vitest: ['FAIL test/parser.test.ts', 'AssertionError', 'Test Files 1 failed'],
  pytest: ['FAILED test_parser.py::test_bad', 'AssertionError', '1 failed, 2 passed'],
  cargo: ['parser::rejects ... FAILED', 'error[E0308]', 'test result: FAILED'],
  go: ['--- FAIL: TestParser', 'parser_test.go:12', 'FAIL example/parser'],
  lint: ['error TS2322', '2:1  error', '✖ 1 problems']
})) test('compact preserves actionable ' + file + ' evidence', () => {
  const input = fs.readFileSync(path.join(__dirname, 'fixtures', 'compact', file + '.txt'), 'utf8');
  const output = compact(input);
  for (const text of expected) assert.ok(output.includes(text), text + ' missing in ' + output);
  assert.ok(output.split('\n').length <= 40);
});
test('compact bounds lines and widths, strips terminal controls and preserves final summary', () => {
  const input = '\x1b[31mnot ok 0 - red\x1b[0m\n' + Array.from({length:100}, (_,i) => 'not ok ' + (i+1) + ' - ' + 'x'.repeat(1000)).join('\n')
    + '\nError: first failure\n at first\n at second\n# tests 101\n# fail 101\n';
  const output = compact(input);
  assert.ok(output.split('\n').length <= 40);
  assert.ok(output.split('\n').every(l => l.length <= 500));
  assert.doesNotMatch(output, /\x1b/); assert.match(output, /Error: first failure/); assert.match(output, /# fail 101/);
  assert.equal(compact(''), '');
  assert.match(compact('build complete\n'), /build complete/);
});

test('compact keeps verify verdicts and reused evidence among noise', () => {
  const lines = ['[quota-boss] Check passed.', '[quota-boss] Check failed with exit code 7.', '[quota-boss] Reused: "node --test" passed on this revision; not run again.'];
  const noise = Array.from({ length: 100 }, (_, i) => 'ordinary output ' + i).join('\n');
  const output = compact(noise + '\n' + lines.join('\n') + '\n' + noise);
  for (const line of lines) assert.ok(output.split('\n').includes(line), line);
  assert.ok(output.split('\n').length <= 40);
});

test('compact keeps node spec reporter counts and the feedback line on a pass', () => {
  const input = ['✔ adds (1ms)', 'ℹ tests 16', 'ℹ suites 0', 'ℹ pass 16', 'ℹ fail 0', 'ℹ duration_ms 616.9',
    '[quota-boss] Check passed.', '[quota-boss] Feedback recorded: claude-opus-5-5 pass.'].join('\n');
  const output = compact(input);
  for (const text of ['ℹ tests 16', 'ℹ pass 16', 'ℹ fail 0', 'Check passed.', 'Feedback recorded']) assert.ok(output.includes(text), text);
  assert.ok(!output.includes('✔ adds'));
});

test('passing tests named after failures are not reported, real node spec failures are', () => {
  const input = ['✔ a failed login check is never reported (2ms)', '  ✔ HTTP 400 FAILED path (1ms)', 'ok 3 - failed input is rejected',
    '✖ parser rejects input (3ms)', '  AssertionError [ERR_ASSERTION]: expected 1', 'ℹ tests 4', 'ℹ fail 1'].join('\n');
  const output = compact(input);
  assert.ok(!output.includes('login check') && !output.includes('HTTP 400') && !output.includes('ok 3'), output);
  for (const text of ['✖ parser rejects input', 'AssertionError', 'ℹ fail 1']) assert.ok(output.includes(text), text);
});
