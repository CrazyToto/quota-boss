'use strict';
// Finds, installs and updates the official CLIs of enabled providers, only after the user agreed.
// Install commands live in this file on purpose: providers.json is user- and merge-editable, so a
// config file can never supply a command. Pipe-to-shell installers are shown to paste, never run.

const child = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');
const { version, older } = require('./diagnostics');

const QUERY_TIMEOUT = 20 * 1000;
const INSTALL_TIMEOUT = 10 * 60 * 1000;
const MAX_STATUS_BYTES = 256 * 1024;
const NPM_REGISTRY = '--registry=https://registry.npmjs.org/';
const WINGET_FLAGS = ['-e', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'];

const npm = pkg => ({ manager: 'npm', args: ['install', '-g', pkg + '@latest', NPM_REGISTRY], latestPackage: pkg });
const winget = id => ({ manager: 'winget', args: ['install', '--id', id, ...WINGET_FLAGS] });

const REGISTRY = Object.freeze({
  claude: { label: 'Claude Code', binary: 'claude', source: 'https://www.npmjs.com/package/@anthropic-ai/claude-code', selfUpdating: true,
    install: { all: npm('@anthropic-ai/claude-code') },
    login: { command: 'claude auth login', run: ['auth', 'login'], check: ['auth', 'status'], loggedIn: /"loggedIn"\s*:\s*true/ } },
  codex: { label: 'Codex', binary: 'codex', source: 'https://www.npmjs.com/package/@openai/codex',
    install: { all: npm('@openai/codex') },
    login: { command: 'codex login', run: ['login'], check: ['login', 'status'], loggedIn: /^(Logged in|API key configured)/m } },
  copilot: { label: 'GitHub Copilot', binary: 'copilot', source: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
    install: { all: npm('@github/copilot') },
    login: { command: 'copilot login', run: ['login'], statusFile: { env: 'COPILOT_HOME', dir: '.copilot', file: 'config.json', field: 'loggedInUsers' } } },
  'opencode-free': { label: 'OpenCode', binary: 'opencode', source: 'https://opencode.ai/docs',
    install: { all: npm('opencode-ai') },
    login: { command: 'opencode auth login', run: ['auth', 'login'], optional: true } },
  'kilo-free': { label: 'Kilo', binary: 'kilo', source: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
    install: { all: npm('@kilocode/cli') } },
  // Not a provider: only the setup installs it, after asking. `graphify install` registers its Claude Code skill.
  graphify: { label: 'Graphify', binary: 'graphify', source: 'https://github.com/Graphify-Labs/graphify', noVersionCheck: true, postInstall: ['install'],
    install: { all: { manager: 'uv', args: ['tool', 'install', '--default-index', 'https://pypi.org/simple', 'graphifyy'] } } },
  ollama: { label: 'Ollama', binary: 'ollama', source: 'https://ollama.com/download',
    install: { win32: winget('Ollama.Ollama'), darwin: { manager: 'brew', args: ['install', 'ollama'] } } },
  grok: { label: 'Grok Build', binary: 'grok', source: 'https://github.com/xai-org/grok-build', install: {},
    paste: { win32: 'irm https://x.ai/cli/install.ps1 | iex', all: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
    login: { command: 'grok login', run: ['login'] } },
  antigravity: { label: 'Antigravity', binary: 'agy', source: 'https://antigravity.google/docs/install', install: {},
    note: 'Google only offers an install script; follow the official guide. It replaced Gemini CLI for free and Google One users.',
    login: { command: 'agy', run: [] } },
});

/** Package managers some tools need first, offered in the same list. */
const PREREQUISITES = Object.freeze({ uv: { win32: winget('astral-sh.uv'), darwin: { manager: 'brew', args: ['install', 'uv'] } } });

/** The alias is a link into the admin-protected app folder, and that publisher id is Microsoft's. */
function isWingetTarget(target) {
  return /^[a-z]:\\Program Files\\WindowsApps\\Microsoft\.DesktopAppInstaller_[^\\]+__8wekyb3d8bbwe\\winget\.exe$/i.test(String(target));
}

/** Tools winget publishes as a link in its Links folder, with the only package folder they may point into. */
const WINGET_LINKS = Object.freeze({ uv: 'astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe' });

function isWingetPackageTarget(name, target, localAppData) {
  if (!Object.hasOwn(WINGET_LINKS, name)) return false;
  const expected = path.win32.join(localAppData, 'Microsoft', 'WinGet', 'Packages', WINGET_LINKS[name], name + '.exe');
  return String(target).toLowerCase() === expected.toLowerCase();
}

/** The strict PATH lookup rejects links, so a winget tool is accepted only if its link has the exact expected target. */
function wingetLinked(name, env) {
  if (!Object.hasOwn(WINGET_LINKS, name) || !env.LOCALAPPDATA || !path.win32.isAbsolute(env.LOCALAPPDATA)) return null;
  try {
    const target = fs.readlinkSync(path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', name + '.exe'));
    if (!isWingetPackageTarget(name, target, env.LOCALAPPDATA)) return null;
    lib.regularStat(target);
    return target;
  } catch { return null; }
}

/** winget itself is a Store app alias, which the strict PATH lookup rejects, so it is identified by its link target. */
function locate(name, env, platform) {
  if (platform !== 'win32') return lib.findExecutable(name, env, platform);
  if (name !== 'winget') return lib.findExecutable(name, env, platform) || wingetLinked(name, env);
  if (!env.LOCALAPPDATA || !path.win32.isAbsolute(env.LOCALAPPDATA)) return null;
  const file = path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe');
  try { return isWingetTarget(fs.readlinkSync(file)) ? file : null; } catch { return null; }
}

/** Environment overrides could point the official package names at another registry. */
function managerEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_config_|^uv_(.*_)?index/i.test(key)));
}

