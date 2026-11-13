---
changelog: platform
section: Fixed
---

- A code-tool sandbox on Cloud Run now opens: the runner manager points the tool host at
  `/tmp/tool-host` (Cloud Run mounts no `/workspace`, which the tool-host image's user cannot
  create), and the tool host creates its directory before it takes a file. Before, every
  `PUT /files/manifest.json` failed with HTTP 500 and the manager answered
  `503 tool_sandbox_unavailable`. The manager now also logs the reason of such a 503.
