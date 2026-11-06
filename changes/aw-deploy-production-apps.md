---
changelog: aw
section: Added
---

- `aw deploy production` refuses a project whose `aw-generated.json` names an app that
  `environments.production.apps` does not list, and says which `apps:` entry to add. A project
  with no `aw-generated.json` has no apps.
