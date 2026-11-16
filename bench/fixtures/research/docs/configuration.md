# Configuration reference

Qelvorn reads TOML configuration using schema 2.
Keys use dotted paths in this reference and table headers in TOML files.
Unless marked version-dependent, defaults below apply to the current release.
Version-dependent defaults must be resolved using their linked release notes.
Unknown keys are errors; arbitrary plugin settings belong under `plugin.settings`.
The [precedence rules](precedence.md) determine which supplied value wins.

## Root fields

### `schema`

- Type: integer; default: `2`; only supported value: `2`.
- Selects the configuration grammar, not the executable release.
- A missing field is equivalent to the default.
- A manifest has its own separate schema field.

### `workspace.id`

- Type: string; default: the identifier in `Qelvornfile`.
- Must match `[a-z][a-z0-9-]{0,47}`.
- An explicit value must equal the manifest identifier.
- Directory names are not used as fallback identifiers.

### `workspace.root`

- Type: path string; default: the directory containing `Qelvornfile`.
- Relative values resolve against the containing configuration file.
- The resolved directory must contain the selected manifest.
- Symlinks are resolved before computing path containment.

### `workspace.followSymlinks`

- Type: boolean; default: `false`.
- When enabled, entry targets may follow symlinks within the workspace root.
- It never permits an input to escape the root.
- Repeated directory targets are visited once during discovery.

## Relay transport

### `network.endpoint`

- Type: string; default: empty string.
- A nonempty endpoint must use the `https` scheme.
- Required by `push`, optional for local bundle inspection.
- Credentials embedded in endpoint URLs are rejected.

### `network.connectTimeoutMs`

- Type: integer; default: `3000`; range: `100..60000` milliseconds.
- Covers DNS resolution and connection establishment together.
- Does not include upload or retry sleep time.
- A completed connection does not reset the operation deadline.

### `network.requestTimeoutMs`

- Type: integer; default: `20000`; range: `100..300000` milliseconds.
- Applies independently to each transfer attempt after connection.
- A retry creates a new request timeout window.
- The operation deadline may terminate that window early.

### `network.proxyUrl`

- Type: string; default: empty string.
- A nonempty value must be an absolute `http` or `https` URL.
- This is the supported proxy key after removal of `network.legacyProxy`.
- An empty value means a direct connection.

### `network.offline`

- Type: boolean; default: `false`.
- Blocks relay requests even when a receipt is absent from the local cache.
- Does not prevent reading local bundles or running local plugin hooks.
- Failure to find offline data produces `QV_EOFFLINE_MISS`.

## Transfer scheduling

### `transfer.workers`

- Type: integer; default: `6`; range: `1..32`.
- Limits simultaneously active bundle chunk requests.
- Waiting retries do not occupy a worker slot.
- The relay may advertise a lower per-session allowance.

### `transfer.chunkBytes`

- Type: integer; default: `1048576`; range: `65536..8388608` bytes.
- Must be a multiple of `4096`.
- The last chunk may contain fewer bytes without padding.
- Changing this value does not alter the manifest fingerprint.

### `transfer.verifyReceipt`

- Type: boolean; default: `true`.
- Verifies a committed receipt before reporting push success.
- Disabling verification does not skip the commit phase.
- The receipt signature is still stored with the upload record.

### `transfer.deadlineMs`

- Type: integer; default: `0`; range: `0..3600000` milliseconds.
- Zero disables the overall operation deadline.
- Positive values include connection, request, queue, and retry sleep time.
- Deadline expiry cancels pending retries rather than shortening their count.

## Retry policy

### `retry.maxRetries`

- Type: integer; default: `4`; range: `0..8`.
- Counts additional attempts after the initial attempt.
- Applies separately to a chunk upload and to receipt commit.
- See [retries](retries.md) for when a sleep is scheduled.

### `retry.jitter`

- Type: boolean; default: `true`.
- Randomizes the scheduled delay to avoid synchronized retry waves.
- Disabled jitter uses the exact deterministic backoff delay.
- It does not change the number of permitted retries.

### `retry.respectServerDelay`

- Type: boolean; default: `true`.
- Allows a valid relay delay hint to raise a retry's wait.
- Invalid or negative hints are ignored and logged.
- It does not make a nonretryable error retryable.

## Cache policy

### `cache.enabled`

