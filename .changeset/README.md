# Changelog entries

Create one entry per change with:

```sh
node tools/release.js add patch Fixed "Describe the change."
```

Each Markdown file has this format (README.md is ignored):

```md
---
bump: patch
section: Fixed
---
Describe the change, including any Markdown continuation lines.
```

Use `patch`, `minor` or `major`; sections are Added, Changed, Deprecated,
Removed, Fixed and Security. A missing bullet prefix is added automatically.
Names are generated from the text and never overwrite existing entries.

`node tools/release.js status` lists pending files and the next version.
`node tools/release.js version --dry-run` previews the release without writes.
`node tools/release.js version` updates package.json and CHANGELOG.md and removes
consumed entries. Any existing Unreleased entries also count as a patch bump.
The highest requested bump wins, using standard semver even before 1.0;
a patch on a prerelease removes its prerelease suffix. Release dates use local time.
Commit the resulting release files before tagging the version.
