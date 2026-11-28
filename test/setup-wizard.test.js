'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tui = require('../scripts/tui');
const { setup } = require('../scripts/setup-wizard');
const { retiredProviders } = require('../scripts/lib');
const { TEXT } = require('../scripts/setup-text');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

// Without a folder the wizard looks at the real working folder, where a local graphify-out/ hides the graph screen.
const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-wizard-'));
test.after(() => fs.rmSync(EMPTY_DIR, { recursive: true, force: true }));

const provider = (enabled, extra) => ({ enabled, ...extra });
const project = () => ({ enabled: false, profile: 'balanced', host: 'claude-code', allowTrainingProviders: false });
const enter = ['enter', 'enter'];
const known = ['look', 'plan:copilot', 'plan:jetbrains'];
const boss = ['on', '--host', 'claude-code', 'balanced'];

async function play(keys, { args = [], lines = [], providers = {}, programs = {}, afterInstall = {}, pending = [],
  stored = '', state = {}, newIds = [], models = {}, active = {}, userProviders = {}, plans = [], installOutput, rows = 60 } = {}) {
  const io = tui.scripted(keys, { lines, columns: 100, rows });
  const commands = [], installs = [], logged = [], keyed = [], opened = [], graphs = [], checks = [];
  let installed = false, paused = false, writes = 0;
  io.pause = () => { assert.equal(paused, false); paused = true; };
  io.resume = () => { assert.equal(paused, true); paused = false; };
  io.close = () => assert.fail('setup closed the caller terminal');
  const tools = {
    check: ids => {
      checks.push(ids);
      return ids.map(id => ({ id, state: (installed && afterInstall[id]) || programs[id] || 'ok',
        installed: '1.0', command: 'npm install ' + id, source: 'https://example.test/' + id, note: 'by hand' }));
    },
    installable: items => items.filter(item => ['missing', 'outdated', 'broken'].includes(item.state)),
    install: ids => {
      assert.ok(paused);
      installed = true;
      installs.push(...ids);
      return installOutput || ids.map(id => '- ' + id + ': done').join('\n');
    },
    pendingLogins: ids => pending.filter(login => ids.includes(login.id)),
    runLogin: id => { assert.ok(paused); logged.push(id); return { status: 0 }; },
    storedKeys: () => typeof stored === 'function' ? stored(keyed) : stored,
    runKeyLogin: id => { assert.ok(paused); keyed.push(id); },
    openPage: url => { assert.ok(paused); opened.push(url); },
  };
  const retired = retiredProviders(providers);
  const current = { ...providers };
  for (const { id } of retired) delete current[id];
  const result = await setup(args, async command => {
    if (command[0] === 'providers' || command[0] === 'use' && command[2] === 'on') assert.ok(paused);
    commands.push(command);
  }, {
    io, tools, options: { wait: () => {} }, userProviders, defaultTraining: false,
    selfTestPassed: () => false, refreshPlans: () => ({ changes: plans }), pending: () => newIds,
    readState: () => state, updateState: patch => { writes++; state = { ...state, ...patch(state) }; },
    readLook: () => ({ style: 'minimal', logos: false, names: false, always: false }),
    currentLimits: () => ({ limits: {}, thresholds: {}, sample: false }),
    setupGraph: folder => { assert.ok(paused); graphs.push(folder); return 'Code graph built locally.'; },
    config: { providers: { providers: current, retired }, models: { models } },
    project: { ...project(), directory: EMPTY_DIR, ...active },
  });
  assert.equal(paused, false);
  return { result, state, writes, io, said: [...io.frames, ...io.written].join('\n'), commands, installs, logged, keyed, opened, graphs, checks };
}

test('non-terminal setup prints the start command and changes nothing', async () => {
  const run = () => assert.fail('ran a command');
  const deps = { interactive: false, readState: () => assert.fail('read state') };
  assert.match(await setup([], run, deps), /node ".*quota-boss\.js" setup$/);
  assert.match(await setup(['--update'], run, deps), / setup --update$/);
  await assert.rejects(setup(['--bad'], run, deps), /Usage:/);
});

