# W2-DB-02 — The repository shape: a scope is a constructor argument, and two implementations are kept honest by one suite

Status: accepted
Date: 2026-09-04
Decided by: W2-DB-02 (Persistence)
Scope: `packages/core/src/db/repositories/**`; the pattern Wave 2's six resource tracks copy

## Context

[ADR-0024](0024-wave-2-needs-a-persistence-foundation-the-plan-does-not-name.md) created this task
because six parallel tracks were about to invent six ways of reaching PostgreSQL. What they will
copy is whatever this task leaves behind, so the shape is the deliverable.

Two prior findings constrain it, and both are checkable rather than remembered.

**Wave 1 built half of spec §25's application rule and said so.**
`apps/web/server/auth/index.ts` states, in its own doc comment:

> Every query in a handler is expected to filter on the scope (spec §25) — that second half is a
> contract, not a gate, and is declared unbuilt.

Possession of a `WorkspaceScope` is compiler-checked there. Its *use in every query* was not,
because W1-CP-06 owned no query code.

**Nothing in the repository read or wrote the database.** At this task's base:

```
$ grep -rln "drizzle-orm" --include=*.ts apps packages | grep -v '^packages/core/src/db/'
(no output)
```

## Decision

The layer at `packages/core/src/db/repositories/**` has exactly seven parts, and a new resource
copies all seven.

1. **`WorkspaceScope` is a constructor argument, not a parameter.** A repository is obtained with
   `provider.forScope(scope)`, and **no method on a repository takes a workspace id**. The `where`
   clause is built inside the repository from `scope.workspaceId`. There is no call site at which
   the tenant filter can be forgotten, because there is no parameter to forget.

2. **The scope cannot be written out of request data, and that is a compile error.** It is a class
   with a `#private` field and a private constructor, frozen at construction — the shape
   `apps/web/server/auth/workspace.ts` arrived at over two verification rounds, adopted here with
   its reasoning rather than reinvented. `repositories/scope-forgery.test.ts` runs `tsc` over a
   fixture of seven deliberate forgeries and requires a diagnostic on each, by line number, plus no
   diagnostic on the legitimate derivation and none on the four declared escapes.

3. **A scope exists only because a lookup found a workspace.** `WorkspaceScopeResolver` has two
   methods, both returning `WorkspaceScope | null`, and `null` means one thing: no such row. There
   is no fallback arm anywhere that produces a scope from a value a caller supplied
   ([ADR-0015](0015-gates-decide-on-positive-assertions.md)).

4. **Failures are named outcomes, one per correction a caller can make.** `name-conflict`,
   `unknown-model-connection`, `not-found`, `duplicate-id`, `unknown-session`, `unknown-agent`,
   `not-a-member`. Each is classified from a SQLSTATE **and** a constraint name, both recognised;
   anything unrecognised is re-thrown rather than reported as a plausible client error.

5. **One contract suite runs against two implementations.** The in-memory implementations are kept,
   not deleted, and `apps/web/server/agents/store.test.ts` and `apps/web/server/runs/store.test.ts`
   each run one suite against both. Neither implementation was written by reading the other.

6. **Every `export` statement on the public barrel re-exports the repository layer.**
   `packages/core/src/db/index.ts` re-exports `./repositories/index.js` and nothing else, so
   `openDatabaseRoot()` and the scope-bound provider types are what a caller of
   `@agent-workspace/core/db` can name. `repositories/database-reachability.test.ts` parses the
   barrel and fails on an export statement naming any other module; `repositories/scope-forgery.test.ts`
   compiles a fixture against the published surface and requires a diagnostic on each attempt to
   reach PostgreSQL through it, one per line. Added in verification round 1 and tightened in round
   2 — see *Amendment* below.

   This is a rule about the barrel, not a claim about the whole program. Two ways to reach the
   layer without going through it remain open at compile time and are closed by other means: the
   declared `@agent-workspace/core/db/unscoped` subpath, and a relative path into
   `packages/core/src/db/**` or `packages/core/dist/db/**`. Both are declared gaps on the PR and
   both are refused by `database-reachability.test.ts`, which reads the tracked tree rather than
   the compiler.

