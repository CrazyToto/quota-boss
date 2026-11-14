'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('../scripts/setup-wizard');
const { TEXT } = require('../scripts/setup-text');
const { PROVIDER_HELP } = require('../scripts/provider-help');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

// Without a folder the wizard looks at the real working folder, where a local graphify-out/ hides the graph screen.
const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-wizard-'));
test.after(() => fs.rmSync(EMPTY_DIR, { recursive: true, force: true }));

const provider = (enabled, extra) => ({ enabled, ...extra });
const baseProviders = () => ({ copilot: provider(false), grok: provider(false), antigravity: provider(false),
  'opencode-free': provider(false, { trainsOnData: true }), 'kilo-free': provider(false, { trainsOnData: true }), codex: provider(true) });
const project = () => ({ enabled: false, profile: 'balanced', host: 'claude-code', workers: { codex: true, gpt: true, perplexity: true }, allowTrainingProviders: false });

/**
 * Plays one setup. Enter takes each default, so `answers` is the list of typed lines in order.
 * `programs` maps tool ids to their state before install; `afterInstall` to their state after it.
 */
function play(answers, { directory = EMPTY_DIR, host, providers = baseProviders(), programs = {}, afterInstall = {}, pending = [], stored = [], installOutput, runError, graphError } = {}) {
  const queue = [...answers], said = [], commands = [], installs = [], logged = [], keyed = [], opened = [], graphs = [];
  let installed = false;
  const stateOf = id => (installed && afterInstall[id]) || programs[id] || 'ok';
  const fake = {
    check: ids => ids.map(id => ({ id, state: stateOf(id), installed: '1.0', command: 'npm install ' + id, source: 'https://example.test/' + id, note: 'by hand' })),
    installable: items => items.filter(item => ['missing', 'outdated', 'broken'].includes(item.state)),
    install: ids => { installed = true; installs.push(...ids); return installOutput || ids.map(id => '- ' + id + ': done').join('\n'); },
    pendingLogins: () => pending,
    runLogin: id => logged.push(id),
    storedKeys: () => stored.join('\n'),
    runKeyLogin: provider => keyed.push(provider),
    openPage: url => opened.push(url),
  };
  const result = setup([], args => { commands.push(args); const error = runError?.(args); if (error) throw error; return ''; }, {
    interactive: true, tools: fake, setupGraph: directory => { graphs.push(directory); return graphError || 'Code graph built locally; no Claude usage.'; }, config: { providers: { providers } }, project: { ...project(), ...(host ? { host } : {}), ...(directory ? { directory } : {}) },
    ask: question => { said.push(question); return queue.length ? queue.shift() : ''; }, say: line => said.push(line), clear: () => {},
  });
  return { result, said: said.join('\n'), commands, installs, logged, keyed, opened, graphs, left: queue };
}

// Enter on: start, profile, host, 3 own, 3 other, the free offers question, api question.
const START = [''], FIRST_TWO = ['', '', ''], OWN = ['', '', ''], OTHER_NONE = ['', '', ''], FREE_NONE = [''], NO_API = [''];
// Chooses "one by one" (option 4, or 5 when "keep" is listed first), then answers the 10 offers in setup order:
// 0 Mistral, 1 Zen GLM, 2 Zen DeepSeek, 3 OpenRouter, 4 Cloudflare, then the rest.
const freeAnswers = (picks, option = '4') => [option, ...Array.from({ length: 10 }, (_, index) => picks[index] ?? '')];
const MISTRAL = freeAnswers({ 0: 'y' });
const flow = (other, free, rest) => [...START, ...FIRST_TWO, ...OWN, ...other, ...free, ...NO_API, ...rest];

test('nothing is saved or installed without the one confirmation', () => {
  const { result, commands, installs } = play(flow(['y', '', ''], FREE_NONE, ['n']), { programs: { copilot: 'missing' } });
  assert.deepEqual(commands, []);
  assert.deepEqual(installs, []);
  assert.equal(result, TEXT.aborted);
});

test('one yes installs what the choices need and turns them on', () => {
  const { said, commands, installs } = play(flow(['y', '', ''], FREE_NONE, ['y']), { programs: { copilot: 'missing' }, afterInstall: { copilot: 'ok' } });
  assert.deepEqual(installs, ['copilot']);
  assert.deepEqual(commands, [['on', '--host', 'claude-code', 'balanced'], ['use', 'copilot', 'on']]);
  assert.match(said, /npm install copilot/);
  assert.match(said, /https:\/\/example\.test\/copilot/);
});

