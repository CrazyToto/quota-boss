'use strict';
// The status line as it would look with a given style, drawn from the real current numbers. A new user without
// numbers yet sees sample values, so every style choice still shows its difference.

const lib = require('./lib');
const { formatStatus } = require('./statusline');
const { ink } = require('./tui');

const SAMPLE = now => ({ claude: { five_hour: { used_percentage: 34, resets_at: Math.floor(now / 1000) + 2 * 3600 }, seven_day: { used_percentage: 52 } },
  codex: { primary: { used_percent: 12 }, secondary: { used_percent: 8 } } });

/** Real limits when they are known, otherwise sample ones. Never throws. */
function currentLimits(now = Date.now()) {
  try {
    const project = lib.findProjectConfig();
    const config = lib.loadConfig(project, { tolerant: true });
    const state = lib.readState();
    const codex = config.providers.providers.codex?.enabled === false ? null : lib.readCodexLimits(now, config.thresholds, true);
    const limits = lib.readProviderLimits(config.providers, { claude: state.claude, codex }, now);
    const values = lib.limitValues(limits);
    if (values.c5h === undefined && values.x5h === undefined) return { limits: SAMPLE(now), thresholds: config.thresholds, sample: true };
    return { limits, thresholds: config.thresholds, sample: false };
  } catch { return { limits: SAMPLE(now), thresholds: {}, sample: true }; }
}

/**
 * Preview lines for a look { style, logos, names } and the "show when boss is off" choice.
 * `numbers` is the result of currentLimits(), passed in so a page does not read files on every key.
 */
function previewLines(look, always, numbers = currentLimits(), now = Date.now()) {
  const project = { enabled: true, profile: 'balanced' };
  const on = formatStatus(numbers.limits, project, numbers.thresholds, now, undefined, '', look);
  const off = always ? formatStatus(numbers.limits, { ...project, enabled: false }, numbers.thresholds, now, undefined, '', look) : ink.sub('(hidden)');
  return [on + '   ' + ink.sub('boss on'), off + '   ' + ink.sub('boss off'), ...(numbers.sample ? [ink.sub('Sample numbers; your own appear once Claude Code has run.')] : [])];
}

module.exports = { currentLimits, previewLines };
