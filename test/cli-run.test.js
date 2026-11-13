'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const lib = require('../scripts/lib');
const runner = require('../scripts/cli-run');

function config() {
  return { providers: { providers: { trial: { label: 'Trial', kind: 'api', enabled: true, worker: 'cli-worker',
    quota: { source: 'counter', windows: { daily: { budget: 100, unit: 'calls' } } },
    cli: { command: 'trial', args: ['-p', '{prompt}', '--model', '{model}', '--effort', '{effort}'], defaultModel: 'default' },
  } } }, models: { models: { tiny: { pool: 'trial', cliModel: 'vendor/tiny' } } } };
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 1234; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null);
  return child;
}

function harness(result = {}, cfg = config()) {
  const records = { feedback: [], timing: [], usage: [], spawns: [] };
  const project = { directory: process.cwd(), allowTrainingProviders: false };
  const deps = { prompt: 'build it', env: { PATH: path.dirname(process.execPath) }, platform: process.platform,
    findProjectConfig: () => project, loadConfig: actual => { assert.equal(actual, project); return cfg; },
    findExecutable: () => process.execPath, now: () => 42000, gitStatus: () => '',
    appendOutcome: (...args) => records.feedback.push(args), recordRun: value => records.timing.push(value),
    appendUsage: (...args) => records.usage.push(args),
    spawn(file, args, options) {
      records.spawns.push({ file, args, options });
      const child = fakeChild();
      queueMicrotask(() => {
        if (result.error) { child.emit('error', result.error); return; }
        child.stdout.write(result.stdout || ''); child.stderr.write(result.stderr || '');
        child.emit('close', result.status ?? 0);
      });
      return child;
    },
  };
  return { deps, records, cfg, project };
}

test('arguments validate values, boolean switches and duplicate/unknown flags', () => {
  assert.equal(runner.parseArgs(['--provider', 'trial', '--expect-changes', '--effort', 'high'])['expect-changes'], true);
  for (const argv of [[], ['--provider'], ['--provider', 'x;bad'], ['--provider', 'trial', '--model', '$(bad)'],
    ['--provider', 'trial', '--effort', 'ultra'], ['--provider', 'trial', '--category', 'bad'],
    ['--provider', 'trial', '--tier', 'bad'], ['--provider', 'trial', '--yolo'],
    ['--provider', 'trial', '--provider', 'trial'], ['--provider', 'trial', '--expect-changes', '--expect-changes']]) {
    assert.throws(() => runner.parseArgs(argv));
  }
});

test('provider and model refusals happen before stdin, spawn or journals', async t => {
  const cases = [
    ['missing', h => { delete h.cfg.providers.providers.trial; }, /missing/],
    ['disabled', h => { h.cfg.providers.providers.trial.enabled = false; }, /disabled/],
    ['no CLI', h => { delete h.cfg.providers.providers.trial.cli; }, /no CLI/],
    ['manual', h => { h.cfg.providers.providers.trial.kind = 'manual'; }, /Manual/],
    ['avoided', h => { h.cfg.providers.providers.trial.tos = 'avoid'; }, /tos avoid/],
    ['training', h => { h.cfg.providers.providers.trial.trainsOnData = true; }, /allowTrainingProviders/],
    ['foreign model', h => { h.cfg.models.models.tiny.pool = 'other'; }, /Unknown model/],
    ['unknown model', h => { delete h.cfg.models.models.tiny; }, /Unknown model/],
    ['invalid CLI slug', h => { h.cfg.models.models.tiny.cliModel = 'bad;name'; }, /Invalid model CLI/],
    ['sandbox bypass', h => { h.cfg.providers.providers.trial.cli.args.push('--dangerously-skip-permissions'); }, /disables sandbox/],
  ];
  for (const [name, mutate, pattern] of cases) await t.test(name, async () => {
    const h = harness(); mutate(h);
    await assert.rejects(runner.run(['--provider', 'trial', '--model', 'tiny'], h.deps), pattern);
    assert.deepEqual(h.records, { feedback: [], timing: [], usage: [], spawns: [] });
  });
  const h = harness(); h.cfg.providers.providers.trial.trainsOnData = true; h.project.allowTrainingProviders = true;
  assert.equal((await runner.run(['--provider', 'trial'], h.deps)).code, 0);
});