test('look applies immediately and updates the preview before any confirmation', async () => {
  const { result, commands, io, writes } = await play(['right', 'down', 'right', 'down', 'right', 'down', 'right', ...enter, 'quit']);
  assert.deepEqual(commands, [
    ['set', 'statusline-style', 'rounded'], ['set', 'statusline-logos', 'on'],
    ['set', 'statusline-names', 'on'], ['set', 'statusline', 'always'],
  ]);
  assert.match(io.frames[0], /\(hidden\)/);
  assert.ok(io.frames.some(frame => frame.includes('Preview') && frame.includes('Applied.') && !frame.includes('(hidden)')));
  assert.equal(result, TEXT.aborted);
  assert.equal(writes, 0);
});

test('escape returns to the previous page and preserves the work choice', async () => {
  const { commands, io } = await play(['back', 'enter', 'right', 'enter', 'back', 'enter', ...enter]);
  assert.deepEqual(commands, [['on', '--host', 'claude-code', 'frugal']]);
  assert.equal(io.frames.filter(frame => frame.includes('These choices') && frame.includes('Assistant')).length, 3);
});

test('back on Finish and Ctrl+C save nothing', async () => {
  const { result, commands, writes, installs } = await play([...enter, 'right', 'enter', 'down', 'enter', 'quit'], {
    providers: { copilot: provider(false) }, programs: { copilot: 'missing' },
  });
  assert.equal(result, TEXT.aborted);
  assert.deepEqual(commands, []);
  assert.deepEqual(installs, []);
  assert.equal(writes, 0);
});

test('one confirmation installs a CLI, enables its provider and starts login', async () => {
  const { said, commands, installs, logged, state, checks } = await play([...enter, 'right', ...enter, 'enter'], {
    providers: { copilot: provider(false) }, programs: { copilot: 'missing' }, afterInstall: { copilot: 'ok' },
    pending: [{ id: 'copilot', command: 'copilot', checkable: false, newWindow: true }],
  });
  assert.deepEqual(installs, ['copilot']);
  assert.deepEqual(logged, ['copilot']);
  assert.deepEqual(commands, [boss, ['use', 'copilot', 'on']]);
  assert.deepEqual(state.knownSetup, known);
  assert.ok(state.knownProviders.includes('copilot'));
  assert.equal(checks.length, 2);
  assert.match(said, /npm install copilot/);
  assert.match(said, /https:\/\/example\.test\/copilot/);
  assert.match(said, /Sign in 1 of 1: GitHub Copilot/);
});

test('missing programs cannot leave providers on', async () => {
  const opts = { providers: { copilot: provider(false) }, programs: { copilot: 'missing' }, installOutput: '- copilot: FAILED (EACCES)' };
  const failed = await play([...enter, 'right', ...enter], opts);
  assert.deepEqual(failed.commands, [boss]);
  assert.match(failed.said, /FAILED \(EACCES\)/);
  assert.match(failed.said, /Stayed off because the program is missing: GitHub Copilot/);
  const manual = await play([...enter, ...enter], { providers: { copilot: provider(true) }, programs: { copilot: 'manual' } });
  assert.deepEqual(manual.commands, [boss, ['use', 'copilot', 'off']]);
  assert.match(manual.said, /You install by hand: GitHub Copilot/);
});

test('new offers require OpenCode and unkeyed offers are removed after a skip', async () => {
  const picks = [...enter, 'down', 'down', 'right', ...enter, 'back'];
  const { commands, said, keyed } = await play(picks);
  assert.deepEqual(commands, [boss, ['add-api', 'openrouter-free'], ['remove-api', 'openrouter-free']]);
  assert.deepEqual(keyed, []);
  assert.match(said, /Key 1 of 1: OpenRouter Free/);
  assert.match(said, /Left out because no key was entered: OpenRouter Free/);
  const { commands: missing } = await play(picks, { programs: { opencode: 'missing' } });
  assert.deepEqual(missing, [boss]);
});

test('keys open in order, stored keys are skipped, and existing offers are kept', async () => {
  const { keyed, opened, commands, said } = await play([...enter, 'down', 'down', 'right', 'down', 'right', ...enter, 'enter', 'enter'], {
    providers: { cohere: provider(true, { custom: true }) },
    stored: keyed => keyed.join(' '),
  });
  assert.deepEqual(keyed, ['openrouter', 'cloudflare-workers-ai']);
  assert.equal(opened.length, 2);
  assert.ok(!commands.some(command => command[0] === 'remove-api'));
  assert.match(said, /Still not logged in: Cohere/);
  const stored = await play([...enter, ...enter], { providers: { cohere: provider(true, { custom: true }) }, stored: 'cohere' });
  assert.doesNotMatch(stored.said, /Key 1 of/);
});

