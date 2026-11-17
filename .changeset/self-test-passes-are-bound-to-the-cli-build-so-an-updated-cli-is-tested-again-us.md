---
bump: patch
section: Added
---
Self-test passes are bound to the CLI build, so an updated CLI is tested again; `use <provider> on` runs the self-test (`--no-test` skips it), and `doctor` and `providers` show a stale test as stale. Models known only from documentation do trivial work after the self-test, normal work after three verified passes, and critical work only with verified normal passes and public scores.
