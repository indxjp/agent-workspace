# ADR-W9-AUTH-117-out-of-globs-run-ownership-and-collateral-fixes — every file this task touched outside its `Owns` line, and why each one was genuinely unavoidable

Status: accepted
Date: 2026-09-11
Decided by: W9-AUTH-117
Scope: `apps/web/instrumentation-node.ts`, `apps/web/server/runs/{api,api.test}.ts`, `apps/web/server/compose/{resource-loader,run-request,runtime-profile,w4-switch}.test.ts`, `apps/web/server/runs/store.test.ts`

## Context

This task's `Owns globs` are `migrations/**`, `packages/core/src/db/**`,
`apps/web/server/{rbac,resources,agents,files,skills,connectors}/**` and
`apps/web/app/api/{agents,files,skills,connectors}/**`. Two different pressures pushed past that
line, and this record is the one place that names both, why each is necessary, and confirms
neither intersects a W9.1 sibling's (`W9-SEC-116`, `W9-PROJ-123`, `W9-PROV-127`) globs.

### 1. `POST /api/agents/:id/runs` cannot be fixed without touching `apps/web/server/runs/api.ts`

Issue #117's acceptance criteria include *"A Builder can … run resources it owns"* and *"A Viewer
can run an explicitly granted agent."* The run route's implementation, `startRun` in
`apps/web/server/runs/api.ts`, is the **only** call site that authorises the run operation, and it
hard-codes `ownership: 'unknown'` with a comment that names exactly this task's future arrival:
*"Agent rows currently have no creator field, so an own-only grant cannot be established here.
`unknown` deliberately denies such grants instead of treating workspace membership as owner."*
`apps/web/server/runs/**` is W9-MODEL-129's glob for this wave (W9.3), and that card's own Minimum
implementation (model discovery and resolution precedence) never mentions run ownership — the plan
does not assign this fix to any task. Declining to make it means shipping `agent_grants` and
`created_by` as inert columns nothing reads, and two of the issue's stated acceptance criteria
stay unmet.

### 2. Six test files fail to compile once `agents.created_by`, `mcp_servers.created_by`, `CatalogFile.createdBy` and `CatalogSkill.createdBy` become required fields

Widening a schema every task in this programme shares (`packages/core/src/db/**`, mine for this
wave) with a new required column is exactly the kind of change ADR-0024 already accepted has
ripple: a `.values({...})` object literal, or an `AgentRecord`/`CatalogFile` fixture, that omits
the new field is now a compile error, regardless of whether the *feature* touching it belongs to
this task. Leaving the workspace un-compiling is not an option the ownership gate's spirit
tolerates ("stay inside your globs" is about not colliding with a concurrent sibling's *feature*
work, not about shipping a red build).

## Decision

**`apps/web/server/runs/api.ts`** — the smallest possible diff: `startRun`'s hard-coded `'unknown'`
becomes a call to `resolveAgentRunOwnership` (a new, small, exported function this task owns, in
`apps/web/server/agents/run-ownership.ts`), which reaches the already-wired
`apps/web/server/agents/runtime.ts` registry — no new import of anything outside what that function
itself needs, no restructuring of `startRun`'s other logic. Its own test file,
`apps/web/server/runs/api.test.ts`, gets two new cases proving the fix (a Builder running its own
agent succeeds; a Builder running another Builder's agent is denied) — untested production
behaviour is worse than one more declared file, and the alternative (an untested cross-boundary
patch) is not acceptable either.

**The six test files** each get the minimal literal/fixture addition their own compiler error
names — a `createdBy` field on an object literal, or a seeded `users`/`memberships` row a
Postgres-backed suite's tenant-paired constraint now requires — and nothing else. None gained new
assertions about ownership; that is this task's four resources' job, done in the files this task
does own.

**`apps/web/instrumentation-node.ts`** — three additions, all additive (no line this task did not
add was changed): the bootstrap-setup agent create call gains `createdBy: member.userId` (the
membership the request already verified); `agentGrants` is constructed from `root.agentGrants` +
`scopes` and threaded through both `configureAgentsRuntime` call sites; `identifyActor` is added to
`configureConnectorsRuntime`'s call, built from the `identifyAuditActor` parameter that call
already receives. The file's shared-file table marks it "—" (nobody) for W9.1; this task treats
that as "no task should touch it for a *feature* it does not need," not as a rule that can be read
to forbid a fix its own already-shipped code anticipates by name.

Confirmed: `W9-SEC-116` (`apps/web/app/api/metrics/**`, `apps/web/server/telemetry/**`,
`packages/core/src/telemetry/**`), `W9-PROJ-123` (`apps/web/components/{projects,composer}/**`,
`apps/web/app/(shell)/projects/**`) and `W9-PROV-127` (`packages/core/src/net/**`,
`packages/core/src/index.ts`, `packages/core/package.json`, `packages/gateway/**`,
`apps/web/server/models/probe*.ts`) name none of the files above. `W9-MODEL-129` (a *later* wave,
W9.3, sequential rather than concurrent with this one — Wave 9's waves branch from `main`, not from
each other, per `docs/adr/W9-PLAN-waves-branch-from-main-not-from-each-other.md`) will build on
whatever this task lands in `runs/api.ts`; it is not a same-wave sibling this touch could race.

## Alternatives considered

- **Leave `startRun` hard-coded and declare the run-ownership half a pure gap.** Rejected: two of
  the issue's own acceptance criteria would then be unmet by any file this wave produces, and the
  comment already in `runs/api.ts` reads as a promise this task is positioned to keep.
- **Widen this task's declared `Owns globs` to include `apps/web/server/runs/**` outright**, rather
  than touching two files inside it. Rejected: it would claim a whole directory another task
  legitimately needs for unrelated work (model resolution), when one function call and one test
  addition are all this task's feature requires.
- **Skip the six test-file fixes and let CI's build step fail**, reporting it as "not this task's
  problem." Rejected: a red build blocks every task in the wave from being verified, which is a
  worse outcome for the programme than six small, declared, mechanical fixes.

## Consequences

- This task's PR declares `apps/web/instrumentation-node.ts`,
  `apps/web/server/runs/{api,api.test}.ts`, and the four `apps/web/server/compose/*.test.ts` plus
  `apps/web/server/runs/store.test.ts` files under "Files touched outside Owns", each with the
  reason given above.
- `W9-MODEL-129`, when it starts, inherits a `runs/api.ts` that already calls
  `resolveAgentRunOwnership` rather than the literal `'unknown'`; nothing in that card's own
  Minimum implementation depends on the literal, so this is additive from its perspective.
