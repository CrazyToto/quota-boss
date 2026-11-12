'use strict';
// Installed adapter for an MCP server supplied as an absolute Windows npm shim.
const lib = require('./lib');
try {
  const [executable, command, ...extra] = process.argv.slice(2);
  if (command !== 'mcp-server' || extra.length) throw new Error('Expected an absolute CLI path and mcp-server.');
  const result = lib.runExecutable(executable, [command], { stdio: 'inherit' });
  process.exitCode = result.status === 0 ? 0 : 1;
} catch { process.stderr.write('quota-boss: could not start trusted MCP executable\n'); process.exitCode = 1; }
