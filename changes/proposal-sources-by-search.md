---
changelog: platform
section: Fixed
---

- The proposal drafter use case (`use-cases/proposal`) now always finds its sources with
  `search_files` (in parallel, one call per requirement area) before reading them, and never picks
  a source by listing the library, so every source its outline cites is one a search found (R1
  run 44891928173 found no `search_files` call).
