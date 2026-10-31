---
changelog: cli
section: Added
---

- `aw deploy` writes the project file's `features:` list into the deployment's `.env` as `AW_DEPLOYMENT_FEATURES=<ids>` (ADR-0160 D5), and removes the line when the file has none. The Compose template forwards it to web; the Helm chart takes it as `deploymentFeatures` and the gcp-cloudrun module as `deployment_features`, each rendering nothing when empty. A project without `features:` deploys byte-identically to before. The generated-project E2E that checks `404 feature_disabled` runs only in CI's `generated-project-e2e` job, which needs Docker.
