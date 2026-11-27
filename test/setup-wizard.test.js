'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('../scripts/setup-wizard');
const { retiredProviders } = require('../scripts/lib');
const { TEXT } = require('../scripts/setup-text');
const { PROVIDER_HELP } = require('../scripts/provider-help');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

// Without a folder the wizard looks at the real working folder, where a local graphify-out/ hides the graph screen.
const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-wizard-'));
test.after(() => fs.rmSync(EMPTY_DIR, { recursive: true, force: true }));

const provider = (enabled, extra) => ({ enabled, ...extra });
const baseProviders = () => ({ copilot: provider(false), grok: provider(false), antigravity: provider(false),
  'kilo-free': provider(false, { trainsOnData: true }), codex: provider(true) });
const project = () => ({ enabled: false, profile: 'balanced', host: 'claude-code', allowTrainingProviders: false });

/**
 * Plays one setup. Enter takes each default, so `answers` is the list of typed lines in order.
 * `programs` maps tool ids to their state before install; `afterInstall` to their state after it.
 */
function play(answers, { directory = EMPTY_DIR, host, providers = baseProviders(), programs = {}, afterInstall = {}, pending = [], stored = [], installOutput, runError, graphError, userProviders = {}, use, selfTestPassed = () => true, plans = [] } = {}) {
  const queue = [...answers], said = [], commands = [], installs = [], logged = [], keyed = [], opened = [], graphs = [], marked = [];
  let installed = false;
  const stateOf = id => (installed && afterInstall[id]) || programs[id] || 'ok';
  const fake = {
    check: ids => ids.map(id => ({ id, state: stateOf(id), installed: '1.0', command: 'npm install ' + id, source: 'https://example.test/' + id, note: 'by hand' })),
    installable: items => items.filter(item => ['missing', 'outdated', 'broken'].includes(item.state)),
    install: ids => { installed = true; installs.push(...ids); return installOutput || ids.map(id => '- ' + id + ': done').join('\n'); },
    pendingLogins: () => pending,
    runLogin: id => { logged.push(id); return { status: 0 }; },
    storedKeys: () => stored.join('\n'),
    runKeyLogin: provider => keyed.push(provider),
    openPage: url => opened.push(url),
  };
  const retired = retiredProviders(providers);
  const activeProviders = { ...providers };
  for (const { id } of retired) delete activeProviders[id];
  const result = setup([], args => { commands.push(args); const error = runError?.(args); if (error) throw error; return ''; }, {
    interactive: true, tools: fake, options: { wait: () => {} }, userProviders, selfTestPassed, refreshPlans: () => ({ changes: plans }), markKnown: ids => marked.push(...ids), setupGraph: directory => { graphs.push(directory); return graphError || 'Code graph built locally; no Claude usage.'; }, config: { providers: { providers: activeProviders, retired } }, project: { ...project(), ...(host ? { host } : {}), ...(directory ? { directory } : {}), ...(use ? { use } : {}) },
    ask: question => { said.push(question); return queue.length ? queue.shift() : ''; }, say: line => said.push(line), clear: () => {},
  });
  return { result, said: said.join('\n'), commands, installs, logged, keyed, opened, graphs, marked, left: queue };
}

// Enter on: start, profile, host, 2 own (Codex, Perplexity), 5 other (Junie Lite first, then 4 plans), the free offers question, api question.
const START = [''], FIRST_TWO = ['', '', ''], OWN = ['', ''], OTHER_NONE = ['', '', '', '', ''], FREE_NONE = [''], NO_API = [''];
// Chooses "one by one" (option 4, or 5 when "keep" is listed first), then answers the 8 offers in setup order:
// 0 Zen DeepSeek, 1 OpenRouter, 2 Cloudflare, 3 Cohere, then the rest.
const freeAnswers = (picks, option = '4') => [option, ...Array.from({ length: 8 }, (_, index) => picks[index] ?? '')];
const COHERE = freeAnswers({ 3: 'y' });
const flow = (other, free, rest) => [...START, ...FIRST_TWO, ...OWN, ...other, ...free, ...NO_API, ...rest];

test('nothing is saved or installed without the one confirmation', () => {
  const { result, commands, installs } = play(flow(['', 'y', '', '', ''], FREE_NONE, ['n']), { programs: { copilot: 'missing' } });
  assert.deepEqual(commands, []);
  assert.deepEqual(installs, []);
  assert.equal(result, TEXT.aborted);
});

test('a confirmed setup marks every shown provider as offered, an aborted one marks none', () => {
  const providers = { ...baseProviders(), 'junie-lite': provider(false), jetbrains: provider(false) };
  const aborted = play(flow(OTHER_NONE, FREE_NONE, ['n']), { providers });
  assert.deepEqual(aborted.marked, []);
  const confirmed = play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers });
  assert.deepEqual([...confirmed.marked].sort(), ['antigravity', 'codex', 'copilot', 'grok', 'jetbrains', 'junie-lite', 'kilo-free']);
});

