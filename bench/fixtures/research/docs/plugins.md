# Plugin execution

Plugins are local executables registered under stable identifiers.
The host does not search the network for missing executables.
Manifest hook declarations express requirements, not installation instructions.
All plugin examples in this manual use fictional local identifiers.

## Registry records

A registry record has an `id`, `executable`, `api`, and capability list.
The identifier must match `[a-z][a-z0-9-]{0,31}`.
An executable path in a registry record is absolute.
API version 2 is required by the current host.
Two records with the same identifier are an error, not a load-order override.
Registry files are read once before manifest hooks are resolved.

```toml
id = "lint-stone"
executable = "/opt/local/qelvorn-hooks/lint-stone"
api = 2
capabilities = ["read-workspace"]
```

## Discovery order

The user registry is searched first.
Configured `plugin.searchPath` directories are searched afterward in list order.
The legacy search-path key is deprecated but still supported.
An allowlist filters eligible identifiers after discovery.
An empty allowlist permits all explicitly registered identifiers.
Disabled plugins are not executed even when a matching registry record exists.
The host never executes a hook merely to display `plugin inspect` output.

## Hook phases

| Phase | Input | Allowed result |
| --- | --- | --- |
| `validate` | Resolved manifest and workspace fingerprint | Diagnostics and pass/fail |
| `transform` | One entry's byte stream | Replacement bytes plus digest |
| `before-push` | Bundle metadata and endpoint hostname | Diagnostics and pass/fail |
| `after-receipt` | Verified receipt metadata | Diagnostics only |

Validation hooks run before any bundle bytes are written.
Transform hooks run in manifest entry order.
Before-push hooks run after local packing and before relay connection.
After-receipt hooks cannot invalidate an already committed receipt.
A failing after-receipt hook still makes the command report a plugin failure.
The receipt remains available for later local inspection.

## Required and optional hooks

A manifest hook is required unless it explicitly sets `required = false`.
An unavailable required plugin produces `QV_EPLUGIN_MISSING`.
An unavailable optional plugin produces a warning and is skipped.
A present plugin that returns a failing result is not treated as unavailable.
Its failure follows the phase's normal error behavior.
The `--no-plugins` flag can therefore make a manifest with required hooks fail.
It is not a way to silently omit mandatory validation.

## Invocation protocol

The host writes one request object to the child's stdin and then closes it.
The child writes one response object to stdout.
Diagnostic messages must go to stderr.
Additional nonwhitespace stdout bytes make the response invalid.
The host validates declared digest and length after a transform response.
Exit status zero alone is insufficient without a valid response object.
The per-hook timeout is selected by `plugin.timeoutMs`.
Network retry configuration never retries a plugin invocation.

## Capabilities

`read-workspace` permits opening declared workspace inputs.
`write-scratch` permits temporary output inside the host-provided scratch directory.
`relay-token` permits receiving the selected token in a child-only variable.
No capability permits altering the host's effective configuration after resolution.
Capabilities are declarations verified against the local registry policy.
They are not an operating-system sandbox by themselves.
Deploy hooks only when their local executable provenance is acceptable.

## Cache interactions

The plugin identifier, API version, and declared plugin version enter transform cache keys.
Plugin settings are serialized canonically before hashing into those keys.
Changing diagnostic log level does not invalidate transformed bytes.
Changing a transform setting invalidates results for affected entries.
Validation hooks run even when transform bytes are reused from cache.
An after-receipt hook is not replayed just because a receipt is inspected locally.

## Compatibility checks

Use `plugin inspect <id> --format json` to inspect a registry entry.
This command validates the record and executable path without invoking the executable.
Use `doctor` to detect duplicate identifiers and missing paths.
A plugin API mismatch produces `QV_EPLUGIN_RESULT` during registry validation.
The registry does not accept an unknown future API optimistically.
Release 2.5.0 deprecated path scanning but did not remove it.
See [migration](migration.md) before deleting keys during an upgrade.
