'use strict';

const { CATEGORIES, TIERS, EFFORT_ORDER, sanitizeLabel, normalizeProject, computeModes, historySettings,
  recentOutcomes, unavailableModels, rateLimitedModels, providerContext, QUOTA_WINDOWS, validProviderId, validCliModel, cliArgsForModel, BUILTIN_PROVIDERS, tightenCaps, bossScore, pickBoss } = require('./lib');
const { medianSeconds, speedFactor } = require('./latency');
const DIFFICULTY = { critical: 8.5, normal: 6.5, trivial: 4.5 };
const MIN_P = { critical: 0.75, normal: 0.55, trivial: 0.4 };
const ALPHA = { critical: { quality: 8, balanced: 6, frugal: 4 },
  normal: { quality: 3, balanced: 2, frugal: 1.5 }, trivial: { quality: 1.5, balanced: 1, frugal: 0.7 } };
// Claude usage of the Haiku relay that launches an external CLI, in model cost units for one job.
// A relay costs about the same on every run, so it weighs most on small jobs.
const RELAY_COST = { critical: 0.03, normal: 0.06, trivial: 0.25 };
// `claude -p` for a Codex boss: each job starts a fresh session and re-reads its whole startup context.
// Extra cost as a share of the job, so it also weighs most on small jobs.
const FRESH_CLI_COST = { critical: 0.1, normal: 0.25, trivial: 0.6 };
// `max` and `ultra` are never picked automatically: both vendors say most work does not need them.
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const MIN_EFFORT = { architecture: 'medium' };
const AVERAGE_TRUST_MINUTES = 1440;
// A Codex model without metadata gets the three levels every Codex model supports.
const BASIC_EFFORTS = ['low', 'medium', 'high'];
// Relative usage per level. No vendor publishes this, so these are estimates (docs/MODELS.md).
const EFFORT_COST = { low: 0.85, medium: 1, high: 1.25, xhigh: 1.6 };
// Measured with a hard fixed task. Every other model keeps the estimate until it is measured.
// Measured with bench/effort.js, see "Effort" in docs/MODELS.md.
const EFFORT_COST_BY_MODEL = {
  'claude-fable-5-2': { low: 0.8, high: 1.7, xhigh: 3.6 },
  'claude-opus-5-5': { low: 0.85, high: 1.35, xhigh: 3.5 },
  'claude-sonnet-5-5': { low: 1, high: 1.1, xhigh: 1.75 },
  'claude-haiku-5-5': { low: 0.9, high: 1.4, xhigh: 2.65 },
  'gpt-6.1-sol': { high: 1.65, xhigh: 3.4 },
  'gpt-6.1-terra': { low: 0.95, high: 1, xhigh: 1.45 },
  'gpt-6-luna': { low: 0.9, high: 1.4, xhigh: 1.6 },
};
const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const positive = (value, fallback) => Math.max(0.000001, finite(value, fallback));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** The model the boss runs on. When the host does not say, assume the model a boss would sensibly use. */
function bossModelId(bossModel, registry, pool) {
  if (!pool) return null;
  const own = registry.filter(model => model.pool === pool);
  if (bossModel && registry.some(model => model.id === bossModel)) return own.some(model => model.id === bossModel) ? bossModel : null;
  const families = pool === 'claude' ? ['fable', 'opus', 'sonnet', 'haiku'] : ['astra', 'sol', 'terra', 'luna'];
  const family = families.find(word => String(bossModel).toLowerCase().split(/[^a-z0-9]+/).includes(word));
  if (family) {
    const versions = id => (id.match(/\d+/g) || []).map(Number);
    const matches = own.filter(model => model.id.toLowerCase().split(/[^a-z0-9]+/).includes(family));
    matches.sort((a, b) => {
      const x = versions(a.id), y = versions(b.id);
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
      return a.id.localeCompare(b.id);
    });
    if (matches.length) return matches[0].id;
  }
  const able = pool === 'claude' ? own.filter(model => !['sonnet', 'haiku'].includes(model.agentModel) && !/^claude-(sonnet|haiku)/.test(model.id)) : own;
  return pickBoss(able.map(model => ({ id: model.id, cost: model.cost, score: bossScore(model) })))?.id ?? null;
}

