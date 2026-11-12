'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('./lib');

/** Copy a prompt with fixed executable arguments and no shell; allow clipboard-free tests. */
function copyPrompt(prompt, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  if ((env.QUOTA_BOSS_NO_CLIPBOARD || env.HARNESS_NO_CLIPBOARD) === '1') return false;
  const commands = platform === 'win32' ? [[path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'clip.exe'), []]]
    : platform === 'darwin' ? [['/usr/bin/pbcopy', []]]
      : [[lib.findExecutable('wl-copy', env, platform), []], [lib.findExecutable('xclip', env, platform), ['-selection', 'clipboard']]];
  for (const [command, args] of commands) {
    const result = lib.runExecutable(command, args, { platform, env, spawnSync: options.spawnSync || spawnSync,
      input: prompt, encoding: 'utf8', timeout: 2000, maxBuffer: 65536 });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

/** Save a manual Perplexity request or an answer supplied through stdin. */
function run(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const directory = path.join(lib.getPaths().quotaBossHome, 'pplx');
  const pending = path.join(directory, 'pending.md');
  if (command === 'ask') {
    let hint = '';
    if (rest[0] === '--model') {
      rest.shift();
      hint = rest.shift();
      if (!hint || hint.startsWith('--')) throw new Error('--model requires a hint.');
    }
    if (rest[0]?.startsWith('--')) throw new Error('Unknown ask option.');
    const prompt = rest.length ? rest.join(' ') : lib.readStdin();
    if (!prompt.trim()) throw new Error('A prompt is required.');
    lib.atomicWrite(pending, '# Perplexity request\n\n' + (hint ? 'Model hint: ' + lib.sanitizeLabel(hint) + '\n\n' : '') + prompt + '\n');
    const copied = copyPrompt(prompt);
    return (copied ? 'Prompt copied to clipboard. ' : 'Copy the prompt from ' + pending + '. ')
      + 'Open Perplexity, submit the prompt' + (hint ? ' using ' + lib.sanitizeLabel(hint) : '')
      + ', then pipe the answer to: node "' + path.join(__dirname, 'pplx.js') + '" result';
  }
  if (command === 'result' && rest.length === 0) {
    const answer = lib.readStdin();
    if (!answer.trim()) throw new Error('An answer is required on stdin.');
    let timestamp = Date.now();
    while (fs.existsSync(path.join(directory, timestamp + '.md'))) timestamp++;
    const file = path.join(directory, timestamp + '.md');
    lib.atomicWrite(file, answer);
    try { fs.unlinkSync(pending); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return file;
  }
  throw new Error('Usage: pplx ask [--model <hint>] <prompt...> | result');
}

/** Run the manual bridge CLI, reporting input errors with exit status one. */
function main() {
  try { process.stdout.write(run() + '\n'); }
  catch (error) { process.stderr.write('pplx: ' + error.message + '\n'); process.exitCode = 1; }
}

if (require.main === module) main();
module.exports = { copyPrompt, run, main };
