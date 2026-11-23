
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const child = require('node:child_process');
const runner = require('../scripts/cli-run');
const diagnostics = require('../scripts/diagnostics');
const shipped = require('../config/providers.json').providers;
const registry = require('../config/models.json').models;
const root = path.join(__dirname, 'fixtures', 'fake-cli');
const cases = { success: ['ok', null], 'bad-output': ['ok', null], 'partial-write': ['failed', null],
  timeout: ['timeout', 'fail'], 'auth-error': ['unavailable', 'unavailable'], 'rate-limit': ['limited', 'fail'], cancel: ['failed', null], 'no-change': ['no-work', 'fail'] };

// Keep the actual shipped template intact. Only the process-launch dependency redirects to Node.
test('every shipped CLI template against local executables', { concurrency: true }, async t => {
  await Promise.all(Object.entries(shipped).filter(([, p]) => p.cli).map(([id, original]) => t.test(id, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-contract-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const provider = { ...original, enabled: true };
    const entry = Object.entries(registry).find(([, model]) => model.pool === id);
    const model = entry?.[0] || 'contract-model';
    const config = { providers: { providers: { [id]: provider } }, models: { models: { [model]: entry?.[1] || { pool: id } } } };
    const prompt = 'write expected.txt; literal "quotes" & % $value\nsecond line {model}';
    // Independent expansion: explicit effort and default model, as requested by the invocation below.
    const full = 'Your working directory is ' + path.resolve(dir) + ' and every file is inside it. Use relative file paths.\n\n' + prompt;
    const stdin = original.cli.promptVia === 'stdin';
    const expected = original.cli.args.map(arg => arg.replaceAll('{effort}', 'high').replaceAll('{model}', original.cli.defaultModel || '').replaceAll('{prompt}', full));
    for (const [scenario, [kind, feedback]] of Object.entries(cases)) {
      const observed = path.join(dir, 'argv.json'), output = path.join(dir, 'expected.txt');
      fs.rmSync(output, { force: true }); fs.rmSync(observed, { force: true });
      const journals = { timing: [], feedback: [], usage: [] };
      let spawned, killed = false, clock = 0, input, sessionArgs = [];
      const result = await runner.run(['--provider', id, '--effort', 'high', '--expect-changes'], {
        prompt, env: {}, findProjectConfig: () => ({ directory: dir, allowTrainingProviders: true }), loadConfig: () => config, homedir: () => dir,
        findExecutable: command => { assert.equal(command, original.cli.command); return process.execPath; },
        gitStatus: () => fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : 'before', now: () => (clock += 1000),
        recordRun: value => journals.timing.push(value), appendOutcome: value => journals.feedback.push(value), appendUsage: (...args) => journals.usage.push(args),
        setTimeout: (fn, ms) => setTimeout(fn, ms === runner.TIMEOUT_MS ? (scenario === 'timeout' ? 500 : 30000) : 300),
        spawn(file, args, options) {
          if (file !== process.execPath) throw new Error('No external executables permitted');
          // cli-run adds Junie's private JSON report file and Copilot's session id; everything else is the template.
          const report = args.filter(arg => arg.startsWith('--json-output-file='));
          assert.equal(report.length, original.cli.command === 'junie' ? 1 : 0);
          const session = args.indexOf('--session-id');
          assert.equal(session >= 0, original.cli.command === 'copilot');
          if (session >= 0) { assert.match(args[session + 1], /^[0-9a-f-]{36}$/); sessionArgs = args.slice(session, session + 2); }
          assert.deepEqual(args.filter((arg, i) => !report.includes(arg) && (session < 0 || i < session || i > session + 1)), expected); assert.equal(options.shell, false); assert.equal(options.cwd, dir);
          // A stdin template carries the prompt only on stdin, never in argv.
          assert.equal(args.filter(arg => arg.includes(prompt)).length, stdin ? 0 : 1);
          assert.equal(options.stdio[0], stdin ? 'pipe' : 'ignore');
          assert.ok(!args.some(arg => /^(--(?:yolo|yes|full-auto|no-sandbox|allow-all|skip-permissions)|-y)$/.test(arg)));
          spawned = child.spawn(process.execPath, [path.join(root, 'play.js'), id, scenario, observed, output, ...args], options);
          if (stdin) { const end = spawned.stdin.end.bind(spawned.stdin); spawned.stdin.end = value => { input = value; return end(value); }; }
          const kill = spawned.kill.bind(spawned);
          spawned.kill = signal => { killed = true; return kill(signal); };
          return spawned;
        },
        kill(pid, signal) { killed = true; process.kill(pid, signal); },
      });
      assert.equal(result.code, kind === 'ok' ? 0 : 1, id + '/' + scenario + ': ' + result.report);
      assert.match(result.report, kind === 'ok' ? /cli-run: ok/ : new RegExp('FAILED \\(' + kind + ':'));
      assert.deepEqual(journals.feedback.map(value => value.result), feedback ? [feedback] : []);
      assert.equal(journals.timing.length, 1); assert.equal(journals.timing[0].ok, kind === 'ok');
      assert.equal(journals.timing[0].seconds, 1); assert.equal(journals.timing[0].model, model);
      assert.equal(journals.usage.length, provider.quota.source === 'counter' ? 1 : 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(observed)).args.filter(arg => !arg.startsWith('--json-output-file=') && !sessionArgs.includes(arg)), expected);
      assert.equal(input, stdin ? full : undefined);
      assert.equal(fs.existsSync(output), ['success', 'partial-write', 'bad-output'].includes(scenario));
      if (scenario === 'timeout') {
        assert.match(result.report, /FAILED \(timeout: 10-minute timeout\)/);
        assert.equal(journals.feedback[0].kind, 'timeout');
        assert.equal(killed, true); assert.ok(spawned.exitCode !== null || spawned.signalCode !== null);
        assert.throws(() => process.kill(spawned.pid, 0), /ESRCH|no such process/i);
      }
      assert.doesNotMatch(JSON.stringify(journals), /literal|unauthorized|CLI failed/);
    }
    // Also lock explicit registry model substitution where supported by the template.
    if (entry?.[1].cliModel) {
      const selected = runner.selection({ provider: id, model, effort: 'low' }, config, { allowTrainingProviders: true });
      const args = original.cli.args.map(arg => arg.replaceAll('{effort}', 'low').replaceAll('{model}', entry[1].cliModel));
      if (!original.cli.args.some(arg => arg.includes('{model}'))) {
        const flag = args.findIndex(arg => ['-m', '--model'].includes(arg)); args[flag + 1] = entry[1].cliModel;
      }
      assert.deepEqual(selected.args, args);
    }
  })));
});

