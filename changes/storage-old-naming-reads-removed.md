---
changelog: platform
section: Removed
---

- The server no longer reads the old object naming: the catalog service opens, signs, renames and deletes a file or a session-state blob only by its object id, the old per-area session-state blob store is gone, and the storage cleanup lists only the new naming. Its report and `GET /api/cron/storage-cleanup` no longer carry `legacyOrphans`. The upgrade guard of this release proves no row needs the old naming; an old object left in the bucket is never read or removed.
