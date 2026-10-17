# W3-CP-06 — `runtime_profiles`, `agents.runtime_profile_id`, and the exact composition-root call the integrator makes

Status: accepted
Date: 2026-09-06
Decided by: W3-CP-06 (runtime profiles CRUD and network-policy data)
Scope: `packages/core/src/db/schema/runtime-profiles.ts`, `packages/core/src/db/schema/agents.ts`,
`packages/core/src/schemas.ts`; binding on the integrator that wires `apps/web/instrumentation.ts`

## Context

Spec §27 lists `runtime_profiles` and no earlier wave claims it. The Wave 3 plan's 3a-2
cell gives this task the table, its repository, the `agents.runtime_profile_id` column §14.9's
reversibility rule requires, and the `AgentConfig` field that column backs. This record states the
three decisions that table and column make, and — separately — names the exact call the
integrator (not this task) must add to `apps/web/instrumentation.ts` to make any of it reachable
from a real deployment.

## Decision — the schema

1. **`runtime_profiles.runtime_connection_id` references `secrets.id`, not a `runtime_connections`
   table.** This task's `Owns` cell grants `apps/web/app/api/runtime-connections/**` but no new
   table, and §14.9 states the resource's whole contract in one line: *"A runtime connection
   exists — endpoint + credentials, stored as a secret."* See
   `docs/adr/W3-CP-06-runtime-connections-are-secrets.md` for the full design; here it is only the
   database consequence — a nullable, tenant-paired, `SET NULL`-on-delete foreign key to `secrets`,
   the same shape `agents.model_connection_id` already uses for the same reason.
2. **`agents.runtime_profile_id` is a reference, `SET NULL` on delete, tenant-paired exactly like
   `model_connection_id`.** §14.9: *"Runtime selection therefore stores a profile reference, never
   a copy of the profile."* Deleting a profile must leave an agent that named it in a visible,
   recoverable state — no profile selected, driver defaults apply — never cascade into deleting the
   agent, and never block the delete on "still referenced".
3. **`AgentConfig.runtimeProfileId` is `.optional()`, not required-and-nullable like `model`.**
   `packages/core/src/config.test.ts`'s `canonicalAgent` fixture is a sibling task's file, not this
   one's, and restates `AgentConfig`'s shape without this field. Widening the field as required
   (even nullable) would fail that fixture the moment this file compiles, which is exactly the
   collateral damage rule 6 of the wave protocol exists to prevent. An absent key and an explicit
   `null` mean the same thing §15.1 already gives an unset profile: the driver's own defaults
   apply. `packages/core/src/schemas.test.ts`'s own new test proves parsing all three forms.

The sentence `AgentConfig` used to carry — *"Step 3's files and Step 5's runtime profile are absent
because `agent_files` and `runtime_profiles` are Wave 2 tables"* — is amended in the same commit
that adds the field, per this task's own Accept line: Step 3 (files) is still absent (that table is
still unbuilt); Step 5 is not.

## Decision — the integrator's call

`apps/web/instrumentation.ts` is not in this task's `Owns` cell (ADR-0038: the composition root
belongs to the integration level). `apps/web/server/runtimes/runtime.ts` ships
`configureRuntimesRuntime`, symmetrical with every other Wave 1/2 seam
(`configureAgentsRuntime`, `configureSecretsRuntime`, …), and the exact call that installs it:

```ts
const root = await openDatabaseRoot(env); // already called for the other seams
configureRuntimesRuntime({
  resolveWorkspace: /* the same resolver every other seam uses */,
  profiles: createRepositoryRuntimeProfileStoreProvider({
    repositories: root.runtimeProfiles,
    scopes: root.scopes,
  }),
  connections: createSecretsRuntimeConnectionStoreProvider({
    secrets: secretsService, // the same SecretsService secrets/runtime.ts's own call builds
    scopes: root.scopes,
  }),
});
```

**This call replaces round 1's**, which did not compile and, in its only writable variant, threw
`ForgedWorkspaceScopeError` at the first request (W3-CP-06-B1, round 2). Round 1's
`SecretsRuntimeConnectionStoreDependencies<TScope>` took an unconstrained `scopeFor(workspaceId):
TScope` called eagerly and synchronously; the only real source of a `WorkspaceScope` is a
`WorkspaceScopeResolver`, which is async because it does a lookup, so no synchronous expression
could ever supply one. `connections.ts` now takes `scopes: WorkspaceScopeResolver` and resolves it
inside a memoised `async` closure — exactly `store.ts`'s `createRepositoryRuntimeProfileStoreProvider`
above, and `apps/web/server/secrets/store.ts`'s `createRepositorySecretsStoreProvider` — and the
port's `scope` parameter is `WorkspaceScope`, not `unknown`, so a wiring this shape cannot be built
against a scope the resolver never minted. Watched: `pnpm exec tsc -p apps/web/tsconfig.json
--noEmit` on a probe file containing the block above, clean; then the same wiring driven end to end
(POST then GET) against a real, encrypting `SecretsService` and a real `WorkspaceScopeResolver`,
both calls succeeding and the GET returning the row the POST created — see `connections.test.ts`'s
"W3-CP-06-B1" suite, which drives this exact shape rather than a hand-rolled fake port, and this
task's PR report for the additional run against a real PostgreSQL 17.11.

`root.runtimeProfiles` and `root.scopes` come from `DatabaseRoot`
(`packages/core/src/db/repositories/root.ts`), which this task extended with one additive field —
**outside this task's `Owns` cell, declared on its PR** — because `apps/web` has no other sanctioned
way to reach a scope-bound `RuntimeProfileRepositoryProvider`: `@agent-workspace/core/db` deliberately
hands out no raw `Database` handle (`db/index.ts`'s own header explains why), so the one column that
was missing on the shared root — `runtimeProfiles` — is what this task added, mirroring `agents`,
`runs` and `sessions` on the same interface. `packages/core/src/db/index.ts`'s curated re-export
list gained the matching type names for the same reason.

Until `apps/web/instrumentation.ts` makes this call, every `/api/runtime-profiles/**` and
`/api/runtime-connections/**` route answers `503 runtimes_runtime_not_configured` — the same
honest, by-name 503 every other unconfigured seam in this repository answers (ADR-0015), asserted
by name in `tests/no-route-answers-503.test.ts`, which this task extended (also outside its `Owns`
cell, also declared) to include these seven routes in the declared, recorded gap alongside
W2-CP-06's nine.

## Consequences

* A real deployment's runtime-profile and runtime-connection routes do not work until the
  integrator makes the call above. That is a declared gap on this task's PR, not a claim.
* `packages/core/src/db/repositories/unscoped.ts` gained one re-export
  (`createDatabaseRuntimeProfileRepositoryProvider`) so that `scope-forgery.test.ts` — which derives
  every `forScope`-shaped factory `repositories/index.ts` exports and requires each to be reachable
  from the declared escape hatch — does not fail on a repository this task added. Also outside this
  task's `Owns` cell, also declared.
* `packages/core/src/db/seed.test.ts`'s literal `agents` column list gained one line
  (`runtime_profile_id`) for the same reason: it is a hard-coded shape assertion in a sibling
  task's file that this task's column addition necessarily changes. Also declared.