test('one yes installs what the choices need and turns them on', () => {
  const { said, commands, installs } = play(flow(['', 'y', '', '', ''], FREE_NONE, ['y']), { programs: { copilot: 'missing' }, afterInstall: { copilot: 'ok' } });
  assert.deepEqual(installs, ['copilot']);
  assert.deepEqual(commands, [['on', '--host', 'claude-code', 'balanced'], ['use', 'copilot', 'on']]);
  assert.match(said, /npm install copilot/);
  assert.match(said, /https:\/\/example\.test\/copilot/);
});

test('a provider whose program is missing afterwards stays off and says why', () => {
  const { said, commands } = play(flow(['', 'y', '', '', ''], FREE_NONE, ['y']), { programs: { copilot: 'missing' }, afterInstall: { copilot: 'missing' }, installOutput: '- copilot: FAILED (EACCES)' });
  assert.deepEqual(commands, [['on', '--host', 'claude-code', 'balanced']]);
  assert.match(said, /FAILED \(EACCES\)/);
  assert.match(said, /Stayed off because the program is missing: GitHub Copilot/);
});

test('an API offer is only added when OpenCode is really there, and names the program', () => {
  const free = freeAnswers({ 0: 'y' });
  const ok = play(flow(OTHER_NONE, free, ['y']), { programs: { 'opencode': 'missing' }, afterInstall: { 'opencode': 'ok' } });
  assert.deepEqual(ok.commands.slice(1), [['add-api', 'zen-deepseek']]);
  assert.match(ok.said, /OpenCode \(needed for OpenCode Zen DeepSeek\)/);
  const failed = play(flow(OTHER_NONE, free, ['y']), { programs: { 'opencode': 'missing' }, afterInstall: { 'opencode': 'missing' } });
  assert.deepEqual(failed.commands.slice(1), []);
});

test('Kilo uses its own CLI, needs no login, and stays off if install fails', () => {
  const free = freeAnswers({ 7: 'y' });
  const options = { programs: { 'kilo-free': 'missing', 'opencode': 'missing' }, afterInstall: { 'kilo-free': 'ok' } };
  const ok = play(flow(OTHER_NONE, free, ['y', 'y']), options);
  assert.deepEqual(ok.installs, ['kilo-free']);
  assert.ok(ok.commands.some(c => c.join(' ') === 'use kilo-free on'));
  assert.ok(ok.commands.some(c => c.join(' ') === 'set training on'));
  assert.match(ok.said, /Kilo Free.*no key, 200 requests\/hour per IP address/);
  assert.match(ok.said, /log prompts/);
  assert.match(ok.said, /outputs/);
  assert.doesNotMatch(ok.said, /Key 1 of|Login 1 of/);
  const failed = play(flow(OTHER_NONE, free, ['y', 'y']), { ...options, afterInstall: { 'kilo-free': 'missing' }, installOutput: '- kilo-free: FAILED (EACCES)' });
  assert.deepEqual(failed.installs, ['kilo-free']);
  assert.ok(!failed.commands.some(c => c.join(' ') === 'use kilo-free on'));
  assert.match(failed.said, /Stayed off because the program is missing: Kilo Free/);
});

test('turning an added offer off removes it', () => {
  const providers = { ...baseProviders(), 'zen-deepseek': provider(true, { custom: true }) };
  const { commands } = play(flow(OTHER_NONE, freeAnswers({ 0: 'n' }, '5'), ['y']), { providers });
  assert.deepEqual(commands.slice(1), [['remove-api', 'zen-deepseek']]);
});

test('setup plans to remove the retired Zen GLM provider on confirmation', () => {
  const providers = { ...baseProviders(), 'zen-glm': provider(true, {
    custom: true, cli: { command: 'opencode', defaultModel: 'opencode/glm-5.3-flash-free' },
  }) };
  const options = { providers, programs: { 'opencode': 'missing' } };
  const { commands, said, installs } = play(flow(OTHER_NONE, FREE_NONE, ['y']), options);
  assert.deepEqual(commands.slice(1), [['remove-api', 'zen-glm']]);
  assert.match(said, /zen-glm/);
  assert.doesNotMatch(said, /Key 1 of/);
  assert.deepEqual(installs, []);
  assert.deepEqual(play(flow(OTHER_NONE, FREE_NONE, ['n']), options).commands, []);
});

