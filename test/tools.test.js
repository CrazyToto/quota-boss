'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const tools = require('../scripts/tools');
const { offerTools } = require('../install');

const config = enabled => ({ providers: { providers: Object.fromEntries(Object.keys(tools.REGISTRY).map(id => [id, { enabled: enabled.includes(id) }])) } });

/** A fake machine: `have` maps binaries to versions, `latest` maps npm packages to their newest version. */
function machine({ have = {}, latest = {}, failInstall = [], installs = {}, status = {} }) {
  const calls = [];
  const state = { ...have };
  const find = name => (name in state ? '/bin/' + name : null);
  const spawnSync = (file, args) => {
    const name = file.split('/').pop();
    calls.push([name, ...args]);
    if (name === 'npm' && args[0] === 'view') return { status: 0, stdout: (latest[args[1]] || '') + '\n' };
    if (args[0] === '--version') return { status: 0, stdout: 'tool ' + state[name] + '\n' };
    if (args[0] === 'install' || args[0] === 'tool') {
      const pkg = args.find(a => /^(@openai|opencode-ai|graphifyy|Ollama)/.test(a)) || '';
      if (failInstall.some(p => pkg.startsWith(p))) return { status: 1, stdout: '', stderr: 'npm error\nEACCES: permission denied\n' };
      for (const [binary, value] of Object.entries(installs)) if (pkg.includes(value.match)) state[binary] = value.version;
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: status[name] || '', stderr: '' };
  };
  return { calls, options: { platform: 'linux', env: {}, find, spawnSync } };
}

