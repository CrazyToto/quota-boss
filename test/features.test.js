'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('../scripts/lib');
const cli = require('../scripts/quota-boss');
const settings = require('../scripts/settings');
const { route, formatTable } = require('../scripts/route');
const diagnostics = require('../scripts/diagnostics');
const defaults = require('../config/providers.json');
const models = require('../config/models.json');

function fakeDoctor(probe, options = {}) { return diagnostics.doctor(probe, { findExecutable: name => options.platform === 'win32' ? 'C:\\trusted\\' + name + '.cmd' : '/trusted/' + name, ...options }); }

test.describe('free/local providers, code intelligence, consensus and settings', () => {
  let dir, project, cwd, env;
  const projectFile = () => lib.getPaths().projectsFile;
  const projectValue = () => lib.readProjects()[lib.projectKey(project)];
  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-features-'));
    project = path.join(dir, 'project'); fs.mkdirSync(project);
    cwd = process.cwd();
    env = Object.fromEntries(['QUOTA_BOSS_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map(k => [k, process.env[k]]));
    process.env.QUOTA_BOSS_HOME = path.join(dir, 'boss');
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
    process.env.CODEX_HOME = path.join(dir, 'codex');
    process.chdir(project);
  });
  test.afterEach(() => {
    process.chdir(cwd);
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const capture = main => {
    const original = { input: lib.readInput, out: process.stdout.write };
    let output = '';
    lib.readInput = () => ({ cwd: project, session_id: 'graph-test' });
    process.stdout.write = s => { output += s; return true; };
    try { main(); return output; }
    finally { lib.readInput = original.input; process.stdout.write = original.out; }
  };

  test('free/local examples are disabled, zero cost and conservatively scored with safe templates', () => {
    lib.validateProviders(defaults);
    for (const id of ['opencode-free', 'kilo-free', 'ollama']) {
      const p = defaults.providers[id], m = models.models[id === 'kilo-free' ? id : id + '-example'];
      assert.equal(p.enabled, false); assert.equal(p.worker, 'cli-worker');
      assert.equal(p.trainsOnData, id !== 'ollama'); assert.equal(m.pool, id); assert.equal(m.cost, 0);
      assert.equal(m.scores.mechanical, 6); assert.ok(m.scores.implementation >= 4 && m.scores.implementation <= 5);
      for (const cat of ['architecture', 'debugging', 'review', 'research']) assert.ok(m.scores[cat] >= 3 && m.scores[cat] <= 4);
      assert.ok(!route({ models, providers: defaults }).candidates.some(c => c.pool === id));
    }
    assert.deepEqual(defaults.providers['opencode-free'].cli.args, ['run', '{prompt}']);
    assert.deepEqual(defaults.providers['kilo-free'].cli.args, ['run', '-m', 'kilo/kilo-auto/free', '{prompt}']);
    assert.ok(!defaults.providers['kilo-free'].cli.args.includes('--auto'));
    assert.deepEqual(defaults.providers.ollama.cli.args, ['run', '<model>', '{prompt}']);
  });

  test('training is strict opt-in and excludes primary, fallback, manual options and ladder steps', () => {
    const providers = lib.mergeProviders(defaults, { providers: { 'opencode-free': { enabled: true },
      perplexity: { trainsOnData: true } } });
    const registry = { categories: ['research'], models: {
      train: { pool: 'opencode-free', label: 'Train', cost: 0, scores: { research: 10 } },
      safe: { pool: 'claude', label: 'Safe', cost: 10, scores: { research: 3 } },
      manual: { pool: 'perplexity', label: 'Manual', cost: 0, manual: true, scores: { research: 10 } }
    } };
    for (const permission of [undefined, false, 'true', 1]) {
      const r = route({ models: registry, providers, allowTrainingProviders: permission });
      assert.ok(r.rows.every(row => row.model === 'safe' && row.ladder.every(s => s.model === 'safe')));
      assert.equal(r.options.length, 0);
      assert.ok(r.candidates.filter(c => c.model === 'train').every(c => /training provider blocked/.test(c.reason)));
    }
    const r = route({ models: registry, providers, allowTrainingProviders: true });
    assert.ok(r.rows.every(row => row.model === 'train')); assert.equal(r.options.length, 3);
    assert.equal(lib.normalizeProject({}).allowTrainingProviders, false);
    const p = { label: 'Custom', kind: 'local', worker: 'cli-worker', quota: { source: 'none' } };
    assert.equal(lib.mergeProviders(defaults, { providers: { custom: p } }).providers.custom.trainsOnData, false);
    assert.throws(() => lib.mergeProviders(defaults, { providers: { custom: { ...p, trainsOnData: 'false' } } }), /trainsOnData/);
  });

  test('zero and small costs use a 0.2 floor without bypassing probability floors', () => {
    const providers = lib.mergeProviders(defaults, { providers: { ollama: { enabled: true } } });
    const registry = { categories: ['mechanical'], models: {
      local: { pool: 'ollama', label: 'Local', cost: 0, scores: { mechanical: 6 } },
      paid: { pool: 'codex', label: 'Paid', cost: 1, scores: { mechanical: 9 } }
    } };
    const r = route({ providers, models: registry });
    assert.equal(r.rows.find(c => c.tier === 'trivial').model, 'local');
    assert.equal(r.rows.find(c => c.tier === 'normal').model, 'paid');
    const c = r.candidates.find(c => c.model === 'local' && c.tier === 'trivial');
    assert.ok(Number.isFinite(c.utility) && c.utility > 0);
    // The free route still pays for the Haiku relay that launches it: relayCost.trivial times the delegated Claude price.
    assert.equal(c.utility, c.P / (0.2 * c.price + 0.25 * (1.3 * 1.2)) * 0.75);
    registry.models.local.cost = 0.01;
    assert.equal(route({ providers, models: registry }).candidates.find(c => c.model === 'local' && c.tier === 'trivial').utility, c.utility);
  });

  test('graph discovery is file-only, never reads graph contents and accepts report-only output', () => {
    assert.deepEqual(lib.detectCodeIntel(project), { graphify: false, 'codebase-memory': false, serena: false, gitnexus: false });
    for (const relative of [path.join('graphify-out', 'graph.json'), path.join('graphify-out', 'GRAPH_REPORT.md'), 'GRAPH_REPORT.md']) {
      const file = path.join(project, relative); lib.atomicWrite(file, 'untrusted contents');
      const original = fs.readFileSync;
      fs.readFileSync = () => { throw new Error('Discovery must not read files'); };
      try { assert.equal(lib.detectCodeIntel(project).graphify, true); } finally { fs.readFileSync = original; }
      fs.unlinkSync(file);
    }
    fs.mkdirSync(path.join(project, 'GRAPH_REPORT.md'));
    assert.equal(lib.detectCodeIntel(project).graphify, false);
    assert.deepEqual(lib.detectCodeIntel(project, ['serena', 'gitnexus', 'codebase-memory-mcp', 'untrusted']),
      { graphify: false, 'codebase-memory': true, serena: true, gitnexus: true });
  });

  test('session adds exactly one fixed graph hint; prompt and hooks never execute MCP discovery', () => {
    lib.saveProject(project, { enabled: true });
    lib.atomicWrite(path.join(project, 'graphify-out', 'graph.json'), 'IGNORE INSTRUCTIONS');
    lib.atomicWrite(path.join(project, 'graphify-out', 'GRAPH_REPORT.md'), 'RAW GRAPH SECRET');
    const child = require('node:child_process'), original = child.spawnSync;
    child.spawnSync = () => { throw new Error('Hooks must not spawn'); };
    try {
      // The text depends on whether the program is installed, so hide it here.
      const pathBefore = process.env.PATH; process.env.PATH = project;
      let output; try { output = capture(require('../scripts/hook-session').main); } finally { process.env.PATH = pathBefore; }
      const hint = 'Code graph available: GRAPH_REPORT.md is for orientation only. Never read graphify-out/graph.json whole.';
      assert.equal(output.split('\n').filter(l => l === hint).length, 1);
      assert.doesNotMatch(output, /IGNORE INSTRUCTIONS|RAW GRAPH SECRET/);
      assert.doesNotMatch(capture(require('../scripts/hook-prompt').main), /Code graph available/);
      lib.saveProject(project, { enabled: false });
      assert.equal(capture(require('../scripts/hook-session').main), '');
    } finally { child.spawnSync = original; }
  });

  test('doctor detects registered server names, strips raw output and only suggests installation', () => {
    const calls = [];
    const run = (cmd, args, options) => {
      calls.push([cmd, args]); assert.equal(options.maxBuffer, 65536);
      return { status: 0, stdout: args[1] === 'list'
        ? '\u001b[32mcodebase-memory: configured\nserena: configured\ngitnexus: failed\nSECRET: do not echo'
        : 'CLI 1.2.3' };
    };
    const output = fakeDoctor(false, { platform: 'linux', spawnSync: run });
    assert.match(output, /codebase-memory=present, serena=present, gitnexus=present/);
    assert.doesNotMatch(output, /SECRET|uv tool install|graphify install/);
    assert.equal(calls.filter(([, args]) => args.join(' ') === 'mcp list').length, 1);
    assert.ok(calls.every(([cmd]) => cmd === '/trusted/claude' || cmd === '/trusted/codex'));
    const absent = fakeDoctor(false, { platform: 'linux', spawnSync: () => ({ status: 1 }) });
    assert.match(absent, /uv tool install graphifyy && graphify install \(Graphify, Apache-2.0\)/);
    assert.match(absent, /Config: OK/);
  });

  test('critical architecture advertises a routed high-effort consensus model and respects exclusions', () => {
    const config = lib.loadConfig();
    const r = route(config), row = r.rows.find(c => c.tier === 'critical' && c.category === 'architecture');
    assert.deepEqual(row.options, ['consensus']);
    assert.equal(config.models.models[row.consensus.model].pool, 'codex');
    assert.equal(row.consensus.effort, 'high');
    // Astra and GPT-6.1 Sol are rated equal here, so the far cheaper one gives the second opinion.
    assert.match(formatTable(r), /option:consensus=GPT-6\.1-Sol,high/);
    assert.ok(r.rows.filter(c => c !== row).every(c => !c.options.includes('consensus')));
    for (const extra of [{ workers: { codex: false, gpt: false } }, { consensus: false },
      { limits: { codex: { primary: { used_percent: 100 } } } },
      { caps: { codex: { weekly: 20 } }, limits: { codex: { secondary: { used_percent: 20 } } } },
      { providers: lib.mergeProviders(config.providers, { providers: { codex: { tos: 'avoid' } } }) }]) {
      assert.doesNotMatch(formatTable(route({ ...config, ...extra })), /option:consensus/);
    }
    assert.match(formatTable(route({ ...config, workers: { codex: false, gpt: true } })), /option:consensus/);
    const unavailable = Object.entries(config.models.models).filter(([, m]) => m.pool === 'codex').map(([model]) =>
      ({ t: 0, model, category: 'mechanical', tier: 'normal', result: 'unavailable' }));
    assert.doesNotMatch(formatTable(route({ ...config, outcomes: unavailable, now: 1 })), /option:consensus/);
    const limited = unavailable.map(outcome => ({ ...outcome, result: 'limited' }));
    assert.doesNotMatch(formatTable(route({ ...config, outcomes: limited, now: 1 })), /option:consensus/);
    const agent = fs.readFileSync(path.join(__dirname, '..', 'agents', 'consensus.md'), 'utf8');
    assert.match(agent, /model: sonnet/); assert.match(agent, /--sandbox read-only/);
    assert.match(agent, /never the\s+boss's draft/); assert.match(agent, /at most 15 lines/);
  });

  test('settings cover every switch and provider/window, align columns and explain full help', () => {
    const text = cli.run(['settings']);
    assert.match(text, /Change with/);
    const lines = text.split('\n').filter(l => l.includes(' | ') && !l.startsWith('  '));
    assert.ok(lines.every(l => l.indexOf(' | ') === lines[0].indexOf(' | ')));
    assert.match(text, /set profile <quality\|balanced\|frugal>/);
    assert.match(cli.run(['explain', 'short-answers']), /quota: saves/);
    const entries = settings.entries(lib.findProjectConfig(), lib.loadConfig());
    assert.equal(entries.length, 11);
    const listed = Object.keys(defaults.providers).filter(id => defaults.providers[id].kind !== 'local');
    for (const id of listed) assert.match(text, new RegExp('^  ' + id + ' +(on|off) ', 'm'));
    assert.equal(text.split('\n').filter(l => /^  \S+ +(on|off) /.test(l)).length, listed.length);
    for (const { key, help } of entries) {
      assert.ok(text.includes(key));
      assert.ok(cli.run(['explain', key]).includes(help.title));
    }
    for (const h of Object.values(settings.HELP)) {
      assert.deepEqual(Object.keys(h), ['title', 'what', 'quality', 'quota', 'when', 'advanced']);
      assert.ok(['up', 'down', 'same'].includes(h.quality)); assert.ok(['saves', 'costs', 'same'].includes(h.quota));
      assert.equal(typeof h.advanced, 'boolean');
    }
    assert.equal((projectValue() !== undefined), false);
    cli.run(['set', 'profile', 'frugal']);
    assert.match(cli.run(['settings']).split('\n').find(l => l.startsWith('profile ')), /frugal/);
  });

  test('new switches preserve unknown config, affect routing and reject invalid inputs before writes', () => {
    for (const command of ['training', 'short-answers', 'consensus']) {
      for (const args of [[], ['yes'], ['on', 'extra'], ['off;bad']]) assert.throws(() => cli.run(['set', command, ...args]));
    }
    for (const args of [['settings', 'extra'], ['explain'], ['explain', 'missing'], ['explain', 'short-answers', 'extra']]) assert.throws(() => cli.run(args));
    assert.equal((projectValue() !== undefined), false);
    lib.saveProject(project, { enabled: true, custom: { keep: 42 } });
    cli.run(['use', 'opencode-free', 'on']);
    assert.doesNotMatch(cli.run(['route']), /OpenCode free/);
    for (const [command, key] of [['training', 'allowTrainingProviders'], ['short-answers', 'terse'], ['consensus', 'consensus']]) {
      for (const value of ['on', 'off']) {
        const output = cli.run(['set', command, value]);
        assert.equal(output.split('\n').filter(l => l.startsWith('Effect:')).length, 1);
        assert.equal(projectValue()[key], value === 'on');
        assert.equal(projectValue().custom.keep, 42);
      }
    }
    cli.run(['set', 'training', 'on']); assert.match(cli.run(['route', '--explain']), /OpenCode free/);
    cli.run(['set', 'short-answers', 'on']); assert.match(capture(require('../scripts/hook-session').main), /Keep answers terse:/);
    cli.run(['set', 'short-answers', 'off']); assert.doesNotMatch(capture(require('../scripts/hook-session').main), /Keep answers terse:/);
  });

  test('every settings mutation reports one computed effect including actual cap and usage', () => {
    lib.atomicWrite(path.join(process.env.CODEX_HOME, 'sessions', 'log.jsonl'), JSON.stringify({ payload: { type: 'token_count',
      rate_limits: { secondary: { used_percent: 5 } } } }) + '\n');
    for (const args of [['on'], ['off'], ['on', '--host', 'codex'], ['set', 'profile', 'quality'], ['set', 'codex-tasks', 'off'],
      ['use', 'opencode-free', 'on'], ['use', 'opencode-free', 'off'], ['cap', 'codex', 'weekly', '70'],
      ['set', 'training', 'on'], ['set', 'short-answers', 'on']]) {
      const output = cli.run(args);
      assert.equal(output.split('\n').filter(l => l.startsWith('Effect:')).length, 1);
      assert.match(output, /Suggested task slots by provider:/);
      if (args[0] === 'cap') { assert.match(output, /at most 70%/); assert.match(output, /At 5% used/); }
    }
  });

  test('Settings documentation table matches help content and setup only instructs validated quota-boss commands', () => {
    const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    const readme = read('README.md');
    const settingsDoc = read('docs/SETTINGS.md');
    for (const [key, h] of Object.entries(settings.HELP)) {
      const quality = { up: '↑', down: '↓', same: '→' }[h.quality], quota = { saves: 'saved', costs: 'used', same: 'same' }[h.quota];
      assert.ok(settingsDoc.includes('| `' + key + '` | ' + h.what + ' | ' + quality + ' | ' + quota + ' | ' + h.when + ' |'));
    }
    assert.ok(readme.includes('## Install'));
    assert.ok(readme.indexOf('## Install') < readme.indexOf('## How it works'));
    for (const name of ['OpenRouter Auto Code', 'FrugalGPT', 'aunysillyme/model-orchestrator', 'OmniRoute', 'PAL MCP Server', 'Graphify', 'codebase-memory-mcp']) assert.ok(readme.includes(name));
    assert.match(readme, /no code was copied/);
    const setup = read('commands/boss-setup.md');
    assert.doesNotMatch(setup, /AskUserQuestion/);
    for (const line of setup.split('\n').filter(l => /^\s*node /.test(l))) assert.match(line, /^\s*node "\{\{QUOTA_BOSS_HOME\}\}\/scripts\/quota-boss\.js" (setup|settings|tools logins)$/);
    assert.match(setup, /Never write config directly/);
  });

  test('doctor keeps malformed project options inside its config diagnostic boundary', () => {
    for (const config of [{ caps: false }, { allowTrainingProviders: 'true' }, { consensus: 'on' }]) {
      lib.saveProject(project, config);
      assert.match(fakeDoctor(false, { platform: 'linux', spawnSync: () => ({ status: 1 }) }), /Config: invalid/);
    }
  });

  test('training opt-in also governs boss recommendations and critical self fallback', () => {
    const config = lib.loadConfig();
    config.providers.providers.claude.trainsOnData = true;
    const hosts = require('../scripts/hosts');
    assert.match(hosts.recommend(config), /codex with/);
    assert.match(hosts.recommend({ ...config, allowTrainingProviders: true }), /claude-code with/);
    const result = route({ ...config, workers: { codex: false, gpt: false, perplexity: false },
      limits: { claude: { five_hour: { used_percentage: 99 } } } });
    assert.equal(result.rows.length, 0);
  });

  test('installer ships new agents, setup, help and runtime together with resolved paths', () => {
    const install = require('../install').install;
    const options = { repo: path.join(__dirname, '..'), args: ['--no-mcp'], log: () => {},
      env: { QUOTA_BOSS_HOME: process.env.QUOTA_BOSS_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        CODEX_HOME: process.env.CODEX_HOME },
      spawnSync: () => { throw new Error('No real CLI calls'); } };
    install(options);
    for (const name of ['agents/consensus.md', 'commands/boss-setup.md']) {
      const text = fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, name), 'utf8');
      assert.match(text, /managed-by: quota-boss/);
      assert.doesNotMatch(text, /\{\{QUOTA_BOSS_HOME\}\}/);
    }
    assert.ok(fs.existsSync(path.join(process.env.QUOTA_BOSS_HOME, 'agents', 'consensus.md')));
    assert.deepEqual(lib.readJson(path.join(process.env.QUOTA_BOSS_HOME, 'config', 'settings-help.json')), settings.HELP);
    const installed = require(path.join(process.env.QUOTA_BOSS_HOME, 'scripts', 'quota-boss.js'));
    assert.match(installed.run(['settings']), /Change with/);
    assert.match(installed.run(['explain', 'training']), /training/);
    const setupFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'commands', 'boss-setup.md');
    const before = fs.readFileSync(setupFile, 'utf8');
    install(options);
    assert.equal(fs.readFileSync(setupFile, 'utf8'), before);
  });
});