test('setup removes both legacy Mistral pools with Zen GLM after confirmation', () => {
  const providers = { ...baseProviders(),
    'mistral-api': provider(true, { custom: true, kind: 'free', trainsOnData: true, cli: { defaultModel: 'mistral/codestral-latest' } }),
    mistral: provider(false, { kind: 'free' }),
    'zen-glm': provider(true, { custom: true, kind: 'free', cli: { defaultModel: 'opencode/glm-5.3-flash-free' } }),
  };
  const options = { providers, stored: ['mistral'], programs: { 'opencode': 'missing' } };
  const { commands, said, installs, keyed } = play(flow(OTHER_NONE, FREE_NONE, ['y']), options);
  assert.deepEqual(commands.slice(1), [['remove-api', 'zen-glm'], ['remove-api', 'mistral-api'], ['remove-api', 'mistral']]);
  assert.match(said, /zen-glm, mistral-api, mistral/);
  assert.doesNotMatch(said, /Already added:.*mistral-api|Key 1 of|Allow them in all your projects/);
  assert.deepEqual(installs, []);
  assert.deepEqual(keyed, []);
  assert.deepEqual(play(flow(OTHER_NONE, FREE_NONE, ['n']), options).commands, []);
});

test('setup keeps a paid custom Mistral API', () => {
  const providers = { ...baseProviders(), 'mistral-api': provider(true, {
    custom: true, kind: 'api', cli: { command: 'opencode', args: ['run', '-m', '{model}'], defaultModel: 'mistral/codestral-latest' },
  }) };
  const { commands, said } = play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers, stored: ['mistral'] });
  assert.deepEqual(commands.slice(1), []);
  assert.match(said, /Already added: mistral-api/);
});

test('one answer turns on the grouped free offers except NVIDIA, and missing keys are removed', () => {
  const { said, commands } = play(flow(OTHER_NONE, ['2'], ['n', 'y', ...Array(6).fill('n')]), { stored: ['1 credentials'] });
  assert.ok(commands.some(c => c[0] === 'add-api' && c[1] === 'gemini-api'));
  assert.deepEqual(commands.filter(c => c[0] === 'remove-api').map(c => c[1]), ['openrouter-free', 'cloudflare', 'cohere', 'gemini-api', 'zai']);
  assert.match(said, /humans may read/);
  assert.match(said, /Allow them in all your projects/);
  assert.match(said, /Left out because no key was entered: OpenRouter Free/);
  assert.doesNotMatch(said, /Still not logged in/);
  assert.doesNotMatch(said, /could not confirm whether it trains/);
  assert.doesNotMatch(said, /OpenCode Free/);
});

test('the add-all free offers choice excludes NVIDIA', () => {
  const { commands } = play(flow(OTHER_NONE, ['2'], ['n', 'y', ...Array(6).fill('n')]), { stored: ['1 credentials'] });
  assert.ok(commands.some(c => c[0] === 'add-api' && c[1] === 'zai'));
  assert.ok(!commands.some(c => c[0] === 'add-api' && c[1] === 'nvidia'));
  const oneByOne = play(flow(OTHER_NONE, freeAnswers({ 5: 'y' }), ['', 'y', 'y']), { stored: ['1 credentials'] });
  assert.ok(oneByOne.commands.some(c => c[0] === 'add-api' && c[1] === 'nvidia'));
});

test('the no-training group adds only offers that do not train and asks no training question', () => {
  const { said, commands } = play(flow(OTHER_NONE, ['1'], ['y']), { stored: ['1 credentials'] });
  assert.deepEqual(commands.slice(1), [['add-api', 'zen-deepseek'], ['add-api', 'zai'], ['remove-api', 'zai']]);
  assert.doesNotMatch(said, /Allow them in all your projects/);
  assert.match(said, /Free offers ready to use: OpenCode Zen DeepSeek\./);
});

test('the no-key group adds only offers that need no key or account and marks the others', () => {
  const { said, commands } = play(flow(OTHER_NONE, ['5'], ['y', 'y', 'y']), { stored: ['1 credentials'] });
  const added = commands.filter(c => c[0] === 'add-api').map(c => c[1]);
  assert.deepEqual(added, ['zen-deepseek']);
  assert.ok(commands.some(c => c.includes('kilo-free')), JSON.stringify(commands));
  assert.ok(!commands.some(c => c[0] === 'add-api' && ['mistral-api', 'openrouter-free', 'gemini-api'].includes(c[1])));
  assert.match(said, /Only the ones without a key or account/);
  assert.doesNotMatch(said, /Mistral/);
  assert.match(said, /\n\* OpenRouter Free {8}50 calls a day/);
  assert.match(said, /\n {2}OpenCode Zen DeepSeek {2}no key/);
  assert.match(said, /\n {2}Kilo Free {14}no key/);
  assert.match(said, /\* needs a free key from that site/);
  assert.match(said, /Free offers ready to use: OpenCode Zen DeepSeek, Kilo/);
  assert.doesNotMatch(said, /Left out because no key was entered/);
});