test('resolution shares cliArgsForModel, including defaults, legacy flags and omitted efforts', () => {
  const cfg = config();
  const choose = options => runner.selection({ provider: 'trial', ...options }, cfg, {});
  assert.deepEqual(choose({ model: 'tiny', effort: 'high' }).args,
    lib.cliArgsForModel(cfg.providers.providers.trial.cli, 'vendor/tiny', 'high'));
  assert.deepEqual(choose({}).args, ['-p', '{prompt}', '--model', 'default']);
  cfg.providers.providers.trial.cli.defaultEffort = 'low';
  assert.deepEqual(choose({}).args.slice(-2), ['--effort', 'low']);
  cfg.providers.providers.trial.cli.args = ['-m', 'old', '{prompt}'];
  assert.equal(choose({ model: 'tiny' }).args[1], 'vendor/tiny');
  cfg.models.models.another = { pool: 'trial' };
  assert.throws(() => choose({}), /Pass --model/);
});

test('sandbox and permission bypass flags refuse before launch or journals, including equals and mixed case', async t => {
  const flags = ['--full-auto', '--yolo', '--dangerously-skip-permissions', '--dangerously-anything',
    '--bypass-permissions', '--bypass-anything', '--trust-all-tools', '--allow-all-tools', '-y', '--yes',
    '--no-sandbox', '--allow-all', '--skip-permissions', '--disable-sandbox'];
  const pairs = [['--approval-mode', 'yolo'], ['--permission-mode', 'bypassPermissions'],
    ['-s', 'danger-full-access'], ['--sandbox', 'danger-full-access'], ['--ask-for-approval', 'never'],
    ['--sandbox', 'off'], ['--sandbox', 'none']];
  const cases = [...flags.flatMap(flag => [[flag], [flag + '=true']]),
    ...pairs.flatMap(([flag, value]) => [[flag, value], [flag + '=' + value]])];
  for (const args of cases) await t.test(args.join(' '), async () => {
    for (const variant of [args, args.map(arg => arg.toUpperCase())]) {
      const h = harness(); h.cfg.providers.providers.trial.cli.args.push(...variant);
      await assert.rejects(runner.run(['--provider', 'trial'], h.deps), /disables sandbox or permission checks/);
      assert.deepEqual(h.records, { feedback: [], timing: [], usage: [], spawns: [] });
    }
  });
  const h = harness();
  h.cfg.providers.providers.trial.cli.args = ['-p', '{prompt}', '--permission-mode', '{model}'];
  h.cfg.providers.providers.trial.cli.defaultModel = 'bypassPermissions';
  await assert.rejects(runner.run(['--provider', 'trial'], h.deps), /disables sandbox/);
  for (const args of [['--sandbox', 'workspace-write'], ['-s'], ['--ask-for-approval', 'on-request'],
    ['--permission-mode=default'], ['--approval-mode', 'default']]) {
    const safe = config(); safe.providers.providers.trial.cli.args.push(...args);
    assert.doesNotThrow(() => runner.selection({ provider: 'trial' }, safe, {}));
  }
});

test('all shipped provider CLI templates pass the denylist after model and effort resolution', () => {
  const providers = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'providers.json'), 'utf8'));
  let checked = 0;
  for (const [id, provider] of Object.entries(providers.providers)) {
    if (!provider.cli) continue;
    const cfg = { providers: { providers: { [id]: { ...provider, enabled: true } } },
      models: { models: { tiny: { pool: id, cliModel: provider.cli.defaultModel || 'vendor/tiny' } } } };
    for (const effort of [undefined, 'high']) {
      assert.doesNotThrow(() => runner.selection({ provider: id, effort }, cfg, { allowTrainingProviders: true }), id);
    }
    checked++;
  }
  assert.ok(checked > 0);
});

test('prompt prefix, quotes, dollars and newlines are one literal argv element; stdin is closed', async () => {
  const h = harness();
  h.deps.prompt = 'quotes " \' & % ! $& $` $\'\nsecond line {model}';
  const result = await runner.run(['--provider', 'trial', '--model', 'tiny', '--effort', 'high'], h.deps);
  const call = h.records.spawns[0];
  assert.deepEqual(call.args, ['-p', 'Your working directory is ' + process.cwd() + ' and every file is inside it. Use relative file paths.\n\n' + h.deps.prompt,
    '--model', 'vendor/tiny', '--effort', 'high']);
  assert.equal(call.options.cwd, process.cwd()); assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(result.code, 0);
  assert.match(result.report.split('\n')[0], /^cli-run: ok \| provider trial \| model tiny @high \| 0s \| feedback none$/);
  assert.equal(h.records.feedback.length, 0); assert.equal(h.records.usage[0][1], 1);
  assert.equal(h.records.timing[0].ok, true); assert.equal(h.records.timing[0].category, null);
});

