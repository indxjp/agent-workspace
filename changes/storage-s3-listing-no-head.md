---
changelog: platform
section: Changed
---

- An S3 listing page no longer sends a HEAD per file to learn its content type: `contentType` is `null` unless the caller passes the new `ListPageOptions.contentTypes`, and then the HEADs go eight at a time. A run's delivery, a storage-connection browse and every catalog-backed listing send none (#1746).
