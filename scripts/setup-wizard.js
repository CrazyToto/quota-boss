'use strict';
// The look applies live. Everything else goes through the confirmed setup.

const path = require('node:path');
const lib = require('./lib');
const tools = require('./tools');
const { PRESETS, MODEL_PATTERN } = require('./add-api');
const { PROVIDER_HELP, CODE_GRAPH_HELP, SCRIPTED_CLAUDE_WARNING } = require('./provider-help');
const tui = require('./tui');
const preview = require('./statusline-preview');
const { TEXT } = require('./setup-text');

const OPENCODE = 'opencode';
const OWN = ['codex', 'perplexity'];
// Free and practically unlimited, so it is the one choice that starts on.
const LITE = 'junie-lite';
const JUNIE = 'junie';
// Free model only, through its own program; no paid plan needed.
const DEVIN = 'devin';
const OTHER = ['copilot', 'grok', 'antigravity', 'jetbrains'];
// Free like the offers below, but its own program and only for video, audio and long PDFs.
const MEDIA = 'gemini-media';
const FREE = ['zen-deepseek', 'openrouter-free', 'cloudflare', 'cohere', 'gemini-api', 'nvidia', 'zai', 'kilo-free'];
const GRAPH = 'graphify';
const graph = require('./graph');
const newProviders = require('./new-providers');
const CHOICES = ['claude', ...OWN, LITE, DEVIN, ...OTHER, MEDIA, ...FREE, GRAPH];
const USABLE = new Set(['ok', 'outdated']);
const STEPS = ['Look', 'Work', 'Providers', 'Finish'];
const PLAN_NAMES = {
  copilot: { free: 'Free or Student', pro: 'Pro', 'pro-plus': 'Pro+' },
  jetbrains: { free: 'AI Free', pro: 'AI Pro', ultimate: 'AI Ultimate' },
};
const PLAN_IDS = Object.keys(PLAN_NAMES);
const SETUP_ITEMS = ['look', ...PLAN_IDS.map(id => 'plan:' + id)];
const YES = ['y', 'yes'], NO = ['n', 'no'];
const keyless = id => id === 'kilo-free' || PRESETS[id]?.keyless === true;
const onOff = value => value ? 'on' : 'off';
const listOf = value => Array.isArray(value) ? value : [];
const page = (step, rows, intro) => ({ title: STEPS[step], steps: STEPS, step, rows, intro });
const toggle = (id, label, value, extra) => ({ id, label, kind: 'toggle', value, ...extra });
const choice = (id, label, value, names, extra) => ({ id, label, kind: 'choice', value, names, options: Object.keys(names), ...extra });
const action = (id, label, help) => ({ id, label, kind: 'action', help });
const say = (w, lines) => { for (const line of [].concat(lines)) w.io.write(line); };

async function withTerminal(w, work) {
  w.io.pause();
  try { return await work(); } finally { w.io.resume(); }
}

const enabledNow = (config, id) => {
  const provider = config.providers.providers[id];
  return !!provider && provider.enabled !== false;
};

/** Which program a choice depends on; null means it needs none. */
function toolOf(id) {
  if (id === 'perplexity') return null;
  if (id === LITE || id === 'jetbrains') return JUNIE;
  if (Object.hasOwn(tools.REGISTRY, id)) return id;
  return OPENCODE;
}

const helpOf = id => id === 'claude' ? { name: 'Claude', what: 'Claude models (Opus, Sonnet, Haiku) as workers through the official `claude` CLI', warning: SCRIPTED_CLAUDE_WARNING } : id === GRAPH ? CODE_GRAPH_HELP : PROVIDER_HELP[id];
const nameOf = id => helpOf(id).name;
const asksForGraph = w => !lib.detectCodeIntel(w.directory).graphify;
// The provider of the assistant you work in runs the boss, so the setup does not ask about it.
const hostPool = w => ({ 'claude-code': 'claude', codex: 'codex' }[w.state.host]);
const choicesOf = w => CHOICES.filter(id => w.shown.has(id));
const apiChoice = id => 'api:' + id;
const inScope = (w, id) => !w.update || w.shown.has(id);
const activeApis = w => w.state.apis.filter(api => w.state.choices[apiChoice(api.id)]);
const chosen = (w, ids) => ids.filter(id => w.state.choices[id]);
const retiredApis = config => config.providers.retired ?? [];
const keptApis = w => Object.entries(w.config.providers.providers).filter(([id, p]) => p?.custom === true && !Object.hasOwn(PRESETS, id));
const mayTrain = id => id === 'kilo-free' || id === MEDIA || PRESETS[id]?.trains === true;
const keyStored = (stored, name, provider) => stored.includes(name.toLowerCase()) || stored.includes(provider.toLowerCase());

