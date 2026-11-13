'use strict';
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const lib = require('./lib');

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const validName = name => NAME.test(name || '') && !RESERVED.test(name);
const GIT_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_NAMESPACE|GIT_CEILING_DIRECTORIES|GIT_PREFIX)$/i;
const USAGE = 'Usage: quota-boss worktree add|list|merge|remove|clean [<name>] [--force]';
const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fail = (message, code = 1) => Object.assign(new Error(message), { exitCode: code });

function gitClient(cwd, deps) {
  const env = deps.env || process.env, platform = deps.platform || process.platform;
  const git = (deps.findExecutable || lib.findExecutable)('git', env, platform, cwd);
  if (!git) throw fail('Git not found on the trusted PATH.');
  return (args, directory = cwd, allowed = []) => {
    const options = lib.childProcessOptions(env, platform);
    for (const key of Object.keys(options.env)) if (GIT_ENV.test(key)) delete options.env[key];
    const result = (deps.spawnSync || childProcess.spawnSync)(git, args, {
      ...options, cwd: directory, shell: false, windowsHide: true,
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0 && !allowed.includes(result.status)) {
      const first = String(result.stderr || '').trim().split(/\r?\n/)[0];
      throw fail(clean(first || result.error?.message || 'Git exited with status ' + result.status).slice(0, 200));
    }
    return result;
  };
}

function repository(cwd, deps) {
  cwd = fs.realpathSync(cwd);
  const git = gitClient(cwd, deps);
  const root = fs.realpathSync(git(['rev-parse', '--show-toplevel']).stdout.trimEnd());
  const common = fs.realpathSync(path.resolve(cwd, git(['rev-parse', '--git-common-dir']).stdout.trimEnd()));
  const local = fs.realpathSync(path.resolve(cwd, git(['rev-parse', '--git-dir']).stdout.trimEnd()));
  if (!same(common, local)) throw fail('Run worktree commands from the main worktree.');
  return { git, root, folder: path.join(path.dirname(root), path.basename(root) + '.qb-worktrees') };
}

function copies(repo) {
  return repo.git(['worktree', 'list', '--porcelain', '-z'], repo.root).stdout.split('\0\0').filter(Boolean).map(block => {
    const fields = block.split('\0');
    return { path: fields.find(field => field.startsWith('worktree '))?.slice(9),
      branch: fields.find(field => field.startsWith('branch '))?.slice(7) };
  }).filter(entry => entry.branch?.startsWith('refs/heads/qb/')).map(entry => ({ ...entry, name: entry.branch.slice(14) }));
}

// Deletion is limited to a direct child of the sibling folder, with no redirected parents.
function copyPath(repo, name) {
  const target = path.join(repo.folder, name);
  for (const directory of [repo.folder, target]) {
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !same(fs.realpathSync(directory), directory)) {
        throw fail('Worker copy path must stay inside ' + clean(repo.folder) + '.');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

function registered(repo, name) {
  const target = copyPath(repo, name);
  const entry = copies(repo).find(copy => copy.name === name && same(path.resolve(copy.path), target));
  if (!entry) throw fail('No registered worker copy ' + name + ' at ' + clean(target) + '.');
  return target;
}

function dirty(repo, target, tracked = false) {
  return repo.git(['--no-optional-locks', '-C', target, 'status', '--porcelain', ...(tracked ? ['--untracked-files=no'] : [])], repo.root).stdout.trim() !== '';
}

function branches(repo) {
  return repo.git(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/qb/'], repo.root).stdout.trim().split('\n').filter(Boolean);
}

function merged(repo, name) {
  const branch = 'qb/' + name;
  const base = repo.git(['merge-base', 'HEAD', branch], repo.root).stdout.trim();
  const files = repo.git(['diff', '--name-only', '-z', base, branch], repo.root).stdout.split('\0').filter(Boolean);
  return files.length === 0 || repo.git(['--literal-pathspecs', 'diff', '--quiet', 'HEAD', branch, '--', ...files], repo.root, [1]).status === 0;
}

function ahead(repo, name) {
  const branch = 'qb/' + name;
  const base = repo.git(['merge-base', 'HEAD', branch], repo.root).stdout.trim();
  const count = repo.git(['rev-list', '--count', base + '..' + branch], repo.root).stdout.trim();
  if (!/^\d+$/.test(count)) throw fail('Invalid Git commit count.');
  return Number(count) > 0;
}

function removeCopy(repo, name, force) {
  const target = registered(repo, name);
  if (!force) {
    const ignored = repo.git(['--no-optional-locks', '-C', target, 'status', '--porcelain', '--ignored', '--untracked-files=all'], repo.root)
      .stdout.split(/\r?\n/).filter(line => line.startsWith('!!')).length;
    if (ignored) throw fail('Worker copy ' + name + ' holds ' + ignored + ' ignored files. Use --force to drop them.');
    if (dirty(repo, target)) throw fail('Worker copy ' + name + ' has work. Use --force to drop them.');
  }
  try { repo.git(['worktree', 'remove', ...(force ? ['--force'] : []), target], repo.root); }
  catch (error) { throw Object.assign(fail('Could not remove worker copy ' + name + ' (' + error.message
    + '); kept branch qb/' + name + '.'), { cause: error }); }
  // rmdir cannot remove contents; never recursively delete a worker folder ourselves.
  try { if (fs.existsSync(repo.folder) && fs.readdirSync(repo.folder).length === 0) fs.rmdirSync(repo.folder); }
  catch { /* An empty sibling container can be left in place. */ }
}

function removeBranch(repo, name, force, removedCopy = false) {
  const prefix = removedCopy ? 'Removed worker copy ' + name + '; could not ' : 'Could not ';
  if (!force) {
    let isMerged;
    try { isMerged = merged(repo, name); }
    catch (error) { throw fail(prefix + 'check whether branch qb/' + name + ' is merged (' + error.message + '); kept the branch.'); }
    if (!isMerged) return 'Kept branch qb/' + name + ': its work is not committed in HEAD.';
  }
  try { repo.git(['branch', '-D', 'qb/' + name], repo.root); }
  catch (error) { throw fail(prefix + 'delete branch qb/' + name + ' (' + error.message + ').'); }
  return '';
}

function remove(repo, name, force) {
  removeCopy(repo, name, force);
  return removeBranch(repo, name, force, true);
}

function merge(repo, name) {
  const target = registered(repo, name);
  if (dirty(repo, repo.root, true)) throw fail('Commit or stash your changes in the main folder first, then merge again.');
  if (dirty(repo, target)) {
    repo.git(['add', '-A'], target);
    const email = repo.git(['config', 'user.email'], target, [1]).stdout.trim();
    const user = repo.git(['config', 'user.name'], target, [1]).stdout.trim();
    const identity = email && user ? [] : ['-c', 'user.name=quota-boss', '-c', 'user.email=quota-boss@localhost'];
    repo.git([...identity, '-c', 'commit.gpgsign=false', 'commit', '-m', 'quota-boss worker copy ' + name], target);
  }
  if (!ahead(repo, name)) {
    remove(repo, name, false);
    return 'Nothing to merge from ' + name + '.';
  }
  try { repo.git(['merge', '--squash', 'qb/' + name], repo.root); }
  catch (error) {
    const conflicts = repo.git(['diff', '--name-only', '--diff-filter=U', '-z'], repo.root).stdout.split('\0').filter(Boolean);
    if (conflicts.length) throw fail(error.message + '\nConflicted files:\n' + conflicts.slice(0, 20).map(clean).join('\n')
      + '\nResolve the conflicts, run the check, then: quota-boss worktree remove ' + name
      + ' --force. To undo the merge instead: git reset --merge');
    throw error;
  }
  try { removeCopy(repo, name, true); }
  catch (error) { return 'Merged ' + name + '; could not remove its copy (' + (error.cause?.message || error.message)
    + '). Run quota-boss worktree clean later.'; }
  return 'Merged ' + name + ' into the main folder as uncommitted changes. Read the diff, run the check once, then commit.';
}

function run(argv, cwd = process.cwd(), deps = {}) {
  const [action, name, flag] = argv;
  if (!['add', 'list', 'merge', 'remove', 'clean'].includes(action)
    || action === 'list' && argv.length !== 1
    || action === 'clean' && (argv.length > 2 || name !== undefined && name !== '--force')
    || ['add', 'merge', 'remove'].includes(action) && (!validName(name)
      || argv.length > (action === 'remove' ? 3 : 2) || flag !== undefined && flag !== '--force')) throw fail(USAGE, 2);
  const repo = repository(cwd, deps);
  if (action === 'list') {
    const entries = copies(repo);
    const rows = entries.map(entry => clean(entry.name) + '\t' + clean(path.resolve(entry.path)) + '\t'
      + (!fs.existsSync(entry.path) ? 'missing' : dirty(repo, entry.path) ? 'changed' : 'clean'));
    for (const branch of branches(repo)) if (!entries.some(entry => entry.branch === 'refs/heads/' + branch)) {
      rows.push(clean(branch.slice(3)) + '\tbranch only');
    }
    return rows.join('\n') || 'No worker copies.';
  }
  if (action === 'add') {
    const target = copyPath(repo, name);
    if (branches(repo).includes('qb/' + name)) throw fail('Branch qb/' + name + ' already exists: run quota-boss worktree list or clean, or pick another name.');
    if (fs.existsSync(target)) throw fail('Worker copy path already exists: ' + name + '.');
    const changed = dirty(repo, repo.root, true);
    repo.git(['worktree', 'add', '-b', 'qb/' + name, target, 'HEAD'], repo.root);
    return clean(target) + '\nPass it as WORKDIR: in the handover. Uncommitted changes in the main folder are not in the copy.'
      + '\nWhen the worker is done: quota-boss worktree merge ' + name + ', resolve any conflict, run the check once, commit. At task end: quota-boss worktree clean.'
      + (changed ? '\nWarning: the main folder has uncommitted tracked changes.' : '');
  }
  if (action === 'merge') return merge(repo, name);
  if (action === 'remove') {
    const kept = remove(repo, name, flag === '--force');
    return 'Removed ' + name + '.' + (kept ? '\n' + kept : '');
  }
  const removed = [], kept = [];
  const entries = copies(repo);
  const force = name === '--force';
  for (const entry of entries) {
    try {
      if (!validName(entry.name)) throw fail('Invalid worker copy name.');
      registered(repo, entry.name);
      if (!fs.existsSync(entry.path)) continue;
      const branchKept = remove(repo, entry.name, force);
      removed.push(clean(entry.name));
      if (branchKept) kept.push(branchKept);
    } catch (error) { kept.push(clean(entry.name) + ' (' + clean(error.message) + ')'); }
  }
  try { repo.git(['worktree', 'prune', '--expire', 'now'], repo.root); }
  catch (error) { throw fail('Could not prune missing worker registrations (' + error.message + ').\nRemoved: '
    + (removed.join(', ') || 'none') + '.\nKept: ' + (kept.join(', ') || 'none') + '.'); }
  const remaining = copies(repo);
  for (const branch of branches(repo)) {
    const branchName = branch.slice(3);
    if (remaining.some(entry => entry.branch === 'refs/heads/' + branch)
      || removed.includes(branchName) || kept.some(message => message.startsWith(branchName + ' ('))) continue;
    try {
      if (!validName(branchName)) throw fail('Invalid worker copy name.');
      const branchKept = removeBranch(repo, branchName, force);
      if (branchKept) kept.push(branchKept);
      else removed.push(clean(branchName));
    } catch (error) { kept.push(clean(branchName) + ' (' + clean(error.message) + ')'); }
  }
  return 'Removed: ' + (removed.join(', ') || 'none') + '.\nKept: ' + (kept.join(', ') || 'none') + '.';
}

/** Config stays in cwd; only a registered qb branch may supply an alternate workspace. */
function resolveWorkdir(dir, cwd = process.cwd(), deps = {}) {
  try {
    const project = fs.realpathSync(cwd), target = fs.realpathSync(path.resolve(cwd, dir));
    if (!fs.statSync(target).isDirectory()) throw fail('Not a directory.');
    if (same(project, target)) return target;
    const repo = repository(project, deps);
    const entry = copies(repo).find(copy => same(path.resolve(copy.path), target));
    if (entry && validName(entry.name) && same(registered(repo, entry.name), target)) return target;
  } catch (error) { throw fail('Invalid --cwd: ' + clean(error.message).slice(0, 200), 2); }
  throw fail('Invalid --cwd: use the current project directory or a registered qb worker copy.', 2);
}

module.exports = { run, resolveWorkdir };
