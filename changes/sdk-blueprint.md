---
changelog: sdk
section: Added
---

- `@indx-workspace/sdk/project` exports the app blueprint API (ADR-0166): `BlueprintManifestSchema`
  and `parseBlueprintManifest` for a package's strict `blueprint.json`; the pure planners
  `planBlueprintInstall(release, app)` and `planBlueprintUpdate(installed, release, local)`, which
  classify each file as `add`, `update`, `remove`, `unchanged` or `conflict` and never plan a write
  over a file the developer edited (a conflict writes only `blueprintSidecarPath`); and
  `destructiveMigrations`, which refuses a non-expand-only migration by name. It reads comments
  with a quote-aware reader and also refuses `TRUNCATE`, `DELETE`, `DO` and `EXECUTE` in blueprint
  SQL. `readBlueprintArchive` reads a gunzipped npm tarball and refuses links, unsafe paths and
  unlisted files. `aw-generated.json` gains a `blueprint` entry kind: a `blueprint:<name>` entry
  must carry its `source` (package, exact version and sha512 integrity) and its `migrations` map.