test('training controls the ready report for a selected trainer', async () => {
  const providers = { 'kilo-free': provider(false) };
  const off = await play([...enter, 'down', 'right', ...enter], { providers });
  assert.doesNotMatch(off.said, /Free offers ready to use/);
  const on = await play([...enter, 'down', 'right', 'end', 'up', 'right', ...enter], { providers });
  assert.ok(on.commands.some(command => command.join(' ') === 'set training on'));
  assert.match(on.said, /Free offers ready to use: Kilo Free/);
  assert.match(on.said, /may train on your data/);
});

test('custom APIs validate each answer and use the provider key prompt', async () => {
  const lines = ['Bad Name', 'my-api', 'bad', 'vendor/model', 'maybe', 'n', 'y'];
  const { commands, said, keyed } = await play([...enter, 'end', 'enter', ...enter, 'enter'], { lines });
  assert.deepEqual(commands, [boss, ['add-api', 'my-api', 'vendor/model', '--trains', 'no', '--free']]);
  assert.deepEqual(keyed, ['vendor']);
  assert.match(said, /Your APIs/);
  assert.match(said, /Use lowercase letters/);
  assert.match(said, /Enter a model as provider\/model/);
  assert.match(said, /Enter y or n/);
});

test('a short Providers page shows its focused last row and a new API can be switched off', async () => {
  const { io, commands } = await play([...enter, 'end', 'enter', 'left', ...enter], {
    rows: 16, lines: ['custom-api', 'vendor/model', 'n', 'n'],
  });
  assert.ok(io.frames.some(frame => frame.includes('❯ + Add an API through OpenCode')));
  assert.deepEqual(commands, [boss]);
});

test('Ctrl+C from an API prompt aborts setup', async () => {
  const { result, commands, writes } = await play([...enter, 'end', 'enter'], { lines: ['\x03'] });
  assert.equal(result, TEXT.aborted);
  assert.deepEqual(commands, []);
  assert.equal(writes, 0);
});

test('setup removes retired APIs while keeping a paid custom API', async () => {
  const { commands } = await play([...enter, ...enter], {
    providers: {
      'zen-glm': provider(true, { custom: true, cli: { defaultModel: 'opencode/glm-5.3-flash-free' } }),
      'paid-mistral': provider(true, { custom: true, cli: { defaultModel: 'mistral/devstral' } }),
    },
    stored: 'mistral',
  });
  assert.deepEqual(commands, [boss, ['remove-api', 'zen-glm']]);
});

test('Junie Lite is preselected unless explicitly disabled', async () => {
  const providers = { 'junie-lite': provider(false, { kind: 'free' }) };
  assert.deepEqual((await play([...enter, ...enter], { providers })).commands, [boss, ['use', 'junie-lite', 'on']]);
  assert.deepEqual((await play([...enter, ...enter], { providers, userProviders: { providers } })).commands, [boss]);
  assert.deepEqual((await play([...enter, ...enter], { providers, active: { use: { providersOff: ['junie-lite'] } } })).commands, [boss]);
});

test('docs providers are tested after login and model plan changes are reported', async () => {
  const { commands, said, logged } = await play([...enter, 'right', ...enter, 'enter'], {
    providers: { jetbrains: provider(false, { evidence: 'docs', cli: { command: 'junie' } }) },
    pending: [{ id: 'junie', command: 'junie', checkable: false }],
    plans: [{ provider: 'devin', plan: 'paid', on: ['devin-swe-2-1'], off: [] }],
  });
  assert.deepEqual(commands, [boss, ['use', 'jetbrains', 'on', '--no-test'], ['providers', 'test', 'jetbrains']]);
  assert.deepEqual(logged, ['junie']);
  assert.match(said, /Models set for your plans/);
  assert.match(said, /devin-swe-2-1/);
});

test('a Junie login that stays open defers self-testing', async () => {
  const { commands, said } = await play([...enter, ...enter, 'enter'], {
    providers: { 'junie-lite': provider(false, { evidence: 'docs', cli: { command: 'junie' } }) },
    pending: [{ id: 'junie', command: 'junie', checkable: true }],
  });
  assert.deepEqual(commands, [boss, ['use', 'junie-lite', 'on', '--no-test']]);
  assert.match(said, /Still not logged in: Junie CLI/);
});

