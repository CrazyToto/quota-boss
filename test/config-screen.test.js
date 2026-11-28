'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../scripts/config-screen');
const tui = require('../scripts/tui');

const down = count => Array(count).fill('down');
function fixture(keys, { fail, output = 'Applied. More detail.\nSecond line.' } = {}) {
  const io = tui.scripted(keys), calls = [], terminal = [];
  const values = { enabled: true, profile: 'balanced', host: 'claude-code', training: false, context: 75000,
    statusline: 'always', 'statusline-style': 'minimal', 'statusline-logos': true, 'statusline-names': true };
  const providers = {
    sample: { enabled: false, kind: 'manual', trainsOnData: true },
    local: { enabled: false, kind: 'local' },
  };
  io.pause = () => terminal.push('pause');
  io.resume = () => terminal.push('resume');
  io.close = () => terminal.push('close');
  let reads = 0;
  const deps = {
    io, readProject: () => values,
    loadConfig: () => ({ providers: { providers, caps: { sample: { daily: 80, weekly: null } } } }),
    entries: project => Object.entries(project).map(([key, value]) => ({ key, value })),
    currentLimits: () => { reads++; return { limits: {}, thresholds: {}, sample: true }; },
  };
  const run = async (args, options) => {
    calls.push(args);
    const [command, key, value] = args;
    if (command === 'use') {
      assert.deepEqual(options, { interactive: true });
      terminal.push('use');
    }
    if (fail === command) throw new Error('Could not apply.\nMore detail.');
    if (command === 'set') {
      values[key] = key === 'context' && value !== 'off' ? Number(value)
        : ['training', 'statusline-logos', 'statusline-names'].includes(key) ? value === 'on' : value;
    }
    if (command === 'on' || command === 'off') values.enabled = command === 'on';
    if (key === '--host') values.host = value;
    if (command === 'use') providers[key].enabled = value === 'on';
    return output;
  };
  return { io, deps, run, calls, terminal, values, reads: () => reads };
}

test('boss settings apply immediately and Assistant is locked while off', async () => {
  const f = fixture(['enter', ...down(2), 'enter', 'home', 'right', 'down', 'right', 'down', 'enter',
    'down', 'space', 'down', 'right', 'right', 'back']);
  assert.equal(await config([], f.run, f.deps), '');
  assert.deepEqual(f.calls, [['off'], ['on'], ['set', 'profile', 'frugal'], ['on', '--host', 'codex', 'frugal'],
    ['set', 'training', 'on'], ['set', 'context', 'off'], ['set', 'context', '50000']]);
  assert.ok(f.io.frames.some(frame => frame.includes('turn boss mode on first')));
  assert.ok(f.io.frames.some(frame => frame.includes('‹ 75000 ›')));
  assert.match(f.io.screen, /50k[\s\S]*Applied\./);
  assert.doesNotMatch(f.io.screen, /More detail|Second line/);
  assert.deepEqual(f.terminal, []);
});

test('status line settings update the preview only while that group is focused', async () => {
  const f = fixture([...down(5), 'right', 'down', 'enter', 'down', 'left', 'down', 'space', 'down', 'back']);
  await config([], f.run, f.deps);
  assert.deepEqual(f.calls, [['set', 'statusline-style', 'rounded'], ['set', 'statusline-logos', 'off'],
    ['set', 'statusline-names', 'off'], ['set', 'statusline', 'boss']]);
  const previews = f.io.frames.filter(frame => frame.includes('Preview'));
  assert.notEqual(previews[0].split('Preview')[1].split('boss on')[0], previews[1].split('Preview')[1].split('boss on')[0]);
  assert.match(previews.at(-1), /\(hidden\) +boss off/);
  assert.doesNotMatch(f.io.frames[0], /Preview/);
  assert.doesNotMatch(f.io.screen, /Preview/);
  assert.equal(f.reads(), 1);
});

test('provider changes hand off the terminal and show multiline output', async () => {
  const f = fixture([...down(9), 'enter', 'enter', 'left', 'enter', 'back']);
  await config([], f.run, f.deps);
  assert.deepEqual(f.calls, [['use', 'sample', 'on'], ['use', 'sample', 'off']]);
  assert.deepEqual(f.terminal, ['pause', 'use', 'resume', 'pause', 'use', 'resume']);
  assert.match(f.io.frames[0], /sample +○ off +trains on your data \| manual \| caps: daily 80%/);
  assert.doesNotMatch(f.io.frames[0], /\blocal\b/);
  assert.ok(f.io.frames.some(frame => frame.includes('Second line.') && frame.includes('Press enter to continue')));
});

test('a failed provider change restores the value and terminal and shows the error', async () => {
  const f = fixture([...down(9), 'space', 'back'], { fail: 'use' });
  await config([], f.run, f.deps);
  assert.deepEqual(f.calls, [['use', 'sample', 'on']]);
  assert.deepEqual(f.terminal, ['pause', 'use', 'resume']);
  assert.match(f.io.screen, /❯ sample +○ off[\s\S]*Could not apply\./);
  assert.doesNotMatch(f.io.screen, /More detail/);
});

test('full setup borrows the terminal and settings reload before Close', async () => {
  const f = fixture(['end', 'up', 'enter', 'down', 'enter']);
  let setupCalls = 0;
  f.deps.setup = async (args, run, { io }) => {
    setupCalls++;
    assert.deepEqual(args, []);
    assert.equal(run, f.run);
    assert.equal(io, f.io);
    await run(['set', 'profile', 'quality']);
    return 'Setup complete.';
  };
  assert.equal(await config([], f.run, f.deps), '');
  assert.equal(setupCalls, 1);
  assert.match(f.io.screen, /Profile +Quality/);
  assert.ok(f.io.frames.some(frame => frame.includes('Setup complete.')));
  assert.deepEqual(f.terminal, []);
});

test('non-interactive config returns the settings table with a terminal hint', async () => {
  const f = fixture(['enter']);
  assert.equal(await config([], f.run, { ...f.deps, interactive: false, table: () => 'Settings table' }),
    'Settings table\n\nOn a terminal, quota-boss config opens the interactive list.');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.io.frames, []);
});
