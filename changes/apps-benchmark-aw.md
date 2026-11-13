---
changelog: aw
section: Changed
---

- `aw destroy project <name>` is refused by name: the `project:<name>` entry `create --template`
  records is the project's own files, so remove the directory instead. `aw destroy app` no longer
  waits for that entry.