function context(options = {}) {
  const env = managerEnv(options.env || process.env), platform = options.platform || process.platform;
  const spawnSync = options.spawnSync || child.spawnSync;
  return { platform, env, home: options.home || env.USERPROFILE || env.HOME || null, find: options.find || (name => locate(name, env, platform)),
    call: (file, args, timeout) => lib.runExecutable(file, args, { platform, env, spawnSync, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }),
    attach: (file, args) => platform === 'win32' ? lib.runInNewWindow(file, args, { env, spawnSync })
      : lib.runExecutable(file, args, { platform, env, spawnSync, stdio: 'inherit' }) };
}

/**
 * For a CLI with no status command. Looks only at whether one non-secret field lists a user, and returns just
 * yes or no: nothing from the file is kept, shown or passed on.
 */
function statusFileSaysLoggedIn(status, d) {
  const override = d.env[status.env];
  const dir = override && path.isAbsolute(override) ? override : d.home && path.join(d.home, status.dir);
  if (!dir) return false;
  const file = path.join(dir, status.file);
  try {
    lib.regularStat(file);
    if (fs.statSync(file).size > MAX_STATUS_BYTES) return false;
    const users = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''))[status.field];
    return Array.isArray(users) && users.length > 0;
  } catch { return false; }
}

const output = result => String(result?.stdout || '') + '\n' + String(result?.stderr || '');
const succeeded = result => !!result && !result.error && result.status === 0;
const display = route => route.manager + ' ' + route.args.join(' ');
const routeOf = (tool, platform) => tool.install[platform] || tool.install.all || null;
const prerequisiteOf = (route, platform) => (route && PREREQUISITES[route.manager]?.[platform]) || null;

function latestVersion(route, d) {
  const manager = route?.latestPackage && d.find('npm');
  if (!manager) return null;
  const result = d.call(manager, ['view', route.latestPackage, 'version', NPM_REGISTRY], QUERY_TIMEOUT);
  return succeeded(result) ? version(result.stdout) || null : null;
}

function byHand(item, tool, route, platform) {
  const paste = tool.paste && (tool.paste[platform] || tool.paste.all);
  const note = paste ? 'official script; paste this into a terminal yourself: ' + paste
    : tool.note || (route ? 'needs ' + route.manager + ', which is not installed' : 'no automatic install on this system');
  return { ...item, state: 'manual', note };
}

