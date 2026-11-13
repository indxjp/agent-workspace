---
changelog: platform
section: Removed
---

- The `adopt`, `copy`, `copy-dry-run` and `finalize` stages of the move off the old object naming. They ran on the release after 0.6.11, which this release requires as an upgrade stop. `AW_STORAGE_MIGRATE=off` still turns off the skills adopt pass; any other value runs it.