test('a free offer whose registration fails is not reported as ready', () => {
  const { said, commands } = play(flow(OTHER_NONE, ['1'], ['y']), {
    stored: ['1 credentials'],
    runError: args => args[0] === 'add-api' && args[1] === 'zen-deepseek' ? new Error('Provider config is busy; retry.') : null,
  });
  assert.deepEqual(commands.slice(1), [['add-api', 'zen-deepseek'], ['add-api', 'zai'], ['remove-api', 'zai']]);
  assert.match(said, /Could not apply add-api zen-deepseek: Provider config is busy; retry\./);
  assert.doesNotMatch(said, /Free offers ready to use:/);
});

test('the free screen only lists what you get, in two groups, and the warnings wait for the training question', () => {
  const { said } = play(flow(OTHER_NONE, ['2'], ['n', 'y', ...Array(6).fill('n')]), { stored: ['1 credentials'] });
  const screen = said.slice(said.indexOf('What you get for free'), said.indexOf('Choose a number (Enter = none)', said.indexOf('What you get for free')));
  assert.match(screen, /Does not train on your data\n {2}OpenCode Zen DeepSeek {2}no key, no published limit, free for now/);
  assert.match(screen, /May train on your data, or does not say\n\* OpenRouter Free {8}50 calls a day/);
  assert.ok(screen.indexOf('OpenCode Zen DeepSeek') < screen.indexOf('May train'));
  assert.doesNotMatch(screen, /Groq|SambaNova/);
  assert.doesNotMatch(screen, /humans may read|OmniRoute/);
  assert.ok(said.indexOf('humans may read') > said.indexOf('This concerns:'));
  assert.ok(screen.split('\n').every(line => line.length <= 76));
});

test('an offer blocked by the training answer is not reported as ready', () => {
  const { said } = play(flow(OTHER_NONE, COHERE, ['n', 'y']), { stored: ['cohere'] });
  assert.doesNotMatch(said, /ready to use/);
});

test('a failed key check removes nothing and reports the open key', () => {
  const { said, commands } = play(flow(OTHER_NONE, ['2'], ['n', 'y', ...Array(7).fill('n')]));
  assert.ok(!commands.some(c => c[0] === 'remove-api'));
  assert.match(said, /Still not logged in: OpenRouter Free/);
});

test('a mixed selection is kept on Enter and the per-offer screens stay hidden', () => {
  const providers = { ...baseProviders(), cohere: provider(true, { custom: true }) };
  const { said, commands } = play(flow(OTHER_NONE, [''], ['y']), { providers });
  assert.match(said, /Keep what is on now: Cohere/);
  assert.deepEqual(commands.slice(1), []);
  assert.doesNotMatch(said, /Cohere \(on\)/);
});

test('the setup asks for more APIs, re-asks bad input and needs a stated training answer', () => {
  const answers = [...START, ...FIRST_TWO, ...OWN, ...OTHER_NONE, ...FREE_NONE,
    'y', 'BAD NAME', 'my-api', 'no-slash', 'acme/model-1', 'n', 'y', 'n', 'y'];
  const { said, commands } = play(answers);
  assert.match(said, /Use lowercase letters/);
  assert.match(said, /does not look like provider\/model/);
  assert.deepEqual(commands.slice(1), [['add-api', 'my-api', 'acme/model-1', '--trains', 'no', '--free']]);
});

test('the training question appears only when a chosen offer may train', () => {
  const none = play(flow(OTHER_NONE, FREE_NONE, ['y']));
  assert.doesNotMatch(none.said, /Allow them in all your projects/);
  const cohere = play(flow(OTHER_NONE, COHERE, ['n', 'y']));
  assert.match(cohere.said, /Allow them in all your projects/);
  assert.deepEqual(cohere.commands.slice(1), [['add-api', 'cohere']]);
  const allowed = play(flow(OTHER_NONE, COHERE, ['y', 'y']));
  assert.ok(allowed.commands.some(c => c[0] === 'set' && c[1] === 'training' && c[2] === 'on'));
});

test('back returns to the previous question and keeps the changed answer', () => {
  const answers = [...START, '3', 'b', '1', '', '', ...OWN, ...OTHER_NONE, ...FREE_NONE, ...NO_API, 'y'];
  const { commands } = play(answers);
  assert.deepEqual(commands[0], ['on', '--host', 'claude-code', 'quality']);
});

test('f moves forward and keeps the answer; the summary cannot be skipped', () => {
  const answers = [...START, 'f', 'f', 'f', 'n', 'b', 'f', '', ...OTHER_NONE, ...FREE_NONE, ...NO_API, 'f', 'y'];
  const { said, commands } = play(answers);
  assert.match(said, /Enter or f = next page, b = previous page/);
  assert.match(said, /one of the shown letters/);
  assert.deepEqual(commands.slice(1), [['use', 'codex', 'off']]);
});

