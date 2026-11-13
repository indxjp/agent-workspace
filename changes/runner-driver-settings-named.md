---
changelog: platform
section: Changed
---

- The runner manager names the variable when a driver setting is missing or blank:
  `GCP_PROJECT`, `GCP_REGION` and `RUNTIME_SERVICE_ACCOUNT` on `cloud-run-service`,
  `ACA_SESSION_POOL_ENDPOINT` and its API version on `aca-sessions`, and `RUNTIME_NETWORK` and
  `AGENT_WORKSPACE_TOOL_NETWORK` on `docker`. Before, start-up stopped on the same values with the
  runtime's own option name, such as "project must be a non-empty string". The database, master key
  and tracing settings web and the model gateway share are now in `docs/operations/settings.md`.
