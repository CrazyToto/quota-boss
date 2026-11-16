# Bundle caching and leases

The cache stores immutable blobs, signed receipts, and reusable leases.
These are separate record kinds with separate validity checks.
A valid blob digest does not imply that a lease is usable.
An expired lease does not imply that its associated blob is corrupted.

## Layout

```text
<cache-root>/
  layout-version
  blobs/<digest-prefix>/<digest>
  receipts/<workspace-fingerprint>/<receipt-id>.json
  leases/<workspace-fingerprint>/<endpoint-hash>.json
  locks/writer.lock
  scratch/<operation-id>/
```

Layout version 3 has been used since release 2.4.0.
The executable release and layout version are independent numbers.
`layout-version` contains one integer followed by a newline.
Unrecognized future layouts are refused rather than rewritten.
Scratch directories are cleaned after successful operations and normal interruption.
Interrupted operating-system shutdown can leave scratch data for `cache prune`.

## Retained lease-policy reference: release 2.3.0

This section preserves the baseline policy shipped with 2.3.0.
Later release changes are recorded in [CHANGELOG](CHANGELOG.md).
Use the running release's cumulative changes when no explicit value is set.

| Setting | 2.3.0 default | Meaning |
| --- | --- | --- |
| `cache.enabled` | `true` | Permit persistent reuse |
| `cache.ttlSeconds` | `900` | Maximum reusable lease age, in seconds |
| `cache.maxBytes` | `536870912` | Eviction target for stored blob bytes |
| `cache.verifyOnRead` | `true` | Verify blob digest on every reuse |

The lease age is measured from successful local receipt storage.
It is not measured from the file's filesystem modification time.
An explicit TTL of zero bypasses lease reuse while leaving blob caching enabled.
The lease's signed server expiry can invalidate it before the local TTL elapses.
Increasing the local TTL never extends the signed server expiry.
The baseline numbers above must not be mistaken for all later release defaults.

## Lease validation order

1. Read the record without following file symlinks.
2. Check JSON shape and record layout version.
3. Compare the stored workspace fingerprint with the active workspace.
4. Verify the signature and endpoint binding.
5. Compare age against the selected local TTL and signed server expiry.
6. Return the receipt reference if every check succeeds.

Scope mismatch is a local identity failure, even if the relay is healthy.
The symbolic diagnostic for that symptom is listed in [authentication errors](authentication-errors.md).
A probe never substitutes for local lease validation.
The host does not silently relabel a mismatched lease with a new fingerprint.

## Ordinary miss versus strict mode

An absent reusable lease is an ordinary cache miss for an online push.
The host may contact the relay and store a new lease afterward.
Expired leases are skipped by ordinary online lookup.
Strict cache-only inspection reports expiry as an error instead of refreshing.
Offline lookup cannot fetch an absent receipt.
Corrupt records and identity mismatches remain errors rather than ordinary misses.
This makes accidental workspace aliasing visible to the operator.

## Blob identity

Blob keys are SHA-256 digests of stored content bytes.
The key does not include the input file's modification time.
Transform outputs use the digest of the transformed bytes.
Plugin version and settings determine transform reuse eligibility separately.
Identical content can share a blob across workspaces within one user's cache.
Workspace-scoped leases cannot be shared the same way.

## Eviction

`cache.maxBytes` is a target applied after a write completes.
The host evicts least-recently-read unpinned blobs first.
The sum counts blob payload bytes, not directories or JSON metadata.
Active operations pin the blobs they need until completion.
If every remaining blob is pinned, cache size may temporarily exceed the target.
The next completed write or explicit prune tries again.
Removing a blob also removes unpinned receipts that cannot be inspected without it.

## Cache commands

`cache list` reports record kind, workspace, age, and stored byte count.
`cache verify --all` checks blob digests and lease metadata without relay access.
`cache prune --expired` removes expired and scope-ineligible lease records.
`cache prune` also enforces the byte target on unpinned blobs.
Neither command revokes a receipt stored on a relay.
A named local bundle outside the cache is never deleted by pruning.
See [limits](limits.md) for maximum local bundle and metadata sizes.
