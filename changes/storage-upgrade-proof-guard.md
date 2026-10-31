---
changelog: platform
section: Changed
---

- **Breaking:** `db:migrate` refuses with `legacy_storage_rows_remain` unless the latest `adopt` and `skills` rows of `storage_migration_runs` were written by the release after 0.6.11 (`proof_version` 2), are clean and have `legacy_rows` 0, so that release is a required upgrade stop (0.6.10 or 0.6.11 → the release after 0.6.11 → this one). A fresh install upgrades with no step. The self-hosting guide lists the three starts that release needs, and one remedy for each cause that keeps `legacy_rows` above 0: `skipped_ownerless` (give the workspace an owner or remove its old objects), `skipped_path_taken` (another file holds the path: download or remove the old object), `skipped_failed` (start again and read the warn lines) and a skill whose delete is pending (its owner retries `DELETE /api/skills/<name>`). Nothing is deleted or rewritten while it refuses. After the check, a file row and a session-state blob row must name an object id (`files_file_has_object_id`, `session_state_blobs.object_id NOT NULL`).
