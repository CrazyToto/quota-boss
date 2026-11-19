'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const lib = require('./lib');
const { selfTest } = require('./self-test');
const { redactReport, version } = require('./diagnostics');

const TASK = 'Fix clamp.js. It exports a function clamp(value, min, max) for finite numbers with min <= max. '
  + 'Return min below the range, max above the range, and value inside the range. Keep the CommonJS export.';
const MODULE = 'module.exports = (value, min, max) => value < min ? max : value > max ? min : value;\n';
const CHECKS = [
  [-9, -5, -1, -5],
  [12, 2, 7, 7],
  [3.5, 2, 7, 3.5],
  [8, 8, 8, 8],
];
const ISSUE = 'https://github.com/CrazyToto/quota-boss/issues/new?template=provider_report.md';

function issueLink(title, report, filename) {
  const prefix = ISSUE + '&title=' + encodeURIComponent(title) + '&body=';
  const full = prefix + encodeURIComponent('Plan: <!-- Fill in your plan. -->\n\n' + report);
  return full.length <= 6000 ? full : prefix + encodeURIComponent('Plan: <!-- Fill in your plan. -->\n\nPlease attach ' + filename + '.');
}

function codingTask(cli, model, executable, { platform, env, find, spawnSync, timeout }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-boss-provider-report-'));
  try {
    const git = find('git');
    if (git) lib.runExecutable(git, ['init', '-q'], { platform, env, spawnSync, workingDirectory: directory, stdio: 'ignore', timeout: 5000 });
    const modulePath = path.join(directory, 'clamp.js');
    fs.writeFileSync(modulePath, MODULE);
    fs.writeFileSync(path.join(directory, 'TASK.md'), TASK + '\n');
    const prompt = 'Read TASK.md and make the requested change in the current folder.';
    const effort = cli.args.some(arg => arg.includes('{effort}'))
      ? ['low', 'medium', 'high', 'xhigh'].find(level => model.efforts?.includes(level)) : undefined;
    const args = lib.cliArgsForModel(cli, model.cliModel, effort).map(arg => arg.replaceAll('{prompt}', prompt));
    const stdin = cli.promptVia === 'stdin';
    const native = lib.nativeLauncher(cli.command, env, platform, directory);
    const started = process.hrtime.bigint();
    const result = lib.runExecutable(executable, args, {
      platform, env: lib.childEnv(cli.command, env, native, platform), spawnSync, workingDirectory: directory,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], ...(stdin ? { input: prompt } : {}),
      encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
    });
    const seconds = (Number(process.hrtime.bigint() - started) / 1e9).toFixed(1);
    const output = [result.stdout, result.stderr].join('\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const reported = output.match(/^\s*model\s*[:=][ \t]*([^\r\n]+)/im)?.[1]?.trim() || 'unknown';
    let error = 'none';
    if (result.error?.code === 'ETIMEDOUT') error = 'timeout';
    else if (/rate limit|\b429\b|too many requests|quota exceeded|exceeded (your )?quota|out of quota|overloaded|\b503\b/i.test(output)) error = 'limit';
    else if (result.error || result.status !== 0) error = 'exit code';

    // Run each assertion in its own bounded process after the provider has exited.
    const passed = CHECKS.filter(([value, min, max, expected]) => {
      const assertion = 'require("node:assert/strict").equal(require(process.argv[1])('
        + [value, min, max].join(',') + '), ' + expected + ');';
      const check = child.spawnSync(process.execPath, ['-e', assertion, modulePath], {
        cwd: directory, env: { ...env, NODE_OPTIONS: '' }, stdio: 'ignore', timeout: 2000, windowsHide: true,
      });
      return !check.error && check.status === 0;
    }).length;
    return { seconds, reported, error, passed };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function providerReport(id, options = {}) {
  const config = options.config || lib.loadConfig();
  const provider = lib.validProviderId(id) && Object.hasOwn(config.providers.providers, id) && config.providers.providers[id];
  if (!provider) throw new Error('Unknown provider id.');
  if (!provider.cli) throw new Error('Provider has no CLI.');
  if (provider.tos === 'avoid') throw new Error('Provider tos avoid.');
  const models = Object.entries(config.models.models || {}).filter(([key, model]) => options.model !== undefined
    ? key === options.model && model.pool === id : model.pool === id && model.enabled !== false);
  if (!models.length) throw new Error(options.model !== undefined ? 'Unknown model or model belongs to another provider.' : 'No models to test.');

  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const find = options.findExecutable || (name => lib.findExecutable(name, env, platform));
  const spawnSync = options.spawnSync || child.spawnSync;
  const executable = find(provider.cli.command);
  if (!executable) throw new Error(provider.cli.command + ' is not installed. Run quota-boss use ' + id + ' on first.');
  const cliVersion = lib.runExecutable(executable, ['--version'], { platform, env, spawnSync, encoding: 'utf8', timeout: 1000, maxBuffer: 65536 });
  const packageVersion = version(lib.readJson(path.join(__dirname, '..', 'package.json'), {}).version) || 'unknown';
  const clean = value => redactReport(value, env).replace(/[|]/g, '\\|').replace(/[\x00-\x1f\x7f]/g, ' ');
  const providerName = clean(id);
  const lines = [
    '# Provider report for ' + providerName, '',
    'Quota Boss ' + packageVersion,
    'OS ' + clean(platform + ' ' + os.release()),
    'CLI ' + clean(provider.cli.command) + ' ' + (!cliVersion.error && cliVersion.status === 0 && version(cliVersion.stdout) || 'unavailable'),
    '',
    '| Model | Self-test | Hidden checks | Seconds (task) | CLI reported model | Error class |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const say = options.say || console.log;
  say('Each model runs two CLI calls that can count against your limit.');
  for (const [key, model] of models) {
    const summary = selfTest(id, { config, model: key, platform, env, findExecutable: find, spawnSync,
      timeout: Math.min(options.timeout ?? 180000, 180000) });
    const passed = summary.split('\n').at(-1).startsWith('PASS ');
    // A limit, timeout or missing login makes the second call fail the same way: skip it, and pause a limited model
    // through the same 15-minute exclusion the worker path uses.
    const blocked = /: (rate limited|timed out|not signed in|not installed)$/.exec(summary)?.[1];
    if (blocked === 'rate limited') {
      try { (options.appendOutcome || lib.appendOutcome)({ model: key, category: 'mechanical', tier: 'trivial', result: 'limited' }, config.models, [], Date.now()); }
      catch { /* the report still prints */ }
    }
    const task = blocked ? { passed: 0, seconds: '-', reported: '-', error: 'none' }
      : codingTask(provider.cli, model, executable, { platform, env, find, spawnSync,
        timeout: Math.min(options.timeout ?? 300000, 300000) });
    const selfError = passed ? 'none' : summary.endsWith(': timed out') ? 'timeout'
      : summary.endsWith(': rate limited') ? 'limit' : 'exit code';
    const error = task.error === 'none' ? selfError : task.error;
    lines.push('| ' + [clean(key), passed ? 'PASS' : 'FAIL', task.passed + '/' + CHECKS.length,
      task.seconds, clean(task.reported), error].join(' | ') + ' |');
  }

  const report = lines.join('\n') + '\n';
  const filename = 'quota-boss-report-' + id + '.md';
  fs.writeFileSync(path.join(options.cwd || process.cwd(), filename), report);
  say(report.trimEnd());
  const link = issueLink('Provider report: ' + providerName, report, filename);
  const attach = 'Attach ' + filename + '.';
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return link + '\n' + attach;
  if (/^(?:y(?:es)?)?$/i.test((options.ask || lib.askLine)('Open a prefilled GitHub issue? [Y/n] ').trim())) {
    if (!require('./tools').openPage(link)) return link + '\n' + attach;
    if (link.endsWith(encodeURIComponent('Please attach ' + filename + '.'))) return attach;
  }
  return 'Saved ' + filename + '.';
}

module.exports = { providerReport, issueLink };