function bossModelNote(bossModel, registry, pool) {
  if (!bossModel || !pool || registry.some(model => model.id === bossModel)) return null;
  const assumed = bossModelId(bossModel, registry, pool);
  const label = sanitizeLabel(registry.find(model => model.id === assumed)?.label || assumed || 'no available boss model');
  return 'Note: boss model ' + sanitizeLabel(bossModel) + ' is not in the registry; routing assumes ' + label
    + '. Add it to config/models.json to route exactly.';
}

function via(model, category, provider, host, boss) {
  if (model.id === boss) return 'self';
  if (host === 'codex' && model.pool === 'codex') return 'codex-subagent';
  if (host === 'codex' && model.pool === 'claude') return model.agentModel === 'fable' ? null : 'claude-worker';
  if (host === 'generic' && provider.worker !== 'cli-worker') return null;
  if (provider.worker === 'cli-worker') return 'cli-worker:' + model.pool;
  if (model.pool !== 'claude' && model.pool !== 'codex') return provider.worker === 'researcher' ? 'researcher (manual)' : null;
  if (model.pool === 'codex') return ['review', 'research', 'architecture'].includes(category) ? 'gpt-advisor' : 'codex-worker';
  if (model.agentModel === 'sonnet' || model.id.startsWith('claude-sonnet')) return category === 'review' ? 'reviewer' : 'sonnet-worker';
  if (model.agentModel === 'haiku' || model.id.startsWith('claude-haiku')) return category === 'research' ? 'researcher' : 'haiku-worker';
  return model.agentModel === 'opus' || model.id.startsWith('claude-opus') ? 'opus-worker' : null;
}

const usesRelay = (method, host) => host === 'claude-code'
  && (method === 'codex-worker' || method === 'gpt-advisor' || Boolean(method?.startsWith('cli-worker:')));

/** A failure at a lower level says little about a higher one; a pass at a higher level says little about a lower one. */
function effortWeight(outcome, effort) {
  const done = EFFORT_ORDER.indexOf(outcome.effort), wanted = EFFORT_ORDER.indexOf(effort);
  if (done < 0 || wanted < 0 || done === wanted) return 1;
  return (outcome.result === 'fail') === (done < wanted) ? 0.5 : 1;
}

/** Registry prior plus a tier-weighted posterior; failures count twice. */
function successProbability(model, category, tier, outcomes = [], thresholds = {}, now = 0, effort = null) {
  const score = clamp(finite(model.scores?.[category], 0), 0, 10);
  const difficulty = finite(thresholds.difficulty?.[tier], DIFFICULTY[tier]);
  const prior = 1 / (1 + Math.exp(-1.1 * (score - difficulty)));
  const n0 = positive(thresholds.n0, 6);
  let wins = 0;
  let fails = 0;
  for (const outcome of recentOutcomes(outcomes, now, thresholds)) {
    if (outcome.model !== model.id || outcome.category !== category) continue;
    const weight = (outcome.tier === tier ? 1 : 0.5) * effortWeight(outcome, effort);
    if (outcome.result === 'pass') wins += weight;
    if (outcome.result === 'fail') fails += weight;
  }
  return (prior * n0 + wins) / (n0 + wins + 2 * fails);
}

