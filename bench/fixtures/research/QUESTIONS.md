# Documentation research

Use only the vendored pages in `docs/`.
The target release is the current version identified in `docs/overview.md`.
Historical examples describe their named release, not necessarily that target.
Write one `answers.json` object with keys `q1` through `q8`.
Each value must have an `answer` and a `source` naming an existing `docs/*.md` file.
For an answer derived from several pages, cite the page giving the deciding rule.
Do not include units, explanations, or citations inside an `answer` value.

## q1
What is the hard maximum number of entries in one manifest, including disabled entries?
Answer form: integer, expressed as a count of entries.

## q2
What is the default value of `log.timestamp`?
Answer form: string, exactly the documented configuration value.

## q3
For the target release, what is the default `cache.ttlSeconds` for a newly created configuration with no overrides?
Answer form: integer, expressed in seconds.

## q4
For the target release, which `output.format` value is used by `qelvorn inspect` when no flag, environment variable, profile, or file sets it, even on a terminal?
Answer form: string, exactly the documented format name.

## q5
A valid configuration sets `transfer.workers = 11`; the process environment sets `QELVORN_WORKERS=7`; the invocation is `qelvorn push --workers 3`. No other source sets workers. What effective worker count is used?
Answer form: integer, expressed as a count of workers.

## q6
Use the target release's default `retry.maxRetries` and the deterministic exponential backoff rule. Every attempt fails with a retryable error, jitter is disabled, there is no server delay hint, and no deadline interrupts the operation. How many milliseconds are spent sleeping before the final attempt starts? Exclude execution time of attempts and all queue waits.
Answer form: integer, expressed in milliseconds.

## q7
An endpoint health probe succeeds and credentials are accepted, but opening a local cached lease fails because its workspace fingerprint differs from the active workspace. Which symbolic error code does the tool emit?
Answer form: string, the full symbolic code, not the numeric process exit status.

## q8
Which configuration option keys were removed specifically in version 2.5.0? Exclude keys merely deprecated, renamed in another release, or removed in another release.
Answer form: sorted list of strings, each a complete dotted configuration key, sorted in ascending lexical order.
