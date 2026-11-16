# Migrating between Qelvorn 2.x releases

Read transitions in ascending order when skipping releases.
A changed default applies only when no higher-priority source supplies a value.
Removing a key is different from changing its default or deprecating its use.
Removed keys cause `QV_ECONFIG_KEY`; they are not silently ignored.
This guide covers configuration keys, not manifest entry fields.

## Before changing versions

Record `qelvorn --version` and the selected profile name.
Save the output of `config explain --format json` without credentials.
Keep the previous complete archive directory for rollback.
Run `config validate` using the new executable before the first upload.
Use `config validate --strict` to make deprecation warnings fail validation too.
Strict mode does not change which keys are actually removed.

## 2.3.0 to 2.4.0

Cache layout changes from version 2 to version 3.
The host migrates reusable receipt metadata on the first cache write.
It does not mutate named bundle files outside the cache.
Use a separate cache directory if an older executable must keep working.
The configuration option `network.timeoutSeconds` is renamed to `network.requestTimeoutMs`.
Convert explicit values by multiplying whole seconds by 1000.
The old spelling remains a deprecated compatibility alias in 2.4.x and 2.5.x.
Supplying both spellings in one file is a configuration error.
The obsolete configuration option `pack.timestamp` is removed in 2.4.0.
Bundle timestamps now come from the deterministic bundle metadata rules.
This removal belongs to 2.4.0, not the following transition.

## 2.4.x to 2.5.0: removed configuration options

Exactly these three configuration keys are removed in version 2.5.0:

| Removed key | Previous purpose | Replacement or action |
| --- | --- | --- |
| `cache.trustMtime` | Reuse bytes based only on modification time | Remove it; use digest-based cache verification |
| `network.legacyProxy` | Select a relay-specific proxy shim | Use `network.proxyUrl` with an explicit URL |
| `output.colorMode` | Choose terminal coloring policy | Use `output.color` |

There are no other configuration-key removals in 2.5.0.
The new `output.color` key accepts `auto`, `always`, and `never`.
Migrating an explicit old color policy requires an explicit new value.
The old proxy shim boolean cannot be copied into the URL field.
The cache no longer considers modification time sufficient evidence of byte identity.
Removing `cache.trustMtime` does not disable blob reuse.

### Deprecations in the same release

`plugin.searchPath` is deprecated in 2.5.0, but is not removed.
It remains valid in the current release with a warning.
The older timeout alias also remains valid throughout 2.5.x.
Do not include deprecations when listing removals for this version.
Prefer explicit plugin registry entries when convenient.
No automatic plugin installation accompanies that recommendation.

## 2.5.x to 2.6.0

The `network.timeoutSeconds` compatibility alias is removed in 2.6.0.
Use the millisecond key introduced in 2.4.0.
The lease TTL default changes in this release; consult [CHANGELOG](CHANGELOG.md).
The retained baseline cache-policy page still documents its original 2.3.0 values.
An explicit `cache.ttlSeconds` value is preserved, including an explicit zero.
An omitted TTL takes the new default without rewriting the configuration file.
No cache layout version change accompanies the TTL change.
Signed relay expiry continues to cap lease lifetime independently.

## 2.6.x to 2.7.0: inspect output

Beginning with 2.7.0, the built-in `output.format` for `inspect` is `ndjson`.
This replaces the earlier `table` default described by the retained CLI example.
The new default applies to both terminal and redirected stdout.
There is no terminal-detection exception for choosing the inspect format.
Use `qelvorn inspect --format table` to request the older human display.
Explicit flags, environment values, profiles, and file values still take precedence.
Other commands retain their own command-specific built-in format choices.
`config explain` and `plan` still use `table` when their format is otherwise unset.
NDJSON inspection writes one complete JSON object per record followed by a newline.
Scripts must parse records independently rather than parse stdout as one JSON array.
The `json` format remains available when a single buffered result is required.

## 2.7.x to 2.8.0 and 2.8.1

Release 2.8.0 adds `--header-only` for local bundle inspection.
It adds an optional `sourceDigest` field to structured entry records.
Consumers must tolerate unknown additive JSON fields.
Release 2.8.1 fixes a lease fingerprint comparison bug after workspace relocation.
Neither release changes the inspect output default or the lease TTL default.
Neither release removes a configuration key.
Do not downgrade configuration merely because a patch release changed diagnostics.

## Keeping deliberate overrides

A saved file containing an old default is still an explicit override.
To adopt a new built-in default, remove the corresponding explicit leaf value.
Check user files, workspace files, profiles, environment, and flags.
Deleting only a workspace value can expose a user-file value instead of the default.
Use `config explain --key <key>` to verify the resulting source.
The source should say `default` when the built-in policy is intended.

## Rollback constraints

Older hosts may reject newer cache layout metadata.
Use a fresh cache namespace rather than editing layout-version by hand.
Keep manifest and configuration schema versions distinct from release versions.
An old host cannot accept a new enum merely because both use schema 2.
Test local inspection before attempting a rollback upload.
See [install](install.md) for archive selection and directory ownership.
