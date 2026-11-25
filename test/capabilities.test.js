'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('../scripts/lib');
const { route, routeTable, formatTable, formatExplain } = require('../scripts/route');
const cli = require('../scripts/quota-boss');
const shipped = require('../config/models.json');
const now = 1000000000;
const fingerprint = () => lib.cliFingerprint('trial', () => process.execPath);
const pass = (tier = 'normal', extra = {}) => ({ t: now, model: 'tiny', category: 'implementation', tier, result: 'pass', ...extra });

function fixture(evidence = 'real') {
  return { host: 'generic', now, findExecutable: () => process.execPath,
    providers: { providers: { trial: { label: 'Trial', kind: 'api', enabled: true, worker: 'cli-worker', evidence,
      quota: { source: 'none' }, cli: { command: 'trial', args: ['{prompt}'] } } } },
    models: { categories: ['implementation'], models: { tiny: { pool: 'trial', label: 'Tiny', cost: 1, scores: { implementation: 10 } } } },
    selfTests: { tiny: { result: 'pass', cli: fingerprint() } } };
}
const candidate = (input, tier = 'trivial') => route(input).candidates.find(c => c.model === 'tiny' && c.tier === tier);
const wins = (input, tier) => route(input).rows.some(c => c.model === 'tiny' && c.tier === tier);

test('shipped capabilities are documented, with a source for every claim', () => {
  const documented = { 'claude-fable-5-2': 1000000, 'claude-opus-5-5': 1000000, 'claude-sonnet-5-5': 1000000, 'claude-haiku-5-5': 1000000,
    'gpt-6.2-astra': 272000, 'gpt-6.2-sol': 500000, 'gpt-6.1-sol': 500000, 'grok-4.7': 500000, 'gemini-4-argon': 1000000, 'gemini-media-3.8-flash': 1048576, 'devin-swe-2-flash': 262144 };
  for (const [id, model] of Object.entries(shipped.models)) {
    assert.equal(model.contextTokens, documented[id], id);
    assert.equal(model.webSearch, undefined);
    if (model.inputs || model.tools || model.contextTokens) assert.match(model.capabilitySource, /\S/, id);
    if (model.pool === 'claude') {
      assert.deepEqual([model.inputs, model.tools], [['text', 'image', 'pdf'], ['web-search']]);
    } else if (model.pool === 'codex') {
      assert.deepEqual([model.inputs, model.tools], [['text', 'image'], ['image-gen', 'web-search']]);
    } else if (model.pool === 'antigravity') {
      assert.deepEqual([model.inputs, model.tools], [undefined, ['web-search']]);
    } else if (model.pool === 'gemini-media') {
      assert.deepEqual([model.inputs, model.tools, model.specialist, model.cost], [['text', 'image', 'pdf', 'video', 'audio'], undefined, true, 0]);
    } else {
      assert.deepEqual([model.inputs, model.tools], [undefined, undefined], id);
    }
  }
});

for (const input of ['image', 'pdf', 'video', 'audio']) {
  test(input + ' needs both model and CLI handover support', () => {
    const params = fixture(); params.needs = [input];
    assert.equal(candidate(params).reason, 'lacks ' + input);
    params.models.models.tiny.inputs = ['text', input];
    assert.equal(candidate(params).reason, 'lacks ' + input);
    params.providers.providers.trial.cli.inputs = [input];
    assert.ok(wins(params, 'trivial'));
    delete params.models.models.tiny.inputs;
    assert.equal(candidate(params).reason, 'lacks ' + input);
    params.models.models.tiny.inputs = [input];
    params.providers.providers.trial.cli.inputs = ['text'];
    assert.equal(candidate(params).reason, 'lacks ' + input);
  });
}