function apiKeys(w) {
  const entries = [
    ...chosen(w, Object.keys(PRESETS).filter(id => inScope(w, id))).filter(id => !PRESETS[id].keyless).map(id => ({ name: nameOf(id), provider: PRESETS[id].model.split('/')[0], page: PRESETS[id].keyPage, hint: PRESETS[id].keyHint })),
    ...activeApis(w).map(api => ({ name: api.id, provider: api.model.split('/')[0] })),
    ...keptApis(w).filter(([id]) => inScope(w, id) && w.state.choices[apiChoice(id)]).flatMap(([id, p]) => {
      // add-api stores '{model}' in the args and the real model in defaultModel; older entries hold it literally.
      const model = typeof p.cli?.defaultModel === 'string' ? p.cli.defaultModel : p.cli?.args?.[2];
      return typeof model === 'string' && model.includes('/') ? [{ name: id, provider: model.split('/')[0] }] : [];
    }),
  ];
  const providers = new Set();
  const stored = w.tools.storedKeys(w.options) || '';
  return entries.filter(entry => {
    const provider = entry.provider.toLowerCase();
    if (providers.has(provider) || keyStored(stored, entry.name, provider)) return false;
    providers.add(provider);
    return true;
  });
}

/** Everything chosen that may send project data to a provider allowed to train on it. */
function trainers(w) {
  return [...chosen(w, [...FREE, MEDIA]).filter(id => inScope(w, id) && mayTrain(id)).map(id => nameOf(id)),
    ...activeApis(w).filter(api => api.trains).map(api => api.id),
    ...keptApis(w).filter(([id, p]) => !w.update && w.state.choices[apiChoice(id)] && p.trainsOnData === true).map(([id]) => id)];
}

function lookPage(w) {
  const look = w.readLook(), numbers = w.currentLimits();
  const { style, logos, names, always } = look;
  const screen = page(0, [
    { heading: 'Status line' },
    choice('statusline-style', 'Style', style, { minimal: 'Minimal', rounded: 'Rounded', classic: 'Classic' }, { help: w.text.lookStyle }),
    toggle('statusline-logos', 'Brand symbols', logos, { help: w.text.lookLogos }),
    toggle('statusline-names', 'Provider names', names, { help: w.text.lookNames }),
    toggle('statusline', 'Show when boss is off', always, { help: w.text.lookAlways }),
  ], [w.text.lookIntro]);
  const fields = { 'statusline-style': 'style', 'statusline-logos': 'logos', 'statusline-names': 'names', statusline: 'always' };
  screen.previewTitle = 'Preview';
  screen.preview = preview.previewLines(look, always, numbers);
  return tui.list(w.io, screen, async row => {
    const field = fields[row.id];
    const value = field === 'style' ? row.value : field === 'always' ? (row.value ? 'always' : 'boss') : onOff(row.value);
    try {
      await w.run(['set', row.id, value]);
      look[field] = row.value;
      screen.preview = preview.previewLines(look, look.always, numbers);
      screen.message = 'Applied.';
    } catch (error) {
      row.value = look[field];
      screen.message = error.message;
    }
  });
}

function workPage(w) {
  const { profile, host, choices } = w.state;
  const rows = [
    choice('profile', 'Profile', profile, { quality: 'Quality', balanced: 'Balanced', frugal: 'Frugal' }, { help: w.text.profiles[profile] }),
    choice('host', 'Assistant', host, { 'claude-code': 'Claude Code', codex: 'Codex', generic: 'Other' }, { help: w.text.hosts[host] }),
    toggle(GRAPH, 'Code map', choices[GRAPH], { hidden: !asksForGraph(w), help: [CODE_GRAPH_HELP.what, CODE_GRAPH_HELP.catch, CODE_GRAPH_HELP.needs].join('\n') }),
  ];
  return tui.list(w.io, page(1, rows, [w.text.saveIntro]), row => {
    if (row.id === GRAPH) choices[GRAPH] = row.value;
    else {
      w.state[row.id] = row.value;
      row.help = (row.id === 'host' ? w.text.hosts : w.text.profiles)[row.value];
    }
  });
}