test('confirmed setup starts required logins without asking again', () => {
  const pending = [{ id: 'copilot', command: 'copilot', checkable: false, optional: false }, { id: 'codex', command: 'codex login', checkable: true, optional: false },
    { id: 'opencode', command: 'opencode auth login', checkable: false, optional: true }];
  const { logged, said, left } = play(flow(OTHER_NONE, FREE_NONE, ['y']), { pending });
  assert.deepEqual(logged, ['copilot', 'codex']);
  assert.match(said, /Logging in: copilot/);
  assert.deepEqual(left, []);
  assert.deepEqual(play(flow(OTHER_NONE, FREE_NONE, ['n']), { pending }).logged, []);
});

test('chosen presets get one key screen each, in order, with their pages', () => {
  const free = freeAnswers({ 1: 'y', 2: 'y' });
  const { said, keyed, opened } = play(flow(OTHER_NONE, free, ['n', 'y', 'y']));
  assert.deepEqual(opened, ['https://openrouter.ai/settings/keys', 'https://dash.cloudflare.com/']);
  assert.deepEqual(keyed, ['openrouter', 'cloudflare-workers-ai']);
  assert.match(said, /Key 1 of 2: OpenRouter Free/);
  assert.match(said, /Key 2 of 2: Cloudflare Workers AI/);
});

test('a key screen says what that service needs beyond a key', () => {
  const { said, opened } = play(flow(OTHER_NONE, freeAnswers({ 1: 'y', 2: 'y' }), ['n', 'y', 'y', 'y']));
  assert.match(said, /Key 1 of 2: OpenRouter Free[\s\S]*A balance of 0 is normal/);
  assert.match(said, /Key 2 of 2: Cloudflare Workers AI[\s\S]*Use REST API[\s\S]*Account ID[\s\S]*Create a Workers AI API Token/);
  assert.deepEqual(opened, ['https://openrouter.ai/settings/keys', 'https://dash.cloudflare.com/']);
});

test('OpenCode Zen is added without a key screen or a training question', () => {
  const { said, keyed, opened, commands } = play(flow(OTHER_NONE, freeAnswers({ 0: 'y' }), ['y']));
  assert.deepEqual(commands.slice(1), [['add-api', 'zen-deepseek']]);
  assert.deepEqual(keyed, []);
  assert.deepEqual(opened, []);
  assert.doesNotMatch(said, /Allow them in all your projects/);
  assert.doesNotMatch(said, /Key 1 of/);
});

test('a stored provider gets no key screen', () => {
  const { said, keyed } = play(flow(OTHER_NONE, COHERE, ['n', 'y', 'y']), { stored: ['cohere'] });
  assert.doesNotMatch(said, /Key .*Cohere/);
  assert.deepEqual(keyed, []);
});

test('declining a key login leaves its OpenCode command in the done report', () => {
  const { said, keyed } = play(flow(OTHER_NONE, COHERE, ['n', 'y', 'n']));
  assert.deepEqual(keyed, []);
  assert.match(said, /Cohere \(opencode auth login -p cohere\)/);
});

test('without a terminal it prints the start command and changes nothing', () => {
  const commands = [];
  const output = setup([], args => commands.push(args), { interactive: false });
  assert.match(output, /Open a terminal/);
  assert.match(output, /cd "/);
  assert.match(output, /quota-boss\.js" setup/);
  assert.deepEqual(commands, []);
});

test('local models are never offered and unknown arguments are refused', () => {
  assert.doesNotMatch(play(flow(OTHER_NONE, FREE_NONE, ['y'])).said, /ollama/i);
  assert.throws(() => setup(['--lang', 'de'], () => '', { interactive: true }), /Usage/);
});

test('all setup text is English', () => {
  const { said } = play(flow(OTHER_NONE, COHERE, ['n', 'y']), { programs: { 'opencode': 'missing' }, afterInstall: { 'opencode': 'ok' } });
  assert.doesNotMatch(said + JSON.stringify(PROVIDER_HELP), /[äöüßÄÖÜ]|Schritt|Zusammenfassung|einschalten/i);
  assert.match(said, /Step 6 of 6: Summary/);
});

test('every option that needs another program says so', () => {
  for (const id of Object.keys(require('../scripts/add-api').PRESETS)) {
    assert.match(PROVIDER_HELP[id].needs, /OpenCode/);
  }
});

test('the code graph is explained, asked once, and installed only with the one confirmation', () => {
  const answers = [...START, '', '', 'y', ...OWN, ...OTHER_NONE, ...FREE_NONE, ...NO_API, 'y'];
  const yes = play(answers, { programs: { graphify: 'missing' }, afterInstall: { graphify: 'ok' } });
  assert.match(yes.said, /Code graph \(Graphify\)/);
  assert.match(yes.said, /docs, PDFs and images/);
  assert.match(yes.said, /npm install graphify/);
  assert.deepEqual(yes.installs, ['graphify']);
  assert.equal(yes.graphs.length, 1);
  assert.match(yes.said, /Optional: type \/graphify \. in Claude Code/);
  assert.deepEqual(yes.commands, [['on', '--host', 'claude-code', 'balanced']]);
  const no = play(flow(OTHER_NONE, FREE_NONE, ['y']), { programs: { graphify: 'missing' } });
  assert.deepEqual(no.installs, []);
  assert.deepEqual(no.graphs, []);
  assert.doesNotMatch(no.said, /type \/graphify/);
});

test('the code graph question is skipped when this folder already has a graph', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-graph-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'graphify-out'));
  fs.writeFileSync(path.join(directory, 'graphify-out', 'graph.json'), '{}');
  const answers = [...START, '', '', ...OWN, ...OTHER_NONE, ...FREE_NONE, ...NO_API, 'y'];
  assert.doesNotMatch(play(answers, { directory }).said, /Code graph/);
});


