# W1-CP-05 — The agent API talks to a port, because `apps/web` may not depend on `@agent-workspace/core`

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-05 (Control Plane)
Scope: `apps/web/server/agents/**`, `apps/web/app/api/agents/route.ts`,
`apps/web/app/api/agents/[id]/route.ts`; binding on whoever wires the Postgres adapter

## Context

W1-CP-05 implements the five agent routes of spec §34 against the `agents` table W1-DB-01 landed.
The obvious implementation imports `agents`, `Database` and `AgentPermissions` from
`@agent-workspace/core/db` and issues Drizzle queries from the route layer.

That import cannot be made. `apps/web/package.json` lists `next`, `react` and `react-dom` and
nothing else, and pnpm's isolated `node_modules` layout means `@agent-workspace/core`,
`drizzle-orm`, `zod` and `pg` are all unresolvable from `apps/web` — at type-check time and at
run time. Adding the workspace link requires editing `apps/web/package.json` and `pnpm-lock.yaml`.

Both files are outside this task's `Owns` globs, and this is not a technicality:

* [ADR-0009](0009-pnpm-lock-ownership-exception.md) gives `pnpm-lock.yaml` to the **first** task in
  a wave and rules that "a later task in the same wave that discovers it needs a new dependency
  **escalates**; it does not edit the lockfile in parallel". W1-CP-05 is at the wave's third stack
  level, alongside three siblings.
* The CI file-ownership gate reads the `Owns globs:` line out of the PR body and fails the build
  listing every changed file outside it. Editing either file turns this task's own acceptance
  criterion — CI green — red, whatever its merits.

So the choice was not "import core, or do something clever". It was "produce a route layer that
does not need core, or land nothing".

## Decision

**`apps/web/server/agents/**` has no dependency outside the Next.js runtime.** It defines its own
port and its own validators, in plain TypeScript.

1. **`store.ts` is the port.** `WorkspaceAgentStore` has `list`, `get`, `create`, `update` and
   `delete`, and **no method takes a workspace id**. A store is obtained through
   `AgentStoreProvider.forWorkspace(workspaceId)`. Row-level workspace scoping is therefore
   structural: there is no parameter to forget. That rule is this repository's extension of spec
   §25's intent to the control plane, not a sentence of §25 — §25 governs runtime `cwd`,
   `CLAUDE_CONFIG_DIR`, workspace files, skills and configuration, and states nothing about
   database queries. The reading is set out in the header of `apps/web/server/agents/store.ts`.
2. **`runtime.ts` is the seam.** One module-global holds an `AgentsRuntime`, which supplies the
   store provider and the workspace resolver. Nothing wires it in this task, so it is `null`, and
   every route answers `503 agents_runtime_not_configured`. Whoever lands the Postgres adapter and
   W1-CP-06's session cookie calls `configureAgentsRuntime` once at start-up.
3. **`contract.ts` validates by hand**, rather than with Zod. Spec §40 makes this the rule rather
   than the exception — "if it is ~50 lines of clear TypeScript, write it", with cryptography, JWT,
   OAuth, database clients and container protocols reserved for libraries. A field validator is
   none of those.
4. **`memory-store.ts` is the reference implementation**, and `store.test.ts` is a *conformance
   suite* exported as `describeAgentStoreConformance`, not a set of tests about a Map. The
   Postgres adapter is expected to be run through the same suite, unchanged.
5. **The dependency itself is escalated, not smuggled.** The `Declared gaps` section of this task's
   PR states that `apps/web` needs `"@agent-workspace/core": "workspace:*"` before any of this can
   reach a database, and that this task did not add it.

## Alternatives considered

* **Add the dependency anyway and declare it in the Ownership section**, the way W0-INF-01 declared
  the lockfile. Rejected: ADR-0009 ratified that specifically for the *first* task in a wave and
  explicitly requires a later task to escalate instead. The precedent it set is the opposite of the
  one that would be needed here.
* **Import `packages/core/src/**` by relative path**, the way `tests/sdk-surface.test.ts` reaches
  into it. Rejected on facts, not taste: the schema module imports `drizzle-orm` and `zod`, and
  `client.ts` imports `pg`; none of the three resolves from `apps/web`, so the file would not
  type-check. `tests/` gets away with it because it reads `types.ts`, which imports nothing.
* **Escalate the whole task and land nothing.** Rejected: four of the five routes' behaviour —
  validation, status codes, conflict mapping, tenant scoping — is independent of which store backs
  them, and it is all tested here. Landing it now means the adapter is a single file against a
  suite that already exists.
* **A service locator with lazy `await import()` of core.** Rejected: it launders an unresolvable
  dependency past the type-checker into a runtime failure, which is worse than a compile error and
  is the kind of "it looked green" this programme keeps paying for.
* **Duplicate the Drizzle schema inside `apps/web`.** Rejected outright: two definitions of one
  table is the failure the §27 "keep the schema understandable" rule exists to prevent.

## Consequences

* **The API cannot serve a request until something wires it.** That is visible, not silent: every
  route returns `503` with the code `agents_runtime_not_configured` and a message saying the
  deployment has no store, rather than `401`, and rather than a `200` with an empty list. ADR-0015's
  rule is that a check which cannot run fails; a store that cannot be reached is the same shape.
* **The permission list is duplicated** between `contract.ts` and
  `packages/core/src/db/schema/agents.ts`. `contract.test.ts` pins it to the schema file's *text*,
  so adding a fifth permission to the table fails this task's tests rather than silently dropping
  the permission on the wire. That is a weaker link than an import and it is the strongest one
  available across the boundary.
* **Two validation layers will exist** once `apps/web` may import core: the hand-written one here
  and the Zod one in `schemas.ts`. Whoever adds the dependency should delete this one and re-point
  `handlers.ts` at `AgentConfig`, keeping the conformance suite. The rules were transcribed from
  the table precisely so that swap is mechanical.
* **Reversing this is cheap and was designed to be.** The port stays; only `memory-store.ts` is
  replaced. Nothing in `handlers.ts`, `http.ts` or either route file knows what backs the store.
