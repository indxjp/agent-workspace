# W9-MODEL-129 — a one-line fixture fix outside this task's `Owns:` globs

Status: accepted
Date: 2026-09-11
Decided by: W9-MODEL-129 (implementer)
Scope: `apps/web/components/projects/model.test.ts`

## Context

`apps/web/components/projects/model.ts` (landed by an earlier Wave 9.1 task, `#123` project UX;
not this task's file) declares:

```ts
export interface ProjectResource extends Omit<ProjectRecord, 'createdAt' | 'updatedAt'> { … }
```

`ProjectRecord` is `packages/core/src/db/schema/projects.ts`'s drizzle-inferred `Project` type.
This task's migration adds `default_model_connection_id` and `default_model` to `projects`
(the Minimum implementation's own first bullet), so `ProjectRecord` — and, through the `Omit`
above, `ProjectResource` — gained two new required fields the moment the schema changed.
`apps/web/components/projects/model.test.ts` builds one hand-typed `ProjectResource` literal as
a fixture, and `pnpm -w typecheck` failed it with `TS2739: … is missing the following properties
… defaultModelConnectionId, defaultModel`.

This is a real, repo-wide compile failure — not a false positive — and it is entirely mechanical:
the fixture object is missing two fields that now exist on every row of the table it models nobody
disputes it should model. Leaving it broken fails `pnpm -w typecheck`, which is one of the four
blocking gates every Wave 9 card lists as **(G)**.

## Decision

Add the two fields to the fixture literal, both `null` (no default configured — the neutral,
pre-existing state every project had before this task), with a one-line comment naming why. Widen
nothing else in that file: `ProjectResource`'s own declaration, `model.ts`'s functions, and every
other test in the file are untouched, because none of them read the new fields.

Declared as an extra glob on this task's PR body (`Owns` line plus
`apps/web/components/projects/model.test.ts`, with this reason), per the execution protocol's
"only if genuinely impossible" escape hatch and
[ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md)'s precedent for a small,
structurally-forced addition to a file no sibling task claims:

- **No Wave 9 task's `Owns:` line names this file.** This task's siblings this wave
  (`W9-PROV-128`: `apps/web/components/models/**`, `apps/web/app/(shell)/admin/models/**`;
  `W9-FILES-132`: the files browser) do not touch `apps/web/components/projects/`.
- **The fix is additive and one-directional.** It does not change what `ProjectResource` means,
  what `model.ts` exports, or what any other test in the file asserts — it only makes an existing
  literal match a type that changed for reasons entirely outside that file.
- **The alternative — narrowing `ProjectResource` to `Omit` the two new columns as well — is
  worse.** It would hide the workspace's own project-default-model data from the one screen that
  already reads every other project field, for no gain: the fixture fix is strictly smaller and
  leaves the resource type honest about what a project row now carries.

## Consequences

- A later task that builds the project-default-model UI (not this wave, per the card's own
  "Deliberately not built": "No UI") reads `ProjectResource.defaultModelConnectionId`/
  `defaultModel` the same way it reads every other field — no further schema-to-resource mapping
  work is needed on its part.
- If a future migration adds more columns to `projects`, the same ripple will recur for the same
  structural reason: `ProjectResource` extends the whole row. That is `#123`'s design choice, not
  this task's, and is not revisited here.

## Related

- [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) — the declared `Owns:` line
  is the boundary; a small, undisputed addition is declared rather than worked around.
