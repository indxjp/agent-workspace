---
changelog: sdk
section: Fixed
---

- `toPortableAgent()` and `portableFromAgentVersionBody()` no longer drop the signed identity assertion (`identity`) of an OpenAPI tool or an `mcp()` connector silently: the converter lists it in `dropped` at `<tool path>.identity`, naming the signing secret, because the portable tool has no field to carry it (ADR-0133 D5).
