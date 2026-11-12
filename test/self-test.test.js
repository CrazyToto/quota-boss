'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const { selfTest, evidenceStatus } = require('../scripts/self-test');
const cli = require('../scripts/quota-boss');

test.describe('provider self-tests', () => {
  let home, previous, exitCode, config, calls, directories;
  test.beforeEach(() => {
    home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-tests-'));
    previous = Object.fromEntries(['QUOTA_BOSS_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map(k => [k, process.env[k]]));
    Object.assign(process.env, { QUOTA_BOSS_HOME: path.join(home, 'boss'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex') });
    exitCode = process.exitCode;
    config = { providers: { providers: { trial: { label: 'Trial', kind: 'subscription', enabled: true, worker: 'cli-worker', tos: 'official-cli',
      quota: { source: 'counter', windows: { daily: { budget: 10, unit: 'calls' } } },
      cli: { command: 'trial', args: ['--model', '{model}', '--effort', '{effort}', '{prompt}'], defaultEffort: 'high' } } } },
      models: { models: { tiny: { pool: 'trial', cliModel: 'vendor/tiny', efforts: ['high', 'low', 'medium'] } } } };
    calls = []; directories = [];
  });
  test.afterEach(() => {
    process.exitCode = exitCode;
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const dir of directories) assert.equal(fs.existsSync(dir), false, 'temporary workspace removed');
    fs.rmSync(home, { recursive: true, force: true });
  });
  function options(result = { status: 0 }, write = true) {
    return { config, platform: 'linux', env: { PATH: '/trusted' }, now: () => 123000, findExecutable: name => '/trusted/' + name,
      spawnSync(file, args, opts) {
        if (args[0] === 'init') { directories.push(opts.cwd); return { status: 1 }; }
        calls.push({ file, args, opts });
        assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
        assert.equal(opts.timeout, 180000); assert.equal(opts.shell, false);
        assert.ok(fs.existsSync(opts.cwd));
        if (write) fs.writeFileSync(path.join(opts.cwd, 'quota-boss-self-test.txt'), write === true ? args.at(-1).match(/[a-f0-9]{48}/)[0] : 'wrong');
        if (result instanceof Error) throw result;
        return result;
      } };
  }
  function seed() { lib.writeState({ selfTests: { tiny: { result: 'pass', at: 1 }, other: { result: 'pass', at: 2 } }, preserved: true }); }
  test('the prompt repeated in the output is not mistaken for an error', () => {
    seed();
    assert.match(selfTest('trial', options({ status: 0, stdout: 'Write to quota-boss-self-test.txt was denied.', stderr: '' }, false)), /FAIL tiny: exit 0 but the work was not done/);
    assert.equal(lib.readState().selfTests.tiny, undefined);
  });
  test('a banner that only mentions quota is not a rate limit', () => {
    seed();
    assert.match(selfTest('trial', options({ status: 2, stdout: 'Quota remaining: 95%', stderr: '' }, false)), /FAIL tiny: exit code 2/);
    assert.equal(lib.readState().selfTests.tiny, undefined);
  });
  test('a model without an effort list keeps the CLI default, so an effort slug still names the model', () => {
    config.providers.providers.trial.cli.args = ['--model', '{model}-{effort}', '{prompt}'];
    delete config.models.models.tiny.efforts;
    assert.match(selfTest('trial', options()), /PASS tiny/);
    assert.deepEqual(calls[0].args.slice(0, 2), ['--model', 'vendor/tiny-high']);
  });
  test('pass records only self-test state and counter usage, with closed stdin and lowest effort', () => {
    assert.match(selfTest('trial', options()), /PASS tiny 0.0 s/);
    assert.deepEqual(lib.readState().selfTests.tiny, { result: 'pass', at: 123000 });
    assert.equal(lib.readUsage(123000).entries.length, 1);
    assert.equal(calls[0].args[3], 'low');
    assert.equal(fs.existsSync(lib.getPaths().outcomesFile), false);
    assert.equal(fs.existsSync(path.join(lib.getPaths().quotaBossHome, 'runs.jsonl')), false);
  });
  for (const [name, result, write, reason, retained, usage] of [
    ['no file', { status: 0 }, false, 'exit 0 but the work was not done (often a missing edit permission)', false, 1],
    ['wrong content', { status: 0 }, 'wrong', 'exit 0 but the work was not done (often a missing edit permission)', false, 1],
    ['ENOENT', { status: null, error: { code: 'ENOENT' } }, false, 'not installed', true, 0],
    ['timeout', { status: null, error: { code: 'ETIMEDOUT' } }, false, 'timed out', true, 1],
    ['rate limit', { status: 1, stderr: '429 rate limit' }, false, 'rate limited', true, 1],
    ['auth', { status: 1, stderr: 'authentication required' }, false, 'not signed in', false, 1],
    ['model', { status: 1, stderr: 'model not found' }, false, 'model not available', false, 1],
    ['throwing spawn', new Error('spawn failed'), false, 'exit code unknown', false, 0],
    ['nonzero with correct file', { status: 2 }, true, 'exit code 2', false, 1]
  ]) test(name + ' preserves or clears state and always cleans up', () => {
    seed(); const text = selfTest('trial', options(result, write));
    assert.ok(text.includes('FAIL tiny: ' + reason), text);
    assert.equal(Boolean(lib.readState().selfTests.tiny), retained);
    assert.equal(lib.readState().preserved, true); assert.ok(lib.readState().selfTests.other);
    assert.equal(lib.readUsage(123000).entries.length, usage);
    assert.equal(process.exitCode, 1);
  });
  test('missing executable does not run or alter state', () => {
    seed(); const opts = options(); opts.findExecutable = name => name === 'git' ? '/trusted/git' : null;
    assert.match(selfTest('trial', opts), /not installed/); assert.equal(calls.length, 0);
    assert.equal(lib.readState().selfTests.tiny.at, 1);
  });
  for (const [reason, patterns] of [
    ['not signed in', ['authentication required', 'not logged in', 'unauthorized', '401', 'api key']],
    ['model not available', ['model not found', 'unknown model', 'invalid model', 'not available']],
    ['rate limited', ['rate limit', '429', 'too many requests', 'quota exceeded', 'exceeded your quota', 'out of quota', 'overloaded', '503']]
  ]) for (const pattern of patterns) test('classifies ' + pattern, () => {
    assert.ok(selfTest('trial', options({ status: 1, stdout: pattern.toUpperCase() }, false)).includes('FAIL tiny: ' + reason));
  });
  test('failure classification follows installation, timeout, auth, model, rate precedence', () => {
    for (const [result, reason] of [
      [{ status: null, error: { code: 'ENOENT' }, stdout: 'unauthorized quota' }, 'not installed'],
      [{ status: null, error: { code: 'ETIMEDOUT' }, stdout: 'unauthorized quota' }, 'timed out'],
      [{ status: 1, stdout: 'unauthorized model not found quota' }, 'not signed in'],
      [{ status: 1, stdout: 'model not found quota' }, 'model not available']
    ]) assert.ok(selfTest('trial', options(result, false)).includes('FAIL tiny: ' + reason));
  });
  test('nonzero diagnostics redact tokens, remove controls and bound output', () => {
    const text = selfTest('trial', options({ status: 7, stderr: '\x1b' + 'SECRET'.repeat(10) + '\x00' + 'a '.repeat(300) }, false));
    const detail = text.split('exit code 7: ')[1];
    assert.match(detail, /<redacted>/); assert.ok(detail.length <= 200);
    assert.doesNotMatch(detail, /SECRET|[\x00-\x1f\x7f]/);
  });
  test('explicit effort overrides lowest level', () => {
    selfTest('trial', { ...options(), effort: 'xhigh' }); assert.equal(calls[0].args[3], 'xhigh');
  });
  test('a template without effort gets no effort argument', () => {
    config.providers.providers.trial.cli.args = ['--model', '{model}', '{prompt}'];
    selfTest('trial', options()); assert.equal(calls[0].args.length, 3);
  });
  test('disabled providers can be tested and counted without enabling them', () => {
    config.providers.providers.trial.enabled = false; selfTest('trial', options());
    assert.equal(config.providers.providers.trial.enabled, false); assert.equal(lib.readUsage(123000).entries.length, 1);
  });
  test('non-counter provider records no usage', () => {
    config.providers.providers.trial.quota = { source: 'none' }; selfTest('trial', options());
    assert.equal(lib.readUsage(123000).entries.length, 0);
  });
  test('disabled models skipped unless explicitly named; all enabled models tested separately', () => {
    config.models.models.off = { ...config.models.models.tiny, enabled: false };
    config.models.models.second = { ...config.models.models.tiny };
    selfTest('trial', options()); assert.equal(calls.length, 2); assert.notEqual(directories[0], directories[1]);
    selfTest('trial', { ...options(), model: 'off' }); assert.ok(lib.readState().selfTests.off);
  });
  for (const model of ['missing', 'foreign']) test('rejects selected ' + model + ' model', () => {
    config.models.models.foreign = { pool: 'other' };
    assert.throws(() => selfTest('trial', { ...options(), model }), /Unknown model/); assert.equal(calls.length, 0);
  });
  test('no models is an error', () => {
    config.models.models = {}; assert.throws(() => selfTest('trial', options()), /No models/);
  });
  test('no CLI is refused', () => {
    delete config.providers.providers.trial.cli; assert.throws(() => selfTest('trial', options()), /no CLI/);
  });
  test('tos avoid is refused', () => {
    config.providers.providers.trial.tos = 'avoid'; assert.throws(() => selfTest('trial', options()), /tos avoid/);
  });
  test('invalid effort is refused', () => { assert.throws(() => selfTest('trial', { ...options(), effort: 'ultra' }), /Invalid effort/); });
  test('unknown provider is refused', () => { assert.throws(() => selfTest('unknown', options()), /Unknown provider/); });
  test('evidence validates direct and merged entries including disabled providers', () => {
    for (const evidence of ['docs', 'real', undefined]) {
      config.providers.providers.trial.evidence = evidence; lib.validateProviders(config.providers);
    }
    for (const evidence of ['wrong', null, false, 1, {}]) {
      assert.throws(() => lib.mergeProviders(config.providers, { providers: { trial: { enabled: false, evidence } } }), /evidence/);
      config.providers.providers.trial.evidence = evidence;
      assert.throws(() => lib.validateProviders(config.providers), /evidence/);
    }
  });
  test('display counts enabled models only and identifies untested providers', () => {
    assert.equal(evidenceStatus('trial', config.models), 'untested: quota-boss providers test trial');
    assert.equal(evidenceStatus('trial', config.models, { tiny: { result: 'pass' } }), 'self-test passed (1 of 1 models)');
  });
  test('an effort placeholder with no model levels uses the CLI default effort', () => {
    delete config.models.models.tiny.efforts;
    selfTest('trial', options());
    assert.deepEqual(calls[0].args.slice(0, 4), ['--model', 'vendor/tiny', '--effort', 'high']);
  });
  test('a correct file with exit zero passes even if output contains failure words', () => {
    assert.match(selfTest('trial', options({ status: 0, stdout: 'quota model not found unauthorized' })), /PASS tiny/);
  });
  test('warning comes before the real-call notice', () => {
    config.providers.providers.antigravity = config.providers.providers.trial;
    config.models.models.tiny.pool = 'antigravity';
    const text = selfTest('antigravity', options());
    assert.ok(text.startsWith('Warning: Account risk.'));
    assert.ok(text.indexOf('Each test is a real call') > text.indexOf('Warning:'));
  });
  for (const extension of ['cmd', 'ps1']) test('Windows ' + extension + ' shims preserve the isolated cwd and closed stdin', () => {
    const opts = options(); opts.platform = 'win32';
    opts.findExecutable = name => name === 'git' ? null : 'C:\\trusted\\trial.' + extension;
    opts.spawnSync = (file, args, spawnOptions) => {
      directories.push(spawnOptions.cwd);
      assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(spawnOptions.env.NoDefaultCurrentDirectoryInExePath, '1');
      assert.equal(spawnOptions.shell, false);
      assert.match(file, extension === 'cmd' ? /System32[\\/]cmd.exe$/ : /WindowsPowerShell[\\/]v1.0[\\/]powershell.exe$/);
      assert.ok(!args.includes('-ExecutionPolicy'));
      fs.writeFileSync(path.join(spawnOptions.cwd, 'quota-boss-self-test.txt'), args.join(' ').match(/[a-f0-9]{48}/)[0]);
      return { status: 0 };
    };
    assert.match(selfTest('trial', opts), /PASS tiny/);
  });
  test('cleanup failure does not change a passing result', () => {
    const remove = fs.rmSync;
    try {
      fs.rmSync = () => { throw new Error('cleanup denied'); };
      assert.match(selfTest('trial', options()), /PASS tiny/);
    } finally {
      fs.rmSync = remove;
      for (const directory of directories) remove(directory, { recursive: true, force: true });
    }
  });
  test('timeout override is passed through and a numeric clock is supported', () => {
    const opts = options(); opts.timeout = 42; opts.now = 123000;
    opts.spawnSync = (_file, args, spawnOptions) => {
      if (args[0] === 'init') { directories.push(spawnOptions.cwd); throw new Error('git absent'); }
      assert.equal(spawnOptions.timeout, 42);
      fs.writeFileSync(path.join(spawnOptions.cwd, 'quota-boss-self-test.txt'), args.at(-1).match(/[a-f0-9]{48}/)[0]);
      return { status: 0 };
    };
    assert.match(selfTest('trial', opts), /PASS tiny 0.0 s/);
  });
  test('providers command validates options before any CLI can run', () => {
    for (const args of [['providers', 'test'], ['providers', 'test', 'grok', '--bad', 'x'], ['providers', 'test', 'grok', '--model'],
      ['providers', 'test', 'grok', '--effort', 'low', '--effort', 'high']]) assert.throws(() => cli.run(args), /Usage/);
  });
});
