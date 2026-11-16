# Hard limits and adjustable budgets

Qelvorn distinguishes compiled ceilings from configurable operating budgets.
A plugin, profile, or environment variable cannot raise a compiled ceiling.
A lower relay allowance can reduce runtime capacity after local validation.
All byte counts on this page use bytes, not rounded decimal display units.

## Manifest limits

| Resource | Hard maximum | What is counted |
| --- | --- | --- |
| Entries per manifest | `8192` | Every declared entry, including disabled entries |
| Logical entry name | `128` bytes | UTF-8 bytes after normalization |
| Workspace identifier | `48` characters | Lowercase ASCII letters, digits, and hyphens |
| Hooks per entry | `16` | Required and optional declarations together |
| Manifest source | `2097152` bytes | Raw TOML bytes before parsing |
| Nested include depth | `8` | Root manifest at depth zero |

Entry count is validated before the `enabled` filter is applied.
Disabling entries therefore cannot bypass the entries-per-manifest ceiling.
Duplicate names are invalid even when one declaration is disabled.
Entries brought in by includes count toward the same manifest-wide ceiling.
The include-depth limit does not grant a separate entry allowance per file.
Exceeding the entry ceiling produces `QV_EMANIFEST_LIMIT` before plugin execution.

## Bundle limits

| Resource | Hard maximum | Notes |
| --- | --- | --- |
| Uncompressed bundle payload | `8589934592` bytes | Sum of transformed entry bytes |
| Single transformed entry | `1073741824` bytes | Checked while streaming |
| Bundle metadata header | `4194304` bytes | Includes entry index and hook identities |
| Receipt JSON | `262144` bytes | Before JSON parsing |
| Lease JSON | `65536` bytes | Before JSON parsing |

The payload ceiling excludes the header but includes empty-entry length zero.
Compression can reduce stored bytes without raising uncompressed limits.
Transform output length is checked even when an input was much smaller.
A bundle with a truncated header fails integrity validation before size negotiation.
The cache target can be smaller than a valid bundle's payload ceiling.
In that case unpinned blobs may be evicted immediately after the operation.

## Configurable budgets

| Budget | Accepted range | Scope |
| --- | --- | --- |
| `transfer.workers` | `1..32` | One push operation |
| `transfer.chunkBytes` | `65536..8388608` | Each chunk, except shorter final chunk |
| `retry.maxRetries` | `0..8` | Each retryable transport operation |
| `plugin.timeoutMs` | `50..30000` | One hook invocation |
| `cache.ttlSeconds` | `0..604800` | Local lease reuse age |
| `transfer.deadlineMs` | `0..3600000` | Complete operation, zero disables |

Defaults are in [configuration](configuration.md) or the linked release notes.
The maximum accepted retry count is not the default retry count.
The largest worker value is not a promise of that many relay slots.
Timeout ranges do not alter backoff constants.

## Relay negotiation

The relay may advertise a session chunk allowance below the worker setting.
Active chunk requests use the smaller of those two values.
The effective configuration shown by `config explain` remains the configured value.
The negotiated allowance appears separately in transfer diagnostics.
An allowance of zero is a busy response, not a valid ongoing session limit.
The busy response may be eligible for ordinary backoff.

## File and path constraints

Input paths must resolve within the canonical workspace root.
Absolute input paths are accepted only when they resolve inside that root.
Path containment is evaluated after symlink resolution.
Case comparisons follow the host filesystem's actual behavior.
Bundle entry names use their own case-sensitive logical namespace.
A platform's path length limit may be lower than Qelvorn's logical name limit.
Use short local input paths when operating on older filesystems.

## Resource planning

Each active worker can buffer up to one configured chunk plus protocol overhead.
Reducing workers lowers concurrent transfer memory use.
Reducing chunk size increases request count for the same payload.
Pending retries release their worker slots while sleeping.
Plugin scratch space is accounted separately from cache blob bytes.
Pinned blobs can make temporary disk use exceed the configured cache target.
Reserve space for both a local bundle output and its cached blobs when packing.
Do not infer exact peak memory solely from the uncompressed payload ceiling.

## Failure timing

Manifest counts and key syntax are validated before reading entry contents.
Entry size is validated while content is read or transformed.
Bundle payload size is checked as the running uncompressed total increases.
Relay allowances are known only after session establishment.
See [authentication errors](authentication-errors.md) for symbolic failure codes.
