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

const CLAUDE_MODEL = 'claude-sonnet-5-5';
function claudeConfig() {
  return { providers: { providers: { claude: { kind: 'subscription', enabled: true, tos: 'official-cli',
    trainsOnData: false, quota: { source: 'claude-statusline' } } } },
  models: { models: Object.fromEntries([CLAUDE_MODEL, 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-fable-5-2']
    .map(model => [model, { pool: 'claude', agentModel: model.split('-')[1] }])) } };
}

function claudeHarness(value = { subtype: 'success', is_error: false, result: 'ok' }, status = 0) {
  return harness({ stdout: typeof value === 'string' ? value : JSON.stringify(value), status }, claudeConfig());
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 1234; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
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
      const child = fakeChild();
      records.spawns.push({ file, args, options, child });
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

test('built-in Claude template uses registry model IDs, optional effort and persistent sessions', () => {
  const cfg = claudeConfig();
  for (const model of Object.keys(cfg.models.models)) for (const effort of [undefined, 'low', 'medium', 'high', 'xhigh']) {
    const selected = runner.selection({ provider: 'claude', model, effort }, cfg, {});
    assert.equal(selected.cli.command, 'claude'); assert.equal(selected.claude, true);
    assert.deepEqual(selected.args, ['-p', '--model', model, ...(effort ? ['--effort', effort] : []),
      '--output-format', 'json', '--permission-mode', 'acceptEdits']);
    assert.equal(selected.effort, effort || '-'); assert.equal(selected.cli.defaultModel, undefined);
  }
  assert.equal(cfg.providers.providers.claude.cli, undefined);
});

test('Claude requires --model and keeps provider and model policy checks before launch or journals', async t => {
  const cases = [
    ['missing model', () => {}, [], /Pass --model/],
    ['single model still requires flag', h => { h.cfg.models.models = { [CLAUDE_MODEL]: { pool: 'claude' } }; }, [], /Pass --model/],
    ['disabled', h => { h.cfg.providers.providers.claude.enabled = false; }, ['--model', CLAUDE_MODEL], /disabled/],
    ['manual', h => { h.cfg.providers.providers.claude.kind = 'manual'; }, ['--model', CLAUDE_MODEL], /Manual/],
    ['avoided', h => { h.cfg.providers.providers.claude.tos = 'avoid'; }, ['--model', CLAUDE_MODEL], /tos avoid/],
    ['training', h => { h.cfg.providers.providers.claude.trainsOnData = true; }, ['--model', CLAUDE_MODEL], /allowTrainingProviders/],
    ['foreign model', h => { h.cfg.models.models[CLAUDE_MODEL].pool = 'trial'; }, ['--model', CLAUDE_MODEL], /Unknown model/],
    ['unknown model', () => {}, ['--model', 'unknown'], /Unknown model/],
  ];
  for (const [name, mutate, args, pattern] of cases) await t.test(name, async () => {
    const h = claudeHarness(); mutate(h);
    await assert.rejects(runner.run(['--provider', 'claude', ...args], h.deps), pattern);
    assert.deepEqual(h.records, { feedback: [], timing: [], usage: [], spawns: [] });
  });
});

test('Claude validates the CLI model before launch and uses cliModel when present', async () => {
  const unsafe = claudeHarness(); unsafe.cfg.models.models['-dangerous'] = { pool: 'claude' };
  assert.throws(() => runner.selection({ provider: 'claude', model: '-dangerous' }, unsafe.cfg, {}), /^Error: Invalid model CLI name\.$/);
  await assert.rejects(runner.run(['--provider', 'claude', '--model', '-dangerous'], unsafe.deps), /Invalid --model/);
  assert.deepEqual(unsafe.records, { feedback: [], timing: [], usage: [], spawns: [] });
  for (const cliModel of ['-dangerous', 'bad model', '', 42, 'x'.repeat(129)]) {
    const h = claudeHarness(); h.cfg.models.models[CLAUDE_MODEL].cliModel = cliModel;
    await assert.rejects(runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps), /^Error: Invalid model CLI name\.$/);
    assert.deepEqual(h.records, { feedback: [], timing: [], usage: [], spawns: [] });
  }
  for (const cliModel of ['vendor/sonnet:latest', null]) {
    const h = claudeHarness(); h.cfg.models.models[CLAUDE_MODEL].cliModel = cliModel;
    assert.equal((await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps)).code, 0);
    assert.equal(h.records.spawns[0].args[2], cliModel ?? CLAUDE_MODEL);
    assert.equal(h.records.timing[0].model, CLAUDE_MODEL);
  }
});