test('doctor report contains only safe metadata and seven-day feedback counts', () => {
  const now = Date.now(), secrets = ['private-person', 'private-project', 'private-host', 'private-session', 'sk-123456789abcdef', 'person@example.invalid', 'C:\\Users\\private-person\\private-project', '/home/private-person/private-project'];
  const model = Object.keys(registry)[0];
  const config = { providers: { providers: { grok: { enabled: false, cli: shipped.grok.cli }, [secrets.join(' ')]: { enabled: true } } }, models: { models: { [model]: { pool: 'grok' } } } };
  const deps = { now, env: { USERNAME: secrets[0], PROJECT_NAME: secrets[1], HOSTNAME: secrets[2], SESSION_ID: secrets[3], API_KEY: secrets[4] },
    findProjectConfig: () => ({ enabled: true, profile: 'frugal', rules: 'tiny', directory: secrets[6], name: secrets[1] }),
    loadConfig: () => config, readState: () => ({ selfTests: { [model]: { result: 'pass', at: now, cli: require('../scripts/lib').cliFingerprint('grok', () => process.execPath), text: secrets.join(' ') } }, secret: secrets }),
    findExecutable: name => name === 'grok' ? process.execPath : null,
    spawnSync: () => ({ status: 0, stdout: '1.2.3 ' + secrets.join(' ') }),
    readOutcomes: () => [{ t: now, model, result: 'limited', text: secrets.join(' ') }, { t: now - 8 * 86400000, model, result: 'fail' }, { t: now, model: secrets.join(' '), result: 'unavailable' }] };
  const report = diagnostics.report(deps);
  for (const secret of secrets) assert.ok(!report.includes(secret), secret);
  assert.match(report, /quota-boss \d+\.\d+\.\d+/); assert.match(report, /Boss mode: on; profile=frugal\n/);
  assert.match(report, /grok: enabled=no; CLI found=yes; version=1.2.3; self-test=pass/);
  assert.ok(report.includes(model + ' limited: 1')); assert.doesNotMatch(report, / fail:/);
  assert.match(report, /custom-model-1 unavailable: 1/);
  const dirty = secrets.concat(os.homedir(), os.userInfo().username, os.hostname()).join('\n') + '\ntoken=unlisted-value\nBearer hidden-value';
  const cleaned = diagnostics.redactReport(dirty, deps.env);
  for (const secret of secrets) assert.ok(!cleaned.includes(secret));
  assert.doesNotMatch(cleaned, /unlisted-value|hidden-value/);
  deps.readState = () => ({ selfTests: { [model]: { result: 'pass', at: now - 8 * 86400000 } } });
  assert.match(diagnostics.report(deps), /self-test=stale/);
  deps.readState = () => ({}); assert.match(diagnostics.report(deps), /self-test=none/);
});

test('doctor report and probe cannot be combined', () => {
  assert.throws(() => require('../scripts/quota-boss').run(['doctor', '--report', '--probe']), /Usage:.*doctor/);
  assert.throws(() => require('../scripts/quota-boss').run(['doctor', '--probe', '--report']), /Usage:.*doctor/);
});


test('contract injection can use the runner Windows npm shim resolution', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-contract-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, 'node_modules', 'fake-cli', 'play.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.copyFileSync(path.join(root, 'play.js'), entry);
  const shim = path.join(dir, 'fake.cmd');
  fs.writeFileSync(shim, '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\fake-cli\\play.js" %*\r\n');
  assert.deepEqual(runner.invocation(shim, 'win32'), { file: process.execPath, prefix: [entry] });
});

test('doctor handler preserves normal and probe dispatch and adds report', () => {
  const cli = require('../scripts/quota-boss');
  const original = { doctor: diagnostics.doctor, report: diagnostics.report };
  try {
    diagnostics.doctor = probe => probe ? 'probe' : 'normal'; diagnostics.report = () => 'report';
    assert.equal(cli.run(['doctor']), 'normal'); assert.equal(cli.run(['doctor', '--probe']), 'probe');
    assert.equal(cli.run(['doctor', '--report']), 'report');
  } finally { Object.assign(diagnostics, original); }
});
