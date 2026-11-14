'use strict';
// The step-by-step setup in its own terminal. Choices are only collected until the one confirmation in the
// summary; after that every change goes through the same validated commands as the CLI.
// A provider ends up on only if its program is really there, so a choice can never point at nothing.

const lib = require('./lib');
const tools = require('./tools');
const { PRESETS, MODEL_PATTERN } = require('./add-api');
const { PROVIDER_HELP, CODE_GRAPH_HELP, UNCONFIRMED_TRAINING, SCRIPTED_CLAUDE_WARNING } = require('./provider-help');
const { TEXT } = require('./setup-text');

const BACK = Symbol('back');
const WIDTH = 76;
const OPENCODE = 'opencode-free';
const OWN = ['workers.codex', 'workers.gpt', 'workers.perplexity'];
const OTHER = ['copilot', 'grok', 'antigravity'];
const FREE = ['mistral-api', 'zen-glm', 'zen-deepseek', 'openrouter-free', 'cloudflare', 'cohere', 'gemini-api', 'nvidia', 'zai', 'kilo-free'];
const GRAPH = 'graphify';
const graph = require('./graph');
const CHOICES = ['claude', ...OWN, ...OTHER, ...FREE, GRAPH];
const USABLE = new Set(['ok', 'outdated']);
const TOTAL_SECTIONS = 6;
const YES = ['y', 'yes'], NO = ['n', 'no'];

function wrap(line, indent) {
  const lead = line.match(/^ */)[0];
  const lines = [];
  let current = lead;
  for (const word of line.slice(lead.length).split(' ')) {
    if (current.trim() && (current + ' ' + word).length > WIDTH) { lines.push(current); current = lead + indent + word; }
    else current = current.trim() ? current + ' ' + word : current + word;
  }
  return [...lines, current].join('\n');
}

function frame(w, section, extra) {
  w.io.clear();
  w.io.say(w.text.title);
  w.io.say(w.text.step(section, TOTAL_SECTIONS, w.text.sections[section - 1]) + (extra ? '   (' + extra + ')' : ''));
  w.io.say('-'.repeat(WIDTH) + '\n');
}

const say = (w, lines, indent = '  ') => { for (const line of [].concat(lines)) w.io.say(wrap(line, indent)); };

/** Enter takes the shown default. Only a real answer or "back" ever leaves the question. */
function yesNo(w, question, fallback, nav = 'both') {
  const hint = fallback ? 'Y/n' : 'y/N';
  for (;;) {
    const help = nav === 'both' ? ' (' + w.text.navBoth + ')' : nav === 'back' ? ' (' + w.text.navBack + ')' : '';
    const answer = w.io.ask(question + ' [' + hint + ']' + help + ' ').toLowerCase();
    if (!answer) return fallback;
    if (YES.includes(answer)) return true;
    if (NO.includes(answer)) return false;
    if (nav !== 'none' && answer === 'b') return BACK;
    if (nav === 'both' && answer === 'f') return fallback;
    w.io.say(w.text.invalid);
  }
}

function pick(w, values, descriptions, current) {
  values.forEach((value, index) => say(w, (index + 1) + ') ' + value + (value === current ? ' (' + w.text.current + ')' : '') + ': ' + descriptions[value]));
  w.io.say('');
  for (;;) {
    const answer = w.io.ask(w.text.choose(current) + ' (' + w.text.navBoth + ') ').toLowerCase();
    if (!answer || answer === 'f') return current;
    if (answer === 'b') return BACK;
    if (/^\d$/.test(answer) && values[Number(answer) - 1]) return values[Number(answer) - 1];
    w.io.say(w.text.invalid);
  }
}

const enabledNow = (config, id) => {
  const provider = config.providers.providers[id];
  return !!provider && provider.enabled !== false;
};

/** Which program a choice depends on; null means it needs none. */
function toolOf(id) {
  if (id === 'workers.codex' || id === 'workers.gpt') return 'codex';
  if (id === 'workers.perplexity') return null;
  if (Object.hasOwn(tools.REGISTRY, id)) return id;
  return OPENCODE;
}

