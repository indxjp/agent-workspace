---
changelog: contracts
section: Added
---

- `environments.production.apps` in the project file: an optional map, keyed by app name, of the
  portal apps production runs beside the platform. Each value is `{ image, url }`: a
  digest-pinned image (`<repository>@sha256:<64 hex>`) and the app's own `https:` origin.
  `ProductionAppSchema` and `ProductionApp` describe one app.
- `appSchemaName(name)`: the PostgreSQL schema, and production database role, of an app
  (`service-desk` → `app_service_desk`). It equals the app kit's `appSchemaName`.