test('a provider whose program is missing afterwards stays off and says why', () => {
  const { said, commands } = play(flow(['y', '', ''], FREE_NONE, ['y']), { programs: { copilot: 'missing' }, afterInstall: { copilot: 'missing' }, installOutput: '- copilot: FAILED (EACCES)' });
  assert.deepEqual(commands, [['on', '--host', 'claude-code', 'balanced']]);
  assert.match(said, /FAILED \(EACCES\)/);
  assert.match(said, /Stayed off because the program is missing: GitHub Copilot/);
});

test('an API offer is only added when OpenCode is really there, and names the program', () => {
  const free = freeAnswers({ 1: 'y' });
  const ok = play(flow(OTHER_NONE, free, ['y']), { programs: { 'opencode-free': 'missing' }, afterInstall: { 'opencode-free': 'ok' } });
  assert.deepEqual(ok.commands.slice(1), [['add-api', 'zen-glm']]);
  assert.match(ok.said, /OpenCode \(needed for OpenCode Zen GLM\)/);
  const failed = play(flow(OTHER_NONE, free, ['y']), { programs: { 'opencode-free': 'missing' }, afterInstall: { 'opencode-free': 'missing' } });
  assert.deepEqual(failed.commands.slice(1), []);
});

test('Kilo uses its own CLI, needs no login, and stays off if install fails', () => {
  const free = freeAnswers({ 9: 'y' });
  const options = { programs: { 'kilo-free': 'missing', 'opencode-free': 'missing' }, afterInstall: { 'kilo-free': 'ok' } };
  const ok = play(flow(OTHER_NONE, free, ['y', 'y']), options);
  assert.deepEqual(ok.installs, ['kilo-free']);
  assert.ok(ok.commands.some(c => c.join(' ') === 'use kilo-free on'));
  assert.ok(ok.commands.some(c => c.join(' ') === 'set training on'));
  assert.match(ok.said, /Kilo Free.*no key, no published limit/);
  assert.match(ok.said, /log prompts/);
  assert.match(ok.said, /outputs/);
  assert.doesNotMatch(ok.said, /Key 1 of|Login 1 of/);
  const failed = play(flow(OTHER_NONE, free, ['y', 'y']), { ...options, afterInstall: { 'kilo-free': 'missing' }, installOutput: '- kilo-free: FAILED (EACCES)' });
  assert.deepEqual(failed.installs, ['kilo-free']);
  assert.ok(!failed.commands.some(c => c.join(' ') === 'use kilo-free on'));
  assert.match(failed.said, /Stayed off because the program is missing: Kilo Free/);
});

test('turning an added offer off removes it', () => {
  const providers = { ...baseProviders(), 'zen-glm': provider(true, { custom: true }) };
  const { commands } = play(flow(OTHER_NONE, freeAnswers({ 1: 'n' }, '5'), ['y']), { providers });
  assert.deepEqual(commands.slice(1), [['remove-api', 'zen-glm']]);
});

test('one answer turns on every free offer, and offers left without a key are removed again', () => {
  const { said, commands } = play(flow(OTHER_NONE, ['2'], ['n', 'y', ...Array(6).fill('n')]), { stored: ['1 credentials', 'mistral'] });
  assert.ok(commands.some(c => c[0] === 'add-api' && c[1] === 'gemini-api'));
  assert.deepEqual(commands.filter(c => c[0] === 'remove-api').map(c => c[1]), ['openrouter-free', 'cloudflare', 'cohere', 'gemini-api', 'nvidia', 'zai']);
  assert.match(said, /humans may read/);
  assert.match(said, /Allow them in this folder/);
  assert.match(said, /Left out because no key was entered: OpenRouter Free/);
  assert.doesNotMatch(said, /Still not logged in/);
  assert.doesNotMatch(said, /could not confirm whether it trains/);
  assert.doesNotMatch(said, /OpenCode Free/);
});

test('the no-training group adds only offers that do not train and asks no training question', () => {
  const { said, commands } = play(flow(OTHER_NONE, ['1'], ['y']), { stored: ['1 credentials'] });
  assert.deepEqual(commands.slice(1), [['add-api', 'zen-glm'], ['add-api', 'zen-deepseek']]);
  assert.doesNotMatch(said, /Allow them in this folder/);
  assert.match(said, /Free offers ready to use: OpenCode Zen GLM, OpenCode Zen DeepSeek\./);
});

test('the no-key group adds only offers that need no key or account and marks the others', () => {
  const { said, commands } = play(flow(OTHER_NONE, ['5'], ['y', 'y', 'y']), { stored: ['1 credentials'] });
  const added = commands.filter(c => c[0] === 'add-api').map(c => c[1]);
  assert.deepEqual(added, ['zen-glm', 'zen-deepseek']);
  assert.ok(commands.some(c => c.includes('kilo-free')), JSON.stringify(commands));
  assert.ok(!commands.some(c => c[0] === 'add-api' && ['mistral-api', 'openrouter-free', 'gemini-api'].includes(c[1])));
  assert.match(said, /Only the ones without a key or account/);
  assert.match(said, /\n\* Mistral {16}about 1 billion tokens a month/);
  assert.match(said, /\n {2}OpenCode Zen GLM {7}no key/);
  assert.match(said, /\n {2}Kilo Free {14}no key/);
  assert.match(said, /\* needs a free key from that site/);
  assert.match(said, /Free offers ready to use: OpenCode Zen GLM, OpenCode Zen DeepSeek, Kilo/);
  assert.doesNotMatch(said, /Left out because no key was entered/);
});

