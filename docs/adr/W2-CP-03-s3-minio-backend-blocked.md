# W2-CP-03 — The S3/MinIO backend is a declared gap: its one dependency is outside this task's Owns

Status: accepted (declared gap, not a design choice)
Date: 2026-09-05
Decided by: W2-CP-03 (ObjectStore)
Scope: `packages/core/src/storage/**` (what is NOT here), `packages/core/package.json` (what this
task needed and did not touch)

## Context

The Wave 2 plan's first acceptance criterion: "One suite passes against both backends"
— local filesystem and S3/MinIO. R-15 §1a (research note R-15), written and pinned
before this task started specifically to unblock it, found that S3 and MinIO both need exactly
three npm packages behind spec §40's "do not reimplement … cryptography … use mature libraries":

| Package | Pinned version | Role |
| --- | --- | --- |
| `@aws-sdk/client-s3` | `3.1124.0` | the S3 API surface, including SigV4 request signing |
| `@aws-sdk/lib-storage` | `3.1124.0` | multipart upload for streams of unknown length |
| `@aws-sdk/s3-request-presigner` | `3.1124.0` | presigned URLs |

None is installed. Verified in this task's worktree:

```text
$ node -e "try { require.resolve('@aws-sdk/client-s3'); console.log('FOUND'); } catch (e) { console.log('NOT INSTALLED:', e.code); }"
NOT INSTALLED: MODULE_NOT_FOUND

$ grep -c "@aws-sdk/client-s3@" pnpm-lock.yaml
0
```

Installing it means adding three `dependencies` entries to `packages/core/package.json` and
regenerating `pnpm-lock.yaml`. Both files are outside this task's declared `Owns` globs
(`packages/core/src/storage/**`, `apps/web/server/files/**`, `apps/web/app/api/files/**`) —
`packages/core/package.json` is W2-DB-02's, per the Wave 2 plan's 2a row — and the wave
protocol states, as absolute prohibition #6, "never change a file outside your declared Owns globs
… no exceptions, no reasons," with the resolution spelled out in the same sentence: "say so in your
report and work around it; the orchestrator owns the integration level." Hand-writing AWS's SigV4
signing to avoid the dependency was considered and rejected: it is exactly the "reimplement
security-sensitive standards" spec §40 forbids, and R-15 §1c quotes AWS's own warning that a
hand-written `UriEncode` "might not work because of differences in implementation" — the smaller of
the two encoding functions this feature needs, and AWS itself does not trust a from-scratch version
of it.

### What was checked before concluding this, per this task's own instruction

The dispatch says explicitly: "Check whether compose.yaml already offers a MinIO service before
concluding MinIO cannot be started here." It does — `compose.yaml`'s `minio` service, pinned to
`minio/minio:RELEASE.2025-09-07T16-13-09Z`, the same tag R-15 probed against. It was started
directly (not through `docker compose up`, to avoid colliding with the already-running
`agent-workspace` compose project other sessions in this shared clone have up) and answered
healthy:

```text
$ docker run -d --rm --name w2cp03-minio-check -p 19000:9000 minio/minio:RELEASE.2025-09-07T16-13-09Z server /data
5f51c3ed2a7a5b4eb17302c059a0a5b4be4dee11a36e2d8bc2f45628608b5f9

$ curl -fsS http://127.0.0.1:19000/minio/health/live -w "\nHTTP_STATUS:%{http_code}\n"
HTTP_STATUS:200

$ docker logs w2cp03-minio-check
MinIO Object Storage Server
Version: RELEASE.2025-09-07T16-13-09Z (go1.24.6 linux/amd64)
API: http://172.17.0.3:9000  http://127.0.0.1:9000
```

So MinIO is reachable in this environment. The gap is entirely the client dependency, not the
server.

## Decision

Ship the local-filesystem backend, complete and fully tested against the shared contract suite
(`contract.ts` via `local-fs-store.test.ts`). Do not write an S3/MinIO backend file at all — not
even a stub that imports `@aws-sdk/client-s3` — because `packages/core/tsconfig.json` has no
`exclude` and would type-check it as part of every `pnpm typecheck`/`pnpm build`, turning this
task's own CI red over an import that cannot resolve. A stub that merely throws
`"not implemented"` was also rejected: spec §12 ("Never Pretend Providers Are Fully Equivalent")
argues against exactly this shape one layer up (model providers), and the same reasoning applies
here — an `ObjectStoreProvider` export that exists but cannot do the one thing an `ObjectStore` is
for is a capability nobody should be able to mistake for supported.

`contract.ts`'s own header states the remediation as a one-line addition:
`defineObjectStoreContract('S3 (MinIO)', s3Setup)`, once a backend exists to hand it a `setup()`.

## Consequences (the declared gap, stated plainly)

* **This task's first acceptance criterion is only half-met by this PR.** The local-filesystem half
  passes, in full, with the shared suite. The S3/MinIO half does not run, and is not reported as
  passing, skipped, or green by any other name.
* **Unblocking it needs exactly one integration-level change**: add the three `@aws-sdk/*`
  dependencies above, at the pinned versions, to `packages/core/package.json`, and run
  `pnpm install` to update `pnpm-lock.yaml`. Nothing else in this task's code needs to change for
  that to be sufficient — `key-safety.ts`, `object-store.ts` and `contract.ts` are all already
  backend-agnostic.
* Once that dependency exists, the second half of `docs/adr/W2-CP-03-object-key-safety.md`'s
  guarantee — the same three attack strings refused on both backends — still needs to be written as
  an S3 backend that calls `toObjectKey`/`toObjectPrefix` before building any AWS SDK command, the
  same way `local-fs-store.ts` does.
* `apps/web/server/files/**` in this PR is written against the local-filesystem backend only
  (`object-store-bridge.ts`), which matches spec §16's own "Development: Local filesystem" —
  production S3 selection is future work layered on the same `ObjectStoreProvider` interface, not a
  second interface.

## Verification round 2: the suite's agnosticism is now witnessed, and the gap still stands

Round 1's finding on this ADR was not that the gap was undeclared — it was declared — but that "the
shared contract suite has exactly one call site, and it is the local filesystem". A suite with one
implementation behind it cannot tell *backend-agnostic* apart from *written against the only backend
there is*, so the claim "adding S3 is a one-line addition, not a rewrite" was untested.

It is now witnessed by a second, independent implementation. `packages/core/src/storage/memory-store.ts`
is an in-memory `ObjectStore` sharing no code with `local-fs-store.ts` — a `Map`, no `node:fs`, no
sidecar file, no directory entries — and `memory-store.test.ts` runs the whole of `contract.ts`
against it by supplying a `setup()` and nothing else. `contract.ts`'s header carries the one
documented entry point, with the exact file an S3 backend has to add.

**This changes nothing about the gap.** An in-memory backend is not S3/MinIO and is not offered as a
substitute for it: it exercises no network, no SigV4, no `ListObjectsV2` delimiter semantics and no
real bucket. W2-plan.md's first acceptance criterion remains **not met** by this PR, for exactly the
reason above — the client dependency cannot be added from inside this task's `Owns` globs. What the
second backend does discharge is the narrower claim this ADR itself makes in its Consequences, that
`contract.ts` is already backend-agnostic and needs no edit to admit a third implementation.
