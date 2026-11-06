---
changelog: aw
section: Added
---

- `aw blueprint add <npm-spec> [--yes]`, `aw blueprint list`, `aw blueprint diff <name> [--to <v>]`
  and `aw blueprint update <name> [--to <v>] [--yes]` (ADR-0166, issue #1533) install an app
  blueprint, a versioned npm release of app parts, and receive each new version as a proposal. The
  package is fetched with `npm pack --ignore-scripts`, so its install scripts never run, with an
  allowlisted environment, and its tarball is checked against npm's sha512 integrity before an
  entry is read. The SDK's `readBlueprintArchive` then refuses links, unsafe paths and unlisted
  files. `add` shows every file, edit and slot and exits 3 until `--yes`. `update` proposes `add`,
  `update`, `remove` or `conflict` per file and exits 3 without `--yes`. With `--yes` it never
  touches a file you edited: it writes the new version beside it as `<file>.blueprint-<version>`.
  A version with a destructive migration is refused by name. `diff` prints line diffs and exits 3
  when the blueprint is behind and 0 when it is not. `aw destroy blueprint <name>` removes an
  installed blueprint.
