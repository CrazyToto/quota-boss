'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install } = require('../install.js');

const MARKER = '<!-- managed-by: quota-boss -->';
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-install-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const repo = path.join(temporary, 'repository');
  const claude = path.join(temporary, 'claude config');
  const home = path.join(temporary, 'custom quota-boss home');
  const codex = path.join(temporary, 'codex');
  const env = { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, QUOTA_BOSS_HOME: home, QUOTA_BOSS_SKIP_MCP: '1', QUOTA_BOSS_MCP: '1' };
  for (const [file, data] of Object.entries({
    'scripts/statusline.js': "'use strict';\n",
    'scripts/hook-session.js': "'use strict';\n",
    'scripts/hook-prompt.js': "'use strict';\n",
    'scripts/nested/helper.js': 'module.exports = 42;\n',
    'config/models.json': '{"models":{}}\n',
    'config/thresholds.json': '{"save":75}\n',
    'agents/worker.md': `${MARKER}\nWorker\n`,
    'commands/boss.md': `${MARKER}\nCommand\n`,
    'templates/RULES.md': 'Quota Boss rules\n',
  })) write(path.join(repo, ...file.split('/')), data);
  const settings = path.join(claude, 'settings.json');
  const logs = [];
  const run = (args = [], overrides = {}) => install({
    repo, env, args, platform: 'linux', log: message => logs.push(message),
    spawnSync: () => { throw new Error('Tests must never invoke real CLIs'); },
    findExecutable: () => { throw new Error('Skipped MCP must not inspect PATH'); },
    ...overrides,
  });
  return { temporary, repo, claude, home, codex, env, settings, logs, run,
    manifest: () => readJSON(path.join(home, 'install-manifest.json')) };
}
function snapshot(directory) {
  const result = {};
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'backups') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, value] of Object.entries(snapshot(file))) result[path.join(entry.name, name)] = value;
    } else result[entry.name] = { data: fs.readFileSync(file, 'base64'), mtime: fs.statSync(file).mtimeMs };
  }
  return result;
}

test('copies runtime sources, uses all path overrides, and writes settings and manifest', t => {
  const f = fixture(t);
  f.run();
  assert.equal(fs.readFileSync(path.join(f.home, 'scripts/nested/helper.js'), 'utf8'), 'module.exports = 42;\n');
  assert.equal(fs.readFileSync(path.join(f.home, 'templates/RULES.md'), 'utf8'), 'Quota Boss rules\n');
  assert.ok(fs.existsSync(path.join(f.claude, 'agents/worker.md')));
  assert.ok(fs.existsSync(path.join(f.claude, 'commands/boss.md')));
  assert.equal(fs.existsSync(f.codex), false);
  const settings = readJSON(f.settings);
  const normalizedHome = f.home.replace(/\\/g, '/');
  assert.deepEqual(settings.statusLine, {
    type: 'command', command: `"${process.execPath.replace(/\\/g, '/')}" "${normalizedHome}/scripts/statusline.js"`, refreshInterval: 30,
  });
  for (const [event, script] of [['SessionStart', 'hook-session.js'], ['UserPromptSubmit', 'hook-prompt.js']]) {
    assert.deepEqual(settings.hooks[event], [{ hooks: [{ type: 'command', command: `"${process.execPath.replace(/\\/g, '/')}" "${normalizedHome}/scripts/${script}"`, timeout: 10 }] }]);
  }
  assert.equal(f.manifest().mcpAdded, false);
  assert.ok(f.manifest().files.some(file => file.path === path.join(f.home, 'config/models.json')));
  assert.equal(Object.keys(snapshot(f.temporary)).some(file => file.includes('.tmp-')), false);
});

