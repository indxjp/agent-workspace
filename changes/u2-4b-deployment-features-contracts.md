---
changelog: contracts
section: Added
---

- `LocalRuntimeEnvironmentSchema` takes an optional `features` (`FeatureListSchema`), which `aw dev` sends only when the project file has a `features:` list (ADR-0160 D5); a runtime older than this key refuses it as an unknown key. `RESERVED_SECRET_NAMES` lists `AW_DEPLOYMENT_FEATURES`, which the `AW_` prefix already reserved.