test('prompt byte bounds, NUL and missing executable refuse before launch', async () => {
  for (const prompt of ['', 'x'.repeat(runner.MAX_PROMPT + 1), '\0', 'é'.repeat(runner.MAX_PROMPT / 2 + 1)]) {
    const h = harness(); h.deps.prompt = prompt;
    await assert.rejects(runner.run(['--provider', 'trial'], h.deps), /Prompt/);
    assert.equal(h.records.spawns.length, 0);
  }
  for (const prompt of [' ', 'é'.repeat(1000)]) {
    const h = harness(); h.deps.prompt = prompt;
    assert.equal((await runner.run(['--provider', 'trial'], h.deps)).code, 0);
  }
  const h = harness(); h.deps.findExecutable = () => null;
  await assert.rejects(runner.run(['--provider', 'trial'], h.deps), /trusted PATH/);
});

test('final prompt byte limits include the directory prefix and refuse before launch or journals on each platform', async () => {
  for (const [platform, kib] of [['win32', 24], ['linux', 100], ['darwin', 100]]) {
    const prefix = 'Your working directory is ' + process.cwd() + ' and every file is inside it. Use relative file paths.\n\n';
    const room = kib * 1024 - Buffer.byteLength(prefix);
    for (const multibyte of [false, true]) {
      const text = multibyte ? 'é'.repeat(Math.floor(room / 2)) + 'x'.repeat(room % 2) : 'x'.repeat(room);
      const h = harness(); h.deps.platform = platform; h.deps.prompt = text;
      h.deps.findExecutable = () => platform === 'win32' ? 'C:\\trusted\\trial.exe' : '/trusted/trial';
      assert.equal((await runner.run(['--provider', 'trial'], h.deps)).code, 0);
      const refused = harness(); refused.deps.platform = platform; refused.deps.prompt = text + 'x';
      refused.deps.findExecutable = () => { throw new Error('must refuse before executable resolution'); };
      await assert.rejects(runner.run(['--provider', 'trial'], refused.deps), new RegExp('Final prompt exceeds the ' + kib + ' KiB argv limit on ' + platform));
      assert.deepEqual(refused.records, { feedback: [], timing: [], usage: [], spawns: [] });
    }
  }
});

test('duration is measured around the CLI call and timing defaults stay unknown', async () => {
  const h = harness(); let reads = 0;
  h.deps.now = () => reads++ === 0 ? 1000 : 4200;
  const result = await runner.run(['--provider', 'trial'], h.deps);
  assert.match(result.report, /\| 3s \| feedback none/);
  assert.equal(h.records.timing[0].seconds, 3); assert.equal(h.records.timing[0].t, 4200);
  assert.equal(h.records.timing[0].category, null); assert.equal(h.records.timing[0].tier, null);
});

test('each failure pattern produces the expected feedback, timing and counter usage', async t => {
  const classes = {
    limited: ['rate limit', 'HTTP 429', 'too many requests', 'quota exceeded', 'request too large', 'overloaded', 'high demand', 'status: 503'],
    unavailable: ['error: 401', 'unauthorized', 'API key', 'model not found', 'provider not found'],
    structural: ['HTTP 400', 'status: 422', 'invalid request', 'unsupported parameter', 'message format'],
    'no-work': ['auto-rejecting', 'rejected permission'],
    failed: ['ordinary error'],
  };
  for (const [kind, patterns] of Object.entries(classes)) for (const output of patterns) await t.test(output, async () => {
    const h = harness({ status: kind === 'no-work' ? 0 : 1, stderr: output });
    const result = await runner.run(['--provider', 'trial', '--model', 'tiny'], h.deps);
    assert.equal(result.code, 1); assert.match(result.report, new RegExp('^cli-run: FAILED \\(' + kind + ':'));
    assert.equal(h.records.timing.length, 1); assert.equal(h.records.timing[0].ok, false);
    assert.equal(h.records.usage.length, 1); assert.equal(h.records.usage[0][2], 'calls');
    if (kind === 'failed') { assert.equal(h.records.feedback.length, 0); return; }
    const entry = h.records.feedback[0][0];
    assert.equal(entry.result, ['structural', 'no-work'].includes(kind) ? 'fail' : kind);
    assert.equal(entry.model, 'tiny'); assert.equal(entry.category, 'mechanical'); assert.equal(entry.tier, 'trivial');
    assert.match(result.report.split('\n')[0], /feedback recorded$/);
  });
});

test('success ignores provider error words and codes in either stream, without feedback', async () => {
  for (const stream of ['stdout', 'stderr']) for (const output of ['api key', '401', 'rate limit', '503', 'HTTP 429', 'HTTP 400 overloaded', 'invalid request']) {
    const h = harness({ status: 0, [stream]: output });
    const result = await runner.run(['--provider', 'trial'], h.deps);
    assert.equal(result.code, 0, output); assert.match(result.report, /^cli-run: ok/);
    assert.equal(h.records.feedback.length, 0); assert.equal(h.records.timing[0].ok, true);
  }
});

