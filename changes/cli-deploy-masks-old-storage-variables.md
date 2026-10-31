---
changelog: cli
section: Changed
---

- `agent-workspace deploy` masks the value of an old storage variable left in `.env` (`AW_FILE_STORAGE_ROOT`, `AW_SKILL_STORAGE_ROOT`, `AW_SESSION_TRANSCRIPT_ROOT`, `OBJECT_STORAGE_BACKEND`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_FORCE_PATH_STYLE`) like any other key it does not generate: nothing reads or writes them since the release after 0.6.10, so they are no longer public configuration. Remove them from `.env`; `AW_STORAGE_URL` alone says where data is kept.