async function askApi(w) {
  const taken = id => Object.hasOwn(lib.BUILTIN_PROVIDERS.providers, id) || Object.hasOwn(PRESETS, id) || w.state.apis.some(api => api.id === id)
    || Object.hasOwn(w.config.providers.providers, id);
  const until = async (question, valid, complaint) => {
    for (;;) {
      const answer = await w.io.line(question, () => { w.quit = true; });
      if (!answer || valid(answer)) return answer;
      say(w, complaint);
    }
  };
  const id = await until(w.text.apiName, value => lib.validProviderId(value) && !taken(value), w.text.apiNameBad);
  if (!id) return;
  const model = await until(w.text.apiModel, value => MODEL_PATTERN.test(value), w.text.apiModelBad);
  if (!model) return;
  const yesNo = async prompt => (await until(prompt, value => [...YES, ...NO].includes(value.toLowerCase()), w.text.invalid)).toLowerCase();
  const trains = await yesNo(w.text.apiTrains);
  if (!trains) return;
  const free = await yesNo(w.text.apiFree);
  if (!free) return;
  w.state.apis.push({ id, model, trains: YES.includes(trains), free: YES.includes(free) });
  w.state.choices[apiChoice(id)] = true;
}

function providerGroups(w) {
  return [
    ['Your subscriptions', ['codex', 'claude', 'perplexity']],
    ['Paid plans you may have', OTHER],
    ['Free with a login', [LITE, DEVIN, MEDIA]],
    ['Free, no sign-up', FREE.filter(keyless)],
    ['Free with a free key', FREE.filter(id => !keyless(id))],
  ].map(([heading, ids]) => [heading, ids.filter(id => id !== hostPool(w) && (w.shown.has(id)
    || w.planOnly.has(id)) && (![DEVIN, MEDIA].includes(id) || w.config.providers.providers[id]))]);
}

function checkPrograms(w, ids) {
  w.io.draw(tui.render(page(2, [], [w.text.checking])));
  const programs = new Set(ids.map(toolOf).filter(Boolean));
  if (!w.update) {
    programs.add(OPENCODE);
    if (asksForGraph(w)) programs.add(GRAPH);
    if (w.state.host === 'claude-code' && w.config.providers.providers.claude && !enabledNow(w.config, 'claude')) programs.add('claude');
  }
  w.programs = new Map(w.tools.check([...programs], w.options).map(item => [item.id, item]));
}

async function providerPage(w) {
  const groups = providerGroups(w);
  checkPrograms(w, groups.flatMap(([, ids]) => ids));
  const { choices, plans } = w.state;
  const note = (program, trains) => [
    !program || USABLE.has(w.programs.get(program)?.state) ? 'ready'
      : w.programs.get(program)?.state === 'manual' ? 'install by hand' : 'installs automatically',
    ...(trains ? ['may train on your data'] : []),
  ].join(' · ');
  const planRow = id => choice('plan:' + id, 'Plan', plans[id], PLAN_NAMES[id], { hidden: !choices[id], help: w.text.planHelp });
  const screen = page(2, [], [w.text.saveIntro]);
  const rows = () => {
    const all = groups.flatMap(([heading, ids]) => ids.length ? [{ heading }, ...ids.flatMap(id => {
      const help = helpOf(id);
      return [
        ...(w.shown.has(id) ? [toggle(id, help.name, choices[id], { note: note(toolOf(id), mayTrain(id)),
          help: [help.what, help.catch, [help.needs, help.warning].filter(Boolean).join(' ')].filter(Boolean).join('\n') })] : [{ heading: help.name }]),
        ...(PLAN_NAMES[id] ? [planRow(id)] : []),
      ];
    })] : []);
    all.push(toggle('training', w.text.trainingLabel, w.state.training, {
      hidden: !trainers(w).length, help: w.text.trainingHelp,
    }));
    if (!w.update) {
      const apis = [...keptApis(w).map(([id, p]) => ({ id, trains: p.trainsOnData })), ...w.state.apis];
      if (apis.length) all.push({ heading: 'Your APIs' }, ...apis.map(api => toggle(apiChoice(api.id), api.id, choices[apiChoice(api.id)], { note: note(OPENCODE, api.trains) })));
      all.push(action('add', '+ Add an API through OpenCode', w.text.apiHelp));
    }
    return all;
  };
  for (;;) {
    screen.rows = rows();
    const result = await tui.list(w.io, screen, row => {
      if (row.id.startsWith('plan:')) plans[row.id.slice(5)] = row.value;
      else if (row.id === 'training') w.state.training = row.value;
      else choices[row.id] = row.value;
      screen.rows = rows();
    });
    if (result !== 'add') return result;
    const before = w.state.apis.length;
    await askApi(w);
    if (w.quit) return 'quit';
    if (w.state.apis.length > before) screen.cursor = rows().findIndex(row => row.id === apiChoice(w.state.apis[before].id));
  }
}

