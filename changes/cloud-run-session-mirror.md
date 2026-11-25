---
changelog: platform
section: Fixed
---

- Cloud Run sandboxes (`cloud-run-service`, the gcp-cloudrun module) now mirror each run's
  transcript and offer `search_files`: the runner manager hands every sandbox
  `AW_SESSION_MIRROR_URL` from the new `RUNTIME_SESSION_MIRROR_URL` setting, and the gateway's
  internal load balancer serves the control plane's four run routes, so a `none` sandbox reaches
  them without any new network destination (ADR-0172).
