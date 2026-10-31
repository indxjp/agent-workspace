---
changelog: platform
section: Fixed
---

- A `file://` storage connection's conditional writes hold across processes: a write's precondition and its rename, and a delete, take a lock file in the folder, so two replicas writing the same file over a shared mount can no longer both pass `ifMatch` and lose one of the writes. A lock left by a process that died is broken after 10 seconds (#1835).