test('Claude sends the full literal prompt on stdin and ends it, without adding it to argv', async () => {
  const h = claudeHarness(); h.deps.prompt = 'quotes " & % ! $value\nsecond line {model}';
  h.deps.findExecutable = command => { assert.equal(command, 'claude'); return process.execPath; };
  const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL, '--effort', 'high', '--cwd', process.cwd()], h.deps);
  const call = h.records.spawns[0];
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']); assert.equal(call.options.shell, false);
  assert.equal(call.options.cwd, fs.realpathSync(process.cwd()));
  assert.equal(call.child.stdin.read().toString(), 'Your working directory is ' + call.options.cwd
    + ' and every file is inside it. Use relative file paths.\n\n' + h.deps.prompt);
  assert.equal(call.child.stdin.writableEnded, true);
  assert.deepEqual(call.args, ['-p', '--model', CLAUDE_MODEL, '--effort', 'high', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
  assert.equal(result.code, 0); assert.deepEqual(h.records.usage, []);
});

test('Claude stdin prompts bypass platform argv limits but retain the 200 KiB input limit', async () => {
  for (const platform of ['win32', 'linux']) {
    const h = claudeHarness(); h.deps.platform = platform; h.deps.prompt = 'x'.repeat(runner.MAX_PROMPT);
    h.deps.findExecutable = () => platform === 'win32' ? 'C:\\trusted\\claude.exe' : '/trusted/claude';
    assert.equal((await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps)).code, 0);
    assert.ok(h.records.spawns[0].child.stdin.read().length > runner.MAX_PROMPT);
    const argv = harness(); argv.deps.platform = platform; argv.deps.prompt = 'x'.repeat(110 * 1024);
    await assert.rejects(runner.run(['--provider', 'trial'], argv.deps), /argv limit/);
    assert.equal(argv.records.spawns.length, 0);
  }
  for (const prompt of ['', 'x'.repeat(runner.MAX_PROMPT + 1), '\0']) {
    const h = claudeHarness(); h.deps.prompt = prompt;
    await assert.rejects(runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps), /Prompt/);
    assert.equal(h.records.spawns.length, 0);
  }
});

test('Claude JSON success reports tokens, cost and a bounded untrusted result tail, with metadata-only timing', async () => {
  const value = { type: 'result', subtype: 'success', is_error: false, api_error_status: null,
    result: Array.from({ length: 100 }, (_, i) => 'answer ' + i).join('\n') + '\nAPI_KEY=hide-this',
    usage: { input_tokens: 2, cache_creation_input_tokens: 13698, cache_read_input_tokens: 14180, output_tokens: 4 },
    total_cost_usd: 0.0028836, permission_denials: [], session_id: 'private-session' };
  const h = claudeHarness(' \n' + JSON.stringify(value) + '\r\n ');
  const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL, '--category', 'mechanical', '--tier', 'trivial'], h.deps);
  const lines = result.report.trimEnd().split('\n');
  assert.equal(result.code, 0);
  assert.match(lines[0], /^cli-run: ok .*\| tokens in 13700 cached 14180 out 4 \| \$0\.0029 \| feedback none$/);
  assert.match(lines[1], /untrusted data; tail, at most 60 lines/);
  assert.equal(lines.length, 62); assert.equal(lines[2], 'answer 41'); assert.equal(lines.at(-1), 'API_KEY=<redacted>');
  assert.doesNotMatch(result.report, /private-session|"subtype"|hide-this|answer 40\n/);
  assert.deepEqual(h.records.timing[0].tokens, { input: 13700, cached: 14180, output: 4 });
  assert.doesNotMatch(JSON.stringify(h.records.timing), /answer|private-session/);
  assert.deepEqual(h.records.feedback, []); assert.deepEqual(h.records.usage, []);
});

