'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tui = require('../scripts/tui');

const page = () => ({ title: 'Settings', rows: [
  { heading: 'Boss' },
  { id: 'boss', label: 'Boss mode', kind: 'toggle', value: true, help: 'Switch task routing.' },
  { id: 'hidden', label: 'Hidden option', kind: 'action', hidden: true },
  { heading: 'Status line' },
  { id: 'style', label: 'Style', kind: 'choice', value: 'minimal', options: ['minimal', 'classic'], names: { minimal: 'Minimal' } },
  { id: 'close', label: 'Close', kind: 'action' },
] });

test('render shows visible rows, values and focused help', () => {
  const screen = tui.strip(tui.render(page()));
  for (const text of ['Settings', 'Boss', '❯ Boss mode', '● on', 'Status line', 'Style', 'Minimal', 'Close', 'Switch task routing.']) assert.ok(screen.includes(text), text);
  assert.doesNotMatch(screen, /Hidden option/);
});

test('navigation skips headings and hidden rows and stops at the ends', () => {
  const p = page();
  for (const [key, cursor] of [['up', 1], ['down', 4], ['down', 5], ['down', 5], ['up', 4], ['home', 1]]) {
    assert.equal(tui.handle(p, key), null);
    assert.equal(p.cursor, cursor);
  }
});

test('toggles, choices and actions honor the keys and Enter mode', () => {
  const p = page();
  assert.deepEqual(tui.handle(p, 'enter'), { action: 'next' });
  p.enter = 'change';
  assert.equal(tui.handle(p, 'enter').changed.value, false);
  assert.equal(tui.handle(p, 'right').changed.value, true);
  assert.equal(tui.handle(p, 'space').changed.value, false);
  p.rows[1].locked = 'Locked';
  assert.equal(tui.handle(p, 'right'), null);
  tui.handle(p, 'down');
  for (const [key, value] of [['left', 'classic'], ['right', 'minimal'], ['enter', 'classic'], ['space', 'minimal']]) {
    assert.equal(tui.handle(p, key).changed.value, value);
  }
  tui.handle(p, 'end');
  assert.deepEqual(tui.handle(p, 'enter'), { action: 'close' });
  assert.deepEqual(tui.handle(p, 'back'), { action: 'back' });
});

test('scroll keeps every focused row visible through both edges', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, label: 'Row ' + i, kind: 'action' }));
  for (const leading of [[], [{ heading: 'Group' }]]) {
    const p = { title: 'Settings', rows: [...leading, ...rows], height: 14 };
    for (let i = 0; i < rows.length; i++) {
      const screen = tui.strip(tui.render(p));
      assert.match(screen, new RegExp('❯ Row ' + i + '\\n'));
      assert.ok(screen.split('\n').length <= p.height);
      tui.handle(p, 'down');
    }
  }
});

test('scripted list redraws after change and quits when keys run out', async () => {
  const io = tui.scripted(['space'], { lines: ['answer'] });
  assert.equal(await io.line('Prompt'), 'answer');
  assert.deepEqual(io.written, ['Prompt']);
  assert.equal(await tui.list(io, page(), async (_, p) => { p.message = 'Applied.'; }), 'quit');
  assert.equal(io.frames.length, 2);
  assert.match(io.screen, /○ off[\s\S]*Applied\./);
});
