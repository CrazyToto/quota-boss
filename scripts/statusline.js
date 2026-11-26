'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('./lib');
const context = require('./context');

/** 0 below the first threshold, 1 between them, 2 at or above the second. */
function level(value, window, thresholds) {
  const fallback = { claude: [60, 85], claudeWeekly: [80, 95], codex: [80, 95], codexWeekly: [85, 97] };
  const group = thresholds[window] || {};
  const first = window.startsWith('claude') ? group.save : group.tight;
  const second = window.startsWith('claude') ? group.emergency : group.exhausted;
  const low = typeof first === 'number' ? first : fallback[window][0];
  const high = typeof second === 'number' ? second : fallback[window][1];
  return value >= high ? 2 : value >= low ? 1 : 0;
}

function colored(value, window, thresholds) {
  if (value === undefined) return '?';
  return '\x1b[' + [32, 33, 31][level(value, window, thresholds)] + 'm' + value + '%\x1b[0m';
}

// Soft Catppuccin Mocha colours for the minimal and rounded styles.
const rgb = ([r, g, b]) => '\x1b[38;2;' + r + ';' + g + ';' + b + 'm';
const PALETTE = { claude: [250, 179, 135], codex: [148, 226, 213], levels: [[166, 227, 161], [249, 226, 175], [243, 139, 168]],
  text: [205, 214, 244], sub: [127, 132, 156], dim: [69, 71, 90], surface: [49, 50, 68] };
const RESET = '\x1b[0m', BOLD = '\x1b[1m', PILL = '\x1b[48;2;49;50;68m';
const BRANDS = { claude: { logo: '✻', name: 'Claude', letter: 'C' }, codex: { logo: '⌬', name: 'Codex', letter: 'X' } };
const DEFAULT_LOOK = { style: 'classic', logos: false, names: false };

/** Brand symbol, name, both, or the old letter when both are off. */
function label(id, look, colour) {
  const brand = BRANDS[id];
  const logo = look.logos ? (colour ? rgb(PALETTE[id]) + brand.logo + RESET : brand.logo) : '';
  const name = look.names ? (colour ? rgb(PALETTE.text) + brand.name + RESET : brand.name) : '';
  return [logo, name].filter(Boolean).join(' ') || brand.letter;
}

/** Context fill as a small pie: ○ ◔ ◑ ◕ ●. */
function contextMark(info) {
  const percent = Number.isFinite(info.percent) ? info.percent : 0;
  return '○◔◑◕●'[Math.min(4, Math.max(0, Math.ceil(percent / 25)))];
}

function bar(value, window, thresholds, style) {
  const size = style === 'rounded' ? 8 : 10;
  const [full, empty] = style === 'rounded' ? ['▰', '▱'] : ['━', '━'];
  if (value === undefined) return rgb(PALETTE.dim) + empty.repeat(size);
  const filled = Math.round(Math.min(100, Math.max(0, value)) / 100 * size);
  return rgb(PALETTE.levels[level(value, window, thresholds)]) + full.repeat(filled) + rgb(PALETTE.dim) + empty.repeat(size - filled);
}

/** One provider for the minimal and rounded styles: label, bar, 5h percent, reset and week. */
function segment(id, five, week, reset, thresholds, look) {
  const window = id === 'claude' ? 'claude' : 'codex';
  const inPill = look.style === 'rounded';
  const back = inPill ? PILL : '';
  const percent = n => n === undefined ? '?' : n + '%';
  const body = label(id, look, true) + back + ' ' + bar(five, window, thresholds, look.style) + RESET + back + ' '
    + BOLD + rgb(PALETTE.text) + percent(five) + RESET + back + rgb(PALETTE.sub) + (reset ? ' ↻' + reset : '')
    + (inPill ? ' · wk ' : '  wk ') + percent(week) + RESET;
  if (!inPill) return body;
  // Round caps are Nerd Font glyphs; the background runs through every reset inside the pill.
  return rgb(PALETTE.surface) + '' + RESET + PILL + body.split(RESET).join(RESET + PILL) + RESET + rgb(PALETTE.surface) + '' + RESET;
}

