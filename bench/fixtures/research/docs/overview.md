# Qelvorn operator manual

Current version: **2.8.1**.
This vendored manual describes the fictional Qelvorn command-line tool.
Qelvorn packs local workspace manifests into bundles for an internal relay.
It can also inspect a bundle without contacting a relay.
The command name is `qelvorn` and the configuration prefix is `QELVORN_`.
The fixture contains documentation only; no executable is supplied.

## Reading this manual

Pages include current references and retained examples from earlier releases.
An explicit release label limits a statement to that release.
For changed defaults, apply changes through the current version above.
The [changelog](CHANGELOG.md) records changes in release order.
The [migration guide](migration.md) identifies incompatible schema changes.
An explicit user setting survives an upgrade unless its key was removed.
A historical default is not an explicit user setting.
An example command does not change a documented default.
Unless a section says otherwise, all paths are relative to the workspace.
All time quantities state their units; bare integers have no inferred unit.

## The workspace model

A workspace is a directory containing a `Qelvornfile` manifest.
The manifest assigns stable logical names to local inputs.
The workspace identifier is independent of the directory basename.
A canonical identifier and manifest schema form a workspace fingerprint.
Copying a directory does not automatically create a new identifier.
Changing the identifier invalidates cached leases for that workspace.
Bundles carry fingerprints so a relay can reject accidental cross-project reuse.
The relay never interprets local filesystem paths as authorization rules.

## Main commands

| Command | Purpose | Contacts relay by default |
| --- | --- | --- |
| `init` | Create a manifest and configuration skeleton | No |
| `plan` | Resolve inputs and display proposed changes | No |
| `pack` | Write a local bundle | No |
| `push` | Upload a bundle and commit a receipt | Yes |
| `inspect` | Read a local bundle or named receipt | Only for remote receipts |
| `cache` | List, verify, or prune cached material | No |
| `plugin` | Inspect explicitly installed plugins | No |
| `doctor` | Report installation and workspace health | Only with `--probe` |
| `config` | Explain or validate effective configuration | No |

## A normal run

```sh
qelvorn init --workspace atlas
qelvorn config validate
qelvorn plan
qelvorn pack --output atlas.qvb
qelvorn inspect atlas.qvb
qelvorn push atlas.qvb --endpoint relay.example.invalid
```

The example endpoint is a placeholder, not a public service.
`plan` and `pack` compute the same content hashes for unchanged inputs.
`push` may reuse a compatible cached receipt after validation.
A successful upload is not a successful commit until the receipt is stored.
See [retries](retries.md) for the boundary between upload and commit attempts.

## Documentation map

- [Install](install.md): archives, checksums, directory ownership, removal.
- [Configuration](configuration.md): types, base values, and field validation.
- [CLI](cli.md): argument parsing and command-specific flags.
- [Environment](environment.md): exported settings and empty values.
- [Precedence](precedence.md): selection order and source diagnostics.
- [Authentication errors](authentication-errors.md): symbolic failures and exits.
- [Plugins](plugins.md): capabilities, loading, and execution boundaries.
- [Caching](caching.md): retained cache layout and lease examples.
- [Retries](retries.md): scheduling and deterministic backoff.
- [Limits](limits.md): hard ceilings versus adjustable budgets.
- [Migration](migration.md): removals and version transitions.
- [FAQ](FAQ.md): operational explanations and common mistakes.
- [Changelog](CHANGELOG.md): changes from 2.3.0 through 2.8.1.
- [Profiles](profiles.md): selecting and merging named environments.
- [Manifests](manifests.md): entry identity and bundle construction.

## Stability boundaries

Configuration keys are case-sensitive, including keys inside profiles.
Symbolic error codes remain stable within a major version.
Human error messages may gain more context in patch releases.
JSON event fields are additive within the 2.x event schema.
Terminal rendering is not a machine interface.
Plugins cannot raise hard limits compiled into the host.
The relay protocol version is distinct from the CLI release number.
The `schema = 2` configuration field does not mean CLI version 2.0.

## Offline operation

Local inspection needs neither relay credentials nor an active account.
`--offline` blocks relay requests before a socket is opened.
It does not disable local plugins that have already been installed.
A remote receipt cannot be fetched offline unless already cached.
Network retry settings do not apply to missing local files.
`doctor` without `--probe` is safe in a disconnected environment.
No command downloads a plugin merely because it appears in a manifest.
Documentation examples use only fictional endpoints and local artifacts.