const helpOf = id => id === 'claude' ? { name: 'Claude', what: 'Claude models (Opus, Sonnet, Haiku) as workers through the official `claude` CLI', warning: SCRIPTED_CLAUDE_WARNING } : id === GRAPH ? CODE_GRAPH_HELP : PROVIDER_HELP[id];
const nameOf = id => helpOf(id).name;
const asksForGraph = w => !lib.detectCodeIntel(w.directory).graphify;
const choicesOf = w => CHOICES.filter(id => id !== 'claude' || w.state.host !== 'claude-code');
const chosen = (w, ids) => ids.filter(id => w.state.choices[id]);
const keptApis = w => Object.entries(w.config.providers.providers).filter(([id, p]) => p?.custom === true && !Object.hasOwn(PRESETS, id));
const mayTrain = id => id === 'kilo-free' || PRESETS[id].trains;
const keyStored = (stored, name, provider) => stored.includes(name.toLowerCase()) || stored.includes(provider.toLowerCase());

function apiKeys(w) {
  const entries = [
    ...chosen(w, Object.keys(PRESETS)).filter(id => !PRESETS[id].keyless).map(id => ({ name: nameOf(id), provider: PRESETS[id].model.split('/')[0], page: PRESETS[id].keyPage, hint: PRESETS[id].keyHint })),
    ...w.state.apis.map(api => ({ name: api.id, provider: api.model.split('/')[0] })),
    ...keptApis(w).filter(([, p]) => p.enabled !== false).flatMap(([id, p]) => {
      // add-api stores '{model}' in the args and the real model in defaultModel; older entries hold it literally.
      const model = typeof p.cli?.defaultModel === 'string' ? p.cli.defaultModel : p.cli?.args?.[2];
      return typeof model === 'string' && model.includes('/') ? [{ name: id, provider: model.split('/')[0] }] : [];
    }),
  ];
  const providers = new Set();
  const stored = w.tools.storedKeys(w.options);
  return entries.filter(entry => {
    const provider = entry.provider.toLowerCase();
    if (providers.has(provider) || keyStored(stored, entry.name, provider)) return false;
    providers.add(provider);
    return true;
  });
}

/** Everything chosen that may send project data to a provider allowed to train on it. */
function trainers(w) {
  return [...chosen(w, FREE).filter(mayTrain).map(id => nameOf(id)),
    ...w.state.apis.filter(api => api.trains).map(api => api.id),
    ...keptApis(w).filter(([, p]) => p.enabled !== false && p.trainsOnData === true).map(([id]) => id)];
}

function switchScreen(w, id, section, note) {
  return { section, run: position => {
    const help = helpOf(id), labels = w.text.labels, width = Math.max(...Object.values(labels).map(l => l.length)) + 2;
    frame(w, section, position);
    w.io.say(help.name + ' (' + (w.state.choices[id] ? w.text.on : w.text.off) + ')\n');
    for (const field of ['what', 'on', 'off', 'catch', 'needs', 'warning']) {
      if (help[field]) say(w, (labels[field] + ':').padEnd(width) + help[field], ' '.repeat(width));
    }
    if (note) say(w, ['', note]);
    w.io.say('');
    const answer = yesNo(w, w.text.turnOn, w.state.choices[id]);
    if (answer === BACK) return BACK;
    w.state.choices[id] = answer;
  } };
}

function choiceScreen(w, field, title, values, descriptions) {
  return { section: 1, run: position => {
    frame(w, 1, position);
    w.io.say(title + '\n');
    const answer = pick(w, values, descriptions, w.state[field]);
    if (answer === BACK) return BACK;
    w.state[field] = answer;
    if (field === 'host' && answer === 'claude-code') say(w, w.text.claude);
  } };
}

const keyless = id => id === 'kilo-free' || PRESETS[id].keyless === true;
const freeGroups = w => ({ all: FREE, 'no-training': FREE.filter(id => !mayTrain(id)), none: [], 'no-key': FREE.filter(keyless) });

function freeGroup(w, title, ids) {
  w.io.say(title);
  for (const id of ids) w.io.say((keyless(id) ? '  ' : '* ') + nameOf(id).padEnd(23) + (id === 'kilo-free' ? 'no key, no published limit' : PRESETS[id].gets));
  w.io.say('');
}

