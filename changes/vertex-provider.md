---
changelog: platform
section: Added
---

- Claude on Google Cloud (Vertex AI) is a keyless model provider (`vertex`, #2105). The gateway
  signs each request with its own Google Cloud identity (`roles/aiplatform.user`), so no model key
  is stored. It acts only on the project the deployment names (`GATEWAY_VERTEX_PROJECT_ID`, set by
  the Cloud Run module) and refuses a connection that names another. It offers `claude-opus-5-5`,
  `claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-fable-5-1` in the `global`, `us` or `eu`
  location, prices them in the default catalogue, and refuses the features Vertex AI lacks with
  `vertex_unsupported_feature`. A `vertex` connection takes `projectId` and `location` and no API
  key, and a project file cannot declare it.
- `aw deploy` on `gcp-cloudrun` connects Claude on Vertex AI as the default model on the first
  deploy, and `gcp.modelLocation` picks its location (`us` and `eu` cost 10 % more). The module
  enables the Vertex AI API and lets only the gateway call it. The preflight checks that Claude is
  enabled in Model Garden and links the page that enables it, as a warning that never stops the deploy; a refusal that is not about the model
  is a warning that names its cause. If seeding fails, finish setup in the browser.
- Web: Add provider offers Claude on Google Cloud (Vertex AI), which needs no API key. A connection
  is ready on its config alone, uses the install's project, and refuses any other. An install without a Google Cloud project refuses to create one. Testing it makes
  no network call, and first-run setup shows a sentence instead of the key field.
- Claude engine sandboxes set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY` and
  `DISABLE_ERROR_REPORTING`, so the engine sends no telemetry or error reports of its own.
