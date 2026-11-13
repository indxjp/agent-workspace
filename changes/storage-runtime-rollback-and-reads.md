---
changelog: platform
section: Fixed
---

- A Cloud Run service or Azure Container Apps session that fails to start is now reported with
  its failed clean-up, so a billed leftover is no longer silent; a run's tool sandbox that cannot
  be released is logged (#2283).
- Google Cloud Storage reads keep a gzip-encoded object's stored bytes, so delivering one no
  longer fails with "changed size"; Azure Blob Storage no longer reads a missing container as a
  missing file; a SeaweedFS listing continues past a key that contains a colon (#2283).
- The recipe routes log an Agent Workspace failure behind a 502, and recipes check
  `AW_APP_API_KEY` the way agent tools do (#2283).
