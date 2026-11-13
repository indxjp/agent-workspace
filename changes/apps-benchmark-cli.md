---
changelog: cli
section: Changed
---

- `npm create @indx-workspace <dir> -- --template portal` records every file it writes in
  `aw-generated.json`: the project's own (`package.json`, `agent-workspace.yaml`, the starter
  agent and the rest) as `project:<name>`, beside the app's `app:<name>`. Without `--template`
  the output is unchanged.
