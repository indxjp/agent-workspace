---
changelog: aw
section: Added
---

- `aw agent-teams list|get|create|remove` and `aw agent-teams versions create|list` (ADR-0104,
  #1516), each with `--json`. A team is named by its name or id; `--lead` and `--member` take
  `[<member name>=]<agent>[@<version>]`, pinning the version `local` points at when none is given.
  `versions create` keeps the team's current lead unless `--lead` names another.
