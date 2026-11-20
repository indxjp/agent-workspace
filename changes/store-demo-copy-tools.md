---
changelog: platform
section: Fixed
---

- An Agent Store demo copy now offers its agent the connector tools its first suggested prompt needs. The template
  seed declares each `openapiTool`'s admitted operations from its own document, and the gallery `mcp()` connectors'
  read tools answer from the entries' fixtures (past defect reports, the authority matrix, the assignable members).
  Before, those connectors only offered a `send` stand-in. An `openapiTool`'s writes (`createQuote`, `createCase`,
  `postComment`, `createTask`, `logResolution`) wait for a person's approval in the copy, as they do on the platform.
