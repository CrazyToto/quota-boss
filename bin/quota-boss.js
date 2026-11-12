#!/usr/bin/env node
'use strict';
// Entry point for npx and global installs: no arguments or installer flags install, anything else is a command.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FLAGS = new Set(['--dry-run', '--force', '--no-mcp', '--mcp', '--uninstall']);

/** True when every argument is an installer flag or the value of --scan (install.js validates the value). */
function isInstallerArgs(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scan') { i++; continue; }
    if (!FLAGS.has(args[i])) return false;
  }
  return true;
}

function main(args = process.argv.slice(2)) {
  const script = path.join(__dirname, '..', isInstallerArgs(args) ? 'install.js' : path.join('scripts', 'quota-boss.js'));
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (result.error) console.error(`quota-boss: cannot start ${path.basename(script)}: ${result.error.message}`);
  process.exitCode = result.status === null ? 1 : result.status;
}

if (require.main === module) main();

module.exports = { isInstallerArgs, main };
