'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hooks = require('../scripts/codex-hooks');
const lib = require('../scripts/lib');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-codex-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { quotaBossHome: path.join(root, 'boss home'), codexDir: path.join(root, 'codex') };
  fs.mkdirSync(paths.codexDir);
  const file = path.join(paths.codexDir, 'hooks.json');
  return { root, paths, file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
test('adds missing hook file, leaves bytes and mtime on repeated add, cleans containers on remove', t => {
  const f = fixture(t);
  assert.deepEqual(hooks.update(true, f.paths), { changed: true });
  const first = fs.readFileSync(f.file, 'utf8'), stat = fs.statSync(f.file);
  const group = f.read().hooks.SessionStart[0], hook = group.hooks[0];
  assert.equal(group.matcher, 'startup|resume|clear|compact');
  assert.equal(hook.command, '"' + lib.trustedHomeText(process.execPath) + '" "' + lib.trustedHomeText(f.paths.quotaBossHome) + '/scripts/hook-session.js" --host codex');
  assert.equal(hook.commandWindows, process.platform === 'win32' ? '& ' + hook.command : undefined);
  assert.equal(hook.timeout, 20);
  assert.ok(hook.additionalContextLimit >= 2500);
  assert.equal(hooks.present(f.paths), true);
  assert.deepEqual(hooks.update(true, f.paths), { changed: false });
  assert.equal(fs.readFileSync(f.file, 'utf8'), first);
  assert.equal(fs.statSync(f.file).mtimeMs, stat.mtimeMs);
  assert.deepEqual(hooks.update(false, f.paths), { changed: true });
  assert.deepEqual(f.read(), {});
  assert.deepEqual(hooks.update(false, f.paths), { changed: false });
});
test('preserves foreign content and key order through add, change, and remove', t => {
  const f = fixture(t), foreign = { z: 1, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }], SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'foreign' }], extra: 9 }] }, a: 2 };
  fs.writeFileSync(f.file, JSON.stringify(foreign));
  hooks.update(true, f.paths);
  const value = f.read();
  assert.deepEqual(Object.keys(value), Object.keys(foreign));
  assert.deepEqual(Object.keys(value.hooks), Object.keys(foreign.hooks));
  assert.deepEqual(value.hooks.Stop, foreign.hooks.Stop);
  assert.deepEqual(value.hooks.SessionStart[0], foreign.hooks.SessionStart[0]);
  value.hooks.SessionStart[1].hooks[0].timeout = 1;
  value.hooks.SessionStart[1].hooks.push({ type: 'command', command: 'also foreign' });
  fs.writeFileSync(f.file, JSON.stringify(value));
  assert.equal(hooks.update(true, f.paths).changed, true);
  assert.equal(hooks.update(false, f.paths).changed, true);
  foreign.hooks.SessionStart.push({ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'also foreign' }] });
  assert.deepEqual(f.read(), foreign);
});
test('refuses malformed and unexpected shapes without touching bytes', t => {
  const f = fixture(t);
  for (const text of ['{oops', 'null', '[]', '{"hooks":[]}', '{"hooks":{"Stop":{}}}', '{"hooks":{"SessionStart":[{}]}}', '{"hooks":{"SessionStart":[{"hooks":[null]}]}}']) {
    fs.writeFileSync(f.file, text);
    for (const add of [true, false]) {
      assert.ok(hooks.update(add, f.paths).message);
      assert.equal(fs.readFileSync(f.file, 'utf8'), text);
    }
  }
});
test('refuses missing home, unsafe command home, special file, linked file and parent', t => {
  const f = fixture(t);
  assert.ok(hooks.update(true, { ...f.paths, codexDir: path.join(f.root, 'missing') }).message);
  assert.equal(fs.existsSync(path.join(f.root, 'missing')), false);
  assert.ok(hooks.update(true, { ...f.paths, quotaBossHome: f.root + '$unsafe' }).message);
  fs.mkdirSync(f.file);
  assert.ok(hooks.update(true, f.paths).message);
  fs.rmdirSync(f.file);
  const target = path.join(f.root, 'target.json'); fs.writeFileSync(target, '{}');
  try { fs.symlinkSync(target, f.file); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('File symlinks unavailable; parent junction still tested'); } else throw error; }
  if (fs.existsSync(f.file)) {
    assert.ok(hooks.update(true, f.paths).message);
    assert.ok(hooks.update(false, f.paths).message);
    fs.unlinkSync(f.file);
  }
  const link = path.join(f.root, 'linked'); fs.symlinkSync(f.paths.codexDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(hooks.update(true, { ...f.paths, codexDir: link }).message);
  assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});
test('refuses concurrent changes and lock failures without replacing external data', t => {
  const f = fixture(t), original = lib.atomicWrite;
  fs.writeFileSync(f.file, '{}');
  lib.atomicWrite = (file, text, verify) => { fs.writeFileSync(file, '{"foreign":true}'); verify(); };
  try { assert.match(hooks.update(true, f.paths).message, /changed during commit/); }
  finally { lib.atomicWrite = original; }
  assert.deepEqual(f.read(), { foreign: true });
  fs.mkdirSync(f.file + '.quota-boss.lock');
  assert.ok(hooks.update(true, f.paths).message);
});
test('write refusal, oversized input and lock contention return clear notes', t => {
  const f = fixture(t), originalWrite = lib.atomicWrite, originalLock = lib.withLock;
  lib.atomicWrite = () => { throw new Error('write denied'); };
  try { assert.match(hooks.update(true, f.paths).message, /write denied/); }
  finally { lib.atomicWrite = originalWrite; }
  assert.equal(fs.existsSync(f.file), false);
  lib.withLock = () => null;
  try { assert.match(hooks.update(true, f.paths).message, /locked/); }
  finally { lib.withLock = originalLock; }
  fs.writeFileSync(f.file, ' '.repeat(4 * 1024 * 1024 + 1));
  assert.match(hooks.update(true, f.paths).message, /too large/);
  assert.equal(fs.statSync(f.file).size, 4 * 1024 * 1024 + 1);
});
test('commands for another installation or wrappers remain foreign', t => {
  const f = fixture(t);
  hooks.update(true, f.paths);
  const own = f.read().hooks.SessionStart[0].hooks[0];
  const foreign = [{ ...own, command: own.command.replace('/scripts/hook-session.js', '/other/scripts/hook-session.js') },
    { ...own, command: 'echo ' + own.command }];
  fs.writeFileSync(f.file, JSON.stringify({ hooks: { SessionStart: [{ hooks: foreign }] } }));
  assert.equal(hooks.present(f.paths), false);
  hooks.update(true, f.paths);
  hooks.update(false, f.paths);
  assert.deepEqual(f.read().hooks.SessionStart, [{ hooks: foreign }]);
});

test('an entry written without the Windows command is replaced by the current one', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  hooks.update(true, f.paths);
  const value = f.read();
  delete value.hooks.SessionStart[0].hooks[0].commandWindows;
  fs.writeFileSync(f.file, JSON.stringify(value));
  assert.equal(hooks.present(f.paths), true);
  assert.deepEqual(hooks.update(true, f.paths), { changed: true });
  const groups = f.read().hooks.SessionStart;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].hooks.length, 1);
  assert.equal(groups[0].hooks[0].commandWindows, '& ' + groups[0].hooks[0].command);
  assert.deepEqual(hooks.update(true, f.paths), { changed: false });
});
