'use strict';
// Keyboard-driven terminal pages for setup and config: one list of rows, like the settings page of an app.
// render() and handle() are pure, so tests drive pages without a terminal; only open() touches the real one.

const readline = require('node:readline');

const COLOR = !process.env.NO_COLOR;
const rgb = ([r, g, b]) => '38;2;' + r + ';' + g + ';' + b;
const paint = code => text => COLOR ? '\x1b[' + code + 'm' + text + '\x1b[0m' : String(text);
// Soft Catppuccin Mocha colours, the same family as the status line.
const ink = {
  bold: paint('1'), dim: paint('2'),
  accent: paint(rgb([137, 180, 250])), title: paint('1;' + rgb([137, 180, 250])),
  ok: paint(rgb([166, 227, 161])), warn: paint(rgb([249, 226, 175])), bad: paint(rgb([243, 139, 168])),
  sub: paint(rgb([127, 132, 156])), text: paint(rgb([205, 214, 244])),
};

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const strip = text => String(text).replace(ANSI, '');
const width = text => [...strip(text)].length;
const pad = (text, size) => text + ' '.repeat(Math.max(0, size - width(text)));

/** Word wrap for plain text; each line gets `indent` in front. */
function wrap(text, max, indent = '') {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line && width(line + ' ' + word) > max - indent.length) { lines.push(indent + line); line = word; }
      else line = line ? line + ' ' + word : word;
    }
    lines.push(indent + line);
  }
  return lines;
}

const focusable = row => !!row && !row.heading && !row.hidden;
const visible = row => !row.hidden;

/** Value column of one row. */
function valueText(row, focused) {
  if (row.kind === 'toggle') return row.value ? ink.ok('● on ') : ink.sub('○ off');
  if (row.kind === 'choice') {
    const name = (row.names && row.names[row.value]) || String(row.value);
    return focused ? ink.accent('‹ ') + ink.bold(name) + ink.accent(' ›') : name;
  }
  return '';
}

function rowLines(row, focused, labelWidth) {
  if (row.heading) return ['', '  ' + ink.title(row.heading)];
  const marker = focused ? ink.accent('❯ ') : '  ';
  if (row.kind === 'action') return ['  ' + marker + (focused ? ink.accent(ink.bold(row.label)) : ink.accent(row.label)) + (row.note ? '  ' + ink.sub(row.note) : '')];
  const label = focused ? ink.bold(row.label) : ink.text(row.label);
  const note = row.locked ? ink.sub(row.locked) : row.note ? ink.sub(row.note) : '';
  return ['  ' + marker + pad(label, labelWidth) + '  ' + pad(valueText(row, focused), row.kind === 'choice' ? 16 : 6) + (note ? '  ' + note : '')];
}

/** First focusable row at or after `from` in direction `step`; stays put at the ends. */
function move(rows, from, step) {
  for (let index = from + step; index >= 0 && index < rows.length; index += step) if (focusable(rows[index])) return index;
  return from;
}

/** Puts the cursor on a focusable row, also after rows appeared or vanished. */
function settle(page) {
  if (focusable(page.rows[page.cursor])) return page.cursor;
  const after = move(page.rows, (page.cursor ?? -1), 1);
  page.cursor = focusable(page.rows[after]) ? after : move(page.rows, page.rows.length, -1);
  return page.cursor;
}

/**
 * One full screen as text. page: { title, steps?, step?, intro?, rows, cursor, preview?, message?, keys?, width?, height? }.
 * A list taller than the screen scrolls with the cursor.
 */
