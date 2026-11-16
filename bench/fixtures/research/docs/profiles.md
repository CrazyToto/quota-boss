# Named configuration profiles

Profiles collect related configuration overrides under a stable name.
They do not select a different manifest or executable version.
No profile is active unless a selector supplies its name.
Selection and ordinary setting precedence are separate operations.

## Declaring profiles

Profiles are tables under the reserved `profiles` root.
Each profile contains ordinary configuration tables and an optional `extends` field.
Profile names match `[a-z][a-z0-9-]{0,31}`.
Names are case-sensitive and must not be empty.
Root metadata such as `schema` cannot appear inside a profile.

```toml
schema = 2

[transfer]
workers = 6

[profiles.staging.network]
endpoint = "https://staging.example.invalid"

[profiles.staging.transfer]
workers = 2

[profiles.production.network]
endpoint = "https://relay.example.invalid"

[profiles.production.transfer]
workers = 12
```

With no profile selected, the example uses the base worker value.
Selecting staging overlays its endpoint and worker count.
It does not alter unrelated base logging settings.
The endpoint values are fictional placeholders.

## Selecting a profile

Use `--profile staging` for an explicit invocation-level selector.
Use `QELVORN_PROFILE=staging` to select it through the process environment.
The flag wins when both selectors are nonempty.
An empty environment selector is treated as absent.
Selecting an undefined name fails validation rather than silently using base values.
A profile selector does not make profile contents equivalent to CLI flags.
Ordinary mapped environment values and flags can override selected profile leaves.

## Profiles across files

Without an explicit file selector, user and workspace files may both declare profiles.
Matching profile names merge by leaf, with workspace leaves taking priority.
Different names remain independent candidates for selection.
A selected profile can inherit leaves declared in the user file.
Use `config explain` to inspect the source file for every effective leaf.
When an explicit file is selected, only its profile declarations are available.
Profiles from ignored discovered files do not participate.

## Inheritance

`extends` names one parent profile in the same resolved profile registry.
The parent is applied before the child.
The child's explicitly supplied leaves replace matching parent leaves.
An omitted child leaf preserves its inherited value.
Lists replace inherited lists in full, including an explicit empty list.
There is no multiple inheritance and no implicit profile named `default`.
The maximum inheritance depth is four profiles, counting the selected profile.
A missing parent is a configuration validation error.
A cycle produces `QV_EPROFILE_CYCLE`, regardless of cycle length.

```toml
[profiles.audit]
extends = "staging"

[profiles.audit.log]
level = "debug"
```

The audit profile inherits staging's endpoint and worker count.
Its explicit log level replaces any inherited log level.
A separate `QELVORN_LOG_LEVEL=error` would still override that profile leaf.

## Paths inside profiles

Paths resolve against the file in which the leaf value was declared.
They do not resolve against a parent profile's file or the shell directory.
This matters when a workspace profile inherits a user-file cache directory.
Environment and flag paths continue to resolve against the process working directory.
Profile selection does not change these path bases.

## Validation and inspection

All profile declarations are structurally validated when their files are loaded.
Selected-profile cross-field constraints are checked after ordinary overlays.
Unknown keys inside a profile remain errors even if the profile is not selected.
Deprecated keys produce the same warnings as they do in base tables.
Removed keys are not accepted as a way to maintain an older-version profile.
Keep release-specific incompatible configurations in separate explicitly selected files.
See [migration](migration.md) for the exact release of each removal.
See [precedence](precedence.md) for source priority after profile resolution.