test('Claude token and cost reports handle zeros, partial usage and absent or invalid numbers', async () => {
  for (const [fields, expected] of [
    [{ usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }, /tokens in 0 cached 0 out 0 \| \$0\.0000/],
    [{ usage: { cache_creation_input_tokens: 7 } }, /tokens in 7 cached 0 out 0/],
    [{ usage: { input_tokens: -1, output_tokens: '4' }, total_cost_usd: '0.2' }, null],
    [{}, null],
  ]) {
    const h = claudeHarness({ subtype: 'success', ...fields });
    const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps);
    assert.equal(result.code, 0);
    if (expected) assert.match(result.report, expected);
    else { assert.doesNotMatch(result.report, /tokens in|\$/); assert.equal(h.records.timing[0].tokens, undefined); }
  }
});

test('Claude token metadata round-trips through the existing latency journal format', async t => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-claude-latency-'));
  const previous = process.env.QUOTA_BOSS_HOME;
  process.env.QUOTA_BOSS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.QUOTA_BOSS_HOME; else process.env.QUOTA_BOSS_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const h = claudeHarness({ subtype: 'success', usage: { input_tokens: 2, cache_creation_input_tokens: 3,
    cache_read_input_tokens: 4, output_tokens: 5 } });
  delete h.deps.recordRun;
  let reads = 0; h.deps.now = () => reads++ === 0 ? 40000 : 42000;
  const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL, '--tier', 'trivial'], h.deps);
  assert.equal(result.code, 0);
  const latency = require('../scripts/latency');
  const entries = latency.readRuns(42000);
  assert.equal(entries.length, 1); assert.equal(entries[0].seconds, 2);
  assert.deepEqual(entries[0].tokens, { input: 5, cached: 4, output: 5 });
  assert.equal(fs.existsSync(path.join(home, 'usage.jsonl')), false);
});

test('Claude JSON errors classify API statuses even on exit zero and record the existing feedback classes', async t => {
  for (const [api_error_status, kind] of [[400, 'structural'], [422, 'structural'], [429, 'limited'], [500, 'limited'],
    [502, 'limited'], [503, 'limited'], [504, 'limited'], [529, 'limited'], [401, 'unavailable'], [403, 'unavailable'],
    [418, 'failed'], [null, 'failed']]) {
    for (const status of [0, 1]) await t.test(api_error_status + ' exit ' + status, async () => {
      const h = claudeHarness({ subtype: 'error_during_execution', is_error: true, api_error_status, result: 'task failed' }, status);
      const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL, '--effort', 'high',
        '--category', 'mechanical', '--tier', 'normal'], h.deps);
      assert.equal(result.code, 1); assert.match(result.report, new RegExp('^cli-run: FAILED \\(' + kind + ':'));
      const reason = api_error_status === null ? 'error_during_execution' : 'api_error_status ' + api_error_status;
      assert.ok(result.report.split('\n')[0].includes('FAILED (' + kind + ': ' + reason + ')'));
      if (kind === 'failed') assert.equal(h.records.feedback.length, 0);
      else {
        assert.deepEqual(h.records.feedback[0][0], { model: CLAUDE_MODEL, category: 'mechanical', tier: 'normal',
          result: kind === 'structural' ? 'fail' : kind, effort: 'high' });
        assert.match(result.report.split('\n')[0], /feedback recorded$/);
      }
      assert.equal(h.records.timing[0].ok, false); assert.equal(h.records.usage.length, 0);
    });
  }
  for (const [fields, reason] of [[{ subtype: 'error_max_turns', is_error: false }, 'error_max_turns'],
    [{ subtype: 'success', is_error: true }, 'error'], [{ subtype: ' success ', is_error: true }, 'error'],
    [{ subtype: '\u001b[31msuccess', is_error: true }, 'error'], [{ is_error: true }, 'error']]) {
    const h = claudeHarness(fields);
    assert.match((await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps)).report,
      new RegExp('FAILED \\(failed: ' + reason + '\\)'));
  }
  const h = claudeHarness({ subtype: 'success', is_error: true, api_error_status: 401 });
  assert.match((await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps)).report,
    /FAILED \(unavailable: api_error_status 401\)/);
});

