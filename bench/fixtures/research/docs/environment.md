# Environment variables

Qelvorn reads its process environment once at startup.
Changes made by a plugin cannot alter the running host's resolved settings.
Only the names listed here are recognized as host configuration.
An unknown `QELVORN_` name is ignored and reported at debug level.
Names are documented in uppercase for portability.
On a case-sensitive operating system, lowercase names are different variables.

## Configuration selectors

| Variable | Type | Purpose |
| --- | --- | --- |
| `QELVORN_CONFIG` | Path | Select an explicit configuration file |
| `QELVORN_PROFILE` | String | Select a named profile |
| `QELVORN_CACHE_DIR` | Path | Set `cache.directory` |
| `QELVORN_PLUGIN_DIR` | Path | Relocate the user plugin registry |

An explicit `--config` flag wins over `QELVORN_CONFIG`.
The environment file selector is not an extra overlay file.
It replaces ordinary user and workspace file discovery.
`QELVORN_PLUGIN_DIR` changes registry discovery, not `plugin.searchPath`.
An empty selector variable is treated as unset.

## Runtime value mapping

| Variable | Configuration key | Accepted representation |
| --- | --- | --- |
| `QELVORN_ENDPOINT` | `network.endpoint` | Absolute HTTPS URL |
| `QELVORN_OFFLINE` | `network.offline` | Boolean token |
| `QELVORN_WORKERS` | `transfer.workers` | Base-ten integer |
| `QELVORN_CHUNK_BYTES` | `transfer.chunkBytes` | Base-ten integer |
| `QELVORN_DEADLINE_MS` | `transfer.deadlineMs` | Base-ten integer |
| `QELVORN_RETRIES` | `retry.maxRetries` | Base-ten integer |
| `QELVORN_JITTER` | `retry.jitter` | Boolean token |
| `QELVORN_CACHE_TTL` | `cache.ttlSeconds` | Base-ten integer, seconds |
| `QELVORN_CACHE_BYTES` | `cache.maxBytes` | Base-ten integer, bytes |
| `QELVORN_FORMAT` | `output.format` | `table`, `json`, or `ndjson` |
| `QELVORN_COLOR` | `output.color` | `auto`, `always`, or `never` |
| `QELVORN_QUIET` | `output.quiet` | Boolean token |
| `QELVORN_LOG_LEVEL` | `log.level` | `error`, `warn`, `info`, or `debug` |

All mapped values participate in ordinary [precedence](precedence.md).
The variables have no independent defaults when unset.
Leaving a variable absent preserves lower-priority configuration.
Setting a worker variable does not change the built-in worker default for other processes.

## Scalar parsing

Leading and trailing ASCII whitespace is stripped from mapped scalar values.
Boolean tokens are `1`, `0`, `true`, and `false`, without case folding.
The token `yes` is not accepted as a boolean.
Integers permit a leading minus sign but must satisfy the field's range.
Hexadecimal notation and decimal fractions are rejected.
An empty mapped scalar value is treated as unset, except the endpoint and proxy strings.
An empty `QELVORN_ENDPOINT` explicitly clears the endpoint.
There is no host environment variable for `network.proxyUrl`.
That setting must be supplied by a file or left at its empty default.
Enum tokens are case-sensitive after whitespace stripping.

## Credentials

`QELVORN_TOKEN` supplies the relay bearer token directly.
`QELVORN_TOKEN_FILE` names a UTF-8 file containing that token.
The direct token wins if both are nonempty.
A token file may have one trailing line ending, which is removed.
Internal whitespace and additional lines are rejected.
Tokens are not stored as configuration keys and are never shown by `config explain`.
An empty token variable allows the token file to be considered.
Neither variable is consulted for purely local inspection.
Missing credentials are detected before opening an authenticated relay request.

## Shell examples

```sh
QELVORN_WORKERS=9 qelvorn push bundle.qvb
QELVORN_OFFLINE=true qelvorn inspect bundle.qvb
QELVORN_FORMAT=json qelvorn config explain
QELVORN_CACHE_TTL=60 qelvorn inspect receipt:sample
```

Shell syntax is illustrative; use the equivalent assignment in your own shell.
The command-line `--workers` flag can override the first example's variable.
An environment variable cannot override a valid explicit CLI value.
See [profiles](profiles.md) for environment selection versus setting values.

## Child plugin environment

Plugins receive only allowlisted host variables and plugin-specific settings.
They do not inherit relay tokens unless their declared capability permits it.
`QELVORN_HOOK` identifies the current hook phase in the child.
`QELVORN_WORKSPACE_FINGERPRINT` identifies the resolved workspace to the child.
These child-only names are outputs of the host, not accepted host inputs.
Setting them before starting Qelvorn has no effect on workspace selection.
Hook context also includes the resolved root through its structured request.
The process environment is not a supported channel for returning hook results.
