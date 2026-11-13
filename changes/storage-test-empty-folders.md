---
changelog: contracts
section: Added
---

- `StorageConnectionTestOutcomeSchema`: a successful test may carry `emptyFolders`, the allowed
  folders it found nothing in. A missing folder and an empty one look the same in an object store,
  so neither fails the test.
