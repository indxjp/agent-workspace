---
changelog: platform
section: Removed
---

- The server no longer reads skills in their old forms: a skill's files are read and written only as its catalog rows, and its record, pending delete and built-in digest only from its catalog row. Skills kept as bare objects (`skills/<name>/…`, `skill-revisions/<name>/<n>/…`), and the `skill-meta/`, `skill-deletes/` and `skill-builtin/` objects of earlier releases, are no longer read, moved or deleted. The upgrade guard every install has passed (0.6.13 and later) proves no skill needs them; an object of theirs left in the bucket stays there untouched.
- The skills adopt pass that ran at start-up, and with it `AW_STORAGE_MIGRATE`, which no longer has any effect.