test('Claude error reasons are cleaned and bounded', async () => {
  const h = claudeHarness({ subtype: '\u001b[31mprivate-secret\n' + 'x'.repeat(200), is_error: true });
  h.deps.env.ACCESS_TOKEN = 'private-secret';
  const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps);
  const reason = result.report.match(/FAILED \(failed: ([^)]*)\)/)[1];
  assert.equal(reason.length, 160); assert.ok(reason.startsWith('<redacted> '));
  assert.doesNotMatch(result.report, /private-secret|\u001b|"subtype"/);
});

test('Claude only treats stderr permission markers as no-work, including split and discarded markers', async () => {
  for (const marker of ['rejected permission', 'auto-rejecting']) for (const status of [0, 7]) {
    const h = claudeHarness({ subtype: 'success', result: marker }, status);
    const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps);
    assert.equal(result.code, status ? 1 : 0);
    assert.match(result.report, status ? /FAILED \(failed: exit 7\)/ : /^cli-run: ok/);
    assert.equal(h.records.feedback.length, 0);
  }
  for (const stream of ['stdout', 'stderr']) {
    const h = claudeHarness();
    h.deps.spawn = () => {
      const child = fakeChild();
      queueMicrotask(() => {
        if (stream === 'stdout') {
          child.stdout.write('{"subtype":"success","result":"rejected per');
          child.stdout.write('mission"}');
        } else {
          child.stdout.write(JSON.stringify({ subtype: 'success' }));
          child.stderr.write('rejected per'); child.stderr.write('mission\n');
          child.stderr.write('x'.repeat(300000));
        }
        child.emit('close', 0);
      });
      return child;
    };
    const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps);
    assert.equal(result.code, stream === 'stdout' ? 0 : 1);
    assert.match(result.report, stream === 'stdout' ? /^cli-run: ok/ : /FAILED \(no-work: permission rejected\)/);
  }
});

test('Claude failure classification uses known envelope statuses, then stderr, without scanning the answer', async () => {
  for (const [fields, stderr, kind, reason] of [
    [{ api_error_status: 429 }, '', 'limited', 'api_error_status 429'],
    [{ api_error_status: 429 }, 'HTTP 400 invalid request', 'limited', 'api_error_status 429'],
    [{ api_error_status: 401 }, 'rate limit', 'unavailable', 'api_error_status 401'],
    [{ api_error_status: null }, 'rate limit', 'limited', 'error_during_execution'],
    [{ api_error_status: 418 }, 'unauthorized', 'unavailable', 'api_error_status 418'],
    [{ api_error_status: '429' }, 'rate limit', 'limited', 'error_during_execution'],
    [{ subtype: 'success', api_error_status: null }, 'rate limit', 'limited', 'error'],
    [{ api_error_status: null }, '', 'failed', 'error_during_execution'],
    [{ api_error_status: 418 }, '', 'failed', 'api_error_status 418'],
    [{ subtype: 'success', is_error: false }, '', 'failed', 'exit 7'],
  ]) {
    const stdout = JSON.stringify({ subtype: 'error_during_execution', is_error: true,
      result: 'invalid request 400; unauthorized; rate limit', ...fields });
    const h = harness({ status: 7, stderr, stdout }, claudeConfig());
    const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps);
    assert.equal(result.code, 1);
    assert.ok(result.report.split('\n')[0].includes('FAILED (' + kind + ': ' + reason + ')'), result.report);
    assert.equal(h.records.timing[0].ok, false);
    assert.equal(h.records.feedback.length, kind === 'failed' ? 0 : 1);
  }
  const h = claudeHarness();
  h.deps.spawn = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ subtype: 'error_during_execution', is_error: true, api_error_status: null }));
      child.stderr.write('rate li'); child.stderr.write('mit\n'); child.stderr.write('x'.repeat(300000));
      child.emit('close', 7);
    });
    return child;
  };
  assert.match((await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps)).report,
    /FAILED \(limited: error_during_execution\)/);
});