test('nonzero failures scan stderr before stdout, with structural errors ahead of limits', async () => {
  for (const [stdout, stderr, kind] of [['', 'HTTP 400: provider overloaded', 'structural'],
    ['HTTP 400', 'HTTP 429', 'limited'], ['rate limit', 'unauthorized', 'unavailable'],
    ['HTTP 429', 'ordinary failure', 'limited'], ['HTTP 422 overloaded', '', 'structural']]) {
    const h = harness({ status: 1, stdout, stderr });
    const result = await runner.run(['--provider', 'trial'], h.deps);
    assert.match(result.report, new RegExp('^cli-run: FAILED \\(' + kind + ':'));
    assert.equal(h.records.feedback[0][0].result, kind === 'structural' ? 'fail' : kind);
  }
  for (const code of ['429', '401', '400', '422', '503']) {
    for (const stream of ['stdout', 'stderr']) {
      assert.equal(runner.classify({ status: 1, [stream]: 'Processed ' + code + ' files' }).kind, 'failed');
      assert.equal(runner.classify({ status: 1, [stream]: 'HTTP response\n' + code }).kind, 'failed');
      assert.notEqual(runner.classify({ status: 1, [stream]: 'error: ' + code }).kind, 'failed');
    }
  }
});

test('permission rejection is no-work and records fail for every exit code and either stream', async () => {
  for (const status of [0, 1, 2]) for (const stream of ['stdout', 'stderr']) for (const marker of ['auto-rejecting', 'rejected permission']) {
    const h = harness({ status, [stream]: 'HTTP 429\n' + marker });
    const result = await runner.run(['--provider', 'trial'], h.deps);
    assert.match(result.report, /^cli-run: FAILED \(no-work: permission rejected\)/);
    assert.equal(h.records.feedback[0][0].result, 'fail'); assert.equal(h.records.timing[0].ok, false);
  }
});

test('chunked detection preserves stderr and permission markers, but only scans the stdout tail for failures', async () => {
  for (const [stream, chunks, status, kind] of [
    ['stdout', ['too many req', 'uests\n'], 0, 'ok'],
    ['stdout', ['too many req', 'uests\n'], 1, 'failed'],
    ['stderr', ['too many req', 'uests\n'], 1, 'limited'],
    ['stdout', ['rejected per', 'mission\n'], 1, 'no-work'],
    ['stderr', ['auto-rej', 'ecting\n'], 0, 'no-work'],
  ]) {
    const h = harness();
    h.deps.spawn = () => {
      const child = fakeChild();
      queueMicrotask(() => {
        for (const chunk of chunks) child[stream].write(chunk);
        child[stream].write('x'.repeat(400000)); child.emit('close', status);
      });
      return child;
    };
    const result = await runner.run(['--provider', 'trial'], h.deps);
    assert.match(result.report, kind === 'ok' ? /^cli-run: ok/ : new RegExp('FAILED \\(' + kind + ':'));
    assert.equal(h.records.feedback.length, ['ok', 'failed'].includes(kind) ? 0 : 1);
  }
});

test('expect-changes compares both Git snapshots; missing Git cannot prove no work', async () => {
  for (const [before, after, expected] of [['', '', 'no-work'], ['', ' M new.js', 'ok'], [null, null, 'ok'], ['', null, 'ok']]) {
    const h = harness(); let reads = 0; h.deps.gitStatus = () => reads++ === 0 ? before : after;
    const result = await runner.run(['--provider', 'trial', '--expect-changes'], h.deps);
    assert.equal(result.code, expected === 'ok' ? 0 : 1); assert.equal(reads, 2);
    assert.equal(h.records.feedback.length, expected === 'no-work' ? 1 : 0);
    if (before === null || after === null) assert.match(result.report.split('\n')[0], /expect-changes skipped: Git fingerprint unavailable/);
  }
});

test('timeout uses injected Windows taskkill /T /F before the parent exits, and records limited', async () => {
  const h = harness(); const timers = []; const cancelled = []; const calls = [];
  h.deps.platform = 'win32'; h.deps.findExecutable = () => 'C:\\trusted\\trial.exe';
  h.deps.setTimeout = (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; };
  h.deps.clearTimeout = timer => cancelled.push(timer);
  const child = fakeChild();
  h.deps.spawn = (file, args, options) => {
    calls.push({ file, args, options });
    if (calls.length === 1) { queueMicrotask(() => timers[0].callback()); return child; }
    assert.match(file, /\\System32\\taskkill\.exe$/i);
    assert.deepEqual(args, ['/PID', '1234', '/T', '/F']);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    const killer = new EventEmitter(); queueMicrotask(() => { killer.emit('close', 0); child.emit('close', null); }); return killer;
  };
  const result = await runner.run(['--provider', 'trial'], h.deps);
  assert.equal(timers[0].ms, 600000); assert.equal(runner.TIMEOUT_MS, 600000);
  assert.match(result.report, /FAILED \(limited: 10-minute timeout\)/);
  assert.equal(h.records.feedback[0][0].result, 'limited'); assert.equal(h.records.timing[0].ok, false);
  assert.equal(h.records.usage.length, 1); assert.equal(cancelled.length, 2);
});

