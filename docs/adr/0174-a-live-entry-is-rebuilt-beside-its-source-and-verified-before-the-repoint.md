# ADR-0174 — A live entry is rebuilt beside its source, and verified before the repoint

Status: accepted
Date: 2026-11-23
Decided by: the implementing agent of batch 1RA (the Agent Store 100-use-case plan, §9 W1R), design approved by the programme's orchestrator on the Owner's delegation
Scope: `examples/store/catalog/define.ts` (`next`, `catalogProblems`), `tests/store/seed/build.ts` (`stagedView`, `seededEntries`, the gallery fixtures), `tests/store/live-verify/run.ts`, `tests/store/catalog.test.ts`, `tests/store/sample-data.test-support.ts`

## Context

The Owner decided on 2026-11-21 to rebuild the ten gallery store entries under `use-cases/<slug>`
(batches 1RA and 1RB). The gallery projects stay as the tutorials. Each of these entries is live
throughout the rebuild, and a live entry must always have a passing real-model (R1) record for the
source hash it has now (`tests/store/catalog.test.ts`, the promotion check).

With the code as it was, the rebuild could not be verified before the repoint:

- The `use-cases/<slug>` folder could not merge while the entry still named `tests/gallery/<slug>`.
  The catalog test refuses a use-case folder whose entry has another source.
- The staging seed (`tests/store/seed/build.ts`) and R1 (`tests/store/live-verify/run.ts`) read
  only the entry's `source` and `demo`, and nothing overrides them. R1 could therefore verify the
  new folder only after `source` pointed at it.
- Repointing `source` changes the hash, so the entry failed the promotion check until a new R1
  record landed. `tests/store/awaiting-r1.json` cannot cover that gap: it may only shrink.

The repoint and the R1 record would have had to land in one PR. The entry would then be live with
no verification for the current code between the merge and the record. Neither the plan nor the
promotion check allows that.

The demo block cannot simply stay as it is either. The archetype templates keep sample data in one
`data` folder, and a template entry has no gallery backend tool such as ringi-review's
`check_authority`. A changed demo changes the hash too.

## Decision

A live entry may carry `next: { source, demo }`, a rebuild staged in its own `use-cases/<slug>`.

- **Catalog.** `next` is allowed only on a live entry, and its source only under `use-cases/`
  (the schema). It must be the agent entry's own `use-cases/<slug>` (the catalog test's folder
  check), different from its `source`, and its demo is checked like any demo (`catalogProblems`).
- **Staging and R1 use the rebuild.** `stagedView(entry)` is the entry with `next`'s source and
  demo in place. `seededEntries('staging')` seeds that view, and the verification fill copies it.
  R1 hashes it, checks it against the deployed commit, compares its instructions and runs its
  prompts.
- **Visitors and the promotion check keep the current source.** Production seeds the live entry as
  it is, and the promotion check hashes `source` and `demo`. The entry stays verified by its
  existing record until the repoint.
- **Repoint.** A small PR moves `next.source` and `next.demo` into `source` and `demo` and drops
  `next`. The hash covers only the folder and the demo, so it equals the one R1 recorded for the
  staged view. The record stays current, and the entry is never unverified. The same PR also
  changes two other things:
  - **Recordings.** They are made from the current source (`tests/store/recordings/use-case-desk.ts`
    and `records-stand-in.ts` read `entry.source`). When the demo or the agent changed, the repoint
    PR re-records the JA and EN moments from the new source, so the promotion check's recordings
    match the repointed demo.
  - **The gallery list.** The catalog test that lists the live entries outside `use-cases/` no
    longer expects the gallery project. It leaves out a `tests/gallery/<slug>` whose entry's source
    is now `use-cases/<slug>` (defined with this decision), so the gallery project stays as the
    tutorial without being a store source.
- **Checks on the rebuild.** The catalog test accepts the `use-cases/<slug>` folder that `next`
  names. The rebuild's folder, demo agent and sample data are checked like a source. Its demo is
  checked by the sample-data rules (`withDemo`) before R1, because a fix after R1 would make the
  record stale.
- **Gallery fixtures.** The fixtures the seed builds for gallery entries (`FIXTURE_RECORDS`, by
  slug) apply only to a `tests/gallery/` source. A rebuild brings its own sample data.

The order for one entry:

1. The batch PR merges `use-cases/<slug>` and sets `next` on the live entry.
2. The staging deploy seeds the rebuild and refills the verification workspace.
3. R1 is dispatched for the entry, and a person commits the record.
4. The repoint PR moves `next` into place.

### The verification workspace

A refill brings a copy the workspace already holds to the template as seeded now (ADR-0171 D1):
instructions, permissions, assignments, skills, stand-ins and sample files. So a deploy's refresh is
enough, and no new, empty workspace is needed.

Two things a rebuild leaves behind, neither of which R1 reads:

- If the rebuild names another demo agent, the old copy stays in the workspace as an unassigned
  agent. R1 finds an entry's copy by the demo agent's name, so it ignores the old one.
- The gallery's sample folders stay where they were copied. The rebuilt agent's file grants name
  its own folders.

## Consequences

- No platform or runtime change. `next` is catalog data that only the staging seed and
  R1 read. Production is unaffected.
- Staging's Try it runs the rebuild as soon as the batch PR is deployed, before R1 has verified it,
  with the entry's current prompts until the repoint. Staging is the verification environment, so
  this is the intended order. A visitor in production only ever gets a verified agent.
- A live entry with `next` has two R1 records: its current one and the rebuild's. Both are kept,
  as every record is.
- **Amended 2026-11-23 (the card).** Both records sit in one `real-model-runs.json`, and the
  store's card (`cardVerification` in `examples/store/catalog/verification.ts`) used to take an
  entry's latest record whatever its hash. A rebuild's failed R1 would then have turned a live
  card back to "verified with the scripted model", and a passed one would have shown a date for
  code visitors do not run. So the card counts only the records whose `sourceHash` is the entry's
  current one. Those hashes are generated at build time into
  `examples/store/catalog/source-hashes.generated.ts` (`tests/store/sources.test.ts`,
  `APPS_WRITE=1`), because the store cannot hash its sources itself. At the repoint, the
  regenerated hash is the rebuild's, so the card moves to the rebuild's record with it.

- Batches 1RA and 1RB use this. Once the ten gallery entries are repointed, nothing sets `next` any
  more. It stays available for any later rebuild of a live entry.
