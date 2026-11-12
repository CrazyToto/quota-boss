'use strict';
// Local models are for people who already run them, so they have their own switch and need a named model.

const path = require('node:path');
const lib = require('./lib');
const { update } = require('./add-api');

const USAGE = 'Usage: quota-boss local | local on <model> | local off';
// Passed as one argument to `ollama run`: an Ollama model name, which can never look like a flag.
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})?(?::[a-zA-Z0-9][a-zA-Z0-9._-]{0,63})?$/;

const userFile = () => path.join(lib.getPaths().quotaBossHome, 'config', 'providers.json');

function save(change) {
  const file = userFile();
  update(file, user => {
    const next = { ...user, providers: { ...user.providers, ollama: { ...user.providers?.ollama, ...change } } };
    lib.mergeProviders(lib.BUILTIN_PROVIDERS, next);
    return next;
  });
}

function status(config) {
  const ollama = config.providers.providers.ollama;
  if (ollama?.enabled === false) return 'Local models: off. Advanced option, see /boss-local.';
  const model = ollama.cli?.args?.[1];
  return 'Local models: on, model ' + (MODEL_PATTERN.test(String(model)) ? model : '(not set)');
}

function command(args, config) {
  if (!args.length) return status(config);
  if (args[0] === 'off' && args.length === 1) {
    save({ enabled: false });
    return 'Local models are off.';
  }
  if (args[0] === 'on' && args.length === 2) {
    if (!MODEL_PATTERN.test(args[1])) throw new Error('Give an Ollama model name such as llama3.2:3b.');
    save({ enabled: true, cli: { command: 'ollama', args: ['run', args[1], '{prompt}'] } });
    return ['Local models are on with ' + args[1] + '.',
      'Next: 1. quota-boss tools (offers Ollama if it is missing)',
      '      2. ollama pull ' + args[1],
      'Undo: quota-boss local off'].join('\n');
  }
  throw new Error(USAGE);
}

module.exports = { command };
