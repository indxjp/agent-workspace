---
changelog: platform
section: Added
---

- The tool host container can take its manifest and tokens over HTTP (`PUT /files/manifest.json`,
  `PUT /files/tokens.json`, guarded by the `x-aw-tool-intake` header) when `AW_TOOL_INTAKE_KEY`
  is set, so a tool sandbox runs on Cloud Run, which has no exec or file API. Without the variable
  nothing changes.
