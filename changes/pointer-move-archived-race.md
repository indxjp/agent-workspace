---
changelog: platform
section: Fixed
---

- Setting, promoting or rolling back a pointer, and the Builder's `draft_save`, now answer 409 `agent_archived` when the agent is archived between the request's read and the pointer move; before, that move applied to an archived agent. The check now runs on the locked agent row.
