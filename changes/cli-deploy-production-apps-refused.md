---
changelog: cli
section: Added
---

- The `gcp-cloudrun` and `vercel` deploy targets refuse a non-empty `environments.production.apps`
  at that path: only `single-vm` and `kubernetes` deploy portal apps.