/** Project one quota window, discarding history across a counter reset. */
function projectWindow(window, key, history = [], sampleKey, now = 0, minutes = 300, thresholds = {}) {
  if (typeof window?.[key] !== 'number' || !Number.isFinite(window[key])) return null;
  const reset = finite(window.resets_at, null);
  const used = reset !== null && reset * 1000 <= now ? 0 : clamp(window[key], 0, 100);
  const W = positive(window.window_minutes, minutes);
  if (reset === null) return { used, rate: null, projected: null, pressure: used / 100, discounted: false };
  const L = clamp((reset * 1000 - now) / 60000, 0, W);
  const elapsed = clamp(1 - L / W, 0.02, 1);
  const samples = (Array.isArray(history) ? history : []).filter(s => s && Number.isFinite(s.t)
    && s.t <= now && s.t >= now - historySettings(thresholds).paceMinutes * 60000
    && typeof s[sampleKey] === 'number' && Number.isFinite(s[sampleKey]) && s[sampleKey] >= 0 && s[sampleKey] <= 100)
    .sort((a, b) => a.t - b.t);
  let segment = [];
  for (const sample of samples) {
    if (segment.length && sample[sampleKey] < segment[segment.length - 1][sampleKey]) segment = [];
    if (!segment.length || sample.t > segment[segment.length - 1].t) segment.push(sample);
  }
  // A current counter drop indicates a reset after the last historical sample.
  if (segment.length && used < segment[segment.length - 1][sampleKey]) segment = [];
  const first = segment[0];
  const last = segment[segment.length - 1];
  const rate = segment.length >= 2 ? (last[sampleKey] - first[sampleKey]) / ((last.t - first.t) / 60000)
    : used / (elapsed * W);
  // Trust the projection only as much as we have observed: a burst in the first minutes of a
  // window must not be extrapolated over hours. Full confidence after `paceMinutes` of data.
  const observedMinutes = segment.length >= 2 ? (last.t - first.t) / 60000 : elapsed * W;
  const confidence = clamp(observedMinutes / historySettings(thresholds).paceMinutes, 0, 1);
  const horizon = Math.min(L, historySettings(thresholds).paceHorizonMinutes);
  const elapsedMinutes = elapsed * W;
  const average = used / elapsedMinutes;
  const trust = clamp(elapsedMinutes / AVERAGE_TRUST_MINUTES, 0, 1);
  const projected = clamp(used + Math.max(0, rate) * horizon * confidence + average * (L - horizon) * trust, used, 200);
  // Using a window fully by its reset is ideal; only the projected overshoot (running dry
  // before the reset) adds pressure on top of what is already used.
  let pressure = clamp((used + Math.max(0, projected - 100)) / 100, 0, 1.5);
  const discounted = projected < 50 && L / W < 0.25;
  if (discounted) pressure *= 0.5;
  return { used, rate, projected, pressure, discounted };
}

/** Scarcity price is independent of model cost and quality. */
function poolPrice(pool, limits = {}, history = {}, thresholds = {}, now = 0, modes = computeModes(limits, thresholds, now)) {
  if (pool === 'claude' && modes.claudeMode === 'emergency'
    || pool === 'codex' && modes.codexMode === 'exhausted') return Infinity;
  const source = limits[pool];
  const windows = pool === 'claude' ? [['five_hour', 'used_percentage', 'u5', 300], ['seven_day', 'used_percentage', 'uw', 10080]]
    : pool === 'codex' ? [['primary', 'used_percent', 'u5', 300], ['secondary', 'used_percent', 'uw', 10080]]
      : Object.entries(QUOTA_WINDOWS).map(([name, minutes]) => [name, 'used_percent', name, minutes]);
  const projections = windows.map(([name, key, sampleKey, minutes]) =>
    projectWindow((pool === 'claude' || pool === 'codex' ? source : source?.windows)?.[name], key, history?.[pool], sampleKey, now, minutes, thresholds)).filter(Boolean);
  return projections.length ? 1 + 3 * Math.max(...projections.map(w => w.pressure)) ** 2 : 1.3;
}

function effortLevels(model) {
  if (Array.isArray(model.efforts)) return EFFORTS.filter(level => model.efforts.includes(level));
  return model.pool === 'codex' ? BASIC_EFFORTS : [];
}

/** The further a model is above the job, the less effort it gets. The boss's own effort is a session setting. */
function effortFor(model, category, tier, thresholds, method, provider, learned = []) {
  const levels = effortLevels(model);
  if (!levels.length || method === 'self') return null;
  // A CLI whose template cannot take a level would ignore it, so do not charge for or promise one.
  if (provider?.worker === 'cli-worker' && !provider.cli?.args?.some(arg => arg.includes('{effort}'))) return null;
  const margin = finite(model.scores?.[category], 0) - finite(thresholds.difficulty?.[tier], DIFFICULTY[tier]);
  const wanted = tier === 'critical' ? 'high' : margin >= 2 ? 'low' : margin >= 0.5 ? 'medium' : 'high';
  const floor = Math.max(EFFORTS.indexOf(wanted), EFFORTS.indexOf(model.minEffort),
    EFFORTS.indexOf(thresholds.minEffort?.[category] ?? MIN_EFFORT[category]));
  let index = levels.indexOf(levels.find(level => EFFORTS.indexOf(level) >= floor) ?? levels[levels.length - 1]);
  while (index < levels.length - 1) {
    const outcomes = learned.filter(e => e.model === model.id && e.category === category && e.tier === tier && e.effort === levels[index]);
    const fails = outcomes.filter(e => e.result === 'fail').length;
    if (fails < 2 || fails <= outcomes.filter(e => e.result === 'pass').length) break;
    index++;
  }
  return levels[index];
}

