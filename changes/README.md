# Changelog fragments

Pull requests do not edit any `CHANGELOG.md`. A change worth a changelog entry adds one file here
instead, named for the change (`changes/<slug>.md`, for example `changes/runs-outputs.md`):

```md
---
changelog: sdk
section: Added
---

- `runs.outputs(runId)` lists the files a completed run wrote to its `outputs/` directory.
```

- `changelog` is `platform` for the root `CHANGELOG.md`, or the directory name of a package under
  `packages/` that has a `CHANGELOG.md` (`sdk`, `cli`, `contracts`, ...).
- `section` is one of `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- The body is one or more markdown list items, written as they will read in the changelog. No
  headings.
- A change that belongs in two changelogs, or in two sections, is two fragments.

`pnpm changes:check` validates every fragment. In CI, the fast-checks job's
`Changelog fragment gate` validates them and fails a pull request whose diff edits a
`CHANGELOG.md`, unless its branch is `release/*`. A branch that forked before the gate existed
only gets a warning until it merges `main`.

The release pull request (branch `release/<version>`) runs `pnpm changes:collect`, which appends
every fragment, in file-name order, to its section under `## Unreleased` in its changelog and
deletes the fragment; then the release renames `## Unreleased` to the version heading
([docs/release/README.md](../docs/release/README.md#cut-a-package-release)).
