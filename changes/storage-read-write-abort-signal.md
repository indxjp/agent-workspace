---
changelog: platform
section: Fixed
---

- `ObjectStore.read` and `write` take an abort `signal`, and every store passes it to its SDK where it takes one (S3 GetObject and the multipart upload, Azure download and upload, the GCS media stream and upload) and errors the body with it everywhere else. A storage write-back passes its save signal to the connection's open, each read and each write, so at the deadline or a cancel a hung provider call is stopped rather than left holding the session until the sweep (#1835, STO-509).