test('upgrade removes legacy rules and tracks the new template through uninstall', t => {
  const f = fixture(t);
  f.run();
  const legacy = path.join(f.home, 'RULES.md');
  const target = path.join(f.home, 'templates', 'RULES.md');
  // Recreate the previous release's installed path and ownership record.
  fs.renameSync(target, legacy);
  const manifest = f.manifest();
  manifest.files.find(entry => entry.path === target).path = legacy;
  write(path.join(f.home, 'install-manifest.json'), JSON.stringify(manifest));
  f.run(['--dry-run']);
  assert.ok(fs.existsSync(legacy));
  assert.equal(fs.existsSync(target), false);
  f.run();
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Quota Boss rules\n');
  assert.ok(f.manifest().files.some(entry => entry.path === target && entry.kind === 'rules'));
  assert.equal(f.manifest().files.some(entry => entry.path === legacy), false);
  f.run(['--uninstall']);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(legacy), false);
});

test('replaces every QUOTA_BOSS_HOME placeholder in agents and commands with forward slashes', t => {
  const f = fixture(t);
  const source = `${MARKER}\nnode "{{QUOTA_BOSS_HOME}}/scripts/quota-boss.js"\n{{QUOTA_BOSS_HOME}}\n`;
  for (const name of ['agents/worker.md', 'commands/boss.md']) write(path.join(f.repo, name), source);
  f.run();
  for (const name of ['agents/worker.md', 'commands/boss.md']) {
    const installed = fs.readFileSync(path.join(f.claude, name), 'utf8');
    assert.equal(installed, source.split('{{QUOTA_BOSS_HOME}}').join(f.home.replace(/\\/g, '/')));
    assert.doesNotMatch(installed, /\{\{QUOTA_BOSS_HOME\}\}|\\/);
  }
});

test('preserves unknown keys and hooks, wraps status line, and backs up exact original bytes', t => {
  const f = fixture(t);
  const original = {
    arbitrary: { secretKeyNameOnly: 'ordinary-setting', nested: [1, 2] }, permissions: { allow: ['Read'] },
    statusLine: { type: 'command', command: 'my-status --colour', custom: 7 },
    hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'user-hook' }] }], Stop: [{ anything: true }] },
  };
  const bytes = JSON.stringify(original, null, 4) + '\n';
  write(f.settings, bytes);
  f.run();
  const settings = readJSON(f.settings);
  assert.deepEqual(settings.arbitrary, original.arbitrary);
  assert.deepEqual(settings.permissions, original.permissions);
  assert.deepEqual(settings.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(settings.hooks.SessionStart[0], original.hooks.SessionStart[0]);
  assert.deepEqual(readJSON(path.join(f.home, 'wrapped-statusline.json')), { command: 'my-status --colour' });
  const backups = fs.readdirSync(path.join(f.claude, 'backups'));
  assert.match(backups[0], /^settings\.json\.quota-boss-\d{8}-\d{6}(?:-\d+)?$/);
  assert.equal(fs.readFileSync(path.join(f.claude, 'backups', backups[0]), 'utf8'), bytes);
  f.run(['--uninstall']);
  assert.deepEqual(readJSON(f.settings), original);
});