/** The one question most people answer; choosing one by one opens the per-offer screens after it. */
function freeScreen(w) {
  return { section: 4, run: position => {
    frame(w, 4, position);
    say(w, w.text.freeIntro, '');
    w.io.say('');
    freeGroup(w, w.text.freeNoTraining, FREE.filter(id => !mayTrain(id)));
    freeGroup(w, w.text.freeMayTrain, FREE.filter(mayTrain));
    say(w, w.text.freeKeyNote, '');
    w.io.say('');
    const groups = freeGroups(w), on = chosen(w, FREE);
    const current = Object.keys(groups).find(name => groups[name].length === on.length && groups[name].every(id => w.state.choices[id])) || 'keep';
    const values = [...(current === 'keep' ? ['keep'] : []), 'no-training', 'all', 'none', 'one-by-one', 'no-key'];
    const answer = pick(w, values, w.text.freeOptions(on.map(id => nameOf(id)).join(', ')), current);
    if (answer === BACK) return BACK;
    w.state.freeChoice = answer;
    if (Object.hasOwn(groups, answer)) for (const id of FREE) w.state.choices[id] = groups[answer].includes(id);
  } };
}

function askApi(w) {
  const taken = id => Object.hasOwn(lib.BUILTIN_PROVIDERS.providers, id) || Object.hasOwn(PRESETS, id) || w.state.apis.some(api => api.id === id)
    || Object.hasOwn(w.config.providers.providers, id);
  const until = (question, valid, complaint) => {
    for (;;) {
      const answer = w.io.ask(question);
      if (!answer || valid(answer)) return answer;
      w.io.say(complaint);
    }
  };
  const id = until(w.text.apiName, value => lib.validProviderId(value) && !taken(value), w.text.apiNameBad);
  if (!id) return;
  const model = until(w.text.apiModel, value => MODEL_PATTERN.test(value), w.text.apiModelBad);
  if (!model) return;
  const trains = until(w.text.apiTrains, value => [...YES, ...NO].includes(value.toLowerCase()), w.text.invalid).toLowerCase();
  if (!trains) return;
  w.state.apis.push({ id, model, trains: YES.includes(trains), free: yesNo(w, w.text.apiFree, false, 'none') });
}

function apiScreen(w) {
  return { section: 5, run: () => {
    w.state.apis = [];
    for (;;) {
      frame(w, 5);
      w.io.say(w.text.apiTitle + '\n');
      say(w, w.text.apiIntro);
      const existing = [...keptApis(w).map(([id]) => id), ...w.state.apis.map(api => api.id)];
      if (existing.length) say(w, ['', w.text.apiExisting(existing.join(', '))]);
      w.io.say('');
      const answer = yesNo(w, w.text.apiAsk, false, w.state.apis.length ? 'none' : 'both');
      if (answer === BACK) return BACK;
      if (!answer) return;
      askApi(w);
    }
  } };
}

function trainingScreen(w) {
  return { section: 5, applies: () => trainers(w).length > 0, run: () => {
    frame(w, 5);
    w.io.say(w.text.trainingTitle + '\n');
    const warnings = chosen(w, FREE).filter(mayTrain).map(id => [nameOf(id), (helpOf(id).warning || '').replace(UNCONFIRMED_TRAINING, '').trim()]).filter(([, text]) => text);
    say(w, [w.text.trainingNames(trainers(w).join(', ')), '', w.text.trainingOn, w.text.trainingOff, ...(warnings.length ? ['', ...warnings.map(([name, text]) => name + ': ' + text)] : [])]);
    if (w.state.choices['mistral-api']) say(w, ['', ...w.text.optOut, w.text.optOutAdvice]);
    w.io.say('');
    const answer = yesNo(w, w.text.trainingAsk, w.state.training);
    if (answer === BACK) return BACK;
    w.state.training = answer;
  } };
}

/** Which programs the current choices need, and who needs them. */
function neededTools(w) {
  const users = new Map();
  const add = (tool, name) => { if (tool) users.set(tool, [...(users.get(tool) || []), name]); };
  for (const id of chosen(w, choicesOf(w))) add(toolOf(id), nameOf(id));
  for (const api of w.state.apis) add(OPENCODE, api.id);
  for (const [id, provider] of keptApis(w)) if (provider.enabled !== false) add(OPENCODE, id);
  return users;
}

