# W2-CP-07 — A restatement across a package boundary is watched by a replay, not by a comment

Status: accepted
Date: 2026-09-05
Task: W2-CP-07 (sub-wave 2b-1, repair round 2)
Scope: `apps/web/server/sessions/wire-contract.test.ts`, `apps/web/server/sessions/transcript.ts`

## Context

`apps/web` and `apps/runner` each hand-write one half of the same contract, twice over:

| what | control plane | sandbox |
| --- | --- | --- |
| the port's type | `TranscriptStore` (`apps/web/server/sessions/transcript.ts`) | `TranscriptMirror` (`packages/engine-claude-agent-sdk/src/boundary.ts`) |
| the HTTP wire format | `apps/web/server/sessions/api.ts` | `apps/runner/src/session.ts` |

The duplication is deliberate and was declared: `apps/web` does not depend on
`@agent-workspace/runner`, `apps/web/package.json` is not this task's file (ADR-0017), and the same
pattern already exists between `apps/runner/src/runtime.ts` and `packages/runtime/src/driver.ts`.

What was **not** true is what this task said protected it. `transcript.ts` and gap 6 of PR #56 both
claimed the compiler was watching:

> What stops drift is that `session.ts` builds a `TranscriptMirror` out of the wire format
> `transcript.ts` defines, so a divergence stops it compiling.

There is no such edge. `apps/runner/src/session.ts` has exactly one import — `./claude.js`, and that
one is `import type` — and `apps/runner/package.json` names `@agent-workspace/core` and
`@anthropic-ai/claude-agent-sdk` and nothing else. The verifier of round 1 built the counter-example
and ran it: renaming the `subkeys` field of one response on the `apps/web` side and updating
`apps/web`'s own test in lockstep — exactly what a maintainer does — left `pnpm typecheck`,
`pnpm lint` and all 1 059 tests green, and broke resume against a real model.

An admitted gap with an imaginary mitigation is worse than an admitted gap. A reader who is told the
compiler is watching stops watching.

## Decision

**Replace the claim with a gate that replays one side's vocabulary against the other, and state its
bounds where a reader will meet them.**

`apps/web/server/sessions/wire-contract.test.ts` reads three sources and trusts none of them:

1. `apps/runner/src/session.ts` **as text, through the TypeScript AST** — the `/api/…` templates it
   calls, the `URLSearchParams` names it sets, the property names it puts under `JSON.stringify`,
   the strings it uses to read fields off an answer, and the `method:` verbs it sends. Reading a
   sibling package's source to stop a restatement drifting is the pattern this repository already
   uses: `apps/web/server/runs/store.test.ts` reads `packages/core/src/db/schema/runs.ts` for the
   same reason. The AST rather than a regular expression is [ADR-0030](0030-import-edges-are-resolved-by-the-compiler-not-matched-by-regex.md)'s
   rule one level down — a property name is a node, not a substring.
2. `tests/route-declarations/W2-CP-07.ts`, the same way. That file is what
   `tests/route-inventory.test.ts` checks the real App Router files against, so comparing the
   mirror's paths to it reaches the route files without this gate knowing where they live.
3. The five handlers in `apps/web/server/sessions/api.ts`, **executed** — requests assembled out of
   the mirror's own field names, against a real store and a real principal.

Then: every top-level field the control plane answers with must be one the mirror's source names,
and every field the mirror reads off an answer must be one an answer carries. Both directions, so a
rename on either side is red.

## Evidence — the verifier's own counter-example, and its mirror image

Mutation applied to `apps/web` alone, with `api.test.ts` updated in lockstep:

```text
$ pnpm typecheck   → tc=0
$ pnpm lint        → lint=0
$ npx vitest run apps/web/server/sessions/wire-contract.test.ts
AssertionError: the control plane answers with a top-level field "subkeyList" that
apps/runner/src/session.ts never mentions, so the mirror cannot read it back
 Test Files  1 failed (1)
```

The same drift entered from the sandbox side instead — `record['subkeys']` renamed in
`apps/runner/src/session.ts`, `apps/web` untouched:

```text
AssertionError: the control plane answers with a top-level field "subkeys" that
apps/runner/src/session.ts never mentions, so the mirror cannot read it back
```

And a path drift, `…/subkeys` → `…/sub-keys` in the mirror:

```text
× calls exactly the routes this task declares, and no others
```

All three mutations were reverted; `git status --porcelain -uall` is clean of them.

## What this does not close, stated because a reader will otherwise assume it does

[ADR-0031](0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md) — a static
check cannot be complete, so the limits are named rather than implied. The gate's own header carries
these too, because that is where the next maintainer meets them:

* It compares the **wire**. `TranscriptStore` and `TranscriptMirror` are still two hand-written
  types with no compiler edge between them. A member added to one and not the other is caught only
  if the wire exercises it; every member the wire does exercise is replayed.
* It reads four syntactic forms out of the mirror. A wire name built some other way — assembled from
  variables, say — is not seen. Each extractor **fails when it finds nothing**, so the gate cannot
  pass vacuously (ADR-0015).
* Path and method are compared as sets, not as pairs. The pairing is what the replay exercises, one
  handler at a time.

The change that would remove the duplication rather than watch it is one shared package — a
`packages/session-wire` holding the types and the path builders, depended on by both apps. That is a
new workspace member and two manifests, none of which is this task's file (ADR-0017); it is on this
task's PR as a declared gap.

## Consequences

* The comment that named a protection now names a protection that exists, and running the
  verifier's mutation is how that was established rather than asserted ([ADR-0029](0029-a-narrowing-is-a-defect-only-when-a-counter-example-exists.md), [ADR-0016](0016-measured-numbers-do-not-live-in-prose.md)).
* A second gate, `apps/web/server/sessions/references.test.ts`, closes the same class one level out:
  three prose pointers to evidence files shipped dangling on this branch because nothing in CI
  resolved them. It resolves every repository path this task's own files name, and it reproduces all
  three by name when they are put back.
* Both gates are scoped to this task's files. A repository-wide version of either belongs in
  `tests/`, which is not this task's to add to; that is reported on the PR rather than quietly
  narrowed.