7. **Every `forScope` opens with `requireWorkspaceScope`.** The two escapes the compiler admits — an
   `as WorkspaceScope` cast and `Object.create(WorkspaceScope.prototype)` — are refused at run time
   before any predicate is built. The gate that asserts it derives its provider set from
   `git ls-files` over the database layer and then from the TypeScript checker: an exported value
   whose type can be called and whose call returns something carrying a `forScope` member is a
   provider factory, whatever syntax declared it, and one that is not reachable through
   `./unscoped.js` fails the gate by name. Round 2 of verification defeated the previous
   text-matching derivation with an arrow-function factory, which is what
   [ADR-0027](0027-a-partition-that-lists-its-members-has-not-been-partitioned.md) clause 3 calls a
   filter rather than a classifier. Added in verification round 1; rewritten in round 2.

## Alternatives considered

* **Make the app-level ports (`AgentStoreProvider.forWorkspace(workspaceId: string)`) take the
  scope directly.** It is the stronger property, and it was rejected on ownership rather than on
  merit: `forWorkspace` is called from `apps/web/server/agents/http.ts`,
  `apps/web/server/compose/run-request.ts` and `apps/web/server/agents/runtime.ts`, none of which
  is in this task's globs, and the change cascades through four more test files. The compile-time
  property therefore lives at the repository boundary, and the adapter above it resolves a workspace
  id to a scope with one positive lookup. Converting the ports is named as follow-up work in
  [W2-DB-02-the-run-port-is-not-scope-bound](W2-DB-02-the-run-port-is-not-scope-bound.md).
* **Put the in-memory implementations in core, next to the Drizzle ones.** Rejected: it would mean
  a second in-memory agent store beside the one `apps/web/server/agents/memory-store.ts` already
  has, and two in-memory implementations is worse than one wherever it lives. The suite runs where
  both implementations can be reached, which is `apps/web`.
* **A generic `Repository<T>` base class.** Rejected. Every resource's outcomes are different
  because every resource's constraints are different, and a base class that unified them would push
  the differences into configuration. Six tracks copying a 200-line file they can read is cheaper
  than six tracks configuring an abstraction they cannot.

## Amendment — verification round 1

The five parts above shipped, and verification found that they secured the repository
**constructor** while leaving the repository **layer** optional. `packages/core/src/db/index.ts`
carried

```
export * from './client.js';
export * from './schema/index.js';
```

so the pooled-connection factory and every table object sat on the package's public surface beside
the scope-bound repositories. The verifier wrote a real Next.js route handler:

```
import { agents, createDatabase, createPool, readDatabaseConfig } from '@agent-workspace/core/db';
export async function GET(): Promise<Response> {
  const db = createDatabase(createPool(readDatabaseConfig(process.env)));
  return Response.json(await db.select().from(agents));   // every tenant's agents
}
```

`pnpm --filter @agent-workspace/web run typecheck` exited 0 and `eslint --max-warnings 0` exited 0.
A cross-tenant **write** — `db.delete(agents)` — compiled the same way. A gate on the constructor of
a layer nobody has to enter is not a gate ([ADR-0015](0015-gates-decide-on-positive-assertions.md)),
and six sub-wave tracks were about to copy the shape.

Verification also found that the two escapes the fixture tagged `DECLARED` were annotated "refused
at run time by `WorkspaceScope.isWorkspaceScope`" while that predicate had **no call site outside
its own unit test**; the verifier used both forgeries against PostgreSQL 17.11 to read another
workspace's rows.

Both are closed above, and the closure is shaped by what the type system can and cannot do:

* **What the type system closes.** `db.createDatabase`, `db.createPool`, `db.readDatabaseConfig`,
  `db.agents` and the queries built from them are compile errors against
  `@agent-workspace/core/db`, and a package `exports` map with no wildcard means a deep specifier
  such as `@agent-workspace/core/db/client` does not resolve. `scope-forgery.test.ts` compiles each
  one on its own line and requires a diagnostic there.