/** Which programs the current choices need, and who needs them. */
function neededTools(w) {
  const users = new Map();
  const add = (tool, name) => { if (tool) users.set(tool, [...(users.get(tool) || []), name]); };
  for (const id of chosen(w, choicesOf(w))) add(toolOf(id), nameOf(id));
  for (const api of activeApis(w)) add(OPENCODE, api.id);
  for (const [id] of keptApis(w)) if (w.state.choices[apiChoice(id)] && inScope(w, id)) add(OPENCODE, id);
  return users;
}

function plan(w) {
  const users = neededTools(w);
  for (const id of w.planOnly) addPlanTool(id);
  if (!w.update && w.state.host === 'claude-code' && w.config.providers.providers.claude && !enabledNow(w.config, 'claude')) addPlanTool('claude');
  function addPlanTool(id) {
    const tool = toolOf(id);
    if (!users.has(tool)) users.set(tool, [nameOf(id)]);
  }
  const items = [...users.keys()].map(id => w.programs?.get(id)).filter(Boolean);
  return { users, install: w.tools.installable(items), manual: items.filter(item => item.state === 'manual') };
}

function summaryPage(w) {
  w.plan = plan(w);
  const on = [...chosen(w, choicesOf(w)).map(nameOf), ...activeApis(w).map(api => api.id)];
  if (!w.update && w.state.host === 'claude-code' && w.config.providers.providers.claude && !enabledNow(w.config, 'claude')) on.push(nameOf('claude'));
  const off = choicesOf(w).filter(id => !w.state.choices[id]).map(nameOf);
  if (!w.update) {
    off.push(...retiredApis(w.config).map(({ id }) => id));
    for (const [id] of keptApis(w)) (w.state.choices[apiChoice(id)] ? on : off).push(id);
  }
  const intro = [
    'Turns on: ' + (on.join(', ') || w.text.none),
    'Turns off: ' + (off.join(', ') || w.text.none),
    'Installs: ' + (w.plan.install.map(item => tools.REGISTRY[item.id].label + ' (' + w.plan.users.get(item.id).join(', ')
      + '): ' + item.command + '. Source: ' + item.source).join(' · ') || w.text.none),
    'You install by hand: ' + (w.plan.manual.map(item => tools.REGISTRY[item.id].label + ': ' + item.source + ' (' + item.note + ')').join(' · ') || w.text.none),
    'Training on your data: ' + onOff(w.state.training),
  ];
  const plans = PLAN_IDS.filter(id => w.state.choices[id] && (w.shown.has(id) || w.planOnly.has(id)));
  if (plans.length) intro.push('Plans: ' + plans.map(id => nameOf(id) + ' (' + PLAN_NAMES[id][w.state.plans[id]] + ')').join(', '));
  return tui.list(w.io, page(3, [action('save', 'Save and set up'), action('back', 'Back')], intro));
}

// A free provider proves itself with real trivial work, so setup spends no calls on a self-test for it.
const needsTest = (config, id) => config.providers.providers[id]?.evidence === 'docs' && !!config.providers.providers[id]?.cli
  && !['free', 'local'].includes(config.providers.providers[id]?.kind);

