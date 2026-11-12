#!/usr/bin/env node
'use strict';
// A tiny todo list stored as JSON next to where it is run.
const fs = require('node:fs');
const path = require('node:path');

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function save(file, todos) {
  fs.writeFileSync(file, JSON.stringify(todos, null, 2) + '\n');
}

function run(args, file = path.join(process.cwd(), 'todos.json')) {
  const [command, ...rest] = args;
  const todos = load(file);
  if (command === 'add') {
    const text = rest.join(' ').trim();
    if (!text) throw new Error('Usage: todo add <text>');
    const id = todos.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    todos.push({ id, text });
    save(file, todos);
    return `Added #${id}: ${text}`;
  }
  if (command === 'list') {
    return todos.length ? todos.map(t => `#${t.id} ${t.text}`).join('\n') : 'Nothing to do.';
  }
  throw new Error('Usage: todo <add|list>');
}

if (require.main === module) {
  try { console.log(run(process.argv.slice(2))); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { run };