* **What it does not, and what refuses instead.** `@agent-workspace/core/db/unscoped` — the escape a
  conformance suite needs to insert the rows the repository under test reads — compiles from
  anywhere, and so does a relative path that walks out of `apps/web` into
  `packages/core/src/db/client.ts` or `packages/core/dist/db/client.js`. TypeScript has no
  visibility rule for either, and this repository's `tsconfig.json` and `eslint.config.mjs` belong
  to W0-INF-01. So the escape is *declared*, and two independent controls refuse it: the module
  throws at import in any process that has not identified itself as a test runner, and
  `repositories/database-reachability.test.ts` reads the tracked tree, hands each import specifier
  to `ts.resolveModuleName` under the compiler options of a **union** of contexts — every tracked
  TypeScript project whose `ts.createProgram` **program** contains the importing file (the program,
  not `parsed.fileNames`: it is the root names plus everything they import), the repository root
  `tsconfig.json`, and every tracked project whose configuration file sits at or above the importing
  file — compares the resolved real paths against the layer's
  directories, and asserts that
  the edges its classifier refuses are an empty list — an
  import of the escape by anything that is not a `*.test.ts` being one of the refused arms. Each
  covers the other's hole — the run-time guard cannot see a file nobody executed, the tree gate
  cannot see a file nobody committed.

The one query that genuinely cannot be scope-bound — turning a session's workspace slug and subject
into the ids a request acts under, which must run *before* a scope exists — moved from
`apps/web/instrumentation.ts` into `repositories/root.ts` as `DatabaseRoot.resolveMembership`.
Keeping it in `apps/web` would have meant keeping a raw handle in `apps/web` for the sake of three
`columns:`-projected reads, and the handle is the thing this amendment removes.

## Amendment — verification round 2

Round 1's closure was written in the form "reaching PostgreSQL outside a repository is a compile
error". Round 2 falsified that, in the places below, and the corrections are in the numbered parts
above.

* **`runSeed` was on the public barrel.** It is not a handle and it is not a table, so neither the
  compile-time fixture nor the tree gate covered it — and it takes a caller-supplied workspace
  slug, resolves that workspace with `insert … on conflict do nothing` followed by a lookup by
  slug, and inserts an `owner` membership row for a caller-supplied email into whatever tenant the
  slug already names. The verifier ran it from a Next.js route handler against PostgreSQL 17 and
  granted an arbitrary address ownership of an existing workspace. `readSeedOptions` and
  `runMigrations` sat beside it. The barrel no longer re-exports `./seed.js` or `./migrate.js` at
  all; `pnpm db:seed`, `pnpm db:migrate` and the production image's `CMD` run
  `node dist/db/seed.js` and `node dist/db/migrate.js` directly and were never reading it. Lines
  tagged `FORBIDDEN` in `scope-forgery.test.ts`'s surface fixture now hold `db.runSeed`,
  `db.readSeedOptions` and `db.runMigrations` individually, and the barrel's shape rule in part 6
  holds the general case.
* **A relative import into `packages/core/dist/db/**` reached the same functions.** The tree gate
  knew only `packages/core/src/db/`, from a literal. It now derives the layer's roots from the
  `./db` export's own conditions in `packages/core/package.json` — `types` names the source
  directory, every other condition names a build-output directory — so both halves are classified
  and neither is written down.
* **The tree gate saw only `.ts`, `.tsx`, `.mts` and `.cts`.** The tracked `.js` and `.mjs` files,
  the executed acceptance harness `apps/web/server/runs/acceptance/run-acceptance.mjs` among them,
  contributed no edges. `git ls-files` now runs with no
  pathspec and every tracked path is classified by extension into a module the gate parses or a
  file no import specifier resolves to; an extension in neither set is a hard failure naming the
  file.
* **The provider set was derived by a regular expression over module text.** A repository written
  as `export const createDatabaseXProvider = (db) => ({ forScope … })`, with no
  `requireWorkspaceScope`, was silently not checked. The derivation is now the TypeScript checker's
  — see part 7.
* **`DatabaseRoot.resolveMembership` had no test.** It has
  `packages/core/src/db/repositories/root.test.ts`.

