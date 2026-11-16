# Authentication errors

This page began as a relay-login troubleshooting note in release 2.3.
It now holds the complete symbolic error catalog, including local failures.
The historical title is retained for existing bookmarks.
Not every code on this page indicates an authentication problem.
Always read the symbolic code before changing credentials.

## Diagnostic envelope

Fatal diagnostics include `code`, `message`, `phase`, and `retryable` fields.
Human output prints the code before the message on stderr.
Structured diagnostics use one JSON object per line on stderr.
Ordinary command results remain on stdout.
The same process status can represent several different symbolic codes.
Automation should inspect `code` rather than matching a human sentence.

## Error code table

| Symbolic code | Exit | Retryable | Condition |
| --- | --- | --- | --- |
| `QV_EARG` | 2 | No | Unknown flag, missing operand, or invalid argument form |
| `QV_ECONFIG_PARSE` | 2 | No | Selected TOML file cannot be parsed |
| `QV_ECONFIG_KEY` | 2 | No | Unknown or removed configuration option |
| `QV_ECONFIG_VALUE` | 2 | No | Recognized option has invalid type or range |
| `QV_EPROFILE_CYCLE` | 2 | No | Profile inheritance graph contains a cycle |
| `QV_ESCHEMA_CATALOG` | 4 | No | Installed built-in schema catalog is unavailable |
| `QV_EPLATFORM` | 4 | No | Unsupported operating system or executable ABI |
| `QV_EMANIFEST_LIMIT` | 4 | No | Manifest entry count exceeds the hard ceiling |
| `QV_EINPUT_MISSING` | 4 | No | Required local input path is missing |
| `QV_EINPUT_ESCAPE` | 4 | No | Input resolves outside the workspace root |
| `QV_EBLOB_DIGEST` | 4 | No | Local cached blob bytes do not match their digest |
| `QV_ECACHE_OWNER` | 4 | No | Cache ownership prevents safe reads or writes |
| `QV_ECACHE_LOCK` | 4 | No | Local cache writer lock cannot be acquired |
| `QV_ELEASE_SCOPE` | 4 | No | Cached lease workspace fingerprint differs from active workspace |
| `QV_ELEASE_EXPIRED` | 4 | No | Expired lease requested in strict cache-only mode |
| `QV_EOFFLINE_MISS` | 4 | No | Required receipt is absent while network access is disabled |
| `QV_ENET_CONNECT` | 6 | Yes | Relay connection cannot be established |
| `QV_ENET_TIMEOUT` | 6 | Yes | An established relay request times out |
| `QV_ERELAY_BUSY` | 6 | Yes | Relay temporarily rejects work due to capacity |
| `QV_EAUTH_MISSING` | 6 | No | Authenticated request has no selected token |
| `QV_EAUTH_REJECTED` | 6 | No | Relay rejects the supplied token |
| `QV_ERECEIPT_SIGNATURE` | 6 | No | Remote receipt signature does not verify |
| `QV_EDEADLINE` | 6 | No | Overall operation deadline expires |
| `QV_EPLUGIN_MISSING` | 8 | No | Required plugin is absent or disabled |
| `QV_EPLUGIN_TIMEOUT` | 8 | No | Hook exceeds its per-invocation time budget |
| `QV_EPLUGIN_RESULT` | 8 | No | Hook returns an invalid response or exits unsuccessfully |

Retryable means eligible for the configured retry scheduler.
It does not promise another attempt if the budget or deadline is exhausted.
The `retryable` diagnostic field remains true on an exhausted transport failure.
The scheduler's attempt count is a separate diagnostic field.

## Successful probe, failed cached lease

A health probe tests relay reachability, not local cache identity.
A valid token can coexist with a lease created for another workspace.
When opening a cached lease, Qelvorn compares its stored workspace fingerprint.
If it differs from the active workspace, the code is `QV_ELEASE_SCOPE`.
This remains the code when the endpoint probe succeeds and credentials are accepted.
The host performs this check locally before attempting lease reuse.
Retrying the request cannot repair the stored fingerprint.
Inspect the workspace identifier and choose the correct cache namespace.
After confirming identity, remove the mismatched lease with `cache prune --expired`.
Scope-invalid leases are considered ineligible and included in that prune operation.
Do not disable receipt verification or rotate a valid token to resolve this case.

## Authentication failures

`QV_EAUTH_MISSING` means no nonempty credential source was selected.
Check the direct token and token-file variables described in [environment](environment.md).
`QV_EAUTH_REJECTED` means the relay received a token but refused it.
The host does not retry either authentication error.
A relay capacity rejection is `QV_ERELAY_BUSY`, even for an authenticated client.
A TLS connection failure is `QV_ENET_CONNECT`, not `QV_EAUTH_REJECTED`.
Credential values are redacted from diagnostics by default.

## Local integrity failures

Digest mismatches concern bytes; lease scope mismatches concern identity.
A lease can have a valid signature and still belong to another workspace.
A blob can belong to the right workspace and still be corrupted.
`cache verify` reports each integrity problem separately.
An expired lease may be refreshed online under ordinary cache policy.
Strict cache-only mode reports expiry instead of refreshing it.
Ordinary offline lookup of an absent receipt reports `QV_EOFFLINE_MISS`.

## Capturing a useful report

Record the symbolic code, executable version, command, and phase.
Include whether the input was a local bundle or a remote receipt selector.
Use `config explain` to record relevant nonsecret effective settings.
Do not include token contents or unredacted endpoint credentials.
For lease issues include both fingerprints, shortened consistently if necessary.
For retries include attempt ordinal and scheduled wait, not just wall-clock duration.
Use [limits](limits.md) to distinguish a hard ceiling from an adjustable budget.
