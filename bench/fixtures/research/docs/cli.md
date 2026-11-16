# Command-line interface

## Argument grammar

```text
qelvorn [global-options] <command> [command-options] [operands]
```

Global flags may also appear after the command name.
Long flags accept either `--name value` or `--name=value`.
Short option bundles such as `-qv` are not supported.
A literal `--` ends option parsing for all remaining tokens.
An option requiring a value consumes exactly one token.
Duplicate scalar flags use the last occurrence.
A token beginning with `--` is not accepted as a missing flag's value.
Use the equals form for a string value that starts with two hyphens.

## Global flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--help` | None | Print help without opening a workspace |
| `--version` | None | Print embedded executable version |
| `--config` | Path | Select one explicit TOML file |
| `--profile` | Name | Select a named profile |
| `--offline` | None | Set `network.offline` to true |
| `--online` | None | Set `network.offline` to false |
| `--quiet` | None | Set `output.quiet` to true |
| `--log-level` | Enum | Set diagnostic severity threshold |
| `--format` | Enum | Set `output.format` for structured commands |
| `--no-plugins` | None | Disable plugin hook execution |

Help and version are handled before configuration loading.
Other commands validate selected configuration before doing work.
Contradictory boolean flags follow the same last-occurrence rule as scalars.
`--online` is an explicit value and can override an offline environment setting.

## Push flags

| Flag | Value | Configuration key |
| --- | --- | --- |
| `--endpoint` | HTTPS URL | `network.endpoint` |
| `--workers` | Integer | `transfer.workers` |
| `--chunk-bytes` | Integer | `transfer.chunkBytes` |
| `--deadline-ms` | Integer | `transfer.deadlineMs` |
| `--retries` | Integer | `retry.maxRetries` |
| `--no-jitter` | None | `retry.jitter = false` |
| `--verify-receipt` | None | `transfer.verifyReceipt = true` |

`push` takes one bundle path as its sole operand.
Without that operand it packs the current workspace before uploading.
The automatic pack phase still runs enabled validation hooks.
Transfer worker counts do not control plugin concurrency.
`--retries 0` means one initial attempt and no additional attempts.
`--deadline-ms 0` means no overall deadline, not immediate cancellation.

## Inspect flags

`inspect` accepts a local `.qvb` path or `receipt:<identifier>`.
`--header-only` reads metadata without expanding entry records.
`--verify` validates all blob digests before emitting results.
`--entry <name>` selects one logical entry using exact case-sensitive identity.
`--format` controls the serialization of records, not which records are selected.
Local bundles are inspected without credentials.
Remote receipt selectors obey offline and cache policy.

### Retained terminal example: release 2.4.0

In 2.4.0, the default `output.format` for `inspect` is `table`.
This default is the same for terminal and redirected output in that release.
The transcript below is retained to explain older support reports.

```text
$ qelvorn inspect sample.qvb
ENTRY          BYTES  DIGEST
assets/icon    1440   0c28...
notes/readme   901    7a10...
```

Do not infer later release defaults from this transcript.
The [migration guide](migration.md) records the later inspect format transition.
Explicit `--format table` remains available in the current release.

## Other command-specific flags

`pack --output <path>` selects the bundle file to write.
`pack --replace` permits replacing an existing bundle file atomically.
`plan --show-disabled` includes disabled manifest entries in the result.
`cache prune --expired` removes expired leases before considering size pressure.
`cache verify --all` checks every stored blob, including unreferenced blobs.
`plugin inspect <id>` describes a plugin without executing its hooks.
`doctor --probe` checks the configured relay after local checks succeed.
`config explain --key <dotted-key>` displays one resolved setting and its source.
`config validate --strict` treats deprecation warnings as validation failures.

## Output channels

Structured command results go to stdout.
Progress, warnings, and errors go to stderr.
The `--quiet` flag does not remove fatal errors or structured results.
An empty result in NDJSON format writes zero records and exits successfully.
An empty result in JSON format writes an empty array.
The table renderer may print a human-readable empty-state sentence.
Pipe consumers should choose JSON or NDJSON explicitly for long-lived scripts.

## Exit and interruption

Success exits with status 0, including an empty plan.
Status 2 identifies argument or configuration validation failures.
Status 4 identifies local input, cache, and workspace failures.
Status 6 identifies relay or credential failures.
Status 8 identifies plugin failures.
An interrupt exits with status 130 after best-effort temporary-file cleanup.
The full error-code table is in [authentication errors](authentication-errors.md).
Do not use a shared numeric status to distinguish individual symbolic failures.
