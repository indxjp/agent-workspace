---
changelog: app
section: Fixed
---

- `defineApp` accepts an empty `resources` list, as `aw generate app` and `--template portal`
  write it, so `aw dev` starts a new portal: the app's `/api/mcp` no longer answers 500
  `invalid_definition` and the ready screen is reached.
