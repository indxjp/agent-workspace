---
changelog: sdk
section: Changed
---

- `renderAppTemplate(template, { appName, version, projectFiles })` takes the project's own files
  in place of the `existing` path list, returns them first in `files` (its `package.json` with the
  app's packages and scripts added), and records them in `aw-generated.json` as the entry
  `project:<name>`, so every file `create --template` writes is recorded. `project` is a new
  `GENERATED_ENTRY_KINDS` kind.
- `@indx-workspace/sdk/project` exports `revertGeneratedEdit`, which undoes one recorded
  generator edit (a line, a replaced line, a `package.json` pin or script, a migration journal
  entry) as `aw destroy` does, with `readPackageManifest`, `serializePackageManifest`,
  `readMigrationJournal` and `serializeMigrationJournal`.