test('POSIX timeout kills the process group; Windows taskkill failure falls back and shutdown is bounded', async () => {
  for (const platform of ['linux', 'win32']) {
    const timers = []; const child = fakeChild(); let killed = false, calls = 0;
    child.kill = signal => { assert.equal(signal, 'SIGKILL'); killed = true; };
    const promise = runner.execute({ file: 'unused', args: [], options: { env: {} } }, {
      platform, setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimeout() {},
      kill: (pid, signal) => { assert.equal(pid, -1234); assert.equal(signal, 'SIGKILL'); killed = true; },
      spawn: () => { if (++calls === 1) return child; throw new Error('taskkill unavailable'); },
    });
    timers[0].callback(); assert.equal(killed, true); assert.equal(timers[1].ms, 5000); timers[1].callback();
    assert.equal((await promise).timedOut, true);
    assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  }
});

test('metadata uses supplied category/tier/effort; counter units and non-counter usage are respected', async () => {
  for (const unit of ['calls', 'tokens', 'usd', null]) {
    const h = harness({ status: 1, stderr: 'HTTP 422' });
    h.cfg.providers.providers.trial.quota = unit ? { source: 'counter', windows: { daily: { budget: 10, unit } } } : { source: 'none' };
    await runner.run(['--provider', 'trial', '--category', 'review', '--tier', 'critical', '--effort', 'high'], h.deps);
    assert.equal(h.records.feedback[0][0].category, 'review'); assert.equal(h.records.feedback[0][0].tier, 'critical');
    assert.equal(h.records.feedback[0][0].effort, 'high'); assert.equal(h.records.timing[0].category, 'review');
    assert.equal(h.records.usage.length, unit ? 1 : 0);
    if (unit) assert.equal(h.records.usage[0][2], unit);
  }
});

test('spawn and recording failures cannot masquerade as success or suppress remaining journals', async () => {
  const h = harness({ error: new Error('secret startup detail') });
  const result = await runner.run(['--provider', 'trial'], h.deps);
  assert.match(result.report, /FAILED \(failed: could not run CLI\)/); assert.doesNotMatch(result.report, /secret startup/);
  assert.equal(h.records.timing.length, 1); assert.equal(h.records.feedback.length, 0);
  const other = harness({ stderr: 'HTTP 429', status: 1 });
  other.deps.appendOutcome = () => { throw new Error('secret log error'); };
  const otherResult = await runner.run(['--provider', 'trial'], other.deps);
  assert.match(otherResult.report, /FAILED \(limited: provider limit\).*feedback none/);
  assert.match(otherResult.report, /Recording failed: feedback\./);
  assert.equal(other.records.usage.length, 1); assert.equal(other.records.timing.length, 1);
});

test('spawn errors report their code as failed, whether thrown or emitted', async () => {
  for (const code of ['E2BIG', 'ENAMETOOLONG', 'ENOENT']) for (const thrown of [false, true]) {
    const error = Object.assign(new Error('private error detail'), { code });
    const h = harness({ error });
    if (thrown) h.deps.spawn = () => { throw error; };
    const result = await runner.run(['--provider', 'trial'], h.deps);
    assert.equal(result.code, 1); assert.match(result.report, new RegExp('failed: could not run CLI \\(' + code + '\\)'));
    assert.doesNotMatch(result.report, /private error detail/); assert.equal(h.records.feedback.length, 0);
    assert.equal(h.records.timing[0].ok, false);
  }
});

test('a provider without quota still returns the report and records timing and applicable feedback', async () => {
  for (const status of [0, 1]) {
    const h = harness({ status, stderr: 'HTTP 429' }); delete h.cfg.providers.providers.trial.quota;
    const result = await runner.run(['--provider', 'trial'], h.deps);
    assert.equal(result.code, status); assert.match(result.report, /^cli-run:/);
    assert.equal(h.records.timing.length, 1); assert.equal(h.records.usage.length, 0);
    assert.equal(h.records.feedback.length, status);
  }
});

