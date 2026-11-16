# Manifests and bundle construction

`Qelvornfile` is a TOML manifest, separate from `.qelvorn.toml` configuration.
It declares what to pack; configuration declares how the host operates.
Both use a schema field, but their supported keys differ.
Configuration keys cannot be placed directly into manifest entry tables.

## Minimal manifest

```toml
schema = 2
workspace = "atlas"

[[entries]]
name = "notes/readme"
path = "notes/readme.txt"
enabled = true

[[entries]]
name = "assets/icon"
path = "assets/icon.bin"
enabled = true
```

Logical names are stable identifiers in the bundle namespace.
Paths identify local sources and may change without renaming logical entries.
Two entries cannot have the same logical name.
Entry ordering in the manifest does not define final bundle ordering.
The host sorts enabled entries by normalized logical name before packing.

## Entry fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | String | Required | Logical entry identifier |
| `path` | Path string | Required | Workspace-relative source |
| `enabled` | Boolean | `true` | Whether to include content in the bundle |
| `mediaType` | String | `application/octet-stream` | Declared payload media type |
| `hooks` | List of tables | `[]` | Entry-level plugin declarations |

An empty logical name is invalid.
Leading slashes and `..` path segments are forbidden in logical names.
Unicode logical names are normalized to NFC before duplicate detection.
Local source paths are resolved against the workspace root.
Actual filesystem containment is checked after symlink resolution.
See [limits](limits.md) for byte and entry ceilings.

## Disabled declarations

A disabled entry remains part of the declared manifest structure.
Its name participates in duplicate detection and total entry counting.
Its content is not read, transformed, or included in the bundle.
A missing source file for a disabled entry is therefore not an input error.
Its field types and logical name must still be valid.
`plan --show-disabled` can display these declarations for auditing.
Ordinary `plan` omits them from proposed packed content.

## Includes

The root `include` list names additional manifest fragments.
Fragments may contribute entries but cannot override the root workspace identifier.
Include paths resolve relative to the declaring manifest fragment.
Every fragment must remain within the canonical workspace root.
A fragment reached twice through different include chains is loaded once.
Include cycles are errors, not a request for recursive expansion.
Flattened entries share one name namespace and one entry ceiling.
The root manifest is at include depth zero.

## Fingerprints

The workspace fingerprint hashes the canonical workspace identifier and manifest schema.
It does not hash the directory basename or absolute checkout path.
A bundle content digest separately includes enabled entry names and transformed bytes.
Renaming the checkout directory alone does not change workspace identity.
Changing the canonical workspace identifier does change it.
Lease validation compares workspace fingerprints before considering reuse age.
Blob sharing uses content identity and does not bypass lease scope checks.

## Deterministic construction

Entry names are normalized before sorting.
Directory traversal order never determines bundle order.
File modification times are not serialized as entry identity.
Transform plugin versions and settings are recorded in the transform index.
The host verifies declared transformed lengths while streaming output.
The bundle header is finalized only after all enabled entries succeed.
A failed pack removes its partial output unless interrupted by operating-system failure.
Replacing an existing output requires the explicit `--replace` flag.

## Validation sequence

Parse manifest syntax and load reachable fragments first.
Validate schema, entry fields, duplicate names, and structural ceilings next.
Resolve paths for enabled entries and enforce workspace containment.
Run required validation hooks before writing bundle content.
Read and transform enabled content while checking size ceilings.
Write the final header and atomically publish the completed output.
Only a completed bundle can proceed into a push session.
Plugin phase details are in [plugins](plugins.md).
Local and relay failure codes are in [authentication errors](authentication-errors.md).