function render(page) {
  const cols = Math.max(50, Math.min(page.width || 80, 100)) - 2;
  settle(page);
  const head = '  ' + ink.title('Quota Boss') + ink.sub('  ·  ' + page.title);
  let steps = '';
  if (page.steps) {
    steps = page.steps.map((name, index) => index < page.step ? ink.ok('✓ ' + name) : index === page.step ? ink.accent(ink.bold('● ' + name)) : ink.sub('○ ' + name)).join(ink.sub('   '));
  }
  const top = [width(head) + width(steps) + 4 <= cols ? pad(head, cols - width(steps)) + steps : head, ...(steps && width(head) + width(steps) + 4 > cols ? ['  ' + steps] : []), ink.sub('  ' + '─'.repeat(cols - 2))];
  const intro = (page.intro || []).flatMap(line => wrap(line, cols, '  ').map(text => ink.sub(text)));
  const shown = page.rows.filter(visible);
  const labelWidth = Math.min(30, Math.max(10, ...shown.filter(row => !row.heading && row.kind !== 'action').map(row => width(row.label))));
  const focused = page.rows[page.cursor];
  const body = [];
  let cursorLine = 0;
  for (const row of shown) {
    if (row === focused) cursorLine = body.length + (row.heading ? 1 : 0);
    body.push(...rowLines(row, row === focused, labelWidth));
  }
  if (body[0] === '') { body.shift(); cursorLine = Math.max(0, cursorLine - 1); }
  const preview = page.preview && page.preview.length ? ['', '  ' + ink.sub(page.previewTitle || 'Preview'), ...page.preview.map(line => '    ' + line)] : [];
  const help = focused && focused.help ? wrap(focused.help, cols, '  ').map(line => ink.text(line)) : [];
  const message = page.message ? ['  ' + ink.ok(page.message)] : [];
  const keys = '  ' + ink.sub(page.keys || '↑↓ move   space switch   ←→ change   enter continue   esc back');
  const bottom = ['', ink.sub('  ' + '─'.repeat(cols - 2)), ...help, ...message, keys];
  const fixed = top.length + (intro.length ? intro.length + 1 : 0) + preview.length + bottom.length + 1;
  const room = Math.max(5, (page.height || 40) - fixed);
  let list = body;
  if (body.length > room) {
    const start = Math.min(Math.max(0, cursorLine - Math.floor(room / 2)), body.length - room);
    const moreAbove = start > 0, moreBelow = start + room < body.length;
    list = [
      ...(moreAbove ? [ink.sub('    ↑ more')] : []),
      ...body.slice(start + Number(moreAbove), start + room - Number(moreBelow)),
      ...(moreBelow ? [ink.sub('    ↓ more')] : []),
    ];
  }
  return [...top, ...(intro.length ? [...intro, ''] : []), ...list, ...preview, ...bottom].join('\n');
}

/**
 * Applies one key to the page. Returns { changed: row } after a value change, { action: id } for an action,
 * 'next', 'back' or 'quit', or null. With page.enter === 'change' Enter switches the row instead of continuing.
 */
function handle(page, key) {
  settle(page);
  const row = page.rows[page.cursor];
  if (key === 'up' || key === 'down') { page.cursor = move(page.rows, page.cursor, key === 'up' ? -1 : 1); page.message = ''; return null; }
  if (key === 'home') { page.cursor = move(page.rows, -1, 1); return null; }
  if (key === 'end') { page.cursor = move(page.rows, page.rows.length, -1); return null; }
  if (key === 'quit') return { action: 'quit' };
  if (key === 'back') return { action: 'back' };
  if (!row) return key === 'enter' ? { action: 'next' } : null;
  if (row.kind === 'action' && (key === 'enter' || key === 'space')) return { action: row.id };
  if (key === 'enter' && page.enter !== 'change') return { action: 'next' };
  if (row.locked) return null;
  if (row.kind === 'toggle' && ['space', 'enter', 'left', 'right'].includes(key)) {
    const value = key === 'left' ? false : key === 'right' ? true : !row.value;
    if (value === row.value) return null;
    row.value = value;
    return { changed: row };
  }
  if (row.kind === 'choice' && ['space', 'enter', 'left', 'right'].includes(key)) {
    const options = row.options, at = options.indexOf(row.value);
    const next = options[(at + (key === 'left' ? -1 : 1) + options.length) % options.length];
    if (next === row.value) return null;
    row.value = next;
    return { changed: row };
  }
  return null;
}

/** Shows a page until an action. onChange(row, page) may update the page (preview, rows, message) and may be async. */
async function list(io, page, onChange) {
  for (;;) {
    page.width = io.columns(); page.height = io.rows();
    io.draw(render(page));
    const result = handle(page, await io.key());
    if (!result) continue;
    if (result.changed) { if (onChange) await onChange(result.changed, page); continue; }
    return result.action;
  }
}

/** Plain message screen that waits for Enter (or any key with anyKey). */
async function pause(io, title, lines, prompt = 'Press enter to continue') {
  io.draw(['  ' + ink.title('Quota Boss') + ink.sub('  ·  ' + title), ink.sub('  ' + '─'.repeat(Math.min(io.columns(), 100) - 4)), '',
    ...lines.flatMap(line => wrap(line, Math.min(io.columns(), 100) - 2, '  ')), '', '  ' + ink.sub(prompt)].join('\n'));
  for (;;) { const key = await io.key(); if (key === 'enter' || key === 'quit' || key === 'back') return key; }
}