test('installed provider defaults survive a partial user config across fresh library loads', t => {
  const f = fixture(t);
  const defaults = fs.readFileSync(path.join(__dirname, '..', 'config', 'providers.json'), 'utf8');
  write(path.join(f.repo, 'config', 'providers.json'), defaults);
  write(path.join(f.repo, 'scripts', 'lib.js'), fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib.js')));
  const userFile = path.join(f.home, 'config', 'providers.json');
  write(userFile, JSON.stringify({ providers: { grok: { enabled: true } }, caps: { grok: { weekly: 20 } } }));
  f.run();
  assert.equal(fs.readFileSync(path.join(f.home, 'defaults', 'providers.json'), 'utf8'), defaults);
  assert.equal(readJSON(userFile).providers.claude, undefined);
  const previousHome = process.env.QUOTA_BOSS_HOME;
  process.env.QUOTA_BOSS_HOME = f.home;
  const installedPath = path.join(f.home, 'scripts', 'lib.js');
  try {
    let installed = require(installedPath);
    assert.equal(installed.loadProviders().providers.claude.quota.source, 'claude-statusline');
    assert.equal(installed.loadProviders().providers.grok.enabled, true);
    write(userFile, JSON.stringify({ caps: { codex: { weekly: 50 } } }));
    delete require.cache[require.resolve(installedPath)];
    installed = require(installedPath);
    assert.equal(installed.loadProviders().providers.codex.worker, 'codex-worker');
    assert.equal(installed.loadProviders().caps.codex.weekly, 50);
  } finally {
    delete require.cache[require.resolve(installedPath)];
    if (previousHome === undefined) delete process.env.QUOTA_BOSS_HOME; else process.env.QUOTA_BOSS_HOME = previousHome;
  }
});

test('second install changes nothing except a fresh backup, including custom home hook detection', t => {
  const f = fixture(t);
  write(f.settings, '{"theme":"dark"}\n');
  f.run();
  const before = snapshot(f.temporary);
  const firstBackupCount = fs.readdirSync(path.join(f.claude, 'backups')).length;
  f.run();
  assert.deepEqual(snapshot(f.temporary), before);
  assert.equal(fs.readdirSync(path.join(f.claude, 'backups')).length, firstBackupCount + 1);
  assert.equal(readJSON(f.settings).hooks.SessionStart.length, 1);
});

test('preserves user configs, emits .json.new, and never overwrites them even with force', t => {
  const f = fixture(t);
  const file = path.join(f.home, 'config/models.json');
  write(file, '{"mine":true}\n');
  // An identical pre-existing user file still receives a .new.
  write(path.join(f.home, 'config/thresholds.json'), '{"save":75}\n');
  f.run(['--force']);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mine":true}\n');
  assert.equal(fs.readFileSync(`${file}.new`, 'utf8'), '{"models":{}}\n');
  assert.ok(fs.existsSync(path.join(f.home, 'config/thresholds.json.new')));
  assert.ok(f.logs.some(line => line.includes('Keep existing config')));
  const before = snapshot(f.temporary);
  f.run();
  assert.deepEqual(snapshot(f.temporary), before);
});

test('updated defaults are shipped as .new while scripts are updated from runtime sources', t => {
  const f = fixture(t);
  f.run();
  write(path.join(f.repo, 'config/models.json'), '{"updated":true}');
  write(path.join(f.repo, 'scripts/new.js'), 'new runtime script');
  f.run();
  assert.equal(fs.readFileSync(path.join(f.home, 'config/models.json'), 'utf8'), '{"models":{}}\n');
  assert.equal(fs.readFileSync(path.join(f.home, 'config/models.json.new'), 'utf8'), '{"updated":true}');
  assert.equal(fs.readFileSync(path.join(f.home, 'scripts/new.js'), 'utf8'), 'new runtime script');
});

test('a repeat install drops registry entries the user never changed and keeps real overrides', t => {
  const f = fixture(t);
  f.run();
  const old = { $comment: 'old', categories: ['a'] };
  write(path.join(f.home, 'defaults/models.json'), JSON.stringify({ ...old, models: { same: { cost: 1 }, edited: { cost: 2 } } }));
  write(path.join(f.home, 'config/models.json'), JSON.stringify({ ...old, models: { same: { cost: 1 }, edited: { cost: 3 }, added: { cost: 4 } } }));
  f.run();
  assert.deepEqual(readJSON(path.join(f.home, 'config/models.json')), { models: { edited: { cost: 3 }, added: { cost: 4 } } });
  assert.ok(f.logs.some(line => line.includes('Removed 1 unchanged model entries')));
});

test('a registry that cannot be compared is left alone', t => {
  const f = fixture(t);
  f.run();
  write(path.join(f.home, 'defaults/models.json'), '{broken');
  write(path.join(f.home, 'config/models.json'), '{"models":{"mine":{"cost":3}}}');
  f.run();
  assert.equal(fs.readFileSync(path.join(f.home, 'config/models.json'), 'utf8'), '{"models":{"mine":{"cost":3}}}');
});

test('managed markdown is replaced; unmanaged collisions are skipped unless forced', t => {
  const f = fixture(t);
  const agent = path.join(f.claude, 'agents/worker.md');
  const command = path.join(f.claude, 'commands/boss.md');
  write(agent, 'user agent');
  write(command, `${MARKER}\nold command`);
  write(path.join(f.repo, 'agents/ignored.txt'), 'not markdown');
  f.run();
  assert.equal(fs.readFileSync(agent, 'utf8'), 'user agent');
  assert.equal(fs.readFileSync(command, 'utf8'), `${MARKER}\nCommand\n`);
  assert.equal(fs.existsSync(path.join(f.claude, 'agents/ignored.txt')), false);
  assert.equal(f.manifest().files.some(file => file.path === agent), false);
  assert.ok(f.logs.some(line => line.includes('Skip unmanaged')));
  f.run(['--force']);
  assert.equal(fs.readFileSync(agent, 'utf8'), `${MARKER}\nWorker\n`);
});

test('upgrades legacy Quota Boss hooks to absolute Node and removes them on uninstall', t => {
  const f = fixture(t);
  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node "C:\\user\\.claude\\quota-boss\\scripts\\hook-session.js"' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "/old/quota-boss/scripts/hook-prompt.js"' }] }],
  };
  write(f.settings, JSON.stringify({ hooks }));
  f.run();
  for (const entries of Object.values(readJSON(f.settings).hooks)) assert.ok(entries[0].hooks[0].command.startsWith('"' + process.execPath.replace(/\\/g, '/') + '" '));
  f.run(['--uninstall']);
  assert.deepEqual(readJSON(f.settings).hooks, {SessionStart:[], UserPromptSubmit:[]});
});

