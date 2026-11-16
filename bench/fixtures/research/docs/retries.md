# Retry scheduling and backoff

Retries apply to eligible relay transport operations.
They do not apply to local parse errors, plugin failures, or lease scope failures.
The configured retry count is defined in [configuration](configuration.md).
This page defines the delay rule rather than another independent retry budget.

## Attempts and ordinals

The initial attempt has ordinal 0 and starts without a backoff sleep.
Retry ordinal 1 is the first additional attempt after an eligible failure.
`retry.maxRetries` counts additional attempts, not total attempts.
If that count is N, there can be at most N sleeps and N + 1 attempts.
No sleep is scheduled after the final permitted attempt fails.
A success stops scheduling immediately and cancels unneeded future work.
A nonretryable failure stops the sequence even when budget remains.

## Deterministic exponential rule

For retry ordinal r, starting at 1, define the raw delay in milliseconds:

```text
delay(r) = min(1000, 125 * 2^(r - 1))
```

The base delay is 125 milliseconds.
The exponential multiplier is 2 per additional retry ordinal.
The deterministic delay cap is 1000 milliseconds.
These constants are fixed protocol policy in the current release.
They are not configuration keys and have no environment mappings.
With jitter disabled and no server hint, sleep exactly `delay(r)`.
Count only sleeps whose following retry actually starts.
Attempt execution time is separate from scheduled sleep time.
Queue waits for a worker are also separate from scheduled sleep time.

## Small nondefault example

For an explicitly configured retry count of 2, there are at most three attempts.
The first retry waits 125 milliseconds before starting.
The second retry waits 250 milliseconds before starting.
The total backoff sleep before the last attempt starts is 375 milliseconds.
There is no third sleep after that final attempt fails.
This example uses an override and does not state the default retry count.

## Jitter

When `retry.jitter` is true, draw an integer uniformly from 0 through the raw delay.
Both endpoints of that integer interval are eligible.
Use the chosen integer as the jittered delay.
The random generator is seeded once per operation from operating-system entropy.
Separate chunk operations do not intentionally share a random stream.
`--no-jitter` chooses the deterministic delay instead.
Disabling jitter does not disable the exponential multiplier or cap.

## Server delay hints

A relay may attach a nonnegative millisecond delay to a busy response.
The host accepts only whole integers up to 30000 milliseconds.
When hints are respected, the final wait is the greater of the local delay and hint.
Jitter, if enabled, is applied to the local delay before this comparison.
An invalid hint is ignored and logged at warning level.
Hints do not increase the retry count.
Hints do not turn authentication or receipt-signature errors into retryable errors.
Without a hint, only the local backoff rule contributes to sleep time.

## Deadlines and timeouts

The operation deadline covers all attempts, sleeps, and worker queue time.
If the deadline expires during a sleep, cancel that sleep and report `QV_EDEADLINE`.
A canceled partial sleep is visible in timing diagnostics.
It is not a completed backoff interval for deterministic schedule examples.
Each network attempt has its own request timeout.
A request timeout may be retried if the operation deadline still permits it.
Connection timeout and request timeout do not replace the operation deadline.
With `transfer.deadlineMs = 0`, no overall deadline interrupts the schedule.

## Upload and receipt commit

Each chunk upload has an independent retry budget.
A successfully uploaded chunk is not uploaded again because another chunk retries.
Receipt commit begins only after every required chunk upload succeeds.
Commit has a fresh retry budget using the same configured maximum.
The relay uses an operation identifier to make commit requests idempotent.
A lost commit response can therefore be retried without creating duplicate receipts.
A local receipt-write failure is a cache failure, not a network retry.

## Diagnostics

Debug records contain `attempt`, `retryOrdinal`, `sleepMs`, and `remainingRetries`.
For the initial attempt, `retryOrdinal` is 0 and `sleepMs` is 0.
The remaining count is decremented when a retry is scheduled.
A failure after budget exhaustion retains its original transport error code.
The final diagnostic also sets `exhausted = true`.
Do not add the final error's timestamp interval as an extra backoff sleep.
The symbolic code table is in [authentication errors](authentication-errors.md).