/** Normalised key name from a readline keypress. */
function keyName(text, key = {}) {
  if (key.ctrl && key.name === 'c') return 'quit';
  const names = { up: 'up', down: 'down', left: 'left', right: 'right', return: 'enter', enter: 'enter', space: 'space', escape: 'back',
    tab: 'down', home: 'home', end: 'end', backspace: 'backspace', delete: 'backspace' };
  if (key.shift && key.name === 'tab') return 'up';
  if (Object.hasOwn(names, key.name)) return names[key.name];
  if (text === 'k') return 'up';
  if (text === 'j') return 'down';
  if (text === 'h') return 'left';
  if (text === 'l') return 'right';
  if (text === ' ') return 'space';
  return typeof text === 'string' && text.length === 1 && text >= ' ' ? { char: text } : null;
}

/**
 * The real terminal: raw keys, full-screen redraws and line input. pause() hands the terminal to a child process
 * (installs and logins), resume() takes it back. close() always restores the terminal.
 */
function open({ input = process.stdin, output = process.stdout } = {}) {
  const queue = [], waiting = [];
  let raw = false, closed = false;
  const push = value => { if (waiting.length) waiting.shift()(value); else queue.push(value); };
  const onKey = (text, key) => push({ name: keyName(text, key), text });
  readline.emitKeypressEvents(input);
  const setRaw = on => { if (input.isTTY && raw !== on) { input.setRawMode(on); raw = on; } };
  const start = () => { setRaw(true); input.on('keypress', onKey); input.resume(); output.write('\x1b[?25l'); };
  const stop = () => { input.removeListener('keypress', onKey); setRaw(false); input.pause(); output.write('\x1b[?25h'); };
  const restore = () => { if (!closed) { closed = true; stop(); } };
  process.once('exit', restore);
  start();
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiting.push(resolve));
  return {
    columns: () => output.columns || 80,
    rows: () => output.rows || 40,
    draw: text => output.write('\x1b[H\x1b[2J\x1b[3J' + text + '\n'),
    write: text => output.write(text + '\n'),
    async key() {
      for (;;) {
        const { name } = await next();
        if (name && typeof name === 'string' && name !== 'backspace') return name;
      }
    },
    /** Esc cancels the line. Ctrl+C can also cancel the enclosing page. */
    async line(prompt, onQuit) {
      output.write('\x1b[?25h' + prompt);
      let value = '';
      for (;;) {
        const { name, text } = await next();
        if (name === 'enter') { output.write('\n\x1b[?25l'); return value.trim(); }
        if (name === 'back' || name === 'quit') {
          output.write('\n\x1b[?25l');
          if (name === 'quit') onQuit?.();
          return '';
        }
        if (name === 'backspace') { if (value) { value = value.slice(0, -1); output.write('\b \b'); } continue; }
        const char = name && typeof name === 'object' ? name.char : name === 'space' ? ' ' : typeof text === 'string' && /^[\x20-\x7e]$/.test(text) ? text : '';
        if (char && value.length < 200) { value += char; output.write(char); }
      }
    },
    pause: () => { if (!closed) stop(); },
    resume: () => { if (!closed) start(); },
    close: () => { restore(); process.removeListener('exit', restore); },
  };
}

/** A scripted terminal for tests: keys and lines are taken in order; running out counts as quit. */
function scripted(keys = [], { lines = [], columns = 80, rows = 40 } = {}) {
  const frames = [], written = [];
  const keyQueue = [...keys], lineQueue = [...lines];
  return {
    frames, written, keysLeft: keyQueue, linesLeft: lineQueue,
    columns: () => columns, rows: () => rows,
    draw: text => frames.push(strip(text)),
    write: text => written.push(strip(text)),
    key: async () => keyQueue.length ? keyQueue.shift() : 'quit',
    line: async (prompt, onQuit) => {
      written.push(strip(prompt));
      const value = lineQueue.length ? lineQueue.shift() : '';
      if (value === '\x03' && onQuit) { onQuit(); return ''; }
      return value;
    },
    pause() {}, resume() {}, close() {},
    get screen() { return frames[frames.length - 1] || ''; },
  };
}

module.exports = { ink, strip, width, pad, wrap, render, handle, list, pause, keyName, open, scripted, settle };