test('legacy Quota Boss status line is replaced without wrapping Quota Boss recursively', t => {
  const f = fixture(t);
  write(f.settings, JSON.stringify({ statusLine: { type: 'command', command: 'node "/old/quota-boss/scripts/statusline.js"' } }));
  f.run();
  assert.equal(fs.existsSync(path.join(f.home, 'wrapped-statusline.json')), false);
  f.run(['--uninstall']);
  assert.equal('statusLine' in readJSON(f.settings), false);
});

test('default Quota Boss path is relative to the overridden Claude directory', t => {
  const f = fixture(t);
  const env = { CLAUDE_CONFIG_DIR: f.claude, CODEX_HOME: f.codex, QUOTA_BOSS_SKIP_MCP: '1', QUOTA_BOSS_MCP: '1' };
  f.run([], { env });
  const home = path.join(f.claude, 'quota-boss');
  assert.ok(fs.existsSync(path.join(home, 'install-manifest.json')));
  assert.equal(fs.existsSync(f.home), false);
  assert.ok(readJSON(f.settings).statusLine.command.includes(home.replace(/\\/g, '/')));
  f.run(['--uninstall'], { env });
});

test('uninstall removes owned hooks/files, preserves later settings and sibling hooks, config and state', t => {
  const f = fixture(t);
  f.run();
  const settings = readJSON(f.settings);
  settings.afterInstall = { value: true };
  settings.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'later user hook' });
  write(f.settings, JSON.stringify(settings));
  write(path.join(f.home, 'state.json'), '{"sessions":{}}');
  write(path.join(f.home, 'personal.txt'), 'keep');
  f.run(['--uninstall']);
  const remaining = readJSON(f.settings);
  assert.deepEqual(remaining.afterInstall, { value: true });
  assert.deepEqual(remaining.hooks, { SessionStart: [{ hooks: [{ type: 'command', command: 'later user hook' }] }] });
  assert.equal('statusLine' in remaining, false);
  assert.equal(fs.existsSync(path.join(f.home, 'scripts/statusline.js')), false);
  assert.equal(fs.existsSync(path.join(f.claude, 'agents/worker.md')), false);
  assert.equal(fs.existsSync(path.join(f.claude, 'commands/boss.md')), false);
  assert.ok(fs.existsSync(path.join(f.home, 'config/models.json')));
  assert.ok(fs.existsSync(path.join(f.home, 'state.json')));
  assert.ok(fs.existsSync(path.join(f.home, 'personal.txt')));
  assert.equal(fs.existsSync(path.join(f.home, 'install-manifest.json')), false);
  const before = snapshot(f.temporary);
  f.run(['--uninstall']);
  assert.deepEqual(snapshot(f.temporary), before);
});

