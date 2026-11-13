---
changelog: platform
section: Added
---

- A project file may name the Google Cloud project and region a `gcp-cloudrun` production deploys
  to: `environments.production.gcp: { project, region }`. `gcp` is accepted only with
  `target: gcp-cloudrun`, and a new project file carries a commented example of it.