function plan(w) {
  const users = neededTools(w);
  const items = w.tools.check([...users.keys()], w.options);
  return { users, install: w.tools.installable(items), manual: items.filter(item => item.state === 'manual') };
}

function summaryScreen(w) {
  return { section: 6, run: () => {
    frame(w, 6);
    w.io.say(w.text.checking + '\n');
    w.plan = plan(w);
    frame(w, 6);
    const on = [...chosen(w, choicesOf(w)).map(id => nameOf(id)), ...w.state.apis.map(api => api.id)];
    const off = choicesOf(w).filter(id => !w.state.choices[id] && (id !== GRAPH || asksForGraph(w))).map(id => nameOf(id));
    const blocked = w.state.training ? [] : trainers(w);
    say(w, [w.text.profile + ': ' + w.state.profile, w.text.assistant + ': ' + w.state.host, w.text.turnedOn + ': ' + (on.join(', ') || w.text.none),
      w.text.turnedOff + ': ' + (off.join(', ') || w.text.none), w.text.training + ': ' + (w.state.training ? w.text.on : w.text.off)]);
    if (blocked.length) say(w, w.text.blockedByTraining(blocked.join(', ')));
    if (w.plan.install.length) {
      w.io.say('\n' + w.text.willInstall);
      for (const item of w.plan.install) {
        w.io.say('- ' + tools.REGISTRY[item.id].label + ' (' + w.text.forProviders(w.plan.users.get(item.id).join(', ')) + ')');
        w.io.say('    ' + item.command + '\n    ' + w.text.source + ': ' + item.source);
      }
    }
    if (w.plan.manual.length) {
      w.io.say('\n' + w.text.byHand);
      for (const item of w.plan.manual) say(w, '- ' + tools.REGISTRY[item.id].label + ': ' + item.source + ' (' + item.note + ')');
    }
    w.io.say('');
    const answer = yesNo(w, w.plan.install.length ? w.text.saveAndInstall : w.text.save, false, 'back');
    if (answer === BACK) return BACK;
    w.confirmed = answer;
  } };
}

/** Screens can appear or vanish as answers change, so the list is filtered again on every move. */
function walk(screens) {
  const active = () => screens.filter(screen => !screen.applies || screen.applies());
  for (let index = 0; index < active().length;) {
    const current = active();
    const siblings = current.filter(screen => screen.section === current[index].section);
    const position = siblings.length > 1 ? siblings.indexOf(current[index]) + 1 : 0;
    const result = current[index].run(position ? position + '/' + siblings.length : '');
    index = result === BACK ? Math.max(0, index - 1) : index + 1;
  }
}

function buildCommands(w, usable) {
  const { state, project, config } = w;
  const commands = [['on', '--host', state.host, state.profile]];
  for (const id of OWN) {
    const worker = id.slice('workers.'.length), want = state.choices[id] && usable(toolOf(id));
    if (project.workers[worker] !== want) commands.push(['set', { codex: 'codex-tasks', gpt: 'gpt-reviews', perplexity: 'perplexity' }[worker], want ? 'on' : 'off']);
  }
  if (state.host === 'claude-code' && config.providers.providers.claude && !enabledNow(config, 'claude')) commands.push(['use', 'claude', 'on']);
  for (const id of [...(state.host === 'claude-code' ? [] : ['claude']), ...OTHER, 'kilo-free']) {
    const want = state.choices[id] && usable(toolOf(id));
    if (config.providers.providers[id] && enabledNow(config, id) !== want) commands.push(['use', id, want ? 'on' : 'off']);
  }
  for (const id of Object.keys(PRESETS)) {
    const want = state.choices[id] && usable(OPENCODE), present = !!config.providers.providers[id];
    if (want && !enabledNow(config, id)) commands.push(['add-api', id]);
    if (!want && present) commands.push(['remove-api', id]);
  }
  if (usable(OPENCODE)) {
    for (const api of state.apis) commands.push(['add-api', api.id, api.model, '--trains', api.trains ? 'yes' : 'no', ...(api.free ? ['--free'] : [])]);
  }
  if (trainers(w).length && state.training !== project.allowTrainingProviders) commands.push(['set', 'training', state.training ? 'on' : 'off']);
  return commands;
}