function inspect(id, d) {
  const tool = REGISTRY[id];
  const route = routeOf(tool, d.platform);
  const after = tool.postInstall ? ' && ' + tool.binary + ' ' + tool.postInstall.join(' ') : '';
  const item = { id, source: tool.source, command: route ? display(route) + after : null, installed: null, latest: null };
  const usable = route && d.find(route.manager);
  const binary = d.find(tool.binary);
  if (binary && tool.noVersionCheck) return { ...item, installed: 'version unknown', state: 'ok' };
  if (binary) {
    const result = d.call(binary, ['--version'], QUERY_TIMEOUT);
    // 127 is "not found": a placeholder such as VS Code's copilot shim, not a damaged install.
    if (result.status === 127 && usable) return { ...item, state: 'missing' };
    if (!succeeded(result)) return usable ? { ...item, state: 'broken' } : byHand({ ...item, installed: 'not starting' }, tool, route, d.platform);
    item.installed = version(result.stdout) || 'version unknown';
    if (!tool.selfUpdating) item.latest = latestVersion(route, d);
    const stale = item.latest && item.installed !== 'version unknown' && older(item.installed, item.latest);
    return { ...item, state: stale && usable ? 'outdated' : 'ok' };
  }
  if (usable) return { ...item, state: 'missing' };
  const prerequisite = prerequisiteOf(route, d.platform);
  if (prerequisite && d.find(prerequisite.manager)) return { ...item, state: 'missing', command: display(prerequisite) + ' && ' + item.command };
  return byHand(item, tool, route, d.platform);
}

/** Every API added through OpenCode needs the one OpenCode CLI. */
function enabledIds(config) {
  const ids = new Set();
  for (const [id, provider] of Object.entries(config.providers.providers)) {
    if (provider?.enabled === false) continue;
    if (Object.hasOwn(REGISTRY, id)) ids.add(id);
    else if (provider?.cli?.command === 'opencode') ids.add('opencode-free');
    else if (provider?.cli?.command === 'kilo') ids.add('kilo-free');
  }
  return [...ids];
}

const check = (ids, options) => { const d = context(options); return ids.map(id => inspect(id, d)); };
const INSTALLABLE = new Set(['missing', 'outdated', 'broken']);
const installable = items => items.filter(item => INSTALLABLE.has(item.state));

function describe(item) {
  if (item.state === 'ok') return 'ok (' + item.installed + ')';
  if (item.state === 'manual') return 'install by hand: ' + item.source + ' (' + item.note + ')';
  const change = item.state === 'outdated' ? 'outdated (' + item.installed + ' -> ' + item.latest + ')'
    : item.state === 'broken' ? 'installed but not starting, reinstall' : 'missing';
  return change + ' | ' + item.command + ' | ' + item.source;
}

function report(items) {
  return [...items.map(item => '- ' + item.id + ': ' + describe(item)),
    'Installable: ' + (installable(items).map(item => item.id).join(' ') || '(none)')].join('\n');
}

function failureText(result) {
  if (result.error) return 'could not start the installer';
  const last = output(result).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || 'exit ' + result.status;
  return last.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160);
}

function installOne(id, d) {
  const before = inspect(id, d);
  if (!INSTALLABLE.has(before.state)) return '- ' + id + ': skipped (' + before.state + ')';
  const route = routeOf(REGISTRY[id], d.platform);
  if (!d.find(route.manager)) {
    const prerequisite = prerequisiteOf(route, d.platform);
    const prepared = d.call(d.find(prerequisite.manager), prerequisite.args, INSTALL_TIMEOUT);
    if (!succeeded(prepared)) return '- ' + id + ': FAILED (' + route.manager + ': ' + failureText(prepared) + ')';
    if (!d.find(route.manager)) return '- ' + id + ': ' + route.manager + ' installed; open a new terminal and run this setup once more to finish';
  }
  const result = d.call(d.find(route.manager), route.args, INSTALL_TIMEOUT);
  if (!succeeded(result)) return '- ' + id + ': FAILED (' + failureText(result) + ')';
  const after = inspect(id, d);
  if (after.state === 'ok' && REGISTRY[id].postInstall) {
    const setupStep = d.call(d.find(REGISTRY[id].binary), REGISTRY[id].postInstall, INSTALL_TIMEOUT);
    if (!succeeded(setupStep)) return '- ' + id + ': FAILED (installed, but its setup step failed: ' + failureText(setupStep) + ')';
  }
  if (after.state === 'ok') return '- ' + id + ': installed (' + after.installed + ')';
  if (after.state === 'outdated') return '- ' + id + ': installed, but an older copy still comes first on PATH (' + after.installed + ')';
  if (after.state === 'broken') return '- ' + id + ': FAILED (installed but does not start)';
  if (route && route.manager === 'uv' && after.state === 'missing') return '- ' + id + ': installed, but its folder is not on PATH. Run: uv tool update-shell, then open a new terminal';
  return '- ' + id + ': installed; open a new terminal if it is not found yet';
}

