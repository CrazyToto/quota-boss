---
bump: patch
section: Added
---
`route --needs image,pdf,...` and `--context <tokens>` skip every route whose model cannot take the input (unknown counts as not supported), and a row with no such route says so instead of guessing.
