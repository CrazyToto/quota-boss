'use strict';

const fs = require('node:fs');
const path = require('node:path');
const graph = require('./graph');

function main(directory, token, options = {}) {
  try {
    if (!directory || !token || fs.readFileSync(path.join(directory, 'graphify-out', graph.LOCK_NAME), 'utf8') !== token) return;
    directory = path.resolve(directory);
    const file = graph.executable('graphify', directory, options);
    if (!graph.graphOutputSafe(directory)) return;
    graph.run(file, ['update', directory], __dirname, options);
  } catch { /* Background maintenance never interrupts a session. */ }
  finally { if (directory && token) graph.releaseLock(directory, token); }
}

if (require.main === module) main(process.argv[2], process.argv[3]);
module.exports = { main };