test('reports label untrusted tails, keep only 60 stdout/20 stderr lines, redact secrets and bound long lines', async () => {
  const h = harness({ status: 1, stdout: Array.from({ length: 100 }, (_, i) => 'out ' + i).join('\n'),
    stderr: Array.from({ length: 30 }, (_, i) => 'err ' + i).join('\n') });
  const lines = (await runner.run(['--provider', 'trial'], h.deps)).report.trimEnd().split('\n');
  assert.equal(lines.length, 83); assert.match(lines[1], /untrusted/); assert.equal(lines[2], 'out 40');
  assert.equal(lines[61], 'out 99'); assert.match(lines[62], /untrusted/); assert.equal(lines[63], 'err 10');
  assert.equal(lines.at(-1), 'err 29');
  const secret = harness({ stdout: 'API_KEY=hide-this\nBearer abcdefgh\nsk-supersecret123\nmy-env-secret\n' + 'a'.repeat(10000) });
  secret.deps.env.ACCESS_TOKEN = 'my-env-secret';
  const report = (await runner.run(['--provider', 'trial'], secret.deps)).report;
  assert.doesNotMatch(report, /hide-this|abcdefgh|sk-supersecret|my-env-secret/); assert.match(report, /redacted/);
  assert.ok(report.length < 5000);
});

test('Windows npm shim resolves to Node and JS without passing a prompt through cmd; unknown shims refuse', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-cli-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, 'node_modules', 'trial', 'cli.js'); fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, '');
  for (const extension of ['cmd', 'bat']) {
    const shim = path.join(dir, 'trial.' + extension);
    fs.writeFileSync(shim, '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\trial\\cli.js" %*\r\n');
    const target = runner.invocation(shim, 'win32');
    assert.equal(target.file, process.execPath); assert.deepEqual(target.prefix, [entry]);
    const plan = runner.spawnPlan(target, ['quotes " & % !\nnewline'], {}, 'win32', dir);
    assert.equal(plan.options.shell, false); assert.equal(plan.options.windowsVerbatimArguments, false);
    assert.deepEqual(plan.args, [entry, 'quotes " & % !\nnewline']);
    fs.writeFileSync(shim, '@echo off\nother.exe %*'); assert.throws(() => runner.invocation(shim, 'win32'), /cannot safely carry/);
    fs.writeFileSync(shim, '"%dp0%\\node_modules\\..\\outside.js" %*'); assert.throws(() => runner.invocation(shim, 'win32'), /cannot safely carry/);
  }
  assert.throws(() => runner.invocation(path.join(dir, 'trial.ps1'), 'win32'), /cannot safely carry/);
});

test('integration: real entry point with fake CLI closes stdin and writes only metadata to all three journals', t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-cli-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), project = path.join(dir, 'project');
  fs.mkdirSync(path.join(home, 'config'), { recursive: true }); fs.mkdirSync(project);
  const fake = path.join(dir, 'fake.js'), observed = path.join(dir, 'observed.json');
  fs.writeFileSync(fake, `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({args:process.argv.slice(2), stdin:fs.readFileSync(0,'utf8'),cwd:process.cwd()}));
process.stderr.write('HTTP 422 invalid request'); process.exitCode=1;`);
  const cfg = config(); cfg.providers.providers.trial.cli.command = 'node'; cfg.providers.providers.trial.cli.args.unshift(fake);
  fs.writeFileSync(path.join(home, 'config', 'providers.json'), JSON.stringify(cfg.providers));
  fs.writeFileSync(path.join(home, 'config', 'models.json'), JSON.stringify(cfg.models));
  const env = { ...process.env, QUOTA_BOSS_HOME: home };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = path.dirname(process.execPath) + path.delimiter + (env[pathKey] || '');
  const script = path.join(__dirname, '..', 'scripts', 'cli-run.js');
  const prompt = 'literal "quotes"\nnew line & % $&';
  const result = spawnSync(process.execPath, [script, '--provider', 'trial', '--model', 'tiny', '--effort', 'high'],
    { cwd: project, env, input: prompt, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr); assert.match(result.stdout, /^cli-run: FAILED \(structural: invalid request\)/);
  const seen = JSON.parse(fs.readFileSync(observed, 'utf8'));
  assert.equal(seen.stdin, ''); assert.equal(seen.cwd.toLowerCase(), project.toLowerCase());
  assert.equal(seen.args[1], 'Your working directory is ' + lib.projectKey(project) + ' and every file is inside it. Use relative file paths.\n\n' + prompt);
  for (const file of ['outcomes.jsonl', 'usage.jsonl', 'runs.jsonl']) {
    const text = fs.readFileSync(path.join(home, file), 'utf8'); assert.doesNotMatch(text, /literal|invalid request/);
    assert.equal(text.trim().split('\n').length, 1);
  }
  fs.unlinkSync(observed);
  const journals = ['outcomes.jsonl', 'usage.jsonl', 'runs.jsonl'];
  const journalContents = journals.map(file => fs.readFileSync(path.join(home, file), 'utf8'));
  for (const [args, input] of [[['--provider', 'no-such-provider'], 'x'], [['--provider', 'trial'], ''],
    [['--provider', 'trial'], 'x'.repeat(runner.MAX_PROMPT + 1)],
    [['--provider', 'trial'], 'x'.repeat((process.platform === 'win32' ? 24 : 100) * 1024)]]) {
    const refused = spawnSync(process.execPath, [script, ...args], { cwd: project, env, input, encoding: 'utf8' });
    assert.equal(refused.status, 2); assert.equal(refused.stderr.trimEnd().split('\n').length, 1); assert.equal(refused.stdout, '');
    assert.equal(fs.existsSync(observed), false);
  }
  cfg.providers.providers.trial.cli.args.push('--yes');
  fs.writeFileSync(path.join(home, 'config', 'providers.json'), JSON.stringify(cfg.providers));
  const denied = spawnSync(process.execPath, [script, '--provider', 'trial'], { cwd: project, env, input: 'x', encoding: 'utf8' });
  assert.equal(denied.status, 2); assert.match(denied.stderr, /disables sandbox or permission checks/);
  assert.equal(fs.existsSync(observed), false);
  assert.deepEqual(journals.map(file => fs.readFileSync(path.join(home, file), 'utf8')), journalContents);
});