test('Claude JSON keeps timeout, permission markers, regex failures and nonzero exits ahead of success', async () => {
  for (const [status, stderr, kind, api_error_status] of [[1, 'HTTP 400 overloaded', 'structural'], [1, 'HTTP 429', 'limited'],
    [1, 'unauthorized', 'unavailable'], [0, 'rejected permission', 'no-work'], [1, '', 'failed'], [0, 'HTTP 429', 'ok'],
    [1, 'HTTP 429', 'structural', 400], [0, 'HTTP 400', 'limited', 429]]) {
    const h = harness({ status, stderr, stdout: JSON.stringify({ subtype: api_error_status ? 'error_during_execution' : 'success',
      is_error: !!api_error_status, api_error_status }) }, claudeConfig());
    const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps);
    assert.match(result.report, kind === 'ok' ? /^cli-run: ok/ : new RegExp('FAILED \\(' + kind + ':'));
  }
  const h = claudeHarness(); const timers = [];
  h.deps.platform = 'linux'; h.deps.findExecutable = () => '/trusted/claude';
  h.deps.setTimeout = (callback, ms) => { timers.push({ callback, ms }); return timers.length; };
  h.deps.clearTimeout = () => {};
  const child = fakeChild();
  h.deps.spawn = () => { queueMicrotask(() => { child.stdout.write(JSON.stringify({ subtype: 'success' })); timers[0].callback(); }); return child; };
  h.deps.kill = () => child.emit('close', null);
  const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps);
  assert.equal(timers[0].ms, 600000); assert.match(result.report, /FAILED \(limited: 10-minute timeout\)/);
  assert.equal(h.records.feedback[0][0].result, 'limited'); assert.equal(h.records.usage.length, 0);
});

test('Claude missing, non-object, invalid and multiple JSON outputs fail and retain the raw tail', async () => {
  for (const stdout of ['', 'plain answer', 'null', '[]', '42', '"answer"', '{broken', '{}\n{}', 'log\n{"subtype":"success"}']) {
    for (const status of [0, 1]) {
      const h = claudeHarness(stdout, status);
      const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps);
      assert.equal(result.code, 1); assert.ok(result.report.includes(stdout));
      assert.match(result.report, status ? /FAILED \(failed: exit 1\)/ : /FAILED \(failed: unparseable JSON result\)/);
      assert.equal(h.records.timing[0].tokens, undefined);
    }
  }
  const h = claudeHarness('HTTP 429', 1);
  assert.match((await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps)).report, /FAILED \(failed: exit 1\)/);
  const stderr = harness({ status: 7, stdout: 'invalid request 400', stderr: 'rate limit' }, claudeConfig());
  assert.match((await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], stderr.deps)).report, /FAILED \(limited: provider limit\)/);
});

test('a truncated Claude stdout tail cannot turn preceding log output into a parsed JSON result', async () => {
  const value = JSON.stringify({ subtype: 'error_during_execution', is_error: true, api_error_status: 429 });
  const h = claudeHarness('log output\n' + ' '.repeat(300000) + value);
  const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps);
  assert.equal(result.code, 1); assert.ok(result.report.includes(value));
  assert.match(result.report, /FAILED \(failed: unparseable JSON result\)/);
  assert.equal(h.records.feedback.length, 0);
});