test('text is always supported; unknown inputs are never supported', () => {
  const params = fixture(); params.needs = ['text'];
  assert.ok(wins(params, 'trivial'));
  params.models.models.tiny.inputs = [];
  params.providers.providers.trial.cli.inputs = [];
  assert.ok(wins(params, 'trivial'));
  params.needs = ['unknown'];
  params.models.models.tiny.inputs = ['unknown'];
  assert.equal(candidate(params).reason, 'lacks unknown');
  // A worker may only declare known abilities.
  params.providers.providers.trial.cli.inputs = ['unknown'];
  assert.throws(() => route(params), /Invalid CLI argument template/);
  params.providers.providers.trial.cli.inputs = []; params.providers.providers.trial.cli.tools = ['teleport'];
  assert.throws(() => route(params), /Invalid CLI argument template/);
});

test('self and Claude workers pass images and PDFs, Codex workers pass images', () => {
  const models = { models: structuredClone(shipped.models) };
  for (const host of ['claude-code', 'codex']) {
    const params = { models, host, needs: ['image'], bossModel: host === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5' };
    const result = route(params);
    const core = result.candidates.filter(c => ['claude', 'codex'].includes(c.pool) && c.via);
    assert.ok(core.length);
    assert.ok(core.every(c => c.inputs.includes('image')));
    assert.ok(core.filter(c => c.pool === 'claude').every(c => c.inputs.includes('pdf')));
    const pdf = route({ ...params, needs: ['pdf'] });
    assert.ok(pdf.rows.every(row => row.pool === 'claude'));
    assert.ok(pdf.candidates.filter(c => c.pool === 'codex').every(c => c.reason === 'lacks pdf'));
    // Even the self path requires the model's own declaration.
    const boss = models.models[params.bossModel];
    const inputs = boss.inputs; delete boss.inputs;
    assert.ok(route(params).candidates.filter(c => c.via === 'self').every(c => c.reason === 'lacks image'));
    boss.inputs = inputs;
  }
});

test('context must be known and at least the requested integer size', () => {
  const params = fixture(); params.context = 1000;
  for (const size of [undefined, null, '2000', 999, 1000.5]) {
    params.models.models.tiny.contextTokens = size;
    assert.equal(candidate(params).reason, 'context unknown or too small');
  }
  for (const size of [1000, 2000]) {
    params.models.models.tiny.contextTokens = size;
    assert.ok(wins(params, 'trivial'));
  }
  params.needs = ['image'];
  assert.equal(candidate(params).reason, 'lacks image');
});

test('unfulfillable needs produce explicit none rows, even with no enabled models', () => {
  const params = fixture(); params.needs = ['video'];
  let result = route(params);
  assert.equal(result.rows.length, 3);
  assert.ok(result.rows.every(row => row.model === null));
  assert.match(formatTable(result), /implementation=none \(no enabled route takes video\)/);
  params.providers.providers.trial.enabled = false;
  assert.match(formatTable(route(params)), /implementation=none \(no enabled route takes video\)/);
  delete params.needs; params.context = 1000;
  assert.match(formatTable(route(params)), /none \(no enabled route has context 1000\)/);
  delete params.context;
  result = route(params);
  assert.equal(formatTable(result), '');
});

test('capabilities filter ladders, manual options, consensus, emergency self and large alternatives', () => {
  const params = { models: shipped, needs: ['pdf'], size: 'medium', bossModel: 'claude-opus-5-5' };
  const result = routeTable(params);
  for (const row of result.rows) {
    assert.equal(row.pool, 'claude');
    assert.ok(row.ladder.every(step => step.pool === 'claude'));
    assert.equal(row.consensus, undefined);
    if (row.large) assert.equal(row.large.pool, 'claude');
  }
  assert.equal(result.options.length, 0);
  assert.ok(result.candidates.filter(c => c.pool === 'codex').every(c => c.reason === 'lacks pdf'));
  const emergency = route({ ...params, needs: ['video'], limits: { claude: { five_hour: { used_percentage: 100 } } } });
  assert.ok(emergency.rows.every(row => row.model === null));
  const context = route({ ...params, needs: [], context: 2000000 });
  assert.ok(context.rows.every(row => row.model === null));
});

test('metadata leaves ordinary core tables unchanged, explain shows effective inputs', () => {
  const models = structuredClone(shipped);
  for (const model of Object.values(models.models)) { delete model.inputs; delete model.capabilitySource; }
  assert.equal(formatTable(route({ models })), formatTable(route({ models: shipped })));
  assert.match(formatExplain(route({ models: shipped })), /Opus 5.5[^\n]*inputs=text,image,pdf/);
  assert.match(formatExplain(route(fixture())), /inputs=text/);
});

test('matching fingerprints admit trivial work and stale, legacy or missing CLIs block it', () => {
  const params = fixture('docs');
  assert.ok(wins(params, 'trivial'));
  for (const cli of [undefined, { ...fingerprint(), path: 'elsewhere' }, { ...fingerprint(), size: -1 }, { ...fingerprint(), mtimeMs: -1 }]) {
    params.selfTests.tiny.cli = cli;
    assert.equal(candidate(params).reason, 'self-test needed (CLI changed): quota-boss providers test trial');
    assert.equal(route(params).rows.length, 0);
  }
  params.selfTests.tiny.cli = fingerprint();
  params.findExecutable = () => null;
  assert.equal(candidate(params).reason, 'CLI not installed');
  params.findExecutable = () => path.join(os.tmpdir(), 'absent-quota-boss-cli', 'trial');
  assert.equal(candidate(params).reason, 'CLI not installed');
  params.findExecutable = () => process.execPath;
  params.selfTests = {};
  assert.equal(candidate(params).reason, 'self-test needed: quota-boss providers test trial');
});

test('fingerprints are read once per provider for all rows and models, without spawning', t => {
  const params = fixture('docs');
  params.models.categories = lib.CATEGORIES;
  params.models.models.other = { ...params.models.models.tiny };
  let finds = 0, stats = 0;
  params.findExecutable = () => { finds++; return process.execPath; };
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (...args) => { stats++; return stat(...args); });
  t.mock.method(require('node:child_process'), 'spawnSync', () => { throw new Error('must not spawn'); });
  route(params);
  assert.equal(finds, 1); assert.equal(stats, 1);
});

