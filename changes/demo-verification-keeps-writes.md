---
changelog: platform
section: Added
---

- The Agent Store's verification workspace now keeps an approved write to a demo records stand-in
  as a visitor's demo does: `PUT /api/demo/verification/{workspaceId}` marks the workspace it fills
  (`workspaces.demo_verification_at`, migration 0110, set on the first fill only), so the real-model
  verification and the daily production test see the change after approval. No other ordinary
  workspace keeps one (ADR-0169).