test('uninstall preserves status line replaced by user and markdown whose marker was removed', t => {
  const f = fixture(t);
  f.run();
  const settings = readJSON(f.settings);
  settings.statusLine = { type: 'command', command: 'new-user-status' };
  write(f.settings, JSON.stringify(settings));
  write(path.join(f.claude, 'agents/worker.md'), 'now owned by user');
  f.run(['--uninstall']);
  assert.deepEqual(readJSON(f.settings).statusLine, settings.statusLine);
  assert.equal(fs.readFileSync(path.join(f.claude, 'agents/worker.md'), 'utf8'), 'now owned by user');
});

test('force uninstall removes installed config and state but keeps unrelated home files', t => {
  const f = fixture(t);
  f.run();
  write(path.join(f.home, 'state.json'), '{}');
  write(path.join(f.home, 'personal.txt'), 'keep');
  f.run(['--uninstall', '--force']);
  assert.equal(fs.existsSync(path.join(f.home, 'config/models.json')), false);
  assert.equal(fs.existsSync(path.join(f.home, 'state.json')), false);
  assert.ok(fs.existsSync(path.join(f.home, 'personal.txt')));
});

test('dry-run install creates nothing and never invokes MCP', t => {
  const f = fixture(t);
  const before = snapshot(f.temporary);
  f.run(['--dry-run'], { env: { ...f.env, QUOTA_BOSS_SKIP_MCP: '0' }, findExecutable: () => '/fake/codex' });
  assert.deepEqual(snapshot(f.temporary), before);
  assert.ok(f.logs.some(line => line.includes('Check Codex MCP')));
  assert.ok(f.logs.every(line => line.startsWith('[dry-run]')));
});

test('dry-run uninstall leaves settings, backups, installed files and manifest untouched', t => {
  const f = fixture(t);
  f.run();
  const before = snapshot(f.temporary);
  const backups = fs.existsSync(path.join(f.claude, 'backups')) ? fs.readdirSync(path.join(f.claude, 'backups')) : [];
  f.run(['--dry-run', '--uninstall', '--force']);
  assert.deepEqual(snapshot(f.temporary), before);
  assert.deepEqual(fs.existsSync(path.join(f.claude, 'backups')) ? fs.readdirSync(path.join(f.claude, 'backups')) : [], backups);
});

test('no-mcp flag and environment skip prevent even PATH inspection', t => {
  const f = fixture(t);
  f.run(['--no-mcp'], { env: { ...f.env, QUOTA_BOSS_SKIP_MCP: '0' } });
  f.run();
});

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`MCP uses fixed argument arrays on ${platform}, records ownership and removes only our server`, t => {
    const f = fixture(t);
    const calls = [];
    const overrides = {
      env: { ...f.env, QUOTA_BOSS_SKIP_MCP: '0' }, platform,
      findExecutable: name => platform === 'win32' ? 'C:\\bin\\' + name + '.cmd' : '/bin/' + name,
      spawnSync: (file, args, options) => {
        calls.push({ file, args, options });
        return { status: calls.length === 1 ? 1 : 0 };
      },
    };
    f.run([], overrides);
    if (platform === 'win32') {
      assert.deepEqual(calls[0].args.slice(0,3), ['/d','/s','/c']);
      assert.match(calls[0].args[3], /"C:\\bin\\claude.cmd" "mcp" "get" "codex"/);
      assert.match(calls[1].args[3], /run-cli.js/);
      assert.match(calls[1].args[3], /C:\\bin\\codex.cmd/);
      assert.match(calls[0].file, /System32[\\/]cmd.exe$/i);
    } else {
      assert.deepEqual(calls[0].args, ['mcp', 'get', 'codex']);
      assert.deepEqual(calls[1].args, ['mcp', 'add', '--scope', 'user', 'codex', '--', '/bin/codex', 'mcp-server']);
      assert.equal(calls[0].file, '/bin/claude');
    }
    assert.equal(calls[0].options.shell, false);
    assert.equal(f.manifest().mcpAdded, true);
    f.run([], overrides);
    assert.equal(calls.filter(call => platform === 'win32' ? call.args[3].includes('\"add\"') : call.args[1] === 'add').length, 1);
    assert.equal(f.manifest().mcpAdded, true);
    f.run(['--uninstall'], overrides);
    if (platform === 'win32') assert.match(calls.at(-1).args[3], /"mcp" "remove" "codex" "--scope" "user"/);
    else assert.deepEqual(calls.at(-1).args, ['mcp', 'remove', 'codex', '--scope', 'user']);
  });
}