/** Test new or newly logged-in CLIs and docs-only providers still awaiting a pass. */
async function selfTests(w, commands, failedOn, open, usable, changed) {
  const turnedOn = commands.filter(command => command[0] === 'use' && command[2] === 'on' && command.includes('--no-test')).map(command => command[1]);
  const turnedOff = new Set(commands.filter(command => command[0] === 'use' && command[2] === 'off').map(command => command[1]));
  const activated = chosen(w, choicesOf(w)).filter(id => {
    const provider = w.config.providers.providers[id];
    // A free provider proves itself with real work, also right after its CLI was installed or logged in.
    return provider?.cli && provider.tos !== 'avoid' && !['free', 'local'].includes(provider.kind) && changed.has(toolOf(id)) && !turnedOff.has(id);
  });
  const waiting = Object.keys(w.config.providers.providers).filter(id => inScope(w, id) && w.state.choices[id] && usable(toolOf(id)) && enabledNow(w.config, id)
    && needsTest(w.config, id) && !w.selfTestPassed(id));
  const ids = [...new Set([...turnedOn, ...waiting, ...activated])].filter(id => usable(toolOf(id)) && !failedOn.has(id))
    .filter(id => !open.some(line => [nameOf(id), tools.REGISTRY[toolOf(id)]?.label].some(name => name && line.startsWith(name + ' ('))));
  const results = [];
  for (const id of ids) {
    say(w, w.text.testing(nameOf(id)));
    try { results.push(String(await withTerminal(w, () => w.run(['providers', 'test', id]))).trim()); }
    catch (error) { results.push(w.text.problem('providers test ' + id, error.message)); }
  }
  return results;
}

function buildCommands(w, usable) {
  const { state, project, config } = w;
  const commands = w.update ? [] : [['on', '--host', state.host, state.profile]];
  if (!w.update && state.host === 'claude-code' && config.providers.providers.claude && !enabledNow(config, 'claude') && usable('claude')) commands.push(['use', 'claude', 'on']);
  for (const id of [...['claude', ...OWN].filter(id => id !== hostPool(w)), LITE, DEVIN, ...OTHER, MEDIA, 'kilo-free']) {
    if (!inScope(w, id)) continue;
    const want = !!state.choices[id] && usable(toolOf(id));
    // Setup counts for every project. A project switch left off here would still block a yes, so that one goes too.
    // A provider that needs a self-test is tested after the logins below, not before them.
    if (config.providers.providers[id] && enabledNow(config, id) !== want) commands.push(['use', id, want ? 'on' : 'off', ...(want && needsTest(config, id) ? ['--no-test'] : [])]);
    if (config.providers.providers[id] && want && project.use?.providersOff?.includes(id)) commands.push(['use', id, 'on', '--project']);
  }
  for (const id of Object.keys(PRESETS)) {
    if (!inScope(w, id)) continue;
    const want = !!state.choices[id] && usable(OPENCODE), present = !!config.providers.providers[id];
    if (want && !enabledNow(config, id)) commands.push(['add-api', id]);
    if (!want && present) commands.push(['remove-api', id]);
  }
  if (!w.update) {
    for (const { id } of retiredApis(config)) commands.push(['remove-api', id]);
    for (const [id] of keptApis(w)) {
      const want = state.choices[apiChoice(id)] && usable(OPENCODE);
      if (enabledNow(config, id) !== want) commands.push(['use', id, onOff(want)]);
    }
  }
  if (usable(OPENCODE)) {
    for (const api of activeApis(w)) commands.push(['add-api', api.id, api.model, '--trains', api.trains ? 'yes' : 'no', ...(api.free ? ['--free'] : [])]);
  }
  // Training counts for all projects, so both the global value and this project's own one must match the answer.
  if (trainers(w).length && (!w.update || w.trainingChanged) && (state.training !== project.allowTrainingProviders || state.training !== w.defaultTraining)) commands.push(['set', 'training', state.training ? 'on' : 'off']);
  return commands;
}

function reportInstalls(w, resultLines, after, usable) {
  return w.plan.install.map(item => {
    const label = tools.REGISTRY[item.id].label;
    const line = (resultLines.find(text => text.startsWith('- ' + item.id + ':')) || '').replace(/^- /, '');
    // The program's name and what it is for: Junie Lite needs the Junie CLI, which the user never picked by that name.
    if (/FAILED/.test(line)) return label + ' (for ' + w.plan.users.get(item.id).join(', ') + ')' + line.slice(item.id.length);
    if (usable(item.id)) return w.text.installed(label, after.get(item.id).installed);
    if (/new terminal/.test(line)) return w.text.newTerminal(label);
    return line || label;
  });
}