function reportInstalls(w, resultLines, after, usable) {
  for (const item of w.plan.install) {
    const label = tools.REGISTRY[item.id].label;
    const line = (resultLines.find(text => text.startsWith('- ' + item.id + ':')) || '').replace(/^- /, '');
    if (/FAILED/.test(line)) say(w, line);
    else if (usable(item.id)) w.io.say(w.text.installed(label, after.get(item.id).installed));
    else if (/new terminal/.test(line)) say(w, w.text.newTerminal(label));
    else say(w, line || label);
  }
}

function logins(w, usable) {
  const ids = [...w.plan.users.keys()].filter(id => id !== OPENCODE).filter(usable);
  const pending = w.tools.pendingLogins(ids, w.options).filter(login => login.id !== OPENCODE);
  pending.forEach((login, index) => {
    w.io.clear();
    w.io.say(w.text.loginTitle + '\n' + '-'.repeat(WIDTH) + '\n');
    say(w, [w.text.loginAsk(index + 1, pending.length, tools.REGISTRY[login.id].label, login.command), login.newWindow ? w.text.loginWindow : w.text.loginInline]);
    w.io.say('');
    if (yesNo(w, w.text.loginNow, false, 'none')) w.tools.runLogin(login.id, w.options);
  });
  const open = pending.length ? w.tools.pendingLogins(ids, w.options).filter(login => login.id !== OPENCODE && login.checkable) : [];
  const keys = usable(OPENCODE) ? apiKeys(w) : [];
  keys.forEach((api, index) => {
    w.io.clear();
    w.io.say(w.text.keyTitle + '\n' + '-'.repeat(WIDTH));
    say(w, [w.text.keyAsk(index + 1, keys.length, api.name), ...w.text.keySteps(api.page, api.hint)]);
    w.io.say('');
    if (yesNo(w, w.text.keyNow, true, 'none')) {
      if (api.page) w.tools.openPage(api.page, w.options);
      w.tools.runKeyLogin(api.provider, w.options);
    }
  });
  const stored = w.tools.storedKeys(w.options);
  return [...open.map(login => tools.REGISTRY[login.id].label + ' (' + login.command + ')'),
    ...keys.filter(api => !keyStored(stored, api.name, api.provider))
      .map(api => api.name + ' (opencode auth login -p ' + api.provider + ')')];
}

/** After choosing a group, an offer without a key is removed, or tasks would be routed to it and fail. */
function dropUnkeyed(w, usable) {
  if (!['all', 'no-training'].includes(w.state.freeChoice) || !usable(OPENCODE)) return [];
  const stored = w.tools.storedKeys(w.options);
  if (!stored) return [];
  return chosen(w, FREE).filter(id => PRESETS[id] && !PRESETS[id].keyless && !keyStored(stored, nameOf(id), PRESETS[id].model.split('/')[0]))
    .filter(id => { try { w.run(['remove-api', id]); return true; } catch { return false; } }).map(id => nameOf(id));
}

