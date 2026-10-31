---
changelog: sdk
section: Security
---

- A new project from `npm create` overrides `minimatch` 10.x to 11.0.3 (GHSA-g3hv-75wg-m249), as
  the repository root does, so the `pi` engine's dependency tree no longer installs a vulnerable
  `minimatch`.