async function logins(w, usable, changed) {
  const ids = [...w.plan.users.keys()].filter(id => id !== OPENCODE).filter(usable);
  const pending = (ids.length ? w.tools.pendingLogins(ids, w.options) : []).filter(login => login.id !== OPENCODE && !login.optional);
  const open = [];
  for (const [index, login] of pending.entries()) {
    const label = tools.REGISTRY[login.id].label;
    const key = await tui.pause(w.io, w.text.loginAsk(index + 1, pending.length, label), [
      login.newWindow ? 'A window opens. Finish there; if it stays open after the login, close it and setup goes on.' : 'Follow the sign-in instructions.',
      ...(login.hint ? [login.hint] : []),
    ]);
    if (key === 'quit' || !await withTerminal(w, () => tools.finishLogin(login, {
      say: line => say(w, line), options: w.options, api: w.tools,
    }))) open.push(label + ' (' + login.command + ')');
    else changed.add(login.id);
  }
  const keys = usable(OPENCODE) ? apiKeys(w) : [];
  for (const [index, api] of keys.entries()) {
    const key = await tui.pause(w.io, w.text.keyAsk(index + 1, keys.length, api.name), w.text.keySteps(api.page, api.hint), w.text.keyPrompt);
    if (key === 'quit') break;
    if (key !== 'enter') continue;
    await withTerminal(w, async () => {
      if (api.page) await w.tools.openPage(api.page, w.options);
      await w.tools.runKeyLogin(api.provider, w.options);
    });
  }
  const stored = w.tools.storedKeys(w.options) || '';
  return [...open, ...keys.filter(api => !keyStored(stored, api.name, api.provider))
    .map(api => api.name + ' (opencode auth login -p ' + api.provider + ')')];
}

/** Leave existing offers alone when their key cannot be found. */
async function dropUnkeyed(w, usable, failedAddApi) {
  if (!usable(OPENCODE)) return [];
  const stored = w.tools.storedKeys(w.options);
  if (stored == null) return [];
  const dropped = [];
  for (const id of chosen(w, FREE)) {
    if (!inScope(w, id) || enabledNow(w.config, id) || failedAddApi.has(id) || !PRESETS[id] || keyless(id)
      || keyStored(stored, nameOf(id), PRESETS[id].model.split('/')[0])) continue;
    try { await w.run(['remove-api', id]); dropped.push(nameOf(id)); } catch {}
  }
  return dropped;
}

async function applyPlans(w, usable, failedOn, problems) {
  const plans = {}, planModels = {};
  for (const id of PLAN_IDS) {
    if ((!w.shown.has(id) && !w.planOnly.has(id)) || !w.state.choices[id] || !usable(toolOf(id)) || failedOn.has(id)) continue;
    const value = w.state.plans[id], tracked = new Set(listOf(w.saved.planModels?.[id]));
    const provider = w.config.providers.providers[id];
    const models = w.config.models?.models ?? {};
    const changes = value === 'free' ? [...tracked] : Object.keys(models).filter(model => {
      const entry = models[model];
      return entry.pool === id && entry.enabled === false && !tracked.has(model) && model !== id + '-default'
        && !(provider?.cli?.defaultModel && entry.cliModel === provider.cli.defaultModel);
    });
    for (const model of changes) {
      if (models[model]?.pool !== id) { tracked.delete(model); continue; }
      const command = ['use', model, value === 'free' ? 'off' : 'on'];
      try {
        await withTerminal(w, () => w.run(command, { interactive: false }));
        if (value === 'free') tracked.delete(model); else tracked.add(model);
      } catch (error) { problems.push(w.text.problem(command.join(' '), error.message)); }
    }
    plans[id] = value;
    planModels[id] = [...tracked];
  }
  if (Object.keys(plans).length) w.updateState(state => ({ plans: { ...state.plans, ...plans }, planModels: { ...state.planModels, ...planModels } }));
}