test('registry only holds fixed commands, and no entry runs through a shell', () => {
  for (const tool of Object.values(tools.REGISTRY)) {
    for (const route of Object.values(tool.install)) {
      assert.match(route.manager, /^(npm|uv|winget|brew)$/);
      assert.ok(route.args.every(arg => !/[|&;<>$`]/.test(arg)));
    }
    assert.match(tool.source, /^https:\/\//);
  }
  assert.ok(!JSON.stringify(tools.REGISTRY.grok.install).includes('curl'));
});

test('check reports missing, outdated and current tools in one list', () => {
  const m = machine({ have: { npm: '11.0.0', codex: '0.100.0', claude: '2.0.0' }, latest: { '@openai/codex': '0.167.0' } });
  const items = tools.check(['codex', 'claude', 'opencode'], m.options);
  assert.deepEqual(items.map(i => i.state), ['outdated', 'ok', 'missing']);
  assert.deepEqual(tools.installable(items).map(i => i.id), ['codex', 'opencode']);
  const text = tools.report(items);
  assert.match(text, /codex: outdated \(0\.100\.0 -> 0\.167\.0\) \| npm install -g @openai\/codex@latest --registry=https:\/\/registry\.npmjs\.org\/ \| https:/);
  assert.match(text, /Installable: codex opencode/);
  assert.ok(!m.calls.some(c => c[0] === 'npm' && c[2] === '@anthropic-ai/claude-code'), 'Claude updates itself');
});

test('tools without a usable package manager or package become manual steps', () => {
  const m = machine({ have: {} });
  const [graphify, grok, ollama] = tools.check(['graphify', 'grok', 'ollama'], m.options);
  assert.equal(graphify.state, 'manual');
  assert.match(graphify.note, /needs uv/);
  assert.equal(grok.state, 'manual');
  assert.equal(ollama.state, 'manual');
  assert.match(tools.report([grok]), /install by hand: https:\/\/github\.com\/xai-org\/grok-build/);
  assert.match(grok.note, /curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash/);
  assert.match(tools.report([grok]), /Installable: \(none\)/);
  const windows = tools.check(['grok'], { ...m.options, platform: 'win32' })[0];
  assert.match(windows.note, /irm https:\/\/x\.ai\/cli\/install\.ps1 \| iex/);
});

test('paste install uses the registry script as one argument after approval and display', () => {
  for (const [platform, shell, binary, argv] of [
    ['linux', 'bash', '/bin/bash', ['-c', 'set -o pipefail; curl -fsSL https://x.ai/cli/install.sh | bash']],
    ['win32', 'powershell', 'C:\\bin\\powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://x.ai/cli/install.ps1 | iex']],
  ]) {
    const events = [];
    const options = { platform, find: name => name === shell ? binary : null,
      spawnSync: (file, args, opts) => { events.push([file, args, opts.shell]); return { status: 0 }; },
      say: command => events.push(command) };
    assert.match(tools.install(['grok'], options), /skipped/);
    assert.deepEqual(events, []);
    assert.equal(tools.check(['grok'], { ...options, scripts: true })[0].state, 'missing');
    tools.install(['grok'], { ...options, approved: true });
    assert.deepEqual(events, [shell + ' ' + argv.slice(0, -1).join(' ') + ' "' + argv.at(-1) + '"', [binary, argv, false]]);
  }
});

test('activation runs a vendor install script only after a yes unless an earlier question already asked', () => {
  for (const [confirmed, answer, runs] of [[false, 'n', false], [false, '', false], [false, 'y', true], [true, null, true]]) {
    const events = [], asked = [];
    const options = { platform: 'linux', find: name => name === 'bash' ? '/bin/bash' : null,
      spawnSync: (file, args) => { events.push([file, args]); return { status: 0 }; } };
    const said = [];
    tools.activate('grok', { say: line => said.push(line), options, confirmed, test: () => {}, verified: () => false,
      ask: question => { asked.push(question); return answer; } });
    assert.equal(asked.length, confirmed ? 0 : 1);
    assert.equal(events.some(([file]) => file === '/bin/bash'), runs);
    if (!runs) assert.ok(said.includes('Install cancelled.'));
  }
});

test('Windows activation polls for a Junie login for at most five minutes', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-junie-wait-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = path.join(home, '.junie', 'dpapi_credentials');
  fs.mkdirSync(store, { recursive: true });
  for (const finish of [false, true]) {
    const messages = [];
    let waited = 0, launches = 0, tests = 0;
    const options = { platform: 'win32', home,
      find: name => name === 'junie' ? 'C:\\bin\\junie.exe' : null,
      wait: ms => { waited += ms; if (finish && waited === 2000) fs.writeFileSync(path.join(store, 'credential'), 'saved'); },
      spawnSync: (_file, args) => {
        if (args[0] === '--version') return { status: 0, stdout: '1.0.0' };
        launches++;
        assert.match(args.at(-1), /start "Quota Boss login" "C:/);
        assert.doesNotMatch(args.at(-1), /\/wait/);
        return { status: 0 };
      } };
    tools.activate('junie', { options, say: line => messages.push(line), test: () => tests++, verified: () => false });
    assert.equal(launches, 1);
    assert.equal(waited, finish ? 2000 : 300000);
    assert.equal(tests, finish ? 1 : 0);
    assert.equal(messages.some(line => line.startsWith('Login timed out:')), !finish);
  }
});

test('a missing package manager joins the same consent list and needs one more pass when PATH is stale', () => {
  const m = machine({ have: { winget: '1.0.0' } });
  m.options.platform = 'win32';
  const [graphify] = tools.check(['graphify'], m.options);
  assert.equal(graphify.state, 'missing');
  assert.match(graphify.command, /^winget install --id astral-sh\.uv .* && uv tool install --default-index https:\/\/pypi\.org\/simple graphifyy && graphify install$/);
  m.options.find = name => (name === 'winget' ? 'C:\\bin\\winget.exe' : null);
  m.options.spawnSync = () => ({ status: 0, stdout: '', stderr: '' });
  assert.match(tools.install(['graphify'], m.options), /uv installed; open a new terminal/);
});

test('a binary that does not start is offered for repair and never reported as healthy', () => {
  const m = machine({ have: { npm: '11.0.0', codex: '1.0.0' } });
  const fail = m.options.spawnSync;
  m.options.spawnSync = (file, args, o) => (args[0] === '--version' ? { status: 1, stdout: '', stderr: 'boom' } : fail(file, args, o));
  const [codex] = tools.check(['codex'], m.options);
  assert.equal(codex.state, 'broken');
  assert.deepEqual(tools.installable([codex]).map(i => i.id), ['codex']);
  assert.match(tools.install(['codex'], m.options), /codex: FAILED \(installed but does not start\)/);
});

test('a placeholder that exits 127 counts as missing', () => {
  const m = machine({ have: { npm: '11.0.0', copilot: '0' } });
  const fake = m.options.spawnSync;
  m.options.spawnSync = (file, args, o) => (args[0] === '--version' ? { status: 127, stdout: '', stderr: 'not found' } : fake(file, args, o));
  assert.equal(tools.check(['copilot'], m.options)[0].state, 'missing');
});

test('package manager overrides from the environment are removed', () => {
  const kept = tools.managerEnv({ PATH: '/bin', NPM_CONFIG_USERCONFIG: 'x', npm_config_registry: 'x', UV_DEFAULT_INDEX: 'x', UV_INDEX_URL: 'x', UV_EXTRA_INDEX_URL: 'x', HTTPS_PROXY: 'p' });
  assert.deepEqual(Object.keys(kept).sort(), ['HTTPS_PROXY', 'PATH']);
});

test('winget is trusted only when its alias points at Microsoft\'s app folder', () => {
  assert.equal(tools.isWingetTarget('C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe\\winget.exe'), true);
  assert.equal(tools.isWingetTarget('C:\\checkout\\winget.exe'), false);
  assert.equal(tools.isWingetTarget('C:\\Program Files\\WindowsApps\\Evil.App_1.0_x64__abcdefghijklm\\winget.exe'), false);
});

test('every API added through OpenCode needs the one OpenCode CLI', () => {
  const ids = tools.enabledIds({ providers: { providers: { groq: { cli: { command: 'opencode' } }, acme: { cli: { command: 'opencode' } }, off: { enabled: false, cli: { command: 'opencode' } } } } });
  assert.deepEqual(ids, ['opencode']);
});

test('Kilo resolves to its own npm CLI and needs no login', () => {
  const ids = tools.enabledIds({ providers: { providers: { custom: { cli: { command: 'kilo' } }, 'kilo-free': { enabled: true } } } });
  assert.deepEqual(ids, ['kilo-free']);
  const tool = tools.REGISTRY['kilo-free'];
  assert.equal(tool.binary, 'kilo');
  assert.equal(tool.login, undefined);
  assert.deepEqual(tool.install.all.args.slice(0, 3), ['install', '-g', '@kilocode/cli@latest']);
  const m = machine({ have: { npm: '11.0.0', kilo: '1.0.0' } });
  assert.equal(tools.pendingLogins(['kilo-free'], m.options).length, 0);
  assert.equal(tools.logins(['kilo-free'], m.options), 'No logins to check.');
});

test('install runs only needed tools, continues after a failure and reports each one', () => {
  const m = machine({ have: { npm: '11.0.0', claude: '2.0.0' }, failInstall: ['@openai'],
    latest: { 'opencode-ai': '1.19.5' }, installs: { opencode: { match: 'opencode-ai', version: '1.19.5' } } });
  const out = tools.install(['codex', 'opencode', 'claude'], m.options).split('\n');
  assert.match(out[0], /codex: FAILED \(EACCES: permission denied\)/);
  assert.equal(out[1], '- opencode: installed (1.19.5)');
  assert.equal(out[2], '- claude: skipped (ok)');
  assert.equal(m.calls.filter(c => c[0] === 'npm' && c[1] === 'install').length, 2);
});

test('install says so when an older copy still wins on PATH', () => {
  const m = machine({ have: { npm: '11.0.0', codex: '0.100.0' }, latest: { '@openai/codex': '0.167.0' } });
  assert.match(tools.install(['codex'], m.options), /older copy still comes first on PATH/);
});

test('logins distinguish logged in, logged out, optional and missing tools', () => {
  const m = machine({ have: { codex: '1.0.0', claude: '2.0.0', opencode: '1.0.0' },
    status: { codex: 'Logged in using ChatGPT\n', claude: '{ "loggedIn": false }' } });
  const out = tools.logins(['codex', 'claude', 'opencode'], m.options).split('\n');
  assert.equal(out[0], '- codex: logged in');
  assert.equal(out[1], '- claude: NOT logged in, run: claude auth login');
  assert.match(out[2], /opencode: cannot be checked automatically; only if needed, run: opencode auth login/);
  assert.equal(out.length, 3);
});

test('a failed login check is never reported as logged in', () => {
  const m = machine({ have: { codex: '1.0.0' } });
  m.options.spawnSync = () => ({ status: 1, stdout: 'Logged in using ChatGPT', stderr: '' });
  assert.match(tools.logins(['codex'], m.options), /NOT logged in/);
  m.options.spawnSync = () => ({ status: null, error: new Error('timeout') });
  assert.match(tools.logins(['codex'], m.options), /could not check/);
  m.options.spawnSync = () => ({ status: 0, stdout: 'API key configured\n', stderr: '' });
  assert.match(tools.logins(['codex'], m.options), /codex: logged in/);
});

test('the command accepts enabled providers only, before anything runs', () => {
  const m = machine({ have: { npm: '11.0.0' } });
  assert.throws(() => tools.command(['install', 'ollama'], config(['codex']), m.options), /enabled providers/);
  assert.throws(() => tools.command(['install', '@evil/pkg'], config(['codex']), m.options), /enabled providers/);
  assert.throws(() => tools.command(['install'], config(['codex']), m.options), /Usage/);
  assert.equal(m.calls.length, 0);
  assert.match(tools.command([], config(['codex']), m.options), /codex: missing/);
});

test('winget from a relative LOCALAPPDATA is never used', () => {
  const options = { platform: 'win32', env: { LOCALAPPDATA: 'relative\\path', PATH: '' }, spawnSync: () => assert.fail('must not run') };
  const [ollama] = tools.check(['ollama'], options);
  assert.equal(ollama.state, 'manual');
  assert.match(ollama.note, /needs winget/);
});

test('installer asks once for everything and installs nothing without a yes', () => {
  const run = answer => {
    const m = machine({ have: { npm: '11.0.0' }, installs: { codex: { match: '@openai', version: '1.0.0' } } });
    const asked = [], said = [];
    offerTools({ ask: q => { asked.push(q); return answer; }, say: t => said.push(t), interactive: true, options: m.options, config: config(['codex', 'opencode']) });
    return { asked, said: said.join('\n'), installs: m.calls.filter(c => c[0] === 'npm' && c[1] === 'install').length };
  };
  const no = run('');
  assert.equal(no.asked.length, 1);
  assert.match(no.asked[0], /codex, opencode/);
  assert.equal(no.installs, 0);
  assert.match(no.said, /Nothing installed/);
  assert.equal(run('y').installs, 2);
});

test('installer without a terminal only prints a hint', () => {
  const m = machine({ have: { npm: '11.0.0' } });
  const said = [];
  offerTools({ ask: () => assert.fail('must not ask'), say: t => said.push(t), interactive: false, options: m.options, config: config(['codex']) });
  assert.equal(m.calls.length, 0);
  assert.equal(said.length, 0);
  offerTools({ interactive: false, say: t => said.push(t), options: { find: () => '/bin/claude' } });
  assert.match(said[0], /boss-setup/);
});

test('a winget link counts only with its exact package target', () => {
  const home = 'C:\\Users\\me\\AppData\\Local';
  const good = home + '\\Microsoft\\WinGet\\Packages\\astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe\\uv.exe';
  assert.equal(tools.isWingetPackageTarget('uv', good, home), true);
  assert.equal(tools.isWingetPackageTarget('uv', good.replace('astral-sh.uv', 'evil.uv'), home), false);
  assert.equal(tools.isWingetPackageTarget('uv', 'C:\\Temp\\uv.exe', home), false);
  assert.equal(tools.isWingetPackageTarget('node', good, home), false);
});

test('copilot counts as logged in from one status field, and nothing else leaves the file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-copilot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { platform: 'linux', env: { COPILOT_HOME: dir }, find: name => '/bin/' + name, spawnSync: () => ({ status: 0, stdout: '' }) };
  const before = tools.pendingLogins(['copilot'], options);
  assert.equal(before.length, 1);
  assert.equal(before[0].checkable, true);
  assert.equal(before[0].command, 'copilot login');
  fs.writeFileSync(path.join(dir, 'config.json'), '// note\n{ "loggedInUsers": [{ "login": "someone" }], "copilotTokens": { "x": "SECRET" } }');
  assert.deepEqual(tools.pendingLogins(['copilot'], options), []);
  assert.equal(tools.logins(['copilot'], options), '- copilot: logged in');
});

test('on Windows a login opens its own window and waits, and unsafe text is refused', () => {
  const calls = [];
  const spawnSync = (file, args, opts) => { calls.push({ file, args, opts }); return { status: 0 }; };
  const options = { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, find: () => 'C:\\tools\\copilot.cmd', spawnSync };
  tools.runLogin('copilot', options);
  const line = calls[0].args.join(' ');
  assert.ok(line.includes('start "Quota Boss login" /wait'), line);
  assert.ok(line.includes('/d /c ""C:\\tools\\copilot.cmd" "login""'), line);
  assert.equal(calls[0].opts.windowsVerbatimArguments, true);
  assert.ok(lib.runInNewWindow('C:\\tools\\a.exe', ['x&calc'], { spawnSync }).error);
  assert.equal(calls.length, 1);
});

test('stored OpenCode keys are lowercased and ANSI-free', () => {
  const options = {
    platform: 'linux', env: {}, find: name => name === 'opencode' ? '/bin/opencode' : null,
    spawnSync: () => ({ status: 0, stdout: '\x1b[32mMistral\x1b[0m\nGoogle\n', stderr: '' }),
  };
  assert.equal(tools.storedKeys(options), 'mistral\ngoogle\n');
});

test('key login validates provider ids and passes the provider flag', () => {
  const calls = [];
  const options = { platform: 'linux', env: {}, find: () => '/bin/opencode',
    spawnSync: (file, args) => { calls.push([file, args]); return { status: 0 }; } };
  assert.throws(() => tools.runKeyLogin('-x', options), /provider/);
  assert.throws(() => tools.runKeyLogin('a b', options), /provider/);
  tools.runKeyLogin('mistral', options);
  assert.deepEqual(calls[0][1], ['auth', 'login', '-p', 'mistral']);
});

test('key pages reject unsafe URLs and use rundll32 on Windows', () => {
  const calls = [];
  const options = { platform: 'win32', env: {}, find: name => name === 'rundll32' ? 'C:\\Windows\\rundll32.exe' : null,
    spawnSync: (file, args) => { calls.push([file, args]); return { status: 0 }; } };
  assert.equal(tools.openPage('http://example.com/key', options), false);
  assert.equal(tools.openPage('https://example.com/" key', options), false);
  assert.equal(tools.openPage('https://example.com/key', options), true);
  assert.deepEqual(calls[0][1], ['url.dll,FileProtocolHandler', 'https://example.com/key']);
  const issue = 'https://github.com/CrazyToto/quota-boss/issues/new?template=provider_report.md&title=Provider%20report&body=a%0Ab';
  assert.equal(tools.openPage(issue, options), true);
  assert.deepEqual(calls.at(-1)[1], ['url.dll,FileProtocolHandler', issue]);
  for (const bad of ['https://example.com/x?a=1', 'https://github.com/a/b/issues/new?body=a b', 'https://github.com/a/b/issues/new?x="&calc',
    'https://github.com/a/b/issues/new?' + 'a'.repeat(7001)]) assert.equal(tools.openPage(bad, options), false);
});

test('Graphify installs under its official package name and registers its skill, with no shell', () => {
  const calls = [];
  let installed = false;
  const find = name => (name === 'uv' || (name === 'graphify' && installed) ? '/bin/' + name : null);
  const spawnSync = (file, args) => { calls.push([file.split('/').pop(), ...args]); if (args[0] === 'tool') installed = true; return { status: 0, stdout: '', stderr: '' }; };
  const options = { platform: 'linux', env: {}, find, spawnSync };
  const item = tools.check(['graphify'], options)[0];
  assert.equal(item.state, 'missing');
  assert.match(item.command, /graphifyy && graphify install$/);
  assert.equal(tools.install(['graphify'], options), '- graphify: installed (version unknown)');
  assert.deepEqual(calls[0].slice(0, 3), ['uv', 'tool', 'install']);
  assert.ok(calls[0].includes('graphifyy'));
  assert.deepEqual(calls[1], ['graphify', 'install']);
});

test('a failed Graphify setup step is reported, and the provider commands cannot install it', () => {
  let installed = false;
  const find = name => (name === 'uv' || (name === 'graphify' && installed) ? '/bin/' + name : null);
  const spawnSync = (file, args) => { if (args[0] === 'tool') { installed = true; return { status: 0, stdout: '', stderr: '' }; } return { status: 1, stdout: '', stderr: 'no permission' }; };
  assert.match(tools.install(['graphify'], { platform: 'linux', env: {}, find, spawnSync }), /FAILED \(installed, but its setup step failed: no permission\)/);
  assert.deepEqual(tools.enabledIds(config(['codex'])).filter(id => id === 'graphify'), []);
  assert.throws(() => tools.command(['install', 'graphify'], { providers: { providers: { codex: { enabled: true } } } }, {}), /only enabled providers/);
});

test('uv tool installed but not on PATH shows update-shell hint', () => {
  const find = name => (name === 'uv' ? '/bin/uv' : null);
  const spawnSync = (file, args) => {
    if (args[0] === 'tool') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === '--version') return { status: 127, stdout: '', stderr: 'not found' };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.match(tools.install(['graphify'], { platform: 'linux', env: {}, find, spawnSync }), /installed, but its folder is not on PATH\. Run: uv tool update-shell/);
});

test('non-uv tool installed but not found yet shows generic message', () => {
  const calls = [];
  const find = name => (name === 'npm' ? '/bin/npm' : null);
  const spawnSync = (file, args) => {
    calls.push([file.split('/').pop(), ...args]);
    if (args[0] === '--version') return { status: 127, stdout: '', stderr: 'not found' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const options = { platform: 'linux', env: {}, find, spawnSync };
  assert.match(tools.install(['opencode'], options), /installed; open a new terminal if it is not found yet/);
});

test('Junie is one paste-only CLI for both JetBrains providers, logged in with the JetBrains account', () => {
  assert.deepEqual(tools.enabledIds({ providers: { providers: { 'junie-lite': { enabled: true, cli: { command: 'junie' } }, jetbrains: { enabled: true, cli: { command: 'junie' } } } } }), ['junie']);
  const m = machine({ have: { junie: '1.0.0' } });
  const [junie] = tools.check(['junie'], { ...m.options, find: () => null });
  assert.equal(junie.state, 'manual');
  assert.match(junie.note, /curl -fsSL https:\/\/junie\.jetbrains\.com\/install\.sh \| bash/);
  assert.match(tools.check(['junie'], { ...m.options, find: () => null, platform: 'win32' })[0].note, /irm https:\/\/junie\.jetbrains\.com\/install\.ps1 \| iex/);
  // Outside Windows the login sits in the OS keychain: it cannot be checked, and a token does not count as a login.
  for (const env of [{}, { JUNIE_API_KEY: 'x' }]) {
    assert.match(tools.logins(['junie'], { ...m.options, env }), /junie: cannot be checked automatically; if not done yet, run: junie$/);
    assert.deepEqual(tools.pendingLogins(['junie'], { ...m.options, env }).map(login => [login.id, login.command, login.checkable, /JetBrains account/.test(login.hint)]),
      [['junie', 'junie', false, true]]);
  }
  // On Windows the saved login folder is the check: missing, a plain file, empty or only empty files means not logged in.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-junie-'));
  try {
    const win = { ...m.options, platform: 'win32', home }, store = path.join(home, '.junie', 'dpapi_credentials');
    assert.equal(tools.logins(['junie'], win), '- junie: NOT logged in, run: junie');
    assert.deepEqual(tools.pendingLogins(['junie'], win).map(login => [login.command, login.checkable, login.newWindow]), [['junie', true, true]]);
    fs.mkdirSync(path.join(home, '.junie'));
    fs.writeFileSync(store, 'sealed');
    assert.equal(tools.logins(['junie'], win), '- junie: NOT logged in, run: junie');
    fs.rmSync(store); fs.mkdirSync(store);
    assert.equal(tools.logins(['junie'], win), '- junie: NOT logged in, run: junie');
    fs.writeFileSync(path.join(store, 'a'), ''); fs.mkdirSync(path.join(store, 'sub'));
    assert.equal(tools.logins(['junie'], win), '- junie: NOT logged in, run: junie');
    fs.writeFileSync(path.join(store, 'b'), 'sealed');
    assert.equal(tools.logins(['junie'], win), '- junie: logged in');
    assert.deepEqual(tools.pendingLogins(['junie'], win), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  // The login check never starts the CLI.
  assert.ok(!m.calls.some(call => call[0] === 'junie' && call[1] !== '--version'));
});
