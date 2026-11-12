'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const lib = require('./scripts/lib');
const hosts = require('./scripts/hosts');

const MARKER = '<!-- managed-by: quota-boss -->';
const managed = text => text.includes(MARKER) || text.includes('<!-- managed-by: harness -->');
const FLAGS = new Set(['--dry-run', '--force', '--no-mcp', '--mcp', '--uninstall']);

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function readJSON(file, fallback) {
  if (!exists(file)) return fallback;
  const value = JSON.parse(lib.readBounded(file, 4 * 1024 * 1024));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected a JSON object: ${file}`);
  }
  return value;
}

const atomicWrite = lib.atomicWrite;

function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function normalized(command) { return String(command || '').replace(/\\/g, '/'); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function paths(env) {
  const claude = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  return {
    claude,
    codex: path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    home: path.resolve(env.QUOTA_BOSS_HOME || env.HARNESS_HOME || path.join(claude, 'quota-boss')),
    settings: path.join(claude, 'settings.json'),
  };
}

const findExecutable = lib.findExecutable;

function parseArgs(args) {
  let scan = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scan') {
      if (scan !== null || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--scan requires one directory.');
      scan = path.resolve(args[++i]);
    } else if (!FLAGS.has(args[i])) throw new Error('Unknown option: ' + args[i]);
  }
  if (scan && !args.includes('--uninstall')) throw new Error('--scan requires --uninstall.');
  return scan;
}
function install(options = {}) {
  const args = options.args || [];
  parseArgs(args);
  if (args.includes('--dry-run')) return installLocked(options);
  const dirs = paths(options.env || process.env);
  // The manifest is first read inside this lock, including for upgrades/uninstalls.
  const result = lib.withLock(path.join(dirs.claude, 'quota-boss-installer'), verify => {
    installLocked(options, verify);
    return true;
  }, 2000);
  if (result === null) throw new Error('Quota Boss installer is busy; retry.');
}
function installLocked(options = {}, verifyInstaller = () => {}) {
  const args = options.args || [];
  const scan = parseArgs(args);
  const env = options.env || process.env;
  const repo = path.resolve(options.repo || __dirname);
  const platform = options.platform || process.platform;
  const run = options.spawnSync || spawnSync;
  const find = options.findExecutable || ((name) => findExecutable(name, env, platform));
  const log = options.log || console.log;
  const dry = args.includes('--dry-run');
  const force = args.includes('--force');
  const skipMCP = args.includes('--no-mcp') || (env.QUOTA_BOSS_SKIP_MCP || env.HARNESS_SKIP_MCP) === '1';
  const dirs = paths(env);
  lib.trustedHomeText(dirs.home);
  lib.regularStat(dirs.settings, true);
  const manifestFile = path.join(dirs.home, 'install-manifest.json');
  const wrappedFile = path.join(dirs.home, 'wrapped-statusline.json');
  const previous = readJSON(manifestFile, null);
  if (previous && (previous.version !== 1 || previous.home !== dirs.home || previous.claude !== dirs.claude)) {
    throw new Error('Install manifest does not match the configured paths or version.');
  }
  let manifest = previous || {
    version: 1, home: dirs.home, claude: dirs.claude,
    settings: dirs.settings, files: [], hooks: [], statusLine: null, mcpAdded: false,
  };
  const settings = readJSON(dirs.settings, {});
  const nodePath = lib.trustedHomeText(process.execPath);
  const command = script => `"${nodePath}" "${normalized(path.join(dirs.home, 'scripts', script))}"`;
  const statusCommand = command('statusline.js');
  const say = message => log(`${dry ? '[dry-run] ' : ''}${message}`);
  const changed = (file, data) => !exists(file) || !Buffer.from(lib.readBounded(file, 4 * 1024 * 1024)).equals(Buffer.from(data));
  const write = (file, data) => {
    if (changed(file, data)) {
      say(`Write ${file}`);
      if (!dry) atomicWrite(file, data, verifyInstaller);
    }
  };
  const remember = (file, kind) => {
    if (!manifest.files.some(entry => entry.path === file)) manifest.files.push({ path: file, kind });
  };
  const backupSettings = () => {
    if (!exists(dirs.settings)) return;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const base = path.join(dirs.claude, 'backups', `settings.json.quota-boss-${stamp}`);
    let target = base;
    for (let count = 1; exists(target); count++) target = `${base}-${count}`;
    say(`Back up settings to ${target}`);
    if (!dry) atomicWrite(target, lib.readBounded(dirs.settings, 4 * 1024 * 1024));
  };
  const validateSettings = value => {
    if (value.hooks !== undefined && !object(value.hooks)) throw new Error('settings.hooks must be an object.');
    for (const event of ['SessionStart', 'UserPromptSubmit']) if (value.hooks?.[event] !== undefined && !Array.isArray(value.hooks[event])) throw new Error('settings.hooks.' + event + ' must be an array.');
  };
  const settingsSnapshot = () => {
    const before = lib.regularStat(dirs.settings, true);
    if (!before) return { bytes: null, mtime: null, size: null, hash: null };
    const bytes = lib.readBounded(dirs.settings, 4 * 1024 * 1024);
    const after = lib.regularStat(dirs.settings);
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
      const error = new Error('settings.json changed while reading'); error.code = 'SETTINGS_CHANGED'; throw error;
    }
    return { bytes, mtime: after.mtimeMs, size: after.size, hash: crypto.createHash('sha256').update(bytes).digest('hex') };
  };
  const saveSettings = transform => {
    if (dry) { transform(structuredClone(settings)); return; }
    const baseManifest = structuredClone(manifest);
    const result = lib.withLock(dirs.settings, verify => {
      for (let attempt = 0; attempt < 3; attempt++) {
        manifest = structuredClone(baseManifest);
        try {
        const snapshot = settingsSnapshot();
        const bytes = snapshot.bytes;
        const fresh = bytes === null ? {} : JSON.parse(bytes);
        if (!object(fresh)) throw new Error('Expected settings JSON object.');
        validateSettings(fresh);
        transform(fresh);
        const data = json(fresh);
        backupSettings();
        if (bytes !== data) {
          // Journal ownership before activation. A failed commit remains uninstallable.
          manifest.pending = true;
          write(manifestFile, json(manifest));
        }
          const unchanged = () => {
            verifyInstaller(); verify();
            if (JSON.stringify(settingsSnapshot()) !== JSON.stringify(snapshot)) { const e = new Error('settings.json changed during commit'); e.code = 'SETTINGS_CHANGED'; throw e; }
          };
          if (bytes !== data) {
            atomicWrite(dirs.settings, data, unchanged);
          } else unchanged();
          return true;
        } catch (error) {
          if (error.code !== 'SETTINGS_CHANGED') throw error;
          if (attempt === 2) throw new Error('settings.json changed during commit after 3 attempts; installation aborted. Retry when other settings writers are idle.');
        }
      }
    }, 2000, dirs.settings + '.quota-boss.lock');
    if (result === null) throw new Error('settings.json is locked by another writer; retry.');
  };
  const mcp = args => lib.runExecutable(find('claude'), args,
    { platform, env: { ...env, QUOTA_BOSS_HOME: dirs.home }, spawnSync: run, encoding: 'utf8', timeout: 15000, stdio: 'pipe' });
  const remove = file => {
    if (!exists(file)) return;
    say(`Remove ${file}`);
    if (!dry) { lib.checkParents(file); lib.regularStat(file); fs.unlinkSync(file); }
  };
  const inside = (base, file) => {
    const relative = path.relative(base, file);
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
  };

  const cleanupProjects = () => {
    say('For pre-upgrade installs, use --uninstall --scan <dir> to find untracked AGENTS.md blocks.');
    const projectsFile = path.join(dirs.home, 'projects.json');
    const cleanup = (entries, verify) => {
      const next = { ...entries };
      const directories = new Set([...Object.keys(entries), ...(scan ? hosts.scanAgents(scan) : [])]);
      const errors = [];
      for (const directory of directories) {
        try {
          if (!exists(directory)) { say('Project already gone: ' + directory); continue; }
          if (Object.hasOwn(entries, directory) && lib.projectKey(directory) !== directory) throw new Error('Registered project path changed.');
          const agent = hosts.agentsText(directory, '');
          if (agent.text !== agent.previous) {
            say('Remove managed AGENTS.md block: ' + directory);
            if (!dry) hosts.writeAgents(agent, verify);
          } else say('No managed AGENTS.md block: ' + directory);
          if (Object.hasOwn(entries, directory)) next[directory] = { ...entries[directory], managedAgents: false };
        } catch (error) { say('Could not clean managed AGENTS.md block: ' + directory + ' (' + error.message + ')'); errors.push(directory); }
      }
      if (errors.length) throw new Error('Project AGENTS.md cleanup failed; manifest retained for retry.');
      return next;
    };
    if (dry) cleanup(lib.readProjects(projectsFile), () => {});
    else if (exists(projectsFile) || scan) lib.updateProjects((entries, verify) => cleanup(entries, verify), projectsFile);
  };
  if (manifest.mcpPending && !skipMCP) {
    say('Reconcile interrupted Codex MCP addition.');
    if (!dry) {
      const result = mcp(['mcp', 'get', 'codex']);
      if (result.error || result.status === null) throw new Error('Could not reconcile pending Codex MCP addition; manifest retained for retry.');
      manifest.mcpAdded = result.status === 0;
      manifest.mcpPending = false;
      write(manifestFile, json(manifest));
    }
  }
  if (args.includes('--uninstall')) {
    const removeCodexHook = () => {
      const result = require('./scripts/codex-hooks').update(false, { quotaBossHome: dirs.home, codexDir: dirs.codex }, dry);
      if (result.message) say('Could not remove Codex SessionStart hook: ' + result.message);
      else if (result.changed) say('Remove Quota Boss Codex SessionStart hook (keep hooks.json).');
    };
    if (!previous) { removeCodexHook(); cleanupProjects(); say('No Quota Boss installation manifest found; nothing to uninstall.'); return; }
    // Validate every manifest path before making changes. Never follow directory symlinks.
    for (const entry of manifest.files) {
      const base = entry.kind === 'agent' ? path.join(dirs.claude, 'agents')
        : entry.kind === 'command' ? path.join(dirs.claude, 'commands') : dirs.home;
      if (!inside(base, entry.path)) throw new Error(`Unsafe path in install manifest: ${entry.path}`);
      let parent = path.dirname(entry.path);
      while (inside(base, parent)) {
        if (exists(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error(`Symlink in install path: ${parent}`);
        parent = path.dirname(parent);
      }
      if (exists(base) && fs.lstatSync(base).isSymbolicLink()) throw new Error(`Symlink in install path: ${base}`);
    }
    removeCodexHook();
    saveSettings(settings => {
    if (object(settings.hooks)) {
      for (const hook of manifest.hooks) {
        const entries = settings.hooks[hook.event];
        if (!Array.isArray(entries)) continue;
        settings.hooks[hook.event] = entries.flatMap(entry => {
          if (!Array.isArray(entry?.hooks)) return [entry];
          const remaining = entry.hooks.filter(item => item?.command !== hook.command);
          if (remaining.length === entry.hooks.length) return [entry];
          if (remaining.length || Object.keys(entry).some(key => key !== 'hooks')) return [{ ...entry, hooks: remaining }];
          return [];
        });
        if (settings.hooks[hook.event].length === 0 && hook.createdEvent) delete settings.hooks[hook.event];
      }
      if (!Object.keys(settings.hooks).length && manifest.createdHooks) delete settings.hooks;
    }
    if (manifest.statusLine && settings.statusLine?.command === manifest.statusLine.command) {
      if (manifest.statusLine.previous !== undefined) settings.statusLine = manifest.statusLine.previous;
      else delete settings.statusLine;
    }
    });
    cleanupProjects();
    for (const entry of manifest.files) {
      if (entry.kind === 'config' && !force) continue;
      if ((entry.kind === 'agent' || entry.kind === 'command') && exists(entry.path)) {
        if (fs.lstatSync(entry.path).isSymbolicLink() || !managed(lib.readBounded(entry.path, 1024 * 1024))) {
          say(`Keep unmanaged file ${entry.path}`);
          continue;
        }
      }
      remove(entry.path);
    }
    if (force) remove(path.join(dirs.home, 'state.json'));
    if (manifest.mcpAdded || manifest.mcpPending) {
      if (skipMCP) {
        say('MCP removal skipped; retaining the manifest so it can be retried.');
        return;
      }
      say('Remove Quota Boss-added Codex MCP server.');
      if (!dry) {
        const result = mcp(['mcp', 'remove', 'codex', '--scope', 'user']);
        if (result.status !== 0) throw new Error('Could not remove Codex MCP server; manifest retained for retry.');
      }
    }
    remove(manifestFile);
    say(`Quota Boss uninstalled. ${force ? 'Installed config and state removed.' : 'Config and state kept.'}`);
    return;
  }

  // Validate settings before copying anything; malformed user data must not be replaced.
  if (settings.hooks !== undefined && !object(settings.hooks)) throw new Error('settings.hooks must be an object.');
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    if (settings.hooks?.[event] !== undefined && !Array.isArray(settings.hooks[event])) {
      throw new Error(`settings.hooks.${event} must be an array.`);
    }
  }
  const copyTree = (source, destination, kind) => {
    if (!exists(source)) { say(`Skip missing source ${source}`); return; }
    for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      if (entry.isDirectory()) copyTree(from, to, kind);
      else if (entry.isFile()) {
        const data = lib.readBounded(from, 4 * 1024 * 1024);
        if (kind === 'config' && exists(to)) {
          // A file installed by us stays unchanged on a repeat install. Existing
          // user files always receive a .new, even when identical to defaults.
          if (changed(to, data) || !manifest.files.some(entry => entry.path === to && entry.kind === 'config')) {
            say(`Keep existing config ${to}; ship defaults to ${to}.new`);
            write(`${to}.new`, data);
            remember(`${to}.new`, kind);
          }
        } else { write(to, data); remember(to, kind); }
      } else say(`Skip non-regular source ${from}`);
    }
  };
  // Installs seed config/models.json as a full copy, and that copy would hide every later price and
  // score. Before defaults/ is replaced, drop what still matches it, so only real overrides remain.
  const pruneUnchangedModels = () => {
    const user = path.join(dirs.home, 'config', 'models.json');
    const previous = path.join(dirs.home, 'defaults', 'models.json');
    if (!exists(user) || !exists(previous)) return;
    // add-api writes this file under the same lock, so read, prune and write inside it.
    const pruned = (dry ? f => f(() => {}) : f => lib.withLock(user, f))(verify => {
      let mine, old;
      try { mine = JSON.parse(lib.readBounded(user, 4 * 1024 * 1024)); old = JSON.parse(lib.readBounded(previous, 4 * 1024 * 1024)); }
      catch { return 0; }
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const entries = Object.entries(mine?.models ?? {});
      const kept = entries.filter(([id, model]) => !same(model, old?.models?.[id]));
      if (kept.length === entries.length) return 0;
      const next = { ...mine, models: Object.fromEntries(kept) };
      for (const key of ['$comment', 'categories']) if (same(next[key], old?.[key])) delete next[key];
      say(`Write ${user}`);
      if (!dry) { verify(); verifyInstaller(); atomicWrite(user, json(next), () => { verify(); verifyInstaller(); }); }
      return entries.length - kept.length;
    });
    if (pruned === null) { say(`Skip pruning ${user}: it is busy; run the install again.`); return; }
    if (pruned) say(`Removed ${pruned} unchanged model entries from ${user}, so shipped updates reach them.`);
  };
  pruneUnchangedModels();
  copyTree(path.join(repo, 'scripts'), path.join(dirs.home, 'scripts'), 'script');
  copyTree(path.join(repo, 'agents'), path.join(dirs.home, 'agents'), 'script');
  copyTree(path.join(repo, 'config'), path.join(dirs.home, 'config'), 'config');
  for (const name of ['providers.json', 'models.json']) {
    const shipped = path.join(repo, 'config', name);
    if (!exists(shipped)) continue;
    const target = path.join(dirs.home, 'defaults', name);
    write(target, lib.readBounded(shipped, 1024 * 1024));
    remember(target, 'script');
  }
  const rules = path.join(repo, 'templates', 'RULES.md');
  if (exists(rules)) {
    const target = path.join(dirs.home, 'templates', 'RULES.md');
    write(target, lib.substituteHome(lib.readBounded(rules, 1024 * 1024), dirs.home)); remember(target, 'rules');
    const legacy = path.join(dirs.home, 'RULES.md');
    remove(legacy);
    manifest.files = manifest.files.filter(entry => entry.path !== legacy);
  } else say(`Skip missing source ${rules}`);
  for (const [directory, kind] of [['agents', 'agent'], ['commands', 'command']]) {
    const source = path.join(repo, directory);
    if (!exists(source)) continue;
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const target = path.join(dirs.claude, directory, entry.name);
      if (exists(target) && !force && !managed(lib.readBounded(target, 1024 * 1024))) {
        say(`Skip unmanaged file ${target} (use --force to replace).`); continue;
      }
      // Agents and commands reference installed scripts through a placeholder.
      const text = lib.readBounded(path.join(source, entry.name), 1024 * 1024)
        .split('{{QUOTA_BOSS_HOME}}').join(normalized(dirs.home))
        .split('{{HARNESS_HOME}}').join(normalized(dirs.home));
      write(target, Buffer.from(text, 'utf8'));
      remember(target, kind);
    }
  }

  saveSettings(settings => {
  if (settings.statusLine?.command !== statusCommand) {
    const ours = normalized(settings.statusLine?.command).includes(normalized(path.join(dirs.home, 'scripts', 'statusline.js')))
      || ['quota-boss/scripts/statusline.js', 'harness/scripts/statusline.js'].some(part => normalized(settings.statusLine?.command).includes(part));
    const previousStatus = manifest.statusLine?.previous;
    manifest.statusLine = { command: statusCommand };
    if (previousStatus !== undefined) manifest.statusLine.previous = previousStatus;
    if (settings.statusLine !== undefined && !ours) manifest.statusLine.previous = settings.statusLine;
    if (typeof settings.statusLine?.command === 'string' && !ours) {
      write(wrappedFile, json({ command: settings.statusLine.command }));
      remember(wrappedFile, 'wrapper');
    }
    settings.statusLine = { type: 'command', command: statusCommand, refreshInterval: 30 };
  }
  if (!settings.hooks) { settings.hooks = {}; manifest.createdHooks = true; }
  for (const [event, script] of [['SessionStart', 'hook-session.js'], ['UserPromptSubmit', 'hook-prompt.js']]) {
    const hookCommand = command(script);
    const createdEvent = settings.hooks[event] === undefined;
    const entries = settings.hooks[event] || [];
    let found = false;
    for (const entry of entries) for (const hook of (Array.isArray(entry?.hooks) ? entry.hooks : [])) {
      if (hook?.command === hookCommand || normalized(hook?.command).includes(normalized(path.join(dirs.home, 'scripts', script))) || ['quota-boss/scripts/hook-', 'harness/scripts/hook-'].some(part => normalized(hook?.command).includes(part))) {
        // Upgrade legacy bare-node hooks as well as commands from an earlier Node installation.
        hook.command = hookCommand;
        found = true;
      }
    }
    if (!found) entries.push({ hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] });
    settings.hooks[event] = entries;
    if (!manifest.hooks.some(hook => hook.event === event && hook.command === hookCommand)) {
      const prior = manifest.hooks.find(hook => hook.event === event);
      manifest.hooks.push({ event, command: hookCommand, createdEvent: prior?.createdEvent ?? createdEvent });
    }
  }
  });
  // Workers use `codex exec` (current Codex CLIs no longer ship `mcp-server`). The MCP bridge is
  // opt-in for older Codex versions: `node install.js --mcp`.
  if (skipMCP || !(args.includes('--mcp') || env.QUOTA_BOSS_MCP === '1')) say('Codex MCP bridge not requested (workers use `codex exec`; pass --mcp for old Codex CLIs).');
  else if (!find('codex')) say('Codex is not on PATH; MCP setup skipped.');
  else if (dry) say('Check Codex MCP registration; add a user-scoped server if missing.');
  else {
    const result = mcp(['mcp', 'get', 'codex']);
    if (result.error) say('Could not check Codex MCP registration; ensure claude is on PATH and rerun.');
    else if (result.status !== 0) {
      const codex = find('codex');
      // MCP cannot represent cmd.exe's nested command-line quoting as literal shim
      // arguments to claude.cmd. The installed Node adapter owns that boundary.
      // npm installs a .cmd shim on Windows. Starting the package's JavaScript entry point with the
      // trusted absolute Node executable avoids cmd.exe entirely (no quoting issues, no cwd lookup).
      const npmEntry = platform === 'win32' && /\.cmd$/i.test(codex)
        ? path.join(path.dirname(codex), 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : null;
      const server = npmEntry && exists(npmEntry) && fs.lstatSync(npmEntry).isFile()
        ? [process.execPath, npmEntry, 'mcp-server']
        : platform === 'win32' && /\.cmd$/i.test(codex)
          ? [process.execPath, path.join(dirs.home, 'scripts', 'run-cli.js'), codex, 'mcp-server']
          : [codex, 'mcp-server'];
      manifest.mcpPending = true;
      write(manifestFile, json(manifest));
      const added = mcp(['mcp', 'add', '--scope', 'user', 'codex', '--', ...server]);
      if (added.status === 0) { manifest.mcpPending = false; manifest.mcpAdded = true; say('Added user-scoped Codex MCP server.'); }
      else say('Could not add Codex MCP server; rerun the installer to retry.');
    } else say('Codex MCP server is already registered.');
  }
  manifest.pending = false;
  write(manifestFile, json(manifest));
  say(`Quota Boss ${dry ? 'installation planned' : 'installed'} at ${dirs.home}`);
}

function setupNext(options = {}) {
  const env = options.env || process.env, platform = options.platform || process.platform;
  const find = options.findExecutable || options.find || (name => findExecutable(name, env, platform));
  return find('claude') ? null : 'Next: in your project folder run: node "' + normalized(paths(env).home) + '/scripts/quota-boss.js" setup';
}

/** Offer missing or outdated provider CLIs once, as one list. Without a terminal nothing is installed. */
function offerTools({ ask = lib.askLine, say = console.log, interactive = !!process.stdin.isTTY, options, config } = {}) {
  // Without Claude Code the final "Next:" line already names the terminal setup.
  if (!interactive) { if (!setupNext(options)) say('Run /boss-setup to check and install provider CLIs.'); return; }
  const tools = require('./scripts/tools');
  const ids = tools.enabledIds(config || lib.loadConfig());
  const items = tools.check(ids, options);
  say('Provider CLIs:\n' + tools.report(items));
  const wanted = tools.installable(items).map(item => item.id);
  if (wanted.length && /^y(es)?$/i.test(ask(`Install or update ${wanted.join(', ')} with the commands above? [y/N] `))) say(tools.install(wanted, options));
  else if (wanted.length) say('Nothing installed.');
  say('Logins:\n' + tools.logins(ids, options));
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    install({ args });
    if (!args.includes('--dry-run') && !args.includes('--uninstall')) {
      try { offerTools(); } catch (error) { console.error(`Provider CLI check skipped (${error.message}); run /boss-setup later.`); }
      console.log(setupNext() || 'Next: type /boss-setup in Claude Code. It shows the one command that starts the step-by-step setup in your terminal.');
    }
  } catch (error) { console.error(`Quota Boss installer: ${error.message}`); process.exitCode = 1; }
}

module.exports = { install, offerTools, setupNext };
