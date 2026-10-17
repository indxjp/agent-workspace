# W2-INT-01 — Every `/api/files*` route answers 500 in a real server, because `@agent-workspace/core/storage` re-exports a module that imports `vitest`

Status: accepted — **closed** by W2-CP-03 at `6a3ac24`; kept as the record of what was found and how
Date: 2026-09-05
Task: W2-INT-01 (sub-wave 2b-1 integrator)
Scope: a defect in `packages/core/src/storage/index.ts` — W2-CP-03's glob, not this task's

## Closed, and by what

W2-CP-03 repaired it in `6a3ac24` and recorded the decision in
[W2-CP-03 — a runtime barrel may not reach a test framework](W2-CP-03-a-runtime-barrel-may-not-reach-a-test-framework.md).
`index.ts` no longer re-exports `contract.ts`; the suite is reached by path from a test file beside
it, which is what `local-fs-store.test.ts`, `memory-store.test.ts` and `contract.ts`'s own printed
recipe already did. The lazy-`vitest`-import alternative was rejected because `describe`/`it` must
be called synchronously during collection, so it would have been a `createRequire` that works only
inside a Vitest process — the same dependency, harder to see.

The repair's evidence comes from outside the test runner, which is the only place it could:

```text
$ cp -r packages/core/dist /tmp/prodsim/dist && cd /tmp/prodsim
$ node --input-type=module -e "await import('./dist/storage/index.js')"
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vitest' imported from
  /tmp/prodsim/dist/storage/contract.js        # on 7cd849d
                                                # on 6a3ac24: loads, 13 exports, no defineObjectStoreContract
```

On this branch, after the merge, all five files routes answer `503 files_runtime_not_configured`
when the runtime is not installed and reach their handlers when it is — the route's own envelope,
which only exists if the module evaluated.

**Why nobody caught it earlier, worth keeping because it generalises:** the 500 does not reproduce
under `next dev` inside a worktree at all. `vitest` is a root devDependency and Node resolves it by
walking up, so a checkout of this repository always has it on the path. Only a dependency-free
`dist` — or a deployment — shows it. That is precisely why this record's finding came from a
real-server probe rather than from a gate, and why the probe stays.

`tests/no-route-answers-503.test.ts` pinned the broken behaviour as an equality against W2-CP-03's
five routes, so the repair could not land silently either: the expectation went red the moment the
barrel stopped re-exporting the suite. It now asserts the property that was false when this record
was written — **no declared route answers a 5xx other than a 503 a named gap accounts for**.

## What was found

