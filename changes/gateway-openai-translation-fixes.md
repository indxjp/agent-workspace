---
changelog: platform
section: Fixed
---

- OpenAI and Azure OpenAI model connections: tool-using turns no longer fail on strict-schema
  validation, cached input tokens are no longer charged twice, and a failed or truncated stream
  records the tokens it spent (or stays unmeasured) instead of settling as $0 (#2283).
- Azure OpenAI connections with a dated `apiVersion` now count tokens through
  `/responses/input_tokens` instead of making a billed Responses call, and a provider without
  token counting answers a typed 501 rather than a 500 (#2283).
