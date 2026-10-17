# W2-CP-03 — A runtime barrel may not reach a test framework, and no gate in this repository can see that it does

Status: accepted
Date: 2026-09-05
Decided by: W2-CP-03 (ObjectStore), on a finding from W2-INT-01
Scope: `packages/core/src/storage/**`

## Context

`packages/core/src/storage/contract.ts` is the shared `ObjectStore` contract suite — the one
documented entry point a new backend calls (`defineObjectStoreContract('S3 (MinIO)', setup)`).
It calls `describe`/`it`, so it imports `vitest` at module scope; there is no other way to reach
those functions.

`packages/core/src/storage/index.ts` re-exported it, so that `contract.ts`'s "Adding a backend"
recipe would be reachable from outside the directory. That barrel is also what
`apps/web/server/files/object-store-bridge.ts` imports, so `vitest` was in the module graph of
every `/api/files*` route.

W2-INT-01 found the consequence by standing up a real `next dev` against a real PostgreSQL on the
integration branch: **all five files routes answered `500`**, thrown while the route module was
being evaluated, at `contract.ts`'s `vitest` import. It verified the failure was not caused by its
own bridge change — reverting to this task's `dist`-relative spelling reproduced it at the same
line — and left the repair to this task, because the entry point is this task's design.

**Nothing in this repository could have caught it.** `routes.test.ts` *is* Vitest, so the import
resolves there and every assertion passes. `pnpm build`, `pnpm typecheck` and `pnpm lint` never
evaluate the module: a type-level import graph is not an evaluated one. Only a real server, or a
deployment-shaped module resolution, surfaces it:

```
$ cp -r packages/core/dist /tmp/prodsim/dist && cd /tmp/prodsim
$ node --input-type=module -e "await import('./dist/storage/index.js')"
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vitest' imported from
  /tmp/prodsim/dist/storage/contract.js
```

That is the same defect the integrator hit, in the form anyone can reproduce in ten seconds: a
deployment installs no devDependencies, so `vitest` is not on the resolution path.

## Decision

**A barrel that production code imports is a runtime surface, and nothing reachable from it may
import a test framework.** Concretely:

1. `index.ts` no longer re-exports `contract.ts`, and carries a comment saying why, so the export
   is not restored by someone reading the file as merely "incomplete".
2. The suite stays reachable the way test-time helpers are reached — by path, from a test file
   beside it: `import { defineObjectStoreContract } from './contract.js'`, which is exactly what
   `local-fs-store.test.ts`, `memory-store.test.ts` and `contract.ts`'s own printed recipe already
   do. Nothing about "one suite, one entry point" changed.
3. A backend *outside* `packages/core` needs a separate `exports` entry — `./storage/contract` —
   rather than the existing `./storage` one. That file is not this task's to edit (ADR-0038 and
   `apps/web/server/files/object-store-bridge.ts`), and the split is the point: production code and
   a Vitest-dependent suite must not sit behind one specifier.
4. `packages/core/src/storage/index.test.ts` walks the static import closure of `index.ts` and
   fails if anything in it imports `vitest`, `jest`, `mocha` or `node:test` — and says in its own
   header that it *cannot prove the fix*, because it runs under Vitest, the environment that hides
   the bug. It is a regression guard, not evidence.

The rejected alternative was a lazy `vitest` import inside `defineObjectStoreContract`. It would
keep the export and hide the coupling: `describe`/`it` must be called synchronously during
collection, so the "lazy" import would be a `createRequire` call that works only inside a Vitest
process anyway — the same dependency, harder to see.

## Consequences

* Evidence for a defect of this shape has to come from outside the test runner. This task's PR
  pastes a real `next dev` request (`GET /api/files` → `503 files_runtime_not_configured`, the
  route's own envelope, so the module evaluated) and the deployment-shaped `node` import above.
  A green Vitest run is not evidence here and is not offered as any.
* W2-INT-01 pinned the broken behaviour in its probe as an equality, so the probe changes when this
  lands — expected and intended, and named here so the change is not read as drift.
* The rule generalises past this file: every `packages/*/src/**/index.ts` this repository grows is
  a runtime surface for whatever imports it, and a suite that ships behind one is a production
  dependency on a devDependency. `index.test.ts`'s closure walk is the shape to copy.
* Nothing about the guard, the two-tree layout or the contract suite's content changed. This is a
  packaging decision, recorded separately from
  [W2-CP-03-object-key-safety.md](W2-CP-03-object-key-safety.md) because it is a different
  question with a different failure mode.