async function finish(w) {
  w.io.draw(w.text.working);
  const ids = w.plan.install.map(item => item.id);
  const resultLines = ids.length ? (await withTerminal(w, () => w.tools.install(ids, {
    ...w.options, approved: true, say: line => say(w, line),
  }))).split('\n') : [];
  // Programs can change while the confirmation is on screen.
  const after = new Map(w.plan.users.size ? w.tools.check([...w.plan.users.keys()], w.options).map(item => [item.id, item]) : []);
  const usable = tool => !tool || USABLE.has(after.get(tool)?.state);

  const graphResult = !w.update && w.state.choices[GRAPH] && usable(GRAPH) && !resultLines.some(line => /^- graphify: FAILED/.test(line))
    ? await withTerminal(w, () => w.setupGraph(w.directory, w.options)) : '';
  const problems = [];
  const failedAddApi = new Set(), failedOn = new Set();
  const commands = buildCommands(w, usable);
  for (const command of commands) {
    try {
      const apply = () => w.run(command, { interactive: false });
      if (command[0] === 'use' && command[2] === 'on') await withTerminal(w, apply);
      else await apply();
    } catch (error) {
      if (command[0] === 'add-api') failedAddApi.add(command[1]);
      if (command[0] === 'use') failedOn.add(command[1]);
      problems.push(w.text.problem(command.join(' '), error.message));
    }
  }
  const stayedOff = [...chosen(w, choicesOf(w)).filter(id => !usable(toolOf(id))).map(nameOf),
    ...activeApis(w).filter(() => !usable(OPENCODE)).map(api => api.id),
    ...keptApis(w).filter(([id]) => !w.update && w.state.choices[apiChoice(id)] && !usable(OPENCODE)).map(([id]) => id)];

  const installs = reportInstalls(w, resultLines, after, usable);
  const changed = new Set(w.plan.install.filter(item => item.state !== 'outdated' && usable(item.id)).map(item => item.id));
  const logged = await logins(w, usable, changed);
  const dropped = await dropUnkeyed(w, usable, failedAddApi);
  const open = logged.filter(line => !dropped.some(name => line.startsWith(name + ' (')));
  await applyPlans(w, usable, failedOn, problems);
  const tested = await selfTests(w, commands, failedOn, open, usable, changed);
  let plans = [];
  try { plans = (await withTerminal(w, w.refreshPlans)).changes; } catch {}
  const ready = chosen(w, FREE).filter(id => inScope(w, id) && usable(toolOf(id)) && !failedAddApi.has(id) && (w.state.training || !mayTrain(id))).map(nameOf)
    .filter(name => !dropped.includes(name) && !open.some(line => line.startsWith(name + ' (')));
  await tui.pause(w.io, w.text.doneTitle, [
    ...installs,
    ...(stayedOff.length ? [w.text.stillOff + ' ' + stayedOff.join(', '), w.text.runAgain] : []),
    ...problems, ...tested,
    ...(open.length ? [w.text.loginsOpen(open.join(', '))] : []),
    ...(dropped.length ? [w.text.droppedNoKey(dropped.join(', '))] : []),
    ...(ready.length ? [w.text.freeReady(ready.join(', '))] : []),
    ...(plans.length ? w.text.planModels(require('./discover-models').changeLines(plans), plans.some(plan => plan.new?.length)) : []),
    ...(graphResult ? [graphResult, ...(w.state.host === 'claude-code' ? [w.text.graphNext] : [])] : []),
    w.state.host === 'claude-code' ? w.text.done : w.text.doneOther, w.text.config,
  ]);
}

/** Junie Lite starts on unless it was turned off on purpose, globally or for this project. */
function liteDefault(config, active, userProviders) {
  if (enabledNow(config, LITE)) return true;
  return !!config.providers.providers[LITE] && userProviders.providers?.[LITE]?.enabled !== false && !lib.projectUse(active).providersOff.includes(LITE);
}

function initialState(config, project, active, userProviders) {
  const choices = {};
  for (const id of ['claude', ...OWN, DEVIN, ...OTHER, MEDIA, ...FREE]) choices[id] = enabledNow(config, id);
  choices[LITE] = liteDefault(config, active, userProviders);
  choices[GRAPH] = false;
  return { profile: project.profile, host: project.host, choices, apis: [], training: project.allowTrainingProviders };
}

function userProviders() {
  try { return lib.readProviderConfig(path.join(lib.getPaths().quotaBossHome, 'config', 'providers.json')); } catch { return {}; }
}

