# Qelvorn release history

Entries are newest first.
Only explicitly listed default changes alter earlier defaults.
Configuration removals are also collected in the [migration guide](migration.md).
The executable version currently targeted by this manual is in [overview](overview.md).

## 2.8.1 - 2025-09-18

### Fixed

- Compare canonical workspace fingerprints consistently after directory relocation.
- Report the active and stored fingerprints for a local lease scope mismatch.
- Preserve the original transport code when the final retry is exhausted.
- Avoid printing a progress footer after interrupted NDJSON inspection.

### Compatibility

- No configuration keys removed.
- No default values changed.
- Cache layout remains version 3 and plugin API remains version 2.

## 2.8.0 - 2025-08-04

### Added

- Add `inspect --header-only` for reading bundle metadata without entry expansion.
- Add optional `sourceDigest` to structured entry records.
- Include selected source details in `config explain --key` output.
- Report deprecated plugin path scanning in `doctor`.

### Fixed

- Keep pinned blobs during concurrent cache pruning.
- Count disabled included entries during manifest ceiling validation.
- Redact token-file content from malformed credential diagnostics.

### Compatibility

- No configuration keys removed and no defaults changed.
- Existing JSON consumers must tolerate additive record fields.

## 2.7.0 - 2025-06-12

### Changed

- Change the implicit inspect renderer as described in [migration](migration.md).
- Use that renderer consistently for terminal and redirected output.
- Preserve explicit format overrides without terminal-dependent rewriting.

### Added

- Allow `inspect --entry` to select a logical entry by exact identity.
- Include the negotiated relay worker allowance in debug diagnostics.

### Compatibility

- No configuration keys removed.
- No change to retry budget, lease TTL, or log timestamp defaults.
- Existing explicit table output remains available.

## 2.6.0 - 2025-04-21

### Changed

- Change the default `cache.ttlSeconds` from `900` to `2400` seconds.
- This applies to newly initialized configurations and omitted TTL values.
- Preserve explicitly configured TTL values across upgrades.
- Continue to honor signed server expiry even when the local TTL is longer.

### Removed

- Remove the deprecated `network.timeoutSeconds` compatibility alias.
- Its replacement, `network.requestTimeoutMs`, was introduced in 2.4.0.

### Fixed

- Measure lease age from successful receipt storage rather than temporary-file creation.
- Ignore malformed relay delay hints without consuming another retry slot.

### Compatibility

- Cache layout remains version 3.
- The default retry budget and deterministic backoff constants are unchanged.
- No further TTL default change occurs through 2.8.1.

## 2.5.0 - 2025-02-10

### Removed

- Remove `cache.trustMtime`; reuse relies on content digests.
- Remove `network.legacyProxy`; use the explicit proxy URL field.
- Remove `output.colorMode`; use `output.color`.
- These are the complete configuration-key removals for this release.

### Deprecated

- Deprecate `plugin.searchPath` in favor of explicit registry records.
- Continue accepting that key with a warning, including in later 2.x releases.
- Continue accepting the old timeout alias until its scheduled 2.6.0 removal.

### Added

- Add source attribution to effective configuration diagnostics.
- Add `cache verify --all` for complete offline integrity checks.

## 2.4.0 - 2024-12-02

### Changed

- Move cache layout to version 3 with workspace-scoped lease directories.
- Rename `network.timeoutSeconds` to `network.requestTimeoutMs`.
- Retain the old timeout spelling temporarily as a deprecated alias.
- Convert explicit timeout seconds to milliseconds during manual migration.

### Removed

- Remove `pack.timestamp`; deterministic metadata no longer accepts that override.

### Added

- Add local bundle inspection with selectable `table`, `json`, and `ndjson` formats.
- Retain `table` as the implicit inspect format for this release.
- Add API version 2 plugin registry validation.

## 2.3.0 - 2024-09-16

### Baseline

- Ship schema 2 configuration and cache layout version 2.
- Set lease TTL to 900 seconds in the baseline cache policy.
- Use four additional network retries by default.
- Use 125-millisecond exponential backoff with multiplier 2 and cap 1000 milliseconds.
- Use `rfc3339` diagnostic timestamps and `warn` diagnostic severity.
- Count all manifest entries before filtering disabled declarations.
- Support local packing without a relay token.
