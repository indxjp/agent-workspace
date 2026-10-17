# ADR-W9-SEC-116 — `/api/metrics` is scoped by the verified principal, not the caller

Status: accepted
Date: 2026-09-11
Decided by: W9-SEC-116 (implementing agent)
Scope: `apps/web/app/api/metrics/route.ts`, `apps/web/server/telemetry/runtime.ts`

## Context

Issue #116 (P0): `GET /api/metrics` checked only `getSession() !== null` and then returned
`recentRunTelemetry()` unfiltered — every run any workspace's session had produced, to any
authenticated caller in any workspace. The Wave 9 plan's W9-SEC-116 card names the fix as
routing the route through the same `authorise`/`decide()` gate every other `/api/` route uses, and
records that `metrics` is already a classified `RESOURCES` entry with a `READ_ONLY` grant
(`read: 'any'`) for all four roles, so no edit to `apps/web/server/rbac/permissions.ts` is needed.
`docs/adr/W9-PLAN-metrics-is-operational-not-product.md` (the wave planner's ADR) already settled
the larger question the issue raised — that `/api/metrics` stays as an operational endpoint and is
not replaced by `#135`'s durable `GET /api/runs` — so this record covers only the two choices that
ADR leaves to the implementation.

## Decision

1. **`recentRunTelemetry` takes `workspaceId: string` as a required parameter**, not an optional
   one and not a second function. The card's own wording — "Filter `recentRunTelemetry()` by
   `principal.workspaceId` inside the projection" — is a change to that one function's signature,
   and a required parameter is the minimal shape that makes the pre-fix call shape (no argument,
   every workspace) a compile error rather than a still-reachable default. The route passes
   `principal.workspaceId`, the value `authorise` verified from the caller's session or API key,
   and reads no workspace identifier from the request itself.

2. **Authorisation goes through `apps/web/server/rbac/http.ts`'s `authorise()`**, the same call
   every Wave 2+ `/api/` route (`agents`, `api-keys`, `memberships`, `users`, …) makes, with
   `ownership: 'not-applicable'` — `GET /api/metrics` is a collection with no single row, the same
   shape as `GET /api/api-keys`. This is "the same principal/RBAC entry the durable run routes
   use" the card names: it is the entry point whose gate literally calls `decide()`, which is what
   the card's next clause ("authorise the existing `metrics` resource through `decide()`") names
   directly. It is a different, older seam from `apps/web/server/runs/environment.ts`'s
   `RunApiEnvironment.authenticate`/`ownsRun`, which is a Wave-1 interface predating the RBAC
   runtime and is about per-run ownership on `/api/runs/:id`, not about a workspace-wide
   projection — there is no per-run ownership question here, only a workspace boundary.

## Alternatives considered

- **Add a new `recentRunTelemetryForWorkspace` function and leave `recentRunTelemetry()` as the
  unfiltered read.** Rejected: it keeps the vulnerable call shape reachable and compiling, which is
  exactly the shape of bug this task exists to close. One function, one required parameter, is
  simpler and leaves nothing for a later caller to reach for by mistake.
- **Filter in the route handler instead of inside `recentRunTelemetry`.** Rejected: the card is
  explicit that the filter belongs "inside the projection", and a filter inside the exported
  function is the one a future caller cannot bypass by calling the function directly, unlike a
  filter that lives only in this one route's handler body.
- **Wire through `runs/environment.ts`'s `Principal`/`RunApiEnvironment`.** Rejected per point 2
  above: it is unconfigured on `main` today (its composition root is W2-DB-02's, not wired), is
  scoped to run-record ownership rather than workspace-wide reads, and is not what the card's
  `decide()` reference names.

## Consequences

- `apps/web/app/api/metrics/route.ts` and its new colocated test import
  `apps/web/server/rbac/http.ts`, `.../principal.ts`, `.../roles.ts`, `.../runtime.ts` and
  `.../memory-directory.ts` by **relative path**, not the `@/*` alias every sibling route file
  under `apps/web/app/api/**` uses. This is a deliberate, narrow deviation: `apps/web/app` has no
  Vitest alias configuration (only `tsconfig.json`'s `paths`, which Next.js's own bundler reads and
  Vitest does not), so a route file that imports `@/server/...` has never before been imported by a
  Vitest test in this repository — every sibling that uses the alias has no colocated test. Adding
  the first colocated route test under `apps/web/app/api/**` surfaced this; fixing it here (rather
  than adding a Vitest alias plugin, which would touch `apps/web/vitest.config.mjs` — outside this
  task's `Owns globs`) is the minimal, in-bounds change. `pnpm -r build` (Next.js) and
  `pnpm -w typecheck` both still pass with the relative form, so nothing about the production path
  changes.
- `recentRunTelemetry`'s one existing caller (`apps/web/app/api/metrics/route.ts`) and its existing
  test (`apps/web/server/telemetry/runtime.test.ts`) both needed a one-line update to pass a
  workspace id; both are inside this task's `Owns globs`.
- The new colocated route test is named `apps/web/app/api/metrics/metrics.test.ts`, not
  `route.test.ts`. `tests/route-inventory.test.ts`'s `classifyAppFile` treats any file under
  `apps/web/app/**` named `route.<anything>` as a claim that Next.js serves it as a route handler,
  and throws when `<anything>` is not one of `next.config.ts`'s `pageExtensions` — which
  `route.test.ts` is not. This is why no other route under `apps/web/app/api/**` had a colocated
  `*.test.ts` before this task: the naming gate forbids the obvious name. `metrics.test.ts` is
  outside that gate's `route.` prefix and inside this task's `Owns globs`.
