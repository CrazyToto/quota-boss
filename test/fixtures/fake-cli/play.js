// Shared executable; fixtures are plain output, never executable commands.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [provider, scenario, observed, output, ...args] = process.argv.slice(2);
fs.writeFileSync(observed, JSON.stringify({ pid: process.pid, args }));
const sample = fs.readFileSync(path.join(__dirname, provider, scenario + '.txt'), 'utf8').split('\n').slice(1).join('\n');
if (scenario === 'timeout') { setInterval(() => {}, 1000); return; }
if (['success', 'partial-write', 'bad-output'].includes(scenario)) fs.writeFileSync(output, scenario);
if (['auth-error', 'rate-limit', 'partial-write'].includes(scenario)) process.stderr.write(sample);
else process.stdout.write(sample);
process.exitCode = scenario === 'cancel' ? 130 : ['auth-error', 'rate-limit', 'partial-write'].includes(scenario) ? 1 : 0;