/** One tool failing never stops the others; each id gets exactly one result line. */
function install(ids, options) {
  const d = context(options);
  return ids.map(id => installOne(id, d)).join('\n');
}

function logins(ids, options) {
  const d = context(options);
  const lines = [];
  for (const id of ids) {
    const login = REGISTRY[id].login, binary = login && d.find(REGISTRY[id].binary);
    if (!binary) continue;
    if (login.statusFile && statusFileSaysLoggedIn(login.statusFile, d)) { lines.push('- ' + id + ': logged in'); continue; }
    if (!login.check) { lines.push('- ' + id + ': cannot be checked automatically; ' + (login.optional ? 'only if needed' : 'if not done yet') + ', run: ' + login.command); continue; }
    const result = d.call(binary, login.check, QUERY_TIMEOUT);
    if (result.error) lines.push('- ' + id + ': could not check');
    else lines.push('- ' + id + ': ' + (succeeded(result) && login.loggedIn.test(output(result)) ? 'logged in' : 'NOT logged in, run: ' + login.command));
  }
  return lines.join('\n') || 'No logins to check.';
}

/** Logins still to do: installed tools that report no login, and tools that cannot report it at all. */
function pendingLogins(ids, options) {
  const d = context(options);
  const pending = [];
  for (const id of ids) {
    const tool = REGISTRY[id], login = tool.login, binary = login?.run && d.find(tool.binary);
    if (!binary) continue;
    if (login.statusFile && statusFileSaysLoggedIn(login.statusFile, d)) continue;
    if (login.check) {
      const result = d.call(binary, login.check, QUERY_TIMEOUT);
      if (succeeded(result) && login.loggedIn.test(output(result))) continue;
    }
    pending.push({ id, command: [tool.binary, ...login.run].join(' '), checkable: !!(login.check || login.statusFile), optional: !!login.optional, newWindow: d.platform === 'win32' });
  }
  return pending;
}

/** Starts a login, in its own window on Windows. The arguments come only from the shipped registry. */
function runLogin(id, options) {
  const d = context(options);
  const tool = REGISTRY[id];
  return d.attach(d.find(tool.binary), tool.login.run);
}

function storedKeys(options) {
  try {
    const d = context(options), binary = d.find('opencode');
    if (!binary) return '';
    const result = d.call(binary, ['auth', 'list'], QUERY_TIMEOUT);
    if (!succeeded(result)) return '';
    return String(result.stdout || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').toLowerCase();
  } catch { return ''; }
}

function runKeyLogin(provider, options) {
  if (typeof provider !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider)) throw new Error('Invalid OpenCode provider id.');
  const d = context(options);
  return d.attach(d.find('opencode'), ['auth', 'login', '-p', provider]);
}

function openPage(url, options) {
  if (typeof url !== 'string' || !/^https:\/\/[a-z0-9.-]+\/[a-zA-Z0-9._\/-]*$/.test(url)) return false;
  try {
    const d = context(options);
    const command = d.platform === 'win32' ? 'rundll32' : d.platform === 'darwin' ? 'open' : 'xdg-open';
    const binary = d.find(command);
    if (!binary) return false;
    const args = d.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    return succeeded(d.call(binary, args, QUERY_TIMEOUT));
  } catch { return false; }
}

/** CLI entry: `tools`, `tools install <ids>` or `tools logins`, always limited to enabled providers. */
function command(args, config, options) {
  const enabled = enabledIds(config);
  if (!args.length) return report(check(enabled, options));
  if (args[0] === 'logins' && args.length === 1) return logins(enabled, options);
  if (args[0] === 'install' && args.length > 1) {
    const ids = [...new Set(args.slice(1))];
    if (ids.some(id => !enabled.includes(id))) throw new Error('tools install accepts only enabled providers with a known CLI: ' + enabled.join(' '));
    const result = install(ids, options);
    if (/: FAILED \(/.test(result)) process.exitCode = 1;
    return result;
  }
  throw new Error('Usage: quota-boss tools | tools install <id...> | tools logins');
}

module.exports = { REGISTRY, enabledIds, check, installable, report, install, logins, pendingLogins, runLogin, storedKeys, runKeyLogin, openPage, command, isWingetTarget, isWingetPackageTarget, managerEnv };