function effortCost(model, effort, thresholds) {
  if (!effort || !Array.isArray(model.efforts)) return 1;
  if (effort === 'max') effort = 'xhigh';
  const measured = thresholds.effortCostByModel?.[model.id]?.[effort] ?? EFFORT_COST_BY_MODEL[model.id]?.[effort];
  return positive(measured ?? thresholds.effortCost?.[effort], EFFORT_COST[effort]);
}

function probabilityOrder(a, b, previousPool) {
  return b.P - a.P || Number(b.pool === previousPool) - Number(a.pool === previousPool) || a.model.localeCompare(b.model);
}

/** Pure, deterministic v2 routing. Callers supply the observation clock and session's previous pool. */
function route({ models = {}, thresholds = {}, profile = 'balanced', limits = {}, workers,
  host = 'claude-code', allowTrainingProviders = false, consensus = true, history = {}, selfTests = {}, outcomes = [], runs = [], now = 0, previousPool = null, providers = BUILTIN_PROVIDERS, caps, bossModel = null, size = null, bossEffort = null } = {}) {
  if (!['small', 'medium', 'large'].includes(size)) size = null;
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(bossEffort)) bossEffort = null;
  if (caps) providers = { ...providers, caps: tightenCaps(providers.caps ?? {}, caps) };
  const context = providerContext(providers, limits, history);
  const modes = computeModes(limits, thresholds, now, providers);
  const rawModes = computeModes(limits, thresholds, now);
  limits = context.limits;
  history = context.history;
  const settings = normalizeProject({ profile, workers, host, allowTrainingProviders, consensus });
  const bossPool = settings.host === 'codex' ? 'codex' : settings.host === 'claude-code' ? 'claude' : null;
  const hostSaving = bossPool === 'claude' ? modes.claudeMode !== 'normal' : bossPool === 'codex' && modes.codexMode !== 'normal';
  const learned = recentOutcomes(outcomes, now, thresholds);
  const unavailable = unavailableModels(learned, now, thresholds);
  const rateLimited = rateLimitedModels(learned, now, thresholds);
  const categories = CATEGORIES.filter(c => !Array.isArray(models.categories) || models.categories.includes(c));
  const registry = Object.entries(models.models || {}).filter(([, m]) => m && Object.hasOwn(providers.providers, m.pool) && providers.providers[m.pool].enabled !== false
    && m.enabled !== false && typeof m.cost === 'number' && Number.isFinite(m.cost) && m.cost >= 0
    && (m.cliModel === undefined || validCliModel(m.cliModel)))
    .map(([id, model]) => ({ ...model, id, passes: learned.filter(e => e.model === id && e.result === 'pass').length }));
  const boss = bossModelId(bossModel, registry, bossPool);
  const rows = [];
  const options = [];
  const candidates = [];
  const samePoolRatio = clamp(finite(thresholds.samePoolRatio, 0.5), 0, 1);
  const relayPrice = poolPrice('claude', limits, history, thresholds, now, modes) * positive(thresholds.bossFactor, 1.2);
  for (const tier of TIERS) {
    const relayCost = Number.isFinite(relayPrice) ? positive(thresholds.relayCost?.[tier], RELAY_COST[tier]) * relayPrice : 0;
    const freshCli = 1 + positive(thresholds.freshCliCost?.[tier], FRESH_CLI_COST[tier]);
    const minimum = clamp(finite(thresholds.minP?.[tier], MIN_P[tier]), 0, 1);
    const alpha = positive(thresholds.alpha?.[tier]?.[settings.profile], ALPHA[tier][settings.profile]);
    for (const category of categories) {
      const evaluated = registry.map(model => {
        const provider = providers.providers[model.pool];
        const method = via(model, category, provider, settings.host, boss);
        const effort = effortFor(model, category, tier, thresholds, method, provider, learned);
        const capped = context.usage[model.pool]?.capped;
        const self = model.pool === bossPool && method === 'self';
        const P = successProbability(model, category, tier, learned, thresholds, now, effort);
        const price = capped && !self ? Infinity : poolPrice(model.pool, limits, history, thresholds, now,
          self ? { ...modes, [bossPool === 'codex' ? 'codexMode' : 'claudeMode']: bossPool === 'codex' ? rawModes.codexMode : rawModes.claudeMode } : modes)
          * (settings.host === 'claude-code' && model.pool === 'claude' && method !== 'self' ? positive(thresholds.bossFactor, 1.2) : 1);
        const manual = model.manual === true || provider.kind === 'manual';
        let reason = '';
        if (provider.evidence === 'docs' && selfTests?.[model.id]?.result !== 'pass') reason = 'self-test needed: quota-boss providers test ' + model.pool;
        else if (provider.evidence === 'docs' && tier === 'critical' && model.passes < positive(thresholds.probationPasses, 3))
          reason = 'probation: ' + (positive(thresholds.probationPasses, 3) - model.passes) + ' more verified passes needed';
        else if (provider.trainsOnData === true && !settings.allowTrainingProviders) reason = 'training provider blocked (allowTrainingProviders is off)';
        else if (unavailable.has(model.id)) reason = 'unavailable (24h exclusion)';
        else if (rateLimited.has(model.id)) reason = 'rate limited (paused for 15 minutes)';
        else if (method !== 'self' && model.pool === 'codex' && !(settings.workers.codex || settings.workers.gpt && ['review', 'research'].includes(category))) reason = 'worker disabled';
        else if (model.pool === 'perplexity' && (category !== 'research' || !settings.workers.perplexity)) reason = 'manual worker disabled for category';
        else if (capped && !self) reason = 'provider capped:' + model.pool;
        else if (!method) reason = 'worker unavailable';
        else if (model.cliModel && provider.worker === 'cli-worker') {
          try { cliArgsForModel(provider.cli || { args: [] }, model.cliModel); }
          catch { reason = 'worker unavailable'; }
        }
        if (!reason) {
          if (manual) reason = 'manual option only';
          else if (provider.tos === 'avoid') reason = 'provider tos avoid';
          else if (model.pool === bossPool && !self && hostSaving) reason = 'host pool saving';
          else if (!Number.isFinite(price)) reason = model.pool === 'claude' ? 'pool emergency' : 'pool exhausted';
        }
        const thinEvidence = !['claude', 'codex'].includes(model.pool) && model.passes < positive(thresholds.probationPasses, 3);
        const seconds = medianSeconds(runs, model.id, category, tier);
        const jobCost = Math.max(model.cost, 0.2) * effortCost(model, self ? bossEffort : effort, thresholds) * (method === 'claude-worker' ? freshCli : 1);
        return { tier, category, model: model.id, cliModel: model.cliModel || null, label: sanitizeLabel(model.label), pool: model.pool, via: method,
          effort, ...(self ? { chargedEffort: bossEffort } : {}), P, price, thinEvidence, jobCost,
          utility: Number.isFinite(price) ? P ** alpha / (jobCost * price + (usesRelay(method, settings.host) ? relayCost : 0))
            * speedFactor(seconds, tier, thresholds) * (thinEvidence ? clamp(finite(thresholds.thinEvidenceFactor, 0.75), 0.1, 1) : 1) : 0,
          seconds,
          belowThreshold: P < minimum, ladder: [], reason, won: false };
      });
      for (const option of evaluated.filter(c => c.reason === 'manual option only')) options.push({ ...option });
      // Handing work to another model of the boss's own pool adds handover, rereading and review to the same quota,
      // so such a worker only wins when it costs at most samePoolRatio of the boss doing the job itself.
      const own = evaluated.find(c => c.via === 'self' && c.pool === bossPool && !c.reason && c.P >= minimum);
      if (own) for (const candidate of evaluated) {
        if (!candidate.reason && candidate.pool === bossPool && candidate.via !== 'self' && candidate.jobCost > samePoolRatio * own.jobCost)
          candidate.reason = 'lost: same pool, costs more than ' + samePoolRatio + ' of the boss';
      }
      if (own && size) {
        const gate = thresholds.gate ?? {};
        const s = positive(gate.size?.[size], { small: 0.3, medium: 1, large: 3 }[size]);
        const margin = clamp(finite(gate.margin, 0.8), 0, 1);
        const maxTotalRatio = Math.max(1, finite(gate.maxTotalRatio, 1.3));
        const defaults = { 'claude-code': { fixed: 0.2, perSize: 0.35 }, codex: { fixed: 1.5, perSize: 0.4 }, generic: { fixed: 0.5, perSize: 0.35 } };
        const h = gate.handover?.[settings.host];
        const fixed = Math.max(0, finite(h?.fixed, defaults[settings.host].fixed));
        const perSize = Math.max(0, finite(h?.perSize, defaults[settings.host].perSize));
        const reread = Math.max(0, finite(gate.reread, 0.3));
        const workSeconds = positive(gate.workSeconds, 150);
        const handoverSeconds = Math.max(0, finite(gate.handoverSeconds?.[settings.host], { 'claude-code': 50, codex: 90, generic: 60 }[settings.host]));
        const maxExtraSeconds = Math.max(0, finite(gate.maxExtraSeconds?.[size], { small: 60, medium: 180, large: 600 }[size]));
        const B = own.jobCost * own.price;
        const selfCost = s * B * (1 + (1 - own.P));
        own.gate = { size, selfCost };
        for (const c of evaluated) {
          if (c === own || c.reason || !Number.isFinite(c.price)) continue;
          const rework = (1 - c.P) * s * B;
          const worker = (s + reread) * c.jobCost * c.price;
          const bossSide = (fixed + perSize * s) * B + rework
            + (usesRelay(c.via, settings.host) ? relayCost : 0) + (c.pool === bossPool ? worker : 0);
          const total = bossSide + (c.pool === bossPool ? 0 : worker);
          const extraSeconds = handoverSeconds + s * (c.seconds ?? workSeconds) - s * (own.seconds ?? workSeconds);
          c.gate = { size, bossSide, total, selfCost, extraSeconds };
          if (bossSide > margin * selfCost || total > (c.pool === bossPool ? margin : maxTotalRatio) * selfCost)
            c.reason = 'lost: handover costs more than it saves (' + size + ')';
          else if (extraSeconds > maxExtraSeconds)
            c.reason = 'lost: handover too slow (' + size + ')';
        }
      }
      let usable = evaluated.filter(c => !c.reason);
      let qualified = usable.filter(c => c.P >= minimum);
      // Only the boss's own critical work may consume an emergency pool, and only as a last resort.
      if (!qualified.length && tier === 'critical') {
        const boss = evaluated.filter(c => c.pool === bossPool && c.via === 'self' && ['pool emergency', 'pool exhausted'].includes(c.reason));
        if (boss.length) {
          usable = [...usable, ...boss];
          qualified = usable.filter(c => c.P >= minimum);
        }
      }
      const belowThreshold = !qualified.length;
      const eligible = qualified.length ? qualified : usable;
      let winner;
      if (belowThreshold) winner = [...eligible].sort((a, b) => b.P - a.P || b.utility - a.utility || probabilityOrder(a, b, previousPool))[0];
      else if (eligible.length) {
        const bestUtility = Math.max(...eligible.map(c => c.utility));
        winner = eligible.filter(c => c.utility >= bestUtility * 0.98).sort((a, b) => probabilityOrder(a, b, previousPool))[0];
      }
      for (const candidate of evaluated) {
        if (candidate === winner) {
          candidate.won = true;
          candidate.reason = !Number.isFinite(candidate.price) ? 'won: critical self emergency fallback'
            : belowThreshold ? 'won: best P below minP' : 'won: highest utility (2% ties: P, then previous pool)';
        } else if (!candidate.reason) {
          candidate.reason = candidate.P < minimum && !belowThreshold ? 'lost: below minP'
            : !eligible.includes(candidate) ? 'lost: critical self fallback required'
              : belowThreshold ? 'lost: lower P in threshold fallback' : 'lost: lower utility or tie-break';
        }
      }
      if (winner) {
        const step = c => ({ model: c.model, cliModel: c.cliModel, label: c.label, pool: c.pool, via: c.via, effort: c.effort });
        const ladder = [step(winner)];
        const levels = effortLevels(registry.find(model => model.id === winner.model));
        const index = levels.indexOf(winner.effort);
        if (index >= 0 && index < levels.length - 1) ladder.push({ ...step(winner), effort: levels[index + 1] });
        const alternatives = eligible.filter(c => c !== winner);
        // Escalate one step at a time: the cheapest model about as likely to succeed, preferably from another pool.
        // The margin keeps equally rated models in play after a few logged passes nudge the winner's P up.
        const stronger = alternatives.filter(c => c.P >= winner.P - 0.05);
        const steps = stronger.length ? stronger : alternatives;
        const different = steps.filter(c => c.pool !== winner.pool);
        const next = [...(different.length ? different : steps)].sort((a, b) =>
          (stronger.length ? b.utility - a.utility : 0) || probabilityOrder(a, b, previousPool))[0];
        if (next) ladder.push(step(next));
        const advisor = tier === 'critical' && category === 'architecture' && settings.consensus
          ? evaluated.filter(c => c.pool === 'codex' && (settings.workers.codex || settings.workers.gpt)
            && !context.usage.codex?.capped && modes.codexMode !== 'exhausted'
            && providers.providers.codex.tos !== 'avoid' && !unavailable.has(c.model) && !rateLimited.has(c.model)
            && (providers.providers.codex.trainsOnData !== true || settings.allowTrainingProviders)
            && settings.host !== 'generic').sort((a, b) => b.P - a.P || b.utility - a.utility || probabilityOrder(a, b, previousPool))[0] : null;
        rows.push({ ...winner, belowThreshold, ladder, options: advisor ? ['consensus'] : [],
          ...(advisor ? { consensus: { model: advisor.model, label: advisor.label, effort: 'high' } } : {}) });
      }
      candidates.push(...evaluated);
    }
  }
  return { mode: modes.mode, rows, options, candidates, note: bossModelNote(bossModel, registry, bossPool) };
}