Driving every declared route against a real `next dev` server built from this branch — the
criterion [ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
gives W2-INT-01, and `tests/no-route-answers-503.test.ts` is the probe — all five files routes
answer **500**:

```text
  500  GET /api/files  (W2-CP-03)
  500  POST /api/files  (W2-CP-03)
  500  GET /api/files/:id  (W2-CP-03)
  500  DELETE /api/files/:id  (W2-CP-03)
  500  PATCH /api/files/:id  (W2-CP-03)
```

The server says why:

```text
⨯ Error: Vitest failed to access its internal state.

One of the following is possible:
- "vitest" is imported directly without running "vitest" command
…
    at module evaluation (..\..\packages\core\src\storage\index.ts:44:92)
    at module evaluation (server\files\object-store-bridge.ts:56:1)
    at module evaluation (server\files\handlers.ts:48:1)
    at module evaluation (app\api\files\route.ts:11:1)
 GET /api/files 500 in 367ms
```

The chain is four modules long and every link is a plain static import:

```text
apps/web/app/api/files/route.ts
  → apps/web/server/files/handlers.ts
    → apps/web/server/files/object-store-bridge.ts
      → packages/core/src/storage/index.ts       line 44:
            export { defineObjectStoreContract, type ObjectStoreContractFixture }
              from './contract.js';
        → packages/core/src/storage/contract.ts  line 49:
            import { describe, expect, it } from 'vitest';
```

`contract.ts` is the shared `ObjectStore` contract suite. It is excellent, it is the thing
`docs/adr/W2-CP-03-s3-minio-backend-blocked.md` correctly points an S3 backend at — and it calls
`describe`/`it` at module scope, so importing it outside a Vitest process throws before any handler
body runs. The storage barrel re-exports it, so **every** consumer of
`@agent-workspace/core/storage` loads Vitest, and a Next.js server is not a Vitest process.

## It is not caused by this task's one-line bridge change, and that was checked by running it

W2-INT-01 landed the `./storage` exports subpath and changed
`apps/web/server/files/object-store-bridge.ts` from `../../../../packages/core/dist/storage/index`
to `@agent-workspace/core/storage` — the one file `docs/adr/W2-CP-03-s3-minio-backend-blocked.md`
said would change. The obvious suspicion is that the new specifier resolves somewhere the old one
did not.

It does not. The bridge was reverted to W2-CP-03's own `dist`-relative spelling, byte for byte from
`origin/aw/w2-05-files`, and the same server was started again against the same database
(ADR-0029 — a finding is a counter-example actually built and run):

```text
$ git show origin/aw/w2-05-files:apps/web/server/files/object-store-bridge.ts \
    > apps/web/server/files/object-store-bridge.ts
$ tail -1 apps/web/server/files/object-store-bridge.ts
} from '../../../../packages/core/dist/storage/index';
$ node aw-scratch/files-probe.mjs      # next dev, real PostgreSQL, real session cookie
STATUS 500
⨯ Error: Vitest failed to access its internal state.
    at module evaluation (..\..\packages\core\src\storage\index.ts:44:92)
    at module evaluation (server\files\object-store-bridge.ts:56:1)
 GET /api/files 500 in 367ms
```

Identical failure, identical line. `dist/storage/index.js` re-exports `dist/storage/contract.js`,
which imports `vitest` exactly as its source does; the frame naming `src/` is Turbopack resolving
the shipped source map. The bridge change is inert with respect to this defect, and the subpath is
kept.

## Why it was invisible to W2-CP-03 and to every gate

`apps/web/server/files/routes.test.ts` drives the real route handlers with real `Request` objects
and passes — **inside Vitest**, where `import 'vitest'` resolves and `describe` at module scope is
legal. `pnpm build`, `pnpm typecheck` and `pnpm lint` all pass too: the import is well-typed, it
resolves, and nothing about it is a static error. The only observer that can see this is a process
that is a web server and not a test runner, and until this task nothing in the repository was one.

That is the same shape as the four uninstalled runtimes ADR-0038 records — a class of defect whose
only witness is a deployment — and it is the argument for the probe being permanent rather than a
one-off paste.

## Why W2-INT-01 does not repair it

The repair is small and its **shape is a decision W2-CP-03 owns**. `contract.ts`'s header names
`defineObjectStoreContract` as the one documented entry point for adding a backend, and
`docs/adr/W2-CP-03-s3-minio-backend-blocked.md` tells the next task to call it. Whether the fix is
"the barrel stops re-exporting it", "the contract gets its own `./storage/contract` subpath", or
"the suite moves to a `*.test-support.ts` the package's build excludes" changes what that
instruction says. Choosing for W2-CP-03 while it has a repair round in flight is how two people end
up owning one recipe.

This task's brief is also explicit: *"If something breaks only on the union, that is the most
valuable thing you can find. Report it plainly; do not quietly fix a task's code to make the union
green."*

What is recorded here, so the repair needs no re-discovery: nothing outside
`packages/core/src/storage/` imports `defineObjectStoreContract`, and both of its users import it
by relative path rather than through the barrel —

```text
$ grep -rn "defineObjectStoreContract" --include=*.ts . | grep -v node_modules | grep -v /dist/
packages/core/src/storage/contract.ts:85:export function defineObjectStoreContract(
packages/core/src/storage/index.ts:44:export { defineObjectStoreContract, … } from './contract.js';
packages/core/src/storage/local-fs-store.test.ts:12:import { defineObjectStoreContract, … } from './contract.js';
packages/core/src/storage/memory-store.test.ts:12:import { defineObjectStoreContract, … } from './contract.js';
```

so deleting line 44 of `index.ts` breaks no existing caller. That is evidence for W2-CP-03's
decision, not a substitute for it.

## Consequences

- **`/api/files`, `POST /api/files`, `GET|DELETE|PATCH /api/files/:id` are unusable in a
  deployment built from this branch.** They answer 500, not 503 — so W2-INT-01's criterion is
  literally satisfied for them and substantively is not, and this record exists so that difference
  cannot be reported as a pass ([ADR-0035](0035-an-acceptance-criterion-needing-a-resource-this-deployment-lacks-is-a-declared-gap-not-a-claim.md)).
- The composition root's own half is verified: `[compose] files API installed: local filesystem
  object store rooted at …` is printed at start-up, the runtime *is* installed, and the 500 happens
  when the route module is first evaluated. Wiring is not the missing piece.
- `tests/no-route-answers-503.test.ts` asserted this positively rather than tolerating it: the set
  of routes answering 5xx had to equal exactly W2-CP-03's five, so the probe would fail the day
  another subsystem broke the same way **and** the day this one was repaired without the record
  being updated. The second of those happened, at `6a3ac24`, which is why this record has a
  "Closed" section and the probe now asserts the empty set.
- A general lesson worth the sentence: a package's public barrel is loaded by every consumer, so a
  test-only module re-exported from it is a test framework shipped into production. `@agent-workspace/core/db`
  and `@agent-workspace/core/secrets` do not do this; `@agent-workspace/core/storage` is the only
  barrel in the repository that does.

## Related

- [ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
  — the criterion whose probe found this, and the class of defect only a deployment can witness.
- [ADR-0029](0029-a-narrowing-is-a-defect-only-when-a-counter-example-exists.md) — why the "not caused
  by the bridge change" paragraph is a transcript rather than an argument.
- `docs/adr/W2-CP-03-s3-minio-backend-blocked.md` — the record that names `contract.ts` as the
  entry point a repair has to keep working.
