# ADR-0153 — Object storage: one key layout, catalog-first writes, references not bytes

Status: accepted
Date: 2026-10-18
Decided by: the Owner, approving the file storage plan (tracker #1402) and its decisions D2 and D3
Scope: `packages/core/src/storage`, `apps/web/server/{files,skills,sessions,compose,composition}`, `packages/runtime/src/transfer.ts`, `apps/runner`, `AW_STORAGE_URL`; amends [ADR-0146](0146-attachments-are-file-store-references-on-the-grant-path.md) by reference only (carriage becomes streaming)

## Context

File storage works but has no single design. Three object roots and `OBJECT_STORAGE_*` configure one
concern. Every catalog writer sets `storage_key = path`, so a rename is copy plus delete. A catalog
row is written after the object under an in-process lock, which is safe on one replica and racy on
several. A presigned upload never gets a catalog row, so the object is missing from every list, grant
and search. Limits of 64 MiB and 128 MiB are each defined several times. Every granted file is base64
encoded into the `/run` body and decoded again to build the archive. The buffered `ObjectStore` port
has no streaming, range or `head`.

[ADR-0146](0146-attachments-are-file-store-references-on-the-grant-path.md) already chose references
on the grant path, carried through `POST /files`. The engineering audit (tracker #1356) fixes the
package layering: `core` holds db, storage and secrets only, and is not split.

## Decision

### 1. Three layers inside today's packages; no `packages/storage`

- **Blob port**, `packages/core/src/storage`: `ObjectStore` v2 with `head`, ranged streaming `read`,
  streaming conditional `write` (`ifNoneMatch` / `ifMatch`), cursor `list`, `copy`, `delete`, and
  capability-gated `createSignedUrl`. The buffered `get`/`put`/`listPrefix`/`copyObject` are deleted
  once every caller has moved; no overload pairs survive. `ObjectKey` is a branded type minted only by
  `key-safety.ts`. Each cloud SDK sits behind one lazily loaded boundary file per backend subpath.
- **Storage domains**, `apps/web/server/{files,skills,sessions}`: `port.ts` (catalog port),
  `service.ts`, `store.ts` (PostgreSQL adapter). Only `store.ts` and `composition/**` import
  `core/storage` or `core/db`; routes import the domain only.
- **Delivery**, `packages/runtime` and `apps/runner`: one streaming ustar codec and the archive path
  guard. `runtime` imports nothing in the workspace.

A new `packages/storage` is **rejected**: the audit says not to split `core`, and per-backend subpaths
with lazy imports give the same optional-SDK benefit.

### 2. One key layout, immutable object ids

```
<storage-url prefix>/workspaces/<workspaceId>/<namespace>/<objectId>
namespace in files | skills | session-state | artifacts | staging
```

`objectId` is a UUID v7 and never changes. The catalog maps `path -> objectId`, so a rename or folder
move is a row update. Paths stay the user-visible truth, so `.attachments/<sessionId>/...` and the
session concealment rule are unchanged. Session state uses `session-state/<objectId>` and loses the
doubled segment. Run outputs go to `artifacts/` with real content types; staging goes to `staging/`,
which no listing reads.

### 3. Catalog-first writes

1. Insert the row with `status = 'pending'`.
2. Write the object with `ifNoneMatch`.
3. Mark the row `ready` with size, content type and sha256.

Readers see only `ready`. A scheduled sweeper deletes `pending` rows older than the presign TTL plus
one hour together with their objects, and deletes objects that have no row. The in-process
`withKeyLock` leaves the correctness path. A presigned upload uses the same steps: minting the URL
inserts the `pending` row, and `POST /api/files/:id/upload-urls/complete` runs `head`, checks size and
content type, and marks the row `ready`. The SDK calls it, so callers never see it.

### 4. Key migration is online, dual-read and resumable (decision D2)

Existing rows keep `storage_key = path`; new rows store `files/<objectId>`. Readers resolve either
form. A resumable backfill (ST-22) moves old objects to the new layout, records progress in the
database, and is safe to stop and restart. There is no maintenance window, because self-hosted
operators cannot be assumed to have one. The dual-read path is a compatibility shim, removed by ST-50
once the backfill is complete.

### 5. One setting, `AW_STORAGE_URL`

The deployment profile's grammar: `s3://bucket/prefix?endpoint=...`, `gcs://`,
`azblob://account/container/prefix`, `file:///var/lib/aw/objects`. Credentials come from the
environment or workload identity, never the URL. For one minor release the old variables
(`AW_FILE_STORAGE_ROOT`, `AW_SKILL_STORAGE_ROOT`, `AW_SESSION_TRANSCRIPT_ROOT`, `OBJECT_STORAGE_*`)
are translated with a warning naming the replacement; ST-50 removes them.

### 6. References, not bytes (amends ADR-0146 carriage)

`RunFileResource` carries `{ path, access, size, sha256 }` and never bytes; the `/run` body shrinks to
metadata. Bytes travel through the hydrate ADR-0146 chose (`POST /files`), now with a streaming codec
over `ObjectStore.read`, so web memory is flat whatever the grant size. The archive cap becomes one
constant exported from `runtime/transfer.ts`. `RuntimeCapabilities` gains
`fileTransfer: 'push-archive' | 'local-disk'`; the `local` driver writes straight to the session
directory with `0o444` modes. ADR-0146's grant-path and reference decisions stand unchanged; only
carriage changes.

**`pull-signed` delivery is deferred.** A cloud sandbox fetching through signed GET URLs, with the
bucket host on the egress allowlist, is added only when a measured run exceeds the archive cap on a
cloud sandbox.

### 7. Azure presigned uploads (decision D3)

Azure cannot bind a length in a presigned upload. **Session tokens keep the 501.** Members receive an
unbound SAS; the completion step checks the object size against the bound and **deletes oversize
objects**, leaving the row non-`ready`.

### 8. Not built

No DI container or event bus; no upload-time processing (ADR-0147 rule 1); no FUSE or volume mounts;
no multipart orchestration of our own; no tiering or lifecycle engine. Bring-your-own-bucket
connections (decision D1) are a product feature on top of this refactor. The Owner decided D1 = yes on
2026-10-18: build them as wave S5 (ST-40 to ST-45), after S4.

## Alternatives considered

- **A new `packages/storage`.** Rejected: contradicts the audit and adds a package for one cohesion.
- **Keep path-as-key.** Rejected: renames stay O(objects) and the layout cannot be shared.
- **Object first, row second.** Rejected: a crash leaves objects no listing, grant or search can see.
- **Maintenance-window migration.** Rejected under D2.
- **Bind Azure length by refusing members.** Rejected under D3: the check-and-delete gives the same
  bound without removing a working path.

## Consequences

- ADR-0146 is not edited; this record amends its carriage by reference. Readers of 0146 follow this
  record for how bytes reach the sandbox.
- The field guide's open question 1 (thin whole-buffer port, no presign) is closed by Decision 1.
- Defect 5b (a presigned upload without a catalog row) is fixed by Decision 3.
- Implementation lands as units ST-01 to ST-50 of the storage plan; each keeps the layering above.
