'use strict';
function alignRight(text, width) { return String(text).padStart(width, ' '); }
function percent(value) { return Math.round(value * 100) + '%'; }
module.exports = { alignRight, percent };
