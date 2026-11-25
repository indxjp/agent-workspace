---
changelog: contracts
section: Deprecated
---

- `@indx-workspace/contracts/storage-settings`: the type `LegacyAreaPrefix` and the function `legacyAreaPrefixes(settings)`, which list where each area kept its objects in the old per-area naming. Nothing reads that naming since 0.6.12 moved every object off it, and neither the server nor `agent-workspace doctor` calls them. They still compile and return the same values; they are removed in the next major release.
