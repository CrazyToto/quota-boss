'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const cli = require('../scripts/quota-boss');
const lib = require('../scripts/lib');
const { providerReport, issueLink } = require('../scripts/provider-report');

function fixture(t, scenario, output = 'model: observed-model') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-report-test-'));
  const exitCode = process.exitCode;
  const printed = [];
  const writes = [];
  const taskCalls = [];
  const model = { pool: 'grok', cliModel: 'example' };
  const config = {
    providers: { providers: { grok: { cli: { command: 'fake-cli', args: ['{model}', '{prompt}'] }, quota: {} }, manual: {} } },
    models: { models: { example: model, disabled: { ...model, enabled: false } } },
  };
  t.mock.method(lib, 'updateState', update => writes.push(update({})));
  t.after(() => {
    process.exitCode = exitCode;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const options = {
    config, cwd, interactive: false, say: value => printed.push(value),
    ask: () => assert.fail('Non-TTY report prompted'),
    findExecutable: () => process.execPath,
    spawnSync: (_file, args, opts) => {
      if (args[0] === '--version') return { status: 0, stdout: 'fake-cli 1.2.3' };
      if (args[0] === 'init') {
        fs.mkdirSync(path.join(opts.cwd, '.git'));
        return { status: 0 };
      }
      const nonce = args.join(' ').match(/[a-f0-9]{48}/)?.[0];
      if (nonce) {
        fs.writeFileSync(path.join(opts.cwd, 'quota-boss-self-test.txt'), nonce);
        return { status: 0 };
      }
      taskCalls.push(opts);
      assert.deepEqual(fs.readdirSync(opts.cwd).sort(), ['.git', 'TASK.md', 'clamp.js']);
      const modulePath = path.join(opts.cwd, 'clamp.js');
      if (scenario === 'pass') fs.writeFileSync(modulePath, 'module.exports = (v, min, max) => Math.min(max, Math.max(min, v));');
      if (scenario === 'partial') fs.writeFileSync(modulePath, 'module.exports = (v, min, max) => v < min ? min : v;');
      if (scenario === 'fail') fs.writeFileSync(modulePath, 'module.exports = () => null;');
      if (scenario === 'timeout') return { status: null, error: { code: 'ETIMEDOUT' } };
      return { status: scenario === 'limit' ? 1 : 0, stdout: output, stderr: scenario === 'limit' ? 'Rate limit' : '' };
    },
  };
  return { options, config, printed, writes, taskCalls, read: () => fs.readFileSync(path.join(cwd, 'quota-boss-report-grok.md'), 'utf8') };
}

for (const [scenario, score, error] of [['pass', 4, 'none'], ['partial', 3, 'none'], ['fail', 0, 'none'], ['timeout', 2, 'timeout'], ['limit', 2, 'limit']]) {
  test('provider report scores ' + scenario, t => {
    const { options, read, writes, taskCalls } = fixture(t, scenario);
    providerReport('grok', options);
    assert.match(read(), new RegExp('example \\| PASS \\| ' + score + '/4 \\| [0-9.]+ \\| '
      + (scenario === 'timeout' ? 'unknown' : 'observed-model') + ' \\| ' + error));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].selfTests.example.result, 'pass');
    assert.equal(taskCalls.length, 1);
    assert.equal(taskCalls[0].timeout, 300000);
    assert.equal(fs.existsSync(taskCalls[0].cwd), false);
  });
}

test('non-TTY prints a redacted report and returns a prefilled link and attach line', t => {
  const { options, config, printed, read } = fixture(t, 'pass', 'model: ' + os.homedir() + ' alice@example.com');
  t.mock.method(lib, 'loadConfig', () => config);
  t.mock.method(require('../scripts/tools'), 'openPage', () => assert.fail('Non-TTY report opened a browser'));
  const result = cli.run(['providers', 'report', 'grok', '--model', 'disabled'], options);
  const report = read();
  assert.equal(printed.at(-1), report.trimEnd());
  assert.match(report, /CLI fake-cli 1\.2\.3/);
  assert.match(report, /disabled \| PASS \| 4\/4 .*<redacted> <redacted>/);
  assert.ok(!report.includes(os.homedir()) && !report.includes('alice@example.com'));
  const [link, attach] = result.split('\n');
  assert.equal(new URL(link).searchParams.get('template'), 'provider_report.md');
  assert.ok(new URL(link).searchParams.get('body').endsWith(report));
  assert.equal(attach, 'Attach quota-boss-report-grok.md.');
});

test('oversize encoded report falls back to an attach request', () => {
  const link = issueLink('Provider report: grok', 'é'.repeat(1200), 'quota-boss-report-grok.md');
  assert.ok(link.length < 6000);
  assert.match(new URL(link).searchParams.get('body'), /attach quota-boss-report-grok\.md/);
});

test('TTY defaults to yes and prints the issue link if the opener declines it', t => {
  const { options, printed } = fixture(t, 'pass');
  options.interactive = true;
  options.ask = question => {
    assert.equal(question.trim(), 'Open a prefilled GitHub issue? [Y/n]');
    assert.match(printed.at(-1), /Hidden checks/);
    return '';
  };
  const opener = t.mock.method(require('../scripts/tools'), 'openPage', () => false);
  const [link, attach] = providerReport('grok', options).split('\n');
  assert.deepEqual(opener.mock.calls.map(call => call.arguments), [[link]]);
  assert.equal(attach, 'Attach quota-boss-report-grok.md.');
});

test('unknown providers and providers without a CLI fail before running anything', t => {
  const { options, config } = fixture(t, 'fail');
  t.mock.method(lib, 'loadConfig', () => config);
  assert.throws(() => cli.run(['providers', 'report', 'toString'], options), /Unknown provider id/);
  assert.throws(() => cli.run(['providers', 'report', 'manual'], options), /Provider has no CLI/);
});

test('a rate-limited self-test skips the coding task and pauses the model', t => {
  const { options, read, taskCalls } = fixture(t, 'pass');
  const spawn = options.spawnSync, outcomes = [];
  options.spawnSync = (file, args, opts) => /[a-f0-9]{48}/.test(args.join(' '))
    ? { status: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests' } : spawn(file, args, opts);
  options.appendOutcome = outcome => outcomes.push(outcome);
  providerReport('grok', options);
  assert.equal(taskCalls.length, 0, 'no second call after a limit');
  assert.deepEqual(outcomes.map(o => [o.model, o.result]), [['example', 'limited']]);
  assert.match(read(), /example \| FAIL \| 0\/4 \| - \| - \| limit/);
});