function finish(w) {
  w.io.clear();
  w.io.say(w.text.working + '\n');
  const ids = w.plan.install.map(item => item.id);
  const resultLines = ids.length ? w.tools.install(ids, w.options).split('\n') : [];
  const after = new Map(w.tools.check([...w.plan.users.keys()], w.options).map(item => [item.id, item]));
  const usable = tool => !tool || USABLE.has(after.get(tool)?.state);

  const graphResult = w.state.choices[GRAPH] && usable(GRAPH) && !resultLines.some(line => /^- graphify: FAILED/.test(line))
    ? w.setupGraph(w.directory, w.options) : '';
  const problems = [];
  const failedAddApi = new Set();
  for (const command of buildCommands(w, usable)) {
    try { w.run(command); } catch (error) {
      if (command[0] === 'add-api') failedAddApi.add(command[1]);
      problems.push(w.text.problem(command.join(' '), error.message));
    }
  }
  const stayedOff = [...chosen(w, choicesOf(w)).filter(id => !usable(toolOf(id))).map(id => nameOf(id)),
    ...w.state.apis.filter(() => !usable(OPENCODE)).map(api => api.id)];

  reportInstalls(w, resultLines, after, usable);
  const report = () => {
    if (stayedOff.length) say(w, ['', w.text.stillOff + ' ' + stayedOff.join(', '), w.text.runAgain]);
    if (problems.length) say(w, ['', ...problems]);
  };
  report();
  if (stayedOff.length || problems.length) { w.io.say(''); w.io.ask(w.text.pressContinue + ' '); }

  const logged = logins(w, usable);
  const dropped = dropUnkeyed(w, usable);
  const open = logged.filter(line => !dropped.some(name => line.startsWith(name + ' (')));
  w.io.clear();
  w.io.say(w.text.doneTitle + '\n' + '-'.repeat(WIDTH) + '\n');
  report();
  if (open.length) say(w, ['', w.text.loginsOpen(open.join(', '))]);
  if (dropped.length) say(w, ['', w.text.droppedNoKey(dropped.join(', '))]);
  const ready = chosen(w, FREE).filter(id => usable(toolOf(id)) && !failedAddApi.has(id) && (w.state.training || !mayTrain(id))).map(id => nameOf(id))
    .filter(name => !dropped.includes(name) && !open.some(line => line.startsWith(name + ' (')));
  if (ready.length) say(w, ['', w.text.freeReady(ready.join(', '))]);
  if (w.state.choices['mistral-api'] && !dropped.includes(nameOf('mistral-api')) && !w.state.training && usable(toolOf('mistral-api'))) say(w, ['', w.text.reminder, ...w.text.optOut, w.text.optOutAdvice]);
  if (graphResult) say(w, ['', graphResult, ...(w.state.host === 'claude-code' ? [w.text.graphNext] : [])]);
  say(w, ['', w.state.host === 'claude-code' ? w.text.done : w.text.doneOther, w.text.addLater]);
}

function initialState(config, project) {
  const choices = {};
  for (const id of OWN) choices[id] = project.workers[id.slice('workers.'.length)];
  for (const id of ['claude', ...OTHER, ...FREE]) choices[id] = enabledNow(config, id);
  choices[GRAPH] = false;
  return { profile: project.profile, host: project.host, choices, apis: [], training: project.allowTrainingProviders };
}

/** Runs the setup on a terminal; anywhere else it only says how to start one and changes nothing. */
function setup(args, run, deps = {}) {
  if (args.length) throw new Error('Usage: quota-boss setup');
  const text = TEXT;
  const interactive = deps.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return text.terminalOnly(process.cwd(), require.resolve('./quota-boss.js'));
  const active = deps.project || lib.findProjectConfig();
  const config = deps.config || lib.loadConfig(active);
  const project = lib.normalizeProject(active);
  const w = { directory: active.directory || process.cwd(), text, run, config, project, options: deps.options, setupGraph: deps.setupGraph || graph.setupGraph, tools: deps.tools || tools, state: initialState(config, project), confirmed: false,
    io: { ask: deps.ask || lib.askLine, say: deps.say || console.log, clear: deps.clear || console.clear } };

  w.state.choices.claude = w.state.choices.claude && USABLE.has(w.tools.check(['claude'], w.options)[0]?.state);
  w.io.clear();
  w.io.say(text.title + '\n' + '-'.repeat(WIDTH) + '\n');
  say(w, [...text.intro(process.cwd()), '']);
  w.io.ask(text.press + ' ');

  walk([
    choiceScreen(w, 'profile', text.profileTitle, lib.PROFILES, text.profiles),
    choiceScreen(w, 'host', text.hostTitle, lib.HOSTS, text.hosts),
    { ...switchScreen(w, GRAPH, 1), applies: () => asksForGraph(w) },
    ...OWN.map(id => switchScreen(w, id, 2)),
    { ...switchScreen(w, 'claude', 3), applies: () => w.state.host !== 'claude-code' },
    ...OTHER.map(id => switchScreen(w, id, 3, text.onlyWithPlan)),
    freeScreen(w),
    ...FREE.map(id => ({ ...switchScreen(w, id, 4), applies: () => w.state.freeChoice === 'one-by-one' })),
    apiScreen(w),
    trainingScreen(w),
    summaryScreen(w),
  ]);
  if (!w.confirmed) return text.aborted;
  finish(w);
  return '';
}

module.exports = { setup };
