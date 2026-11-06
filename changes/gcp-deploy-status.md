---
changelog: platform
section: Added
---

- `aw deploy status production` reports a Google Cloud deployment without changing it: the CLI
  version and the image of each service, whether each Cloud Run service's latest revision is
  ready, whether data protection is on, off or partial, and whether the stack has drifted from the
  project file (a plan that does not lock the state and is never applied). It exits 0 when every
  service is ready and the plan is empty, 3 when the plan has changes, and 1 when a service is
  not ready or nothing was deployed from this machine.
