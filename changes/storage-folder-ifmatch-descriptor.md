---
changelog: platform
section: Fixed
---

- A `file://` storage connection checks a write's `ifMatch` against the file in the folder the write opened, not whatever the key resolves to from the root when the check runs, so a folder renamed inside the root during a write can no longer pass another file's etag (#1835).
