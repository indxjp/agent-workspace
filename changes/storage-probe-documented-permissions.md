---
changelog: platform
section: Fixed
---

- Connecting a Google Cloud Storage or S3 bucket no longer needs `storage.buckets.get` or an unprefixed `s3:ListBucket`: the readiness probe lists one object under the connection prefix, so the least-privilege grants in the storage connections guide are enough.