test('Claude permission denials report unique tool names (at most five) and only unchanged expected changes imply no-work', async () => {
  const permission_denials = ['Read', 'Read', 'Edit', 'Bash', 'Write', 'Glob', 'Grep'].map(tool_name => ({ tool_name }));
  for (const [expect, before, after, kind] of [[false, '', '', 'ok'], [true, 'same', 'same', 'no-work'],
    [true, 'before', 'after', 'ok'], [true, null, null, 'ok']]) {
    const h = claudeHarness({ subtype: 'success', is_error: false, result: 'partial work', permission_denials });
    let reads = 0; h.deps.gitStatus = () => reads++ === 0 ? before : after;
    const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL, ...(expect ? ['--expect-changes'] : [])], h.deps);
    assert.match(result.report, kind === 'ok' ? /^cli-run: ok/ : /FAILED \(no-work: git fingerprint unchanged\)/);
    assert.match(result.report, /Permission denials: 7 \(Read, Edit, Bash, Write, Glob\)/);
    assert.doesNotMatch(result.report, /Grep/); assert.equal(reads, expect ? 2 : 0);
    assert.equal(h.records.feedback.length, kind === 'no-work' ? 1 : 0);
  }
  const h = claudeHarness({ subtype: 'error_during_execution', is_error: true, api_error_status: 429, permission_denials });
  assert.match((await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL, '--expect-changes'], h.deps)).report, /FAILED \(limited:/);
});

test('an explicit Claude CLI retains argv behaviour and the permission bypass denylist', async () => {
  for (const args of [['--permission-mode', 'bypassPermissions'], ['--permission-mode=BYPASSPERMISSIONS'], ['--dangerously-skip-permissions']]) {
    const h = claudeHarness(); h.cfg.providers.providers.claude.cli = { command: 'claude', args: ['-p', '{prompt}', ...args] };
    await assert.rejects(runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps), /disables sandbox or permission checks/);
    assert.deepEqual(h.records, { feedback: [], timing: [], usage: [], spawns: [] });
  }
  const h = claudeHarness({ subtype: 'error_during_execution', is_error: true, api_error_status: 429 });
  h.cfg.providers.providers.claude.cli = { command: 'custom', args: ['-p', '{prompt}'] };
  const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps);
  assert.equal(result.code, 0); assert.match(result.report, /"api_error_status":429/);
  assert.deepEqual(h.records.spawns[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.match(h.records.spawns[0].args[1], /build it/);
});

test('Claude stdin errors, including EPIPE and synchronous writes, leave exit status in control', async () => {
  for (const status of [0, 7]) for (const sync of [false, true]) {
    const h = claudeHarness({ subtype: 'success', result: 'done' }, status); const spawn = h.deps.spawn;
    h.deps.prompt = 'x'.repeat(runner.MAX_PROMPT);
    let input;
    h.deps.spawn = (...args) => {
      const child = spawn(...args);
      child.stdin.end = value => {
        input = value;
        const error = Object.assign(new Error('pipe closed'), { code: 'EPIPE' });
        if (sync) throw error;
        queueMicrotask(() => child.stdin.emit('error', error));
      };
      return child;
    };
    const result = await runner.run(['--provider', 'claude', '--model', CLAUDE_MODEL], h.deps);
    assert.ok(Buffer.byteLength(input) > runner.MAX_PROMPT);
    assert.equal(h.records.spawns[0].child.stdin.readableLength, 0);
    assert.equal(result.code, status ? 1 : 0);
    assert.match(result.report, status ? /FAILED \(failed: exit 7\)/ : /^cli-run: ok/);
    assert.doesNotMatch(result.report, /EPIPE|pipe closed/);
  }
});

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
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch (error) { stdin = ''; }
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({args:process.argv.slice(2), stdin, cwd:process.cwd()}));
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
