---
changelog: cli
section: Removed
---

- `agent-workspace doctor` no longer has a `storage-layout` check. It counted the objects left in the old per-area storage naming, which only the release after 0.6.11 still moves; that release is a required upgrade stop, and the server no longer reads the old naming.