## Amendment — verification round 3

Round 2's tree gate reasoned about import specifiers and looked only at the ones that began with a
dot. Round 3 walked past it three ways. Each was rebuilt in the worktree against the round-2 gate,
which reported 8 passed on all three, and then against the gate as it now stands, which refuses all
three.

* **A path alias reached the layer.** `apps/web/tsconfig.json` maps `"@/*"` to `"./*"`, and three
  shipped route handlers already import through it, so
  `import { createDatabase } from '@/../../packages/core/dist/db/client.js'` named the same file the
  relative spelling names — and `classify()` returned `null` for every specifier that did not begin
  with a dot. Measured on that route handler: `tsc` exited 0, `eslint --max-warnings 0` exited 0,
  `next build` exited 0 and listed `ƒ /api/vattack-alias` in its route table, and the round-2 gate
  reported 8 passed. Verification round 4 then reached the layer twice more through the same
  weakness — a `paths` block moved into an `extends` target whose extension is not `.json`, and a
  relative path through the pnpm workspace symlink `apps/web/node_modules/@agent-workspace/core` —
  so both tracked-tree gates stopped comparing specifier text altogether. Each now asks
  `ts.resolveModuleName` under the compiler options of a union of contexts — every tracked
  TypeScript project whose `ts.createProgram` program contains the importing file, the repository
  root `tsconfig.json`, and every tracked project whose configuration file sits at or above the
  importing file — and compares the resolved real paths:
  [W2-DB-02 — A module specifier is resolved, not compared as text](W2-DB-02-a-module-specifier-is-resolved-not-compared.md).
* **A dynamic import with a computed specifier was invisible.** Both gates read the argument of
  `import()` and `require()` only when it was a string literal, so
  `const layer = '…/packages/core/src/db/client'; await import(layer)` contributed no edge —
  measured on a route handler of that shape, with `tsc` exiting 0 and `eslint --max-warnings 0`
  exiting 0. A non-literal argument is now a hard failure naming the file: the specifier is a
  run-time value, and "I could not read it" is not "there is nothing there".
* **Only the first declared escape was checked for its run-time guard.** The
  `assertTestProcess`-at-module-scope check read `[...escapeSubpaths][0]`, so a second escape subpath
  re-exporting the raw handle and every table with no guard call passed. It now checks every declared
  escape.

The same two specifier holes were in `apps/web/server/runs/store.test.ts`, whose "nothing a
deployment loads constructs `InMemoryRunStore`" block resolved a specifier only when it began with a
dot and read a dynamic import's argument only when it was a string literal. A module importing
`InMemoryRunStore` as `@/server/runs/store`, and a module awaiting a dynamic import of a `const`
holding `'./store'`, each left that block at 3 passed with `tsc` exiting 0; both are refused now. It
is fixed the same way, with its own copy of the alias derivation — the two gates live in different
packages, and giving them a shared helper would mean a new export subpath on
`packages/core/package.json`, which is a second door into the layer the first gate would then have
to classify.

## Consequences

* A Wave 2 resource author copies `agents.ts`, replaces the table and the constraint names, and
  gets the tenant property for free. The thing they must not copy is `findRunWorkspace`, which says
  so in its own doc comment.
* `packages/core/src/db/repositories/testing.ts` ships with the layer: a suite calls
  `createIsolatedTestDatabase(name)` and gets a private, migrated database, because
  `packages/core/src/db/seed.test.ts` truncates the one `TEST_DATABASE_URL` names and Vitest runs
  files in parallel workers. Since the amendment it is reached through
  `@agent-workspace/core/db/unscoped`, not through the public barrel, and only from a `*.test.ts`.
* A composition root calls `openDatabaseRoot(process.env)` and gets providers, never a handle. The
  `select 1` connectivity probe moved inside it, so "the seam is installed because a query
  succeeded" is a property of the entry point rather than of each caller remembering to probe.
* The scope carries the tenant and nothing else — no actor, no role. Authorisation is W2-CP-06's,
  and a repository that took a role would be deciding authorisation in the same place it builds a
  `where` clause.
