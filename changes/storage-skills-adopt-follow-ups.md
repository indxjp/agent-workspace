---
changelog: platform
section: Changed
---

- A start-up skips the skills adopt walk when the latest `skills` row of `storage_migration_runs` is clean, has `proof_version` 2, `legacy_rows` 0 and `mismatches` 0, and logs `skills adopt skipped: the latest pass left no old skill forms`; a pass that left anything, or failed a workspace, still runs on the next start-up. A pass that does run reads each skill's pending delete by name instead of listing every skill, and counts a workspace that failed twice as one failed workspace. Migration 0094 adds a partial index of the pending `files` rows, so counting a workspace's pending uploads no longer reads its ready rows; it is a plain `CREATE INDEX`, so it holds writes to `files` while it scans the table once.
