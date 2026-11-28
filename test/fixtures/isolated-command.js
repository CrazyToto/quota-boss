'use strict';
// Tests that run the real installer must never touch the machine's own quota-boss command or a global
// npm copy: the launcher folder points into the sandbox, and PATH loses every folder that has one.
const fs = require('node:fs');
const path = require('node:path');

function isolateCommand(env, sandbox) {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const names = ['quota-boss', 'quota-boss.cmd', 'quota-boss.ps1'];
  const keep = String(env[key] || '').split(delimiter)
    .filter(dir => dir && !names.some(name => { try { fs.lstatSync(path.join(dir.replace(/^"|"$/g, ''), name)); return true; } catch { return false; } }));
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'path' || name.toUpperCase() === 'APPDATA') delete env[name];
  env[key] = keep.join(delimiter);
  env.APPDATA = path.join(sandbox, 'appdata');
  // `npm root -g` then points into the sandbox, so a real global copy is never uninstalled.
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'npm_config_prefix') delete env[name];
  env.npm_config_prefix = path.join(sandbox, 'npm-prefix');
  return env;
}

module.exports = { isolateCommand };
