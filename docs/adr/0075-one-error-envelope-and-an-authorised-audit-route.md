# ADR-0075 — One `{ code, message }` error envelope, and `GET /api/audit-events` through `authorise`

Status: accepted
Date: 2026-09-29
Decided by: the implementer of SDK migration unit 6 (issue #238), on the plan the issue's
`indx-dev:plan` comment fixed (plan v2)
Scope: `packages/contracts/src/problem.ts`; `packages/sdk/src/http.ts`;
`apps/web/server/rbac/http.ts`; `apps/web/server/resources/item-ownership.ts`;
`apps/web/app/api/auth/workspace/route.ts`; `apps/web/app/api/audit-events/route.ts`;
`apps/web/server/audit/api.ts`, `apps/web/server/audit/runtime.ts`;
`apps/web/server/composition/register.ts`; `formal/AgentWorkspace/Contracts/Problem.lean`; spec
`docs/sdk/04-api-specification.md` §8 rows S-16 and S-17

## Context

The SDK spec (04 §8) listed the server changes the typed client needs. Two of them are decided
together here because they change the same three-armed reader in the SDK.

- **S-16.** The RBAC layer — the team routes, and every `401`, `403`, `500
authorisation_undecidable` and `503 rbac_runtime_not_configured` refused before a domain handler
  runs — rendered `{ error: { code, detail } }`, where every other route rendered `{ error: { code,
message, details? } }`. A client had to accept two spellings for the same field.
- **S-17.** `GET /api/audit-events` was the one route that did not go through `authorise`. It
  authenticated on its own, answered the bare-code `{ error: '<code>' }` envelope, and so was
  outside the RBAC decision table and the RBAC conformance harness.

## Decision

### D1 — One envelope, with `detail` kept for one release

`problem()` in `apps/web/server/rbac/http.ts` renders `{ error: { code, message, detail } }`, with
`detail` always equal to `message`. `ApiProblemSchema` declares `detail` as an optional,
`@deprecated` string; it must be declared because the schema is `.strict()`.

The browser readers of `detail` did not all keep working. The agents model
(`apps/web/components/agents/model.ts`) reads `message` or `detail` without checking the key set,
so it needed no change. The workspace directory (`apps/web/components/shell/workspaces-directory.ts`)
accepts only an exact key set. It refused `{ code, message, detail }`, so every `/api/workspaces`
refusal read as a transport failure and a `401` no longer triggered session recovery. That reader now
accepts exactly `{ code, message, detail }` (preferring `message`) or exactly the earlier
`{ code, detail }`, and its tests build the body with `problem()` itself. Both readers drop `detail`
when it is removed.

`POST /api/auth/workspace` has its own producer (`jsonProblem`) and follows the same rule.
`resolverForRow`'s `403 machine_ownership_unsupported` was a second hand-written `{ code, detail }`
producer that the plan missed; it now goes through `problem()`, so no production file outside
`problem()` and `jsonProblem` renders the old shape.

`ApiProblemDetailSchema` and `ApiProblemBareCodeSchema` stay published, and the SDK's `readProblem`
keeps all three arms: a client built from this release must still read the `code` of an older
deployment.

### D2 — The audit route is an ordinary authorised route

`GET /api/audit-events` calls `authorise(request, 'not-applicable', …)` and renders through
`toResponse`. The route file is a thin adapter; the behaviour is `listAuditEvents` in
`apps/web/server/audit/api.ts`, testable with the RBAC harness.

- `401 unauthenticated` and `503 rbac_runtime_not_configured` come from the gate.
- Only an Owner is allowed. `audit-events` has no role override in `permissions.ts`, so the
  `EVERYTHING` fallback allows Owner and `NOTHING` denies the other roles. This equals the formal
  Lean model and does not change `permissions.ts`. Denial is `403 forbidden`.
- `503 audit_runtime_not_configured` when the audit repositories are not wired, and `400
invalid_limit` for a `limit` that is not an integer in `[1, AUDIT_LIST_MAX_LIMIT]`, are in the
  standard envelope.
- The response body is unchanged: `{ events }`, newest first, at most `limit` rows, default
  `AUDIT_LIST_DEFAULT_LIMIT`.

The audit runtime now holds a `WorkspaceScopeResolver` so the handler resolves the caller's scope
from the principal's workspace id rather than authenticating a second time.

## Consequences

- One reader of an error body is enough for every `/api/**` route this unit touched. The remaining
  routes that do not answer the standard envelope are counted in the route inventory and are the
  follow-up sweep below.
- Every response body from the RBAC layer grew by one duplicated string for one release.
- A deployment older than this release still answers the two older shapes, which is why the SDK
  keeps three arms.
- No route was added and no route's path or method changed, and `permissions.ts` is untouched, so
  the Lean decision table and `every_matrix_route_is_decided` are unchanged.
- The Lean model of the envelope follows the contract: `ApiProblemBody` in
  `formal/AgentWorkspace/Contracts/Problem.lean` gains the optional `detail`, and the theorems that
  name the standard inner key set (`api_problem_refuses_unknown_inner_key`,
  `additive_inner_field_loses_the_code`, `accepted_standard_envelope_has_no_extra_key`) now list
  `detail` in it. `envelopes_are_pairwise_disjoint` keeps its statement; its proof now rests on the
  standard envelope requiring `message`, which the older `{ code, detail }` envelope refuses. The
  generated catalogue and the problem-envelope vectors are regenerated.

## Follow-ups (not part of this unit)

- **SDK-06b** — S-5, cursor pagination (`cursor` / `nextCursor`) of the sessions and audit lists.
- **SDK-06c** — the route-inventory sweep for the routes that still answer another envelope.
- Removal of `detail` from the server and from `ApiProblemSchema`, in the release after this one,
  together with the browser readers.
- AD-1 alignment: whether Admin should hold `READ_ONLY` on the audit trail. This unit keeps the
  current, Lean-modelled Owner-only rule.

## Alternatives considered

- **Rename `detail` to `message` with no duplicate.** Rejected: a browser bundle and an SDK built
  against the previous release read `detail`, and the two are not deployed in lock-step.
- **Widen `permissions.ts` to let Admin read the audit trail.** Rejected here: it changes the
  Lean-modelled decision table and belongs to the AD-1 alignment follow-up.
- **Leave the audit route outside `authorise`.** Rejected: it is the one route the decision table
  and the conformance harness could not cover.