test('Windows native executable does not enable shell', t => {
  const f = fixture(t);
  f.run([], {
    platform: 'win32', env: { ...f.env, QUOTA_BOSS_SKIP_MCP: '0' },
    findExecutable: name => `C:\\bin\\${name}.exe`,
    spawnSync: (file, args, options) => { assert.equal(options.shell, false); return { status: 0 }; },
  });
});

test('pre-existing MCP registration is never removed on uninstall', t => {
  const f = fixture(t);
  const calls = [];
  const overrides = {
    env: { ...f.env, QUOTA_BOSS_SKIP_MCP: '0' }, findExecutable: () => '/fake/cli',
    spawnSync: (file, args) => { calls.push(args); return { status: 0 }; },
  };
  f.run([], overrides);
  assert.equal(f.manifest().mcpAdded, false);
  f.run(['--uninstall'], overrides);
  assert.deepEqual(calls, [['mcp', 'get', 'codex']]);
});

test('MCP absence, failed check and failed addition are reported without claiming ownership', t => {
  for (const mode of ['absent', 'check-error', 'add-error']) {
    const f = fixture(t);
    const calls = [];
    f.run([], {
      env: { ...f.env, QUOTA_BOSS_SKIP_MCP: '0' },
      findExecutable: name => mode === 'absent' && name === 'codex' ? null : '/fake/cli',
      spawnSync: (file, args) => { calls.push(args); return mode === 'check-error' ? { error: new Error('missing'), status: null } : { status: 1 }; },
    });
    assert.equal(f.manifest().mcpAdded, false);
    assert.equal(calls.length, mode === 'absent' ? 0 : mode === 'check-error' ? 1 : 2);
    assert.ok(f.logs.some(line => /skipped|Could not/.test(line)));
  }
});

test('skipped or failed MCP removal retains ownership manifest for retry', t => {
  const f = fixture(t);
  let failRemoval = true;
  const overrides = {
    env: { ...f.env, QUOTA_BOSS_SKIP_MCP: '0' }, findExecutable: () => '/fake/cli',
    spawnSync: (file, args) => ({ status: args[1] === 'get' || (args[1] === 'remove' && failRemoval) ? 1 : 0 }),
  };
  f.run([], overrides);
  f.run(['--uninstall']);
  assert.equal(f.manifest().mcpAdded, true);
  assert.throws(() => f.run(['--uninstall'], overrides), /manifest retained/);
  assert.equal(f.manifest().mcpAdded, true);
  failRemoval = false;
  f.run(['--uninstall'], overrides);
  assert.equal(fs.existsSync(path.join(f.home, 'install-manifest.json')), false);
});

test('rejects bad options and malformed settings before modifying anything', t => {
  for (const settings of ['{broken', '[]', '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}']) {
    const f = fixture(t);
    write(f.settings, settings);
    const before = snapshot(f.temporary);
    assert.throws(() => f.run());
    assert.deepEqual(snapshot(f.temporary), before);
  }
  const f = fixture(t);
  assert.throws(() => f.run(['--typo']), /Unknown option/);
  assert.equal(fs.existsSync(f.home), false);
});

