'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const lib = require('./lib');
const { PROVIDER_HELP } = require('./provider-help');
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const RESULT_FILE = 'quota-boss-self-test.txt';

function evidenceStatus(id, models = {}, selfTests = {}) {
  const ids = Object.entries(models.models || {}).filter(([, m]) => m.pool === id && m.enabled !== false).map(([key]) => key);
  const passed = ids.filter(key => selfTests?.[key]?.result === 'pass').length;
  return passed ? 'self-test passed (' + passed + ' of ' + ids.length + ' models)'
    : 'untested: quota-boss providers test ' + id;
}
function failure(result, output, correct) {
  if (result.error?.code === 'ENOENT') return 'not installed';
  if (result.error?.code === 'ETIMEDOUT') return 'timed out';
  if (/authentication required|not logged in|unauthorized|\b401\b|api key/i.test(output)) return 'not signed in';
  if (/model not found|unknown model|invalid model|not available/i.test(output)) return 'model not available';
  if (/rate limit|\b429\b|too many requests|quota exceeded|exceeded (your )?quota|out of quota|overloaded|\b503\b/i.test(output)) return 'rate limited';
  if (result.status !== 0) {
    const detail = output.replace(/[\x00-\x1f\x7f-\x9f]/g, '').replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>').slice(0, 200);
    return 'exit code ' + (result.status ?? 'unknown') + (detail ? ': ' + detail : '');
  }
  return correct ? null : 'exit 0 but the work was not done (often a missing edit permission)';
}

/** Real file-write calls, isolated from the checkout; quality feedback stays separate. */
function selfTest(id, options = {}) {
  const config = options.config || lib.loadConfig();
  const provider = Object.hasOwn(config.providers.providers, id) ? config.providers.providers[id] : null;
  if (!provider) throw new Error('Unknown provider id.');
  if (!provider.cli) throw new Error('Provider has no CLI.');
  if (provider.tos === 'avoid') throw new Error('Provider tos avoid.');
  if (options.effort !== undefined && !EFFORTS.includes(options.effort)) throw new Error('Invalid effort.');
  const models = Object.entries(config.models.models || {}).filter(([key, m]) => options.model !== undefined
    ? key === options.model && m.pool === id : m.pool === id && m.enabled !== false);
  if (!models.length) throw new Error(options.model !== undefined ? 'Unknown model or model belongs to another provider.' : 'No models to test.');
  const platform = options.platform || process.platform, env = options.env || process.env;
  const run = options.spawnSync || require('node:child_process').spawnSync;
  const find = options.findExecutable || (name => lib.findExecutable(name, env, platform));
  const now = typeof options.now === 'function' ? options.now : () => options.now ?? Date.now();
  const lines = [];
  if (PROVIDER_HELP[id]?.warning) lines.push('Warning: ' + PROVIDER_HELP[id].warning);
  lines.push('Each test is a real call that counts against the limit.');
  let failed = false;
  for (const [key, model] of models) {
    const nonce = crypto.randomBytes(24).toString('hex');
    const prompt = 'Create ' + RESULT_FILE + ' in the current directory containing exactly ' + nonce + ' and do nothing else.';
    const effort = options.effort ?? (provider.cli.args.some(a => a.includes('{effort}')) ? EFFORTS.find(e => model.efforts?.includes(e)) : undefined);
    // The CLI's default level stays: without it a slug like {model}-{effort} would lose the model and test the wrong one.
    const args = lib.cliArgsForModel(provider.cli, model.cliModel, effort).map(a => a.replaceAll('{prompt}', prompt));
    const started = now();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-boss-self-test-'));
    let reason;
    try {
      try { lib.runExecutable(find('git'), ['init', '-q'], { platform, env, spawnSync: run, workingDirectory: directory, stdio: 'ignore', timeout: 5000 }); } catch {}
      const executable = find(provider.cli.command);
      let result;
      if (!executable) result = { status: null, error: Object.assign(new Error('Not installed'), { code: 'ENOENT' }) };
      else {
        try { result = lib.runExecutable(executable, args, { platform, env, spawnSync: run, workingDirectory: directory,
          stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: options.timeout ?? 180000, maxBuffer: 1024 * 1024 }); }
        catch (error) { result = { status: null, error }; }
      }
      const ran = result.status != null || result.pid > 0 || result.error?.code === 'ETIMEDOUT';
      if (ran && provider.quota.source === 'counter') {
        const units = Object.values(provider.quota.windows).map(w => w.unit);
        const unit = units.includes('calls') ? 'calls' : units[0];
        lib.appendUsage(id, 1, unit, { ...config.providers, providers: { ...config.providers.providers, [id]: { ...provider, enabled: true } } }, now());
      }
      let correct = false;
      try { correct = lib.readBounded(path.join(directory, RESULT_FILE), 4096).trim() === nonce; } catch {}
      // A CLI may repeat the prompt, and its own words must not look like an error.
      const output = (String(result.stdout || '') + '\n' + String(result.stderr || '')).split(nonce).join('').split(RESULT_FILE).join('');
      reason = result.status === 0 && correct ? null : failure(result, output, correct);
      if (!reason || !['not installed', 'timed out', 'rate limited'].includes(reason)) {
        lib.updateState(state => {
          const selfTests = { ...state.selfTests };
          if (!reason) selfTests[key] = { result: 'pass', at: now() }; else delete selfTests[key];
          return { selfTests };
        });
      }
      if (reason) { failed = true; lines.push('FAIL ' + key + ': ' + reason); }
      else lines.push('PASS ' + key + ' ' + ((now() - started) / 1000).toFixed(1) + ' s');
    } finally { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} }
  }
  if (failed) process.exitCode = 1;
  return lines.join('\n');
}
module.exports = { selfTest, evidenceStatus };
