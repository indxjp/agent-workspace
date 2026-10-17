# ADR-0012 — Two ADR series collided; task records were renamed to their task ids

Status: accepted (three false claims corrected 2026-09-03 — see "Correction")
Date: 2026-09-03
Decided by: orchestrator
Scope: `docs/adr/`

## Context

[ADR-0003](0003-adr-naming-preserves-file-ownership.md) predicted that globally-numbered ADR
filenames cannot survive this programme's parallelism, because a global number is a shared resource
and plan §2.3 buys concurrency with disjoint file ownership. The prediction was confirmed within one
wave, by two authors who never saw each other's work:

- W0-INF-01, during a code-review pass, created `docs/adr/` with its own `README.md`, a
  `0000-record-architecture-decisions.md` bootstrap record, and five numbered records
  (`0001-vitest-projects-follow-the-workspace`, `0002-typescript-project-layout`,
  `0003-type-aware-linting`, `0004-internal-packages-are-not-published`,
  `0005-supported-node-runtime`). It reached `main` via the merge of PR #2
  ([ADR-0011](0011-unauthorised-agent-merges-and-the-restack.md)).
- The orchestrator, separately, authored programme records `0001`–`0010` under the ADR-0003
  convention.

Result: two files named `0001-*`, two named `0002-*`, and so on through `0005-*`, with unrelated
content and two competing `README.md` conventions.

## Decision

Apply ADR-0003 to the collision rather than inventing a new scheme for it.

1. The five W0-INF-01 records are **task-level** by content — every one is a decision local to the
   monorepo skeleton. Rename each to `W0-INF-01-<slug>.md`, content unchanged. Renaming, not
   renumbering: the record keeps its identity and its text, and `git log --follow` still reaches it.
2. `0000-record-architecture-decisions.md` and W0-INF-01's `README.md` are superseded by the
   orchestrator's `README.md`, which states the two-class convention. The bootstrap record is deleted
   rather than kept as a stub: its entire content was "we will use ADRs", which the README now says
   with the convention attached.
3. The programme records `0001`–`0014` stand.
4. `W0-INF-01-supported-node-runtime.md` is retained alongside
   [ADR-0006](0006-node-24-and-engine-strict.md). The task record says what the package manifest
   does; ADR-0006 says why the floor is a security decision tied to R-14 and spec §15.2. Neither
   subsumes the other, and the two now link to each other.

## Correction

This record originally carried three false statements, all found by a verifier and all of the exact
class this programme keeps failing on — an artefact asserting something that is not so.

- It said the renamed records were *"referenced only from W0-INF-01's own PR body"*. False. Four
  **source files** carry links to the old paths: `vitest.config.ts:17` and
  `scripts/check-file-ownership.mjs:22` → `0001-vitest-projects-follow-the-workspace.md`;
  `tsconfig.json:26` and `apps/web/tsconfig.json:19` → `0002-typescript-project-layout.md`;
  `eslint.config.mjs:23` → `0003-type-aware-linting.md`. Renaming the records broke every one of
  them, and three now **mis-resolve** to an unrelated programme record of the same number — worse
  than a dead link, because the reader lands somewhere plausible and wrong.
- It said *"ADR-0006 links to it"*. False when written; ADR-0006 contained no such link and no
  mention. The link now exists, which is why the claim is true today — but it was asserted before it
  was made, which is the defect.
- It said the index had drifted *"listing 12 records when the directory held 22"*. False at every
  commit. Measured across the whole range in which the twelve-row table stood (`73ca40b`,
  `794b674`, `d4652cb`, `224daca`, `5f5fa9d`), the directory held 18, 20, 20, 20, 20 —
  never 22. The Wave 0 manifest said 20 for the same event and was right; the two
  artefacts disagreed for a day because both numbers were recalled rather than measured, which is
  the failure W0-DOC-01 exists to prevent, committed inside the record that names it.

The claims are corrected in place and the correction is recorded rather than silently applied. An
ADR that quietly repairs its own false statements teaches the next reader nothing.

## Alternatives considered

- **Renumber the orchestrator's records to `0006`–`0019`.** Rejected: it concedes the global sequence
  ADR-0003 already rejected, and the next wave would collide again.
- **Keep both series and disambiguate by directory** (`docs/adr/programme/`, `docs/adr/tasks/`).
  Rejected: it moves every existing link and buys nothing the filename prefix does not already give,
  since the prefix is what makes the ownership glob work.
- **Delete W0-INF-01's records as redundant.** Rejected outright. They record real decisions with
  real rejected alternatives; deleting a decision log to tidy a naming clash is the opposite of what
  the log is for.

## Consequences

- The five source-file cross-links above had to be repointed. Three of them mis-resolved in the
  interim, and `main` carries one commit where they were broken.
- The convention is enforced by nothing but this record and the README. A future agent that writes
  `docs/adr/0015-…` will not be stopped by CI. Making the ownership checker reject a `NNNN-` record
  from a task-level PR is a small addition and is recorded as a declared gap rather than done here,
  because the checker belongs to W0-INF-02.
- `docs/adr/README.md`'s index must be regenerated by listing the directory, never by memory. It has
  already drifted once, listing 12 records when the directory held **20** — the same failure
  [W0-DOC-01's ADR](W0-DOC-01-mechanical-count-derivation.md) was written about. Regeneration is now
  a committed command, `docs/adr/regenerate-index.sh`, rather than an instruction; see the README.

  Provenance for the 20, because this record first said 22 and the manifest said 20: the twelve-row
  table was in force from `73ca40b` to `5f5fa9d`, and
  `git ls-tree --name-only <sha> docs/adr/ | grep -v README | wc -l` over that range returns
  18, 20, 20, 20, 20. The directory held 18 when the twelve-row table was written and 20 at
  `5f5fa9d`, the commit immediately before `a3d69bb` regenerated it. **It never held 22 while the
  index listed 12**, at any commit in this branch's history.
