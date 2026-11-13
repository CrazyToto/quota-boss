'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const cli = require('../scripts/quota-boss');
const hosts = require('../scripts/hosts');
const diagnostics = require('../scripts/diagnostics');
const { route, formatTable } = require('../scripts/route');

function fakeDoctor(probe, options = {}) { return diagnostics.doctor(probe, { findExecutable: name => options.platform === 'win32' ? 'C:\\trusted\\' + name + '.cmd' : '/trusted/' + name, ...options }); }

test.describe('hosts and diagnostics', () => {
  let temporary, project, cwd, env, findExecutable;
  const projectFile = () => lib.getPaths().projectsFile;
  const projectValue = () => lib.readProjects()[lib.projectKey(project)];
  test.beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-hosts-'));
    project = path.join(temporary, 'project'); fs.mkdirSync(project);
    cwd = process.cwd();
    env = Object.fromEntries(['QUOTA_BOSS_HOME', 'HARNESS_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map(k => [k, process.env[k]]));
    process.env.QUOTA_BOSS_HOME = path.join(temporary, 'boss');
    process.env.CLAUDE_CONFIG_DIR = path.join(temporary, 'claude');
    process.env.CODEX_HOME = path.join(temporary, 'codex');
    process.chdir(project);
    findExecutable = lib.findExecutable; lib.findExecutable = () => '/trusted/cli';
  });
  test('doctor reports evidence state only for enabled docs providers', () => {
    lib.writeJson(path.join(lib.getPaths().quotaBossHome, 'config', 'providers.json'), { providers: { grok: { enabled: true } } });
    const options = { spawnSync: () => ({ status: 0, stdout: '' }) };
    assert.match(fakeDoctor(false, options), /grok: untested: quota-boss providers test grok/);
    const models = lib.loadConfig().models.models;
    const ids = Object.entries(models).filter(([, m]) => m.pool === 'grok' && m.enabled !== false).map(([id]) => id);
    lib.writeState({ selfTests: Object.fromEntries(ids.map(id => [id, { result: 'pass', at: 1 }])) });
    const report = fakeDoctor(false, options);
    assert.ok(report.includes('grok: self-test passed (' + ids.length + ' of ' + ids.length + ' models)'));
    assert.doesNotMatch(report, /antigravity: untested/);
    assert.match(cli.run(['providers']), /self-test passed/);
  });
  test('doctor resolves OpenCode model templates and omits unresolved defaults', () => {
    const offer = (model, defaultModel) => ({ enabled: true, cli: { command: 'opencode', args: ['run', '-m', model], defaultModel } });
    const providers = { template: offer('{model}', 'vendor/tiny'), unresolved: offer('{model}'), literal: offer('vendor/tiny') };
    assert.deepEqual(diagnostics.openCodeOffers(providers, () => ({ status: 0, stdout: 'vendor/tiny\n' })),
      ['OpenCode offer template: OK', 'OpenCode offer literal: OK']);
    assert.deepEqual(diagnostics.openCodeOffers({ unresolved: providers.unresolved }, () => assert.fail('must not call')), []);
  });
  test.afterEach(() => {
    lib.findExecutable = findExecutable;
    process.chdir(cwd);
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  test('home fallback remains but repository config is ignored', () => {
    process.env.HARNESS_HOME = path.join(temporary, 'old');
    assert.equal(lib.getPaths().quotaBossHome, process.env.QUOTA_BOSS_HOME);
    delete process.env.QUOTA_BOSS_HOME;
    assert.equal(lib.getPaths().quotaBossHome, process.env.HARNESS_HOME);
    delete process.env.HARNESS_HOME;
    assert.equal(lib.getPaths().quotaBossHome, path.join(process.env.CLAUDE_CONFIG_DIR, 'quota-boss'));
    const legacy = path.join(project, '.claude', 'harness.json');
    lib.writeJson(legacy, { enabled: true, profile: 'frugal', custom: 42 });
    assert.equal(lib.findProjectConfig().profile, 'balanced');
    cli.run(['on', '--host', 'generic']);
    assert.equal(projectValue().custom, undefined);
    assert.equal(lib.findProjectConfig().host, 'generic');
    assert.equal(lib.findProjectConfig().file, projectFile());
    assert.equal(lib.readJson(legacy).profile, 'frugal');
  });
  test('Codex block is idempotent, preserves exact outside bytes and is removed by off', () => {
    const file = path.join(project, 'AGENTS.md');
    const before = 'User rules\r\n\r\n', after = '\r\nKeep this suffix without a newline';
    fs.writeFileSync(file, before + hosts.START + '\nold block\n' + hosts.END + after);
    cli.run(['on', '--host', 'codex', 'quality']);
    const first = fs.readFileSync(file, 'utf8');
    assert.ok(first.startsWith(before + hosts.START)); assert.ok(first.endsWith(hosts.END + after));
    assert.match(first, /claude -p/); assert.match(first, /--output-format json/);
    assert.match(first, /usage claude 1 calls/); assert.match(first, /before delegating run node .*quota-boss.js.* route/);
    cli.run(['on', 'quality', '--host', 'codex']);
    assert.equal(fs.readFileSync(file, 'utf8'), first);
    assert.equal(first.split(hosts.START).length, 2);
    cli.run(['off']);
    assert.equal(fs.readFileSync(file, 'utf8'), before + after);
    cli.run(['off']); assert.equal(fs.readFileSync(file, 'utf8'), before + after);
    assert.equal(projectValue().enabled, false);
  });
  test('Codex creates the file, switching hosts removes its block, malformed markers are untouched', () => {
    const file = path.join(project, 'AGENTS.md');
    cli.run(['on', '--host', 'codex']); assert.match(fs.readFileSync(file, 'utf8'), /quota-boss:start/);
    cli.run(['on', '--host', 'claude-code']); assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, 'User\n' + hosts.START);
    const config = fs.readFileSync(projectFile(), 'utf8');
    assert.throws(() => cli.run(['on', '--host', 'codex']), /Malformed/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'User\n' + hosts.START);
    assert.equal(fs.readFileSync(projectFile(), 'utf8'), config);
  });
  test('Codex includes only effective workers, while generic always includes cli-worker', () => {
    const rules = () => cli.run(['rules', '--host', 'codex']);
    const check = (claude, cliWorker) => {
      const text = rules();
      assert.equal(/^name: claude-worker$/m.test(text), claude);
      assert.equal(/^name: cli-worker$/m.test(text), cliWorker);
      assert.equal(text.includes('Use claude-worker for Claude tasks'), claude);
      assert.equal(text.includes('cli-worker for other official CLIs'), cliWorker);
      assert.equal(text.includes('If a table row names'), !claude || !cliWorker);
      if (!claude || !cliWorker) assert.match(text, /rules --host codex and follow that worker's section/);
    };
    cli.run(['only', 'codex']); check(false, false);
    cli.run(['only', 'off']);
    cli.run(['use', 'claude', 'on']);
    cli.run(['only', 'claude', 'codex']); check(true, false);
    cli.run(['use', 'grok', 'on']);
    cli.run(['only', 'off']); check(true, true);
    cli.run(['use', 'claude', 'off', '--project']); check(false, true);
    cli.run(['only', 'codex', '--project']); check(false, false);
    cli.run(['only', 'off', '--project']);
    cli.run(['use', 'claude', 'on', '--project']); check(true, true);
    cli.run(['use', 'grok', 'off', '--project']);
    cli.run(['only', 'claude', 'codex', '--project']); check(true, false);
    const generic = hosts.rules('generic');
    cli.run(['use', 'claude', 'off']);
    assert.equal(hosts.rules('generic'), generic);
    assert.match(generic, /^name: cli-worker$/m);
    assert.doesNotMatch(generic, /If a table row names/);
  });
  test('missing Claude CLI leaves the final Codex block without Claude instructions', () => {
    lib.findExecutable = () => null;
    assert.match(cli.run(['on', '--host', 'codex']), /Claude CLI not found/);
    const text = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(text, /^name: claude-worker$/m);
    assert.equal(text, hosts.managedBlock(lib.findProjectConfig()));
  });
  test('switches refresh every enabled Codex project and skip malformed or missing projects', () => {
    cli.run(['on', '--host', 'codex']);
    const other = path.join(temporary, 'other'), broken = path.join(temporary, 'broken'), gone = path.join(temporary, 'gone');
    for (const directory of [other, broken, gone]) {
      fs.mkdirSync(directory);
      lib.saveProject(directory, { enabled: true, host: 'codex', managedAgents: true });
    }
    fs.writeFileSync(path.join(other, 'AGENTS.md'), 'Prefix\n' + hosts.managedBlock({}) + '\nSuffix');
    fs.writeFileSync(path.join(broken, 'AGENTS.md'), hosts.START);
    fs.rmdirSync(gone);
    cli.run(['use', 'claude', 'off']);
    const output = cli.run(['use', 'claude', 'on']);
    assert.match(output, /Note: Skipped AGENTS.md refresh.*Malformed/);
    assert.match(output, /Note: Skipped AGENTS.md refresh.*gone/);
    for (const directory of [project, other]) assert.match(fs.readFileSync(path.join(directory, 'AGENTS.md'), 'utf8'), /^name: claude-worker$/m);
    assert.ok(fs.readFileSync(path.join(other, 'AGENTS.md'), 'utf8').startsWith('Prefix\n'));
    assert.ok(fs.readFileSync(path.join(other, 'AGENTS.md'), 'utf8').endsWith('\nSuffix'));
    cli.run(['only', 'codex']);
    assert.doesNotMatch(fs.readFileSync(path.join(other, 'AGENTS.md'), 'utf8'), /^name: (claude|cli)-worker$/m);
    cli.run(['only', 'off']);
    cli.run(['local', 'on', 'tiny']);
    assert.match(fs.readFileSync(path.join(other, 'AGENTS.md'), 'utf8'), /^name: cli-worker$/m);
    cli.run(['local', 'off']);
    assert.doesNotMatch(fs.readFileSync(path.join(other, 'AGENTS.md'), 'utf8'), /^name: cli-worker$/m);
    fs.writeFileSync(path.join(other, 'AGENTS.md'), hosts.START + '\nstale\n' + hosts.END);
    cli.run(['use', 'gpt-6.1-sol', 'on']);
    assert.equal(fs.readFileSync(path.join(other, 'AGENTS.md'), 'utf8'), hosts.managedBlock(lib.findProjectConfig(other)));
    cli.run(['use', 'claude', 'off', '--project']);
    assert.doesNotMatch(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), /^name: claude-worker$/m);
    assert.match(fs.readFileSync(path.join(other, 'AGENTS.md'), 'utf8'), /^name: claude-worker$/m);
    assert.equal(fs.readFileSync(path.join(broken, 'AGENTS.md'), 'utf8'), hosts.START);
  });
  test('host CLI forms reject extra, missing, duplicate, and injected arguments before writes', () => {
    for (const args of [['on', '--host'], ['on', '--host', 'bad'], ['on', '--host', 'codex', '--host', 'codex'],
      ['on', '--host=codex'], ['on', 'balanced', 'quality'], ['rules'], ['rules', '--host', 'codex', 'x'],
      ['rules', '--host', 'codex;evil'], ['boss', 'x'], ['doctor', '--probe', '--probe'], ['doctor', '--bad'],
      ['stats', '--days', '0'], ['stats', '--days', '366'], ['stats', '--days', '1e2'], ['stats', '--days', '2', 'x']]) {
      assert.throws(() => cli.run(args), args.join(' '));
      assert.equal((projectValue() !== undefined), false);
      assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), false);
    }
  });
  test('rules support every host and terse adds exactly one fixed instruction', () => {
    lib.saveProject(project, { enabled: true, terse: true, host: 'codex' });
    for (const host of lib.HOSTS) {
      const text = cli.run(['rules', '--host', host]);
      assert.equal(text.split('Keep answers terse:').length, 2);
      assert.match(text, /^\[quota-boss\]/);
      if (host === 'generic') assert.match(text, /usage <provider> 1 calls/);
    }
    cli.run(['on', '--host', 'codex']);
    assert.match(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), /Keep answers terse:/);
    assert.equal(lib.normalizeProject({ host: 'inject\n', terse: 'true' }).host, 'claude-code');
    assert.equal(lib.normalizeProject({ terse: 'true' }).terse, false);
  });
  test('Claude hooks stay silent for Codex and generic hosts', () => {
    const original = {input:lib.readInput,out:process.stdout.write}; let output='';
    lib.readInput = () => ({cwd:project,session_id:'host-test'});
    process.stdout.write = chunk => {output+=chunk;return true;};
    try {
      for (const host of ['codex','generic']) {
        lib.saveProject(project,{enabled:true,host});
        require('../scripts/hook-session').main();require('../scripts/hook-prompt').main();
      }
    } finally {lib.readInput=original.input;process.stdout.write=original.out;}
    assert.equal(output,'');assert.equal(fs.existsSync(lib.getPaths().stateFile),false);
  });
  test('boss scores host-capable enabled models and breaks ties on cost', () => {
    assert.match(cli.run(['boss']), /claude-code with Opus 5.5 .*boss score 10.0/);
    const config = lib.loadConfig();
    config.models.models = {
      expensive: { pool: 'claude', label: 'Expensive', cost: 10, scores: { architecture: 8, review: 8 } },
      cheap: { pool: 'codex', label: 'Cheap\n<script>', cost: 2, scores: { architecture: 8, review: 8 } }
    };
    assert.match(hosts.recommend(config), /codex with Cheapscript .*boss score 8.0/);
    const start = Date.UTC(2026, 0, 1), limited = [{ t: start, model: 'cheap', category: 'review', tier: 'normal', result: 'limited' }];
    assert.match(hosts.recommend(config, limited, start + 60000), /claude-code with Expensive/);
    config.providers.providers.codex.tos = 'avoid';
    assert.match(hosts.recommend(config), /claude-code/);
    config.providers.providers.claude.enabled = false;
    assert.match(hosts.recommend(config), /No enabled provider/);
  });
  test('a boss within half a point of the best wins on price, and the other host is named too', () => {
    const config = lib.loadConfig();
    config.models.models = {
      astra: { pool: 'codex', label: 'Astra', cost: 32, scores: { architecture: 9, review: 9 } },
      sol: { pool: 'codex', label: 'Sol', cost: 5, scores: { architecture: 9, review: 8 } },
      opus: { pool: 'claude', label: 'Opus', cost: 10, scores: { architecture: 10, review: 10 } },
      sonnet: { pool: 'claude', label: 'Sonnet', cost: 5, scores: { architecture: 8, review: 8 } }
    };
    const text = hosts.recommend(config);
    assert.match(text, /^claude-code with Opus \(opus, boss score 10\.0, cost 10\)/);
    assert.match(text, /other host: codex with Sol \(sol, boss score 8\.6, cost 5\)/);
    config.providers.providers.claude.enabled = false;
    assert.doesNotMatch(hosts.recommend(config), /other host/);
  });
  test('doctor without probe runs only fixed local checks and never echoes CLI output or credentials', () => {
    const calls = [];
    lib.writeJson(path.join(process.env.CODEX_HOME, 'models_cache.json'), { client_version: '0.120.0' });
    const output = fakeDoctor(false, { platform: "linux", spawnSync: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0, stdout: cmd + ' 0.100.0\nSECRET_TOKEN=never-print', stderr: 'credential-secret' };
    } });
    assert.deepEqual(calls.map(c => [c.cmd, c.args]), [['/trusted/claude', ['--version']], ['/trusted/codex', ['--version']], ['/trusted/claude', ['mcp', 'get', 'codex']], ['/trusted/claude', ['mcp', 'list']]]);
    assert.ok(calls.every(c => c.options.shell === false));
    assert.match(output, /update Codex CLI/); assert.match(output, /Config: OK/); assert.match(output, /Probes skipped/);
    assert.doesNotMatch(output, /SECRET|credential-secret/);
    assert.equal(fs.existsSync(lib.getPaths().outcomesFile), false);
    lib.atomicWrite(path.join(lib.getPaths().quotaBossHome, 'config', 'models.json'), '{bad');
    assert.match(fakeDoctor(false, { platform: "linux", spawnSync: () => ({ status: null }) }), /Config: invalid/);
  });
  test('doctor CLI uses fakes, validates config details and never probes by default', () => {
    const child = require('node:child_process'), original = child.spawnSync;
    const calls = [];
    child.spawnSync = (cmd, args) => { calls.push(args); return {status:0,stdout:cmd + ' 1.2.3'}; };
    lib.writeJson(path.join(lib.getPaths().quotaBossHome, 'install-manifest.json'), {version:1,home:lib.getPaths().quotaBossHome});
    try {
      assert.match(cli.run(['doctor']), /Install manifest: OK/);
      assert.ok(calls.every(args => args[0] !== 'exec'));
      for (const config of [{enabled:'true'}, {host:'evil'}, {workers:[]}, {workers:{codex:'yes'}}, {terse:1}]) {
        lib.saveProject(project,config); assert.match(cli.run(['doctor']),/Config: invalid/);
      }
      lib.saveProject(project,{enabled:true});
      lib.writeJson(path.join(lib.getPaths().quotaBossHome,'config','models.json'),{models:{invalid:{pool:'codex',label:'Bad',cost:1,scores:{review:'inject'}}}});
      assert.match(cli.run(['doctor']),/Config: invalid/);
    } finally {child.spawnSync=original;}
  });
  test('probe uses exact argument arrays and timeout, records unavailable for failed or missing CLIs', () => {
    const calls = [];
    const output = fakeDoctor(true, { platform: "linux", spawnSync: (cmd, args, options) => {
      if (args[0] !== 'exec') return { status: 0, stdout: cmd + ' 1.0.0' };
      calls.push({ cmd, args, options });
      if (args[2] === 'gpt-6.1-sol') return { status: 0, stdout: 'OK\n' };
      return { status: null, error: new Error('SECRET CREDENTIAL') };
    } });
    const rated = Object.entries(lib.loadConfig().models.models).filter(([,m]) => m.pool === 'codex').length;
    assert.equal(calls.length, rated);
    for (const call of calls) {
      assert.equal(call.cmd, '/trusted/codex'); assert.equal(call.options.timeout, 90000); assert.equal(call.options.shell, false);
      assert.deepEqual(call.args, ['exec', '-m', call.args[2], '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', 'Reply with exactly: OK']);
    }
    assert.equal(lib.readOutcomes().length, rated - 1);
    assert.ok(lib.readOutcomes().every(o => o.result === 'unavailable' && o.model !== 'gpt-6.1-sol'));
    assert.doesNotMatch(output, /SECRET|CREDENTIAL/);
  });
  test('stats filters by days, reports provider/model split, pass rates and counters', () => {
    const now = Date.now(), models = lib.loadConfig().models;
    for (const [result, t] of [['pass', now - 1000], ['fail', now - 2000], ['unavailable', now - 3000], ['pass', now - 40 * 86400000]]) {
      lib.appendOutcome({ model: 'gpt-6.1-sol', category: 'review', tier: 'normal', result }, models, [], t);
    }
    lib.appendUsage('claude', 2, 'calls', lib.loadProviders(), now - 1000);
    const output = diagnostics.stats(30, now);
    assert.match(output, /provider codex: 3 \(100.0%\)/); assert.match(output, /model gpt-6.1-sol: 3/);
    assert.match(output, /review: 50.0% pass=1 fail=1 unavailable=1/); assert.match(output, /claude calls: 2/);
    assert.match(cli.run(['stats', '--days', '1']), /Stats: last 1 days/);
  });
  test('avoid never enters automatic routes or ladders; invalid tos is rejected', () => {
    const config = lib.loadConfig(); config.providers.providers.claude.tos = 'avoid';
    const result = route({ ...config });
    assert.ok(result.rows.length);
    assert.ok(result.rows.every(r => r.pool !== 'claude' && r.ladder.every(s => s.pool !== 'claude')));
    config.providers.providers.claude.tos = 'bad'; assert.throws(() => route(config), /tos/);
  });
  test('Codex host delegates Claude through claude-worker, generic uses cli-worker only', () => {
    const config = lib.loadConfig();
    const result = route({ ...config, host: 'codex', limits: { codex: { primary: { used_percent: 85 } } } });
    assert.ok(result.candidates.filter(c => c.pool === 'claude' && c.model !== 'claude-fable-5-2').every(c => c.via === 'claude-worker'));
    const codex = result.candidates.filter(c => c.pool === 'codex');
    assert.ok(codex.filter(c => c.model === 'gpt-6.1-sol').every(c => c.via === 'self'), 'an unknown boss is assumed to run the cheap near-best model');
    assert.ok(codex.filter(c => c.model !== 'gpt-6.1-sol').every(c => c.via === 'codex-subagent'));
    assert.match(formatTable(result), /claude-worker/);
    config.providers.providers.grok.enabled = true;
    config.models.models.grok = { pool: 'grok', label: 'Grok', cost: 1, scores: { implementation: 8 } };
    const generic = route({ ...config, host: 'generic', selfTests: { grok: { result: 'pass' } } });
    assert.ok(generic.rows.length); assert.ok(generic.rows.every(r => r.via === 'cli-worker:grok'));
    const saving = route({ ...config, limits: { claude: { five_hour: { used_percentage: 60 } } } });
    assert.ok(saving.rows.every(r => r.pool !== 'claude' || r.via === 'self'));
  });
  test('Codex host uses Claude counters unless live status data is fresh', () => {
    const project = { host: 'codex' };
    let providers = lib.loadProviders(project);
    assert.equal(providers.providers.claude.quota.source, 'counter');
    lib.appendUsage('claude', 1, 'calls', providers);
    assert.equal(lib.readProviderLimits(providers).claude.windows.daily.counted, 1);
    lib.writeState({ claude: { updated_at: Date.now(), five_hour: { used_percentage: 5 } } });
    providers = lib.loadProviders(project);
    assert.equal(providers.providers.claude.quota.source, 'claude-statusline');
    lib.appendUsage('claude', 1, 'calls', providers);
    lib.updateState(() => ({ claude: { updated_at: Date.now() - 1800000 } }));
    assert.equal(lib.loadProviders(project).providers.claude.quota.source, 'counter');
  });
  test('Codex on installs once, inherited on repairs hooks, off keeps hook, doctor reports missing as info', () => {
    fs.mkdirSync(process.env.CODEX_HOME);
    const first = cli.run(['on', '--host', 'codex']);
    assert.match(first, /type \/hooks/);
    assert.doesNotMatch(cli.run(['on']), /\/hooks/);
    const file = path.join(process.env.CODEX_HOME, 'hooks.json');
    const bytes = fs.readFileSync(file, 'utf8');
    cli.run(['off']);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    cli.run(['on']);
    const options = { spawnSync: () => ({ status: 0, stdout: '' }) };
    assert.doesNotMatch(fakeDoctor(false, options), /Info: Quota Boss SessionStart hook/);
    fs.unlinkSync(file);
    assert.match(fakeDoctor(false, options), /Info: Quota Boss SessionStart hook.*quota-boss on --host codex/);
    assert.match(cli.run(['on']), /type \/hooks/);
    fs.writeFileSync(file, '{bad');
    assert.match(cli.run(['on']), /Note: Could not install Codex SessionStart hook/);
    assert.equal(lib.findProjectConfig().enabled, true);
    assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
  });
});

test('doctor on win32 starts absolute npm shims through absolute cmd.exe without shell lookup', () => {
  const calls = [];
  fakeDoctor(false, { platform: 'win32', spawnSync: (command, args, options) => {
    calls.push({command, args, options}); return { status: 1, stdout: '' };
  } });
  assert.ok(calls.length >= 2);
  for (const call of calls) {
    assert.match(call.command, /[\\/]System32[\\/]cmd\.exe$/i);
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(call.args[3], /C:\\trusted\\(?:claude|codex|opencode)\.cmd/);
  }
});

test('codex rules keep the work with the boss when route cannot run', () => {
  const text = hosts.rules('codex');
  assert.match(text, /launch is refused .* run the same command once more with another shell, on Windows C:\\Windows\\System32\\cmd\.exe/);
  assert.match(text, /If route still cannot run .* do the work yourself and spawn no subagents/);
  assert.match(text, /Never spawn a subagent on your own model at the same or a higher effort/);
  assert.doesNotMatch(hosts.rules('generic'), /If route still cannot run|another shell/);
});