test('setup builds for an already installed Graphify and reports build failures without aborting', () => {
  const answers = [...START, '', '', 'y', ...OWN, ...OTHER_NONE, ...FREE_NONE, ...NO_API, 'y'];
  const ready = play(answers, { programs: { graphify: 'ok' } });
  assert.deepEqual(ready.installs, []);
  assert.equal(ready.graphs.length, 1);
  const failedBuild = play(answers, { graphError: 'Could not build the code graph.' });
  assert.equal(failedBuild.graphs.length, 1);
  assert.match(failedBuild.said, /Could not build the code graph/);
  assert.match(failedBuild.said, /Your settings apply/);
  const failedInstall = play(answers, { programs: { graphify: 'missing' }, afterInstall: { graphify: 'missing' }, installOutput: '- graphify: FAILED (installer)' });
  assert.deepEqual(failedInstall.graphs, []);
  const failedRegistration = play(answers, { programs: { graphify: 'missing' }, afterInstall: { graphify: 'ok' }, installOutput: '- graphify: FAILED (setup step)' });
  assert.deepEqual(failedRegistration.graphs, []);
});

test('a kept custom API template asks for the provider key from defaultModel', () => {
  const providers = { ...baseProviders(), 'my-mistral': provider(true, { custom: true, cli: { args: ['run', '-m', '{model}'], defaultModel: 'mistral/x' } }) };
  const missing = play(flow(OTHER_NONE, [''], ['y', 'y']), { providers });
  assert.deepEqual(missing.keyed, ['mistral']);
  assert.match(missing.said, /Key 1 of 1: my-mistral/);
  const stored = play(flow(OTHER_NONE, [''], ['y']), { providers, stored: ['mistral'] });
  assert.deepEqual(stored.keyed, []);
  assert.doesNotMatch(stored.said, /Key 1 of/);
  assert.ok(!stored.commands.some(c => c[0] === 'remove-api'));
});

for (const host of ['codex', 'generic']) {
  // On a Codex host its own pool needs no switch, so only the Perplexity screen is left.
  const own = host === 'codex' ? [''] : OWN;
  for (const enabled of [false, true]) {
    for (const usable of [false, true]) {
      test('Claude switch for ' + host + ', enabled=' + enabled + ', usable=' + usable, () => {
        const providers = { ...baseProviders(), claude: provider(enabled) };
        const answers = [...START, ...FIRST_TWO, ...own, '', ...OTHER_NONE, ...FREE_NONE, ...NO_API, 'y'];
        const result = play(answers, { host, providers, programs: { claude: usable ? 'ok' : 'broken' } });
        assert.match(result.said, /Claude models \(Opus, Sonnet, Haiku\)/);
        assert.doesNotMatch(result.said, /Claude always stays on/);
        assert.ok(result.said.replace(/\s+/g, ' ').includes(require('../scripts/provider-help').SCRIPTED_CLAUDE_WARNING));
        assert.equal(result.commands.some(c => c.join(' ') === 'use claude off'), enabled && !usable);
        assert.equal(result.commands.some(c => c.join(' ') === 'use claude on'), false);
      });
    }
  }
  test('Claude can be enabled for ' + host + ' only when installation succeeds', () => {
    for (const usable of [false, true]) {
      const result = play([...START, ...FIRST_TWO, ...own, 'y', ...OTHER_NONE, ...FREE_NONE, ...NO_API, 'y'], {
        host, providers: { ...baseProviders(), claude: provider(false) }, programs: { claude: 'missing' }, afterInstall: { claude: usable ? 'ok' : 'missing' },
      });
      assert.equal(result.commands.some(c => c.join(' ') === 'use claude on'), usable);
    }
  });
}
test('Claude Code restores its boss pool without a Claude switch', () => {
  const result = play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers: { ...baseProviders(), claude: provider(false) } });
  assert.ok(result.commands.some(c => c.join(' ') === 'use claude on'));
  assert.doesNotMatch(result.said, /Claude models \(Opus, Sonnet, Haiku\)/);
});

