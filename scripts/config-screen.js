'use strict';
const lib = require('./lib');
const settings = require('./settings');
const tui = require('./tui');
const preview = require('./statusline-preview');

const onOff = value => value ? 'on' : 'off';
const firstLine = text => tui.strip(text).split(/\r?\n/, 1)[0].trim();
const confirmation = text => firstLine(text).split(/(?<=[.!?])\s/, 1)[0] || 'Applied.';

function rowsFor(values, config) {
  const toggle = (id, label, command, value = values[id]) => ({ id, label, kind: 'toggle', value, command, help: settings.helpFor(id)?.what });
  const choice = (id, label, options, names, command) => ({ id, label, kind: 'choice', value: values[id], options, names, command, help: settings.helpFor(id)?.what });
  const set = id => value => ['set', id, String(value)];
  const switchSetting = id => value => set(id)(onOff(value));
  const context = ['off', 50000, 100000, 200000, 400000];
  if (!context.includes(values.context)) context.push(values.context);
  const host = choice('host', 'Assistant', lib.HOSTS, { 'claude-code': 'Claude Code', codex: 'Codex', generic: 'Other' },
    value => ['on', '--host', value, values.profile]);
  if (!values.enabled) host.locked = 'turn boss mode on first';
  const providers = Object.entries(config.providers.providers)
    .filter(([, provider]) => provider.kind !== 'local' || provider.enabled !== false)
    .map(([id, provider]) => {
      const caps = Object.entries(config.providers.caps?.[id] || {}).filter(([, value]) => typeof value === 'number')
        .map(([window, value]) => window + ' ' + value + '%');
      const note = [provider.trainsOnData && 'trains on your data', provider.kind === 'manual' && 'manual',
        'caps: ' + (caps.join(', ') || 'none')].filter(Boolean).join(' | ');
      return { id: 'provider:' + id, label: lib.sanitizeLabel(provider.label) || id, kind: 'toggle', value: provider.enabled !== false, note,
        help: provider.kind === 'manual' ? 'Paste the prompt yourself.' : provider.tos === 'avoid' ? 'This provider is never routed automatically.' : settings.helpFor('providers.enabled')?.what,
        command: value => ['use', id, onOff(value)] };
    });
  return [
    { heading: 'Boss' },
    toggle('enabled', 'Boss mode', value => [onOff(value)]),
    choice('profile', 'Profile', lib.PROFILES, { quality: 'Quality', balanced: 'Balanced', frugal: 'Frugal' }, set('profile')),
    host,
    toggle('training', 'Training on your data', switchSetting('training')),
    choice('context', 'Fresh session hint', context, { 50000: '50k', 100000: '100k', 200000: '200k', 400000: '400k' }, set('context')),
    { heading: 'Status line' },
    choice('statusline-style', 'Style', lib.STATUSLINE_STYLES, { minimal: 'Minimal', rounded: 'Rounded', classic: 'Classic' }, set('statusline-style')),
    toggle('statusline-logos', 'Brand symbols', switchSetting('statusline-logos')),
    toggle('statusline-names', 'Provider names', switchSetting('statusline-names')),
    toggle('statusline', 'Show when boss is off', value => set('statusline')(value ? 'always' : 'boss'), values.statusline === 'always'),
    { heading: 'Providers' }, ...providers,
    { heading: 'More' },
    { id: 'setup', kind: 'action', label: 'Run the full setup' },
    { id: 'close', kind: 'action', label: 'Close' },
  ];
}

async function config(args, run, deps = {}) {
  if (args.length) throw new Error('Usage: quota-boss config');
  const interactive = deps.interactive ?? (deps.io || (process.stdin.isTTY && process.stdout.isTTY));
  if (!interactive) return (deps.table || settings.table)() + '\n\nOn a terminal, ' + lib.selfCommand('config') + ' opens the interactive list.';
  const io = deps.io || tui.open();
  const readProject = deps.readProject || lib.findProjectConfig;
  const loadConfig = deps.loadConfig || lib.loadConfig;
  const entries = deps.entries || settings.entries;
  const currentLimits = deps.currentLimits || preview.currentLimits;
  let values, numbers, previewLines, quit;
  const listIo = { ...io, key: () => quit ? 'quit' : io.key() };
  const page = {
    title: 'Settings', intro: ['Changes apply at once. Single commands: quota-boss help'],
    enter: 'change', keys: '↑↓ move   enter or space change   ←→ change   esc close', rows: [],
    get preview() {
      if (!this.rows[this.cursor]?.id?.startsWith('statusline')) return;
      const look = { style: values['statusline-style'], logos: values['statusline-logos'], names: values['statusline-names'] };
      return previewLines ??= preview.previewLines(look, values.statusline === 'always', numbers ??= currentLimits());
    },
  };
  function reload() {
    const id = page.rows[page.cursor]?.id;
    const project = readProject(), loaded = loadConfig(project);
    values = Object.fromEntries(entries(project, loaded).map(({ key, value }) => [key, value]));
    previewLines = undefined;
    page.rows = rowsFor(values, loaded);
    const index = id === undefined ? -1 : page.rows.findIndex(row => row.id === id);
    if (index >= 0) page.cursor = index;
    tui.settle(page);
  }
  async function change(row) {
    const command = row.command(row.value);
    try {
      let output;
      if (command[0] === 'use') {
        io.pause();
        try { output = await run(command, { interactive: true }); }
        finally { io.resume(); }
        const lines = String(output ?? '').trim().split(/\r?\n/);
        if (lines.length > 1) quit = (await tui.pause(io, row.label, lines)) === 'quit';
      } else output = await run(command);
      page.message = confirmation(output ?? '');
    } catch (error) {
      page.message = firstLine(error.message);
    }
    reload();
  }
  try {
    reload();
    // A quit from the provider output screen also closes settings.
    for (;;) {
      const action = await tui.list(listIo, page, change);
      if (action !== 'setup') return '';
      try {
        const setup = deps.setup || require('./setup-wizard').setup;
        const output = await setup([], run, { io });
        page.message = output ? confirmation(output) : '';
      } catch (error) {
        page.message = firstLine(error.message);
      }
      numbers = undefined;
      reload();
    }
  } finally {
    if (!deps.io) io.close();
  }
}

module.exports = { config };