test('Git fingerprints hash binary diffs and untracked contents, with bounded file sizes and counts', t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-cli-fingerprint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), project = path.join(dir, 'project');
  fs.mkdirSync(bin); fs.mkdirSync(project);
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'git.exe' : 'git'), '', { mode: 0o755 });
  const env = { PATH: bin };
  let files = ['binary.dat'], diff = Buffer.from([0, 255]), head = true, error = false;
  fs.writeFileSync(path.join(project, files[0]), Buffer.from([255]));
  const spawn = (file, args, options) => {
    assert.equal(options.shell, false); assert.equal(options.cwd, project);
    assert.equal(args[0], '--no-optional-locks');
    if (error) return { status: null, error: new Error('Git failed') };
    let stdout;
    switch (args[1]) {
      case 'rev-parse':
        if (args[2] === '--show-toplevel') stdout = project + '\n';
        else if (head) stdout = 'abcdef\n';
        else return { status: 1 };
        break;
      case 'status':
        assert.deepEqual(args.slice(2), ['--porcelain', '--untracked-files=all', '-z']);
        stdout = ' M tracked.txt\0' + files.map(name => '?? ' + name + '\0').join(''); break;
      case 'diff':
        assert.ok(args.includes('--binary')); assert.ok(args.includes('--no-ext-diff')); assert.ok(args.includes('--no-textconv'));
        if (head) assert.equal(args[2], 'HEAD');
        stdout = diff; break;
      case 'ls-files': stdout = files.join('\0') + '\0'; break;
      default: assert.fail('Unexpected Git command');
    }
    return { status: 0, stdout: Buffer.from(stdout) };
  };
  const fingerprint = () => runner.gitStatus(project, env, process.platform, spawn);
  const first = fingerprint(); assert.match(first, /^[a-f0-9]{64}$/); assert.equal(fingerprint(), first);
  diff = Buffer.from([0, 254]); assert.notEqual(fingerprint(), first);
  const changed = fingerprint();
  fs.writeFileSync(path.join(project, files[0]), Buffer.from([254])); assert.notEqual(fingerprint(), changed);
  head = false; assert.match(fingerprint(), /^[a-f0-9]{64}$/); head = true;
  files.push('large.dat');
  fs.writeFileSync(path.join(project, 'large.dat'), Buffer.alloc(5 * 1024 * 1024 + 1));
  const large = fingerprint();
  const fd = fs.openSync(path.join(project, 'large.dat'), 'r+');
  fs.writeSync(fd, Buffer.from('changed')); fs.closeSync(fd);
  assert.equal(fingerprint(), large, 'oversized files are skipped');
  files = Array.from({ length: 2001 }, (_, i) => 'file-' + String(i).padStart(4, '0'));
  for (const name of files) fs.writeFileSync(path.join(project, name), '');
  const capped = fingerprint(); assert.match(capped, /^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(project, files[2000]), 'outside cap'); assert.equal(fingerprint(), capped);
  fs.writeFileSync(path.join(project, files[1999]), 'inside cap'); assert.notEqual(fingerprint(), capped);
  error = true; assert.equal(fingerprint(), null);
});

test('expect-changes with no Git skips the check in the report line and records no failure', async () => {
  const h = harness(); h.deps.gitStatus = () => runner.gitStatus(process.cwd(), {}, process.platform);
  const result = await runner.run(['--provider', 'trial', '--expect-changes'], h.deps);
  assert.equal(result.code, 0); assert.match(result.report.split('\n')[0], /expect-changes skipped: Git fingerprint unavailable/);
  assert.equal(h.records.feedback.length, 0); assert.equal(h.records.timing[0].ok, true);
});