const withLite = () => ({ ...baseProviders(), 'junie-lite': provider(false), jetbrains: provider(false) });

test('Junie Lite is preselected and turned on when the provider exists and was never turned off', () => {
  const { said, commands } = play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers: withLite() });
  assert.match(said, /Junie Lite \(free\) \(on\)/);
  assert.deepEqual(commands.slice(1), [['use', 'junie-lite', 'on']]);
  assert.deepEqual(play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers: withLite(), programs: { junie: 'missing' } }).commands.slice(1), []);
});

test('an explicit off for Junie Lite is kept, from the user providers file or the project', () => {
  for (const options of [{ userProviders: { providers: { 'junie-lite': { enabled: false } } } }, { use: { providersOff: ['junie-lite'] } }]) {
    const { said, commands } = play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers: withLite(), ...options });
    assert.match(said, /Junie Lite \(free\) \(off\)/);
    assert.deepEqual(commands.slice(1), []);
  }
  assert.deepEqual(play(flow(['n', '', '', '', ''], FREE_NONE, ['y']), { providers: withLite() }).commands.slice(1), []);
  assert.deepEqual(play(flow(OTHER_NONE, FREE_NONE, ['y'])).commands.slice(1), []);
});

test('the Junie Lite screen has no plan note, JetBrains AI has one', () => {
  const { said, commands } = play(flow(['', '', '', '', 'y'], FREE_NONE, ['y']), { providers: withLite() });
  const screen = name => said.slice(said.indexOf(name), said.indexOf(TEXT.turnOn, said.indexOf(name)));
  assert.ok(!screen('Junie Lite (free) (').includes(TEXT.onlyWithPlan));
  assert.ok(screen('JetBrains AI (Junie) (').includes(TEXT.onlyWithPlan));
  assert.ok(said.indexOf('Junie Lite (free) (') < said.indexOf('GitHub Copilot ('));
  assert.deepEqual(commands.slice(1), [['use', 'junie-lite', 'on'], ['use', 'jetbrains', 'on']]);
});

test('Gemini media gets its own screen after the plans, installs its program and counts as a training offer', () => {
  const providers = { ...baseProviders(), 'gemini-media': provider(false, { kind: 'free', evidence: 'docs', cli: { command: 'gemini-api' } }) };
  // The extra screen comes after the 4 plan screens; a yes there brings up the training question before the summary.
  const on = play(flow([...OTHER_NONE, 'y'], FREE_NONE, ['y', 'y']), { providers, programs: { 'gemini-media': 'missing' }, afterInstall: { 'gemini-media': 'ok' } });
  assert.match(on.said, /Gemini media \(free\) \(off\)/);
  assert.ok(on.said.indexOf('GitHub Copilot (') < on.said.indexOf('Gemini media (free) ('));
  assert.ok(on.said.includes(TEXT.trainingNames('Gemini media (free)')));
  assert.deepEqual(on.installs, ['gemini-media']);
  assert.ok(on.commands.some(c => c.join(' ') === 'use gemini-media on'));
  assert.deepEqual(on.left, []);
  const off = play(flow([...OTHER_NONE, ''], FREE_NONE, ['y']), { providers });
  assert.ok(!off.commands.some(c => c.includes('gemini-media')));
  assert.deepEqual(off.left, []);
  // Without the provider in the config there is no screen, so older answer lists still fit.
  assert.doesNotMatch(play(flow(OTHER_NONE, FREE_NONE, ['y'])).said, /Gemini media/);
});

test('a provider that needs a self-test is turned on without one and tested after the login, unless that login stays open', () => {
  const docs = () => ({ ...baseProviders(), 'junie-lite': provider(false, { evidence: 'docs', cli: { command: 'junie' } }), jetbrains: provider(false) });
  const done = play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers: docs() });
  assert.deepEqual(done.commands.slice(1), [['use', 'junie-lite', 'on', '--no-test'], ['providers', 'test', 'junie-lite']]);
  assert.match(done.said, /Testing Junie Lite/);
  const pending = [{ id: 'junie', command: 'junie', checkable: true, optional: false, newWindow: true }];
  const open = play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers: docs(), pending });
  assert.deepEqual(open.commands.slice(1), [['use', 'junie-lite', 'on', '--no-test']]);
  assert.match(open.said, /Still not logged in: Junie CLI \(junie\)/);
  const inline = play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers: docs(), pending: [{ ...pending[0], checkable: false }] });
  assert.deepEqual(inline.commands.slice(1), [['use', 'junie-lite', 'on', '--no-test'], ['providers', 'test', 'junie-lite']]);
});

