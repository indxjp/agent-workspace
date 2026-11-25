---
changelog: contracts
section: Added
---

- `DEMO_FALLBACK_REASONS` gains `format`, and `demoFallbackReason('output_schema_unsatisfied')`
  returns it: a demo run whose answer did not satisfy its `outputSchema` (ADR-0143) is shown to the
  visitor as that answer's fallback, in the visitor's words.
