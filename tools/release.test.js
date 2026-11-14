'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const release = require('./release');

function fixture(t, unreleased = '', version = '0.1.4') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.changeset'));
  fs.writeFileSync(path.join(root, 'package.json'), `{\r\n\t"nested": {"version": "9.0.0"},\r\n\t"version" : "${version}",\r\n\t"name":"fixture"\r\n}\r\n`);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## [Unreleased]\n\n${unreleased}## [0.1.3] - 2026-01-01\n\nOld notes.\n`);
  return root;
}

function snapshot(root) {
  return Object.fromEntries(['package.json', 'CHANGELOG.md', ...fs.readdirSync(path.join(root, '.changeset')).map(file => `.changeset/${file}`)]
    .map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
}

test('standard semver and prerelease increments', () => {
  for (const [input, bump, expected] of [
    ['0.1.4', 'patch', '0.1.5'], ['0.1.4', 'minor', '0.2.0'], ['0.1.4', 'major', '1.0.0'],
    ['0.1.5-rc.0', 'patch', '0.1.5'], ['0.1.5-rc.0', 'minor', '0.2.0'],
    ['1.0.0-rc.0', 'major', '1.0.0'], ['0.2.0-rc.0', 'minor', '0.2.0']
  ]) assert.equal(release.bumpVersion(input, bump), expected);
});

test('highest bump wins regardless of file ordering', t => {
  const root = fixture(t);
  release.add(root, 'major', 'Added', 'A major change');
  release.add(root, 'patch', 'Fixed', 'Z patch change');
  release.add(root, 'minor', 'Changed', 'Middle change');
  assert.equal(release.readPending(root).version, '1.0.0');
});

test('merges Unreleased, orders sections, preserves multiline text and package formatting', t => {
  const root = fixture(t, '### Fixed\n\n- Legacy fix\n  continued\n\n- Another fix\n\n');
  const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  for (const section of ['Security', 'Fixed', 'Removed', 'Deprecated', 'Changed', 'Added']) {
    release.add(root, section === 'Added' ? 'minor' : 'patch', section, `${section} entry\n  continuation\n\n  More detail.`);
  }
  fs.writeFileSync(path.join(root, '.changeset', 'README.md'), 'Ignored content');
  const notes = release.version(root, false, new Date(2026, 0, 2));
  assert.match(notes, /^## \[0\.2\.0\] - 2026-01-02\n/);
  assert.deepEqual([...notes.matchAll(/^### (.+)$/gm)].map(match => match[1]), ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);
  assert.ok(notes.includes('- Fixed entry\n  continuation\n\n  More detail.\n\n- Legacy fix\n  continued\n\n- Another fix'));
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before.replace('"0.1.4"', '"0.2.0"'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes('## [Unreleased]\n\n## [0.2.0]'));
  assert.ok(changelog.endsWith('## [0.1.3] - 2026-01-01\n\nOld notes.\n'));
  assert.deepEqual(fs.readdirSync(path.join(root, '.changeset')), ['README.md']);
});

test('Unreleased alone produces a patch release', t => {
  const root = fixture(t, '### Added\n\nLegacy entry\n\n');
  assert.match(release.version(root), /\[0\.1\.5\]/);
});

test('dry run prints notes and changes no bytes', t => {
  const root = fixture(t);
  release.add(root, 'patch', 'Fixed', 'Fix it');
  const before = snapshot(root);
  const logs = [];
  assert.equal(release.main(root, ['version', '--dry-run'], { log: value => logs.push(value), error: assert.fail }), 0);
  assert.match(logs[0], /## \[0\.1\.5\]/);
  assert.deepEqual(snapshot(root), before);
});

for (const [name, content] of [
  ['missing', 'No frontmatter'],
  ['bump', '---\nbump: huge\nsection: Fixed\n---\nText'],
  ['section', '---\nbump: patch\nsection: Other\n---\nText'],
  ['empty', '---\nbump: patch\nsection: Fixed\n---\n']
]) test(`invalid ${name} aborts before any write`, t => {
  const root = fixture(t);
  release.add(root, 'patch', 'Added', 'Valid entry');
  fs.writeFileSync(path.join(root, '.changeset', 'z-invalid.md'), content);
  const before = snapshot(root);
  const errors = [];
  assert.equal(release.main(root, ['version'], { log: assert.fail, error: value => errors.push(value) }), 1);
  assert.match(errors[0], /z-invalid\.md:/);
  assert.deepEqual(snapshot(root), before);
});

test('empty CLI exits 1 without writing; empty status exits 0', t => {
  const root = fixture(t);
  const before = snapshot(root);
  const errors = [];
  assert.equal(release.main(root, ['version'], { log: assert.fail, error: value => errors.push(value) }), 1);
  assert.match(errors[0], /No pending/);
  assert.equal(release.main(root, ['status'], { log() {}, error: assert.fail }), 0);
  assert.deepEqual(snapshot(root), before);
});

test('add creates unique slugs and validates arguments without writes', t => {
  const root = fixture(t);
  assert.equal(release.add(root, 'patch', 'Fixed', 'Hello, World!'), '.changeset/hello-world.md');
  assert.equal(release.add(root, 'minor', 'Added', 'Hello, World!'), '.changeset/hello-world-1.md');
  const before = snapshot(root);
  assert.throws(() => release.add(root, 'huge', 'Fixed', 'Bad'), /unknown bump/);
  assert.throws(() => release.add(root, 'patch', 'Other', 'Bad'), /unknown section/);
  assert.deepEqual(snapshot(root), before);
  assert.equal(release.readPending(root).version, '0.2.0');
});