test('failed atomic settings replacement preserves original settings and backup, and cleans temporary file', t => {
  const f = fixture(t);
  const original = '{"user":"keep byte for byte"}\n';
  write(f.settings, original);
  const rename = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (to === f.settings) throw new Error('simulated settings rename failure');
    return rename.call(this, from, to);
  };
  try { assert.throws(() => f.run(), /simulated settings rename failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.settings, 'utf8'), original);
  const backups = fs.readdirSync(path.join(f.claude, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(f.claude, 'backups', backups[0]), 'utf8'), original);
  assert.equal(fs.existsSync(`${f.settings}.tmp-${process.pid}`), false);
});

test('missing runtime source directories are allowed without importing scripts/lib.js', t => {
  const f = fixture(t);
  fs.rmSync(f.repo, { recursive: true, force: true });
  fs.mkdirSync(f.repo);
  f.run();
  assert.ok(fs.existsSync(f.settings));
  assert.ok(f.logs.some(line => line.includes('Skip missing source')));
});

test('credential files are never opened', t => {
  const f = fixture(t);
  write(path.join(f.codex, 'auth.json'), 'do not read');
  write(path.join(f.claude, '.credentials.json'), 'do not read');
  const original = fs.openSync;
  const reads = [];
  fs.openSync = function(file, ...args) {
    reads.push(String(file));
    assert.equal(['auth.json', '.credentials.json'].includes(path.basename(String(file))), false);
    return original.call(this, file, ...args);
  };
  try { f.run(); f.run(); f.run(['--uninstall']); }
  finally { fs.openSync = original; }
  assert.ok(reads.length > 0);
});

test('uninstall rejects manifest paths outside configured directories', t => {
  const f = fixture(t);
  f.run();
  const manifest = f.manifest();
  const outside = path.join(f.temporary, 'do-not-delete.txt');
  write(outside, 'keep');
  manifest.files.push({ path: outside, kind: 'script' });
  write(path.join(f.home, 'install-manifest.json'), JSON.stringify(manifest));
  const before = snapshot(f.temporary);
  assert.throws(() => f.run(['--uninstall', '--force']), /Unsafe path/);
  assert.deepEqual(snapshot(f.temporary), before);
});


test('legacy home, marker, placeholder and hook names remain recognized', t => {
  const f = fixture(t);
  const env = { CLAUDE_CONFIG_DIR: f.claude, CODEX_HOME: f.codex, HARNESS_HOME: f.home, HARNESS_SKIP_MCP: '1' };
  write(path.join(f.repo, 'agents/worker.md'), '<!-- managed-by: quota-boss -->\n{{QUOTA_BOSS_HOME}}\n{{HARNESS_HOME}}\n');
  write(path.join(f.claude, 'agents/worker.md'), '<!-- managed-by: harness -->\nold managed worker');
  const hooks = { SessionStart: [{hooks:[{type:'command',command:'node "/old/harness/scripts/hook-session.js"'}]}],
    UserPromptSubmit: [{hooks:[{type:'command',command:'node "/old/quota-boss/scripts/hook-prompt.js"'}]}] };
  write(f.settings, JSON.stringify({ hooks, statusLine: {type:'command',command:'node "/old/harness/scripts/statusline.js"'} }));
  f.run([], { env });
  assert.equal(fs.readFileSync(path.join(f.claude,'agents/worker.md'),'utf8'), '<!-- managed-by: quota-boss -->\n' + f.home.replace(/\\/g,'/') + '\n' + f.home.replace(/\\/g,'/') + '\n');
  for (const entries of Object.values(readJSON(f.settings).hooks)) assert.ok(entries[0].hooks[0].command.startsWith('"' + process.execPath.replace(/\\/g, '/') + '" '));
  assert.equal(fs.existsSync(path.join(f.home,'wrapped-statusline.json')),false);
  // The old marker is also managed during uninstall.
  write(path.join(f.claude,'agents/worker.md'), '<!-- managed-by: harness -->\nmanaged');
  f.run(['--uninstall'], { env });
  assert.equal(fs.existsSync(path.join(f.claude,'agents/worker.md')),false);
  assert.deepEqual(readJSON(f.settings).hooks,{SessionStart:[], UserPromptSubmit:[]});
});