/** Compact context contains only registry labels, validated enums and fixed punctuation. */
function formatTable(result) {
  const lines = result.note ? [result.note] : [];
  const valid = item => item && TIERS.includes(item.tier) && CATEGORIES.includes(item.category)
    && (['self', 'reviewer', 'opus-worker', 'sonnet-worker', 'researcher', 'haiku-worker', 'codex-worker', 'codex-subagent', 'claude-worker', 'gpt-advisor', 'researcher (manual)'].includes(item.via)
      || typeof item.via === 'string' && item.via.startsWith('cli-worker:') && validProviderId(item.via.slice(11)))
    && (item.effort === null || EFFORTS.includes(item.effort))
    && typeof item.model === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(item.model);
  const format = item => {
    const ladder = (Array.isArray(item.ladder) ? item.ladder : []).slice(0, 3);
    const chain = ladder.map((s, i) => sanitizeLabel(s.label) + (i && s.model === ladder[i - 1].model ? '+' : '')).join('>');
    return item.category + '=' + sanitizeLabel(item.label) + '(' + item.via + (item.effort ? ',' + item.effort : '')
      + (item.cliModel && item.via.startsWith('cli-worker:') || ['codex-subagent', 'codex-worker', 'gpt-advisor', 'claude-worker'].includes(item.via) ? ',model=' + item.model : '') + ')'
      + (chain ? '[' + chain + ']' : '')
      + (item.tier === 'critical' && item.category === 'architecture' && item.options?.includes('consensus') && item.consensus
        ? '[option:consensus=' + sanitizeLabel(item.consensus.label) + ',high]' : '') + (item.belowThreshold ? '[below threshold]' : '');
  };
  for (const tier of TIERS) {
    const primary = (result.rows || []).filter(item => item.tier === tier && valid(item));
    if (primary.length) lines.push(tier + ': ' + primary.map(format).join(' '));
    const optional = (result.options || []).filter(item => item.tier === tier && valid(item));
    if (optional.length) lines.push(tier + ' options: ' + optional.map(format).join(' '));
  }
  return lines.join('\n');
}

function formatExplain(result) {
  const metric = value => Number.isFinite(value) ? value.toFixed(6) : 'Infinity';
  return (result.note ? result.note + '\n' : '') + result.candidates.map(c => c.tier + ' ' + c.category + ' ' + sanitizeLabel(c.label)
    + ' P=' + metric(c.P) + ' price=' + metric(c.price) + ' utility=' + metric(c.utility) + ' | latency=' + (c.seconds === null ? '?' : c.seconds + 's') + ' | ' + c.reason + (c.thinEvidence ? ' | thin evidence' : '')
    + (c.chargedEffort ? ' | boss effort ' + c.chargedEffort : '')
    + (c.gate ? ' | gate ' + c.gate.size + ': ' + (c.via === 'self' ? 'self=' + c.gate.selfCost.toFixed(3)
      : 'boss=' + c.gate.bossSide.toFixed(3) + ' total=' + c.gate.total.toFixed(3) + ' self=' + c.gate.selfCost.toFixed(3) + ' extra=' + Math.round(c.gate.extraSeconds) + 's') : '')).join('\n');
}

module.exports = { bossModelId, bossModelNote, route, formatTable, formatExplain, successProbability, projectWindow, poolPrice };