- Type: boolean; default: `true`.
- Controls persistent bundle and lease reuse.
- Temporary files are still needed when persistence is disabled.
- Local verification can read a named bundle without consulting the cache.

### `cache.directory`

- Type: path string; default: the platform directory in [install](install.md).
- Relative file values resolve against the containing file.
- The directory is created only when a command needs to write cache data.
- A read-only inspection does not create a missing directory.

### `cache.ttlSeconds`

- Type: integer; range: `0..604800` seconds.
- Default: release-dependent; use [caching](caching.md) and [changelog](CHANGELOG.md).
- Zero disables lease reuse; it does not disable cached bundle blobs.
- Explicit values are retained across upgrades.

### `cache.maxBytes`

- Type: integer; default: `536870912`; range: `1048576..17179869184` bytes.
- This is an eviction target, not the maximum size of an individual bundle.
- Blobs pinned by an active operation are exempt until that operation finishes.
- Temporary writes can briefly exceed the target.

### `cache.verifyOnRead`

- Type: boolean; default: `true`.
- Recomputes a blob digest before returning it to a caller.
- Lease signature and workspace checks are always performed.
- Disabling this field cannot bypass lease scope validation.

## Output and logging

### `output.format`

- Type: string enum; values: `table`, `json`, `ndjson`.
- Default: command- and release-dependent; see [CLI](cli.md) and [migration](migration.md).
- `json` buffers one complete result; `ndjson` streams one object per line.
- The `--format` flag sets this key for commands that produce structured results.

### `output.color`

- Type: string enum; default: `auto`; values: `auto`, `always`, `never`.
- `auto` enables terminal styling only for the table renderer on a terminal.
- Color never inserts escape sequences into JSON or NDJSON records.
- This key replaces the removed `output.colorMode` spelling.

### `output.quiet`

- Type: boolean; default: `false`.
- Suppresses progress and informational summaries on stderr.
- Does not suppress result records on stdout or fatal diagnostics.
- The process exit status is independent of this field.

### `log.level`

- Type: string enum; default: `warn`; values: `error`, `warn`, `info`, `debug`.
- Sets the lowest diagnostic severity written to stderr.
- Does not affect structured results written to stdout.
- Plugin diagnostics are filtered using the same threshold.

### `log.timestamp`

- Type: string enum; default: `rfc3339`; values: `rfc3339`, `unix-ms`, `none`.
- Controls timestamps in diagnostic log records only.
- `rfc3339` uses UTC and includes exactly three fractional second digits.
- Receipt timestamps always use their protocol-defined representation.

### `log.redact`

- Type: boolean; default: `true`.
- Replaces known credential values with `[redacted]` in diagnostics.
- It does not rewrite input files or generated bundles.
- Plugin authors must mark any additional sensitive fields explicitly.

## Plugin policy

### `plugin.enabled`

- Type: boolean; default: `true`.
- Enables hooks from explicitly registered plugins.
- Does not install plugins named by a manifest.
- A required hook fails if its plugin is disabled.

### `plugin.timeoutMs`

- Type: integer; default: `1500`; range: `50..30000` milliseconds.
- Applies to each individual hook invocation.
- A timed-out hook is terminated and is not retried by the network scheduler.
- See [plugins](plugins.md) for hook failure behavior.

### `plugin.allow`

- Type: list of strings; default: `[]`.
- Empty means all explicitly registered plugin identifiers are eligible.
- A nonempty list restricts execution to the listed identifiers.
- Lists replace lower-precedence lists rather than concatenating with them.

### `plugin.searchPath`

- Type: list of paths; default: `[]`.
- Additional local directories searched after the user registry.
- This key was deprecated in 2.5.0 but remains accepted in 2.8.1.
- Prefer explicit registry entries to ambiguous directory scanning.

### `plugin.settings`

- Type: table of plugin identifier to table; default: `{}`.
- Each plugin validates the contents of its own settings table.
- Host validation only verifies that each identifier names a table.
- Unknown host-level keys outside this table remain errors.

## Validation details

Booleans in TOML must be bare `true` or `false`, not strings.
Numeric fields accept base-ten integers without unit suffixes.
Duration names ending in `Ms` use milliseconds, not seconds.
Lists may not contain null values or duplicate plugin identifiers.
Only file-relative path values use the configuration file's directory.
Environment and flag paths use the process working directory instead.
`config explain` displays the selected value and its source for each field.
Secrets are redacted even when `config explain --format json` is selected.
