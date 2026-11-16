# Installing Qelvorn

## Supported archive families

Qelvorn is distributed as an executable plus a built-in schema catalog.
An archive contains `bin/qelvorn`, `share/schema-2.json`, and `LICENSE.txt`.
The Windows archive names the executable `qelvorn.exe`.
There is no runtime package manager and no first-run download.
The documentation-only benchmark does not contain these archives.
All commands on this page describe a fictional installation.

| Archive suffix | Intended system | Runtime dependency |
| --- | --- | --- |
| `linux-x64.tar.gz` | Linux, x86-64 | C library ABI 2.31 or newer |
| `linux-arm64.tar.gz` | Linux, ARM64 | C library ABI 2.31 or newer |
| `darwin-universal.tar.gz` | macOS, both processor families | macOS 13 or newer |
| `windows-x64.zip` | Windows, x86-64 | Windows 10 build 19044 or newer |

## Verify before extraction

1. Obtain the archive and matching checksum from the same internal mirror.
2. Compute the archive's SHA-256 digest locally.
3. Compare the full digest, including leading zeroes.
4. Extract into an empty directory that is not writable by other users.
5. Move the entire directory into its final location.
6. Add only its `bin` subdirectory to `PATH`.

The checksum covers the compressed archive bytes.
It is not the digest of the extracted executable.
A checksum copied from an unrelated version cannot validate a newer archive.
The schema catalog must remain beside the executable's parent directory.
Copying only the executable produces `QV_ESCHEMA_CATALOG` during startup.

## User installation example

```sh
mkdir -p "$HOME/tools/qelvorn-2.8.1"
tar -xzf qelvorn-2.8.1-linux-x64.tar.gz -C "$HOME/tools/qelvorn-2.8.1"
export PATH="$HOME/tools/qelvorn-2.8.1/bin:$PATH"
qelvorn --version
qelvorn doctor
```

`--version` reads the executable's embedded release string.
It does not inspect the workspace or validate its configuration.
`doctor` checks the schema catalog, cache ownership, and plugin registry.
Use `doctor --probe` only when a relay connectivity check is wanted.

## Directory selection

| Purpose | Default on Unix | Default on Windows |
| --- | --- | --- |
| User configuration | `$HOME/.config/qelvorn/config.toml` | `%APPDATA%/Qelvorn/config.toml` |
| User cache | `$HOME/.cache/qelvorn` | `%LOCALAPPDATA%/Qelvorn/cache` |
| Plugin registry | `$HOME/.local/share/qelvorn/plugins` | `%LOCALAPPDATA%/Qelvorn/plugins` |
| Workspace configuration | `.qelvorn.toml` | `.qelvorn.toml` |

These defaults are independent of the current shell's temporary directory.
Changing `PATH` does not relocate either configuration or cached bundles.
`QELVORN_CACHE_DIR` selects an alternate cache root.
`QELVORN_CONFIG` selects a single explicit configuration file.
See [precedence](precedence.md) before combining file selectors.

## Shared machines

Keep a shared executable directory read-only to ordinary users.
Give each user a separate cache and plugin registry.
Do not point two unrelated accounts at one writable cache root.
Lease records contain workspace identity, not login credentials.
Their ownership still matters for lock acquisition and replacement.
A world-writable parent directory is rejected by `doctor --strict`.
The ordinary `doctor` command reports that condition as a warning.

## Upgrade procedure

Stop any long-running `push` operations before replacing the executable.
Install the new archive next to the previous version.
Run the new executable with `config validate` in each maintained workspace.
Review removed keys in the [migration guide](migration.md).
Update the `PATH` entry or an operator-maintained version symlink.
Keep the previous archive until local bundle inspection succeeds.
An upgrade does not rewrite explicit configuration values.
It also does not upgrade plugins without an explicit registry change.

## Rollback and removal

Rollback means selecting a previous complete archive directory.
Do not mix a new executable with an old schema catalog.
Cache layout changes can make older versions refuse newer cache records.
Use a separate cache root when testing a rollback across layout versions.
Removing an executable directory does not remove workspace manifests.
Remove the user cache separately only when retained bundles are unnecessary.
Plugin source directories outside the registry remain user-owned files.
Uninstallation never contacts a relay or revokes remote receipts.

## Installation diagnostics

`QV_ESCHEMA_CATALOG` indicates a missing or unreadable catalog.
`QV_EPLATFORM` indicates an unsupported operating system or ABI.
`QV_ECACHE_OWNER` indicates an unsafe cache owner or permission mode.
An unrecognized shell command usually means `PATH` still points elsewhere.
Use an absolute executable path to distinguish shell lookup from startup errors.
The symbolic code catalog is in [authentication errors](authentication-errors.md).
