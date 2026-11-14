'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const BUMPS = ['patch', 'minor', 'major'];

function validate(bump, section, file) {
  if (!BUMPS.includes(bump)) throw new Error(`${file}: unknown bump "${bump}"`);
  if (!SECTIONS.includes(section)) throw new Error(`${file}: unknown section "${section}"`);
}

function parseChangeset(text, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: missing or invalid frontmatter`);
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(bump|section):\s*(\S+)\s*$/.exec(line);
    if (!field || fields[field[1]]) throw new Error(`${file}: invalid frontmatter field`);
    fields[field[1]] = field[2];
  }
  validate(fields.bump, fields.section, file);
  const entry = match[2].trim();
  if (!entry) throw new Error(`${file}: entry text is empty`);
  return { ...fields, entry: /^- /.test(entry) ? entry : `- ${entry}`, file };
}

function bumpVersion(version, bump) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`package.json: invalid version "${version}"`);
  let [, major, minor, patch, prerelease] = match;
  [major, minor, patch] = [major, minor, patch].map(Number);
  if (bump === 'major') { if (!prerelease || minor || patch) major++; minor = 0; patch = 0; }
  else if (bump === 'minor') { if (!prerelease || patch) minor++; patch = 0; }
  else if (bump === 'patch') { if (!prerelease) patch++; }
  else throw new Error(`Unknown bump "${bump}"`);
  return `${major}.${minor}.${patch}`;
}

function readPending(root) {
  const directory = path.join(root, '.changeset');
  const changesets = fs.existsSync(directory) ? fs.readdirSync(directory).sort()
    .filter(file => file.endsWith('.md') && file !== 'README.md')
    .map(file => parseChangeset(fs.readFileSync(path.join(directory, file), 'utf8'), `.changeset/${file}`)) : [];
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const heading = /^## \[Unreleased\][ \t]*\r?$/m.exec(changelog);
  if (!heading) throw new Error('CHANGELOG.md: missing ## [Unreleased] heading');
  const start = heading.index + heading[0].length;
  const tail = changelog.slice(start);
  const next = /^## /m.exec(tail);
  const end = next ? start + next.index : changelog.length;
  const entries = [...changesets];
  let section;
  let lines = [];
  function flush() {
    const entry = lines.join('\n').trim();
    if (entry) {
      if (!section) throw new Error('CHANGELOG.md: Unreleased entry has no section');
      entries.push({ bump: 'patch', section, entry: /^- /.test(entry) ? entry : `- ${entry}` });
    }
    lines = [];
  }
  for (const line of changelog.slice(start, end).split(/\r?\n/)) {
    const title = /^### (.+?)\s*$/.exec(line);
    if (title) {
      flush();
      section = title[1];
      validate('patch', section, 'CHANGELOG.md');
    } else if (/^- /.test(line)) { flush(); lines.push(line); }
    else lines.push(line);
  }
  flush();
  const packageText = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const current = JSON.parse(packageText).version;
  const bump = entries.reduce((best, entry) => BUMPS.indexOf(entry.bump) > BUMPS.indexOf(best) ? entry.bump : best, 'patch');
  return { changesets, entries, changelog, start, end, packageText, current, version: bumpVersion(current, bump) };
}

function add(root, bump, section, text) {
  validate(bump, section, 'add');
  if (!text || !text.trim()) throw new Error('add: entry text is empty');
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '') || 'entry';
  const directory = path.join(root, '.changeset');
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; ; index++) {
    const file = `${slug}${index ? `-${index}` : ''}.md`;
    if (file === 'README.md') continue;
    try {
      fs.writeFileSync(path.join(directory, file), `---\nbump: ${bump}\nsection: ${section}\n---\n${text.trim()}\n`, { flag: 'wx' });
      return `.changeset/${file}`;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

function version(root, dryRun = false, date = new Date()) {
  const pending = readPending(root);
  if (!pending.entries.length) throw new Error('No pending changesets or Unreleased entries');
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const sections = SECTIONS.filter(section => pending.entries.some(entry => entry.section === section))
    .map(section => `### ${section}\n\n${pending.entries.filter(entry => entry.section === section).map(entry => entry.entry).join('\n\n')}`);
  const release = `## [${pending.version}] - ${day}\n\n${sections.join('\n\n')}\n\n`;
  if (!dryRun) {
    const eol = pending.changelog.includes('\r\n') ? '\r\n' : '\n';
    const changelog = pending.changelog.slice(0, pending.start) + eol + eol + release.replace(/\r?\n/g, eol) + pending.changelog.slice(pending.end);
    // Match the top-level version, leaving every other byte of package.json intact.
    const packageText = pending.packageText;
    const versionField = /"version"\s*:\s*"[^"\\]*"/g;
    let match;
    let depth = 0;
    let replacement;
    // JSON.parse has validated the document; track nesting while skipping strings.
    const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]]/g;
    while ((match = tokens.exec(packageText))) {
      if (match[0] === '{' || match[0] === '[') depth++;
      else if (match[0] === '}' || match[0] === ']') depth--;
      else if (depth === 1 && match[0] === '"version"') {
        versionField.lastIndex = match.index;
        const field = versionField.exec(packageText);
        if (field && field.index === match.index) replacement = { index: field.index, text: field[0] };
      }
    }
    if (!replacement) throw new Error('package.json: missing version string');
    const updated = replacement.text.replace(/"[^"\\]*"$/, JSON.stringify(pending.version));
    fs.writeFileSync(path.join(root, 'package.json'), packageText.slice(0, replacement.index) + updated + packageText.slice(replacement.index + replacement.text.length));
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);
    for (const changeset of pending.changesets) fs.unlinkSync(path.join(root, changeset.file));
  }
  return release;
}

function main(root, args, output = console) {
  try {
    if (args[0] === 'add' && args.length === 4) output.log(add(root, ...args.slice(1)));
    else if (args[0] === 'status' && args.length === 1) {
      const pending = readPending(root);
      output.log(pending.entries.length ? `Next release: ${pending.version}` : `No pending changes; current version: ${pending.current}`);
      for (const entry of pending.changesets) output.log(`${entry.file}: ${entry.bump} ${entry.section}`);
      if (pending.entries.length > pending.changesets.length) output.log('CHANGELOG.md: Unreleased entries (patch)');
    } else if (args[0] === 'version' && (args.length === 1 || (args.length === 2 && args[1] === '--dry-run'))) output.log(version(root, args[1] === '--dry-run'));
    else throw new Error('Usage: release.js add <patch|minor|major> <Section> "<text>" | status | version [--dry-run]');
    return 0;
  } catch (error) { output.error(error.message); return 1; }
}

if (require.main === module) process.exitCode = main(path.resolve(__dirname, '..'), process.argv.slice(2));
module.exports = { add, bumpVersion, main, parseChangeset, readPending, version };
