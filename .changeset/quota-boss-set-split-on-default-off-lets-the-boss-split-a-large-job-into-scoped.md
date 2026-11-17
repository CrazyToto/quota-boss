---
bump: patch
section: Added
---
`quota-boss set split on` (default off) lets the boss split a large job into scoped worker copies: `worktree add --scope <paths> --plan <file>`, and `worktree merge` of several copies rejects files outside a scope or shared between copies before merging any.