test('integration: Git fingerprints detect dirty file edits, binary contents and files within untracked directories', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-cli-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = lib.findExecutable('git', process.env, process.platform, dir);
  if (!git) { t.skip('Git unavailable'); return; }
  const init = lib.runExecutable(git, ['init', '-q'], { workingDirectory: dir });
  assert.ifError(init.error); assert.equal(init.status, 0);
  const call = args => lib.runExecutable(git, args, { workingDirectory: dir, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'committed');
  assert.equal(call(['add', 'tracked.txt']).status, 0);
  assert.equal(call(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']).status, 0);
  const status = () => runner.gitStatus(dir, process.env, process.platform);
  const clean = status(); assert.match(clean, /^[a-f0-9]{64}$/); assert.equal(status(), clean);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'dirty');
  const checkChange = async mutate => {
    const h = harness(); h.deps.gitStatus = status;
    const spawn = h.deps.spawn;
    h.deps.spawn = (...args) => { mutate(); return spawn(...args); };
    const result = await runner.run(['--provider', 'trial', '--expect-changes'], h.deps);
    assert.equal(result.code, 0, result.report); assert.doesNotMatch(result.report, /skipped/);
    assert.equal(h.records.feedback.length, 0);
  };
  await checkChange(() => fs.writeFileSync(path.join(dir, 'tracked.txt'), 'dirty again'));
  assert.equal(call(['add', 'tracked.txt']).status, 0);
  await checkChange(() => fs.writeFileSync(path.join(dir, 'tracked.txt'), Buffer.from([0, 255, 1])));
  fs.mkdirSync(path.join(dir, 'new-dir'));
  fs.writeFileSync(path.join(dir, 'new-dir', 'first.txt'), 'first');
  await checkChange(() => fs.writeFileSync(path.join(dir, 'new-dir', 'second.txt'), 'second'));
  const untracked = path.join(dir, 'new-dir', 'binary.dat');
  fs.writeFileSync(untracked, Buffer.from([255]));
  await checkChange(() => fs.writeFileSync(untracked, Buffer.from([254])));
  assert.equal(runner.gitStatus(dir, {}, process.platform), null);
  const noGit = harness(); noGit.deps.gitStatus = () => runner.gitStatus(dir, {}, process.platform);
  const result = await runner.run(['--provider', 'trial', '--expect-changes'], noGit.deps);
  assert.equal(result.code, 0); assert.match(result.report.split('\n')[0], /expect-changes skipped/);
  assert.equal(noGit.records.feedback.length, 0);
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-cli-no-git-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.equal(runner.gitStatus(outside, process.env, process.platform), null);
});

test('real config, project training consent and journal functions work with an injected CLI', async t => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-cli-journals-'));
  const previous = process.env.QUOTA_BOSS_HOME;
  process.env.QUOTA_BOSS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.QUOTA_BOSS_HOME; else process.env.QUOTA_BOSS_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(home, 'config'));
  const cfg = config(); cfg.providers.providers.trial.trainsOnData = true;
  fs.writeFileSync(path.join(home, 'config', 'providers.json'), JSON.stringify(cfg.providers));
  fs.writeFileSync(path.join(home, 'config', 'models.json'), JSON.stringify(cfg.models));
  const h = harness({ status: 1, stderr: 'high demand' });
  for (const key of ['findProjectConfig', 'loadConfig', 'appendOutcome', 'appendUsage', 'recordRun']) delete h.deps[key];
  await assert.rejects(runner.run(['--provider', 'trial'], h.deps), /allowTrainingProviders/);
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ [lib.projectKey(process.cwd())]: { allowTrainingProviders: true } }));
  const result = await runner.run(['--provider', 'trial', '--effort', 'high'], h.deps);
  assert.match(result.report, /FAILED \(limited: provider limit\).*feedback recorded/);
  const journals = {};
  for (const name of ['outcomes', 'usage', 'runs']) {
    const text = fs.readFileSync(path.join(home, name + '.jsonl'), 'utf8');
    assert.equal(text.trimEnd().split('\n').length, 1); assert.doesNotMatch(text, /build it|high demand/);
    journals[name] = JSON.parse(text);
  }
  assert.deepEqual({ ...journals.outcomes, t: 0 }, { t: 0, model: 'tiny', category: 'mechanical', tier: 'trivial', result: 'limited', effort: 'high' });
  assert.equal(journals.usage.provider, 'trial'); assert.equal(journals.usage.amount, 1); assert.equal(journals.usage.unit, 'calls');
  assert.equal(journals.runs.model, 'tiny'); assert.equal(journals.runs.ok, false);
  assert.equal(journals.runs.category, null); assert.equal(journals.runs.tier, null);
});