test('a free docs provider is turned on without a self-test and setup spends no call on one', () => {
  const free = () => ({ ...baseProviders(), 'junie-lite': provider(false, { kind: 'free', evidence: 'docs', cli: { command: 'junie' } }), jetbrains: provider(false) });
  assert.deepEqual(play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers: free() }).commands.slice(1), [['use', 'junie-lite', 'on']]);
  const on = { ...free(), 'junie-lite': provider(true, { kind: 'free', evidence: 'docs', cli: { command: 'junie' } }) };
  assert.deepEqual(play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers: on, selfTestPassed: () => false }).commands.slice(1), []);
});

test('a provider an update turned on without a self-test is tested by setup; one that passed is not', () => {
  const on = () => ({ ...baseProviders(), 'junie-lite': provider(true, { evidence: 'docs', cli: { command: 'junie' } }), jetbrains: provider(false) });
  const waiting = play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers: on(), selfTestPassed: () => false });
  assert.deepEqual(waiting.commands.slice(1), [['providers', 'test', 'junie-lite']]);
  const passed = play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers: on() });
  assert.deepEqual(passed.commands.slice(1), []);
});

test('setup installs and logs in Junie for free Junie Lite without a self-test call', () => {
  const providers = { ...baseProviders(), 'junie-lite': provider(false, { kind: 'free', evidence: 'docs', cli: { command: 'junie' } }) };
  const { installs, logged, commands } = play(flow(OTHER_NONE, FREE_NONE, ['y']), {
    providers, programs: { junie: 'missing' }, afterInstall: { junie: 'ok' }, pending: [{ id: 'junie', command: 'junie', checkable: false }],
  });
  assert.deepEqual(installs, ['junie']);
  assert.deepEqual(logged, ['junie']);
  assert.deepEqual(commands.slice(1), [['use', 'junie-lite', 'on']]);
});

test('one setup confirmation installs Junie, starts login and tests Junie Lite', () => {
  const providers = { ...baseProviders(), 'junie-lite': provider(false, { evidence: 'docs', cli: { command: 'junie' } }) };
  const pending = [{ id: 'junie', command: 'junie', checkable: false }];
  const { installs, logged, commands, left } = play(flow(OTHER_NONE, FREE_NONE, ['y']), {
    providers, programs: { junie: 'missing' }, afterInstall: { junie: 'ok' }, pending,
  });
  assert.deepEqual(installs, ['junie']);
  assert.deepEqual(logged, ['junie']);
  assert.deepEqual(commands.slice(1), [['use', 'junie-lite', 'on', '--no-test'], ['providers', 'test', 'junie-lite']]);
  assert.deepEqual(left, []);
});

test('the Junie login shows its hint and runs junie on yes', () => {
  const pending = [{ id: 'junie', command: 'junie', hint: 'In Junie choose "Continue with JetBrains account", log in in your browser, then type /exit.', checkable: true, optional: false, newWindow: true }];
  const { said, logged, opened } = play(flow(OTHER_NONE, FREE_NONE, ['y']), { providers: withLite(), pending });
  assert.match(said, /Logging in: junie \(new window\)/);
  assert.match(said, /Continue\s+with\s+JetBrains\s+account/);
  assert.deepEqual(logged, ['junie']); assert.deepEqual(opened, []);
});

test('setup counts for every project; a yes also clears a project switch that still blocks the provider', () => {
  const plain = play(flow(OTHER_NONE, FREE_NONE, ['y'])).commands;
  assert.ok(plain.every(command => !command.includes('--project')));
  const { commands } = play([...START, ...FIRST_TWO, 'y', '', ...OTHER_NONE, ...FREE_NONE, ...NO_API, 'y'], { use: { providersOff: ['codex'] } });
  assert.ok(commands.some(command => command.join(' ') === 'use codex on --project'), JSON.stringify(commands));
});

test('the done screen names the models set for the plans it found', () => {
  const plans = [{ provider: 'devin', plan: 'paid', on: ['devin-swe-2-1'], off: [] }];
  const { said } = play(flow(OTHER_NONE, FREE_NONE, ['y']), { plans });
  assert.match(said, /Models set for your plans \(checked again every day\):\n  devin \(paid plan\): on devin-swe-2-1/);
  assert.doesNotMatch(play(flow(OTHER_NONE, FREE_NONE, ['y'])).said, /Models set for your plans/);
});
