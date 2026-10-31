---
changelog: aw
section: Added
---

- `aw dev` sends the project file's `features:` list to the local runtime, which installs only those features (ADR-0160 D5). A project without `features:` starts exactly as before. Changing `features:` while `aw dev` runs prints `agent-workspace.yaml: features changed; restart aw dev to apply`.
