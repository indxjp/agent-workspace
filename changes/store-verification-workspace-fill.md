---
changelog: platform
section: Added
---

- `PUT /api/demo/verification/{workspaceId}` (Agent Store operator route, `AW_DEMO_OPERATOR_TOKEN` bearer) copies
  every seeded demo template into an ordinary workspace exactly as a visitor's demo copy is made, so the real-model
  verification (R1) and the daily production test run what a visitor gets. A visitor's demo workspace, a template or
  a workspace with no Owner is refused.
