'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./todo');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-')), 'todos.json');
}

test('add stores a todo with the next id', () => {
  const file = tempFile();
  assert.equal(run(['add', 'buy', 'milk'], file), 'Added #1: buy milk');
  assert.equal(run(['add', 'call', 'Sam'], file), 'Added #2: call Sam');
});

test('list shows todos or says there is nothing to do', () => {
  const file = tempFile();
  assert.equal(run(['list'], file), 'Nothing to do.');
  run(['add', 'water', 'plants'], file);
  assert.equal(run(['list'], file), '#1 water plants');
});

test('add without text and unknown commands explain the usage', () => {
  const file = tempFile();
  assert.throws(() => run(['add'], file), /Usage: todo add/);
  assert.throws(() => run(['nope'], file), /Usage: todo/);
});
