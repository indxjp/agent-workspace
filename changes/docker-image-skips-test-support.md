---
changelog: platform
section: Fixed
---

- The release images build again: `*.test-support.ts` files, which import test helpers from the
  repository's `tests/` folder, are left out of the Docker build context like `*.test.ts` files,
  so the web build in the image no longer fails with `TS2307`.