function markSetup(w, ids, providers = []) {
  if (!ids.length && !providers.length) return;
  w.updateState(state => ({
    ...(ids.length ? { knownSetup: [...new Set([...listOf(state.knownSetup), ...ids])] } : {}),
    ...(providers.length ? { knownProviders: [...new Set([...listOf(state.knownProviders), ...providers])] } : {}),
  }));
}

/** Runs the setup on a terminal; anywhere else it only says how to start one. */
async function setup(args, run, deps = {}) {
  const update = args.length === 1 && args[0] === '--update';
  if (args.length && !update) throw new Error('Usage: quota-boss setup [--update]');
  const interactive = deps.interactive ?? !!(deps.io || (process.stdin.isTTY && process.stdout.isTTY));
  if (!interactive) return TEXT.terminalOnly(process.cwd(), require.resolve('./quota-boss.js'), update);
  const readState = deps.readState || lib.readState;
  const saved = readState(), known = [...listOf(saved.knownSetup)];
  const look = !update || !known.includes('look');
  const active = deps.project || lib.findProjectConfig();
  const config = deps.config || lib.loadConfig(active);
  const project = lib.normalizeProject(active);
  const state = initialState(config, project, active, deps.userProviders || userProviders());
  const w = { directory: active.directory || process.cwd(), text: TEXT, run, config, project, update, saved, state,
    options: { ...deps.options, scripts: true }, setupGraph: deps.setupGraph || graph.setupGraph, tools: deps.tools || tools,
    refreshPlans: deps.refreshPlans || (() => require('./discover-models').refresh()),
    readLook: deps.readLook || (() => ({ ...lib.statuslineLook(), always: lib.showsWithoutBoss() })),
    currentLimits: deps.currentLimits || preview.currentLimits, updateState: deps.updateState || lib.updateState,
    defaultTraining: deps.defaultTraining ?? (lib.readDefaults().allowTrainingProviders === true),
    selfTestPassed: deps.selfTestPassed || (id => require('./self-test').evidenceStatus(id, config.models, readState().selfTests, config.providers.providers[id]?.cli?.command).startsWith('self-test passed')),
    planOnly: new Set(update ? PLAN_IDS.filter(id => enabledNow(config, id) && !known.includes('plan:' + id)) : []),
    shown: new Set(update ? (deps.pending || newProviders.pending)() : []),
  };
  if (update) {
    w.shown.delete(hostPool(w));
    for (const id of [DEVIN, MEDIA]) if (!config.providers.providers[id]) w.shown.delete(id);
  }
  if (update && !look && !w.shown.size && !w.planOnly.size) return w.text.upToDate;

  state.plans = Object.fromEntries(PLAN_IDS.map(id => [id, Object.hasOwn(PLAN_NAMES[id], saved.plans?.[id]) ? saved.plans[id] : 'free']));
  for (const [id] of keptApis(w)) state.choices[apiChoice(id)] = enabledNow(config, id);
  w.io = deps.io || tui.open();
  try {
    const pages = [
      ...(look ? [() => lookPage(w)] : []),
      ...(!update ? [() => workPage(w)] : []),
      ...(!update || w.shown.size || w.planOnly.size ? [() => {
        if (!update) w.shown = new Set(CHOICES.filter(id => id !== hostPool(w) && (id === GRAPH ? asksForGraph(w)
          : FREE.includes(id) || Object.hasOwn(config.providers.providers, id))));
        return providerPage(w);
      }] : []),
      () => summaryPage(w),
    ];
    for (let index = 0;;) {
      const result = await pages[index]();
      if (result === 'quit') return w.text.aborted;
      if (result === 'back') { index = Math.max(0, index - 1); continue; }
      if (update && look && index === 0 && result === 'next' && !known.includes('look')) {
        markSetup(w, ['look']);
        known.push('look');
      }
      if (index === pages.length - 1) break;
      index++;
    }
    w.trainingChanged = state.training !== project.allowTrainingProviders;
    const items = update ? PLAN_IDS.filter(id => w.planOnly.has(id) || w.shown.has(id) && state.choices[id]).map(id => 'plan:' + id) : SETUP_ITEMS;
    markSetup(w, items, [...w.shown].filter(id => Object.hasOwn(config.providers.providers, id) || Object.hasOwn(lib.BUILTIN_PROVIDERS.providers, id)));
    await finish(w);
    return '';
  } finally {
    if (!deps.io) w.io.close();
  }
}

module.exports = { setup };
