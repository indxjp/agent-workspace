# ADR-0150 — The ADR index is generated on demand, not committed

Status: accepted
Date: 2026-10-18
Decided by: engineering audit W3-2 (finding F-17)
Scope: `docs/adr/README.md`; `scripts/docs/adr-index.mjs`; `scripts/check-adrs.mjs` (`pnpm adr:check`); every pull request that adds an ADR. Supersedes [ADR-0037](0037-the-adr-index-is-generated-not-owned-so-a-conflict-in-it-is-resolved-by-regenerating.md)

## Context

[ADR-0037](0037-the-adr-index-is-generated-not-owned-so-a-conflict-in-it-is-resolved-by-regenerating.md)
made every pull request that adds an ADR regenerate the index table in `docs/adr/README.md` and
commit it, and resolved conflicts in it by regenerating. That kept the index correct, and it made
every pair of ADR pull requests in flight conflict: each one changes the record count line and
appends a row at the same place (new numbered records sort to the end of the numbered block). The
audit counted 44 edits to the file in the last 400 first-parent commits, and the bot programmes saw
every ADR merge make the other open ADR pull requests DIRTY on the index alone. The shell generator
also took minutes on Windows, so each conflict-only refresh was slow.

## Decision

1. The index is **not committed**. `docs/adr/README.md` keeps the hand-written guidance and tells
   the reader to run `pnpm --silent adr:index`, which prints the count and the table from the directory.
2. The generator is `scripts/docs/adr-index.mjs` (Node, no subprocesses). Its rows are
   byte-identical to the retired `docs/adr/regenerate-index.sh` output for every record on the day
   it replaced it. That script is removed, and `pnpm adr:check` no longer runs its `--check`,
   because there is no committed table left to go stale.
3. `pnpm adr:check` (CI fast checks) instead runs the generator's parser over every record and fails
   on a record it cannot read a title or a date from. `tests/docs/adr-index.test.ts` keeps the
   generator correct: the three header shapes parse, one row per record, and `docs/adr/README.md`
   carries no index table, so it cannot creep back.
4. Adding an ADR touches only the new record; no PR declares `docs/adr/README.md` for the index.

## Alternatives considered

- **Keep committing it, `merge=union` in `.gitattributes`.** A union of two sides keeps both count
  lines and can leave rows out of order; the result is silently wrong. GitHub's merge also ignores
  custom drivers.
- **Regenerate on push to `main` from a workflow.** `main` is pull-request-only; no workflow may push
  to it.
- **Shard the index into one file per record and assemble it.** The records already are the shards;
  a second file per ADR adds a step and assembles the same table.
- **Generate it into the OSS export.** The export is the tracked tree, byte-identical; adding a
  generated file breaks that contract, and the public repository has the same `pnpm --silent adr:index`.

## Consequences

- Browsing the index on GitHub now means reading the directory listing (filenames are the titles)
  or running one command; the table with status and scope is no longer a rendered page.
- An open branch created before this change that still has the shell script's index block resolves
  a conflict in `docs/adr/README.md` by taking `main`'s side.
- `tsconfig.architecture.json` is not treated the same way: it is hand-maintained (not generated),
  `pnpm package-exports:check` already checks it against the package exports, and several entries
  map a specifier to a source that cannot be derived from `exports` (declaration files, a vendored
  dependency). Its keys are grouped by package, so parallel pull requests on different packages do
  not touch the same lines.
- Reversal: restore the block and the shell script from git history in one pull request.