test('docs-only probation has exact normal and critical tier boundaries', () => {
  const params = fixture('docs');
  assert.ok(wins(params, 'trivial'));
  for (const count of [0, 2, 3]) {
    params.outcomes = Array.from({ length: count }, () => pass('trivial'));
    assert.equal(wins(params, 'normal'), count === 3);
    if (count < 3) assert.equal(candidate(params, 'normal').reason, 'probation: ' + (3 - count) + ' more verified trivial+ passes needed for normal');
    assert.equal(candidate(params, 'critical').reason, 'probation: 3 more verified normal passes needed for critical');
    for (const tier of ['normal', 'critical']) {
      params.outcomes = Array.from({ length: count }, () => pass(tier));
      assert.equal(wins(params, 'critical'), count === 3);
      assert.equal(wins(params, 'normal'), count === 3);
      if (count < 3) assert.equal(candidate(params, 'critical').reason, 'probation: ' + (3 - count) + ' more verified normal passes needed for critical');
    }
  }
  params.outcomes = [pass('trivial'), pass(), pass('critical')];
  assert.ok(wins(params, 'normal')); assert.equal(wins(params, 'critical'), false);
  params.thresholds = { probationPasses: 2 };
  assert.ok(wins(params, 'critical'));
  delete params.models.models.tiny.scores;
  assert.equal(candidate(params, 'critical').reason, 'probation: unrated, no public evidence for critical');
  params.models.models.tiny.scores = {};
  assert.equal(candidate(params, 'critical').reason, 'probation: unrated, no public evidence for critical');
});