test('a free offer whose registration fails is not reported as ready', () => {
  const { said, commands } = play(flow(OTHER_NONE, ['1'], ['y']), {
    stored: ['1 credentials'],
    runError: args => args[0] === 'add-api' && args[1] === 'zen-glm' ? new Error('Provider config is busy; retry.') : null,
  });
  assert.deepEqual(commands.slice(1), [['add-api', 'zen-glm'], ['add-api', 'zen-deepseek']]);
  assert.match(said, /Could not apply add-api zen-glm: Provider config is busy; retry\./);
  const ready = said.match(/Free offers ready to use: [^\n]+/);
  assert.ok(ready);
  assert.match(ready[0], /OpenCode Zen DeepSeek/);
  assert.doesNotMatch(ready[0], /OpenCode Zen GLM/);
});

test('the free screen only lists what you get, in two groups, and the warnings wait for the training question', () => {
  const { said } = play(flow(OTHER_NONE, ['2'], ['n', 'y', ...Array(7).fill('n')]), { stored: ['1 credentials'] });
  const screen = said.slice(said.indexOf('What you get for free'), said.indexOf('Choose a number (Enter = none)', said.indexOf('What you get for free')));
  assert.match(screen, /Does not train on your data\n {2}OpenCode Zen GLM {7}no key, no published limit, free for now/);
  assert.match(screen, /May train on your data, or does not say\n\* Mistral {16}about 1 billion tokens a month, 2 requests a minute/);
  assert.ok(screen.indexOf('OpenCode Zen DeepSeek') < screen.indexOf('May train'));
  assert.doesNotMatch(screen, /Groq|SambaNova/);
  assert.doesNotMatch(screen, /humans may read|OmniRoute/);
  assert.ok(said.indexOf('humans may read') > said.indexOf('This concerns:'));
  assert.ok(screen.split('\n').every(line => line.length <= 76));
});

test('an offer blocked by the training answer is not reported as ready', () => {
  const { said } = play(flow(OTHER_NONE, MISTRAL, ['n', 'y']), { stored: ['mistral'] });
  assert.doesNotMatch(said, /ready to use/);
});

test('a failed key check removes nothing and reports the open key', () => {
  const { said, commands } = play(flow(OTHER_NONE, ['2'], ['n', 'y', ...Array(7).fill('n')]));
  assert.ok(!commands.some(c => c[0] === 'remove-api'));
  assert.match(said, /Still not logged in: Mistral/);
});

test('a mixed selection is kept on Enter and the per-offer screens stay hidden', () => {
  const providers = { ...baseProviders(), 'zen-glm': provider(true, { custom: true }) };
  const { said, commands } = play(flow(OTHER_NONE, [''], ['y']), { providers });
  assert.match(said, /Keep what is on now: OpenCode Zen GLM/);
  assert.deepEqual(commands.slice(1), []);
  assert.doesNotMatch(said, /OpenCode Zen GLM \(on\)/);
});

test('the setup asks for more APIs, re-asks bad input and needs a stated training answer', () => {
  const answers = [...START, ...FIRST_TWO, ...OWN, ...OTHER_NONE, ...FREE_NONE,
    'y', 'BAD NAME', 'my-api', 'no-slash', 'acme/model-1', 'n', 'y', 'n', 'y'];
  const { said, commands } = play(answers);
  assert.match(said, /Use lowercase letters/);
  assert.match(said, /does not look like provider\/model/);
  assert.deepEqual(commands.slice(1), [['add-api', 'my-api', 'acme/model-1', '--trains', 'no', '--free']]);
});

test('the training question appears only when a chosen offer may train, and Mistral shows its switch', () => {
  const none = play(flow(OTHER_NONE, FREE_NONE, ['y']));
  assert.doesNotMatch(none.said, /Allow them in this folder/);
  const mistral = play(flow(OTHER_NONE, MISTRAL, ['n', 'y']));
  assert.match(mistral.said, /Allow them in this folder/);
  assert.match(mistral.said, /Anonymous improvement data/);
  assert.doesNotMatch(mistral.said, /Vibe/);
  assert.deepEqual(mistral.commands.slice(1), [['add-api', 'mistral-api']]);
  assert.match(mistral.said, /Still to do for Mistral/);
  const allowed = play(flow(OTHER_NONE, MISTRAL, ['y', 'y']));
  assert.ok(allowed.commands.some(c => c[0] === 'set' && c[1] === 'training' && c[2] === 'on'));
});

