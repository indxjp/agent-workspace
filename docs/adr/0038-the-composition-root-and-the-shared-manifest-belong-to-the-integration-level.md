# ADR-0038 — The composition root and the shared manifest belong to the integration level, and a wave without an integration task cannot wire anything

Status: accepted
Date: 2026-09-05
Decided by: orchestrator, after all four sub-wave 2b-1 tracks reported the same two files as blocking
Scope: `apps/web/instrumentation.ts`, `packages/core/package.json`, `pnpm-lock.yaml`; the shape of every future sub-wave's task list

## Context

Sub-wave 2b-1 dispatched four parallel backend tracks with pairwise-disjoint `Owns` globs, exactly as
plan §2.3 requires. All four passed that check. All four then reported, independently and without
having seen each other's reports, that they were blocked on the same two files.

**`apps/web/instrumentation.ts` — the composition root.** It is where a subsystem's runtime is
installed so its routes stop answering `503`. W2-DB-02 owns it and W2-DB-02 landed with sub-wave 2a.
So in a real deployment built from 2b-1's four branches: every `/api/secrets/**` route answers
`503 secrets_runtime_not_configured`, every `/api/files*` route answers `503
files_runtime_not_configured`, all nine RBAC routes answer `503`, and every session route answers
`503` "forever" in its own author's words. Four subsystems, fully built, fully tested, and
unreachable — and no task in the sub-wave was permitted to connect them.

**`packages/core/package.json` and `pnpm-lock.yaml` — the shared manifest.** W2-CP-03 could not add
`@aws-sdk/client-s3`, so the S3/MinIO half of its acceptance criterion — "one suite passes against
**both** backends" — could not be attempted at all. It verified that MinIO starts and answers
healthy here, verified the dependency is absent from the lockfile, wrote an ADR recording the
blockage, and declared the gap. That was the correct behaviour and the criterion still failed.

The two tracks that hit the manifest resolved it in **opposite** ways, both defensibly:

- **W2-CP-02** added one `exports` key, declared it on its `Owns` line with a reason, and cited
  [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) — a task needing a file
  outside its glob declares it and stays disjoint from its siblings.
- **W2-CP-03** refused, citing the dispatch protocol's absolute prohibition on changing a file
  outside the declared globs, and [ADR-0017](0017-manifests-belong-to-their-package-the-lockfile-is-generated.md)'s
  rule that a manifest has exactly one owner.

When two careful agents read the same rules and reach opposite conclusions, the rules are
underspecified. That is the defect this record fixes.

There is a third, quieter cost. W2-CP-03 needed `@agent-workspace/core/storage` to exist and could
not create the export, so it reached the module through a `dist`-relative bridge instead — and that
produced a real bug it then had to find and fix: the relative path resolved to a *different module
instantiation* than the package specifier resolves to, so a `WorkspaceScope` minted by one was
refused by the other's private-field brand check. Two runtime classes with the same name. Denying a
task the one line it needs does not remove the need; it routes it through something worse.

## Decision

**The composition root and the shared manifest are owned at the integration level, and every
sub-wave that produces installable subsystems must have an integration task that owns them.**

Concretely, for the remainder of Wave 2 and for every wave after it:

1. **`apps/web/instrumentation.ts` belongs to the sub-wave's integration task**, never to a feature
   track. Each track ships its `configure<X>Runtime` function and states, in an ADR, the exact call
   that installs it. The integration task makes those calls and verifies the routes leave `503`.
2. **`packages/core/package.json` and `pnpm-lock.yaml` belong to the sub-wave's integration task.**
   A track that needs an export subpath or a dependency states it — the package, the pinned version,
   and the research note that pinned it — and does not add it. The integration task adds all of them
   in one commit and regenerates the lockfile once.
3. **A sub-wave with no integration task is a defective dispatch.** Sub-wave 2b-1 had none. That is
   an orchestrator error, not a failing of any of the four tracks, and it is recorded here as one.
4. **`ADR-0018` does not license editing a shared manifest.** It licenses declaring a file outside
   the glob *when that file has no other claimant at the same level*. A manifest every sibling needs
   has claimants; it belongs to the level above. W2-CP-02's edit stands — it is one additive
   `exports` key, it is declared, and reverting it would cost more than it is worth — but it is the
   last one, and the integration task now owns reconciling it.

The general test is [ADR-0037](0037-the-adr-index-is-generated-not-owned-so-a-conflict-in-it-is-resolved-by-regenerating.md)'s:
**is a conflict in this file resolved by deciding, or by re-deriving?** The ADR index is
re-derived, so every task may write it. `instrumentation.ts` needs somebody to decide the
installation order and the configuration each subsystem receives; `package.json` needs somebody to
decide the dependency set. Both are decisions. Both belong to the integration level, which is
exactly [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md)'s rule applied to
composition rather than to gates.

## Consequences

- Sub-wave 2b-1 gains **W2-INT-01**, an integration task owning `apps/web/instrumentation.ts`,
  `packages/core/package.json`, `pnpm-lock.yaml`, and the union verification of the four tracks.
  Its acceptance criterion is the one no track could state: **every route the sub-wave shipped
  answers something other than 503 in a deployment built from the integration branch.**
- W2-CP-03's S3/MinIO backend becomes writable — but by whom is a real question, since the contract
  suite and the backend are W2-CP-03's and the dependency is W2-INT-01's. The sequencing is:
  W2-INT-01 lands the dependency, then W2-CP-03 writes the backend against its own already-generic
  contract suite. That is one extra edge in the stack and it is the honest one.
- Every future wave plan must show an integration task in its ownership table before dispatch. The
  wave-ownership checker cannot detect its absence — it proves globs do not intersect, not that the
  union covers what the wave promised — so this is a review item, not a gate. Stated plainly rather
  than implied (ADR-0031).
- Four tracks' worth of `503` routes is the visible cost of getting this wrong once. It was caught
  by the tracks themselves reporting honestly rather than quietly reaching outside their globs,
  which is the behaviour the prohibition exists to produce.

## Alternatives rejected

**Let each track edit `instrumentation.ts` and resolve the conflicts at merge.** Four tracks editing
one composition root is the union failure of ADR-0019 in a different costume — five Wave 1 tracks
each passed alone and produced seven failures on union for exactly this reason.

**Give `instrumentation.ts` to one of the four tracks.** Whichever is chosen must then understand
and install the other three subsystems, which is the integration task wearing a track's name.

**Let a track add its own dependency and regenerate the lockfile.** Four parallel lockfile
regenerations conflict in a file nobody can hand-merge, and ADR-0017 exists because that was already
tried.

**Widen the prohibition's exception so a track may edit a manifest "when necessary".** "Necessary"
is exactly the judgement the two tracks made oppositely. A rule that two careful readers apply in
opposite directions is not a rule.

## Related

- [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) — the same rule for
  repository-wide gates; this record extends it from gates to composition.
- [ADR-0017](0017-manifests-belong-to-their-package-the-lockfile-is-generated.md) — a manifest has
  one owner; this record says which one.
- [ADR-0037](0037-the-adr-index-is-generated-not-owned-so-a-conflict-in-it-is-resolved-by-regenerating.md)
  — the contrasting case, and the test that separates them.
- [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) — narrowed here: it does not
  license editing a file that has claimants at the same level.
- [ADR-0034](0034-an-integration-branch-is-built-from-main-not-from-the-top-of-the-stack.md) — how
  the integration branch W2-INT-01 works on is built.
