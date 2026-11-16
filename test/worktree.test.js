'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('../scripts/lib');
const worktree = require('../scripts/worktree');
const cli = path.resolve(__dirname, '../scripts/quota-boss.js');
const git = lib.findExecutable('git');
const available = git && spawnSync(git, ['--version'], { windowsHide: true }).status === 0;

function fixture(t, identity = true, suffix = '') {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-worktree-test-')));
  t.after(() => {
    const resolved = fs.realpathSync.native(temp);
    assert.equal(resolved, temp);
    assert.ok(path.basename(resolved).startsWith('qb-worktree-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const root = path.join(temp, 'repo' + suffix), folder = root + '.qb-worktrees';
  fs.mkdirSync(root);
  // Ignore the machine's Git identity, hooks, signing and repository overrides.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temp, 'empty-config'),
    QUOTA_BOSS_HOME: path.join(temp, 'home') });
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  fs.mkdirSync(env.QUOTA_BOSS_HOME);
  const call = (args, cwd = root, allowed = [0]) => {
    const result = spawnSync(git, args, { cwd, env, shell: false, windowsHide: true, encoding: 'utf8' });
    assert.ok(allowed.includes(result.status), result.stderr || result.error?.message);
    return result.stdout.trimEnd();
  };
  call(['init', '-b', 'main']);
  call(['config', 'core.autocrlf', 'false']);
  call(['config', 'core.hooksPath', path.join(temp, 'no-hooks')]);
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
  call(['add', '.']);
  call(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'base']);
  if (identity) {
    call(['config', 'user.name', 'Test']);
    call(['config', 'user.email', 'test@localhost']);
  }
  const run = (...args) => worktree.run(args, root, { env });
  const add = (name, ...options) => { run('add', name, ...options); return path.join(folder, name); };
  const command = (...args) => spawnSync(process.execPath, [cli, 'worktree', ...args], {
    cwd: root, env, encoding: 'utf8', windowsHide: true, shell: false,
  });
  return { root, temp, folder, env, call, run, add, command };
}

describe('worker worktrees', { skip: !available && 'Git unavailable' }, () => {
  test('scope normalizes repo paths and stores them in the common dir even from a subdirectory', t => {
    const f = fixture(t), nested = path.join(f.root, 'nested');
    fs.mkdirSync(nested);
    const output = worktree.run(['add', 'scoped', '--scope', './src\\,./file.txt'], nested, { env: f.env });
    assert.match(output, /\nSCOPE: src\/,file.txt$/);
    assert.equal(fs.readFileSync(path.join(f.root, '.git', 'qb-scope', 'scoped'), 'utf8'), 'src/\nfile.txt\n');
    assert.equal(fs.existsSync(path.join(f.root, 'nested', '.git')), false);
  });

  for (const value of ['src', 'src/.']) {
    test('scope treats an existing main directory as a prefix: ' + value, t => {
      const f = fixture(t), nested = path.join(f.root, 'nested');
      fs.mkdirSync(nested);
      fs.mkdirSync(path.join(f.root, 'src'));
      fs.writeFileSync(path.join(f.root, 'src', 'existing.txt'), 'base\n');
      f.call(['add', 'src']); f.call(['commit', '-m', 'source directory']);
      const output = worktree.run(['add', 'directory', '--scope', value], nested, { env: f.env });
      assert.match(output, /SCOPE: src\/$/);
      assert.equal(fs.readFileSync(path.join(f.root, '.git', 'qb-scope', 'directory'), 'utf8'), 'src/\n');
      const target = path.join(f.folder, 'directory');
      fs.writeFileSync(path.join(target, 'src', 'new.txt'), 'worker\n');
      assert.match(f.run('merge', 'directory'), /^Merged directory into/);
      assert.equal(f.call(['diff', '--cached', '--name-only']), 'src/new.txt');
    });
  }

  test('invalid scopes and malformed options fail before creating a copy or branch', t => {
    const f = fixture(t);
    for (const value of [',file.txt', 'file.txt,', 'a,,b', '/absolute', '\\absolute', '//server/share',
      'C:/absolute', 'C:relative', './C:/drive', '../outside', 'src/../file.txt', 'src\\..\\file.txt',
      '.qb-plan.md', './.qb-plan.md', '.qb-plan.md/', '.', './', 'line\nbreak']) {
      assert.throws(() => f.run('add', 'bad', '--scope', value), error => error.exitCode === 2, value);
    }
    for (const args of [['--scope'], ['--plan'], ['--scope', ''], ['--scope', 'a', '--scope', 'b'],
      ['--plan', 'missing', '--plan', 'missing'], ['--other', 'x'], ['extra']]) {
      assert.throws(() => f.run('add', 'bad', ...args));
    }
    assert.equal(f.call(['branch', '--list', 'qb/bad']), '');
    assert.equal(fs.existsSync(f.folder), false);
    assert.throws(() => f.run('merge', 'one', 'one'), error => error.exitCode === 2);
  });

  test('plan copies bytes, creates the shared exclude and never duplicates its line', t => {
    const f = fixture(t), plan = path.join(f.temp, 'plan.md');
    const contents = Buffer.from('GOAL: split\r\nBASE: fixed\r\n');
    fs.writeFileSync(plan, contents);
    const exclude = path.join(f.root, '.git', 'info', 'exclude');
    fs.unlinkSync(exclude);
    fs.rmdirSync(path.dirname(exclude));
    const output = f.run('add', 'one', '--scope', 'file.txt', '--plan', plan);
    assert.match(output, /\nSCOPE: file.txt\nPLAN: \.qb-plan.md \(read it first\)$/);
    assert.deepEqual(fs.readFileSync(path.join(f.folder, 'one', '.qb-plan.md')), contents);
    fs.writeFileSync(exclude, '# keep without a final newline');
    f.add('two', '--plan', plan);
    f.add('three', '--plan', plan);
    assert.equal(fs.readFileSync(exclude, 'utf8'), '# keep without a final newline\n.qb-plan.md\n');
    for (const name of ['one', 'two', 'three']) assert.equal(f.call(['status', '--porcelain'], path.join(f.folder, name)), '');
    fs.writeFileSync(path.join(f.folder, 'one', 'file.txt'), 'worker\n');
    f.run('merge', 'one');
    assert.equal(f.call(['ls-tree', '--name-only', 'qb/one']), 'file.txt');
    assert.equal(fs.existsSync(path.join(f.folder, 'one')), true);
  });

  test('directory and missing plans fail with usage status before creating anything', t => {
    const f = fixture(t);
    for (const plan of [f.temp, path.join(f.temp, 'missing')]) {
      const result = f.command('add', 'bad-plan', '--scope', 'file.txt', '--plan', plan);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /Invalid plan file:.*\nUsage:/);
      assert.equal(f.call(['branch', '--list', 'qb/bad-plan']), '');
      assert.equal(fs.existsSync(path.join(f.root, '.git', 'qb-scope', 'bad-plan')), false);
      assert.equal(fs.existsSync(f.folder), false);
    }
  });

  for (const failure of ['worktree add', 'partial worktree add', 'plan copy']) {
    test('add rolls back scope, copy and branch after failed ' + failure + ' and permits retry', t => {
      const f = fixture(t), plan = path.join(f.temp, 'plan.md');
      fs.writeFileSync(plan, 'plan\n');
      const scope = path.join(f.root, '.git', 'qb-scope', 'retry');
      const target = path.join(f.folder, 'retry');
      assert.throws(() => worktree.run(['add', 'retry', '--scope', 'file.txt', '--plan', plan], f.root,
        { env: f.env, spawnSync(file, args, options) {
          if (args[0] === 'worktree' && args[1] === 'add') {
            assert.equal(fs.readFileSync(scope, 'utf8'), 'file.txt\n');
            if (failure !== 'worktree add') {
              const result = spawnSync(file, args, options);
              assert.equal(result.status, 0, result.stderr);
              if (failure === 'plan copy') {
                fs.mkdirSync(path.join(target, '.qb-plan.md'));
                return result;
              }
            }
            return { status: 1, stderr: 'injected worktree add failure' };
          }
          return spawnSync(file, args, options);
        } }), failure === 'plan copy' ? /EISDIR|EPERM|EACCES/ : /injected worktree add failure/);
      assert.equal(fs.existsSync(scope), false);
      assert.equal(fs.existsSync(target), false);
      assert.equal(f.call(['branch', '--list', 'qb/retry']), '');
      assert.doesNotThrow(() => f.add('retry', '--scope', 'file.txt', '--plan', plan));
    });
  }

  test('an invalid scope file identifies its copy and path before committing worker changes', t => {
    const f = fixture(t), target = f.add('invalid', '--scope', 'file.txt');
    const scope = path.join(f.root, '.git', 'qb-scope', 'invalid');
    fs.writeFileSync(scope, '../outside\n');
    fs.writeFileSync(path.join(target, 'file.txt'), 'worker\n');
    const head = f.call(['rev-parse', 'qb/invalid']);
    assert.throws(() => f.run('merge', 'invalid'), error => {
      assert.equal(error.message, 'Scope file for invalid is invalid: ' + scope);
      return true;
    });
    assert.equal(f.call(['rev-parse', 'qb/invalid']), head);
    assert.equal(f.call(['status', '--porcelain']), '');
  });

  for (const kind of ['tracked file', 'deletion', 'untracked file', 'directory without slash', 'directory prefix boundary']) {
    test('scope rejects an out-of-scope ' + kind + ' before merging any copy', t => {
      const f = fixture(t), first = f.add('first', '--scope', 'first.txt');
      const scope = kind === 'directory without slash' ? 'src' : kind === 'directory prefix boundary' ? 'src/' : 'allowed/';
      const second = f.add('second', '--scope', scope);
      fs.writeFileSync(path.join(first, 'first.txt'), 'allowed\n');
      let forbidden = 'file.txt';
      if (kind === 'deletion') fs.unlinkSync(path.join(second, forbidden));
      else if (kind === 'tracked file') fs.writeFileSync(path.join(second, forbidden), 'outside\n');
      else {
        forbidden = kind === 'untracked file' ? 'outside.txt' : kind === 'directory without slash' ? 'src/new.txt' : 'src-other/new.txt';
        fs.mkdirSync(path.dirname(path.join(second, forbidden)), { recursive: true });
        fs.writeFileSync(path.join(second, forbidden), 'outside\n');
      }
      const head = f.call(['rev-parse', 'HEAD']);
      assert.throws(() => f.run('merge', 'first', 'second'), error => error.message.includes('second') && error.message.includes(forbidden));
      assert.equal(f.call(['status', '--porcelain']), '');
      assert.equal(f.call(['rev-parse', 'HEAD']), head);
      assert.equal(fs.existsSync(first), true);
      assert.equal(fs.existsSync(second), true);
      assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'base\n');
    });
  }

  for (const scoped of [false, true]) {
    test('a force-added plan is forbidden even ' + (scoped ? 'with' : 'without') + ' scope', t => {
      const f = fixture(t), plan = path.join(f.temp, 'plan');
      fs.writeFileSync(plan, 'private plan\n');
      const target = f.add('plan', '--plan', plan, ...(scoped ? ['--scope', 'file.txt'] : []));
      f.call(['add', '-f', '.qb-plan.md'], target);
      assert.throws(() => f.run('merge', 'plan'), /Worker copy plan.*\n.qb-plan.md/);
      assert.equal(f.call(['status', '--porcelain']), '');
      assert.equal(fs.existsSync(path.join(f.root, '.qb-plan.md')), false);
    });
  }

  test('overlapping changes fail the whole merge, including deletion versus modification', t => {
    for (const deletion of [false, true]) {
      const f = fixture(t), first = f.add('first'), second = f.add('second');
      fs.writeFileSync(path.join(first, 'file.txt'), 'first\n');
      if (deletion) fs.unlinkSync(path.join(second, 'file.txt'));
      else fs.writeFileSync(path.join(second, 'file.txt'), 'second\n');
      assert.throws(() => f.run('merge', 'first', 'second'), /Worker copy second overlaps another named copy \(first\):\nfile.txt/);
      assert.equal(f.call(['status', '--porcelain']), '');
      assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'base\n');
    }
  });

  test('scope matching is case insensitive on Windows', { skip: process.platform !== 'win32' }, t => {
    const f = fixture(t), target = f.add('case', '--scope', 'FILE.TXT,SRC/');
    fs.writeFileSync(path.join(target, 'file.txt'), 'worker\n');
    fs.mkdirSync(path.join(target, 'src'));
    fs.writeFileSync(path.join(target, 'src', 'new.txt'), 'new\n');
    assert.match(f.run('merge', 'case'), /^Merged case into/);
    assert.equal(f.call(['diff', '--cached', '--name-only']), 'file.txt\nsrc/new.txt');
  });

  test('overlap matching ignores case on Windows', { skip: process.platform !== 'win32' }, t => {
    const f = fixture(t), a = f.add('a'), b = f.add('b');
    fs.writeFileSync(path.join(a, 'New.txt'), 'a\n');
    fs.writeFileSync(path.join(b, 'new.TXT'), 'b\n');
    assert.throws(() => f.run('merge', 'a', 'b'), /Worker copy b overlaps.*\nnew.TXT/);
    assert.equal(f.call(['status', '--porcelain']), '');
  });

  for (const scoped of [false, true]) {
    test('two-copy merge stages both packages in order and keeps their copies and branches ' + (scoped ? 'with' : 'without') + ' scopes', t => {
      const f = fixture(t), a = f.add('a', ...(scoped ? ['--scope', 'file.txt'] : []));
      const b = f.add('b', ...(scoped ? ['--scope', 'src/'] : []));
      fs.writeFileSync(path.join(a, 'file.txt'), 'worker a\n');
      fs.mkdirSync(path.join(b, 'src'));
      fs.writeFileSync(path.join(b, 'src', 'b.txt'), 'worker b\n');
      const head = f.call(['rev-parse', 'HEAD']), merges = [];
      let mainChecks = 0;
      const output = worktree.run(['merge', 'b', 'a'], f.root, { env: f.env, spawnSync(file, args, options) {
        if (args.includes('--untracked-files=no')) mainChecks++;
        if (args[0] === 'merge') merges.push(args.at(-1));
        return spawnSync(file, args, options);
      } });
      assert.equal(mainChecks, 1);
      assert.deepEqual(merges, ['qb/b', 'qb/a']);
      assert.equal(output, 'Merged b, a into the main folder as uncommitted changes. Run the full check once and read the diff. A failed package: send the error to its worker (same WORKDIR), then `git reset --merge` and merge again. When done: commit, then quota-boss worktree clean.');
      assert.equal(f.call(['diff', '--cached', '--name-only']), 'file.txt\nsrc/b.txt');
      assert.equal(f.call(['diff', '--name-only']), '');
      assert.equal(f.call(['rev-parse', 'HEAD']), head);
      assert.equal(fs.existsSync(a), true);
      assert.equal(fs.existsSync(b), true);
      assert.notEqual(f.call(['branch', '--list', 'qb/a', 'qb/b']), '');
      f.call(['commit', '-m', 'combined']);
      assert.match(f.run('clean'), /Kept: none/);
      assert.equal(fs.existsSync(a), false);
      assert.equal(fs.existsSync(b), false);
      for (const name of ['a', 'b']) assert.equal(fs.existsSync(path.join(f.root, '.git', 'qb-scope', name)), false);
    });
  }

  test('preflight validates every registration before auto-committing any copy', t => {
    const f = fixture(t), target = f.add('one');
    fs.writeFileSync(path.join(target, 'file.txt'), 'worker\n');
    const head = f.call(['rev-parse', 'qb/one']);
    assert.throws(() => f.run('merge', 'one', 'missing'), /No registered worker copy missing/);
    assert.equal(f.call(['rev-parse', 'qb/one']), head);
    assert.equal(f.call(['diff', '--cached', '--name-only'], target), '');
    assert.equal(f.call(['status', '--porcelain']), '');
  });

  test('diverged multi-copy merge preserves earlier staged deletions and force-added ignored paths', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, '.gitignore'), 'ignored.txt\n');
    f.call(['add', '.']); f.call(['commit', '-m', 'ignore output']);
    const a = f.add('a', '--scope', 'file.txt,ignored.txt'), b = f.add('b', '--scope', 'b.txt');
    fs.unlinkSync(path.join(a, 'file.txt'));
    fs.writeFileSync(path.join(a, 'ignored.txt'), 'worker a\n');
    f.call(['add', '-f', 'ignored.txt'], a);
    fs.writeFileSync(path.join(b, 'b.txt'), 'worker b\n');
    fs.writeFileSync(path.join(f.root, 'main.txt'), 'main\n');
    f.call(['add', 'main.txt']); f.call(['commit', '-m', 'main diverged']);
    f.run('merge', 'a', 'b');
    assert.equal(f.call(['diff', '--cached', '--name-status']), 'A\tb.txt\nD\tfile.txt\nA\tignored.txt');
    assert.equal(f.call(['diff', '--name-only']), '');
    assert.equal(fs.readFileSync(path.join(f.root, 'ignored.txt'), 'utf8'), 'worker a\n');
    assert.equal(fs.readFileSync(path.join(f.root, 'main.txt'), 'utf8'), 'main\n');
    f.call(['reset', '--merge']);
    assert.equal(f.call(['status', '--porcelain']), '');
    assert.equal(fs.existsSync(path.join(f.root, 'b.txt')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'ignored.txt')), false);
    assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'base\n');
  });

  test('renames check both the removed source and added destination without rename detection', t => {
    const f = fixture(t), target = f.add('rename', '--scope', 'renamed.txt');
    f.call(['mv', 'file.txt', 'renamed.txt'], target);
    assert.throws(() => f.run('merge', 'rename'), /Worker copy rename.*\nfile.txt/);
    assert.equal(f.call(['status', '--porcelain']), '');
  });

  test('scope errors name the copy and list at most twenty paths', t => {
    const f = fixture(t), target = f.add('bounded', '--scope', 'file.txt');
    for (let index = 0; index < 25; index++) fs.writeFileSync(path.join(target, 'outside-' + index), 'outside\n');
    assert.throws(() => f.run('merge', 'bounded'), error => {
      assert.match(error.message, /^Worker copy bounded changes forbidden or out-of-scope paths:/);
      assert.equal(error.message.split('\n').length, 21);
      return true;
    });
    assert.equal(f.call(['status', '--porcelain']), '');
  });

  test('a scoped empty copy stays available after merging', t => {
    const f = fixture(t), target = f.add('empty', '--scope', 'file.txt');
    assert.equal(f.run('merge', 'empty'), 'Nothing to merge from empty.\nNo copies have changes; nothing merged.');
    assert.equal(fs.existsSync(target), true);
    assert.notEqual(f.call(['branch', '--list', 'qb/empty']), '');
    assert.equal(f.call(['status', '--porcelain']), '');
  });

  for (const changed of [false, true]) {
    test('multi merge skips empty copies and keeps them ' + (changed ? 'alongside changed copies' : 'when all are empty'), t => {
      const f = fixture(t), a = f.add('empty'), b = f.add('other');
      if (changed) fs.writeFileSync(path.join(b, 'file.txt'), 'worker\n');
      const merges = [];
      const output = worktree.run(['merge', 'empty', 'other'], f.root, { env: f.env, spawnSync(file, args, options) {
        if (args[0] === 'merge') merges.push(args.at(-1));
        return spawnSync(file, args, options);
      } });
      assert.ok(output.startsWith('Nothing to merge from empty.\n'));
      assert.deepEqual(merges, changed ? ['qb/other'] : []);
      if (changed) {
        assert.match(output, /\nMerged other into the main folder/);
        assert.equal(f.call(['diff', '--cached', '--name-only']), 'file.txt');
      } else {
        assert.equal(output, 'Nothing to merge from empty.\nNothing to merge from other.\nNo copies have changes; nothing merged.');
        assert.equal(f.call(['status', '--porcelain']), '');
      }
      for (const [name, target] of [['empty', a], ['other', b]]) {
        assert.equal(fs.existsSync(target), true);
        assert.notEqual(f.call(['branch', '--list', 'qb/' + name]), '');
      }
    });
  }

  test('hundreds of staged literal paths are reset and re-added through NUL-delimited stdin', t => {
    const f = fixture(t), a = f.add('many'), b = f.add('next');
    const files = Array.from({ length: 350 }, (_, index) => '[literal]-' + String(index).padStart(3, '0') + '-'.repeat(85) + '.txt');
    for (const file of files) fs.writeFileSync(path.join(a, file), 'worker a\n');
    fs.writeFileSync(path.join(b, 'file.txt'), 'worker b\n');
    const transfers = [];
    worktree.run(['merge', 'many', 'next'], f.root, { env: f.env, spawnSync(file, args, options) {
      if (args[0] === '--literal-pathspecs' && ['reset', 'add'].includes(args[1])) {
        transfers.push(args[1]);
        assert.ok(args.includes('--pathspec-from-file=-'));
        assert.ok(args.includes('--pathspec-file-nul'));
        assert.ok(args.join(' ').length < 200);
        assert.equal(options.input, files.join('\0') + '\0');
        assert.ok(options.input.length > 32767);
      }
      return spawnSync(file, args, options);
    } });
    assert.deepEqual(transfers, ['reset', 'add']);
    assert.deepEqual(f.call(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean).sort(), [...files, 'file.txt'].sort());
    assert.equal(f.call(['diff', '--name-only']), '');
  });

  test('merge and re-add errors preserve the original error first and earlier unstaged changes', t => {
    const f = fixture(t), a = f.add('a'), b = f.add('b');
    fs.writeFileSync(path.join(a, 'a.txt'), 'worker a\n');
    fs.writeFileSync(path.join(b, 'file.txt'), 'worker b\n');
    assert.throws(() => worktree.run(['merge', 'a', 'b'], f.root, { env: f.env, spawnSync(file, args, options) {
      if (args[0] === 'merge' && args.at(-1) === 'qb/b') return { status: 1, stderr: 'original merge failure' };
      if (args[0] === '--literal-pathspecs' && args[1] === 'add') return { status: 1, stderr: 're-add failure' };
      return spawnSync(file, args, options);
    } }), error => {
      assert.ok(error.message.startsWith('original merge failure\nCould not re-add earlier changes: re-add failure\n'));
      assert.match(error.message, /Merged copies: a\.\nConflicted copy: b\./);
      assert.match(error.message, /main folder \(staged or unstaged\)/);
      assert.match(error.message, /New files from completed copies:\na.txt\n/);
      return true;
    });
    assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'worker a\n');
    assert.equal(f.call(['diff', '--cached', '--name-only']), '');
    assert.equal(fs.readFileSync(path.join(a, 'a.txt'), 'utf8'), 'worker a\n');
    assert.equal(fs.readFileSync(path.join(b, 'file.txt'), 'utf8'), 'worker b\n');
  });

  test('later conflicts report completed changes and manual cleanup while preserving both copies', t => {
    const f = fixture(t), a = f.add('a', '--scope', 'a.txt'), b = f.add('b', '--scope', 'file.txt');
    fs.writeFileSync(path.join(a, 'a.txt'), 'worker a\n');
    fs.writeFileSync(path.join(b, 'file.txt'), 'worker b\n');
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'main\n');
    f.call(['commit', '-am', 'main change']);
    assert.throws(() => f.run('merge', 'a', 'b'), error => {
      assert.match(error.message, /Merged copies: a\.\nConflicted copy: b\.\nConflicted files:\nfile.txt/);
      assert.match(error.message, /Changes from copies a are in the main folder \(staged or unstaged\)/);
      assert.match(error.message, /New files from completed copies:\na.txt\n/);
      assert.match(error.message, /`git reset --merge` followed by `git clean` of the listed new files is NOT run automatically/);
      return true;
    });
    assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'worker a\n');
    assert.equal(f.call(['diff', '--name-only', '--diff-filter=U']), 'file.txt');
    assert.equal(fs.existsSync(a), true);
    assert.equal(fs.existsSync(b), true);
    assert.equal(fs.readFileSync(path.join(a, 'a.txt'), 'utf8'), 'worker a\n');
    assert.equal(fs.readFileSync(path.join(b, 'file.txt'), 'utf8'), 'worker b\n');
    assert.equal(f.call(['show', 'qb/a:a.txt']), 'worker a');
    assert.equal(f.call(['show', 'qb/b:file.txt']), 'worker b');
    f.call(['reset', '--merge']);
    assert.equal(f.call(['status', '--porcelain']), '');
    assert.equal(fs.existsSync(path.join(f.root, 'a.txt')), false);
    assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'main\n');
  });

  test('clean and remove delete scope files only when copy safety checks allow removal', t => {
    const f = fixture(t), target = f.add('dirty', '--scope', 'file.txt');
    const scope = name => path.join(f.root, '.git', 'qb-scope', name);
    fs.writeFileSync(path.join(target, 'file.txt'), 'keep\n');
    assert.throws(() => f.run('remove', 'dirty'), /has work/);
    assert.match(f.run('clean'), /Kept: dirty/);
    assert.equal(fs.existsSync(scope('dirty')), true);
    f.run('remove', 'dirty', '--force');
    assert.equal(fs.existsSync(scope('dirty')), false);
    const missing = f.add('missing', '--scope', 'file.txt');
    f.call(['worktree', 'remove', missing]);
    fs.writeFileSync(scope('orphan'), 'file.txt\n');
    f.run('clean');
    assert.equal(fs.existsSync(scope('missing')), false);
    assert.equal(fs.existsSync(scope('orphan')), false);
  });

  test('add uses the sibling folder and qb branch; duplicates and unsafe inputs refuse', t => {
    const f = fixture(t);
    const result = f.command('add', 'one');
    const target = path.join(f.folder, 'one');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], target);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), [target,
      'Pass it as WORKDIR: in the handover. Uncommitted changes in the main folder are not in the copy.',
      'When the worker is done: quota-boss worktree merge one, resolve any conflict, run the check once, commit. At task end: quota-boss worktree clean.']);
    assert.equal(f.call(['branch', '--show-current'], target), 'qb/one');
    assert.equal(fs.readFileSync(path.join(target, 'file.txt'), 'utf8'), 'base\n');
    assert.equal(path.dirname(f.folder), path.dirname(f.root));
    assert.throws(() => f.run('add', 'one'), /already exists/);
    fs.mkdirSync(path.join(f.folder, 'existing'));
    assert.throws(() => f.run('add', 'existing'), /already exists/);
    f.call(['branch', 'qb/branch-only']);
    const duplicate = f.command('add', 'branch-only');
    assert.equal(duplicate.status, 1);
    assert.equal(duplicate.stderr.trim(), 'quota-boss: Branch qb/branch-only already exists: run quota-boss worktree list or clean, or pick another name.');
    for (const name of ['', '../escape', '-bad', 'Upper', 'a'.repeat(41), 'a\nb', 'x/y']) {
      assert.equal(f.command('add', name).status, 2, name);
    }
    for (const args of [[], ['remove'], ['add', 'two', '--force'], ['list', 'one'], ['clean', 'one'], ['remove', 'one', '--bad']]) {
      assert.equal(f.command(...args).status, 2, args.join(' '));
    }
    for (const name of ['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, i) => 'com' + (i + 1)),
      ...Array.from({ length: 9 }, (_, i) => 'lpt' + (i + 1))]) {
      for (const action of ['add', 'merge', 'remove']) {
        assert.throws(() => f.run(action, name), error => error.exitCode === 2, action + ' ' + name);
      }
    }
    assert.throws(() => worktree.run(['add', 'nested'], target, { env: f.env }), /main worktree/);
    assert.throws(() => worktree.run(['list'], target, { env: f.env }), /main worktree/);
    const nested = path.join(f.root, 'nested');
    fs.mkdirSync(nested);
    assert.equal(worktree.run(['add', 'two'], nested, { env: f.env }).split('\n')[0], path.join(f.folder, 'two'));
  });

  test('tracked main changes warn and do not enter the copy; untracked files alone do not warn', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, 'untracked'), 'main');
    assert.doesNotMatch(f.run('add', 'untracked'), /Warning:/);
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'dirty\n');
    assert.match(f.run('add', 'dirty'), /Warning:.*uncommitted tracked changes/);
    assert.equal(fs.readFileSync(path.join(f.folder, 'dirty', 'file.txt'), 'utf8'), 'base\n');
  });

  test('list shows only qb copies, with changed or clean state', t => {
    const f = fixture(t);
    assert.equal(f.run('list'), 'No worker copies.');
    f.call(['worktree', 'add', '-b', 'other', path.join(f.temp, 'other')]);
    assert.equal(f.run('list'), 'No worker copies.');
    const target = f.add('one');
    assert.equal(f.run('list'), 'one\t' + target + '\tclean');
    fs.writeFileSync(path.join(target, 'untracked'), 'new');
    assert.equal(f.run('list'), 'one\t' + target + '\tchanged');
  });

  test('merge commits worker changes, squashes into main, removes copy and empty sibling folder', t => {
    const f = fixture(t), target = f.add('one');
    const head = f.call(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(target, 'file.txt'), 'worker\n');
    fs.writeFileSync(path.join(target, 'new.txt'), 'new\n');
    const commits = [];
    const result = worktree.run(['merge', 'one'], f.root, { env: f.env, spawnSync(file, args, options) {
      if (args.includes('commit')) commits.push(args);
      return spawnSync(file, args, options);
    } });
    assert.deepEqual(commits, [['-c', 'commit.gpgsign=false', 'commit', '-m', 'quota-boss worker copy one']]);
    assert.equal(result, 'Merged one into the main folder as uncommitted changes. Read the diff, run the check once, then commit.');
    assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'worker\n');
    assert.equal(fs.readFileSync(path.join(f.root, 'new.txt'), 'utf8'), 'new\n');
    assert.equal(f.call(['rev-parse', 'HEAD']), head);
    assert.match(f.call(['status', '--porcelain']), /M  file.txt/);
    assert.notEqual(f.call(['branch', '--list', 'qb/one']), '');
    assert.equal(f.call(['worktree', 'list', '--porcelain']).split('worktree ').length, 2);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(f.folder), false);
    assert.equal(f.run('list'), 'one\tbranch only');
    assert.match(f.run('clean'), /Kept branch qb\/one: its work is not committed in HEAD/);
    assert.notEqual(f.call(['branch', '--list', 'qb/one']), '');
    f.call(['commit', '-m', 'squashed worker']);
    // Unrelated committed work must not prevent recognizing the squash.
    fs.writeFileSync(path.join(f.root, 'unrelated'), 'later\n');
    f.call(['add', 'unrelated']);
    f.call(['commit', '-m', 'unrelated']);
    assert.equal(f.run('clean'), 'Removed: one.\nKept: none.');
    assert.equal(f.call(['branch', '--list', 'qb/one']), '');
  });

  test('two copies can edit one file and merge independently', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'first\n' + 'middle\n'.repeat(20) + 'last\n');
    f.call(['commit', '-am', 'long file']);
    const a = f.add('a'), b = f.add('b');
    fs.writeFileSync(path.join(a, 'file.txt'), fs.readFileSync(path.join(a, 'file.txt'), 'utf8').replace('first', 'worker a'));
    fs.writeFileSync(path.join(b, 'file.txt'), fs.readFileSync(path.join(b, 'file.txt'), 'utf8').replace('last', 'worker b'));
    f.run('merge', 'a');
    assert.equal(fs.existsSync(f.folder), true);
    f.call(['commit', '-am', 'merge a']);
    f.run('merge', 'b');
    const text = fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8');
    assert.match(text, /worker a/);
    assert.match(text, /worker b/);
    assert.equal(fs.existsSync(f.folder), false);
  });

  test('merge with no new commits or changes removes an empty copy', t => {
    const f = fixture(t);
    f.add('empty');
    assert.equal(f.run('merge', 'empty'), 'Nothing to merge from empty.');
    assert.equal(fs.existsSync(f.folder), false);
    assert.equal(f.call(['branch', '--list', 'qb/empty']), '');
  });

  test('merge accepts existing worker commits without creating another commit', t => {
    const f = fixture(t), target = f.add('committed');
    fs.writeFileSync(path.join(target, 'file.txt'), 'committed\n');
    f.call(['commit', '-am', 'worker commit'], target);
    worktree.run(['merge', 'committed'], f.root, { env: f.env, spawnSync(file, args, options) {
      assert.ok(!args.includes('commit'));
      return spawnSync(file, args, options);
    } });
    assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'committed\n');
    assert.equal(fs.existsSync(f.folder), false);
    assert.throws(() => f.run('merge', 'missing'), /No registered worker copy/);
  });

  test('conflicts list files, return 1 and keep branch and copy', t => {
    const f = fixture(t), target = f.add('conflict');
    fs.writeFileSync(path.join(target, 'file.txt'), 'worker\n');
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'main\n');
    f.call(['commit', '-am', 'main change']);
    const result = f.command('merge', 'conflict');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Conflicted files:\nfile.txt\n/);
    assert.ok(result.stderr.includes('Resolve the conflicts, run the check, then: quota-boss worktree remove conflict --force. To undo the merge instead: git reset --merge'));
    assert.equal(fs.existsSync(target), true);
    assert.notEqual(f.call(['branch', '--list', 'qb/conflict']), '');
    assert.equal(f.call(['diff', '--name-only', '--diff-filter=U']), 'file.txt');
    f.call(['reset', '--merge']);
    // Also exercise control characters on hosts that cannot create such filenames.
    assert.throws(() => worktree.run(['merge', 'conflict'], f.root, { env: f.env, spawnSync(file, args, options) {
      if (args.includes('--diff-filter=U')) return { status: 0, stdout: Array.from({ length: 23 }, (_, i) => 'bad' + i + '\n\x1b.txt\0').join('') };
      return spawnSync(file, args, options);
    } }), error => {
      const files = error.message.split('Conflicted files:\n')[1].split('\nResolve')[0].split('\n');
      assert.equal(error.exitCode, 1);
      assert.equal(files.length, 20);
      assert.ok(files.every(file => /^bad\d+\.txt$/.test(file)));
      assert.doesNotMatch(error.message, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      return true;
    });
  });

  test('any tracked main changes refuse before worker staging or committing and change nothing', t => {
    for (const kind of ['unstaged overlapping', 'unstaged unrelated', 'staged unrelated']) {
      const f = fixture(t);
      fs.writeFileSync(path.join(f.root, 'other.txt'), 'base\n');
      f.call(['add', '.']); f.call(['commit', '-m', 'other file']);
      const target = f.add('one');
      fs.writeFileSync(path.join(target, 'file.txt'), 'worker\n');
      fs.writeFileSync(path.join(target, 'new.txt'), 'untracked worker\n');
      const file = kind.includes('overlapping') ? 'file.txt' : 'other.txt';
      fs.writeFileSync(path.join(f.root, file), 'main dirty\n');
      if (kind.startsWith('staged')) f.call(['add', file]);
      const snapshot = () => [f.call(['status', '--porcelain']), f.call(['diff']), f.call(['diff', '--cached']),
        fs.readFileSync(path.join(f.root, '.git', 'index')).toString('base64'), f.call(['rev-parse', 'HEAD']),
        f.call(['status', '--porcelain'], target), f.call(['diff'], target), f.call(['diff', '--cached'], target),
        fs.readFileSync(path.join(f.root, '.git', 'worktrees', 'one', 'index')).toString('base64'),
        f.call(['rev-parse', 'qb/one'])];
      const before = snapshot(), result = f.command('merge', 'one');
      assert.equal(result.status, 1, kind);
      assert.equal(result.stderr.trim(), 'quota-boss: Commit or stash your changes in the main folder first, then merge again.');
      assert.deepEqual(snapshot(), before, kind);
      assert.equal(fs.existsSync(target), true);
    }
  });

  test('remove protects uncommitted work and keeps unmerged branches after removing copies', t => {
    const f = fixture(t), dirty = f.add('dirty'), committed = f.add('committed');
    fs.writeFileSync(path.join(dirty, 'new'), 'work');
    fs.writeFileSync(path.join(committed, 'file.txt'), 'committed\n');
    f.call(['commit', '-am', 'worker'], committed);
    const result = f.command('remove', 'dirty');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Use --force to drop them\./);
    assert.equal(fs.existsSync(dirty), true);
    assert.match(f.run('remove', 'dirty', '--force'), /Removed/);
    assert.equal(f.call(['branch', '--list', 'qb/dirty']), '');
    assert.match(f.run('remove', 'committed'), /Removed committed\.\nKept branch qb\/committed/);
    assert.notEqual(f.call(['branch', '--list', 'qb/committed']), '');
    assert.equal(fs.existsSync(committed), false);
    assert.match(f.run('clean', '--force'), /Removed: committed/);
    assert.equal(fs.existsSync(f.folder), false);
    f.add('clean');
    assert.equal(f.run('remove', 'clean'), 'Removed clean.');
  });

  test('clean reports kept work, removes empty copies, prunes, and force removes the rest', t => {
    const f = fixture(t), dirty = f.add('dirty'), committed = f.add('committed');
    f.add('empty');
    fs.writeFileSync(path.join(dirty, 'new'), 'work');
    fs.writeFileSync(path.join(committed, 'file.txt'), 'work\n');
    f.call(['commit', '-am', 'worker'], committed);
    f.call(['worktree', 'add', '-b', 'other', path.join(f.temp, 'other')]);
    const result = f.run('clean');
    assert.match(result, /Removed: committed, empty\./);
    assert.match(result, /Kept:.*qb\/committed.*not committed.*dirty.*has work/);
    assert.equal(fs.existsSync(dirty), true);
    assert.equal(fs.existsSync(committed), false);
    assert.equal(fs.existsSync(path.join(f.folder, 'empty')), false);
    assert.match(f.run('clean', '--force'), /Removed: dirty, committed\.\nKept: none\./);
    assert.equal(fs.existsSync(f.folder), false);
    assert.equal(f.call(['branch', '--list', 'other']).trim(), '+ other');
    assert.equal(f.run('clean'), 'Removed: none.\nKept: none.');
  });

  for (const setting of [null, 'user.email', 'user.name']) test('worker commit supplies identity with ' + (setting || 'neither identity field'), t => {
    const f = fixture(t, false);
    if (setting) f.call(['config', setting, setting === 'user.email' ? 'only@localhost' : 'Only Name']);
    f.call(['config', 'commit.gpgsign', 'true']);
    const target = f.add('identity');
    fs.writeFileSync(path.join(target, 'file.txt'), 'worker\n');
    const commits = [];
    const deps = { env: f.env, spawnSync(file, args, options) {
      if (args.includes('commit')) commits.push(args);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      return spawnSync(file, args, options);
    } };
    worktree.run(['merge', 'identity'], f.root, deps);
    assert.deepEqual(commits, [['-c', 'user.name=quota-boss', '-c', 'user.email=quota-boss@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'quota-boss worker copy identity']]);
    assert.equal(f.call(['show', '-s', '--format=%an <%ae>', 'qb/identity']), 'quota-boss <quota-boss@localhost>');
    assert.equal(f.call(['config', 'user.email'], f.root, [0, 1]), setting === 'user.email' ? 'only@localhost' : '');
    assert.equal(f.call(['config', 'user.name'], f.root, [0, 1]), setting === 'user.name' ? 'Only Name' : '');
    assert.equal(f.call(['config', 'commit.gpgsign']), 'true');
  });

  test('git errors report only the first stderr line, trimmed and bounded', t => {
    const f = fixture(t);
    assert.throws(() => worktree.run(['list'], f.root, { env: f.env,
      spawnSync: () => ({ status: 128, stderr: '  first\x1b line ' + 'x'.repeat(220) + '\nsecret second line\n' }),
    }), error => error.message.length === 200 && error.message.startsWith('first line ') && !error.message.includes('secret'));
  });

  test('ignored files block remove and clean until forced, with their file count', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, '.gitignore'), 'ignored/\n');
    f.call(['add', '.gitignore']); f.call(['commit', '-m', 'ignore output']);
    const target = f.add('ignored');
    fs.mkdirSync(path.join(target, 'ignored'));
    for (const name of ['one', 'two']) fs.writeFileSync(path.join(target, 'ignored', name), 'keep');
    assert.throws(() => f.run('remove', 'ignored'), /holds 2 ignored files\. Use --force to drop them\./);
    assert.match(f.run('clean'), /Kept: ignored \(.*holds 2 ignored files\. Use --force to drop them\./);
    assert.equal(fs.readFileSync(path.join(target, 'ignored', 'one'), 'utf8'), 'keep');
    assert.notEqual(f.call(['branch', '--list', 'qb/ignored']), '');
    assert.equal(f.run('remove', 'ignored', '--force'), 'Removed ignored.');
    assert.equal(fs.existsSync(target), false);
    assert.equal(f.call(['branch', '--list', 'qb/ignored']), '');
  });

  test('missing folders are listed and pruned; their branches follow the content check', t => {
    const f = fixture(t), empty = f.add('empty'), work = f.add('work');
    fs.writeFileSync(path.join(work, 'file.txt'), 'worker\n');
    f.call(['commit', '-am', 'worker'], work);
    // Both resolved targets are direct children of this test's known sibling folder.
    for (const target of [empty, work]) {
      assert.equal(path.dirname(fs.realpathSync.native(target)), f.folder);
      assert.equal(path.dirname(f.folder), f.temp);
      fs.rmSync(target, { recursive: true });
    }
    assert.equal(f.run('list'), 'empty\t' + empty + '\tmissing\nwork\t' + work + '\tmissing');
    const result = f.run('clean');
    assert.match(result, /Removed: empty\./);
    assert.match(result, /Kept branch qb\/work: its work is not committed in HEAD/);
    assert.doesNotMatch(f.call(['worktree', 'list', '--porcelain']), /qb\//);
    assert.equal(f.run('list'), 'work\tbranch only');
    assert.equal(f.call(['branch', '--list', 'qb/empty']), '');
    assert.notEqual(f.call(['branch', '--list', 'qb/work']), '');
    assert.match(f.run('clean', '--force'), /Removed: work/);
  });

  test('orphan branches are listed; clean keeps unmerged content, including deletions', t => {
    const f = fixture(t), target = f.add('orphan');
    f.call(['rm', 'file.txt'], target);
    f.call(['commit', '-m', 'worker deletion'], target);
    f.call(['worktree', 'remove', target]);
    f.call(['branch', 'qb/empty']);
    const emptyCommit = f.call(['commit-tree', 'HEAD^{tree}', '-p', 'qb/empty', '-m', 'empty worker commit']);
    f.call(['update-ref', 'refs/heads/qb/empty', emptyCommit]);
    assert.equal(f.run('list'), 'empty\tbranch only\norphan\tbranch only');
    assert.match(f.run('clean'), /Removed: empty\.\nKept: Kept branch qb\/orphan/);
    assert.notEqual(f.call(['branch', '--list', 'qb/orphan']), '');
    f.call(['rm', 'file.txt']); f.call(['commit', '-m', 'same deletion']);
    assert.equal(f.run('clean'), 'Removed: orphan.\nKept: none.');
  });

  test('merged file comparisons preserve literal path names', t => {
    const f = fixture(t), target = f.add('literal');
    fs.writeFileSync(path.join(target, '[one].txt'), 'worker\n');
    f.call(['add', '.'], target); f.call(['commit', '-m', 'literal worker file'], target);
    f.call(['worktree', 'remove', target]);
    assert.match(f.run('clean'), /Kept branch qb\/literal/);
    fs.writeFileSync(path.join(f.root, '[one].txt'), 'worker\n');
    f.call(['add', '.']); f.call(['commit', '-m', 'same literal file']);
    assert.equal(f.run('clean'), 'Removed: literal.\nKept: none.');
  });

  test('copy removal and branch deletion failures identify the completed and failed steps', t => {
    const f = fixture(t); f.add('one');
    const deps = failStep => ({ env: f.env, spawnSync(file, args, options) {
      if (args[0] === failStep && (failStep === 'branch' || args[1] === 'remove')) {
        return { status: 1, stderr: 'injected failure\nmore detail' };
      }
      return spawnSync(file, args, options);
    } });
    assert.throws(() => worktree.run(['remove', 'one'], f.root, deps('worktree')),
      /Could not remove worker copy one \(injected failure\); kept branch qb\/one/);
    assert.equal(fs.existsSync(path.join(f.folder, 'one')), true);
    assert.match(worktree.run(['clean'], f.root, deps('worktree')),
      /Kept: one \(Could not remove worker copy one \(injected failure\); kept branch qb\/one/);
    assert.throws(() => worktree.run(['remove', 'one'], f.root, deps('branch')),
      /Removed worker copy one; could not delete branch qb\/one \(injected failure\)/);
    assert.equal(fs.existsSync(path.join(f.folder, 'one')), false);
    assert.notEqual(f.call(['branch', '--list', 'qb/one']), '');
    assert.match(worktree.run(['clean'], f.root, deps('branch')), /could not delete branch qb\/one/i);
    assert.equal(f.run('clean'), 'Removed: one.\nKept: none.');
    f.add('two');
    assert.throws(() => worktree.run(['remove', 'two'], f.root, { env: f.env, spawnSync(file, args, options) {
      if (args[0] === 'merge-base') return { status: 1, stderr: 'comparison failed' };
      return spawnSync(file, args, options);
    } }), /Removed worker copy two; could not check whether branch qb\/two is merged \(comparison failed\); kept the branch/);
    assert.equal(fs.existsSync(path.join(f.folder, 'two')), false);
    assert.notEqual(f.call(['branch', '--list', 'qb/two']), '');
  });

  test('successful squash still returns success when copy removal fails', t => {
    const f = fixture(t), target = f.add('one');
    fs.writeFileSync(path.join(target, 'file.txt'), 'worker\n');
    const result = worktree.run(['merge', 'one'], f.root, { env: f.env, spawnSync(file, args, options) {
      if (args[0] === 'worktree' && args[1] === 'remove') return { status: 1, stderr: 'copy locked' };
      return spawnSync(file, args, options);
    } });
    assert.equal(result, 'Merged one; could not remove its copy (copy locked). Run quota-boss worktree clean later.');
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'worker\n');
    assert.notEqual(f.call(['branch', '--list', 'qb/one']), '');
    // A clean copy may go, but its branch must survive until the squash is committed.
    assert.match(f.run('clean'), /Removed: one\.\nKept: Kept branch qb\/one/);
    f.call(['commit', '-m', 'squash']);
    assert.equal(f.run('clean'), 'Removed: one.\nKept: none.');
  });

  test('all child Git spawns ignore parent repository overrides, including GIT_DIR', t => {
    const f = fixture(t);
    const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX'];
    const env = { ...f.env, ...Object.fromEntries(keys.map(key => [key, path.join(f.temp, 'wrong')])) };
    const deps = { env, spawnSync(file, args, options) {
      for (const key of keys) assert.equal(options.env[key], undefined, key);
      assert.equal(options.env.GIT_CONFIG_GLOBAL, f.env.GIT_CONFIG_GLOBAL);
      return spawnSync(file, args, options);
    } };
    const target = worktree.run(['add', 'env'], f.root, deps).split('\n')[0];
    fs.writeFileSync(path.join(target, 'file.txt'), 'worker\n');
    assert.match(worktree.run(['list'], f.root, deps), /changed/);
    assert.equal(worktree.resolveWorkdir(target, f.root, deps), target);
    assert.match(worktree.run(['merge', 'env'], f.root, deps), /^Merged env into/);
    f.call(['commit', '-m', 'squash']);
    assert.match(worktree.run(['clean'], f.root, deps), /Removed: env/);
    for (const key of keys) assert.equal(env[key], path.join(f.temp, 'wrong'), 'parent ' + key);
    const result = spawnSync(process.execPath, [cli, 'worktree', 'list'], { cwd: f.root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'No worker copies.');
  });

  test('merge keeps the copy when a commit hook rejects it', t => {
    const f = fixture(t), target = f.add('hook');
    fs.writeFileSync(path.join(target, 'file.txt'), 'worker\n');
    const hooks = path.join(f.temp, 'hooks'); fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!' + process.execPath.replace(/\\/g, '/')
      + '\nconsole.error("hook rejected"); console.error("more detail"); process.exit(1);\n', { mode: 0o755 });
    f.call(['config', 'core.hooksPath', hooks]);
    const head = f.call(['rev-parse', 'HEAD']), workerHead = f.call(['rev-parse', 'qb/hook']);
    const index = fs.readFileSync(path.join(f.root, '.git', 'index'));
    const result = f.command('merge', 'hook');
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'quota-boss: hook rejected');
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'base\n');
    assert.equal(f.call(['rev-parse', 'HEAD']), head);
    assert.equal(f.call(['rev-parse', 'qb/hook']), workerHead);
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.git', 'index')), index);
    assert.equal(f.call(['status', '--porcelain']), '');
  });

  test('resolveWorkdir accepts only the project or a registered qb copy, including realpath checks', t => {
    const f = fixture(t), target = f.add('one');
    const resolve = dir => worktree.resolveWorkdir(dir, f.root, { env: f.env });
    assert.equal(resolve('.'), f.root);
    assert.equal(resolve(f.root), f.root);
    assert.equal(resolve(target), target);
    assert.equal(resolve(path.relative(f.root, target)), target);
    f.call(['worktree', 'add', '-b', 'other', path.join(f.temp, 'other')]);
    for (const dir of [f.temp, path.join(f.temp, 'other'), path.join(f.root, 'missing'), path.join(f.root, 'file.txt')]) {
      assert.throws(() => resolve(dir), /Invalid --cwd/);
    }
    const link = path.join(f.root, 'outside-link');
    fs.symlinkSync(f.temp, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => resolve(link), /Invalid --cwd/);
    const subdir = path.join(target, 'sub');
    fs.mkdirSync(subdir);
    assert.throws(() => resolve(subdir), /Invalid --cwd/);
  });

  test('unregistered, moved, external and redirected copies cannot be removed', t => {
    const f = fixture(t);
    fs.mkdirSync(f.folder);
    const unregistered = path.join(f.folder, 'unregistered');
    fs.mkdirSync(unregistered);
    fs.writeFileSync(path.join(unregistered, 'keep'), 'keep');
    assert.throws(() => f.run('remove', 'unregistered', '--force'), /No registered/);
    f.call(['worktree', 'add', '-b', 'qb/external', path.join(f.temp, 'external')]);
    assert.throws(() => f.run('remove', 'external', '--force'), /No registered/);
    assert.throws(() => worktree.resolveWorkdir(path.join(f.temp, 'external'), f.root, { env: f.env }), /Invalid --cwd/);
    const target = f.add('redirected'), moved = path.join(f.temp, 'moved');
    fs.renameSync(target, moved);
    fs.symlinkSync(moved, target, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.run('remove', 'redirected', '--force'), /must stay inside/);
    assert.throws(() => worktree.resolveWorkdir(target, f.root, { env: f.env }), /Invalid --cwd/);
    assert.equal(fs.readFileSync(path.join(moved, 'file.txt'), 'utf8'), 'base\n');
    assert.equal(fs.readFileSync(path.join(unregistered, 'keep'), 'utf8'), 'keep');
    assert.match(f.run('clean', '--force'), /Kept:.*external.*redirected/);
  });

  test('a sibling folder symlink cannot redirect creation or removal', t => {
    const f = fixture(t), elsewhere = path.join(f.temp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, f.folder, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.run('add', 'one'), /must stay inside/);
    assert.throws(() => f.run('remove', 'one', '--force'), /must stay inside/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  test('hostile conflict filenames are sanitized and limited to twenty', { skip: process.platform === 'win32' && 'Control characters are invalid Windows filenames' }, t => {
    const f = fixture(t), names = Array.from({ length: 23 }, (_, i) => 'bad' + i + '\n\x1b.txt');
    for (const name of names) fs.writeFileSync(path.join(f.root, name), 'base\n');
    f.call(['add', '.']); f.call(['commit', '-m', 'hostile names']);
    const target = f.add('one');
    for (const name of names) {
      fs.writeFileSync(path.join(target, name), 'worker\n');
      fs.writeFileSync(path.join(f.root, name), 'main\n');
    }
    f.call(['commit', '-am', 'main']);
    const result = f.command('merge', 'one');
    assert.equal(result.status, 1);
    const files = result.stderr.split('Conflicted files:\n')[1].split('\nResolve')[0].split('\n');
    assert.equal(files.length, 20);
    assert.ok(files.every(file => /^bad\d+\.txt$/.test(file)));
    assert.doesNotMatch(result.stderr, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    assert.equal(fs.existsSync(target), true);
  });

  test('cli-run uses --cwd for spawn, prompt and fingerprint, keeps main config and rejects invalid dirs', async t => {
    const runner = require('../scripts/cli-run');
    const childProcess = require('node:child_process');
    const f = fixture(t), target = f.add('cli'), original = process.cwd();
    const plans = [], fingerprints = [], timings = [];
    const project = { directory: f.root };
    const config = { providers: { providers: { trial: { kind: 'local', enabled: true,
      cli: { command: 'node', args: ['-e', 'require("fs").writeFileSync("runner.txt", "changed"); console.log(process.argv[1]);', '{prompt}'] },
    } } }, models: { models: { tiny: { pool: 'trial' } } } };
    const deps = { env: f.env, prompt: 'do the job',
      findProjectConfig() { assert.equal(process.cwd(), f.root); return project; },
      loadConfig(value) { assert.equal(value, project); return config; },
      spawn(file, args, options) { plans.push({ file, args, options }); return childProcess.spawn(file, args, options); },
      spawnSync(file, args, options) {
        if (args[0] === '--no-optional-locks') fingerprints.push(options.cwd);
        return spawnSync(file, args, options);
      },
      recordRun: value => timings.push(value), appendOutcome: () => assert.fail('Unexpected feedback'),
    };
    process.chdir(f.root);
    try {
      const result = await runner.run(['--provider', 'trial', '--cwd', target, '--expect-changes'], deps);
      assert.equal(result.code, 0, result.report);
      assert.equal(plans[0].options.cwd, target);
      assert.match(result.report, /cli-run: ok/);
      assert.ok(result.report.includes('Your working directory is ' + target + ' and every file is inside it.'));
      assert.ok(fingerprints.length > 0 && fingerprints.every(dir => path.resolve(dir) === target));
      assert.equal(fs.existsSync(path.join(target, 'runner.txt')), true);
      assert.equal(fs.existsSync(path.join(f.root, 'runner.txt')), false);
      assert.equal(timings.length, 1);
      await assert.rejects(runner.run(['--provider', 'trial', '--cwd', f.temp], deps), /Invalid --cwd/);
      assert.equal(plans.length, 1);
      assert.equal(timings.length, 1);
      await runner.run(['--provider', 'trial'], deps);
      assert.equal(plans[1].options.cwd, f.root);
      await runner.run(['--provider', 'trial', '--cwd', '.'], deps);
      assert.equal(plans[2].options.cwd, f.root);
      assert.throws(() => runner.parseArgs(['--provider', 'trial', '--cwd']), /Usage/);
    } finally { process.chdir(original); }
  });

  test('codex-run passes --cwd to its child, rejects invalid dirs, and preserves the default', t => {
    const runner = require('../scripts/codex-run');
    const f = fixture(t), target = f.add('codex');
    const fake = path.join(f.temp, 'codex.js'), observed = path.join(f.temp, 'observed.json');
    fs.writeFileSync(fake, 'const fs = require("node:fs");\n'
      + 'fs.writeFileSync(' + JSON.stringify(observed) + ', JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n'
      + 'fs.writeFileSync(process.argv[process.argv.indexOf("-o")+1], "done\\n");\n');
    const exec = args => spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/codex-run.js'), '--model', 'gpt-6.1-sol', ...args], {
      cwd: f.root, env: { ...f.env, QUOTA_BOSS_CODEX_JS: fake }, input: 'do the job', encoding: 'utf8', windowsHide: true,
    });
    let result = exec(['--cwd', target]);
    assert.equal(result.status, 0, result.stderr);
    let actual = JSON.parse(fs.readFileSync(observed, 'utf8'));
    assert.equal(actual.cwd, target);
    assert.equal(actual.args.includes('--cwd'), false);
    assert.equal(runner.parseArgs(['--model', 'gpt-6.1-sol', '--cwd', target]).cwd, target);
    fs.unlinkSync(observed);
    result = exec(['--cwd', f.temp]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid --cwd/);
    assert.equal(fs.existsSync(observed), false);
    result = exec([]);
    assert.equal(result.status, 0, result.stderr);
    actual = JSON.parse(fs.readFileSync(observed, 'utf8'));
    assert.equal(actual.cwd, f.root);
    result = exec(['--cwd', '.']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(observed, 'utf8')).cwd, f.root);
    assert.throws(() => runner.parseArgs(['--model', 'gpt-6.1-sol', '--cwd']), /Usage/);
  });
});