test('free and local routes earn normal work with one verified pass and need no self-test', () => {
  for (const evidence of ['real', 'docs']) for (const kind of ['free', 'local']) {
    const params = fixture(evidence);
    params.providers.providers.trial.kind = kind;
    params.models.models.tiny.cost = 0;
    params.selfTests = {};
    assert.equal(candidate(params, 'normal').reason, 'probation: 1 more verified trivial+ passes needed for normal');
    assert.match(candidate(params, 'trivial').reason, /^won:/);
    assert.equal(candidate(params, 'trivial').thinEvidence, true);
    params.outcomes = [pass('trivial')];
    assert.ok(!candidate(params, 'normal').reason?.startsWith('probation'));
    assert.equal(candidate(params, 'normal').thinEvidence, false);
    // Critical work still needs the full probation in normal passes.
    assert.equal(candidate(params, 'critical').reason, 'probation: 3 more verified normal passes needed for critical');
    params.thresholds = { freeProbationPasses: 2 };
    assert.equal(candidate(params, 'normal').reason, 'probation: 1 more verified trivial+ passes needed for normal');
  }
  // A paid docs-only provider still needs its self-test.
  const docs = fixture('docs');
  docs.selfTests = {};
  assert.match(candidate(docs, 'trivial').reason, /^self-test needed/);
  const paid = fixture('real');
  assert.ok(!candidate(paid, 'normal').reason?.startsWith('probation'));
});

test('only recent verified real passes count; other pools also need rated normal passes for critical', () => {
  const params = fixture('docs');
  params.outcomes = [pass('normal', { bench: true }), pass('normal', { result: 'fail' }), pass('normal', { t: now + 1 }),
    pass('normal', { t: now - 365 * 86400000 }), pass('normal', { model: 'other' })];
  assert.equal(candidate(params, 'normal').reason, 'probation: 3 more verified trivial+ passes needed for normal');
  for (const evidence of ['real', undefined]) {
    params.providers.providers.trial.evidence = evidence;
    params.selfTests = {};
    assert.ok(wins(params, 'normal'));
    assert.equal(wins(params, 'critical'), false);
    params.outcomes = [pass(), pass(), pass('critical')];
    assert.ok(wins(params, 'critical'));
    delete params.models.models.tiny.scores;
    assert.equal(candidate(params, 'critical').reason, 'probation: unrated, no public evidence for critical');
    params.models.models.tiny.scores = { implementation: 10 }; params.outcomes = [];
  }
});

