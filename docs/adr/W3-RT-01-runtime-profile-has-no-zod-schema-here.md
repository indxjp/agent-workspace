# W3-RT-01 — `RuntimeProfile` carries no Zod schema in `packages/runtime`; a dependency was needed and not added

Status: accepted
Date: 2026-09-06
Decided by: W3-RT-01 (the one abstraction)
Scope: `packages/runtime/src/types.ts`; binding on W3-CP-06, which the plan already assigns the Zod
validation to

## Context

The Wave 3 plan's 3a-1 cell reads: *"add `types.ts` carrying `RuntimeProfile` (§15.1) with
its Zod schema."* This task's Accept criterion, in the same cell, reads: *"`pnpm typecheck` and
`pnpm lint` pass with `packages/runtime` still declaring **no runtime dependencies**."*

Those two sentences cannot both be honoured by adding a Zod schema to `packages/runtime/src/types.ts`:

* A schema that validates `RuntimeProfile` at a system boundary (an HTTP body, a database row) has
  to call `zod`'s `z.object(...)` and `.parse()`/`.safeParse()` at run time, in code shipped from
  this package's `dist/`. That makes `zod` a **runtime** dependency of `@agent-workspace/runtime`,
  not a devDependency: every consumer of the built package needs `zod` resolvable at both
  type-check time and run time, which means it has to be listed in
  `packages/runtime/package.json`'s `dependencies`.
* `packages/runtime/package.json` today has no `dependencies` key at all — only
  `devDependencies: { typescript, vitest }` — and this task's own Accept line asserts that stays
  true.

So "with its Zod schema" and "no runtime dependencies" are, read together, a plan defect: the
Owns/what-to-build cell asks for something the Accept cell's own criterion forbids. Per the wave
protocol (*"Where the development plan and `spec.md` disagree, the plan is defective: record it, do
not work around it in code"* — the same principle applied here to two clauses of the same plan
disagreeing with each other) and the task's binding rule (*"YOU MAY NOT ADD A DEPENDENCY... If you
find you need one, STATE IT in your report and stop rather than adding it"*), the resolution is to
record the conflict, not silently pick a side by adding the dependency.

Three additional facts make "do not add it here" the right side to have picked, not merely the
permitted one:

1. **`docs/spec.md` §15.1 itself prints no Zod schema.** Its fenced `ts` block is a plain
   `interface`; "with its Zod schema" is the wave plan's addition, not the specification's, and
   the specification is authoritative over the plan (protocol, "Authoritative reading").
2. **The wave plan's own 3a-2 row assigns the schema to a different task.** W3-CP-06's cell reads:
   *"runtime profiles CRUD over §34's `/api/runtime-profiles`, **the §15.1 schema validated with
   Zod**, and the §15.2 network-policy mapping stored as data."* W3-CP-06 lives in `apps/web`,
   which already depends on `zod` transitively through `@agent-workspace/core`
   (`packages/core/package.json` pins `"zod": "4.5.4"`) — the schema has a home that costs nothing
   new.
3. **ADR-0041 makes "no runtime dependencies" a precondition of this task's own execution**, not
   only its Accept line: it is *"the condition under which this task is allowed to run
   concurrently with sub-wave 2b-2."* Adding `zod` here would not just fail a local check; it would
   falsify a fact another task's scheduling already assumed to be true.

## Decision

`packages/runtime/src/types.ts` transcribes `RuntimeProfile`'s **shape** (§15.1, verbatim member
names, optionality and type text — checked by `spec-transcription.test.ts`) and adds **no** Zod
schema, no `zod` import, and no dependency in `packages/runtime/package.json`.

The Zod schema is a **declared, stated gap** of this task, in the sense the wave protocol asks for:
whoever builds W3-CP-06 writes `RuntimeProfileSchema` (or equivalent) in `apps/web` (or
`packages/core`, wherever that task's Owns globs land it), against the `zod` dependency that
already exists there, validating the same shape `packages/runtime/src/types.ts` declares.

## Alternatives considered

* **Add `zod` to `packages/runtime/package.json` and write the schema here anyway**, on the theory
  that a package doing type-only work "shouldn't count." Rejected: `pnpm typecheck` and `pnpm lint`
  passing "with no runtime dependencies" is this task's own Accept sentence, verbatim, and there is
  no reading of "no runtime dependencies" under which a `dependencies` entry does not count as one.
* **Write the schema as a devDependency-only construct**, e.g. only used from `types.test.ts` and
  never exported. Rejected: the plan's cell asks for `types.ts` to *carry* the schema, i.e. export
  it for a consumer to use; a schema that exists only inside a test file validates nothing a real
  caller can reach, which is a stub dressed as a deliverable — the same objection this wave's own
  text raises elsewhere about a mocked transcript standing in for a real thing
  ([ADR-0035](0035-an-acceptance-criterion-needing-a-resource-this-deployment-lacks-is-a-declared-gap-not-a-claim.md)).
* **Hand-roll a validator with no dependency** (manual `typeof`/shape checks). Rejected on the
  wave protocol's own instruction: *"Before hand-rolling a decision procedure, check whether a
  dependency you already have makes it for you"* — the dependency this task does not have is not
  the one to work around by hand-rolling a worse version of it; the dependency the *platform*
  already has (`zod`, in `apps/web`/`packages/core`) is the one that should validate this shape,
  which is exactly where the plan's own 3a-2 row puts it.