/** Render the quota status line using only validated numbers and project enums. */
function formatStatus(limits, project, thresholds, now = Date.now(), providers, contextInfo = '', look = DEFAULT_LOOK) {
  const value = lib.limitValues(limits);
  const reset = lib.formatReset(limits.claude?.five_hour?.resets_at, now);
  const modes = lib.computeModes(limits, thresholds, now, providers);
  const bossOn = project.enabled === true;
  const profile = lib.PROFILES.includes(project.profile) ? project.profile : 'balanced';
  const ctx = bossOn && contextInfo && typeof contextInfo === 'object' ? contextInfo : null;
  if (look.style === 'minimal' || look.style === 'rounded') {
    const gap = look.style === 'rounded' ? ' ' : '    ';
    const sub = text => rgb(PALETTE.sub) + text + RESET;
    let line = segment('claude', value.c5h, value.cWeek, reset, thresholds, look) + gap
      + segment('codex', value.x5h, value.xWeek, '', thresholds, look);
    if (bossOn) line += gap + rgb(PALETTE.levels[0]) + '●' + RESET + sub(' boss' + (profile === 'balanced' ? '' : ' ' + profile));
    if (ctx) line += '  ' + (ctx.warn ? rgb(PALETTE.levels[1]) : rgb(PALETTE.sub)) + contextMark(ctx) + ' ' + ctx.tokens + RESET;
    if (modes.codexUnknown) line += '  ' + sub('codex data unknown');
    if (modes.codexStale) line += '  ' + sub('codex numbers ' + modes.codexAge + ' old');
    return line;
  }
  let line = label('claude', look, false) + ' 5h ' + colored(value.c5h, 'claude', thresholds) + (reset ? ' ↻' + reset : '')
    + ' · wk ' + colored(value.cWeek, 'claudeWeekly', thresholds)
    + ' │ ' + label('codex', look, false) + ' 5h ' + colored(value.x5h, 'codex', thresholds) + ' · wk ' + colored(value.xWeek, 'codexWeekly', thresholds);
  if (bossOn) line += ' │ boss on:' + profile;
  if (modes.codexUnknown) line += ' │ codex data unknown';
  if (modes.codexStale) line += ' │ codex numbers ' + modes.codexAge + ' old';
  if (!bossOn) return line;
  const extra = providers && lib.formatProvidersCompact(providers, limits);
  if (extra) line += ' │ ' + extra;
  const contextText = ctx ? (ctx.warn ? '\x1b[33m' : '') + 'ctx ' + ctx.tokens + ' ' + ctx.percent + '%' + (ctx.warn ? '\x1b[0m' : '')
    : typeof contextInfo === 'string' ? contextInfo : '';
  if (contextText) line += ' │ ' + contextText;
  return line;
}

/** Persist quota updates and safely compose the previous user-owned status command. */
function main() {
  try {
    const raw = lib.readStdin();
    const input = JSON.parse(raw || '{}');
    const project = lib.findProjectConfig(input?.cwd);
    const config = lib.loadConfig(project, { tolerant: true });
    const now = Date.now();
    const codex = config.providers.providers.codex?.enabled === false ? null : lib.readCodexLimits(now, config.thresholds);
    const state = lib.updateState(current => {
      const claude = lib.updateClaudeLimits(current.claude, input, now);
      const bossModel = lib.cleanModelId(input?.model?.id);
      return { claude, ...(bossModel ? { bossModel, bossModels: lib.recordBossModel(current.bossModels, project.directory, bossModel, now) } : {}), ...(input?.rate_limits ? { history: lib.recordUsageHistory(current.history, 'claude', claude, now, config.thresholds) } : {}),
        ...(project.enabled === true ? { contexts: context.recordContext(current.contexts, input, context.projectId(project, input?.cwd), now) } : {}) };
    }) || lib.readState();
    const limits = lib.readProviderLimits(config.providers, { claude: state.claude, codex }, now);
    const sessions = state.contexts && typeof state.contexts === 'object' ? state.contexts : {};
    const measured = project.enabled === true && typeof input?.session_id === 'string' && Object.hasOwn(sessions, input.session_id) ? sessions[input.session_id] : null;
    const visible = project.enabled === true || lib.showsWithoutBoss();
    const line = visible ? formatStatus(limits, project, config.thresholds, now, config.providers, context.statusInfo(measured, lib.normalizeProject(project).contextSuggest) || '', lib.statuslineLook()) + '\n' : '';
    const wrapper = lib.readJson(path.join(lib.getPaths().quotaBossHome, 'wrapped-statusline.json'));
    let prefix = '';
    if (typeof wrapper?.command === 'string' && wrapper.command.trim()) {
      // The sole shell exception: execute the user's saved status line verbatim.
      const result = spawnSync(wrapper.command, [], { ...lib.childProcessOptions(), shell: true, input: raw, encoding: 'utf8', timeout: 2000, maxBuffer: 65536 });
      if (!result.error && result.status === 0 && result.stdout?.trim()) prefix = result.stdout.trimEnd() + '\n';
    }
    process.stdout.write(prefix + line);
  } catch {
    try { if (lib.showsWithoutBoss()) process.stdout.write('C 5h ? · wk ? │ X 5h ? · wk ?\n'); } catch { /* Exit successfully even with a closed output pipe. */ }
  }
}

if (require.main === module) {
  process.stdout.on('error', () => {});
  main();
}
module.exports = { formatStatus, main };