test.describe('capability CLI and enabling self-tests', () => {
  let temporary, previous, exitCode;
  test.beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-capabilities-'));
    previous = Object.fromEntries(['QUOTA_BOSS_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map(key => [key, process.env[key]]));
    Object.assign(process.env, { QUOTA_BOSS_HOME: path.join(temporary, 'boss'), CLAUDE_CONFIG_DIR: path.join(temporary, 'claude'), CODEX_HOME: path.join(temporary, 'codex') });
    exitCode = process.exitCode;
  });
  test.afterEach(() => {
    process.exitCode = exitCode;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  function fakeCli(t, succeeds = true) {
    const calls = [];
    t.mock.method(lib, 'findExecutable', name => name === 'git' ? null : process.execPath);
    t.mock.method(require('node:child_process'), 'spawnSync', (_file, args, options) => {
      if (args[0] === '--version') return { status: 0, stdout: '1.0.0' };
      if (args.join(' ') === 'login status') return { status: 0, stdout: 'Logged in' };
      if (args[0] === 'login' || args[0] === '/d') return { status: 0 };
      if (args[0] === 'view') return { status: 0, stdout: '1.0.0' };
      calls.push(args);
      if (succeeds) fs.writeFileSync(path.join(options.cwd, 'quota-boss-self-test.txt'), args.join(' ').match(/[a-f0-9]{48}/)[0]);
      return { status: 0 };
    });
    return calls;
  }
  const activate = (id = 'grok', say = () => {}) => cli.run(['use', id, 'on'], { interactive: true, say });
  test('route parses both capability flags, reports none and rejects malformed requests', () => {
    assert.match(cli.run(['route', '--needs', 'video', 'implementation', 'normal']), /normal: implementation=none \(no enabled route takes video\)/);
    assert.match(cli.run(['route', '--context', '2000000', 'implementation', 'normal']), /none \(no enabled route has context 2000000\)/);
    assert.match(cli.run(['route', '--explain', '--needs', 'image,pdf', '--context', '2000000']), /context unknown or too small/);
    for (const flags of [['--needs'], ['--needs', 'foo'], ['--needs', 'image,'], ['--needs', 'text', '--needs', 'image'],
      ['--context'], ['--context', '0'], ['--context', '-1'], ['--context', '1.5'], ['--context', '1e4'], ['--context', 'Infinity'],
      ['--context', '9007199254740992'], ['--context', '1', '--context', '2']]) assert.throws(() => cli.run(['route', ...flags]), /Usage/);
  });
  test('global provider on runs fake real-work tests, binds each model and skips valid retests', t => {
    const calls = fakeCli(t);
    const messages = [];
    const text = activate('grok', message => messages.push(message));
    assert.ok(messages.includes('Running the self-test (real calls that count against the limit). Skip with --no-test.'));
    assert.match(text, /PASS grok-4.7/); assert.match(text, /PASS grok-build/);
    assert.equal(calls.length, 2);
    assert.equal(lib.loadConfig().providers.providers.grok.enabled, true);
    assert.equal(lib.readUsage().entries.length, 2);
    for (const id of ['grok-4.7', 'grok-build']) assert.deepEqual(lib.readState().selfTests[id].cli, fingerprint());
    assert.doesNotMatch(activate(), /PASS/);
    assert.equal(calls.length, 2);
    lib.updateState(state => ({ selfTests: { ...state.selfTests, 'grok-build': { result: 'pass' } } }));
    assert.match(activate(), /PASS grok-build/);
    assert.equal(calls.length, 4);
  });
  test('non-terminal provider on only switches and says how to finish', t => {
    const calls = fakeCli(t);
    const text = cli.run(['use', 'grok', 'on'], { interactive: false });
    assert.match(text, /\nTo finish, run quota-boss use grok on in a terminal\.$/);
    assert.equal(lib.loadConfig().providers.providers.grok.enabled, true);
    assert.deepEqual(calls, []);
    assert.deepEqual(lib.readUsage().entries, []);
  });
  test('--no-test leaves the provider enabled and gated without any calls', t => {
    const calls = fakeCli(t);
    const text = cli.run(['use', 'grok', 'on', '--no-test']);
    assert.match(text, /Self-test skipped: run quota-boss providers test grok before it gets work\./);
    assert.equal(calls.length, 0);
    const result = route({ ...lib.loadConfig(), findExecutable: lib.findExecutable });
    assert.ok(result.candidates.filter(c => c.pool === 'grok').every(c => c.reason.startsWith('self-test needed:')));
  });
  test('global enabling tests globally enabled models despite project restrictions', t => {
    const calls = fakeCli(t);
    lib.saveProject(process.cwd(), { use: { modelsOff: ['grok-4.7', 'grok-build'] } });
    assert.match(activate(), /PASS grok-build/);
    assert.equal(calls.length, 2);
  });
  test('globally disabled models do not require tests or receive calls', t => {
    const calls = fakeCli(t);
    cli.run(['use', 'grok-build', 'off']);
    assert.doesNotMatch(activate(), /PASS grok-build/);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(activate(), /PASS/);
    assert.equal(calls.length, 1);
  });
  test('failed and missing CLI tests leave provider on but gated', t => {
    const calls = fakeCli(t, false);
    assert.match(activate(), /FAIL grok-4.7: exit 0 but the work was not done/);
    assert.equal(calls.length, 2);
    assert.equal(lib.loadConfig().providers.providers.grok.enabled, true);
    assert.equal(lib.readState().selfTests?.['grok-4.7'], undefined);
    lib.findExecutable.mock.mockImplementation(() => null);
    const messages = [];
    activate('grok', message => messages.push(message));
    assert.match(messages.join('\n'), /install by hand/);
    assert.equal(calls.length, 2);
    assert.ok(route(lib.loadConfig()).candidates.filter(c => c.pool === 'grok').every(c => c.reason === 'CLI not installed'));
  });
  test('project switches, individual models, off and real-evidence providers never auto-test', t => {
    const calls = fakeCli(t);
    for (const args of [['grok', 'on', '--project'], ['grok-4.7', 'on'], ['grok', 'off'], ['codex', 'on']]) {
      assert.doesNotMatch(cli.run(['use', ...args]), /Running the self-test/);
    }
    assert.equal(calls.length, 0);
    for (const args of [['grok', 'off', '--no-test'], ['grok-4.7', 'on', '--no-test'], ['grok', 'on', '--project', '--no-test'],
      ['grok', 'on', '--no-test', '--no-test']]) assert.throws(() => cli.run(['use', ...args]), /Usage/);
  });
});

test('an npm update behind an unchanged Windows shim invalidates the self-test', { skip: process.platform !== 'win32' && 'Windows shims only' }, t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const lib = require('../scripts/lib');
  const { validSelfTest } = require('../scripts/self-test');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'grok.cmd'), manifest = path.join(dir, 'node_modules', '@scope', 'grok-cli', 'package.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(shim, '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\@scope\\grok-cli\\dist\\index.js" %*\r\n');
  fs.writeFileSync(manifest, '{"version":"1.0.0"}');
  const before = lib.cliFingerprint('grok', () => shim);
  assert.ok(before.package);
  assert.equal(validSelfTest({ result: 'pass', cli: before }, lib.cliFingerprint('grok', () => shim)), true);
  fs.writeFileSync(manifest, '{"version":"1.0.10"}');
  assert.equal(validSelfTest({ result: 'pass', cli: before }, lib.cliFingerprint('grok', () => shim)), false);
  fs.rmSync(manifest);
  assert.equal(lib.cliFingerprint('grok', () => shim), null);
});

test('a specialist only routes when the job needs an input it has, and tools follow model and worker', () => {
  const params = fixture();
  params.models.models.tiny.specialist = true;
  params.models.models.tiny.inputs = ['text', 'video'];
  params.providers.providers.trial.cli.inputs = ['video'];
  params.needs = [];
  assert.equal(candidate(params).reason, 'specialist: only with route --needs');
  params.needs = ['text'];
  assert.equal(candidate(params).reason, 'specialist: only with route --needs');
  params.needs = ['video'];
  assert.ok(wins(params, 'trivial'));
  const tools = fixture(); tools.needs = ['web-search'];
  assert.equal(candidate(tools).reason, 'lacks web-search');
  tools.models.models.tiny.tools = ['web-search'];
  assert.equal(candidate(tools).reason, 'lacks web-search');
  tools.providers.providers.trial.cli.tools = ['web-search'];
  assert.ok(wins(tools, 'trivial'));
  tools.needs = ['image-gen'];
  assert.equal(candidate(tools).reason, 'lacks image-gen');
});

test('shipped image-gen goes to Codex workers and web search never to plain Claude workers', () => {
  const image = route({ models: shipped, needs: ['image-gen'], bossModel: 'claude-opus-5-5' });
  assert.ok(image.rows.every(row => row.model === null || row.pool === 'codex'));
  const search = route({ models: shipped, needs: ['web-search'], bossModel: 'claude-opus-5-5' });
  assert.ok(search.rows.some(row => row.model !== null));
  assert.ok(search.rows.every(row => !['haiku-worker', 'sonnet-worker', 'opus-worker'].includes(row.method)));
  const video = route({ models: shipped, needs: ['video'], bossModel: 'claude-opus-5-5' });
  assert.ok(video.rows.every(row => row.model === null));
  assert.match(video.note, /quota-boss use gemini-media on/);
});

test('cli-run input accepts YouTube links and regular files inside the working directory up to 14 MiB', () => {
  const run = require('../scripts/cli-run');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-input-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-outside-'));
  try {
    fs.writeFileSync(path.join(dir, 'clip.mp4'), 'x');
    fs.mkdirSync(path.join(dir, 'sub.mp4')); fs.writeFileSync(path.join(dir, '.env'), 'x'); fs.writeFileSync(path.join(dir, '..notes.png'), 'x'); fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    assert.equal(run.inputArgument(url, dir), url);
    assert.equal(run.inputArgument('https://youtu.be/dQw4w9WgXcQ?si=abc', dir), url);
    assert.equal(run.inputArgument('https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30s', dir), url);
    assert.throws(() => run.inputArgument(url, dir, {}, ['image']), /no video input/);
    assert.throws(() => run.inputArgument('http://www.youtube.com/watch?v=dQw4w9WgXcQ', dir), /Only YouTube links/);
    assert.throws(() => run.inputArgument('https://www.youtube.com/watch?v=short', dir), /Only YouTube links/);
    assert.throws(() => run.inputArgument('.env', dir), /Hidden files/);
    assert.throws(() => run.inputArgument('..notes.png', dir), /Hidden files/);
    assert.throws(() => run.inputArgument('notes.txt', dir), /no .txt input/);
    assert.throws(() => run.inputArgument('clip.mp4', dir, {}, ['image', 'pdf']), /no .mp4 input/);
    assert.throws(() => run.inputArgument('https://example.com/watch?v=dQw4w9WgXcQ', dir), /Only YouTube links/);
    assert.equal(run.inputArgument('clip.mp4', dir), fs.realpathSync(path.join(dir, 'clip.mp4')));
    assert.throws(() => run.inputArgument('missing.mp4', dir), /not found/);
    assert.throws(() => run.inputArgument(path.join(outside, 'secret.txt'), dir), /inside the working directory/);
    assert.throws(() => run.inputArgument('../' + path.basename(outside) + '/secret.txt', dir), /inside the working directory/);
    assert.throws(() => run.inputArgument('.', dir), /inside the working directory/);
    assert.throws(() => run.inputArgument('sub.mp4', dir), /regular file/);
    const big = { stat: () => ({ isFile: () => true, size: run.MAX_INPUT + 1 }) };
    assert.throws(() => run.inputArgument('clip.mp4', dir, big), /larger than 14 MiB/);
    let linked = true;
    try { fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt')); } catch { linked = false; }
    if (linked) assert.throws(() => run.inputArgument('link.txt', dir), /inside the working directory/);
    const args = ['analyze', 'p', '-i', '{input}'];
    assert.deepEqual(run.withInput(args, undefined, dir), ['analyze', 'p']);
    assert.deepEqual(run.withInput(args, url, dir), ['analyze', 'p', '-i', url]);
    assert.deepEqual(run.withInput(['{input}', 'p'], undefined, dir), ['p']);
    assert.throws(() => run.withInput(['p'], url, dir), /takes no --input/);
    assert.deepEqual(run.withInput(['p'], undefined, dir), ['p']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('an input placeholder must be a whole argument and appear at most once', () => {
  for (const args of [['{prompt}', '--file={input}'], ['{prompt}', '{input}', '{input}']]) {
    const params = fixture(); params.providers.providers.trial.cli.args = args;
    assert.throws(() => route(params), /Invalid CLI argument template/);
  }
  const params = fixture(); params.providers.providers.trial.cli.args = ['{prompt}', '-i', '{input}'];
  assert.doesNotThrow(() => route(params));
});

test('input paths are checked before they are resolved, and media routes have no self-test', () => {
  const run = require('../scripts/cli-run');
  const probe = { realpath: () => { throw new Error('probed'); } };
  for (const input of ['\\\\server\\share\\a.mp4','//server/share/a.mp4', '../a.mp4']) assert.throws(() => run.inputArgument(input, process.cwd(), probe), /inside the working directory/);
  for (const input of ['a.mp4 ', ' a.mp4', 'a.mp4:stream']) assert.throws(() => run.inputArgument(input, process.cwd(), probe), /spaces at its ends or a colon/);
  const { selfTest } = require('../scripts/self-test');
  const config = { providers: require('../config/providers.json'), models: shipped };
  assert.throws(() => selfTest('gemini-media', { config, spawnSync: () => { throw new Error('spawned'); } }), /has no self-test/);
});
