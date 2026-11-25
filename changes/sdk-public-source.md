---
changelog: sdk
section: Added
---

- `@indx-workspace/sdk/define` gains the public-source connector (ADR-0170): `definePublicSource()`
  configures a dated snapshot or live sources (JSON Feed, RSS, Atom, JSON records or CSV with a
  field mapping, with or without a header row, up to 12 MiB each), `publicSourceTool()` declares a
  read-only code tool whose network is exactly the sources' hosts (none in snapshot mode),
  `publicSourceRun()` is its run file's default export, and `publicSourceRecords()` files a
  snapshot as the demo seed's record set. Answers are typed (`PublicSourceAnswerSchema`, with
  `asOf` and `truncated`); every item of a source is searched, and fetched content is validated,
  size-limited, decoded in its declared charset and refused by a stable `PublicSourceError` code.
