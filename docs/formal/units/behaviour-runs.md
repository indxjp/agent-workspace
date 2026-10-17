# B-behaviour-runs

## Scope

`AgentWorkspace.Behaviour.Runs` models the seven run route rows R-1 through R-7 as an ordered
transition from a principal, a request, and a workspace-filtered run projection to a reply and
post-state. R-4 and R-5 deliberately share one revocation branch. The model reuses
`Authz.Decide` for the ordinary routes, the reduced revoke predicate that the dedicated
decision proves equivalent on both route shapes, and `Lifecycle.Run.interruptActions` for the interrupt effect. The request
records the results of HTTP parsing and adapter lookups at each boundary, so simultaneous faults
can demonstrate which problem code wins. `State.er` computes the current ER state from the
surrounding tables plus the modeled run rows; the two views therefore share one run projection.

The generated `routes.json` cases are replayed through the real `startRun`, `listRuns`, `readRun`,
`revokeRunTokens`, `streamRunEvents`, and `interruptRun` functions with `installRunApi` and
`InMemoryRunStore`. They check status and problem code, response envelopes, list owner filtering,
revocation outcomes, queued creation, and interrupt cancellation. The test fixture copies the
environment seam used by `apps/web/server/runs/api.test.ts` and resets the registry after each
case. It also calls App Router exports to verify that thrown failures become safe
`500 internal_error` responses. The stream test checks all three SSE headers, and a two-page
list test round-trips the real opaque cursor without duplication.

After [PR #293](https://github.com/indxjp/agent-workspace/pull/293), the start branch
checks malformed agent IDs after authentication and before role permission. `start_problem_codes`
and the regenerated route vectors pin the documented `400 invalid_agent_id` for every role.

## Claims and divergences

- T1: `Normative.BehaviourRuns` states the success branch for each route family and direct
  witnesses for each validation stage, including the list query's parser order, cross-workspace
  404 concealment, terminal interrupt conflict, revocation outcomes, and interrupt post-state.
- T2: `Invariants.BehaviourRuns.every_route_preserves_foreign` covers all seven raw handler
  branches. `start_preserves_foreign` and `interrupt_preserves_foreign` prove the two write
  effects directly; `start_records_owner_and_session` pins the created row attribution.
  `er_run_projection` links modeled run rows to Er/Current. A separate commit theorem states
  current-schema consistency at the repository write boundary.
- T2: response envelope keys exclude token secrets and token hashes. The real replay also checks
  response content and persisted post-state.
- T4: `Refinement.BehaviourRuns.empty_model_request_agrees` records that the server parser and
  `StartRunRequestSchema` both reject a paired empty model after PR #285 (suspicious point 7).
- T4: `Refinement.BehaviourRuns.admin_revoke_handler_and_decide_agree` records that the handler
  and the dedicated decision both allow Admin token revocation after PR #294 (point 10).

## Boundaries

The model takes parsing and adapter outcomes as explicit request facts. The existing
`Contracts.Runs`, `Behaviour.RunCompose`, `Authz` and `Events` layers own their internal parser,
scope, and stream framing details. A `500 internal_error` represents an exception mapped by the
HTTP boundary; a throw inside the direct handler is not an HTTP response until that boundary
handles it. Stream failures after status 200 are in-band events and belong to EventsSse.

The ER commit theorem is conditional on a consistent pre-state and describes the PostgreSQL
constraint/rollback boundary. It is not a theorem that the in-memory handler step itself checks
every ER constraint. The model does not add a post-handler consistency scan or a foreign-row
refusal absent from `api.ts`; the noninterference theorem proves the actual start/interrupt
updates instead. The shared ER fixture can contain rows that the in-memory harness does not
materialize, so the vector replay compares the handler-visible run projection and its post-state.

The in-memory harness cannot replay PostgreSQL transaction order for all-token revocation or
the repository stream tail race. Those paths remain represented by lifecycle and events units and
need their own service-backed differential tests. `startRun` ownership resolution uses the
separate agent runtime registry, so the run route vectors exercise Owner's `any` grant and the
Viewer denial; detailed Builder agent ownership belongs to AuthzTenancy and RunCompose.
The browser-token proxy's pre-handler 401 edge is tested by AuthzTenancy; these vectors start at
the run handler after authentication.

## Coverage

| Checklist | Evidence |
| --- | --- |
| R-1 | `start_accepted`, `start_problem_codes`, `scoped_problem_codes`, `start_records_owner_and_session`; `start-*` vectors |
| R-2 | `list_forces_owner`, `list_problem_codes`; `list-*` vectors |
| R-3 | `read_foreign_is_not_found`, `read_problem_codes`; `read-*` vectors |
| R-4 | `revoke_alias_agrees`; full `revoke-alias-*` problem matrix |
| R-5 | `admin_revoke_allowed`, `revoke_problem_codes`, `revoke_outcomes`; `revoke-*` vectors |
| R-6 | `stream_cursor_precedes_lookup`, `stream_problem_codes`; `stream-*` vectors |
| R-7 | `terminal_interrupt_conflicts`, `interrupt_problem_codes`, `interrupt_success_poststate`; `interrupt-*` vectors |
| Point 7 | `empty_model_request_agrees` |
| Point 10 | `admin_revoke_handler_and_decide_agree` |

## Verification

The route model, Normative/Refinement/Invariants modules and vectors built in the narrow Lake
slot. The generated matrix has 93 vectors, and all 97 focused real-handler tests pass. These
include successful start and interrupt with a foreign row, direct foreign-row equality after the
handler call, authenticated owner and resolved session on creation, and persisted cancelled status
after interrupt. Web TypeScript check and focused ESLint passed. Axiom/citation/import audits and
the integrated catalogue/import audits remain pending after these final additions. An independent
verifier killed eight fresh definition mutations through named theorem builds: workspace lookup,
start workspace assignment, interrupt workspace update, forced owner filtering, session scope,
revocation `tokenFound`, interrupt lifecycle effect, and start owner assignment. The source hash
matched after restoration, the clean 50-job named build passed, and the verifier repeated the
97/97 real-handler replay.

`authorisation_undecidable` is structurally unreachable on the recognized run routes today:
`api.ts` parses roles before `decide()`, and the route method/path shapes are known. The R-2
checklist itself marks its decide-deny/refuse branch unreachable (G-8). The model retains the
fail-closed response code, while the real replay exercises every reachable 4xx/503 code and
App Router `internal_error` on all seven exports.
