# Resolving configuration values

Configuration resolution has three stages: discovery, overlay, and validation.
Do not confuse selecting a file with setting every key inside that file.
Selectors are resolved first so the overlay stage has a fixed set of inputs.
There is no automatic retry with a lower-priority source when validation fails.

## File discovery

An explicit `--config` selects exactly one configuration file.
Otherwise a nonempty `QELVORN_CONFIG` selects exactly one file.
With either selector, ordinary user and workspace files are not loaded.
Without either selector, Qelvorn loads the platform user file if it exists.
It then loads `.qelvorn.toml` in the discovered workspace if that file exists.
A missing optional discovered file is ignored.
A missing explicitly selected file is an error.
Workspace discovery looks for the nearest ancestor containing `Qelvornfile`.
Discovery stops there; parent workspaces do not contribute another file.

## Overlay order

For each ordinary configuration key, highest priority wins:

1. Explicit command-line flag.
2. Nonempty mapped environment variable, with documented empty-string exceptions.
3. Selected profile overlay from the chosen configuration files.
4. Workspace configuration file's base table.
5. User configuration file's base table.
6. Built-in default for the running release.

With one explicitly selected file, its base table replaces levels 4 and 5.
Profiles declared in that file still occupy level 3.
Absent values do not participate and cannot erase a lower-priority value.
An explicitly supplied false boolean participates just like true.
A scalar value replaces the entire previous scalar.
A list replaces the entire previous list rather than appending to it.
Tables merge by leaf key; setting one leaf does not replace its siblings.

## Selection versus values

`--profile` has priority over `QELVORN_PROFILE` for choosing a profile name.
Neither selector raises profile values above mapped environment variables.
Likewise, `--config` selects a file but does not make its values flags.
For example, a selected file's log level still loses to `--log-level debug`.
The built-in profile selector is empty, so no profile is applied by default.
Unknown selected profile names are validation errors.
Profiles are resolved before ordinary mapped environment values are overlaid.

## Worked leaf example

Suppose a user file supplies `transfer.workers = 10`.
The workspace file supplies `transfer.workers = 8`.
The selected profile supplies `transfer.workers = 5`.
The process supplies `QELVORN_WORKERS=4`.
The command includes `--workers 2`.
The effective configured worker count is 2, attributed to the command line.
Removing that flag exposes 4, attributed to the environment.
Removing the environment variable as well exposes the profile value 5.
The relay's session allowance can reduce active concurrency after resolution.
That runtime allowance does not change the effective configured worker count.

## Validation boundaries

Every loaded file is parsed before the final overlay is constructed.
Unknown keys and syntactically invalid TOML fail even in an overridden file.
Recognized leaf values are type-checked when their source is read.
The selected effective values are then checked against cross-field constraints.
An invalid environment integer fails even if a valid flag would replace it.
For valid values, ordinary priority alone determines the selected source.
No source is guessed from the value's resemblance to a built-in default.

## Empty values and disabling

An empty profile selector means that no profile is selected.
An empty plugin allowlist means all explicitly registered plugins are eligible.
It does not mean plugins are disabled.
Use `plugin.enabled = false` or `--no-plugins` to disable hooks.
An empty endpoint explicitly clears an inherited endpoint.
An empty environment worker value is treated as absent.
Zero retries disables additional attempts while preserving the initial attempt.
Zero deadline disables the overall deadline.

## Inspecting the resolved result

```sh
qelvorn config explain --key transfer.workers
qelvorn config explain --format json
qelvorn config validate --strict
```

`config explain` attributes a value to `flag`, `environment`, `profile`, `file`, or `default`.
For file values it also reports the normalized absolute file path.
For profile values it includes the profile name and declaration file.
It reports the selected value before relay concurrency negotiation.
Redacted secret placeholders are never candidates in the merge process.
See [environment](environment.md) for the exact mapping of variable names.
See [profiles](profiles.md) for profile inheritance and cycle detection.