test('back returns to the previous question and keeps the changed answer', () => {
  const answers = [...START, '3', 'b', '1', '', '', ...OWN, ...OTHER_NONE, ...FREE_NONE, ...NO_API, 'y'];
  const { commands } = play(answers);
  assert.deepEqual(commands[0], ['on', '--host', 'claude-code', 'quality']);
});

test('f moves forward and keeps the answer; the summary cannot be skipped', () => {
  const answers = [...START, 'f', 'f', 'f', 'n', 'b', 'f', '', '', ...OTHER_NONE, ...FREE_NONE, ...NO_API, 'f', 'y'];
  const { said, commands } = play(answers);
  assert.match(said, /Enter or f = next page, b = previous page/);
  assert.match(said, /one of the shown letters/);
  assert.deepEqual(commands.slice(1), [['set', 'codex-tasks', 'off']]);
});

test('logins start only when wanted, and only from the listed tools', () => {
  const pending = [{ id: 'copilot', command: 'copilot', checkable: false, optional: false }, { id: 'codex', command: 'codex login', checkable: true, optional: false },
    { id: 'opencode-free', command: 'opencode auth login', checkable: false, optional: true }];
  const { logged, said } = play(flow(OTHER_NONE, FREE_NONE, ['y', 'y', 'n']), { pending });
  assert.deepEqual(logged, ['copilot']);
  assert.match(said, /Login 1 of 2: GitHub Copilot/);
});

test('chosen presets get one key screen each, in order, with their pages', () => {
  const free = freeAnswers({ 0: 'y', 3: 'y' });
  const { said, keyed, opened } = play(flow(OTHER_NONE, free, ['n', 'y', 'y']));
  assert.deepEqual(opened, ['https://admin.mistral.ai/organization/api-keys', 'https://openrouter.ai/settings/keys']);
  assert.deepEqual(keyed, ['mistral', 'openrouter']);
  assert.match(said, /Key 1 of 2: Mistral/);
  assert.match(said, /Key 2 of 2: OpenRouter Free/);
});

test('a key screen says what that service needs beyond a key', () => {
  const { said, opened } = play(flow(OTHER_NONE, freeAnswers({ 3: 'y', 4: 'y' }), ['n', 'y', 'y', 'y']));
  assert.match(said, /Key 1 of 2: OpenRouter Free[\s\S]*A balance of 0 is normal/);
  assert.match(said, /Key 2 of 2: Cloudflare Workers AI[\s\S]*Use REST API[\s\S]*Account ID[\s\S]*Create a Workers AI API Token/);
  assert.deepEqual(opened, ['https://openrouter.ai/settings/keys', 'https://dash.cloudflare.com/']);
});

test('OpenCode Zen is added without a key screen or a training question', () => {
  const { said, keyed, opened, commands } = play(flow(OTHER_NONE, freeAnswers({ 1: 'y', 2: 'y' }), ['y']));
  assert.deepEqual(commands.slice(1), [['add-api', 'zen-glm'], ['add-api', 'zen-deepseek']]);
  assert.deepEqual(keyed, []);
  assert.deepEqual(opened, []);
  assert.doesNotMatch(said, /Allow them in this folder/);
  assert.doesNotMatch(said, /Key 1 of/);
});

test('a stored provider gets no key screen', () => {
  const { said, keyed } = play(flow(OTHER_NONE, MISTRAL, ['n', 'y', 'y']), { stored: ['mistral'] });
  assert.doesNotMatch(said, /Key .*Mistral/);
  assert.deepEqual(keyed, []);
});

test('declining a key login leaves its OpenCode command in the done report', () => {
  const { said, keyed } = play(flow(OTHER_NONE, MISTRAL, ['n', 'y', 'n']));
  assert.deepEqual(keyed, []);
  assert.match(said, /Mistral \(opencode auth login -p mistral\)/);
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
  const { said } = play(flow(OTHER_NONE, MISTRAL, ['n', 'y']), { programs: { 'opencode-free': 'missing' }, afterInstall: { 'opencode-free': 'ok' } });
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
  for (const enabled of [false, true]) {
    for (const usable of [false, true]) {
      test('Claude switch for ' + host + ', enabled=' + enabled + ', usable=' + usable, () => {
        const providers = { ...baseProviders(), claude: provider(enabled) };
        const answers = [...START, ...FIRST_TWO, ...OWN, '', ...OTHER_NONE, ...FREE_NONE, ...NO_API, 'y'];
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
      const result = play([...START, ...FIRST_TWO, ...OWN, 'y', ...OTHER_NONE, ...FREE_NONE, ...NO_API, 'y'], {
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
