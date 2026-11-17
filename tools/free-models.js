#!/usr/bin/env node
'use strict';
// Dev tool for the weekly free-models workflow: checks the free presets against downloaded models.dev/OpenRouter lists.
const { command } = require('../scripts/free-models');

if (require.main === module) {
  const result = command(process.argv.slice(2));
  process.stdout.write(result.text + '\n');
  process.exitCode = result.code;
}
