---
changelog: sdk
section: Added
---

- `@indx-workspace/sdk/project`: `renderPageSpec(name, { kind, resource })` gives the values of the
  `page/dashboard`, `page/list` and `page/custom` templates (`GENERATOR_PAGE_KINDS`), refusing an
  unknown kind, a list page without its resource and a reserved name; `renderResourceSpec`'s values
  also render the new `resource-pages` template. `aw-generated.json` entries may now be `page:<name>`.