test('package, executable and slash command expose the renamed project', () => {
  const repo = path.join(__dirname,'..');
  const pkg = readJSON(path.join(repo,'package.json'));
  assert.equal(pkg.name,'quota-boss');assert.deepEqual(pkg.bin,{'quota-boss':'bin/quota-boss.js'});
  assert.ok(fs.readFileSync(path.join(repo,'bin','quota-boss.js'),'utf8').startsWith('#!/usr/bin/env node\n'));
  assert.ok(fs.readFileSync(path.join(repo,'scripts','quota-boss.js'),'utf8').startsWith('#!/usr/bin/env node\n'));
  assert.equal(fs.existsSync(path.join(repo,'scripts','harness.js')),false);
  assert.equal(fs.existsSync(path.join(repo,'commands','harness.md')),false);
  assert.match(fs.readFileSync(path.join(repo,'commands','boss.md'),'utf8'),/managed-by: quota-boss/);
});

test('installed Codex and generic rules can find their worker instructions without the checkout', t => {
  const f = fixture(t);
  for (const file of ['scripts/lib.js','scripts/hosts.js','agents/claude-worker.md','agents/cli-worker.md','templates/RULES.md','config/providers.json']) {
    write(path.join(f.repo,file),fs.readFileSync(path.join(__dirname,'..',file)));
  }
  f.run();
  const previous=process.env.QUOTA_BOSS_HOME;process.env.QUOTA_BOSS_HOME=f.home;
  try {
    const hosts=require(path.join(f.home,'scripts','hosts.js'));
    assert.match(hosts.rules('codex'),/claude -p/);assert.match(hosts.rules('generic'),/usage <provider> 1 calls/);
    assert.doesNotMatch(hosts.rules('codex'), /^name: cli-worker$/m);
    write(path.join(f.home, 'config/providers.json'), JSON.stringify({ providers: { claude: { enabled: false }, grok: { enabled: true } } }));
    const switched = hosts.rules('codex');
    assert.doesNotMatch(switched, /^name: claude-worker$/m);
    assert.match(switched, /^name: cli-worker$/m);
    assert.match(switched, /rules --host codex/);
  } finally {if(previous===undefined)delete process.env.QUOTA_BOSS_HOME;else process.env.QUOTA_BOSS_HOME=previous;}
});

test('default install does not register the Codex MCP bridge (workers use codex exec)', t => {
  const f = fixture(t);
  f.run([], { env: { ...f.env, QUOTA_BOSS_SKIP_MCP: '0', QUOTA_BOSS_MCP: '0' } });
  assert.ok(f.logs.some(line => line.includes('Codex MCP bridge not requested')));
});


test('uninstall removes only our Codex hook and dry-run preserves it', t => {
  const f = fixture(t);
  f.run();
  fs.mkdirSync(f.codex);
  const hooks = require('../scripts/codex-hooks');
  const paths = { quotaBossHome: f.home, codexDir: f.codex };
  assert.equal(hooks.update(true, paths).changed, true);
  const file = path.join(f.codex, 'hooks.json');
  const value = readJSON(file);
  value.foreign = 'keep';
  value.hooks.Stop = [{ hooks: [{ type: 'command', command: 'foreign' }] }];
  fs.writeFileSync(file, JSON.stringify(value));
  const bytes = fs.readFileSync(file, 'utf8');
  f.run(['--uninstall', '--dry-run']);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  f.run(['--uninstall']);
  assert.deepEqual(readJSON(file), { hooks: { Stop: value.hooks.Stop }, foreign: 'keep' });
});
