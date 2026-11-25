---
changelog: platform
section: Fixed
---

- `POST /api/agents/:id/platform-exports` and `.../platform-archives` read an assigned skill's files from its catalog rows, where every skill is kept. They read the old bare-object form before, so an exported skill could be reported as having no files.