test('confirmation builds the code map and an existing map hides the row', async () => {
  const pick = ['enter', 'down', 'down', 'right', 'enter'];
  const { graphs, installs } = await play([...pick, ...enter], { programs: { graphify: 'missing' }, afterInstall: { graphify: 'ok' } });
  assert.deepEqual(graphs, [EMPTY_DIR]);
  assert.deepEqual(installs, ['graphify']);
  assert.deepEqual((await play([...pick, 'quit'])).graphs, []);
  const folder = path.join(EMPTY_DIR, 'with-graph');
  fs.mkdirSync(path.join(folder, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'graphify-out', 'graph.json'), '{}');
  const existing = await play(['enter', 'quit'], { active: { directory: folder } });
  assert.doesNotMatch(existing.said, /Code map/);
});

test('the host pool is hidden and can only be restored when usable', async () => {
  const providers = { claude: provider(false), codex: provider(true) };
  const claude = await play([...enter, ...enter], { providers });
  assert.doesNotMatch(claude.said, /Claude models \(Opus/);
  assert.deepEqual(claude.commands, [boss, ['use', 'claude', 'on']]);
  const broken = await play([...enter, ...enter], { providers, programs: { claude: 'missing' } });
  assert.deepEqual(broken.commands, [boss]);
  const codex = await play([...enter, ...enter], { providers, active: { host: 'codex' } });
  assert.doesNotMatch(codex.said, /ChatGPT \(Codex\)/);
  assert.match(codex.said, /Claude models \(Opus/);
});

test('an update with nothing new draws no frames and writes no state', async () => {
  const { result, io, writes, commands } = await play([], { args: ['--update'], state: { knownSetup: known } });
  assert.match(result, /^Quota Boss is up to date\. Nothing new to set up\. All settings: (quota-boss|node "[^"]+") config$/);
  assert.deepEqual(io.frames, []);
  assert.equal(writes, 0);
  assert.deepEqual(commands, []);
});

test('an update offers only new providers and preserves unshown choices', async () => {
  const { said, commands, state, checks } = await play(['right', ...enter], {
    args: ['--update'], newIds: ['grok'], state: { knownSetup: known, knownProviders: ['copilot'] },
    providers: { copilot: provider(true), grok: provider(false), 'junie-lite': provider(false) },
    programs: { copilot: 'broken' },
  });
  assert.deepEqual(commands, [['use', 'grok', 'on']]);
  assert.deepEqual(checks, [['grok'], ['grok']]);
  assert.doesNotMatch(said, /GitHub Copilot|Junie Lite|Choose how the status line|Assistant/);
  assert.deepEqual(state.knownProviders, ['copilot', 'grok']);
});

test('leaving Look in update mode records it before confirmation', async () => {
  const { result, state, commands } = await play(['right', 'enter', 'quit'], {
    args: ['--update'], state: { knownSetup: known.slice(1) },
  });
  assert.equal(result, TEXT.aborted);
  assert.ok(state.knownSetup.includes('look'));
  assert.deepEqual(commands, [['set', 'statusline-style', 'rounded']]);
});

test('paid plans enable pool models and free disables only models tracked by setup', async () => {
  const providers = { copilot: provider(true) };
  const models = {
    'copilot-default': { pool: 'copilot', enabled: false },
    'copilot-extra': { pool: 'copilot', enabled: false },
    'copilot-manual': { pool: 'copilot', enabled: true },
    'junie-extra': { pool: 'jetbrains', enabled: false },
  };
  const paid = await play(['right', ...enter], {
    args: ['--update'], state: { knownSetup: ['look', 'plan:jetbrains'] }, providers, models,
  });
  assert.match(paid.said, /Free or Student/);
  assert.match(paid.said, /\bPro\b/);
  assert.deepEqual(paid.commands, [['use', 'copilot-extra', 'on']]);
  assert.deepEqual(paid.state.plans, { copilot: 'pro' });
  const free = await play([...enter, 'down', 'left', ...enter], { providers, models, state: paid.state });
  assert.deepEqual(free.commands, [boss, ['use', 'copilot-extra', 'off']]);
  assert.deepEqual(free.state.plans, { copilot: 'free' });
  assert.deepEqual(free.state.planModels, { copilot: [] });
});
