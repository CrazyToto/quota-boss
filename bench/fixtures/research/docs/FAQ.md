# Frequently asked questions

## Why does a local bundle inspect without a token?

Local inspection reads an existing artifact and performs local validation.
It does not authenticate a relay session.
Tokens are required only when the selected operation needs an authenticated request.
A remote receipt selector may need such a request when the receipt is not cached.
Use a local bundle path for predictable disconnected inspection.

## Why did changing a workspace file not change workers?

A profile, environment value, or command-line flag may have higher priority.
`--config` can also select a different file from the one you edited.
Use `config explain --key transfer.workers` to identify the selected source.
A file selected by a flag still contributes file-level values.
See [precedence](precedence.md) for the complete ordering.

## Why does inspect no longer look like the old transcript?

The CLI page retains a release-labeled terminal transcript for support history.
The current version is listed in [overview](overview.md).
Consult the format transition in [migration](migration.md) before copying old defaults.
Explicitly selecting a format is the most stable choice for a script.
Terminal detection only affects automatic coloring, not the current inspect format default.

## Does zero retries mean zero attempts?

No: the initial attempt is separate from additional retries.
Zero retries means the initial attempt can run once.
An invalid local input can still fail before any network attempt is made.
The attempt and retry ordinal fields are described in [retries](retries.md).
Do not infer retry budget from the maximum allowed configuration range.

## Why is elapsed time longer than the sum of backoff sleeps?

Each attempt may take connection and request time.
The operation may also wait for a free worker slot.
Plugin hooks and local cache writes contribute additional wall-clock time.
Backoff arithmetic counts scheduled sleeps only unless stated otherwise.
A relay delay hint can raise a sleep above the local deterministic rule.

## Does disabling jitter disable backoff?

Disabling jitter uses exact deterministic delays.
It does not change retry count, multiplier, cap, or eligible errors.
Jitter only changes the locally selected wait within the documented interval.
Server hints are processed after the local jitter decision.
Use explicit assumptions when estimating a full retry sequence.

## Can I raise the manifest ceiling by disabling entries?

The count includes disabled entries and entries from included manifests.
Filtering occurs only after structural validation.
Split an oversized workspace into independent manifests instead.
Each workspace needs its own identifier and cache lease namespace.
See [limits](limits.md) for exact ceilings.

## Is a successful health probe proof that my lease is usable?

A probe checks network reachability and relay health.
Lease reuse also checks local workspace identity, signature, and age.
A copied or misplaced lease can fail even when credentials work.
The full symbolic error catalog lives on [authentication errors](authentication-errors.md).
The page title reflects its history rather than the scope of every listed failure.

## Why does cache size exceed cache.maxBytes?

The field is an eviction target applied after writes.
Active operations pin blobs until they finish.
Scratch files and metadata are accounted separately from stored blob payloads.
Pruning cannot remove a blob still required by an active operation.
See [caching](caching.md) for eviction order.

## Was every warning in 2.5.0 a removal?

A deprecation warning announces discouraged but accepted configuration.
A removed key fails ordinary validation immediately.
Strict validation can promote warnings to failures without making them removals.
Use the release-specific removal table in [migration](migration.md).
Do not combine removals from adjacent release transitions.

## Why did an upgrade preserve the previous TTL?

A numeric value written into a file is an explicit setting.
Upgrades change built-in defaults without rewriting user files.
Remove the explicit value only if the new built-in policy is wanted.
Check other sources before assuming removal exposes the default.
The release history is recorded in [CHANGELOG](CHANGELOG.md).

## Can a plugin alter the retry schedule?

Hooks cannot mutate the host's resolved configuration.
A hook may fail before transfer begins, which prevents any network schedule.
The network scheduler never retries a failed plugin hook.
Transform caches include plugin identity and settings, not its stderr text.
See [plugins](plugins.md) for hook ordering and response validation.
