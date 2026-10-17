# D1 — Runs and the event stream

This is the D1 scope checklist, step 1 of the method in
the formal programme handover notes (maintainers' copy), §5.2. It was enumerated from the
code on branch `formal/d1-runs` (base `1e431b7`) and from the documents. **The code is today's
truth.** Where a document disagrees with the code, the disagreement appears under
[Suspicious points](#suspicious-points-noticed-while-reading) and not as a scope item.

Later steps add these sections: theorems, attacker model, mutation report, conformance suites, and
bugs and their outcomes. The [coverage checklist](#coverage-checklist) at the end is the domain's
coverage target. When D1 is done, every row there has a theorem, a vector, a finding, or a
justified "not modelled".

Path abbreviations used on this page:

| Alias                         | Path                                        |
| ----------------------------- | ------------------------------------------- |
| `api.ts`                      | `apps/web/server/runs/api.ts`               |
| `store.ts`                    | `apps/web/server/runs/store.ts`             |
| `sse.ts` (server)             | `apps/web/server/runs/sse.ts`               |
| `register.ts`                 | `apps/web/server/composition/register.ts`   |
| `core runs.ts`                | `packages/core/src/db/repositories/runs.ts` |
| `decide.ts`, `permissions.ts` | `apps/web/server/rbac/…`                    |
| SDK `runs.ts`                 | `packages/sdk/src/resources/runs.ts`        |
| aw `runs.ts`                  | `packages/aw/src/commands/runs.ts`          |

## Scope

### Routes

#### Conventions shared by every run route

- **Handler order.** Every run route is a thin App Router adapter
  (`apps/web/app/api/**/route.ts`) around a `Request → Response` function in `api.ts`. The adapter
  wraps that function in `errorResponse` (`apps/web/server/http/error-response.ts:55`). There, a
  thrown `DomainError` maps to its category's status (validation 400, unauthenticated 401,
  forbidden 403, not-found 404, conflict 409, rate-limit 429 with `Retry-After`). Anything else
  becomes `500 internal_error`, `503 service_unavailable` or `502 upstream_failure`, each with a
  fixed message.
- **Error envelope.** Every run-route problem is `{ error: { code, message } }`
  (`apiError`, `apps/web/server/runs/http.ts:21`). This is `ApiProblemSchema` without `details`.
  Run routes never use the RBAC `{ code, detail }` spelling, because they do not go through
  `rbac/http.ts`.
- **JSON bodies** (R-1, R-4, R-5) are read by `readJsonBody` (`runs/http.ts:97`). Each of these
  answers `400 invalid_body`:
  - a missing `Content-Type`;
  - a media type other than `application/json`;
  - more than `MAX_JSON_BODY_BYTES = 2 000 000` bytes, counted while reading;
  - a body that cannot be read;
  - invalid JSON.

  None of these answers 413, 415 or `malformed_body`. See [suspicious point 8](#suspicious-points-noticed-while-reading).

- **The edge.** In `apps/web/proxy.ts:43`, `isBrowserTokenExemptRoute` lets `Bearer awt_live_…`
  through only on `GET /api/runs/:id(/events)` and `POST /api/agents/:id/runs`. Every other route
  answers a browser token with 401 at the edge.
- **UUID check.** Ids are checked with `isUuid` (`runs/http.ts:33`), which is canonical RFC 9562
  and case-insensitive (`/i`). They are then passed on as the caller spelled them.

#### Run routes

| Id  | Method and path                       | Route file → handler                                                            | Success                                                                                                           | Problems, in evaluation order (file:line)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | `POST /api/agents/:id/runs`           | `apps/web/app/api/agents/[id]/runs/route.ts` → `startRun` (`api.ts:256`)        | **202** `{ run, events }`, `Location: /api/runs/:id/events`; the run is `queued`; `env.launch` is fire-and-forget | 1. `503 run_api_not_configured` (no environment installed). 2. `401 unauthenticated`. 3. _ownership_ = `resolveAgentRunOwnership` (`apps/web/server/agents/run-ownership.ts:41`: own / permitted / other / unknown; a non-UUID id is `unknown`). 4. `403 forbidden` (the role does not parse, `api.ts:212`). 5. `403 token_out_of_scope` (decide's scope grammar; a run scope never reaches `agents.run`). 6. `403 forbidden` (decide deny). 7. `500 authorisation_undecidable` (decide refuse). 8. `400 invalid_agent_id` (reached only by an `any` grant). 9. `400 invalid_body` (`readJsonBody`, or `parseStartRunBody` at `api.ts:90`). 10. `403 token_out_of_scope` (session scope, when `sessionId` is null or differs, `api.ts:241`/`283`). 11. `404 agent_not_found` (`findAgent` returns null for a missing agent **or** an archived or missing workspace, `register.ts:858`). 12. `409 session_not_usable` (`openSession` returns null, `register.ts:869`: the requested session is missing, belongs to another agent or another owner principal, sits in an archived project, the workspace is archived, or a new-session `ensure` did not create). 13. `500 internal_error` (`store.create` threw). |
| R-2 | `GET /api/runs`                       | `apps/web/app/api/runs/route.ts` → `listRuns` (`api.ts:771`)                    | **200** `{ runs, nextCursor }`, newest first                                                                      | 1. `503 run_api_not_configured` (no environment, or `store.listRuns` is undefined). 2. `401`. 3. `403 forbidden` (the role does not parse). 4. `403 token_out_of_scope` (any scoped token: a runs read with no `:id`; the proxy's 401 comes first). 5. `403`/`500` from decide deny/refuse (unreachable today; gap G-8, `api.ts:609`). 6. `400 invalid_limit` (not `/^[1-9]\d{0,3}$/`, or > 200). 7. `400 invalid_cursor` (`decodeRunListCursor`, `api.ts:544`). 8. `400 invalid_status`, `invalid_agent`, `invalid_project`, `invalid_provider`, `invalid_model` (blank after trim), `invalid_from`, `invalid_to`, `invalid_date_range` (to < from), in that order. 9. `user` present: `403 user_filter_forbidden` if the grant is not `any`, else `400 invalid_user`. 10. `500 internal_error`. With an `own` grant and no `user`, the filter `ownerPrincipalId = principal.principalId` is forced (`api.ts:754`).                                                                                                                                                                                                                                                                                            |
| R-3 | `GET /api/runs/:id`                   | `apps/web/app/api/runs/[id]/route.ts` `GET` → `readRun` (`api.ts:342`)          | **200** `{ run }`                                                                                                 | 1. `503`. 2. `401`. 3. `400 invalid_run_id`. 4. `404 run_not_found` (absent **or** another workspace; `findRunForPrincipal`, `api.ts:331`). 5. `403 token_out_of_scope` (session scope and `run.sessionId ≠ scope.id`). 6. `403 forbidden` (the role does not parse). 7. decide with own/other (`ownsRun`, where the session's `owner_principal_id` equals the principal, `register.ts:925`): `403 token_out_of_scope` (run scope and `:id ≠ scope.id`), `403 forbidden`, `500 authorisation_undecidable`. 8. `500 internal_error`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R-4 | `POST /api/runs/:id` (**deprecated**) | `apps/web/app/api/runs/[id]/route.ts` `POST` → `revokeRunTokens` (`api.ts:794`) | **200** `{ revoked, outcome }`                                                                                    | Same as R-5. The handler is shared.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R-5 | `POST /api/runs/:id/revoke-tokens`    | `apps/web/app/api/runs/[id]/revoke-tokens/route.ts` → `revokeRunTokens`         | **200** `{ revoked, outcome }`                                                                                    | 1. `503` (no environment, or `env.revokeRunTokens` is undefined). 2. `401`. 3. `403 token_out_of_scope` (any browser-token scope; the proxy's 401 comes first). 4. `403 run_token_revoke_forbidden` (role not in {owner, admin}, including a missing role). 5. `400 invalid_run_id`. 6. `404 run_not_found`. 7. `400 invalid_body` (`readJsonBody`, the body is not an object, or it has a key other than `tokenId`). 8. `400 invalid_token_id`. 9. `500`. **No `decide()` call.** Outcomes (`register.ts:822–846`): with `tokenId` null, every `run_tokens` row and every `browser_tokens` row of the run is revoked and the answer is `revoked` when the count is > 0, else `already-revoked` (`not-found` only when the workspace scope does not resolve). With a `tokenId`, `RunTokenRepository.revoke` answers `revoked` (revoked = 1), `already-revoked` or `not-found`, and browser tokens are untouched.                                                                                                                                                                                                                                                                                                |
| R-6 | `GET /api/runs/:id/events`            | `apps/web/app/api/runs/[id]/events/route.ts` → `streamRunEvents` (`api.ts:946`) | **200** `text/event-stream`, with exactly the three `SSE_HEADERS` (`sse.ts:46`)                                   | 1. `503`. 2. `401`. 3. `400 invalid_run_id`. 4. `400 invalid_resume_cursor` (`Last-Event-ID` header or `?after=`; the header wins; checked **before** the run lookup). 5. `404 run_not_found`. 6. `403 token_out_of_scope` (session scope). 7. `403 forbidden` (role). 8. decide (own/other): `403 token_out_of_scope`, `403 forbidden`, `500 authorisation_undecidable`. 9. `404 run_not_found` (`openStream` returned null). 10. `500` if thrown before the response. Once the status is 200, every failure is in band ([Events](#events)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R-7 | `POST /api/runs/:id/interrupt`        | `apps/web/app/api/runs/[id]/interrupt/route.ts` → `interruptRun` (`api.ts:849`) | **200** `{ run }`, re-read after the effect                                                                       | 1. `503` (no environment, or `env.interruptRun` is undefined). 2. `401`. 3. `400 invalid_run_id`. 4. `404 run_not_found`. 5. `403 forbidden` (role). 6. decide, op `run`: `403 token_out_of_scope` (every scope; the proxy's 401 comes first), `403 forbidden` (Builder or Viewer on `other`). 7. `500 authorisation_undecidable`. 8. `409 run_not_interruptible` (already terminal). 9. `500`. No body is read. The effect (`register.ts:849–856`), in order: `appendPlatformEvent(run.status {cancelled, 'the run was interrupted by request'})`, then `finish(cancelled)`, then `revokeAllRunTokensFor` (run and browser tokens), then `signalLiveRun` (best effort, ≤ 5 s, `interrupt.ts:48`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

#### Routes the run flow depends on

D1 models only what the run flow needs from these routes. The owning domain is named for each.

| Id   | Route                                                            | Handler                                                                                   | Why D1 needs it                                                                                                                                                                                                           | Codes relevant to D1                                                                                                                                                                                                                                                                                                                                                                                                    | Owner domain                      |
| ---- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| R-8  | `POST /api/tokens`                                               | `apps/web/server/tokens/handlers.ts:80` `mintToken` (via `rbac/http.ts`, detail envelope) | Mints the run- and session-scoped browser tokens that R-1, R-3 and R-6 accept                                                                                                                                             | `201`. `rbac/http.ts` body errors (`415 unsupported_media_type`, `413 request_body_too_large`, `400 malformed_body`) come **before** authentication. `400 invalid_field`, then authorise `401/403/500`, `404 run_not_found`/`session_not_found` (non-UUID, absent, another workspace, a terminal run or an archived session; `register.ts:1083–1096`), `503 tokens_runtime_not_configured`. TTL 60–3600 s, default 300. | D3                                |
| R-9  | `GET /api/sessions/:claudeSessionId`                             | `apps/web/server/sessions/api.ts:256` `getSession`                                        | Reads `resumable` for a session a run continues                                                                                                                                                                           | `503 session_api_not_configured`, `401`, `400 invalid_session_id`, `403 session_forbidden` (checked before existence), `404 session_not_found`                                                                                                                                                                                                                                                                          | D1 (runs part) / D4               |
| R-10 | `PATCH /api/sessions/:claudeSessionId`                           | `sessions/api.ts:273` `updateSession`                                                     | Archiving a session ends session-scoped browser tokens (checked when the token is resolved). It does **not** stop a new run from continuing the session ([suspicious point 2](#suspicious-points-noticed-while-reading)). | `400 invalid_body`/`invalid_title`/`invalid_session_status`, `403 session_forbidden`, `404 session_not_found`                                                                                                                                                                                                                                                                                                           | D1 (runs part) / D4               |
| R-11 | `POST /api/projects/:id/sessions`                                | projects runtime (`guardProjectSessionCreation`, `guardSessionCreation`)                  | Creates the session row a later run continues (`startSession`/`adoptSession`). Passes the archive gates.                                                                                                                  | `409 project_archived`, `409 project_session_has_runs`, `422 project_default_agent_unresolvable`                                                                                                                                                                                                                                                                                                                        | D5                                |
| R-12 | `GET`/`POST`/`DELETE …/sessions/:id/transcript`, `GET …/subkeys` | `sessions/api.ts`; auth `composition/session-rbac.ts:23`                                  | The runner mirrors transcripts with the **run token** (`AW_SESSION_MIRROR_TOKEN`). The principal kind is `runner` when the token is active and its claims match the run row.                                              | `409 session_archived` (read and append)                                                                                                                                                                                                                                                                                                                                                                                | D4 (paths), D1 (runner principal) |
| R-13 | gateway, every path                                              | `packages/gateway/src/auth.ts:75` `authenticateGatewayRequest`                            | Run-token verification                                                                                                                                                                                                    | `401 token_missing` → `401 token_expired` / `401 token_invalid` → `403 token_run_mismatch` → `401 token_revoked` / `410 run_deleted` / `404 run_not_found`. The envelope is `{ type:'error', error:{ type:'authentication_error', code, message } }`.                                                                                                                                                                   | D1                                |

### Tables

| Table                                                   | Lean (Phase 1)                                                                                                                                                                                                                                                                 | Columns and constraints D1 relies on (`packages/core/src/db/schema/*.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs`                                                  | `Concepts/Run.lean` `Run` (plus `endedAtIffTerminal`, `endedAfterStarted`, `costNonNegative`, `currencyUsd`, `priceVersionMatches`, `unpricedCostZero`, `wellFormed`, `durationMs`, `create`, `stamp`, `agentVia`, `ownerVia`); `Er/Current/Work.lean` `runCells`, `workCheck` | PK `id`. `workspace_id` NOT NULL. No `agent_id` and no `owner_principal_id`: the agent, project, initiating user and owner principal are all reached through `sessions`. FKs: `runs_session_workspace_fk (session_id, workspace_id) → sessions` ON DELETE CASCADE; `runs_model_connection_workspace_fk`. Unique index `runs_id_workspace_unique`. Checks: `runs_status_valid`, `runs_provider_valid`, `runs_accounting_state_valid`, `runs_ended_at_iff_terminal`, `runs_ended_after_started`, `runs_counters_non_negative`, `runs_cost_currency_usd`, `runs_price_version_matches_accounting_state`, `runs_unpriced_cost_zero` (`schema/runs.ts:153–196`). Indexes: `runs_workspace_created_idx`, `runs_session_created_idx`, `runs_model_connection_idx`. |
| `run_events`                                            | `Concepts/RunEvent.lean` `RunEvent`, `logContiguous`, `isEventName`, `frameKind?`; `Work.lean` `runEventCells`                                                                                                                                                                 | PK `run_events_pkey (run_id, sequence)`. `sequence` is a bigint; `type` is text; `data` is jsonb. `run_events_run_workspace_fk`. Indexes `…_workspace_sequence_idx`, `…_run_sequence_idx`. The per-run advisory lock (`pg_advisory_xact_lock(hashtextextended(run_id,0))`) serialises append, finish and recordUsage (`core runs.ts:320`, `:696`, `:765`).                                                                                                                                                                                                                                                                                                                                                                                                  |
| `run_tokens`                                            | `Concepts/Run.lean` `RunToken` (`expiryAfterCreated`, `revokedAfterCreated`); `Work.lean` `runTokenCells`                                                                                                                                                                      | `run_tokens_run_workspace_fk`, `run_tokens_hash_key` (globally unique hash), `run_tokens_expiry_after_created`, `…_revoked_after_created`, `run_tokens_active_idx`. Repository: `packages/core/src/db/repositories/run-tokens.ts` (`register`, `isActive`, `revoke`, `revokeForRun`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `run_usage_records`                                     | `Concepts/Usage.lean` `UsageRecord`, `ledgerAccounting`, `Counters`; `Work.lean` `usageCells`                                                                                                                                                                                  | `run_usage_records_response_unique (run_id, provider_response_id)`, `…_run_workspace_fk`, `…_currency_usd`, `…_counters_non_negative`. `provider` is free text (F-063).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sessions` (as used)                                    | `Concepts/Session.lean` `Session`, `resumable`, `launchMode`, `recordReported`, `identityCurrent`, `tenantScopeOk`; `Work.lean` `sessionCells`                                                                                                                                 | `id`, `workspace_id`, `agent_id`, `user_id` (nullable, legacy), `owner_principal_id`, `project_id`, `claude_session_id`, `status ∈ {active, archived}`. FKs: `sessions_agent_workspace_fk`, `sessions_member_workspace_fk`, `sessions_owner_principal_workspace_fk`, `sessions_project_workspace_fk` (F-002/F-073).                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `browser_tokens` (run and session scope)                | `Concepts/BrowserToken.lean`                                                                                                                                                                                                                                                   | `browser_tokens_scope_xor`, `…_run_workspace_fk`, `…_session_workspace_fk`, `…_minter_workspace_fk`, `…_hash_key`. Full modelling belongs to D3. D1 needs `revokeForRun`, `findActiveByHash`, and the terminal/archived refusal at resolution time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `share_run_charges`, `shares.spent_usd`, `audit_events` | `Concepts/Share.lean`, `Work.lean` `AuditEvent`                                                                                                                                                                                                                                | Only as side effects of `recordUsage` (the charge delta, the budget stop, and one `runnable-link-stopped` audit row, `core runs.ts:915–960`). Owned by D2. **Runs themselves write no audit event.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `workspaces.archived_at`, `projects.archived_at`        | `Concepts/Workspace.lean`, `Concepts/Project.lean`                                                                                                                                                                                                                             | Read by the run gate and the archive gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

The Phase 1 ER state and its invariants live in `Er/Current/Work.lean`: `workTables`,
`workChecksHold`, `workConsistent`, `workForeignKeys` and `fkCardinality`. The existing lifecycle
is `Lifecycle/Run.lean`: `RunOp`, `runStep`, `applyRunOp(s)` and `RunTransition`. The existing
contract is `Contracts/Runs.lean` (`RunStatus`, `terminal`, `isTerminal`).

### Contracts

Notation: **S** = `.strict()`, **R** = `.readonly()`, **opt** = the key may be absent,
**null** = the value may be `null`.

`packages/contracts/src/identifiers.ts`, the shared foundation:

| Export              | Line | Shape                                                                                              |
| ------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| `UUID_PATTERN`      | 8    | `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`, any version, case-insensitive |
| `isUuid`            | 10   | `typeof v === 'string' && UUID_PATTERN.test(v)`                                                    |
| `UuidSchema`        | 15   | `z.string().regex(UUID_PATTERN)`                                                                   |
| `IsoDateTimeSchema` | 21   | `z.iso.datetime()` (Zod 4: offset-free `Z` form by default)                                        |

`packages/contracts/src/problem.ts`, the shared foundation:

| Export                                       | Line    | Shape                                                                                                                                                                                                                                |
| -------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ApiProblemSchema` / `ApiProblem`            | 11 / 25 | S R `{ error: S R { code: min 1, message: string, details?: string[] (opt, R) } }`                                                                                                                                                   |
| `ApiProblemDetailSchema`                     | 37      | S R `{ error: S R { code: min 1, detail: string } }` (the RBAC spelling)                                                                                                                                                             |
| `ApiProblemBareCodeSchema`                   | 56      | S R `{ error: min 1, message?: string (opt) }`                                                                                                                                                                                       |
| `COMMON_PROBLEM_CODES` / `CommonProblemCode` | 70 / 83 | `unauthenticated 401, forbidden 403, authorisation_undecidable 500, malformed_body 400, invalid_body 400, unsupported_media_type 415, request_body_too_large 413, internal_error 500, service_unavailable 503, upstream_failure 502` |

`packages/contracts/src/runs.ts`:

| Export                                                      | Line      | Shape                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUN_STATUSES` / `RunStatus`                                | 9 / 10    | `queued, running, completed, failed, cancelled`                                                                                                                                                                                                                                                                                   |
| `TERMINAL_RUN_STATUSES`                                     | 12        | `completed, failed, cancelled`                                                                                                                                                                                                                                                                                                    |
| `isTerminalRunStatus`                                       | 15        | set membership                                                                                                                                                                                                                                                                                                                    |
| `MODEL_PROVIDERS` / `ModelProvider`                         | 20 / 27   | `anthropic, anthropic-compatible, openai, azure-openai, openai-compatible`                                                                                                                                                                                                                                                        |
| `ACCOUNTING_STATES` / `AccountingState`                     | 30 / 37   | `pending, complete, partial, failed, unavailable`                                                                                                                                                                                                                                                                                 |
| `MAX_PROMPT_CHARS`                                          | 40        | `100_000` UTF-16 code units                                                                                                                                                                                                                                                                                                       |
| `RunUsageSchema` / `RunUsage`                               | 42 / 55   | S R, six `int ≥ 0` fields: `inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, totalTokens, toolCalls`. The sum is **not** enforced by the schema.                                                                                                                                                        |
| `RunCostSchema` / `RunCost`                                 | 57 / 67   | S R `{ amount: string min 1 (not a decimal pattern, F-067), currency: string min 1 (not 'USD'), priceTableVersion: string null }`                                                                                                                                                                                                 |
| `RunResourceSchema` / `RunResource`                         | 74 / 101  | S R. `id, workspaceId, agentId, sessionId`: string min 1 (not UUID). `projectId, initiatingUserId, model, modelConnectionId, error, accountingError`: string null. `status`: enum. `createdAt`: ISO. `startedAt, endedAt`: ISO null. `durationMs`: int ≥ 0 null. `provider`: enum null. `usage`, `cost`, `accountingState`: enum. |
| `StartRunRequestSchema` / `StartRunRequest`                 | 111 / 132 | S R `{ prompt: max 100 000 and trim non-empty; sessionId?: Uuid null opt; modelConnectionId?: Uuid null opt; model?: string min 1 null opt }`, with the refine `(connection ≠ null) ⇔ (model ≠ null)`                                                                                                                             |
| `StartRunResponseSchema` / `StartRunResponse`               | 135 / 144 | S R `{ run, events: string min 1 }`                                                                                                                                                                                                                                                                                               |
| `RunResponseSchema`                                         | 147       | S R `{ run }` (no type alias is exported)                                                                                                                                                                                                                                                                                         |
| `InterruptRunResponseSchema` / `InterruptRunResponse`       | 154 / 156 | S R `{ run }`                                                                                                                                                                                                                                                                                                                     |
| `RevokeRunTokensResponseSchema` / `RevokeRunTokensResponse` | 165 / 173 | S R `{ revoked: int ≥ 0, outcome: 'revoked' \| 'already-revoked' \| 'not-found' }`                                                                                                                                                                                                                                                |
| `RUN_LIST_DEFAULT_LIMIT` / `RUN_LIST_MAX_LIMIT`             | 176 / 177 | 20 / 200                                                                                                                                                                                                                                                                                                                          |
| `RunListResponseSchema` / `RunListResponse`                 | 180 / 188 | S R `{ runs: RunResource[] R, nextCursor: string min 1 null }`                                                                                                                                                                                                                                                                    |
| `RunListQuery` (interface)                                  | 196       | ten optional fields: `status, agent, project, provider, model, from, to, user, limit (number), cursor`                                                                                                                                                                                                                            |
| `runListSearchParams`                                       | 210       | sets the fields that are not `undefined`, in that order, as `String(v)`; does no validation                                                                                                                                                                                                                                       |

`packages/contracts/src/run-events.ts`:

| Export                                                | Line    | Shape                                                                                      |
| ----------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `CONTROL_FRAME_NAMES` / `ControlFrameName`            | 27 / 28 | `done, run-failed, stream-reset`. The server list adds `error` (`sse.ts:110`).             |
| `RUN_STATUS_EVENT`                                    | 31      | `'run.status'`                                                                             |
| `RELAYED_EVENT_NAMES` / `RelayedEventName`            | 38 / 47 | `system, system-unknown, result, result-unknown, sdk-event, unknown, malformed`            |
| `EVENT_NAME_PATTERN`                                  | 50      | `/^[A-Za-z][A-Za-z0-9._-]{0,63}$/`                                                         |
| `RunStatusEventDataSchema` / `RunStatusEventData`     | 53 / 62 | S R `{ status: RunStatus, error: string null }`                                            |
| `RunFailedFrameDataSchema` / `RunFailedFrameData`     | 69 / 77 | S R `{ status: RunStatus \| 'unknown', message: string }`                                  |
| `StreamResetFrameDataSchema` / `StreamResetFrameData` | 80 / 89 | S R `{ reason: string, resumedAfter: string null }`                                        |
| `RelayedEventDataSchema` / `RelayedEventData`         | 96 / 98 | `z.looseObject({ kind: string min 1 }).readonly()`, the only loose object in the contracts |

`packages/contracts/src/sessions.ts`, the parts runs use:

| Export                                      | Line    | Shape                                                                                                                                                                                            |
| ------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SESSION_STATUSES` / `SessionStatus`        | 5 / 6   | `active, archived`                                                                                                                                                                               |
| `SessionResourceSchema` / `SessionResource` | 16 / 35 | S R. `userId, projectId, claudeSessionId, title`: null. `ownerPrincipalId`: min 1. `resumable: boolean` (documented as active ∧ claudeSessionId ≠ null; derived at `sessions/api.ts:208`/`248`). |
| `SessionResponseSchema`                     | 38      | S R `{ session }`                                                                                                                                                                                |
| `UpdateSessionPatch` (interface)            | 58      | `{ title?: string \| null, status?: SessionStatus }`                                                                                                                                             |
| `PROJECT_KEY_PATTERN`                       | 71      | `/^[A-Za-z0-9_-]{1,64}$/`. For a run's sandbox it is the workspace id (`sandboxFor`).                                                                                                            |

The rest of `sessions.ts` (`SessionListResponseSchema`, the `TRANSCRIPT_*` constants, `Transcript*`
schemas, `TranscriptQuery`, `transcriptSearchParams`) belongs to D4. The token contracts
(`packages/contracts/src/tokens.ts`: `TokenScopeSchema`, `MintTokenRequestSchema`,
`BROWSER_TOKEN_DEFAULT_TTL_SECONDS`) belong to D3. D1 reads the scope shape.

Server-side restatements that must equal the contract (T4 targets):

| Server restatement                                                                       | Contract                                                                                 |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `store.ts:63` `runStatuses`, `terminalRunStatuses`, `modelProviders`, `accountingStates` | `runs.ts` enums                                                                          |
| `api.ts:64` `MAX_PROMPT_CHARS`                                                           | `runs.ts:40`                                                                             |
| `api.ts:366–368`, `store.ts:210`, `core runs.ts` `MAX_RUN_LIST_LIMIT`                    | `RUN_LIST_*`                                                                             |
| `parseStartRunBody`                                                                      | `StartRunRequestSchema` ([suspicious point 7](#suspicious-points-noticed-while-reading)) |
| `renderRun` (`api.ts:149`)                                                               | `RunResourceSchema`                                                                      |
| `sse.ts` names                                                                           | `run-events.ts` names                                                                    |

### Authorisation

**Size of the whole table**, all of which D1 models (handover §6, "Shared foundations"):

- `ROLES` = 4 (`roles.ts:31`).
- `RESOURCES` = 25 (`resources.ts:2`).
- `Operation` = 3 (`read`, `write`, `run`).
- `Grant` = 4 (`none`, `own`, `permitted`, `any`).
- `OWNERSHIPS` = 5 (`decide.ts`).
- `POLICY` has 4 × 25 × 3 = **300 grant cells** (`permissions.ts:216`). Owner's fallback is `EVERYTHING`, with a `workspaces` override.
- `applyGrant` has 4 × 5 = **20 cells**.
- `decide` over (role, resource, op, ownership) has **1 500 cells**. The scope axis multiplies that by {null, run(id), session(id)} crossed with id match or mismatch or no id.
- Accepted path shapes: 25 collections + 25 rows + **17 sub-resources**, 67 in all (`SPEC_34_SUB_RESOURCES`: `agents/runs`, `runs/events`, `sessions/messages`, plus 14 declared in `apps/web/server/rbac/declarations/*.ts`). These are crossed with 7 methods; `OPTIONS` and any other string are refused.
- Route level (`authorisation-matrix.test.ts`): 102 declared routes, minus 5 `PUBLIC_ROUTES` and 1 `IDENTITY_ONLY_ROUTES`, leaves 96 routes. 96 × 4 roles × 5 ownerships = **1 920 route cells**. Every cell must be allow or deny.

**Role-table cells D1 depends on** (`permissions.ts`), written read/write/run:

| Resource                                 | Owner       | Admin                                                  | Builder                | Viewer                          |
| ---------------------------------------- | ----------- | ------------------------------------------------------ | ---------------------- | ------------------------------- |
| `runs`                                   | any/any/any | any/none/**any** (`:295`, `{...READ_ONLY, run:'any'}`) | own/none/own (`:328`)  | own/none/own (`:351`)           |
| `agents` (the `run` column starts a run) | any/any/any | any/any/any (`:235`)                                   | any/own/own (`:314`)   | any/none/**permitted** (`:346`) |
| `sessions`                               | any/any/any | own/own/none (`:279`)                                  | own/own/none (`:322`)  | own/none/none (`:348`)          |
| `tokens` (mint, R-8)                     | any/any/any | none/any/none (`:305`)                                 | none/own/none (`:336`) | none/none/none                  |

**How `decide` maps each run route** (`decide.ts`: `parsePath`, `parseOperation`, `checkTokenScope`):

| Route                              | resource / sub        | op                               | Ownership the handler passes       | run scope                                | session scope                                                  |
| ---------------------------------- | --------------------- | -------------------------------- | ---------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| `POST /api/agents/:id/runs`        | agents / runs         | **run** (POST + sub `runs`)      | `resolveAgentRunOwnership`         | deny `token_out_of_scope`                | grammar ok; the row check is in the handler (body `sessionId`) |
| `GET /api/runs`                    | runs / – (collection) | read                             | `not-applicable`                   | deny (no `:id`)                          | deny (no `:id`)                                                |
| `GET /api/runs/:id`                | runs / –              | read                             | own/other                          | ok for the same valid UUID, regardless of hex case | ok; row check in the handler                                   |
| `GET /api/runs/:id/events`         | runs / events         | read                             | own/other                          | ok for the same valid UUID, regardless of hex case | ok; row check in the handler                                   |
| `POST /api/runs/:id/interrupt`     | runs / interrupt      | **run** (POST + sub `interrupt`) | own/other                          | deny                                     | deny                                                           |
| `POST /api/runs/:id/revoke-tokens` | runs / revoke-tokens  | revoke                           | `not-applicable`                   | deny `token_out_of_scope`                | deny `token_out_of_scope`                                      |
| `POST /api/runs/:id`               | runs / –              | revoke                           | `not-applicable`                   | deny `token_out_of_scope`                | deny `token_out_of_scope`                                      |

**Decision components** (`decide.ts`), in `decide`'s order:

1. `parseRole`. Null means refuse.
2. `classifyPath` (`apps/web/server/auth/paths.ts:109`). `public` → allow with `facts: null`; `page` → refuse.
3. `parsePath`. The resource must be one of the 25. Depth ≤ 3. A `sub` must be in `SUB_RESOURCES`.
4. A POST on a named run or its `revoke-tokens` subroute uses the dedicated revoke capability: scoped callers are denied, Owner/Admin are allowed, and Builder/Viewer receive `run_token_revoke_forbidden`.
5. Otherwise, `parseOperation` maps the method to read, run or write.
6. `checkTokenScope` against `TOKEN_SCOPE_GRAMMAR = { run: [(runs, read)], session: [(runs, read), (agents, run)] }`. This denies with `code: 'token_out_of_scope'` when the pair is outside the grammar, a runs read has no id, or a run scope names a different id after valid UUID normalization. It never refuses.
7. `grantsFor(role, resource)[op]`, then `applyGrant` for ordinary routes.

The result is `Decision = allow | deny{code?} | refuse`.

**Handler-side authorisation specific to runs:**

| Rule                                                                                                                                                                                                         | Where                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `requireRunPermission`: a role that does not parse is `403 forbidden` (not the `500` refuse); refuse is `500 authorisation_undecidable`; deny is `403` with `decision.code ?? 'forbidden'`                   | `api.ts:206`                                    |
| `requireSessionScopeMatch`: the session scope's row identity, checked by exact string equality; `403 token_out_of_scope`                                                                                     | `api.ts:241`                                    |
| `decideRunListAccess` plus the forced `ownerPrincipalId` filter when the grant is not `any`; the `user` filter only with `any`                                                                               | `api.ts:594`, `:650`                            |
| `revokeRunTokens` uses the dedicated `decide()` capability: it refuses every scope and admits only Owner and Admin                                                                                             | `api.ts#revokeRunTokens`                        |
| `resolveAgentRunOwnership`: own when `agent.ownerPrincipalId === principalId`; permitted when an `agent_grants` row exists by **user id** (F-053/F-068); other; unknown when there is no agent or no runtime | `apps/web/server/agents/run-ownership.ts:41`    |
| `ownsRun`: `session.ownerPrincipalId === principal.principalId` (a run has no owner column, F-060)                                                                                                           | `register.ts:925`                               |
| `Principal.scope` is required (`TokenScope \| null`) and copied into the run API's principal                                                                                                                 | `runs/environment.ts:45`, `register.ts:308–322` |
| `resolveBrowserTokenActor` refuses a token whose run is terminal or whose session is archived, and re-reads the minter from the directory                                                                    | `composition/session-rbac.ts:191`               |
| The `runner` principal for transcripts: the run token is active **and** the claims' session, workspace and agent equal the run row                                                                           | `session-rbac.ts:36–64`                         |

**Run tokens** (`packages/gateway/src/tokens/run-token.ts`):

- `RunTokenClaimsSchema` (`:5`) is S R `{ version: 1, tokenId, runId, sessionId, workspaceId, agentId, modelConnectionId }`. The string fields are non-blank after trim. `issuedAt` and `expiresAt` are ints, refined `expiresAt > issuedAt`.
- `createRunTokenCodec` (`:79`):
  - The secret must be ≥ 32 bytes.
  - `ttlSeconds` is an integer in 1–3600, default `DEFAULT_TTL_SECONDS = 300`.
  - `issue` rejects blank subject fields.
  - The token is `base64url(payload).base64url(HMAC-SHA256)`.
  - `verify` answers `invalid` for a segment count ≠ 2, bad base64, a bad signature or bad claims. It answers `expired` when `now ≥ expiresAt`. Otherwise it answers `ok`.
- The token is issued in `buildRunRequestFor` (`apps/web/server/compose/run-request.ts:460`). It is registered as a `run_tokens` row and becomes `ANTHROPIC_AUTH_TOKEN` and `AW_SESSION_MIRROR_TOKEN`.
- Revocation happens three ways:
  - `finish` does it in the same transaction as the terminal status (`core runs.ts:732`).
  - R-4 and R-5.
  - Interrupt, and the launcher's `abandonInterruptedLaunch` (`launcher.ts:262`).

**Tenancy:**

- `WorkspaceScope` / `requireWorkspaceScope` (`packages/core/src/db/repositories/scope.ts`). Every run and event query is scoped.
- `findRunWorkspace` (`core runs.ts:1262`) is the one query keyed by run id alone. It returns only a workspace id (ADR W2-DB-02).
- `findRunForPrincipal` hides another workspace's run behind a **404** (`api.ts:331`).
- `findAgent` returns `404 agent_not_found` for a foreign agent and for an archived workspace.
- `runs_session_workspace_fk` pairs the run's workspace with its session's.
- `requireResourceAccess` / `authorise`'s ownership resolver (`apps/web/server/resources/authorise.ts:16`, ADR W9-AUTH-117 "404 before decide") is the shared tenancy shape. Run routes do not use it.

### Run request composition

| Unit                                                 | Location                                                                                                                                                             | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseStartRunBody`                                  | `api.ts:90`                                                                                                                                                          | The body must be an object. Keys ⊆ {prompt, sessionId, modelConnectionId, model}. `prompt` is a string, `trim()` is non-empty, `length ≤ 100 000`. `modelConnectionId` is a UUID when not null/undefined. `model` is **any string** when not null/undefined. Connection and model are both null or both set. `sessionId` is a UUID or absent/null. The function never throws.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `openSession`                                        | `register.ts:869`                                                                                                                                                    | Run gate first. For a requested id, the session must exist with `agentId = agent.id` and `ownerPrincipalId = principal.principalId`, and `createProjectRunGate(...).isUsableForNewWork(projectId)` must hold. It then returns `sessionForLaunch` (**`status` is not checked**). With no requested id, `sessions.ensure({ id: randomUUID, agentId, ownerPrincipalId, userId })`, and only `created`/`existing` succeed.                                                                                                                                                                                                                                                                                                                                                                 |
| `sessionForLaunch` / `recordReportedSessionIdentity` | `composition/session-launch.ts:12`, `:19`                                                                                                                            | `resume: true` iff `claudeSessionId ≠ null`. The reported id must equal `session.id`, otherwise the call throws (F-061/F-076).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Run gate                                             | `apps/web/server/workspaces/run-gate.ts:42` `isWorkspaceUsableForRuns`, `:55` `createRunGate`, `:82` `guardSessionCreation`                                          | Usable ⇔ the workspace row exists ∧ `archivedAt = null`. The guard refuses `ensure` as `unknown-principal`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Archive gate                                         | `apps/web/server/projects/archive-gate.ts:37` `isProjectUsableForNewWork`, `:53` `createProjectRunGate` (`null` project → true), `:74` `guardProjectSessionCreation` | Only creation is gated; a run already in flight finishes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `resolveModelForRun`                                 | `compose/run-request.ts:347`                                                                                                                                         | Layers are tried in the order run → agent → project → workspace → deployment, and the **first non-null layer wins outright**. It is refused, with the layer named, when: the connection is missing; it is not `ready`; the credential cannot be resolved; discovery fails; or the model is not discovered. The deployment layer (#506) exists only when the agent names no model; it pairs the agent's connection, else the workspace's one named `default`, with the deployment's per-provider default (`AW_DEPLOYMENT_DEFAULT_MODELS`), runs the same checks, and is refused at `deployment` with no such connection or no default for the provider: the one exception to never mixing levels. When every layer is null, the refusal names the `workspace` layer.                    |
| `snapshotModel`                                      | `register.ts` `buildRunRequest`; `store.ts`                                                                                                                          | Writes model, provider and connection before the request is built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `toolPolicyFor`                                      | `run-request.ts:260`                                                                                                                                                 | `readFiles` off → deny Read, Glob, Grep. `writeFiles` off → Write, Edit, NotebookEdit. `runCommands` off → Bash, BashOutput, KillShell. `unrestrictedNetwork` off → WebFetch, WebSearch. `base` is the preset, `permissionMode` is `default`, and there is no dangerous flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `agentConfigFor`                                     | `run-request.ts:309`                                                                                                                                                 | With a stored policy, `deny` and `autoApprove` are **unioned** with the floor. `skills` = policy names ∩ assigned (`all` → the assigned set). `base`, `permissionMode`, `allowDangerouslySkipPermissions` and `limits` are taken verbatim from the policy. Project instructions are appended after `\n\n`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `applyFileGrantPolicy`                               | `run-request.ts:386`                                                                                                                                                 | A read-only grant adds `Write(p)`, `Edit(p)`, `NotebookEdit(p)` (`/**` for a directory) and Bash, BashOutput, KillShell to deny. Deny only grows (ADR W1-COMP-01 "deny not allow").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Project resource narrowing                           | `compose/resource-loader.ts`; ADR W9-PROJ-125                                                                                                                        | Capped by `agents.permissions` (or a run override). A project file needs `readFiles`; a project connector needs `unrestrictedNetwork`; an unresolvable id throws.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `sandboxFor`                                         | `run-request.ts:417`                                                                                                                                                 | The session id must match `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`. `cwd = root/ws/session`, `projectKey = workspaceId`, `configDir = cwd/.claude`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `buildRunRequestFor`                                 | `run-request.ts:460`                                                                                                                                                 | Connection = the resolved one, or `modelOverride`, or legacy `modelConnectionId`, or the agent's; none → throw. Model = the resolved one, or the override, or `agent.model`. The gateway token is issued **before** `RunRequest.parse`. The session is `resume` or `fresh`. The env holds the agent secrets plus `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `AW_SESSION_MIRROR_TOKEN` and `NODE_USE_ENV_PROXY`.                                                                                                                                                                                                                                                                                                                                                                     |
| `compileRunRequest`                                  | `packages/core/src/config.ts:124`                                                                                                                                    | Re-parses `RunRequest`. It derives `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`, `AGENT_WORKSPACE_RUN_ID` and `AGENT_WORKSPACE_SESSION_ID`, applied last. It **throws** if any env key upper-cases to `ANTHROPIC_API_KEY`. It sets `settingSources: ['project']` and `strictMcpConfig: true`, and `allowedTools/disallowedTools/tools/skills` come from the agent. `systemPrompt` is a preset append, only when instructions are non-blank. A null limit or model omits its key. Session mode is fresh `{sessionId}`, resume `{resume}` or fork `{resume, sessionId, forkSession}`.                                                                                                                                                                                             |

Governing narrowing ADRs:

- W9-PROJ-125 (`project-resources-narrow-never-widen`)
- W9-UI-133 (`permission-cap-narrows-at-read-and-write`)
- W1-COMP-01 (`permissions-map-onto-deny-not-allow`)
- SDK-02-AGENT-POLICY-234 (stored policy narrows; owned by D5, applied here)
- W9-WS-119 (run gate)
- W9-PROJ-183 (archive gate)

### Lifecycle

**Status machine.** The two stores implement the same port, `RunStore` (`store.ts:272`):
`InMemoryRunStore` (`store.ts:552`, test adapter only, per ADR RF-001) and
`createRepositoryRunStore` (`store.ts:787`) over `core runs.ts:623`.

| Transition                                                                             | In memory                                                                                                    | Repository (PostgreSQL)                                                                                                                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create → `queued`                                                                      | `store.ts:562`: times null, counters 0, cost `'0.000000'`, `USD`, accounting `pending`, the event log opened | `core runs.ts:651`: `created` \| `duplicate-id` \| `unknown-session` (another workspace's session is also `unknown-session`)                                        |
| markRunning `queued → running`, stamps `startedAt`                                     | `:604`, returns `true`                                                                                       | `:677` `moved`. Otherwise `no-op` or `not-found`. The port returns `moved` as a boolean.                                                                            |
| finish(t), t terminal, from any **non-terminal** state (so `queued → t` exists: F-001) | `:612`: `startedAt ??= now`, `endedAt = now`, error set, log closed                                          | `:696`: under the advisory lock, `startedAt = coalesce(startedAt, now())`, `endedAt = now()`, and **every active `run_tokens` row revoked in the same transaction** |
| finish when already terminal                                                           | no-op (the first call wins)                                                                                  | `no-op`, and the adapter still wakes waiters                                                                                                                        |
| finish(non-terminal target)                                                            | rejects                                                                                                      | throws (checked before any lookup)                                                                                                                                  |

**Timestamps.**

- `runs_ended_at_iff_terminal` and `runs_ended_after_started` hold in the database.
- `durationMs = endedAt − startedAt`, or null if either is missing (`renderRun`, `api.ts:167`).
- `createdAt` is set on insert. The repository's list cursor carries microseconds; the in-memory cursor carries milliseconds.

**Accounting state** (ADR W9-RUNS-134, `core runs.ts:765` `recordUsage`, `:973` `markAccountingFailed`):

- Initial state: `pending`.
- `recordUsage`, under the lock, answers one of `recorded` \| `duplicate` \| `not-found` \| `price-version-conflict`:
  - It inserts a new ledger row keyed by `(runId, providerResponseId)`, or updates an unpriced row with a late price. The later case adds only the cost delta.
  - It then **recomputes** the state: `unavailable` when no row is priced, `complete` when all are priced, `partial` otherwise.
  - It sets `accountingError = null` and advances the share charge and budget stop.
- `markAccountingFailed` applies only from `pending`.
- A later `recordUsage` moves `failed` to a recomputed state.
- Settlement runs inside the gateway (`settlementTimeoutMs` 5000); a timeout leaves `pending` (ADR W9-RUNS-134 settlement).
- Accounting is independent of `status`.

**Launcher** (`apps/web/server/runs/launcher.ts`, `createRunnerLauncher` at `:296`):

- A preparation failure calls `markRunning`, then appends `run.status{running}`, then `conclude(failed)` (`:362–370`).
- If `markRunning` returns false (the run was already terminal, for example an interrupt while queued), `abandonInterruptedLaunch` revokes tokens and concludes `cancelled` (`:400`).
- Otherwise the launcher appends `run.status{running}` and posts `/run`. The connect timeout and the credential-bounded lifetime timer (min(gateway TTL margin, profile timeout)) both lead to `failed`.
- The relay outcome maps as follows: `completed` (with outputs persisted) → `completed`; `cancelled` → `cancelled`; anything else → `failed`.
- `conclude` (`:224`) appends the terminal `run.status` **before** `finish` (two transactions).

**Interrupt** (R-7):

- The route checks that the run is not terminal, so a terminal run gets `409`.
- `interruptRun` (`register.ts:849`) runs append, finish(cancelled), revoke-all, then signal.
- The runner's `run-interrupted` frame → relay `cancelled` → `conclude(cancelled)`.
- The in-process live-run registry (`apps/web/server/runs/interrupt.ts`) makes the signal best effort within one replica. ADR SDK-03-RUN-235.

**Event log closure.**

- In memory, `RunEventLog.close` runs on finish.
- In the repository, `append` refuses a terminal run under the lock.
- In both, a log never grows after the terminal transition.

### Events

**Server log and stream:**

| Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Location                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Name grammar `EVENT_NAME_PATTERN`. Reserved = `CONTROL_FRAME_NAMES` (`done, run-failed, stream-reset, error`) + `PLATFORM_EVENT_NAMES` (`run.status`). `classifyEventName` answers ok / reserved / rejected; `classifyPlatformEventName`; `classifyStoredEventName`. None of them throws.                                                                                                                                                                                                                                 | `sse.ts:110–253`                                                           |
| `renderEventData` rejects values that cannot be serialised (BigInt, cycles) and `undefined`, functions and symbols                                                                                                                                                                                                                                                                                                                                                                                                        | `sse.ts:271`                                                               |
| `append` (relay only, `RelayTarget = Pick<RunStore,'append'>`) refuses reserved names. `appendPlatformEvent` accepts only `run.status`.                                                                                                                                                                                                                                                                                                                                                                                   | `store.ts:303`, `:312`; `relay.ts:50`                                      |
| Sequence: next = max + 1 per run under the advisory lock. In memory, ids are contiguous from 1.                                                                                                                                                                                                                                                                                                                                                                                                                           | `core runs.ts:320–357`; `store.ts` `RunEventLog.write`                     |
| Retention `DEFAULT_MAX_EVENTS_PER_RUN = 50 000`: delete `sequence ≤ next − max` (in memory, shift from the front)                                                                                                                                                                                                                                                                                                                                                                                                         | `store.ts:334`; `core runs.ts:345`                                         |
| `openStream(after)` reset. **Gap**: `after < oldest − 1` → `stream-reset{reason, resumedAfter: oldest − 1}`, resume at the oldest. **Ahead**: `after > latest` (or no events and `after > 0`) → reset, restart at the oldest. With **no cursor** there is no reset even if early events were evicted.                                                                                                                                                                                                                     | `store.ts:436–455` (in memory), `:926–950` (repository)                    |
| Follow: replay strictly after the cursor, then live. In memory the stream ends when `closed ∧ cursor ≥ lastId` (`:472`). The repository re-lists every 250 ms or when woken, and **returns as soon as the run reads terminal after a list** (`:974–981`).                                                                                                                                                                                                                                                                 | `store.ts`                                                                 |
| Resume cursor `readResumeCursor(header, query)`: absent / after / invalid. The header wins, and an invalid header does not fall through. The value is trimmed, must match `/^\d{1,19}$/`, and must be `≤ MAX_EVENT_ID = 2⁶³−1`.                                                                                                                                                                                                                                                                                           | `apps/web/server/runs/cursor.ts:63`; `sse.ts:86`                           |
| `sseStreamResponse` write order: 1. `retry: 3000`. 2. The prelude (`stream-reset`). 3. `sseFrame` per event: `event: N\nid: <bigint>\ndata: <json>\n\n`. 4. The outcome: `succeeded` → `done`; `failed` → `run-failed{status, message}` then `done`; `indeterminate` → `run-failed{status:'unknown', message}` then `done`. 5. On a producer throw: `run-failed{status:'unknown'}` with **no** `done`. Also: keep-alive `: keepalive` every 15 s, one teardown, a 200 whatever happens, and `event: error` never written. | `sse.ts:338`, `:316`, `:331`, `:347`, `:394–516`                           |
| `classifyRunOutcome`: `completed` → succeeded; `failed`/`cancelled` → failed (message = `run.error` or a fallback); `queued`/`running`/missing → indeterminate                                                                                                                                                                                                                                                                                                                                                            | `api.ts:891`                                                               |
| Runner relay: `SseLineSplitter` (CR, LF, CRLF, including across chunks; the tail is discarded) and `SseMessageAssembler` (HTML §9.2; an id containing NUL is ignored). `classifyRunnerResponse` requires 200, `text/event-stream` and a body. Runner terminal frames `run-done`/`run-error`/`run-interrupted` are consumed and not appended; a `sessionId` in them triggers `onSessionIdentified`. Bad JSON, a missing `event:`, or an append refusal makes the run fail.                                                 | `apps/web/server/runs/relay.ts:64`, `:108`, `:155`, `:216`, `:232`, `:266` |
| `run.status` data is `{ status, error }` and is written on running and on each terminal status                                                                                                                                                                                                                                                                                                                                                                                                                            | `launcher.ts:235`, `:366`, `:404`; `register.ts:850`                       |

**SDK side** (`packages/sdk/src/events/`):

- `parseSseFrame` (`sse.ts:33`):
  - Lines split on `\n`. Blank lines and `:` lines are skipped.
  - The last `event`/`id` wins. `data` lines are joined with `\n`.
  - No `event` → `null`. Empty data → `null`. If JSON parsing fails, the raw string is kept.
  - An empty `id:` gives `''`.
- `splitSseFrames` (`:74`) normalises CRLF only.
- `readSseFrames` (`:88`) cancels the reader on abort or early exit.
- `classifyRunEventFrame` (`run-events.ts:49`):
  - `done`, `run-failed`, `stream-reset` and `run.status` are validated against the contract. A mismatch is a `ContractViolationError` with status 200.
  - Every other name becomes `runtime{id, name, data}`.
- `RunEventFrame` (`run-events.ts:24`).
- The neutral `agent.*` vocabulary (ENG-03, #302; `packages/contracts/src/run-events.ts`, SPEC §6.3):
  - `AGENT_FRAME_NAMES` is closed: `agent.session`, `agent.message`, `agent.message.delta`, `agent.tool.call`, `agent.tool.result`, `agent.usage`, `agent.result`, `agent.native`, `agent.malformed`. `AgentFrameSchema` is a discriminated union on `frame`, one strict arm each; every arm carries `engine` and `raw`.
  - `RELAYED_EVENT_NAMES` is retained as the **pre-ENG-03** vocabulary. No writer produces it; the read path recognises it in order to upgrade a stored row.
  - `raw` over `AGENT_FRAME_RAW_MAX_BYTES` (64 KiB) is truncated with `AgentFrameRawTruncationSchema`'s marker, never rejected. The cap is applied by `packages/core`'s `capAgentFrameRaw`; the contract publishes the number and the marker's shape.
- The Claude mapping (`packages/core/src/schemas.ts`):
  - `toAgentFrames(event: ClassifiedSdkEvent, engine?): readonly AgentFrame[]` is pure, never throws and **never returns an empty list**. `ClassifiedSdkEvent` is its input type and names nothing on the wire.
  - `claudeToolKind` gives an ACP kind to the built-ins whose effect is known, `mcp` by prefix, and `other` to everything else. `delete` and `move` are in the neutral set and unused: the SDK deletes and moves through `Bash`.
  - `result` subtypes map to `end_turn` / `max_turns` / `max_budget`, and everything else — an unknown subtype included — to `error`. `refusal` and `cancelled` are unused by this adapter: the SDK reports a refusal as a `system` message, and a cancellation is the control plane's own transition.
- The event-read upgrade (`apps/web/server/runs/agent-frames.ts`):
  - `upgradeStoredEvent` recognises a pre-ENG-03 name positively and re-derives `classifySdkEvent` → `toAgentFrames` over the stored message. Every other stored name is already what the stream serves and is forwarded under its bare sequence.
  - A row whose envelope is not the relay's becomes `agent.malformed` with the stored payload in `raw`.
  - One row's frames are served under `<sequence>.<sub-index>`; `upgradeEventStream` drops what a resumed client already has.
- The SDK parser (`agent-event.ts`, SPEC §6.3):
  - `toAgentEvent(frame)` validates `frame.data` against `AgentFrameSchema`, answers the typed frame, `null` for a platform frame, and a `ContractViolationError` for a payload that does not satisfy its contract or whose `event:` name disagrees with its own `frame` field. It holds no engine vocabulary.
  - `assistantResponseFromAgentEvent(event)`: only an `agent.message` with `role: 'assistant'`, a non-null `messageId` and a non-blank text block becomes an `AssistantResponse`.

### SDK

`RunsClient` (SDK `runs.ts:73`) is wired as `runs` in `createClient` (`packages/sdk/src/index.ts:140`).

Shared plumbing, in `packages/sdk/src/http.ts`:

- `send` (`:280`) makes exactly one fetch.
  - A fetch rejection → `TransportError{aborted}`. `aborted` is true for the caller's signal **or** the headers deadline.
  - A status outside `expect` → `ApiProblemError`, read with `readProblem` (`:144`), which knows the three envelopes. Any other body gives `unrecognised_error_body`, and `Retry-After` is read as seconds.
- `json` (`:310`):
  - A body that is not JSON, or fails the schema → `ContractViolationError`.
  - A 204 → `null`.
- `headersDeadline` (`:98`) covers headers only.
- `combinedSignal` (`:117`).

Error classes are in `errors.ts:18`, `:43` and `:62`.

| Method                                                        | Line | HTTP                                                                                                                        | Expect / schema                                                                                                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start(agentId, {prompt, sessionId?, modelOverride?})`        | 84   | `POST /api/agents/{seg}/runs`, body `{prompt, sessionId ?? null, modelConnectionId, model}` (both null without an override) | 202 / `StartRunResponseSchema`                                                                                                                     | No idempotency key                                                                                                                                                                                                                                                                                                                                                                                          |
| `get(runId)`                                                  | 105  | `GET /api/runs/{seg}`                                                                                                       | 200 / `RunResponseSchema` → `.run`                                                                                                                 |                                                                                                                                                                                                                                                                                                                                                                                                             |
| `interrupt(runId)`                                            | 122  | `POST /api/runs/{seg}/interrupt`, no body                                                                                   | 200 / `InterruptRunResponseSchema` → `.run`                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                             |
| `revokeTokens(runId, {tokenId?})`                             | 138  | `POST /api/runs/{seg}/revoke-tokens`, body `{tokenId ?? null}`                                                              | 200 / `RevokeRunTokensResponseSchema`                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                             |
| `list(query)`                                                 | 155  | `GET /api/runs?` + `runListSearchParams`                                                                                    | 200 / `RunListResponseSchema`                                                                                                                      | No client-side validation                                                                                                                                                                                                                                                                                                                                                                                   |
| `events(runId, {after?})`                                     | 174  | `GET …/events`, `accept: text/event-stream`, `last-event-id: after` when not null                                           | 200; the media type must be `text/event-stream` and there must be a body, otherwise the body is cancelled and a `ContractViolationError` is thrown | Yields `run-status`, `runtime`, `run-failed` and `stream-reset`. **Returns** `{lastEventId}` on `done` (`done` is never yielded). `lastEventId` advances on id-bearing `run-status`/`runtime` frames. A contract error is rethrown. A read error → `TransportError(aborted = the caller's signal)`. EOF without `done` → `TransportError`.                                                                  |
| `follow(runId, {maxReconnects = 5, reconnectDelayMs = 3000})` | 242  | repeated `events`                                                                                                           | —                                                                                                                                                  | Reconnects only when the error is a `TransportError` and the caller's signal is not aborted, so a headers timeout does reconnect. The counter is **cumulative** and never reset. Stop condition: `reconnects ≥ max`. `after` = the last id seen, not reset by `stream-reset`. An abort during the delay → `TransportError{aborted:true}`. `ApiProblemError` and `ContractViolationError` are never retried. |
| `waitForOutcome(runId)`                                       | 285  | `follow` and then `get`                                                                                                     | —                                                                                                                                                  | A non-terminal status after `done` → `ContractViolationError` (operation `runs.waitForOutcome`)                                                                                                                                                                                                                                                                                                             |

### CLI

Commands are in aw `runs.ts:92` (`runCommands`). They are resolved by longest prefix in
`packages/aw/src/commands/index.ts`. The client is always `auth: api-key`.

| Command                  | Line                    | Arguments and flags                                                                                                                                                                                            | SDK call                                                                                                                                                  | Output                                                                                                                                                                                              |
| ------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aw runs start <agent>`  | 93 (impl `start` at 70) | `--prompt` \| `--prompt-file <path\|->` (exactly one; `-` reads stdin once), `--session`, `--model <conn>:<model>` (split at the first `:`, both parts non-empty), `--wait` \| `--follow` (mutually exclusive) | `runs.start`; then `waitForOutcome` or `follow`                                                                                                           | Default: prints `started.run` as a record, pretty JSON or one jsonl line, **not** `{run, events}`. `--wait`/`--follow`: the notice `run <id> started` goes to stderr. `--follow` prints the stream. |
| `aw runs get <id>`       | 99                      | —                                                                                                                                                                                                              | `runs.get`                                                                                                                                                | The record                                                                                                                                                                                          |
| `aw runs list`           | 102                     | `--status` (enum), `--agent`, `--project`, `--limit` (a positive integer with no cap), `--cursor`                                                                                                              | `runs.list`                                                                                                                                               | human: a notice `next page: --cursor …` plus a table of `RUN_COLUMNS` (`:21`). `--json`/`--jsonl`: the whole page as one value or line.                                                             |
| `aw runs events <id>`    | 129                     | `--after`                                                                                                                                                                                                      | `runs.events`                                                                                                                                             | The stream                                                                                                                                                                                          |
| `aw runs follow <id>`    | 142                     | `--after`, `--interrupt-on-cancel`                                                                                                                                                                             | `runs.follow`; on error with SIGINT and the flag set, `runs.interrupt` with a fresh 5 s signal (`:31`); errors are swallowed and the original is rethrown | The stream                                                                                                                                                                                          |
| `aw runs interrupt <id>` | 168                     | —                                                                                                                                                                                                              | `runs.interrupt`                                                                                                                                          | The record. A 409 exits 1.                                                                                                                                                                          |
| `aw runs wait <id>`      | 173                     | —                                                                                                                                                                                                              | `runs.waitForOutcome`                                                                                                                                     | The settled record. **Exit 0 whatever the status.**                                                                                                                                                 |

Shared CLI rules:

- Arguments (`packages/aw/src/args.ts`): `VALUE_FLAGS` (`:8`), `SWITCH_FLAGS` (`:39`), `parseArguments` (`:118`). Flags are global, so a known but unused flag is ignored.
- Output (`packages/aw/src/output.ts`): `outputMode` (`:30`) and `writeResult` (`:101`). `notice` (`:127`) goes to stderr unless `--quiet`.
- `EXIT_CODE` (`output.ts:7`): ok 0, problem 1, usage 2, contract 3, transport 4, interrupted 130.
- `reportFailure` (`:138`) checks in this order: SIGINT → 130, `UsageError` → 2, `ApiProblemError` → 1, `ContractViolationError` → 3, `TransportError` → 4, anything else → 1.
- Stream rendering (`packages/aw/src/stream.ts`):
  - `renderFrame`: with `--raw`, a platform frame prints as itself and an agent frame prints its `raw` — the engine's own payload (raw wins over `--jsonl`). With `--json` or `--jsonl`, compact JSON: platform frames as themselves (`done` → nothing) and agent frames as the parsed `AgentEvent`. Otherwise human lines (`renderPlatformFrame`, `renderAgentEvent`, a total switch over `AGENT_FRAME_NAMES`).
  - `printStream` (`:79`).
- `revokeTokens` has no CLI command (aw `runs.ts:91`).

**The aw test harness** is `packages/aw/src/testing.ts`:

- `runCli(argv, {route, stdin, env, homeDir, signal})` (`:84`) runs `main()` in process with a fake `CliIo`. It returns `{code, stdout, stderr, calls}`. The fetch double is at `:25`.
- The suites are `packages/aw/src/commands/runs.test.ts`, `stream.test.ts`, `main.test.ts` and `output.test.ts`.

### Normative sentences

Aliases:

| Alias | Path                                                 |
| ----- | ---------------------------------------------------- |
| SPEC  | `docs/sdk/04-api-specification.md`                   |
| RL    | `docs/sdk/site/concepts/run-lifecycle.mdx`           |
| ST    | `docs/sdk/site/guides/streaming.mdx`                 |
| TC    | `docs/sdk/site/guides/timeouts-and-cancellation.mdx` |
| ER    | `docs/sdk/site/guides/errors.mdx`                    |
| RI    | `docs/sdk/site/guides/retries-and-idempotency.mdx`   |
| PG    | `docs/sdk/site/guides/pagination.mdx`                |
| RR    | `docs/sdk/site/resources/runs.mdx`                   |
| SE    | `docs/sdk/site/resources/sessions.mdx`               |
| OX    | `docs/sdk/site/cli/output-and-exit-codes.mdx`        |
| CF    | `docs/sdk/site/cli/configuration.mdx`                |
| OV    | `docs/sdk/site/cli/overview.mdx`                     |
| CV    | `docs/sdk/site/cli/cli-vs-sdk.mdx`                   |

ADRs are cited by file name under `docs/adr/`. An anchor of `#` alone means the page introduction.
⚠ marks a sentence the code contradicts (see [Suspicious points](#suspicious-points-noticed-while-reading)).

#### SPEC (`04-api-specification.md`)

| S    | Sentence (abridged)                                                                                                                                                         | Source                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| S-1  | "A malformed bearer is `401 unauthenticated`; a revoked, expired and unknown key are indistinguishable"                                                                     | SPEC#31-credentials                                                 |
| S-2  | "The SDK never retries a 401."                                                                                                                                              | SPEC#31-credentials                                                 |
| S-3  | "browser-token … scope limited to run/session"                                                                                                                              | SPEC#31-credentials                                                 |
| S-4  | "A browser token resolves to its _minting_ principal … with a `scope` attached that narrows what it may do."                                                                | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-5  | "The minting principal's role is re-read from the directory on every request, never carried in the token"                                                                   | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-6  | "`run` · `GET /api/runs/:id` · Read that run, and only that run."                                                                                                           | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-7  | "`run` · `GET /api/runs/:id/events` · Follow that run's stream."                                                                                                            | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-8  | "`session` · `GET /api/runs/:id` (and `/events`) · Read a run that belongs to that session."                                                                                | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-9  | "`session` · `POST /api/agents/:id/runs` · … `sessionId` required in the body; a request that omits it, or names another session, is refused."                              | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-10 | "Every route outside this table is refused for a browser-token caller."                                                                                                     | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-11 | "…that covers `GET /api/runs` (the workspace-wide list; a scope reads one row, never a collection)" (401 at the edge)                                                       | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-12 | "A route inside the grammar's prefix but outside its cells reaches `decide()` and answers `403 token_out_of_scope`."                                                        | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-13 | "A run scope's `:id` must name the scoped run exactly; a session scope's row identity … is checked where the row is read"                                                   | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-14 | "`60 ≤ ttlSeconds ≤ 3600`, default `300`."                                                                                                                                  | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-15 | "A token stops authenticating when: `expiresAt` passes; the scoped run or session reaches a terminal state …; or its minting principal is revoked."                         | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-16 | "Problem codes: `token_out_of_scope` (403…), `unauthenticated` (401…), `forbidden` (403…), `invalid_field` (400…)"                                                          | SPEC#311-browser-tokens-issue-236-sdk-04-s-1                        |
| S-17 | "The SDK does not encode the table; it surfaces `403 forbidden`."                                                                                                           | SPEC#33-roles                                                       |
| S-18 | "runs · Owner all · Admin read/run any · Builder read/run own · Viewer read/run own"                                                                                        | SPEC#33-roles                                                       |
| S-19 | "Identifiers: UUID v4 text…"                                                                                                                                                | SPEC#4-conventions                                                  |
| S-20 | "Timestamps: ISO-8601 UTC strings. `null` means 'has not happened'."                                                                                                        | SPEC#4-conventions                                                  |
| S-21 | "Money: Decimal strings (`\"0.001234\"`), currency `USD`."                                                                                                                  | SPEC#4-conventions                                                  |
| S-22 | "Items: … **wrapped** (`{ run }`, `{ session }` …)"                                                                                                                         | SPEC#4-conventions                                                  |
| S-23 | "`{ error: { code, message, details? } }` (`ApiProblemSchema`) is the target on every `/api/**` route."                                                                     | SPEC#4-conventions                                                  |
| S-24 | "…the 401/403/500/503 refused by `requireResourceAccess` before any handler runs" use `{ error: { code, detail } }`                                                         | SPEC#4-conventions                                                  |
| S-25 | "`code` is stable; `message` is safe prose; `details` are per-field strings."                                                                                               | SPEC#4-conventions                                                  |
| S-26 | ⚠ "Status: … 202 run accepted … 400 malformed/invalid, 401, 403, 404 (also for cross-tenant — never 403), 409 conflict … 413, 415 … 5xx with a fixed message and no cause." | SPEC#4-conventions                                                  |
| S-27 | ⚠ "Pagination: Cursor: `{ items, nextCursor }` with `limit` ≤ 200; opaque cursor, never an offset. Implemented for runs"                                                    | SPEC#4-conventions                                                  |
| S-28 | ⚠ "`POST /api/agents/:id/runs` accepts `Idempotency-Key` once RF-301 lands (S-6); the SDK sends one per `runs.start` call when configured."                                 | SPEC#4-conventions                                                  |
| S-29 | ⚠ "The client sends `X-Agent-Workspace-Contracts: <version>`; the server may answer `426` when unsupported (S-7)."                                                          | SPEC#4-conventions                                                  |
| S-30 | "Every SDK method takes `{ signal }`; `timeoutMs` bounds headers only."                                                                                                     | SPEC#4-conventions                                                  |
| S-31 | "SessionResource { … status: 'active'\|'archived', resumable … }"                                                                                                           | SPEC#511-sessions-and-transcripts--awsessions                       |
| S-32 | "Problem codes: … `409 session_archived` (read only)…"                                                                                                                      | SPEC#511-sessions-and-transcripts--awsessions                       |
| S-33 | "RunStatus = 'queued'\|'running'\|'completed'\|'failed'\|'cancelled'"                                                                                                       | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-34 | "RunResource { … durationMs\|null … accountingState: 'pending'\|'complete'\|'partial'\|'failed'\|'unavailable' … }"                                                         | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-35 | "StartRunRequest { prompt (≤100 000 chars, non-blank), sessionId?, modelConnectionId?+model? (together) }"                                                                  | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-36 | "Start (202) · `POST /api/agents/:id/runs` · `start(agentId, { prompt, sessionId?, modelOverride? })`"                                                                      | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-37 | "Stream, one connection · `GET /api/runs/:id/events` · `events(id, { after? })`"                                                                                            | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-38 | "Stream with resume · `follow(id, { maxReconnects?, reconnectDelayMs? })`"                                                                                                  | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-39 | "Wait for the settled record · (same + `GET /api/runs/:id`) · `waitForOutcome(id)`"                                                                                         | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-40 | "Revoke gateway tokens (Owner/Admin) · `POST /api/runs/:id/revoke-tokens` (`POST /api/runs/:id` kept, deprecated, for one release)"                                         | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-41 | "`run-status` and `runtime` carry a resume id; `run-failed`, `stream-reset`, `done` do not."                                                                                | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-42 | "`interrupt` is authorised as §3.3's `run` verb — Admin any, Builder and Viewer own"                                                                                        | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-43 | "It writes the run's terminal `cancelled` status and revokes its gateway tokens whether or not the runtime itself can be reached"                                           | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-44 | "a follower observes the transition as a `run-status` frame."                                                                                                               | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-45 | ⚠ "Problem codes: `409 run_not_interruptible` (already terminal), `404 run_not_found`, `400 invalid_run_id`, `503 run_api_not_configured`." (omits `403`)                   | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-46 | "`revokeTokens` answers identically on both paths; the deprecated `POST /api/runs/:id` is removed no sooner than one release after this one."                               | SPEC#512-runs-and-the-event-stream--awruns                          |
| S-47 | "Events · Portable: `run-status`, `run-failed`, `stream-reset`, `done`, and the closed `agent.*` frame set · Engine-native: the engine-native message, capped, in every frame's `raw`" | SPEC#61-what-is-portable-and-what-is-provider-native                |
| S-48 | "Normalisation happens **once, in the runner, by the engine's adapter** (ADR-0065 D5), not in each client."                                                                  | SPEC#63-the-neutral-event-vocabulary                                |
| S-49 | "`toAgentEvent(frame: RunEventFrame): AgentEvent \| null` validates `frame.data` against `AgentFrameSchema` … a `ContractViolationError` for a payload that does not satisfy its contract" | SPEC#63-the-neutral-event-vocabulary                                |
| S-50 | "`AGENT_FRAME_NAMES` = agent.session \| agent.message \| agent.message.delta \| agent.tool.call \| agent.tool.result \| agent.usage \| agent.result \| agent.native \| agent.malformed" | SPEC#63-the-neutral-event-vocabulary                                |
| S-51 | "every arm also carries `{ engine, raw }`"; "`raw` over the cap is truncated with a marker and never rejected"                                                               | SPEC#63-the-neutral-event-vocabulary                                |
| S-52 | "Tool use is **not** a block: it is its own frame"; "`toAgentFrames` … never returns an empty list"                                                                          | SPEC#63-the-neutral-event-vocabulary                                |
| S-53 | "`agent.malformed` is not `agent.native`" — the first is "not well formed, reported by name", the second "well formed, no neutral meaning, forwarded"                          | SPEC#63-the-neutral-event-vocabulary                                |
| S-54 | "`agent.usage` is informational. Billing is gateway-metered in `run_usage_records` (ADR-0065 D6). A counter an engine does not report is `null`, never `0`."                  | SPEC#63-the-neutral-event-vocabulary                                |
| S-55 | "Legacy frames are upgraded on read … replaying an old run yields the same `AgentEvent` sequence as a fresh run of the same messages. There is **no data migration**."        | SPEC#63-the-neutral-event-vocabulary                                |
| S-56 | "Nothing in §5 changes shape for a second provider"                                                                                                                         | SPEC#64-adding-a-provider-the-contract-a-second-engine-must-satisfy |
| S-57 | "aw runs start <agent> --prompt\|--prompt-file [--session] [--model <conn>:<model>] [--wait\|--follow]; aw runs get\|list\|events\|follow\|wait\|interrupt"                 | SPEC#72-command-tree-mirrors-5-one-to-one                           |
| S-58 | "A command exists only for a ✅ row of §5 that the CLI's own credential can reach"                                                                                          | SPEC#72-command-tree-mirrors-5-one-to-one                           |
| S-59 | ⚠ "`--json` emits exactly the contract's JSON (one object, or one object per line for streams with `--jsonl`). `follow` prints `AgentEvent`s; `--raw` prints frames."       | SPEC#73-behaviour                                                   |
| S-60 | "Exit codes: `0` success; `1` `ApiProblemError` …; `2` usage; `3` `ContractViolationError`; `4` `TransportError`; `130` interrupted"                                        | SPEC#73-behaviour                                                   |
| S-61 | "`aw runs follow --interrupt-on-cancel` also stops the run itself on the way out."                                                                                          | SPEC#73-behaviour                                                   |
| S-62 | "S-6 · `Idempotency-Key` on run start (with RF-301)"; "None is required for §5's ✅ rows."                                                                                  | SPEC#8-server-changes-this-specification-requires                   |

#### RL (`concepts/run-lifecycle.mdx`)

| S    | Sentence (abridged)                                                                                                                                            | Source                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| S-63 | "`POST /api/agents/:id/runs` … always answers `202`: the run already exists, with `status: 'queued'`, and the body also carries `events`"                      | RL#from-start-to-a-terminal-status |
| S-64 | "A run's `status` is one of five values, `RUN_STATUSES`"                                                                                                       | RL#from-start-to-a-terminal-status |
| S-65 | "`queued` and `running` are live; the other three are terminal, and a terminal run's event stream replays and ends rather than follows."                       | RL#from-start-to-a-terminal-status |
| S-66 | "`isTerminalRunStatus(status)` is the exported predicate"                                                                                                      | RL#from-start-to-a-terminal-status |
| S-67 | ⚠ The state diagram draws only `queued → running → {completed, failed, cancelled}` (F-001)                                                                     | RL#from-start-to-a-terminal-status |
| S-68 | "`aw.runs.waitForOutcome(id)` … follow the stream to its end, then read the record — in one call."                                                             | RL#from-start-to-a-terminal-status |
| S-69 | "`totalTokens` (the sum of the four)"                                                                                                                          | RL#usage-cost-and-accounting       |
| S-70 | "`amount` as a decimal _string_ (never a float — `\"0.000000\"` before accounting settles) … `priceTableVersion` (`null` until priced)"                        | RL#usage-cost-and-accounting       |
| S-71 | "Only `'complete'` is a settled answer; `accountingError` carries why when it is not."                                                                         | RL#usage-cost-and-accounting       |
| S-72 | "A run's `status` reaching a terminal value and its `accountingState` reaching `'complete'` are two separate facts"                                            | RL#usage-cost-and-accounting       |
| S-73 | "Every run belongs to exactly one session (`RunResource.sessionId`), and a session can hold many runs."                                                        | RL#sessions-group-runs             |
| S-74 | "pass an existing session's id to continue it … or omit it (or send `null`) to start a new one."                                                               | RL#sessions-group-runs             |
| S-75 | "`GET /api/runs/:id/events` is a `text/event-stream`"                                                                                                          | RL#the-event-stream                |
| S-76 | "Control frames (`done`, `run-failed`, `stream-reset`) … carry no `id:` and never move the resume cursor."                                                     | RL#the-event-stream                |
| S-77 | "`run.status` — durable and replayable, appended whenever the run's `status` changes. Its `id:` is a resume cursor."                                           | RL#the-event-stream                |
| S-78 | "Relayed provider events … also carry a resume `id:` … surfaced as `kind: 'runtime'` frames"                                                                   | RL#the-event-stream                |
| S-79 | "`done` is not success. It means _this connection is finished delivering frames_ — nothing more."                                                              | RL#the-event-stream                |
| S-80 | "A run that failed still ends its stream with `done`"                                                                                                          | RL#the-event-stream                |
| S-81 | ⚠ "`run-failed` … `status` is the run's own terminal status, or the literal `\"unknown\"` when producing the stream itself threw"                              | RL#the-event-stream                |
| S-82 | ⚠ "`\"unknown\"` is exactly the case where reconnecting with `Last-Event-ID` is the right move"                                                                | RL#the-event-stream                |
| S-83 | "`stream-reset` means the cursor you resumed from is no longer servable … must discard what it has rendered … not merge."                                      | RL#the-event-stream                |
| S-84 | "Every durable frame's `id:` is a resume cursor. Reconnect by sending it back as the `Last-Event-ID` request header (or the SDK's `after` option)"             | RL#resuming                        |
| S-85 | "`follow` … reconnects up to `maxReconnects` times (default 5), waiting `reconnectDelayMs` … (default 3000, matching the server's own SSE `retry:` value)."    | RL#resuming                        |
| S-86 | "`follow` does not reconnect on a `ContractViolationError` … or on an abort of the caller's own `signal` — only a dropped connection is treated as transient." | RL#resuming                        |
| S-87 | "A run does not choose its own execution environment; the agent it runs against does."                                                                         | RL#where-a-run-executes            |
| S-88 | "[A profile change] takes effect on the agent's next run."                                                                                                     | RL#where-a-run-executes            |
| S-89 | "A reader relying on an exact transition table should treat this as unconfirmed" (the F-001 docs fix closes this)                                              | RL#open-questions                  |

#### ST (`guides/streaming.mdx`)

| S     | Sentence (abridged)                                                                                                                                                                                                      | Source                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| S-90  | "Every frame the platform writes carries an explicit `event:` name (`id:` too, for the frames that can be resumed) and a `data:` payload"                                                                                | ST#the-wire-format                                         |
| S-91  | "Control frames … No `id:`, ever — none of them may move a client's resume cursor."                                                                                                                                      | ST#the-wire-format                                         |
| S-92  | "`RUN_STATUS_EVENT`, the literal string `'run.status'` … appends on every run status change."                                                                                                                            | ST#the-wire-format                                         |
| S-93  | "`RELAYED_EVENT_NAMES`: `system`, `system-unknown`, `result`, `result-unknown`, `sdk-event`, `unknown`, `malformed` … a future SDK type can never collide with a control name."                                          | ST#the-wire-format                                         |
| S-94  | "Durable events (kinds 2 and 3) carry a monotonic `id:`, the resume cursor"                                                                                                                                              | ST#the-wire-format                                         |
| S-95  | "`RunStatusEventDataSchema` — `{ status: RunStatus, error: string \| null }`."                                                                                                                                           | ST#the-wire-format                                         |
| S-96  | "`RunFailedFrameDataSchema` — `{ status: RunStatus \| 'unknown', message: string }`."                                                                                                                                    | ST#the-wire-format                                         |
| S-97  | "`StreamResetFrameDataSchema` — `{ reason: string, resumedAfter: string \| null }`."                                                                                                                                     | ST#the-wire-format                                         |
| S-98  | "`RelayedEventDataSchema` … only `kind` is guaranteed; the rest … passed through unvalidated"                                                                                                                            | ST#the-wire-format                                         |
| S-99  | "RunEventFrame = run-status{id\|null,data} \| runtime{id\|null,name,data} \| run-failed{data} \| stream-reset{data} \| done"                                                                                             | ST#runeventframe-the-classified-shape                      |
| S-100 | "A malformed **platform** frame … is refused as a `ContractViolationError`"                                                                                                                                              | ST#runeventframe-the-classified-shape                      |
| S-101 | "A `runtime` frame is passed through as-is, `data: unknown`; nothing about its shape is validated"                                                                                                                       | ST#runeventframe-the-classified-shape                      |
| S-102 | "[events] yield[s] classified frames until the server's `done` frame."                                                                                                                                                   | ST#events-follow-and-waitforoutcome                        |
| S-103 | ⚠ "If the connection ends or breaks before `done` … it throws a `TransportError`, carrying the last durable event id"                                                                                                    | ST#events-follow-and-waitforoutcome                        |
| S-104 | "A `200` whose `content-type` isn't `text/event-stream` is refused as a `ContractViolationError` (and its body is cancelled…)."                                                                                          | ST#events-follow-and-waitforoutcome                        |
| S-105 | "[waitForOutcome] Drains `follow` to its end, then calls `runs.get`"                                                                                                                                                     | ST#events-follow-and-waitforoutcome                        |
| S-106 | "If the run still reports a non-terminal status after the stream ends … `waitForOutcome` raises a `ContractViolationError`"                                                                                              | ST#events-follow-and-waitforoutcome                        |
| S-107 | ⚠ "the store writes the terminal status before the stream's last frame"                                                                                                                                                  | ST#events-follow-and-waitforoutcome                        |
| S-108 | "Both `events` and `follow` are `AsyncGenerator<RunEventFrame, RunStreamEnd, void>` … `{ lastEventId: string \| null }`"                                                                                                 | ST#events-follow-and-waitforoutcome                        |
| S-109 | "Breaking out of a `for await` loop … cancels the underlying response body rather than leaking the connection."                                                                                                          | ST#early-exit-closes-the-connection                        |
| S-110 | "`maxReconnects = options.maxReconnects ?? 5; reconnectDelayMs = options.reconnectDelayMs ?? 3000`"                                                                                                                      | ST#reconnection                                            |
| S-111 | "On a dropped connection (a `TransportError` whose cause isn't the caller's own signal), `follow` waits `reconnectDelayMs`, then reconnects … `after` set to the last durable event id"                                  | ST#reconnection                                            |
| S-112 | "It gives up and rethrows once `reconnects >= maxReconnects`."                                                                                                                                                           | ST#reconnection                                            |
| S-113 | "It never re-sends a `start`"                                                                                                                                                                                            | ST#reconnection                                            |
| S-114 | "A `timeoutMs` headers deadline firing mid-follow is treated exactly like a network drop and reconnected from"                                                                                                           | ST#reconnection                                            |
| S-115 | "Only the caller's own `options.signal` aborting stops `follow` for good, ending it with a `TransportError` whose `aborted` is `true`."                                                                                  | ST#reconnection                                            |
| S-116 | "A `200` that isn't an event stream … is never retried"                                                                                                                                                                  | ST#reconnection                                            |
| S-117 | "`follow` waits a fixed `reconnectDelayMs` … and ignores the stream's `retry:` field."                                                                                                                                   | ST#reconnection                                            |
| S-118 | "When set (and not `null`), it's sent as the `Last-Event-ID` request header; omit it (or pass `null`) to replay from the beginning of the stream."                                                                       | ST#resuming-with-after-and-last-event-id                   |
| S-119 | "If the server can no longer serve the cursor …, it answers with a `stream-reset` frame instead of silently restarting"                                                                                                  | ST#resuming-with-after-and-last-event-id                   |
| S-120 | "`resumedAfter` is the oldest id the stream can actually start after (`null` when nothing is retained)."                                                                                                                 | ST#resuming-with-after-and-last-event-id                   |
| S-121 | "the frame is yielded as-is, both by `events` and by `follow` (it doesn't trigger a reconnect on its own…)"                                                                                                              | ST#resuming-with-after-and-last-event-id                   |
| S-122 | ⚠ "`done` means the stream is over — nothing further will be delivered on this or any later connection. It says nothing about whether the run _succeeded_."                                                              | ST#what-done-does-and-does-not-mean                        |
| S-123 | "the run's actual settled outcome is `runs.get(runId)` … `status` … and `error`."                                                                                                                                        | ST#what-done-does-and-does-not-mean                        |
| S-124 | "`readSseFrames(body, signal?)` reassembles frames across chunk boundaries (including a multi-byte UTF-8 character split…) and cancels the reader when the consumer stops … or `signal` aborts."                         | ST#using-the-parsers-directly-on-a-stream-you-already-hold |
| S-125 | "`toAgentEvent` returns `null` for the platform's own frames … A payload that does not satisfy its schema … is a `ContractViolationError`"                                                                                | ST#the-neutral-agentevent-view                             |
| S-126 | "There is no fan-out function any more, and none is needed: a tool call and a tool result are frames of their own on the wire, so one frame is exactly one event."                                                        | ST#the-neutral-agentevent-view                             |
| S-127 | "A durable event's id is `<sequence>` or `<sequence>.<sub-index>` … ordering is `(sequence, sub-index)` … strictly increasing … so `Last-Event-ID` can name any frame"                                                    | ST#the-id-grammar                                          |
| S-128 | "only an `agent.message` with `role: 'assistant'`, a non-null `messageId` and at least one non-blank text block becomes an `AssistantResponse`"                                                                           | ST#the-neutral-agentevent-view                             |
| S-129 | "`agent.message` … a `messageId` that repeats across a growing snapshot"; "`blocks` is text and reasoning; tool use is not a block"                                                                                       | ST#agentevent-variants                                     |
| S-130 | "`agent.tool.result` … `status` says whether the call ran; `isError` is the engine's verdict on the answer"                                                                                                               | ST#agentevent-variants                                     |
| S-131 | "`agent.usage` … informational. Billing is metered at the gateway"; "a counter the engine did not report is `null`, never `0`"                                                                                            | ST#agentevent-variants                                     |
| S-132 | "`agent.native` … Never dropped, never interpreted — `type` is the engine's own name for the message. This frame is what makes the closed set safe."                                                                      | ST#agentevent-variants                                     |
| S-133 | "`AgentMessageBlock` … stay on the message _as well as_ being fanned out"                                                                                                                                                | ST#agentevent-variants                                     |

#### TC, ER, RI, PG (guides)

| S     | Sentence (abridged)                                                                                                                                                                                            | Source                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| S-134 | "`timeoutMs` … Does not bound how long an open event stream (`runs.events` / `runs.follow`) stays connected"                                                                                                   | TC#timeoutms-covers-response-headers-only                          |
| S-135 | "a `timeoutMs` expiry is … a `TransportError` with `aborted: true`, and `cause` is the `DOMException` named `TimeoutError`"                                                                                    | TC#a-timeout-surfaces-as-transporterror                            |
| S-136 | "Whichever fires first wins" (the caller's signal vs the deadline)                                                                                                                                             | TC#combinedsignal-your-signal-and-the-deadline-merged              |
| S-137 | "for `runs.events` / `runs.follow` [a caller signal] ends the stream at any point …, in every case as a `TransportError` with `aborted: true`."                                                                | TC#a-callers-signal-ends-the-request--or-the-stream--at-any-point  |
| S-138 | "`follow` treats [a timeout] exactly the same way: as a dropped connection to reconnect from with `Last-Event-ID`, up to `maxReconnects` (default 5) with `reconnectDelayMs` (default 3000)"                   | TC#follow-reconnects-after-a-timeout-only-your-own-signal-ends-it  |
| S-139 | "The only thing that stops `follow` for good is your own `options.signal` having aborted"                                                                                                                      | TC#follow-reconnects-after-a-timeout-only-your-own-signal-ends-it  |
| S-140 | "this is the only reliable way to stop a `follow` loop for good"                                                                                                                                               | TC#aborting-a-follow-loop-from-the-outside                         |
| S-141 | "Every call … fails in exactly one of three typed ways, or resolves with a validated value."                                                                                                                   | ER#                                                                |
| S-142 | "[ApiProblemError] Thrown whenever a response status isn't one of the ones the call expected"                                                                                                                  | ER#apiproblemerror-the-server-answered-and-refused                 |
| S-143 | "`details` … `[]` otherwise"; "`retryAfterSeconds` — parsed from `Retry-After`, or `null`"                                                                                                                     | ER#apiproblemerror-the-server-answered-and-refused                 |
| S-144 | "If none of the three parses … `code` is `unrecognised_error_body`"                                                                                                                                            | ER#three-envelope-spellings-one-shape                              |
| S-145 | "Never retry a `ContractViolationError`."                                                                                                                                                                      | ER#contractviolationerror-the-response-does-not-match-the-contract |
| S-146 | "`runs.events` and `runs.follow` raise the same error for a platform frame … whose `data` fails its schema, and for a `200` … whose `content-type` isn't `text/event-stream`"                                  | ER#contractviolationerror-the-response-does-not-match-the-contract |
| S-147 | "`aborted` — `true` when an `AbortSignal` … is why there's no response; `false` for every other network failure (… the connection dropping mid-stream…)"                                                       | ER#transporterror-no-response-arrived                              |
| S-148 | ⚠ "`unauthenticated` 401; `forbidden` 403; `authorisation_undecidable` 500; `malformed_body` 400; `invalid_body` 400; `unsupported_media_type` 415; `request_body_too_large` 413 …; `service_unavailable` 503" | ER#common_problem_codes                                            |
| S-149 | "`@indx-workspace/sdk` performs no automatic retry for ordinary requests, and has no idempotency-key mechanism."                                                                                              | RI#                                                                |
| S-150 | "The only built-in retry … is `runs.follow()`'s reconnect … never a resend of a `start`."                                                                                                                      | RI#                                                                |
| S-151 | "Every other method — `agents.get`, `runs.start`, … makes exactly one request and settles exactly once."                                                                                                       | RI#the-one-built-in-retry-follows-reconnect                        |
| S-152 | "`TransportError` with `aborted === true` · No, not automatically"; "`ApiProblemError` 429 or 503 · Yes, honouring `retryAfterSeconds`"                                                                        | RI#whats-safe-to-retry-yourself                                    |
| S-153 | "Calling `runs.start` twice with the same prompt creates two runs."                                                                                                                                            | RI#runsstart-is-not-idempotent                                     |
| S-154 | "nothing in `StartRunRequestSchema` accepts [an idempotency key]"; "`RunListQuery` has no `sessionId` field"                                                                                                   | RI#runsstart-is-not-idempotent                                     |
| S-155 | "`user` · Honoured only for … `owner`/`admin`; otherwise `403 user_filter_forbidden`."                                                                                                                         | PG#runslist--the-only-cursor-paged-operation                       |
| S-156 | "`limit` Default … (20), maximum … (200)"; "`cursor` Exactly the `nextCursor` of a previous page — opaque"                                                                                                     | PG#runslist--the-only-cursor-paged-operation                       |
| S-157 | "`runs` is one page, newest first. `nextCursor` is `null` exactly when there is no next page"                                                                                                                  | PG#runslist--the-only-cursor-paged-operation                       |
| S-158 | "Nothing else in the response tells you how many runs exist in total"                                                                                                                                          | PG#runslist--the-only-cursor-paged-operation                       |
| S-159 | "`--json`/`--jsonl` output skips the notice and returns the raw page (`{ runs, nextCursor }`)"                                                                                                                 | PG#the-cli---cursor----limit                                       |

#### RR (`resources/runs.mdx`) and SE (`resources/sessions.mdx`)

| S     | Sentence (abridged)                                                                                                                                                                                                                   | Source              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| S-160 | "Starting a run is asynchronous: the server answers as soon as the run is queued"                                                                                                                                                     | RR#                 |
| S-161 | "`RunResource` … is what `get`, `list`, and the `202` of `start` all render. Dates are ISO-8601 strings."                                                                                                                             | RR#the-run-record   |
| S-162 | "`initiatingUserId` … `null` for a run started with an API key."                                                                                                                                                                      | RR#the-run-record   |
| S-163 | "A terminal run's event stream replays what happened and ends"                                                                                                                                                                        | RR#the-run-record   |
| S-164 | "`durationMs` … `null` until both `startedAt` and `endedAt` exist."                                                                                                                                                                   | RR#the-run-record   |
| S-165 | "`totalTokens` is derived server-side as the sum of the four token counters."                                                                                                                                                         | RR#the-run-record   |
| S-166 | "`amount` is a decimal string … `\"0.000000\"` until accounting settles. `priceTableVersion` is `null` until it does too."                                                                                                            | RR#the-run-record   |
| S-167 | "`error` The safe public failure text, or `null` while the run is live or ended well."                                                                                                                                                | RR#the-run-record   |
| S-168 | "`complete` is the only settled answer; treat `usage`/`cost` as provisional otherwise."                                                                                                                                               | RR#the-run-record   |
| S-169 | "The `202` response means the run exists and is `queued` — nothing has necessarily executed yet."                                                                                                                                     | RR#start            |
| S-170 | "`started.events === /api/runs/${id}/events`"                                                                                                                                                                                         | RR#start            |
| S-171 | "`prompt` Non-blank after trimming, at most `MAX_PROMPT_CHARS` (`100_000`) code units."                                                                                                                                               | RR#start            |
| S-172 | "`sessionId` Continue an existing session, or omit/`null` to start one."                                                                                                                                                              | RR#start            |
| S-173 | "A connection and a model always travel together — the contract refuses a body that sets one without the other"                                                                                                                       | RR#start            |
| S-174 | ⚠ start codes: "503 run_api_not_configured; 401 unauthenticated; 403 forbidden; 500 authorisation_undecidable; 400 invalid_agent_id; 400 invalid_body; 404 agent_not_found; 409 session_not_usable" (omits `token_out_of_scope`)      | RR#start            |
| S-175 | ⚠ get codes: "503; 401; 400 invalid_run_id; 404 run_not_found; 403 forbidden" (omits `token_out_of_scope` and `500`)                                                                                                                  | RR#get              |
| S-176 | "One page of the workspace's run history, newest first. This is the only cursor-paginated resource"                                                                                                                                   | RR#list             |
| S-177 | "`to` … must not be before `from`."                                                                                                                                                                                                   | RR#list             |
| S-178 | ⚠ "`user` … Only honoured for … Owner or Admin — a narrower caller gets their own runs regardless …, and setting it explicitly is a `403`."                                                                                           | RR#list             |
| S-179 | "`limit` Default (`20`), maximum (`200`)."; "`cursor` Exactly the `nextCursor` of a previous page."                                                                                                                                   | RR#list             |
| S-180 | list codes: "400 invalid_limit …; invalid_cursor; invalid_status; invalid_agent; invalid_project; invalid_provider; invalid_model (empty); invalid_from; invalid_to; invalid_date_range; 403 user_filter_forbidden; 400 invalid_user" | RR#list             |
| S-181 | "[events] yield classified frames until the server's `done` frame."                                                                                                                                                                   | RR#events           |
| S-182 | "`run-status` … appended on every run status change. `id` is a resume cursor."                                                                                                                                                        | RR#events           |
| S-183 | "`runtime` … `id` is a resume cursor and `data` … passed through unvalidated."                                                                                                                                                        | RR#events           |
| S-184 | ⚠ "`run-failed` … `status` is … or `\"unknown\"` … reconnecting with the last event id is the right response."                                                                                                                        | RR#events           |
| S-185 | "`stream-reset` What follows is not contiguous …. `resumedAfter` is the oldest id the stream can actually resume from, or `null`"                                                                                                     | RR#events           |
| S-186 | "`done` The stream is over. This says nothing about whether the run succeeded"                                                                                                                                                        | RR#events           |
| S-187 | "`run-status` and `runtime` are the only kinds that carry a resume cursor (`id`)."                                                                                                                                                    | RR#events           |
| S-188 | "Omit `after` to replay the stream from the beginning. `events` itself does not reconnect — it throws a `TransportError` if the connection ends or breaks before `done`"                                                              | RR#events           |
| S-189 | events codes: "503; 401; 400 invalid_run_id; 400 invalid_resume_cursor …; 404 run_not_found; 403 forbidden"                                                                                                                           | RR#events           |
| S-190 | "`maxReconnects: 5` default 5; `reconnectDelayMs: 3000` default 3000, the server's own SSE `retry:` value"                                                                                                                            | RR#follow           |
| S-191 | "It throws once reconnection is exhausted, or immediately for any error that is not a dropped connection"                                                                                                                             | RR#follow           |
| S-192 | "A `stream-reset` frame is yielded as-is, not swallowed"                                                                                                                                                                              | RR#follow           |
| S-193 | "Aborting the `signal` … ends the stream with a `TransportError` whose `aborted` is `true` … the _only_ thing that ends a `follow` early from the outside"                                                                            | RR#follow           |
| S-194 | "Stopping iteration yourself … also closes the underlying connection"                                                                                                                                                                 | RR#follow           |
| S-195 | "Problem codes: the same as `events` — `follow` … does not introduce its own."                                                                                                                                                        | RR#follow           |
| S-196 | "`waitForOutcome` drains `follow` … and then calls `get`."                                                                                                                                                                            | RR#waitforoutcome   |
| S-197 | "If the stream ends but the run's own record still reports a live status … it raises a `ContractViolationError`"                                                                                                                      | RR#waitforoutcome   |
| S-198 | ⚠ "the store is expected to write the terminal status before the stream's `done` frame"                                                                                                                                               | RR#waitforoutcome   |
| S-199 | "[toAgentEvent] returns `null` for the platform's own frames … and never throws."                                                                                                                                                     | RR#the-neutral-view |
| S-200 | "closing your own connection … does not stop the run itself."                                                                                                                                                                         | RR#interrupt        |
| S-201 | "`interrupt` makes the run terminal: it writes `cancelled` and revokes the run's gateway tokens even when the runtime itself cannot be reached"                                                                                       | RR#interrupt        |
| S-202 | "a follower observes the transition as a `run-status` frame either way."                                                                                                                                                              | RR#interrupt        |
| S-203 | "Admin any run in the workspace, Builder and Viewer their own."                                                                                                                                                                       | RR#interrupt        |
| S-204 | "`aw runs follow --interrupt-on-cancel <id>` calls this on SIGINT, after the stream itself has been cancelled, so the exit code stays `130`."                                                                                         | RR#interrupt        |
| S-205 | interrupt codes: "503; 401; 400 invalid_run_id; 404 run_not_found; 403 forbidden; 409 run_not_interruptible"                                                                                                                          | RR#interrupt        |
| S-206 | "Revoke one, or every active, gateway token … Owner and Admin only"; "the old, unnamed `POST /api/runs/:id` answers identically and is kept for one release."                                                                         | RR#revoketokens     |
| S-207 | ⚠ revokeTokens codes: "503; 401; 403 run_token_revoke_forbidden; 400 invalid_run_id; 404 run_not_found; 400 invalid_token_id" (omits `token_out_of_scope` and `invalid_body`)                                                         | RR#revoketokens     |
| S-208 | ⚠ "`resumable` … is derived, not stored: `true` exactly when `status === 'active'` and `claudeSessionId` is not `null`"                                                                                                               | SE#session_statuses |
| S-209 | "an API-key (`runner`) principal sees only the one session named in its signed per-run claim"                                                                                                                                         | SE#list             |
| S-210 | "`session_archived` · 409 · The session is archived; restore it before reading its transcript."                                                                                                                                       | SE#transcriptread   |

#### CLI pages (OX, CF, OV, CV)

| S     | Sentence (abridged)                                                                                                                                                                   | Source                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| S-211 | "Three commands print the whole envelope … `runs list` · `nextCursor`"                                                                                                                | OX#--json                                               |
| S-212 | "Every `--json` value round-trips through the corresponding `@indx-workspace/contracts` schema"                                                                                      | OX#--json                                               |
| S-213 | "A stream (`runs events`/`follow`, `runs start --follow`) prints one line per event."                                                                                                 | OX#--jsonl                                              |
| S-214 | "An envelope value (`runs list` …) prints as one line holding the whole object"                                                                                                       | OX#--jsonl                                              |
| S-215 | ⚠ "For `runs events`, `runs follow`, and `runs start --follow\|--wait`: prints the classified `RunEventFrame` exactly as received"                                                    | OX#--raw-streams-only                                   |
| S-216 | ⚠ "A platform frame … has no neutral view either way and always prints as itself, told apart by its `kind`"                                                                           | OX#--raw-streams-only                                   |
| S-217 | ⚠ "Combine with `--json`/`--jsonl` to get the raw frames as JSON instead of the human rendering."                                                                                     | OX#--raw-streams-only                                   |
| S-218 | "[notices] never mix into stdout" (`run <id> started`, `next page: --cursor …`)                                                                                                       | OX#--quiet                                              |
| S-219 | "A failure always writes to stderr, never stdout … `error: <code>: <message>`"                                                                                                        | OX#errors-on-stderr                                     |
| S-220 | "0 success; 1 ApiProblemError; 2 usage …; 3 ContractViolationError — never retry; 4 TransportError: network failure, or `--timeout` elapsed before response headers; 130 interrupted" | OX#exit-codes                                           |
| S-221 | "Anything unexpected … also exits `1`, printed as `error: unexpected: <message>`"                                                                                                     | OX#exit-codes                                           |
| S-222 | "`Ctrl-C` aborts the `AbortSignal` every request and stream in flight was given, prints `interrupted` on stderr, and exits `130` — this takes priority over any other failure"        | OX#sigint                                               |
| S-223 | "`run_id=$(aw runs start … --json \| jq -r '.id')`" (`runs start --json` prints the run object)                                                                                       | OX#scripting-recipes                                    |
| S-224 | "[--timeout] covers only the wait for response headers … a streamed run body can stay open indefinitely regardless of `--timeout`."                                                   | CF#--timeout-and-the-sdks-timeout                       |
| S-225 | "An unrecognized `--flag` is refused before any command runs (exit `2`)."                                                                                                             | CF#every-flag                                           |
| S-226 | "`--after` · `runs events`, `runs follow`"; "`--model` · `runs start` (`<connection-id>:<model>`)"                                                                                    | CF#value-flags---name-value---namevalue-or---name-value |
| S-227 | ⚠ "`--wait` · `runs start`; `--follow` · `runs start`; `--raw` …" (omits `--interrupt-on-cancel`)                                                                                     | CF#switches-no-value                                    |
| S-228 | "`--follow` streams the run and prints the neutral `AgentEvent` view …. `--wait` instead follows silently and prints the settled run record once it ends."                            | OV#the-five-minute-tour                                 |
| S-229 | "`aw runs follow <run-id>` # reconnects with the last event id if the connection drops"                                                                                               | OV#the-five-minute-tour                                 |
| S-230 | "`aw.runs.waitForOutcome(id)` · `aw runs wait <id>` (also `runs start --wait`)"                                                                                                       | CV#command-to-method-table                              |

#### Governing ADRs

These ADRs are **not** D1-normative, so they have no S-n number:

- UI-only: W9-PLAN-run-detail-is-a-panel, W9-PLAN-the-run-list-card-assumed-an-admin-grant, W9-UI-136 (durable-polling, catalogue-resolved-names, session-link), W1-UI-03-the-first-message-starts-a-screen.
- PROPOSED: FORMAL-P1-documented-row-invariants-are-checks (provider `oneOf`), FORMAL-P1-one-owner-vocabulary.
- Historical: W1-INF-01-the-gateway-placeholder-refuses.
- Packaging only: W9-MODEL-129-gateway-registry-subpath-export.
- Runtime-driver: ADR-cloud-run-service-driver, W3-QA-02.

No ADR governs `AgentEvent`, the `aw runs` commands, the run-token issue and verify lifecycle, or
run- and session-scoped browser tokens. Those rules are stated only in SPEC and the site pages
above.

| S     | Sentence (abridged)                                                                                                                                                                                                         | Source (`docs/adr/…`)                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| S-231 | "PostgreSQL `run_events` is the production source of truth… Production composition does not silently fall back to the in-memory adapter."                                                                                   | RF-001-durable-run-events-are-the-production-authority.md#decision                                                                         |
| S-232 | "primary key is `(run_id, sequence)`. Append takes a transaction-level advisory lock… verifies… Run exists and is nonterminal… Terminal transition takes the same lock… no append is admitted afterward."                   | RF-001-…#decision                                                                                                                          |
| S-233 | ⚠ "A stream reads committed rows after its cursor in sequence order… bounded polling observes events written by another process or before a restart."                                                                       | RF-001-…#decision                                                                                                                          |
| S-234 | ⚠ "Append removes rows older than the configured event limit… the server never pretends that truncated replay is contiguous."                                                                                               | RF-001-…#decision                                                                                                                          |
| S-235 | "`InMemoryRunStore` is a test adapter, not a deployment mode."                                                                                                                                                              | RF-001-…#decision                                                                                                                          |
| S-236 | "`RunStore` is defined as 'replay from an event id, then follow'… `after === null`… is a named case." (superseded ADR; port contract still binds)                                                                           | W1-CP-04-run-events-are-in-process-in-wave-1.md#decision                                                                                   |
| S-237 | "a PostgreSQL adapter… **must** subscribe first, buffer, then read the backlog, then drop buffered events whose id it already replayed."                                                                                    | W1-CP-04-run-events-are-in-process-in-wave-1.md#decision                                                                                   |
| S-238 | "Retention is bounded per run, and exhausting it is announced… `stream-reset`."                                                                                                                                             | W1-CP-04-run-events-are-in-process-in-wave-1.md#decision                                                                                   |
| S-239 | "`openStream` arms the waiter **before** re-testing the condition, and any adapter that reimplements the follow loop has to do the same."                                                                                   | W1-CP-04-run-events-are-in-process-in-wave-1.md#decision                                                                                   |
| S-240 | "Persist the record. Keep the event log in process." (SUPERSEDED by RF-001; historical, not modelled)                                                                                                                       | W2-DB-02-the-run-event-log-has-no-table.md#decision                                                                                        |
| S-241 | "`sseStreamResponse` requires its caller to state the run's outcome… `outcome` … is **not optional**."                                                                                                                      | W1-CP-04-a-finished-stream-is-not-a-finished-run.md#decision                                                                               |
| S-242 | "`succeeded` → `done`; `failed` → `run-failed` {status,message}, then `done`; `indeterminate` → `run-failed` {status:\"unknown\"}, then `done`."                                                                            | W1-CP-04-a-finished-stream-is-not-a-finished-run.md#decision                                                                               |
| S-243 | "`completed` → `succeeded`; `failed` and `cancelled` → `failed`…; `queued` and `running` → `indeterminate`… unreadable → `indeterminate`…"                                                                                  | W1-CP-04-a-finished-stream-is-not-a-finished-run.md#decision                                                                               |
| S-244 | "The producer's `.catch()` keeps `run-failed`, with `status: \"unknown\"`, and writes no `done`."                                                                                                                           | W1-CP-04-a-finished-stream-is-not-a-finished-run.md#decision                                                                               |
| S-245 | "The durable `run.status` event stays… Both are written; neither is inferred from the other."                                                                                                                               | W1-CP-04-a-finished-stream-is-not-a-finished-run.md#decision                                                                               |
| S-246 | "`classifyRunOutcome` re-reads the run record through `findRunForPrincipal`, after the source is exhausted."                                                                                                                | W1-CP-04-a-finished-stream-is-not-a-finished-run.md#consequences                                                                           |
| S-247 | "Validation happens at ingestion — `RunStore.append` — not at render time."                                                                                                                                                 | W1-CP-04-event-names-are-validated-at-ingestion.md#decision                                                                                |
| S-248 | "`event:` names must match `/^[A-Za-z][A-Za-z0-9._-]{0,63}$/`."                                                                                                                                                             | W1-CP-04-event-names-are-validated-at-ingestion.md#decision                                                                                |
| S-249 | "A relayed event may not use a reserved name… `done`, `run-failed`, `stream-reset` and `error`… `run.status`."                                                                                                              | W1-CP-04-event-names-are-validated-at-ingestion.md#decision                                                                                |
| S-250 | "`RunStore.append` is the relay's only write and refuses every reserved name; `RunStore.appendPlatformEvent` accepts nothing _but_ a platform name…"                                                                        | W1-CP-04-event-names-are-validated-at-ingestion.md#decision                                                                                |
| S-251 | "`renderEventData` is a two-arm verdict… A payload with no JSON representation is rejected."                                                                                                                                | W1-CP-04-event-names-are-validated-at-ingestion.md#decision                                                                                |
| S-252 | "A frame the relay cannot accept fails the run; it is not skipped."                                                                                                                                                         | W1-CP-04-event-names-are-validated-at-ingestion.md#decision                                                                                |
| S-253 | "`sseFrame` still throws… `sseStreamResponse` converts the throw into an in-band `run-failed` frame."                                                                                                                       | W1-CP-04-event-names-are-validated-at-ingestion.md#decision                                                                                |
| S-254 | "`readResumeCursor` returns one of three arms — `absent`, `after`, `invalid`… An invalid header does **not** fall through to the query parameter."                                                                          | W1-CP-04-resume-cursor-failures.md#decision                                                                                                |
| S-255 | "Parsing is digits _and_ range. `/^\d{1,19}$/` then `<= 9223372036854775807n`."                                                                                                                                             | W1-CP-04-resume-cursor-failures.md#decision                                                                                                |
| S-256 | "A malformed cursor is answered with `400 invalid_resume_cursor`, before the run is looked up."                                                                                                                             | W1-CP-04-resume-cursor-failures.md#decision                                                                                                |
| S-257 | "A well-formed but unservable cursor is answered **in band**, with `200` and a `stream-reset` control frame… `reason` and `resumedAfter`."                                                                                  | W1-CP-04-resume-cursor-failures.md#decision                                                                                                |
| S-258 | "Control frames carry no `id:`."                                                                                                                                                                                            | W1-CP-04-resume-cursor-failures.md#decision                                                                                                |
| S-259 | ⚠ "One interface, `RunApiEnvironment`, with five members…" (it now has nine)                                                                                                                                                | W1-CP-04-run-api-is-installed-not-imported.md#decision                                                                                     |
| S-260 | "an uninstalled run API answers `503 run_api_not_configured`… does **not** answer `401`."                                                                                                                                   | W1-CP-04-run-api-is-installed-not-imported.md#decision                                                                                     |
| S-261 | "`authenticate` returning a principal is a positive assertion… `null`… maps to 401."                                                                                                                                        | W1-CP-04-run-api-is-installed-not-imported.md#decision                                                                                     |
| S-262 | "The registry lives on `globalThis`, under `__agentWorkspaceRunApiEnvironment__`."                                                                                                                                          | W1-CP-04-run-api-is-installed-not-imported.md#decision                                                                                     |
| S-263 | ⚠ "The request body is `{ prompt: string, sessionId?: string \| null }` and nothing else. An unknown key is **rejected**." (the model pair was added later)                                                                 | W1-CP-04-start-run-request-shape.md#decision                                                                                               |
| S-264 | "`sessionId` omitted or `null` means 'start a session'; a UUID means 'continue that one'. A session the agent cannot run is `409`."                                                                                         | W1-CP-04-start-run-request-shape.md#decision                                                                                               |
| S-265 | "`prompt` is capped at 100 000 characters… (`MAX_PROMPT_CHARS`)." (these are UTF-16 code units)                                                                                                                             | W1-CP-04-start-run-request-shape.md#decision                                                                                               |
| S-266 | "The response is `202` with `{ run, events }` and a `Location` header pointing at the stream."                                                                                                                              | W1-CP-04-start-run-request-shape.md#decision                                                                                               |
| S-267 | "A run in another workspace is `404`, not `403`… same rule applies to `GET /api/runs/:id` and `GET /api/runs/:id/events`."                                                                                                  | W1-CP-04-start-run-request-shape.md#decision                                                                                               |
| S-268 | "`interruptRun` writes the terminal `cancelled` status (the platform `run.status` event first, then `store.finish`), revokes the run's gateway tokens… and _then_ raises the private `POST {base}/interrupt`."              | SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md#decision                                                                      |
| S-269 | "a caller never sees success for a run whose credential is still live — holds on a single replica for every window, including the `queued` one."                                                                            | SDK-03-RUN-235-…#decision                                                                                                                  |
| S-270 | "`RunStore.markRunning` reports whether _this_ call performed the `queued → running` transition… a launch that did not… sends nothing to the runtime, revokes the token it has just minted, and finalises."                 | SDK-03-RUN-235-…#decision                                                                                                                  |
| S-271 | "a runner-reported `run-interrupted` frame is now a `{ kind: 'cancelled' }` `RelayOutcome`, and the launcher concludes `'cancelled'`."                                                                                      | SDK-03-RUN-235-…#decision                                                                                                                  |
| S-272 | "The live-run registry … is anchored on `globalThis`… scope… exactly one process."                                                                                                                                          | SDK-03-RUN-235-…#decision                                                                                                                  |
| S-273 | "Interrupting a run is spec §21's **`run`** verb… (`POST` + sub `interrupt` → `run`)… Admin `run: 'any'`… Builder and Viewer `run: 'own'`."                                                                                 | SDK-03-RUN-235-…#decision                                                                                                                  |
| S-274 | "The rename is add-then-keep… `revoke-tokens/route.ts` adapter over the **same** `revokeRunTokens` handler; the old `POST /api/runs/[id]` is untouched."                                                                    | SDK-03-RUN-235-…#decision                                                                                                                  |
| S-275 | "The transcript default… an absent `projectKey` becomes the principal's own key… a _declared_ key is still parsed and still compared."                                                                                      | SDK-03-RUN-235-…#decision                                                                                                                  |
| S-276 | "`run_usage_records.price_table_version` becomes nullable. A response captured with no catalogue price is still inserted, at `cost_usd = '0'`…"                                                                             | W9-RUNS-134-accounting-state-is-a-recomputed-ledger-aggregate.md#decision                                                                  |
| S-277 | "`recordUsage` keys a ledger write by `(runId, providerResponseId)`… No existing row → insert… already priced, or this attempt unpriced → `duplicate`… Existing unpriced, this attempt priced → … only the **cost delta**." | W9-RUNS-134-accounting-state-…#decision                                                                                                    |
| S-278 | "`runs.accounting_state` is recomputed on every successful `recordUsage`… `unavailable` … `complete` … `partial`…"                                                                                                          | W9-RUNS-134-accounting-state-…#decision                                                                                                    |
| S-279 | "`markAccountingFailed(runId, reason)`… writes `'failed'` only when … still `'pending'`… a later real settlement… always supersedes an earlier `'failed'`."                                                                 | W9-RUNS-134-accounting-state-…#decision                                                                                                    |
| S-280 | "'The run's transition to a terminal state' is read as the **accounting** state's own transition to a terminal value."                                                                                                      | W9-RUNS-134-settlement-gating-is-within-the-gateway-process.md#decision                                                                    |
| S-281 | "The response's `ReadableStream`… is teed. One branch is forwarded… unbuffered… The other… read by `recordResponseUsage`."                                                                                                  | W9-RUNS-134-settlement-gating-…#decision                                                                                                   |
| S-282 | "The **forwarded** branch's own end-of-stream signal… is held open… until the settlement promise resolves or `settlementTimeoutMs` (default 5000ms) elapses."                                                               | W9-RUNS-134-settlement-gating-…#decision                                                                                                   |
| S-283 | "`conclude()`… reads back the run's settled `cost_usd`… but it does not wait on `accounting_state`… independent."                                                                                                           | W9-RUNS-134-settlement-gating-…#decision                                                                                                   |
| S-284 | "a timeout leaves `accounting_state` at `'pending'`."                                                                                                                                                                       | W9-RUNS-134-settlement-gating-…#consequences                                                                                               |
| S-285 | "`RunRepository.listRuns` is added…"                                                                                                                                                                                        | W9-RUNS-135-durable-run-list.md#decision                                                                                                   |
| S-286 | "`RunRecord.projectId` and `RunRecord.initiatingUserId` are added as _optional_ fields."                                                                                                                                    | W9-RUNS-135-durable-run-list.md#decision                                                                                                   |
| S-287 | "`RunStore.listRuns` is a workspace-id-taking, _optional_ member of the port… no `listRuns` [is] `503`."                                                                                                                    | W9-RUNS-135-durable-run-list.md#decision                                                                                                   |
| S-288 | "`readRun` and `listRuns`… call the same `renderRun`… `durationMs` (`null` unless both timestamps are set)… `usage.totalTokens` (the sum…)."                                                                                | W9-RUNS-135-durable-run-list.md#decision                                                                                                   |
| S-289 | "Cursor pagination is keyset, on `(created_at, id)` descending… opaque — base64url of `{createdAt, id}` — and a malformed one is `400`… `limit + 1`."                                                                       | W9-RUNS-135-durable-run-list.md#decision                                                                                                   |
| S-290 | ⚠ "The `user` filter is gated on the _grant_… `grant !== 'any'` forces `initiatingUserId: principal.userId`… naming `user=`… gets `403 user_filter_forbidden`." (the code forces `ownerPrincipalId`)                        | W9-RUNS-135-durable-run-list.md#decision                                                                                                   |
| S-291 | "No migration, no new index (gap G-6)."                                                                                                                                                                                     | W9-RUNS-135-durable-run-list.md#decision                                                                                                   |
| S-292 | ⚠ "An Admin's `GET /api/runs` is narrowed to the Admin's own runs (gap G-7)." (superseded by W9-AUTH-165; not marked)                                                                                                       | W9-RUNS-135-durable-run-list.md#decision                                                                                                   |
| S-293 | "A run-list cursor's `createdAt` is accepted only in the exact shape the stores mint… one to six fractional digits… plus a calendar check."                                                                                 | W9-RUNS-135-durable-run-list.md#query-plans                                                                                                |
| S-294 | "`createdTo` is inclusive at millisecond precision… `created_at < createdTo + 1 ms`" (added by PostgreSQL, not `Date`)                                                                                                      | W9-RUNS-135-durable-run-list.md#query-plans                                                                                                |
| S-295 | "`from`/`to` are accepted only in a strict, explicit-zone ISO-8601 shape, bounded to years 0001–9999… `400 invalid_from` / `invalid_to`."                                                                                   | W9-RUNS-135-durable-run-list.md#query-plans                                                                                                |
| S-296 | "three inserts and one delete between page one and page two — is a shipped test." (keyset stability)                                                                                                                        | W9-RUNS-135-durable-run-list.md#query-plans                                                                                                |
| S-297 | "`MAX_RUN_LIST_LIMIT = 200`… repository… `api.ts`… `400 invalid_limit`… `InMemoryRunStore`… restates the same constant"                                                                                                     | W9-RUNS-135-durable-run-list.md#query-plans                                                                                                |
| S-298 | ⚠ "`POLICY.admin.byResource.runs` becomes … `READ_ONLY` (`{ read: 'any', write: 'none', run: 'none' }`)." (later widened by SDK-03)                                                                                         | W9-AUTH-165-admin-reads-workspace-run-history.md#decision                                                                                  |
| S-299 | ⚠ "It is a `read` widening only… An Admin still cannot start, cancel, or write a run."                                                                                                                                      | W9-AUTH-165-…#decision                                                                                                                     |
| S-300 | "`read: 'any'` on `runs` reaches all three run read routes… `GET /api/runs/:id/events`… `200`."                                                                                                                             | W9-AUTH-165-…#decision                                                                                                                     |
| S-301 | "It does not touch `sessions`… It is not a tenancy change."                                                                                                                                                                 | W9-AUTH-165-…#decision                                                                                                                     |
| S-302 | "One run per container…" (replaced by `maxConcurrentRuns` and 0049)                                                                                                                                                         | W1-RN-02-runtime-http-contract-refusals.md#decision                                                                                        |
| S-303 | "`POST /interrupt` with nothing in flight answers 409… `no_run_in_flight`."                                                                                                                                                 | W1-RN-02-runtime-http-contract-refusals.md#decision                                                                                        |
| S-304 | "Contract paths that are not implemented answer 501, not 404."                                                                                                                                                              | W1-RN-02-runtime-http-contract-refusals.md#decision                                                                                        |
| S-305 | ⚠ "Inside an established stream, nothing changes the status code… terminal frames `done` / `run-interrupted` / `run-failed`." (now `run-done`/`run-error`)                                                                  | W1-RN-02-runtime-http-contract-refusals.md#decision                                                                                        |
| S-306 | "Event names come from the classification, not from the SDK's `type` string."                                                                                                                                               | W1-RN-02-runtime-http-contract-refusals.md#decision                                                                                        |
| S-307 | "`202` on `POST /interrupt` means the signal was raised, not that the subprocess has exited."                                                                                                                               | W1-RN-02-runtime-http-contract-refusals.md#consequences                                                                                    |
| S-308 | "A run is refused with `409 session_in_flight` if any run already in flight on this runtime shares its `sessionId`…"                                                                                                        | 0049-a-session-scoped-workspace-refuses-its-own-concurrent-run-not-just-its-duplicate.md#decision                                          |
| S-309 | "`run.interrupted ? 'run-interrupted' : failure === null ? 'run-done' : 'run-error'`"                                                                                                                                       | W1-RN-03-terminal-frame-name-is-decided-from-interrupted-first.md#decision                                                                 |
| S-310 | "The runner's terminal frame is renamed `run-done` / `run-error`, keeping `run-interrupted`."                                                                                                                               | W1-COMP-01-the-runners-own-terminal-frame-collided-with-the-relays-reserved-names.md#decision                                              |
| S-311 | ⚠ "`relay.ts` now reads the runner's terminal frame as the run's outcome… `run-interrupted` → `{ kind: 'failed', … }`." (superseded by SDK-03 → `cancelled`)                                                                | W1-COMP-01-the-runners-own-terminal-frame-…#decision                                                                                       |
| S-312 | "None of the three is appended to the store as a relayed event."                                                                                                                                                            | W1-COMP-01-the-runners-own-terminal-frame-…#decision                                                                                       |
| S-313 | "A forged `done` or `run-failed` is still refused."                                                                                                                                                                         | W1-COMP-01-the-runners-own-terminal-frame-…#decision                                                                                       |
| S-314 | "`RunnerLauncherOptions` gains `buildRunRequest(context)`, required, with no default… ends with `RunRequest.parse`."                                                                                                        | W1-COMP-01-the-launcher-does-not-know-the-body.md#decision                                                                                 |
| S-315 | "A body that cannot be built fails the run, and posts nothing… `markRunning`, a `running` platform event, then `failed`."                                                                                                   | W1-COMP-01-the-launcher-does-not-know-the-body.md#consequences                                                                             |
| S-316 | "Event names come from the classifier … `malformed` is yielded, not thrown."                                                                                                                                                | W1-RN-01-event-normalisation-at-the-boundary.md#decision                                                                                   |
| S-317 | "Cancellation is `AbortController`, not `Query.interrupt()`… §14.3's `POST /interrupt` maps onto that."                                                                                                                     | W1-RN-01-event-normalisation-at-the-boundary.md#decision                                                                                   |
| S-318 | "`tools` and `skills`… **required** by `toSdkOptions`, which throws by name when either is absent."                                                                                                                         | W1-RN-01-event-normalisation-at-the-boundary.md#decision                                                                                   |
| S-319 | "`durable: true` is returned **only** when… stream was exhausted… no error… a `result` event arrived… at least one `append()` call **resolved**."                                                                           | W1-RN-01-session-durability-is-a-verdict.md#decision                                                                                       |
| S-320 | "`live.ts` reads the response body of `fetch(eventsUrl)` … parses the… SSE wire format by hand… Every frame … reaches the caller."                                                                                          | W1-UI-05-the-composer-parses-sse-frames-by-hand.md#decision                                                                                |
| S-321 | "The database run store resolves a run's workspace with one query that is scoped by run id alone — `findRunWorkspace`… returns a **workspace id and no row content**… memoised per run id."                                 | W2-DB-02-the-run-port-is-not-scope-bound.md#decision                                                                                       |
| S-322 | "`SessionRepository` has two methods, `ensure` and `get`, over three columns." (stale)                                                                                                                                      | W2-DB-02-a-run-needs-a-session-row.md#decision                                                                                             |
| S-323 | ⚠ "`openSession` in the composition root therefore still **refuses** a requested session id and answers `null`." (stale: the code resumes owned sessions)                                                                   | W2-DB-02-a-run-needs-a-session-row.md#decision                                                                                             |
| S-324 | "No fallback to memory, at all, ever, in any deployment mode."                                                                                                                                                              | W2-DB-02-no-silent-memory-fallback.md#decision                                                                                             |
| S-325 | "The seam is installed because a query succeeded (`select 1`)."                                                                                                                                                             | W2-DB-02-no-silent-memory-fallback.md#decision                                                                                             |
| S-326 | "`findAgent` and `openSession` each call it… `if (!(await runGate.isUsable(principal.workspaceId))) return null;`"                                                                                                          | W9-WS-119-run-gate-module-and-project-sessions.md#1-one-module-appswebserverworkspacesrun-gatets-owns-the-predicate-and-the-gate           |
| S-327 | "calls the REAL `register()`… deleting either call-site line… makes this test's post-archive assertions fail."                                                                                                              | W9-WS-119-…#2-the-call-sites-get-a-composition-root-integration-test-not-just-the-predicate                                                |
| S-328 | ⚠ "`guardSessionCreation`… `ensure`… checks the gate first… refusal… reported as `{ kind: 'not-a-member' }`." (code: `unknown-principal`)                                                                                   | W9-WS-119-…#3-configureprojectsruntimes-sessions-provider-is-wrapped-not-the-route                                                         |
| S-329 | "`runPublic`… opens with the same one-line check… before the session `ensure` and the run `store.create`."                                                                                                                  | W9-WS-119-…#4-runpublic-is-wired-to-the-same-gate-and-proved-through-the-runtime-registry-not-http                                         |
| S-330 | "`archive-gate.ts` exposes `isProjectUsableForNewWork`… each [seam] is one line delegating here." (the resume branch of `openSession` → `409 session_not_usable`)                                                           | W9-PROJ-183-archive-routes-conceal-and-gate-execution.md#decision                                                                          |
| S-331 | "Only creation paths are gated, so a run in flight when its project is archived finishes normally."                                                                                                                         | W9-PROJ-183-…#consequences                                                                                                                 |
| S-332 | "the gate reads the **destination**" (moving a session out is not refused)                                                                                                                                                  | W9-PROJ-183-…#alternatives-rejected                                                                                                        |
| S-333 | "The ceiling for a project's contribution to a run is `agents.permissions`."                                                                                                                                                | W9-PROJ-125-project-resources-narrow-never-widen.md#decision                                                                               |
| S-334 | "`project_files`' ids become `access: 'read'` grants… placed **before** the agent's own grants… the agent's own … wins."                                                                                                    | W9-PROJ-125-…#decision                                                                                                                     |
| S-335 | "If the project has any file association… and `readFiles` is not `true`, the whole load throws… project connector… refused unless `unrestrictedNetwork` is `true`."                                                         | W9-PROJ-125-…#decision                                                                                                                     |
| S-336 | "A `project_files`/`project_mcp_servers` id that no longer resolves… throws."                                                                                                                                               | W9-PROJ-125-…#decision                                                                                                                     |
| S-337 | "Session start… resolves `defaultAgentId`… unresolvable… `422 project_default_agent_unresolvable` before any session row is written."                                                                                       | W9-PROJ-125-…#decision                                                                                                                     |
| S-338 | "`moveSession` queries `runs`… **before** it writes `sessions.project_id`, and refuses… `409 project_session_has_runs`."                                                                                                    | W9-PROJ-125-…#decision                                                                                                                     |
| S-339 | "`replace` (write) narrows what a request persists, and `get` (read) re-derives the same ceiling from the agent's _current_ `permissions`…"                                                                                 | W9-UI-133-permission-cap-narrows-at-read-and-write.md#decision                                                                             |
| S-340 | "`validateTenantSessionScope`… returns a two-arm verdict."                                                                                                                                                                  | W1-CORE-01-tenant-project-key-validated-before-the-run.md#decision                                                                         |
| S-341 | "The scope is part of `RunRequest`, and `compileRunRequest` re-parses it. A run whose scope fails validation does not compile."                                                                                             | W1-CORE-01-tenant-project-key-…#decision                                                                                                   |
| S-342 | "`CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_PROJECT_DIR_NAME` are _derived_ from the scope, never copied from `env`."                                                                                                             | W1-CORE-01-tenant-project-key-…#decision                                                                                                   |
| S-343 | "`settingSources: ['project']`"                                                                                                                                                                                             | W1-CORE-01-compile-step-defaults.md#decision                                                                                               |
| S-344 | "`strictMcpConfig: true`"                                                                                                                                                                                                   | W1-CORE-01-compile-step-defaults.md#decision                                                                                               |
| S-345 | "Instructions append to the Claude Code preset… empty… emits **no** `systemPrompt` key"                                                                                                                                     | W1-CORE-01-compile-step-defaults.md#decision                                                                                               |
| S-346 | "`null` limits and a `null` model omit their keys."                                                                                                                                                                         | W1-CORE-01-compile-step-defaults.md#decision                                                                                               |
| S-347 | "`compileRunRequest` emits all four (five with the dangerous flag)"                                                                                                                                                         | W1-CORE-01-tool-permissions-correct-spec-6.md#decision                                                                                     |
| S-348 | "`bypassPermissions` without `allowDangerouslySkipPermissions: true` is a parse error"                                                                                                                                      | W1-CORE-01-tool-permissions-correct-spec-6.md#decision                                                                                     |
| S-349 | "unanchored wildcard is rejected in an allow list and accepted in a deny list."                                                                                                                                             | W1-CORE-01-tool-permissions-correct-spec-6.md#decision                                                                                     |
| S-350 | "A permission that is off puts its tools in `deny`… `permissionMode` stays `default`, and `allowDangerouslySkipPermissions` is never set." (a stored policy may still set both, D5)                                         | W1-COMP-01-permissions-map-onto-deny-not-allow.md#decision                                                                                 |
| S-351 | "It spreads the container's own environment under the request's… removes `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_PROJECT_DIR_NAME`… The request's own `env` is applied last and wins."                                         | W1-COMP-01-the-runner-supplies-the-base-environment.md#decision                                                                            |
| S-352 | "It creates the `cwd` and the config directory it was told to use."                                                                                                                                                         | W1-COMP-01-the-runner-supplies-the-base-environment.md#decision                                                                            |
| S-353 | "`buildRuntimeEnvironment` implements the full contract…; `compileRunRequest` wires in only the two keys `RunRequest` already carries." (likely stale)                                                                      | W3-CP-09-a11-injector-cannot-source-gateway-fields-yet.md#decision                                                                         |
| S-354 | "`sessionWorkspacePaths(workspaceRoot, sessionId)`… refuses traversal…" (the per-session `cwd` is now `sandboxFor`)                                                                                                         | W3-CP-09-session-scoped-workspace-paths.md#decision                                                                                        |
| S-355 | "derive the stored `projectKey` from the authenticated principal… disagree → **403 `project_key_mismatch`**…" (the "states none" arm is superseded by SDK-03)                                                               | W2-CP-07-the-project-key-is-the-tenant-and-a-mismatch-is-refused.md#decision                                                               |
| S-356 | "`startRun`'s hard-coded `'unknown'` becomes a call to `resolveAgentRunOwnership`… (a Builder running its own agent succeeds; a Builder running another Builder's agent is denied)."                                        | W9-AUTH-117-out-of-globs-run-ownership-and-collateral-fixes.md#decision                                                                    |
| S-357 | "`Ownership` gains a fifth value, `'permitted'`… `applyGrant`'s `case 'permitted':` … allows exactly when `ownership === 'permitted'`"                                                                                      | W9-AUTH-117-viewer-permitted-agent-grants.md#decision                                                                                      |
| S-358 | "Inside `authorise`, the resolver runs **after** `identify()` … and **before** `decide()` … a `'refuse'` outcome … makes the 404 indistinguishable"                                                                         | W9-AUTH-117-ownership-resolver-and-404-before-decide.md#decision                                                                           |
| S-359 | "`startAgentRun`… body becomes `{ prompt, sessionId, modelConnectionId, model }`, matching `parseStartRunBody`."                                                                                                            | W9-MODEL-130-out-of-globs-model-connections-list-and-composer-run-client.md#decision                                                       |
| S-360 | "the three §34 run routes and the revocation operation are still required by name, and everything else served under `/api/runs` must be declared."                                                                          | W9-PLAN-the-run-route-closed-world-is-derived-from-the-declarations.md#decision                                                            |
| S-361 | "`/api/metrics` is an operational endpoint… never read by the Runs product… W9-UI-136 reads `GET /api/runs` only"                                                                                                           | W9-PLAN-metrics-is-operational-not-product.md#decision                                                                                     |
| S-362 | "`recentRunTelemetry` takes `workspaceId: string` as a required parameter… the route passes `principal.workspaceId`."                                                                                                       | W9-SEC-116-scope-metrics-projection-by-principal-workspace.md#decision                                                                     |
| S-363 | "`GET /api/runs?limit=1&user=00000000-…`… `200` → available; `403 user_filter_forbidden` → unavailable… fails closed."                                                                                                      | W9-UI-136-user-filter-visibility-is-a-server-probe.md#decision                                                                             |
| S-364 | "`components/run/live.ts` re-exports the SDK's SSE parser"; "The wire does not change to suit the SDK."                                                                                                                     | 0052-the-sdk-is-contracts-first-and-the-application-is-its-first-consumer.md#decision                                                      |
| S-365 | "`runs.(session_id, workspace_id) → sessions.(id, workspace_id)` · `cascade`"; "deleting an agent destroys its sessions and their runs."                                                                                    | W1-DB-01-schema-conventions.md#5-foreign-key-delete-behaviour-is-decided-per-edge-and-two-edges-disagree-on-purpose                        |
| S-366 | "A run reaches its agent through `sessions.agent_id`… `model` and `provider` **are** stored… `runs_ended_at_iff_terminal`."                                                                                                 | W1-DB-01-schema-conventions.md#6-runs-stores-neither-agent_id-nor-duration-though-35-lists-both                                            |
| S-367 | "`RUNNER_URL` [absent] · agent API installed, run API **not**; the three run routes 503 by name."                                                                                                                           | W1-COMP-01-the-composition-root-and-what-it-does-not-wire.md#decision-1--each-seam-is-installed-only-when-its-own-configuration-is-present |
| S-368 | ⚠ "`openSession` therefore **refuses** a caller-supplied `sessionId`." (stale)                                                                                                                                              | W1-COMP-01-the-composition-root-and-what-it-does-not-wire.md#what-is-not-wired-and-why-not-here                                            |

### Existing test harnesses for the real request path

| Harness                                                                                                                                                         | What it drives                                                                                                                                                                                                | Fakes and stores                                                                                                                                                                                                                                                                          | How a formal suite reuses it                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/server/runs/api.test.ts` (1 609 lines, about 74 cases)                                                                                                | `startRun`, `listRuns`, `readRun`, `revokeRunTokens`, `interruptRun`, `streamRunEvents`, `parseStartRunBody`, `renderRun`, `classifyRunOutcome`, all as plain `Request → Response`                            | `install(overrides)` calls `installRunApi` with a `RunApiEnvironment`: `authenticate` keyed by an `x-test-user` header returns a fixed owner `PRINCIPAL`; `findAgent`, `openSession`, `ownsRun` and `launch` capture. The store is `InMemoryRunStore`. `resetRunApi` runs in `afterEach`. | **The primary real-path harness.** Scenario vectors (pre-state, principal with role and scope, request) become an environment with the vector's principal and ownership plus a seeded `InMemoryRunStore`. The check covers status, code, body and post-state (`store.get`, `openStream`). |
| `apps/web/server/runs/routes.test.ts`                                                                                                                           | Only checks that the route files export the right methods                                                                                                                                                     | none                                                                                                                                                                                                                                                                                      | A suite may import the App Router `GET`/`POST` exports directly, as `revocation.integration.test.ts` does, to include the adapter and `errorResponse`.                                                                                                                                    |
| `apps/web/server/runs/interrupt.test.ts`                                                                                                                        | `signalRuntimeInterrupt` / `signalLiveRun` deadline and refusal                                                                                                                                               | fetch doubles, `registerLiveRun`/`resetLiveRuns`                                                                                                                                                                                                                                          | Unit-level vectors for the best-effort signal                                                                                                                                                                                                                                             |
| `apps/web/server/runs/revocation.integration.test.ts`                                                                                                           | The revoke-tokens adapters (new and legacy) plus the **real gateway** (`createGatewayApplication`, `createRunTokenCodec`)                                                                                     | `InMemoryRunStore`, no database                                                                                                                                                                                                                                                           | End-to-end token revocation vectors (R-4/R-5 → gateway `401 token_revoked`)                                                                                                                                                                                                               |
| `apps/web/server/runs/store.test.ts` (2 886 lines)                                                                                                              | The conformance suite over **both** `InMemoryRunStore` and `createRepositoryRunStore`, the latter against real PostgreSQL when `TEST_DATABASE_URL` is set; it covers records, events, openStream and listRuns | real stores                                                                                                                                                                                                                                                                               | The refinement (T4) replay between the two adapters. Also the place to add the tail-loss race vector.                                                                                                                                                                                     |
| `apps/web/server/runs/launcher.test.ts`, `relay.test.ts`, `sse.test.ts`, `cursor.test.ts`, `http.test.ts`, `failures.test.ts`, `route-error-boundaries.test.ts` | Launcher lifecycle, runner relay, SSE framing, resume cursor, body reading, error boundaries                                                                                                                  | `createRunnerLauncher` with a fetch fake and `InMemoryRunStore`                                                                                                                                                                                                                           | Lifecycle and event vectors at the unit layer                                                                                                                                                                                                                                             |
| `apps/web/server/rbac/authorisation-matrix.test.ts`, `token-scope-matrix.test.ts`, `permissions.test.ts`, `roles.test.ts`, `declared-sub-resources.test.ts`     | `decide` over every declared route × role × ownership, and the scope matrix                                                                                                                                   | pure                                                                                                                                                                                                                                                                                      | The oracle for the exhaustive `decide` vectors (1 920 route cells, and every scope cell)                                                                                                                                                                                                  |
| `apps/web/server/rbac/testing.ts`                                                                                                                               | Drives the real `apps/web/app/api/**` route exports with a real RBAC runtime, an in-memory directory and real session tokens; records every response                                                          | real `Principal`                                                                                                                                                                                                                                                                          | The template for R-8 (tokens) vectors                                                                                                                                                                                                                                                     |
| `apps/web/server/composition/browser-token-composition.integration.test.ts`                                                                                     | `register()` wiring of browser tokens (terminal and archived refusal, scope)                                                                                                                                  | needs `TEST_DATABASE_URL`                                                                                                                                                                                                                                                                 | Real-path check of `resolveBrowserTokenActor` (runs in CI)                                                                                                                                                                                                                                |
| `apps/web/server/sdk-conformance.test.ts` (`describe('runs')` `:401`, `describe('run events')` `:497`)                                                          | Server renderers against the contract schemas; every server frame parses to the SDK classification                                                                                                            | pure                                                                                                                                                                                                                                                                                      | T4 contract ↔ renderer and server ↔ SDK framing                                                                                                                                                                                                                                           |
| `packages/sdk/src/testing.ts`                                                                                                                                   | `fetchDouble` (`:21`), `jsonResponse` (`:41`), `eventStreamResponse` (`:57`), `droppedEventStreamResponse` (`:65`), `openEventStreamResponse` (`:85`), `drain` (`:105`)                                       | recording fetch                                                                                                                                                                                                                                                                           | SDK method vectors (request shape, error class, reconnect automaton). Used by `packages/sdk/src/resources/runs.test.ts`, `events/sse.test.ts` and `events/agent-event.test.ts`.                                                                                                           |
| `packages/aw/src/testing.ts`                                                                                                                                    | `runCli(argv, {route, stdin, env, homeDir, signal})` (`:84`) → `{code, stdout, stderr, calls}`                                                                                                                | fake `CliIo`, fetch double (`:25`)                                                                                                                                                                                                                                                        | `aw runs …` vectors: exit codes, output modes, SIGINT with `--interrupt-on-cancel` (`packages/aw/src/commands/runs.test.ts`)                                                                                                                                                              |

### Pending findings

These `docs/formal/findings.md` entries belong to D1, or D1 must triage them:

| F             | One line                                                                                              | Why D1                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| F-001         | A `queued` run can reach a terminal status directly; the RL diagram omits it (docs fix proposed)      | lifecycle; the handover names it                                 |
| F-002 / F-073 | `sessions_project_workspace_fk` is a composite ON DELETE SET NULL including a NOT NULL `workspace_id` | sessions as used by runs                                         |
| F-007         | The model's tenancy rule differs from `tenancy.test.ts` rule 1                                        | `Authz/Tenancy` is built in D1                                   |
| F-053 / F-068 | `agent_grants` is keyed by user id, and the `permitted` run check reads by user                       | `resolveAgentRunOwnership`                                       |
| F-060         | SPEC §2 says runs carry `ownerPrincipalId`; a run is owned through its session                        | run ownership, `ownsRun`                                         |
| F-061         | Three names for the session identifier (`claude_session_id`, `:claudeSessionId`, `providerSessionId`) | `recordReportedSessionIdentity`, the transcript runner principal |
| F-062         | `session_transcripts.project_key` = workspace id is enforced only by the repository                   | the run's `projectKey = workspaceId`                             |
| F-063         | `run_usage_records.provider` is free text; there is no check that an unpriced row costs 0             | accounting ledger                                                |
| F-065         | "session" names both the resource and the sign-in session                                             | naming in the D1 pages                                           |
| F-067         | `RunCostSchema.amount` is `z.string().min(1)`, not a decimal pattern                                  | contracts                                                        |
| F-076         | Six documented row invariants are not checks (SDK session id = session id, ledger provider set, …)    | runs and sessions invariants                                     |
| F-039 / F-074 | "Principal" names two things; kind `api_key` in storage vs `api-key` on the wire                      | the `Authz` principal vocabulary D1 introduces (triage with D3)  |

Phase 1 debt that D1 builds on:

- [er-core gaps](../units/er-core.md#gaps). 67 non-closed-set checks have no semantics, including `runs_ended_at_iff_terminal` via `otherCheckHolds`. The snapshot lake dependency is missing. Non-unique indexes are not modelled. Deletion is not a transition.
- [concept-work gaps](../units/concept-work.md#gaps). These cover runs, run events, usage and sessions.
- [er-synthesis gaps](../units/er-synthesis.md#gaps).

### Suspicious points noticed while reading

Numbered by rough severity. "Candidate" means step 7 still has to triage it.

1. **The repository stream can drop the tail of a run.** In `store.ts:974–981` the loop lists
   events after the cursor, then reads the run, and `return`s when the run is terminal. It does not
   list again. Events appended between the list and the read are never yielded. The launcher's
   final `run.status` is typical: `conclude` appends and then finishes. After that the server writes
   `done`, "do not reconnect". The in-memory adapter checks `closed ∧ cursor ≥ lastId` (`:472`),
   which is correct. This contradicts S-233, S-237, S-239 and S-236 ("everything it produced has
   been sent"). It is a candidate product bug and a T4 refinement failure between the two stores.
2. **An archived session still accepts new runs.** `openSession` (`register.ts:879–902`) never
   checks `session.status`. `sessionForLaunch` sets `resume: true` from `claudeSessionId` alone.
   This contradicts `resumable = active ∧ claudeSessionId` (S-208, `contracts/sessions.ts:14`) and
   the transcript's own `409 session_archived` "Restore this session before resuming"
   (`sessions/api.ts:336`). A 202 is returned, and the run then probably fails when it reads the
   transcript.
3. **An interrupt racing a completion can log two terminal `run.status` events.**
   `interruptRun` (`register.ts:850–854`) and `conclude` (`launcher.ts:235–236`) each run "append,
   then finish" as two transactions, and `finish` is first-call-wins. The durable log can therefore
   hold `cancelled` followed by `completed` while the record says only one of them. `POST
…/interrupt` can then answer 200 with `status: completed`. This undercuts S-43, S-201, S-245
   and S-268.
4. **`run-failed{unknown}` followed by `done`** is written for an `indeterminate` outcome
   (`sse.ts:460–482`, per S-242). The `CONTROL_FRAME_NAMES` comment in the same file (`sse.ts:95–103`)
   and S-81, S-82 and S-184 say "unknown" means "the producer threw; reconnect". But `follow`
   stops on `done`, and `waitForOutcome` then throws `ContractViolationError` (`aw` exit 3) on a
   live run. S-107 and S-198 ("the store writes the terminal status before the last frame") are
   false in this arm.
5. **A run-scoped browser token dies at terminal, so its documented use breaks.**
   `resolveBrowserTokenActor` (`session-rbac.ts:191`) refuses a run-scoped token once the run is
   terminal (S-15). The SPEC §3.1.1 example `browser.runs.follow(run.id)` still works while the run
   is live. But `waitForOutcome`'s final `get`, or any reconnect after the run settles, gets
   **401**, and `follow` does not retry that. The rule conflicts with S-6 "Read that run" and with
   S-65 and S-163 "a terminal run's event stream replays".
6. **The terminal transition does not revoke browser tokens.** `finish` revokes only `run_tokens`
   (`core runs.ts:732`). `browser_tokens.revokeForRun` has callers only on revoke and interrupt
   (`register.ts:829–830`), and `revokeForSession` has none (`browser-tokens.ts:31–37`). The rows
   stay `revoked_at IS NULL`, and only the check at resolution time refuses them. This is ambiguous
   against S-15.
7. **Contract and server disagree on `StartRunRequest.model`.** The contract says
   `z.string().min(1)` (`contracts/runs.ts:119`); the server accepts any string (`api.ts:124`). So
   `{modelConnectionId, model: ""}` gets a 202 from the server and fails model resolution after
   launch, while the contract refuses the same body.
8. **Two problem vocabularies for body errors.** Run routes answer `400 invalid_body` for a
   missing or wrong Content-Type and for an oversized body (`runs/http.ts:97–118`). The RBAC routes
   answer `415 unsupported_media_type`, `413 request_body_too_large` and `400 malformed_body`
   (`rbac/http.ts:86–123`). The latter matches S-26 and S-148.
9. **`startRun` authorises before it checks the id is well formed** (`api.ts:266–274`), against the
   file header's own order (`api.ts:19–21`). A non-UUID agent id gives Builder and Viewer 403 and
   Owner and Admin 400. S-174 lists `400 invalid_agent_id` with no condition.
10. **`decide()` and the handler disagree on Admin revoke.** `POST …/revoke-tokens` parses as
    `write` on `runs`, which Admin does not hold (`permissions.ts:295`), so `decide` and the
    authorisation matrix deny Admin. The handler admits Admin with its own role check (`api.ts:811`).
    A capability derived from `decide` (ADR W9-UI-184) would say Admin cannot revoke, while SPEC
    (S-40) and the handler say Admin can.
11. **A granted Builder cannot run the agent; a granted Viewer can.** `resolveAgentRunOwnership`
    answers `permitted` (`run-ownership.ts:50–54`). Builder's `agents.run` grant is `own`, and
    `applyGrant(own, permitted)` is deny. Viewer's grant is `permitted`, which allows. Viewer
    running its **own** agent is `applyGrant(permitted, own)`, which is also deny. The role table
    is not monotone here.
12. **Admin run verbs: two ADRs disagree.** SDK-03 gives Admin `run: 'any'` (the code follows it,
    `permissions.ts:295`), but W9-AUTH-165 (S-298, S-299) still says "An Admin still cannot … cancel".
    W9-AUTH-165 is not marked as amended.
13. **A first connection to a truncated log gets no `stream-reset`.** Both stores reset only when
    `after ≠ null` (`store.ts:438`, `:931`). A client that has seen nothing gets ids starting above
    1 and no reset. This contradicts S-234.
14. **Id spelling is compared as a string.** The run-scope check (`decide.ts` `pathId !== scope.id`)
    and the session-scope check (`api.ts:244`) compare exact strings, but `isUuid` is
    case-insensitive and PostgreSQL `uuid` lookups ignore case. An upper-case path for the scoped
    run is refused, which is safe but wrong. `InMemoryRunStore.listRuns` orders ids as strings
    while PostgreSQL orders `uuid` values: a refinement mismatch for ids that are not lower case.
15. **The two stores filter the owner differently.** `toRunRecord` (`core runs.ts:548`) never maps
    the `ownerPrincipalId` that `RUN_COLUMNS` selects (`:509`). The in-memory `listRuns` filters on
    `run.ownerPrincipalId` (the creator), and the repository filters on
    `sessions.owner_principal_id`. They agree only because `openSession` requires the caller to own
    the session.
16. **Runtime-supplied failure text is published verbatim.** The runner's `run-error` and
    `run-interrupted` `message` (`relay.ts:219`, `:316`, `:321`) becomes the public `run.error` and
    the `run-failed.message` without passing through `publicRunFailure`. The contract (S-167) calls
    `error` "safe public failure text". This is an A6 hygiene candidate.
17. **`revokeAllRunTokensFor` answers `already-revoked` for a run that never had a token**
    (`register.ts:831`). `not-found` is reachable only when the workspace scope is missing.
18. **The server stream comment is out of date.** `CONTROL_FRAME_NAMES` has four names, including
    `error` (`sse.ts:110`), where the contract has three. The comment at `sse.ts:95–103` says
    `run-failed` has "exactly two" producers, which the `indeterminate` arm contradicts. See
    point 4.
19. **`mintToken` reads the body before it authenticates** (`tokens/handlers.ts:80–84`), against
    its header's "configured → authenticated → well-formed" order. A malformed body gets 400 before 401. This belongs to D3 and touches D1.
20. **The proxy's browser-token check is case-sensitive.** The exemption is
    `startsWith('Bearer awt_live_')` (`proxy.ts:44`). `readBearerBrowserTokenAttempt` accepts a
    `bearer` scheme in any case. So `bearer awt_live_…` gets 401 at the edge.
21. **SDK and document mismatches:**
    - S-103: `TransportError` has no last-event-id field (`errors.ts:62`).
    - `done` is never yielded (SDK `runs.ts:207`), yet RR's examples `switch` on it.
    - S-27 says pagination returns `{ items, nextCursor }`; the code returns `{ runs, nextCursor }`.
    - S-28 and S-29 describe the idempotency key and the contracts header as present; neither is sent.
    - S-178 is self-contradictory. The code answers 403 whenever `user` is set without an `any` grant.
    - S-174, S-175 and S-207 omit `token_out_of_scope`, `invalid_body` and `500`.
    - S-45 omits `403`.
    - SPEC §5.12 does not document `?after=`.
22. **SDK `follow` rules the documents do not state:**
    - The reconnect budget is cumulative (SDK `runs.ts:249`, `:273`).
    - `after` is not reset after a `stream-reset`.
    - An empty `id:` gives `''`, which is later sent as `last-event-id: ''` (SDK `sse.ts:47`).
    - `splitSseFrames` ignores a lone CR.
    - `maxReconnects` and `reconnectDelayMs` are not validated.
23. **CLI mismatches:**
    - `runs start` prints `run`, not `{run, events}` (S-59, S-212).
    - `--raw` alone is JSON, it wins over `--json`, and `--wait` ignores it (S-215, S-216, S-217).
    - `runs wait` and `start --wait` exit 0 for a failed or cancelled run.
    - `--interrupt-on-cancel` is missing from CF (S-227), and `runs start --follow` does not have it.
    - Global flags are ignored silently.
    - The stdin-once message does not name `--prompt-file -`.
24. **ADR drift not marked as superseded or amended:**
    - S-259: `RunApiEnvironment` now has nine members.
    - S-263: the start body gained the model pair.
    - S-265: `length` counts UTF-16 code units.
    - S-290: the forced filter is `ownerPrincipalId`, not `initiatingUserId`.
    - S-292: point 8 of W9-RUNS-135.
    - S-305 and S-311: the runner's terminal frame names and the `cancelled` mapping.
    - S-323 and S-368: `openSession` now resumes.
    - S-328: `guardSessionCreation` returns `unknown-principal`, not `not-a-member`.
    - The resume cursor is trimmed before it is parsed (`cursor.ts:36`).
25. **The launcher's failure path records a run that never ran as `running`.** A preparation
    failure (`launcher.ts:362–370`) stamps `startedAt` and appends `run.status{running}` for a run
    that never reached a runtime. It is visible to followers and in `durationMs`. This is
    ambiguous, and it is why no `queued → failed` edge is ever observed through this path.
26. **A later `recordUsage` can move `failed` back to a recomputed state.** This is by design
    (S-279), but RL's "Only `complete` is settled" (S-71) does not say that `failed` is not final.
27. **Admin session access disagrees with the table.** Admin's `sessions` grant is `own`
    (`permissions.ts:279`), yet `canAccessSession` admits any Admin (`session-rbac.ts:90–101`).
    That affects transcript access, not runs. `openSession` requires the owner principal even for
    Owner and Admin, so they cannot continue another member's session (`409`), and nothing
    documents that.
28. **The project-move check races run creation.** In W9-PROJ-125's `moveSession`
    (`packages/core/src/db/repositories/projects.ts:250–262`), "has runs?" and the update are
    separate statements. A concurrent `store.create` can slip in between (S-338).

## Lean modules

Reading order. Each module extends Phase 1; none redefines it.

1. `Prelude/JValue.lean`, `Prelude/Codec.lean`, `Prelude/Text.lean`: the shared JSON value; the
   Zod-like codec with exact optional/nullable semantics and strict objects; string predicates such
   as trim, UTF-16 length and regex fragments.
2. `Contracts/Identifiers.lean`, `Contracts/Problem.lean`: `UUID_PATTERN`, ISO date-time, the three
   problem envelopes and `COMMON_PROBLEM_CODES`.
3. `Contracts/Runs.lean` (extended from Phase 0), `Contracts/RunEvents.lean`,
   `Contracts/Sessions.lean` (runs part).
4. `Authz/Roles.lean`, `Authz/Resources.lean` (resources and sub-resources),
   `Authz/Permissions.lean` (all 300 `POLICY` cells), `Authz/Decide.lean` (`parsePath`,
   `parseOperation`, `applyGrant`, `decide`), `Authz/TokenScope.lean` (the grammar and
   `checkTokenScope`), `Authz/Tenancy.lean` (the scope witness, 404 concealment, run ↔ session
   pairing), `Authz/RunToken.lean` (claims codec, verification, gateway authentication order).
5. `Behaviour/RunCompose.lean`: `parseStartRunBody`, the gates, `resolveModelForRun`,
   `toolPolicyFor`, `agentConfigFor`, `applyFileGrantPolicy`, `sandboxFor`, the
   `compileRunRequest` env rules.
6. `Behaviour/Runs.lean`: `startRun`, `listRuns` (the query parser, both cursor codecs, the forced
   filter), `readRun`, `revokeRunTokens`, `interruptRun`, `streamRunEvents` pre-flight, and
   `renderRun`, each as `(ER state, principal, request) → (state', response | problem)`.
7. `Lifecycle/Run.lean` (extended: timestamps, token revocation at finish, interrupt,
   launcher paths) and `Lifecycle/RunAccounting.lean`.
8. `Events/RunLog.lean` (append, close, retention, reset, and the follow semantics of both
   stores), `Events/Sse.lean` (server framing, the resume cursor, outcome → frames),
   `Events/SdkSse.lean` (`parseSseFrame`, `splitSseFrames`, `classifyRunEventFrame`),
   `Events/AgentFrames.lean` (ENG-03: the closed `agent.*` union and its codec, the Claude mapping,
   the legacy upgrade, the `(sequence, sub-index)` wire id and the SDK's parser — it replaces
   `Events/AgentEvent.lean`, whose theorems are restated over the frames).
9. `Sdk/Runs.lean`: the request per method, error classification, the `follow` reconnect
   automaton, `waitForOutcome`.
10. `Cli/Runs.lean`: commands, flag grammar as far as runs use it, output modes, `EXIT_CODE` and the
    `reportFailure` order.
11. Theorems in `Theorems/WellFormed`, `Normative`, `Invariants`, `Adversarial`, and
    `Refinement`, grouped by their model family. The Phase-0 `Runs.lean` files are extended by
    D1's `ContractsRuns`, `LifecycleRun`, `EventsSse`, `AgentFrames`, `BehaviourRuns`, `SdkRuns`,
    and `CliRuns` families; `AdversarialRunsAccess` and `AdversarialRunsStream` are the red-team families.
    Refinement theorems identify current and target behavior where they differ.

Build the integrated model with `cd formal && lake build AgentWorkspace`. The theorem families
and their actual declarations are indexed in the [catalogue](../catalogue.md).

## Coverage checklist

"Covered by" gives the intended form of coverage:

- T0–T4: a theorem of that tier.
- V: a vector replayed against the TypeScript.
- V(real): a vector through the real request path (the `api.test.ts` environment).
- F: a finding.
- NM: not modelled, with a reason.

Rows remain `open` where no completed unit supplies direct evidence. A `covered` status records the
named unit's model, theorem, vector, or real-path replay; a `finding` records a demonstrated
disagreement. A `not modelled` status names the scope limit. The detailed limits remain in the
linked [unit reports](../units) and [triage](d1-runs-triage.md).

### Routes and problem codes

| Item                                                                      | Kind         | Covered by                                    | Status                                               |
| ------------------------------------------------------------------------- | ------------ | --------------------------------------------- | ---------------------------------------------------- |
| R-1 `POST /api/agents/:id/runs`                                           | route        | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-1.1 `503 run_api_not_configured`                                        | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-1.2 `401 unauthenticated`                                               | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-1.3 `403 forbidden` (unparseable role)                                  | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-1.4 `403 token_out_of_scope` (decide)                                   | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-1.5 `403 forbidden` (decide deny)                                       | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-1.6 `500 authorisation_undecidable`                                     | problem      | T1 + V(real)                                  | covered: BehaviourRuns (unreachable guard)           |
| R-1.7 `400 invalid_agent_id`                                              | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-1.8 `400 invalid_body`                                                  | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-1.9 `403 token_out_of_scope` (session body)                             | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-1.10 `404 agent_not_found` (incl. archived workspace)                   | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-1.11 `409 session_not_usable`                                           | problem      | T1 + V(real)                                  | covered: BehaviourRuns; RAccess                      |
| R-1.12 `500 internal_error`                                               | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-1.13 `202 {run, events}` + `Location`, run `queued`                     | status       | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-2 `GET /api/runs`                                                       | route        | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.1 `503` (no env / no `listRuns`)                                      | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.2 `401`                                                               | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.3 `403 forbidden` (role)                                              | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.4 `403 token_out_of_scope`                                            | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-2.5 decide deny/refuse (unreachable, G-8)                               | problem      | T1 (unreachability)                           | covered: AuthzDecide; BehaviourRuns (unreachable)    |
| R-2.6 `400 invalid_limit`                                                 | problem      | T0 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.7 `400 invalid_cursor`                                                | problem      | T0 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.8 `400 invalid_status`                                                | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.9 `400 invalid_agent`                                                 | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.10 `400 invalid_project`                                              | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.11 `400 invalid_provider`                                             | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.12 `400 invalid_model`                                                | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.13 `400 invalid_from`                                                 | problem      | T0 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.14 `400 invalid_to`                                                   | problem      | T0 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.15 `400 invalid_date_range`                                           | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.16 `403 user_filter_forbidden`                                        | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-2.17 `400 invalid_user`                                                 | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-2.18 `200` page, newest first, forced own filter                        | status       | T1 + T3 + V(real)                             | covered: BehaviourRuns; RAccess                      |
| R-2.19 `500 internal_error`                                               | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-3 `GET /api/runs/:id`                                                   | route        | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-3.1 `503`                                                               | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-3.2 `401`                                                               | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-3.3 `400 invalid_run_id`                                                | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-3.4 `404 run_not_found` (absent or cross-tenant)                        | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns; RAccess                      |
| R-3.5 `403 token_out_of_scope` (session row)                              | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-3.6 `403 forbidden` (role)                                              | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-3.7 `403 token_out_of_scope` (run id)                                   | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-3.8 `403 forbidden` (decide)                                            | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-3.9 `500 authorisation_undecidable`                                     | problem      | T1 + V(real)                                  | covered: BehaviourRuns (unreachable guard)           |
| R-3.10 `200 {run}`                                                        | status       | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-4 `POST /api/runs/:id` (deprecated)                                     | route        | T1 (same handler as R-5) + V(real)            | covered: BehaviourRuns                               |
| R-5 `POST /api/runs/:id/revoke-tokens`                                    | route        | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-5.1 `503`                                                               | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-5.2 `401`                                                               | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-5.3 `403 token_out_of_scope` (any scope)                                | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-5.4 `403 run_token_revoke_forbidden`                                    | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns; RAccess                      |
| R-5.5 `400 invalid_run_id`                                                | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-5.6 `404 run_not_found`                                                 | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-5.7 `400 invalid_body`                                                  | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-5.8 `400 invalid_token_id`                                              | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-5.9 `200` all-tokens outcomes (`revoked`/`already-revoked`/`not-found`) | status       | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-5.10 `200` single-token outcomes                                        | status       | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-6 `GET /api/runs/:id/events`                                            | route        | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-6.1 `503`                                                               | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-6.2 `401`                                                               | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-6.3 `400 invalid_run_id`                                                | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-6.4 `400 invalid_resume_cursor` (before lookup)                         | problem      | T0 + T1 + V(real)                             | covered: BehaviourRuns                               |
| R-6.5 `404 run_not_found`                                                 | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-6.6 `403 token_out_of_scope` (session row)                              | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-6.7 `403 forbidden` (role)                                              | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-6.8 decide `403`/`500`                                                  | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-6.9 `404` (`openStream` null)                                           | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-6.10 `200` with exactly three SSE headers                               | status       | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-7 `POST /api/runs/:id/interrupt`                                        | route        | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-7.1 `503`                                                               | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-7.2 `401`                                                               | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-7.3 `400 invalid_run_id`                                                | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-7.4 `404 run_not_found`                                                 | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-7.5 `403 forbidden` (role)                                              | problem      | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-7.6 decide `403` (`token_out_of_scope`/`forbidden`)                     | problem      | T1 + T3 + V(real)                             | covered: BehaviourRuns                               |
| R-7.7 `500 authorisation_undecidable`                                     | problem      | T1 + V(real)                                  | covered: BehaviourRuns (unreachable guard)           |
| R-7.8 `409 run_not_interruptible`                                         | problem      | T1 + V(real)                                  | covered: BehaviourRuns; RAccess                      |
| R-7.9 `200 {run}` re-read                                                 | status       | T1 + V(real)                                  | covered: BehaviourRuns                               |
| R-C.1 `errorResponse` mapping (DomainError categories, infra 500/503/502) | rule         | T1 + V                                        | covered: BehaviourRuns                               |
| R-C.2 `readJsonBody` (content type, 2 000 000-byte cap, JSON)             | rule         | T0 + V                                        | covered: BehaviourRuns                               |
| R-C.3 edge exemption `isBrowserTokenExemptRoute`                          | rule         | T3 + V                                        | covered: AuthzDecide; RAccess                        |
| R-8 `POST /api/tokens` (run/session target rules)                         | route (dep.) | T1 + V(real, `rbac/testing.ts`)               | covered: AuthzRunToken; RAccess                      |
| R-9 `GET /api/sessions/:id` (`resumable`)                                 | route (dep.) | T1 + V                                        | covered: ContractsRuns; RunCompose                   |
| R-10 `PATCH /api/sessions/:id` (archive effect on runs and tokens)        | route (dep.) | T1 + V; F (point 2)                           | finding: F-103; RunCompose                           |
| R-11 `POST /api/projects/:id/sessions` (gate)                             | route (dep.) | NM in D1, D5 owns (gate modelled via RC rows) | not modelled: D5 session route; RunCompose gate only |
| R-12 transcript routes: `runner` principal from the run token             | route (dep.) | T3 + V                                        | covered: AuthzRunToken; RAccess                      |
| R-13 gateway `authenticateGatewayRequest` codes and order                 | route (dep.) | T1 + T3 + V (`revocation.integration`)        | covered: AuthzRunToken; RAccess                      |

### Contract exports

| Item                                                             | Kind     | Covered by                                     | Status                                    |
| ---------------------------------------------------------------- | -------- | ---------------------------------------------- | ----------------------------------------- |
| C-1 `UUID_PATTERN`                                               | contract | T0 + V                                         | covered: ContractsFoundation              |
| C-2 `isUuid`                                                     | contract | T0 + V                                         | covered: ContractsFoundation              |
| C-3 `UuidSchema`                                                 | contract | T0 + V                                         | covered: ContractsFoundation              |
| C-4 `IsoDateTimeSchema`                                          | contract | T0 + V                                         | covered: ContractsFoundation              |
| C-5 `ApiProblemSchema` / `ApiProblem`                            | contract | T0 + V                                         | covered: ContractsFoundation              |
| C-6 `ApiProblemDetailSchema`                                     | contract | T0 + V                                         | covered: ContractsFoundation              |
| C-7 `ApiProblemBareCodeSchema`                                   | contract | T0 + V                                         | covered: ContractsFoundation              |
| C-8 `COMMON_PROBLEM_CODES` / `CommonProblemCode`                 | contract | T0 + T1 + V                                    | covered: ContractsFoundation              |
| C-9 `RUN_STATUSES` / `RunStatus`                                 | contract | T0 (Phase 0) + T4 (server list)                | covered: ContractsRuns                    |
| C-10 `TERMINAL_RUN_STATUSES`                                     | contract | T0 + T4                                        | covered: ContractsRuns                    |
| C-11 `isTerminalRunStatus`                                       | contract | T0 + V                                         | covered: ContractsRuns                    |
| C-12 `MODEL_PROVIDERS` / `ModelProvider`                         | contract | T0 + T4                                        | covered: ContractsRuns                    |
| C-13 `ACCOUNTING_STATES` / `AccountingState`                     | contract | T0 + T4                                        | covered: ContractsRuns                    |
| C-14 `MAX_PROMPT_CHARS`                                          | contract | T0 + T4 (`api.ts:64`)                          | covered: ContractsRuns                    |
| C-15 `RunUsageSchema` / `RunUsage`                               | contract | T0 + V                                         | covered: ContractsRuns                    |
| C-16 `RunCostSchema` / `RunCost`                                 | contract | T0 + V; F-067                                  | finding: F-067; ContractsRuns             |
| C-17 `RunResourceSchema` / `RunResource`                         | contract | T0 + T4 (`renderRun`) + V                      | covered: ContractsRuns                    |
| C-18 `StartRunRequestSchema` / `StartRunRequest`                 | contract | T0 + T4 (`parseStartRunBody`) + V; F (point 7) | finding: F-104; ContractsRuns; RunCompose |
| C-19 `StartRunResponseSchema` / `StartRunResponse`               | contract | T0 + V                                         | covered: ContractsRuns                    |
| C-20 `RunResponseSchema`                                         | contract | T0 + V                                         | covered: ContractsRuns                    |
| C-21 `InterruptRunResponseSchema` / `InterruptRunResponse`       | contract | T0 + V                                         | covered: ContractsRuns                    |
| C-22 `RevokeRunTokensResponseSchema` / `RevokeRunTokensResponse` | contract | T0 + V                                         | covered: ContractsRuns                    |
| C-23 `RUN_LIST_DEFAULT_LIMIT`                                    | contract | T0 + T4                                        | covered: ContractsRuns                    |
| C-24 `RUN_LIST_MAX_LIMIT`                                        | contract | T0 + T4                                        | covered: ContractsRuns                    |
| C-25 `RunListResponseSchema` / `RunListResponse`                 | contract | T0 + V                                         | covered: ContractsRuns                    |
| C-26 `RunListQuery`                                              | contract | T0                                             | covered: ContractsRuns                    |
| C-27 `runListSearchParams`                                       | contract | T0 + V                                         | covered: ContractsRuns                    |
| C-28 `CONTROL_FRAME_NAMES` / `ControlFrameName`                  | contract | T0 + T4 (server list ⊇)                        | covered: EventsSse                        |
| C-29 `RUN_STATUS_EVENT`                                          | contract | T0 + T4                                        | covered: EventsSse                        |
| C-30 `RELAYED_EVENT_NAMES` / `RelayedEventName`                  | contract | T0 + V                                         | covered: EventsSse                        |
| C-31 `EVENT_NAME_PATTERN`                                        | contract | T0 + T4 (server pattern) + V                   | covered: EventsSse                        |
| C-32 `RunStatusEventDataSchema` / `RunStatusEventData`           | contract | T0 + V                                         | covered: EventsSse                        |
| C-33 `RunFailedFrameDataSchema` / `RunFailedFrameData`           | contract | T0 + V                                         | covered: EventsSse                        |
| C-34 `StreamResetFrameDataSchema` / `StreamResetFrameData`       | contract | T0 + V                                         | covered: EventsSse                        |
| C-35 `RelayedEventDataSchema` / `RelayedEventData` (loose)       | contract | T0 + V                                         | covered: EventsSse                        |
| C-36 `SESSION_STATUSES` / `SessionStatus`                        | contract | T0 (Phase 1)                                   | covered: ContractsRuns (Sessions)         |
| C-37 `SessionResourceSchema` / `SessionResource` (`resumable`)   | contract | T0 + T1 + V                                    | covered: ContractsRuns (Sessions)         |
| C-38 `SessionResponseSchema`                                     | contract | T0 + V                                         | covered: ContractsRuns (Sessions)         |
| C-39 `UpdateSessionPatch`                                        | contract | T0                                             | covered: ContractsRuns (Sessions)         |
| C-40 `PROJECT_KEY_PATTERN`                                       | contract | T0 (Phase 1 `isProjectKey`) + V                | covered: AuthzTenancy                     |

### Tables

| Item                                                               | Kind  | Covered by                                             | Status                                                |
| ------------------------------------------------------------------ | ----- | ------------------------------------------------------ | ----------------------------------------------------- |
| TB-1 `runs` (checks, FKs, `runs_id_workspace_unique`)              | table | T2 (Phase 1 `workChecksHold` + operation preservation) | covered: ErCore; LifecycleRun                         |
| TB-2 `run_events` (PK, contiguity, retention)                      | table | T2 + V                                                 | covered: EventsSse (in-memory replay)                 |
| TB-3 `run_tokens`                                                  | table | T2 + V                                                 | covered: AuthzRunToken; LifecycleRun                  |
| TB-4 `run_usage_records`                                           | table | T2 + V; F-063                                          | covered: LifecycleRun (abstract ledger; no DB replay) |
| TB-5 `sessions` (as used)                                          | table | T2; F-002/F-073                                        | finding: F-103; RunCompose                            |
| TB-6 `browser_tokens` (run/session scope)                          | table | T2 (D1 part); D3 rest                                  | covered: AuthzTenancy; AuthzRunToken (D1 scope)       |
| TB-7 `share_run_charges`/`shares`/`audit_events` via `recordUsage` | table | NM in D1, D2 owns (effect stated)                      | not modelled: D2 share charging                       |
| TB-8 `workspaces.archived_at`, `projects.archived_at` (gates)      | table | T1 via RC rows                                         | covered: RunCompose                                   |

### Authorisation

| Item                                                                         | Kind       | Covered by                              | Status                                        |
| ---------------------------------------------------------------------------- | ---------- | --------------------------------------- | --------------------------------------------- |
| AZ-1.o `runs` owner any/any/any                                              | role cell  | T1 + V (matrix)                         | covered: AuthzDecide                          |
| AZ-1.a `runs` admin any/none/any                                             | role cell  | T1 + V; F (point 12)                    | finding: F-090; AuthzDecide                   |
| AZ-1.b `runs` builder own/none/own                                           | role cell  | T1 + V                                  | covered: AuthzDecide                          |
| AZ-1.v `runs` viewer own/none/own                                            | role cell  | T1 + V                                  | covered: AuthzDecide                          |
| AZ-2.o `agents.run` owner any                                                | role cell  | T1 + V                                  | covered: AuthzDecide                          |
| AZ-2.a `agents.run` admin any                                                | role cell  | T1 + V                                  | covered: AuthzDecide                          |
| AZ-2.b `agents.run` builder own                                              | role cell  | T1 + V; F (point 11)                    | finding: F-088; AuthzDecide                   |
| AZ-2.v `agents.run` viewer permitted                                         | role cell  | T1 + V                                  | covered: AuthzDecide                          |
| AZ-3.* `sessions` × 4 roles                                                  | role cells | T1 + V                                  | covered: AuthzDecide                          |
| AZ-4.* `tokens.write` × 4 roles (mint)                                       | role cells | T1 + V (D3 completes)                   | covered: AuthzDecide (D3 extension pending)   |
| AZ-5 whole `POLICY` (300 cells)                                              | table      | T0 (exhaustive) + V vs `permissions.ts` | covered: AuthzDecide                          |
| AZ-6 `ROLES`/`parseRole`                                                     | rule       | T0 + V                                  | covered: AuthzDecide                          |
| AZ-7 `classifyPath` surfaces                                                 | rule       | T0 + V                                  | covered: AuthzDecide                          |
| AZ-8 `parsePath` (25 resources, depth, sub-resource)                         | rule       | T0 + V                                  | covered: AuthzDecide                          |
| AZ-9 `SUB_RESOURCES` composition (17; a duplicate throws)                    | rule       | T0 + V                                  | covered: AuthzDecide                          |
| AZ-10 `parseOperation`                                                       | rule       | T0 + V                                  | covered: AuthzDecide                          |
| AZ-11 `applyGrant` (20 cells)                                                | rule       | T0 + V                                  | covered: AuthzDecide                          |
| AZ-12 scope grammar clause 1 (cell membership)                               | rule       | T3 + V (`token-scope-matrix`)           | covered: AuthzDecide                          |
| AZ-13 scope grammar clause 2 (no collection read)                            | rule       | T3 + V                                  | covered: AuthzDecide                          |
| AZ-14 scope grammar clause 3 (run id equality)                               | rule       | T3 + V; F (point 14)                    | finding: F-091; AuthzDecide                   |
| AZ-15 `decide` order and `Decision` rendering                                | rule       | T1 + V (1 920 route cells)              | covered: AuthzDecide                          |
| AZ-16 `requireRunPermission`                                                 | rule       | T1 + V(real)                            | covered: BehaviourRuns                        |
| AZ-17 `requireSessionScopeMatch`                                             | rule       | T3 + V(real)                            | covered: BehaviourRuns                        |
| AZ-18 `decideRunListAccess` plus the forced filter                           | rule       | T3 + V(real)                            | covered: BehaviourRuns                        |
| AZ-19 `revokeRunTokens` own gate                                             | rule       | T3 + V(real); F (point 10)              | finding: F-089; AuthzDecide; BehaviourRuns    |
| AZ-20 `resolveAgentRunOwnership`                                             | rule       | T1 + V; F-053/F-068                     | finding: F-053/F-068; BehaviourRuns           |
| AZ-21 `ownsRun` (session owner)                                              | rule       | T1 + V(real); F-060                     | covered: BehaviourRuns; RAccess               |
| AZ-22 `findRunForPrincipal` 404 concealment                                  | rule       | T3 (cross-tenant) + V(real)             | covered: AuthzTenancy; BehaviourRuns; RAccess |
| AZ-23 `findAgent` 404 (foreign, archived)                                    | rule       | T3 + V                                  | covered: AuthzTenancy; BehaviourRuns          |
| AZ-24 `WorkspaceScope`/`findRunWorkspace` tenancy                            | rule       | T3 + T2 (Phase 1 tenancy); F-007        | finding: F-007; AuthzTenancy                  |
| AZ-25 `Principal.scope` required and propagated                              | rule       | T3                                      | covered: AuthzTenancy                         |
| AZ-26 `resolveBrowserTokenActor` (terminal/archived refusal, minter re-read) | rule       | T1 + T3 + V; F (point 5)                | finding: F-102; AuthzTenancy; AuthzRunToken   |
| AZ-27 run-token claims codec (HMAC, TTL 1–3600/300, verify)                  | rule       | T0 + T3 + V                             | covered: AuthzRunToken                        |
| AZ-28 `authenticateGatewayRequest` order and codes                           | rule       | T1 + T3 + V                             | covered: AuthzRunToken                        |
| AZ-29 `RunTokenRepository` (`register`/`isActive`/`revoke`/`revokeForRun`)   | rule       | T1 + V                                  | covered: AuthzRunToken                        |
| AZ-30 transcript `runner` principal                                          | rule       | T3 + V                                  | covered: AuthzRunToken                        |
| AZ-31 `requireResourceAccess` resolver (404 before decide)                   | rule       | T3 (shared tenancy)                     | covered: AuthzTenancy                         |

### Run request composition

| Item                                                                                            | Kind | Covered by                        | Status                                         |
| ----------------------------------------------------------------------------------------------- | ---- | --------------------------------- | ---------------------------------------------- |
| RC-1 `parseStartRunBody`                                                                        | rule | T0 + T4 (vs contract) + V         | finding: F-104; RunCompose                     |
| RC-2 `openSession`                                                                              | rule | T1 + V(real); F (points 2 and 27) | finding: F-103; RunCompose                     |
| RC-3 `sessionForLaunch` / `recordReportedSessionIdentity`                                       | rule | T1 + V; F-061/F-076               | covered: RunCompose                            |
| RC-4 `isWorkspaceUsableForRuns` / `createRunGate`                                               | rule | T1 + V                            | covered: RunCompose                            |
| RC-5 `guardSessionCreation`                                                                     | rule | T1 + V; F (point 24)              | covered: RunCompose                            |
| RC-6 `isProjectUsableForNewWork` / `createProjectRunGate`                                       | rule | T1 + V                            | covered: RunCompose                            |
| RC-7 `guardProjectSessionCreation`                                                              | rule | T1 + V                            | covered: RunCompose                            |
| RC-8 `resolveModelForRun`                                                                       | rule | T1 + V                            | covered: RunCompose                            |
| RC-9 `snapshotModel` before build                                                               | rule | T1                                | covered: RunCompose (model selection snapshot) |
| RC-10 `toolPolicyFor`                                                                           | rule | T0 + V                            | covered: RunCompose                            |
| RC-11 `agentConfigFor` (union/intersection narrowing)                                           | rule | T3 (never widens) + V             | covered: RunCompose                            |
| RC-12 `applyFileGrantPolicy` (deny only grows)                                                  | rule | T3 + V                            | covered: RunCompose                            |
| RC-13 project resource narrowing (W9-PROJ-125)                                                  | rule | T3 + V                            | covered: RunCompose                            |
| RC-14 `sandboxFor`                                                                              | rule | T0 + T3 (path) + V                | covered: RunCompose                            |
| RC-15 `buildRunRequestFor` (connection chain, token issue, session mode, env)                   | rule | T1 + T3 (no credential) + V       | covered: RunCompose (pure build decisions)     |
| RC-16 `compileRunRequest` (env derivation, `ANTHROPIC_API_KEY` refusal, defaults, session mode) | rule | T1 + T3 + V                       | covered: RunCompose                            |

### Lifecycle

| Item                                                                      | Kind       | Covered by                                   | Status                                                   |
| ------------------------------------------------------------------------- | ---------- | -------------------------------------------- | -------------------------------------------------------- |
| LC-1 create → `queued` (initial fields)                                   | transition | T1 + T2 + V                                  | covered: LifecycleRun                                    |
| LC-2 markRunning `queued → running`, stamps `startedAt`                   | transition | T1 (Phase 0) + T2 + V                        | covered: LifecycleRun                                    |
| LC-3 markRunning not queued → no-op; missing → not-found                  | transition | T1 + V                                       | covered: LifecycleRun                                    |
| LC-4 finish `queued → {completed, failed, cancelled}` (F-001)             | transition | T1 (Phase 0) + V                             | covered: LifecycleRun                                    |
| LC-5 finish `running → {completed, failed, cancelled}`                    | transition | T1 + V                                       | covered: LifecycleRun                                    |
| LC-6 finish on a terminal run → no-op (terminal absorbing)                | transition | T2 (Phase 0) + V                             | covered: LifecycleRun                                    |
| LC-7 finish with a non-terminal target throws                             | transition | T1 (Phase 0) + V                             | covered: LifecycleRun                                    |
| LC-8 finish revokes `run_tokens` atomically                               | transition | T3 + V (DB suite)                            | covered: LifecycleRun; AuthzRunToken (DB replay limited) |
| LC-9 timestamps: `ended_at` iff terminal, `ended ≥ started`, `durationMs` | invariant  | T2 + V                                       | covered: LifecycleRun                                    |
| LC-10 event log closed at terminal                                        | invariant  | T2 + V                                       | covered: LifecycleRun                                    |
| LC-11 interrupt (checks, then append, finish, revoke, signal)             | transition | T1 + T3 + V(real); F (point 3)               | finding: F-096; LifecycleRun; BehaviourRuns              |
| LC-12 launcher `markRunning` false → abandon (revoke, conclude cancelled) | transition | T3 + V (`launcher.test`)                     | covered: LifecycleRun (abandon replay limited)           |
| LC-13 launcher preparation failure → running → failed                     | transition | T1 + V; F (point 25)                         | covered: LifecycleRun (preparation failure)              |
| LC-14 `conclude` ordering and relay outcome mapping                       | transition | T1 + V                                       | covered: LifecycleRun                                    |
| LC-15 credential-bounded lifetime → failed                                | transition | T1 + V                                       | not modelled: runtime credential timer                   |
| LC-16 connect timeout → failed                                            | transition | T1 + V                                       | not modelled: runtime connect timer                      |
| LC-17 `recordUsage` insert and recomputed state                           | transition | T1 + T2 + V (DB)                             | covered: LifecycleRun (abstract ledger; no DB replay)    |
| LC-18 duplicate / late priced arrival (cost delta only)                   | transition | T1 + V                                       | covered: LifecycleRun (abstract ledger; no DB replay)    |
| LC-19 `price-version-conflict`                                            | transition | T1 + V                                       | covered: LifecycleRun (abstract ledger; no DB replay)    |
| LC-20 `markAccountingFailed` only from `pending`                          | transition | T1 + V                                       | covered: LifecycleRun (abstract ledger; no DB replay)    |
| LC-21 `failed` superseded by a later settlement                           | transition | T1 + V                                       | covered: LifecycleRun (abstract ledger; no DB replay)    |
| LC-22 settlement timeout leaves `pending`                                 | transition | NM (gateway timing); stated as an assumption | not modelled: gateway settlement timeout                 |
| LC-23 run token issued at build time with a TTL                           | transition | T1 + V                                       | covered: AuthzRunToken; RunCompose                       |
| LC-24 explicit revoke (one/all)                                           | transition | T1 + V(real)                                 | covered: AuthzRunToken; BehaviourRuns                    |
| LC-25 browser tokens revoked on revoke/interrupt; refused at terminal     | transition | T1 + T3 + V; F (point 6)                     | finding: F-097; LifecycleRun; AuthzRunToken              |
| LC-26 `snapshotModel`                                                     | transition | T1 + V                                       | covered: RunCompose                                      |
| LC-27 session archive → effect on runs (none today)                       | transition | T1 (Current) + F (point 2)                   | finding: F-103; RunCompose                               |

### Events

| Item                                                                                                | Kind       | Covered by                       | Status                                              |
| --------------------------------------------------------------------------------------------------- | ---------- | -------------------------------- | --------------------------------------------------- |
| EV-1 `EVENT_NAME_PATTERN` grammar                                                                   | event rule | T0 + T3 (frame injection) + V    | covered: EventsSse                                  |
| EV-2 reserved names (server 4 + `run.status`; contract 3)                                           | event rule | T0 + T4 + V                      | covered: EventsSse                                  |
| EV-3 `classifyEventName`/`classifyPlatformEventName`/`classifyStoredEventName`                      | event rule | T0 + V                           | covered: EventsSse                                  |
| EV-4 `renderEventData`                                                                              | event rule | T0 + V                           | covered: EventsSse (JSON-representable values only) |
| EV-5 relay path refuses reserved names; the platform path only `run.status`                         | event rule | T3 + V                           | covered: EventsSse                                  |
| EV-6 sequence max+1, contiguous under the lock                                                      | event rule | T2 + V                           | covered: EventsSse                                  |
| EV-7 append refused once terminal                                                                   | event rule | T2 + V                           | covered: EventsSse                                  |
| EV-8 retention 50 000 (delete ≤ next − max)                                                         | event rule | T2 + V                           | covered: EventsSse (in-memory replay only)          |
| EV-9 reset: gap                                                                                     | event rule | T1 + V (both stores)             | covered: EventsSse                                  |
| EV-10 reset: ahead / empty                                                                          | event rule | T1 + V (both stores)             | covered: EventsSse                                  |
| EV-11 first connection to a truncated log: no reset                                                 | event rule | T1 (Current) + F (point 13)      | covered: EventsSse                                  |
| EV-12 replay strictly after the cursor, then live, in order                                         | event rule | T1 + T4 + V                      | covered: EventsSse (in-memory replay only)          |
| EV-13 stream end condition (in memory vs repository)                                                | event rule | T4 + V; F (point 1)              | finding: F-100; EventsSse; RStream                  |
| EV-14 `readResumeCursor`                                                                            | event rule | T0 + V                           | covered: EventsSse                                  |
| EV-15 `SSE_HEADERS` exactly three                                                                   | event rule | T1 + V                           | covered: EventsSse                                  |
| EV-16 `retry: 3000` first                                                                           | event rule | T1 + V                           | covered: EventsSse                                  |
| EV-17 `stream-reset` prelude before events                                                          | event rule | T1 + V                           | covered: EventsSse                                  |
| EV-18 `sseFrame` format with id                                                                     | event rule | T0 + V                           | covered: EventsSse                                  |
| EV-19 control frames carry no id                                                                    | event rule | T1 + V                           | covered: EventsSse                                  |
| EV-20 keep-alive comment (15 s, CR/LF stripped)                                                     | event rule | T0 + V                           | covered: EventsSse                                  |
| EV-21 outcome → frames (`done`; `run-failed`+`done`; `run-failed{unknown}`+`done`)                  | event rule | T1 + V; F (point 4)              | covered: EventsSse                                  |
| EV-22 producer throw → `run-failed{unknown}`, no `done`                                             | event rule | T1 + V                           | covered: EventsSse                                  |
| EV-23 `classifyRunOutcome` total                                                                    | event rule | T1 + V                           | covered: EventsSse                                  |
| EV-24 never `event: error`                                                                          | event rule | T1 + V                           | covered: EventsSse                                  |
| EV-25 teardown exactly once                                                                         | event rule | NM (resource hygiene); V only    | covered: EventsSse (real teardown test only)        |
| EV-26 relay `SseLineSplitter`                                                                       | event rule | T0 + V                           | covered: EventsSse                                  |
| EV-27 relay `SseMessageAssembler`                                                                   | event rule | T0 + V                           | covered: EventsSse                                  |
| EV-28 `classifyRunnerResponse`                                                                      | event rule | T0 + V                           | covered: EventsSse                                  |
| EV-29 `relayRunnerStream` outcomes (bad JSON, no name, terminal frames, append refusal, session id) | event rule | T1 + V; F (point 16)             | covered: EventsSse (partial Lean; real replay)      |
| EV-30 `run.status` data shapes and write points                                                     | event rule | T1 + V                           | not modelled: run.status write points in Lean       |
| EV-31 SDK `parseSseFrame`                                                                           | event rule | T0 + T4 (vs relay assembler) + V | covered: EventsSse                                  |
| EV-32 SDK `splitSseFrames`                                                                          | event rule | T0 + V; F (point 22)             | covered: EventsSse                                  |
| EV-33 SDK `readSseFrames`                                                                           | event rule | T1 + V                           | covered: EventsSse                                  |
| EV-34 SDK `classifyRunEventFrame`                                                                   | event rule | T0 + V                           | covered: EventsSse                                  |
| EV-35 `toAgentEvent` (the `agent.*` parser)                                                         | event rule | T0 + V                           | covered: AgentFrames                                |
| EV-36 `toAgentFrames` (the Claude mapping)                                                          | event rule | T2 + T4 + V                      | covered: AgentFrames                                |
| EV-37 `assistantResponseFromAgentEvent`                                                             | event rule | T0 + V                           | covered: AgentFrames                                |
| EV-39 the legacy upgrade on read, and `(sequence, sub-index)` resume                                 | event rule | T2 + T4 + V                      | covered: AgentFrames                                |
| EV-38 server frames ↔ SDK classification                                                            | event rule | T4 + V (`sdk-conformance`)       | covered: EventsSse; SdkRuns                         |

### SDK and CLI

| Item                                                            | Kind       | Covered by                              | Status                     |
| --------------------------------------------------------------- | ---------- | --------------------------------------- | -------------------------- |
| SDK-1 `runs.start`                                              | SDK method | T1 + V (fetch double)                   | covered: SdkRuns           |
| SDK-2 `runs.get`                                                | SDK method | T1 + V                                  | covered: SdkRuns           |
| SDK-3 `runs.interrupt`                                          | SDK method | T1 + V                                  | covered: SdkRuns           |
| SDK-4 `runs.revokeTokens`                                       | SDK method | T1 + V                                  | covered: SdkRuns           |
| SDK-5 `runs.list`                                               | SDK method | T1 + V                                  | covered: SdkRuns           |
| SDK-6 `runs.events`                                             | SDK method | T1 + V                                  | covered: SdkRuns           |
| SDK-7 `runs.follow` (reconnect automaton)                       | SDK method | T1 + T2 (termination) + V; F (point 22) | covered: SdkRuns           |
| SDK-8 `runs.waitForOutcome`                                     | SDK method | T1 + V; F (points 4 and 5)              | finding: point 4; SdkRuns  |
| SDK-9 `send`/`json` error classification                        | SDK rule   | T1 + V                                  | covered: SdkRuns           |
| SDK-10 `readProblem` three envelopes, `unrecognised_error_body` | SDK rule   | T0 + V                                  | covered: SdkRuns           |
| SDK-11 `headersDeadline`/`combinedSignal`                       | SDK rule   | T1 + V                                  | covered: SdkRuns           |
| CLI-1 `aw runs start`                                           | aw command | T1 + V (`runCli`)                       | covered: CliRuns           |
| CLI-2 `aw runs get`                                             | aw command | T1 + V                                  | covered: CliRuns           |
| CLI-3 `aw runs list`                                            | aw command | T1 + V                                  | covered: CliRuns           |
| CLI-4 `aw runs events`                                          | aw command | T1 + V                                  | covered: CliRuns           |
| CLI-5 `aw runs follow` (`--interrupt-on-cancel`)                | aw command | T1 + V                                  | covered: CliRuns           |
| CLI-6 `aw runs interrupt`                                       | aw command | T1 + V                                  | covered: CliRuns           |
| CLI-7 `aw runs wait`                                            | aw command | T1 + V; F (point 23)                    | finding: point 23; CliRuns |
| CLI-8 `renderFrame`/`printStream`                               | aw rule    | T0 + V                                  | covered: CliRuns           |
| CLI-9 `EXIT_CODE`/`reportFailure` order                         | aw rule    | T0 + V                                  | covered: CliRuns           |
| CLI-10 `promptOf`/`--model` parsing                             | aw rule    | T0 + V                                  | covered: CliRuns           |
| CLI-11 `writeResult` output modes                               | aw rule    | T0 + V                                  | covered: CliRuns           |

### Findings

| Item          | Kind    | Covered by                          | Status                       |
| ------------- | ------- | ----------------------------------- | ---------------------------- |
| F-001         | finding | docs fix (RL diagram) + existing T1 | finding: F-001; LifecycleRun |
| F-002 / F-073 | finding | triage                              | finding: D1Triage            |
| F-007         | finding | triage (`Authz/Tenancy`)            | finding: D1Triage            |
| F-053 / F-068 | finding | triage                              | finding: D1Triage            |
| F-060         | finding | docs fix                            | finding: D1Triage            |
| F-061         | finding | triage                              | finding: D1Triage            |
| F-062         | finding | triage                              | finding: D1Triage            |
| F-063         | finding | triage                              | finding: D1Triage            |
| F-065         | finding | docs fix                            | finding: D1Triage            |
| F-067         | finding | triage                              | finding: D1Triage            |
| F-076         | finding | triage                              | finding: D1Triage            |
| F-039 / F-074 | finding | triage with D3                      | finding: D1Triage            |

### Normative sentences

Every sentence is planned as a T1 unless noted. ⚠ sentences are planned as a finding (a document
fix or a product fix) plus a T1 over today's code.

| Item  | Kind     | Covered by                                           | Status                                  |
| ----- | -------- | ---------------------------------------------------- | --------------------------------------- |
| S-1   | sentence | T1                                                   | open                                    |
| S-2   | sentence | T1 (SDK)                                             | open                                    |
| S-3   | sentence | T1                                                   | covered: AuthzDecide                    |
| S-4   | sentence | T1                                                   | covered: AuthzDecide                    |
| S-5   | sentence | T1                                                   | covered: AuthzTenancy                   |
| S-6   | sentence | T1; F (point 5)                                      | finding: F-102; AuthzRunToken           |
| S-7   | sentence | T1                                                   | finding: F-102; AuthzRunToken           |
| S-8   | sentence | T1                                                   | open                                    |
| S-9   | sentence | T1                                                   | open                                    |
| S-10  | sentence | T1                                                   | open                                    |
| S-11  | sentence | T1                                                   | covered: AuthzDecide                    |
| S-12  | sentence | T1                                                   | covered: AuthzDecide                    |
| S-13  | sentence | T1                                                   | covered: AuthzDecide                    |
| S-14  | sentence | T1 (D3 completes)                                    | open                                    |
| S-15  | sentence | T1; F (points 5 and 6)                               | finding: F-097; AuthzRunToken           |
| S-16  | sentence | T1                                                   | covered: AuthzDecide                    |
| S-17  | sentence | T1                                                   | covered: AuthzDecide                    |
| S-18  | sentence | T1                                                   | covered: AuthzDecide                    |
| S-19  | sentence | T0                                                   | open                                    |
| S-20  | sentence | T0                                                   | open                                    |
| S-21  | sentence | T0; F-067                                            | finding: F-067; ContractsRuns           |
| S-22  | sentence | T0                                                   | covered: ContractsRuns                  |
| S-23  | sentence | T1                                                   | open                                    |
| S-24  | sentence | T1                                                   | open                                    |
| S-25  | sentence | T1                                                   | open                                    |
| S-26  | sentence | F (point 8) + T1                                     | covered: AuthzTenancy                   |
| S-27  | sentence | F (point 21)                                         | open                                    |
| S-28  | sentence | F (point 21)                                         | open                                    |
| S-29  | sentence | F (point 21)                                         | open                                    |
| S-30  | sentence | T1 (SDK)                                             | open                                    |
| S-31  | sentence | T0                                                   | covered: ContractsRuns                  |
| S-32  | sentence | T1                                                   | open                                    |
| S-33  | sentence | T0 (Phase 0)                                         | covered: ContractsRuns                  |
| S-34  | sentence | T0                                                   | covered: ContractsRuns                  |
| S-35  | sentence | T0                                                   | covered: ContractsRuns                  |
| S-36  | sentence | T1                                                   | open                                    |
| S-37  | sentence | T1                                                   | open                                    |
| S-38  | sentence | T1                                                   | open                                    |
| S-39  | sentence | T1                                                   | open                                    |
| S-40  | sentence | T1; F (point 10)                                     | finding: F-089; AuthzDecide             |
| S-41  | sentence | T1                                                   | open                                    |
| S-42  | sentence | T1                                                   | covered: AuthzDecide                    |
| S-43  | sentence | T1; F (point 3)                                      | open                                    |
| S-44  | sentence | T1                                                   | open                                    |
| S-45  | sentence | F (point 21) + T1                                    | open                                    |
| S-46  | sentence | T1                                                   | open                                    |
| S-47  | sentence | T1                                                   | open                                    |
| S-48  | sentence | T1                                                   | open                                    |
| S-49  | sentence | T0                                                   | open                                    |
| S-50  | sentence | T0                                                   | open                                    |
| S-51  | sentence | T0                                                   | open                                    |
| S-52  | sentence | T1                                                   | open                                    |
| S-53  | sentence | T1                                                   | open                                    |
| S-54  | sentence | T1                                                   | open                                    |
| S-55  | sentence | NM (a second provider does not exist)                | open                                    |
| S-56  | sentence | NM (a second provider does not exist)                | open                                    |
| S-57  | sentence | T1 (CLI)                                             | open                                    |
| S-58  | sentence | T1 (CLI)                                             | open                                    |
| S-59  | sentence | F (point 23) + T1                                    | open                                    |
| S-60  | sentence | T1 (CLI)                                             | open                                    |
| S-61  | sentence | T1 (CLI)                                             | open                                    |
| S-62  | sentence | NM (S-6 not built)                                   | open                                    |
| S-63  | sentence | T1                                                   | open                                    |
| S-64  | sentence | T0                                                   | open                                    |
| S-65  | sentence | T1; F (point 5)                                      | open                                    |
| S-66  | sentence | T0                                                   | open                                    |
| S-67  | sentence | F-001 (docs) + T1                                    | open                                    |
| S-68  | sentence | T1                                                   | open                                    |
| S-69  | sentence | T1                                                   | open                                    |
| S-70  | sentence | T1                                                   | open                                    |
| S-71  | sentence | T1; F (point 26)                                     | open                                    |
| S-72  | sentence | T1                                                   | open                                    |
| S-73  | sentence | T2                                                   | open                                    |
| S-74  | sentence | T1                                                   | open                                    |
| S-75  | sentence | T1                                                   | open                                    |
| S-76  | sentence | T1                                                   | open                                    |
| S-77  | sentence | T1; F (point 3)                                      | open                                    |
| S-78  | sentence | T1                                                   | open                                    |
| S-79  | sentence | T1                                                   | open                                    |
| S-80  | sentence | T1                                                   | open                                    |
| S-81  | sentence | F (point 4) + T1                                     | open                                    |
| S-82  | sentence | F (point 4) + T1                                     | open                                    |
| S-83  | sentence | T1                                                   | open                                    |
| S-84  | sentence | T1                                                   | open                                    |
| S-85  | sentence | T1                                                   | open                                    |
| S-86  | sentence | T1                                                   | open                                    |
| S-87  | sentence | NM in D1 (D6: runtime profiles)                      | open                                    |
| S-88  | sentence | NM in D1 (D6)                                        | open                                    |
| S-89  | sentence | F-001                                                | open                                    |
| S-90  | sentence | T1                                                   | open                                    |
| S-91  | sentence | T1                                                   | open                                    |
| S-92  | sentence | T1                                                   | open                                    |
| S-93  | sentence | T0                                                   | open                                    |
| S-94  | sentence | T2                                                   | open                                    |
| S-95  | sentence | T0                                                   | open                                    |
| S-96  | sentence | T0                                                   | open                                    |
| S-97  | sentence | T0                                                   | open                                    |
| S-98  | sentence | T0                                                   | open                                    |
| S-99  | sentence | T0                                                   | open                                    |
| S-100 | sentence | T1                                                   | open                                    |
| S-101 | sentence | T1                                                   | open                                    |
| S-102 | sentence | T1                                                   | open                                    |
| S-103 | sentence | F (point 21)                                         | open                                    |
| S-104 | sentence | T1                                                   | open                                    |
| S-105 | sentence | T1                                                   | open                                    |
| S-106 | sentence | T1                                                   | open                                    |
| S-107 | sentence | F (point 4)                                          | open                                    |
| S-108 | sentence | T1                                                   | open                                    |
| S-109 | sentence | T1                                                   | open                                    |
| S-110 | sentence | T1                                                   | open                                    |
| S-111 | sentence | T1                                                   | open                                    |
| S-112 | sentence | T1; F (point 22)                                     | open                                    |
| S-113 | sentence | T1                                                   | open                                    |
| S-114 | sentence | T1                                                   | open                                    |
| S-115 | sentence | T1                                                   | open                                    |
| S-116 | sentence | T1                                                   | open                                    |
| S-117 | sentence | T1                                                   | open                                    |
| S-118 | sentence | T1                                                   | open                                    |
| S-119 | sentence | T1                                                   | open                                    |
| S-120 | sentence | T1                                                   | open                                    |
| S-121 | sentence | T1                                                   | open                                    |
| S-122 | sentence | F (point 4) + T1                                     | open                                    |
| S-123 | sentence | T1                                                   | open                                    |
| S-124 | sentence | T1                                                   | open                                    |
| S-125 | sentence | T0                                                   | open                                    |
| S-126 | sentence | T0                                                   | open                                    |
| S-127 | sentence | T0                                                   | open                                    |
| S-128 | sentence | T0                                                   | open                                    |
| S-129 | sentence | T0                                                   | open                                    |
| S-130 | sentence | T0                                                   | open                                    |
| S-131 | sentence | T1                                                   | open                                    |
| S-132 | sentence | T0                                                   | open                                    |
| S-133 | sentence | T0                                                   | open                                    |
| S-134 | sentence | T1                                                   | open                                    |
| S-135 | sentence | T1                                                   | open                                    |
| S-136 | sentence | T1                                                   | open                                    |
| S-137 | sentence | T1                                                   | open                                    |
| S-138 | sentence | T1                                                   | open                                    |
| S-139 | sentence | T1                                                   | open                                    |
| S-140 | sentence | T1                                                   | open                                    |
| S-141 | sentence | T1                                                   | open                                    |
| S-142 | sentence | T1                                                   | open                                    |
| S-143 | sentence | T1                                                   | open                                    |
| S-144 | sentence | T0                                                   | open                                    |
| S-145 | sentence | NM (advice to callers)                               | open                                    |
| S-146 | sentence | T1                                                   | open                                    |
| S-147 | sentence | T1                                                   | open                                    |
| S-148 | sentence | F (point 8) + T0                                     | open                                    |
| S-149 | sentence | T1                                                   | open                                    |
| S-150 | sentence | T1                                                   | open                                    |
| S-151 | sentence | T1                                                   | open                                    |
| S-152 | sentence | NM (advice to callers)                               | open                                    |
| S-153 | sentence | T1                                                   | open                                    |
| S-154 | sentence | T0                                                   | open                                    |
| S-155 | sentence | T1                                                   | covered: BehaviourRuns                  |
| S-156 | sentence | T1                                                   | open                                    |
| S-157 | sentence | T1                                                   | open                                    |
| S-158 | sentence | T0                                                   | open                                    |
| S-159 | sentence | T1 (CLI)                                             | open                                    |
| S-160 | sentence | T1                                                   | open                                    |
| S-161 | sentence | T1                                                   | open                                    |
| S-162 | sentence | T1                                                   | open                                    |
| S-163 | sentence | T1; F (point 5)                                      | open                                    |
| S-164 | sentence | T1                                                   | open                                    |
| S-165 | sentence | T1                                                   | open                                    |
| S-166 | sentence | T1                                                   | open                                    |
| S-167 | sentence | T1; F (point 16)                                     | open                                    |
| S-168 | sentence | T1                                                   | open                                    |
| S-169 | sentence | T1                                                   | open                                    |
| S-170 | sentence | T1                                                   | open                                    |
| S-171 | sentence | T0                                                   | open                                    |
| S-172 | sentence | T1                                                   | open                                    |
| S-173 | sentence | T0; F (point 7)                                      | open                                    |
| S-174 | sentence | F (points 9 and 21) + T1                             | open                                    |
| S-175 | sentence | F (point 21) + T1                                    | open                                    |
| S-176 | sentence | T1                                                   | open                                    |
| S-177 | sentence | T1                                                   | open                                    |
| S-178 | sentence | F (point 21) + T1                                    | open                                    |
| S-179 | sentence | T1                                                   | open                                    |
| S-180 | sentence | T1                                                   | open                                    |
| S-181 | sentence | T1                                                   | open                                    |
| S-182 | sentence | T1                                                   | open                                    |
| S-183 | sentence | T1                                                   | open                                    |
| S-184 | sentence | F (point 4) + T1                                     | open                                    |
| S-185 | sentence | T1                                                   | open                                    |
| S-186 | sentence | T1                                                   | open                                    |
| S-187 | sentence | T1                                                   | open                                    |
| S-188 | sentence | T1                                                   | open                                    |
| S-189 | sentence | T1                                                   | open                                    |
| S-190 | sentence | T1                                                   | open                                    |
| S-191 | sentence | T1                                                   | open                                    |
| S-192 | sentence | T1                                                   | open                                    |
| S-193 | sentence | T1                                                   | open                                    |
| S-194 | sentence | T1                                                   | open                                    |
| S-195 | sentence | T1                                                   | open                                    |
| S-196 | sentence | T1                                                   | open                                    |
| S-197 | sentence | T1                                                   | open                                    |
| S-198 | sentence | F (point 4)                                          | open                                    |
| S-199 | sentence | T0                                                   | open                                    |
| S-200 | sentence | T1                                                   | open                                    |
| S-201 | sentence | T1; F (point 3)                                      | open                                    |
| S-202 | sentence | T1                                                   | open                                    |
| S-203 | sentence | T1                                                   | covered: AuthzDecide                    |
| S-204 | sentence | T1 (CLI)                                             | open                                    |
| S-205 | sentence | T1                                                   | open                                    |
| S-206 | sentence | T1                                                   | finding: F-089; AuthzDecide             |
| S-207 | sentence | F (point 21) + T1                                    | open                                    |
| S-208 | sentence | T0; F (point 2)                                      | open                                    |
| S-209 | sentence | T1                                                   | open                                    |
| S-210 | sentence | T1                                                   | open                                    |
| S-211 | sentence | T1 (CLI)                                             | open                                    |
| S-212 | sentence | F (point 23) + T1                                    | open                                    |
| S-213 | sentence | T1 (CLI)                                             | open                                    |
| S-214 | sentence | T1 (CLI)                                             | open                                    |
| S-215 | sentence | F (point 23)                                         | open                                    |
| S-216 | sentence | F (point 23)                                         | open                                    |
| S-217 | sentence | F (point 23)                                         | open                                    |
| S-218 | sentence | T1 (CLI)                                             | open                                    |
| S-219 | sentence | T1 (CLI)                                             | open                                    |
| S-220 | sentence | T1 (CLI)                                             | open                                    |
| S-221 | sentence | T1 (CLI)                                             | open                                    |
| S-222 | sentence | T1 (CLI)                                             | open                                    |
| S-223 | sentence | T1 (CLI)                                             | open                                    |
| S-224 | sentence | T1 (CLI)                                             | open                                    |
| S-225 | sentence | T1 (CLI)                                             | open                                    |
| S-226 | sentence | T1 (CLI)                                             | open                                    |
| S-227 | sentence | F (point 23)                                         | open                                    |
| S-228 | sentence | T1 (CLI)                                             | open                                    |
| S-229 | sentence | T1 (CLI)                                             | open                                    |
| S-230 | sentence | T1 (CLI)                                             | open                                    |
| S-231 | sentence | T1                                                   | open                                    |
| S-232 | sentence | T2                                                   | open                                    |
| S-233 | sentence | F (point 1) + T4                                     | open                                    |
| S-234 | sentence | F (point 13)                                         | open                                    |
| S-235 | sentence | NM (deployment wiring); V (`store.test` import gate) | open                                    |
| S-236 | sentence | T1                                                   | open                                    |
| S-237 | sentence | F (point 1) + T4                                     | open                                    |
| S-238 | sentence | T1                                                   | open                                    |
| S-239 | sentence | T1 (in memory); NM (lost-wakeup timing)              | open                                    |
| S-240 | sentence | NM (superseded)                                      | open                                    |
| S-241 | sentence | T1                                                   | open                                    |
| S-242 | sentence | T1                                                   | open                                    |
| S-243 | sentence | T1                                                   | open                                    |
| S-244 | sentence | T1                                                   | open                                    |
| S-245 | sentence | T1; F (point 3)                                      | open                                    |
| S-246 | sentence | T1                                                   | open                                    |
| S-247 | sentence | T1                                                   | open                                    |
| S-248 | sentence | T0                                                   | open                                    |
| S-249 | sentence | T0                                                   | open                                    |
| S-250 | sentence | T3                                                   | open                                    |
| S-251 | sentence | T0                                                   | open                                    |
| S-252 | sentence | T1                                                   | open                                    |
| S-253 | sentence | T1                                                   | open                                    |
| S-254 | sentence | T0                                                   | open                                    |
| S-255 | sentence | T0                                                   | open                                    |
| S-256 | sentence | T1                                                   | open                                    |
| S-257 | sentence | T1                                                   | open                                    |
| S-258 | sentence | T1                                                   | open                                    |
| S-259 | sentence | F (point 24)                                         | open                                    |
| S-260 | sentence | T1                                                   | open                                    |
| S-261 | sentence | T1                                                   | open                                    |
| S-262 | sentence | NM (process wiring)                                  | open                                    |
| S-263 | sentence | F (point 24)                                         | open                                    |
| S-264 | sentence | T1                                                   | open                                    |
| S-265 | sentence | T0; F (point 24)                                     | open                                    |
| S-266 | sentence | T1                                                   | open                                    |
| S-267 | sentence | T3                                                   | covered: AuthzTenancy                   |
| S-268 | sentence | T1                                                   | open                                    |
| S-269 | sentence | T3                                                   | open                                    |
| S-270 | sentence | T1                                                   | open                                    |
| S-271 | sentence | T1                                                   | open                                    |
| S-272 | sentence | NM (process wiring)                                  | open                                    |
| S-273 | sentence | T1                                                   | covered: AuthzDecide                    |
| S-274 | sentence | T1                                                   | covered: AuthzDecide                    |
| S-275 | sentence | NM in D1 (D4 transcripts)                            | open                                    |
| S-276 | sentence | T1                                                   | open                                    |
| S-277 | sentence | T1                                                   | open                                    |
| S-278 | sentence | T1                                                   | open                                    |
| S-279 | sentence | T1                                                   | open                                    |
| S-280 | sentence | T1                                                   | open                                    |
| S-281 | sentence | NM (gateway stream plumbing)                         | open                                    |
| S-282 | sentence | NM (timing)                                          | open                                    |
| S-283 | sentence | T1                                                   | open                                    |
| S-284 | sentence | T1                                                   | open                                    |
| S-285 | sentence | T1                                                   | open                                    |
| S-286 | sentence | T0                                                   | open                                    |
| S-287 | sentence | T1                                                   | open                                    |
| S-288 | sentence | T1                                                   | open                                    |
| S-289 | sentence | T0 + T1                                              | open                                    |
| S-290 | sentence | F (point 24) + T1                                    | open                                    |
| S-291 | sentence | NM (index choice)                                    | open                                    |
| S-292 | sentence | F (point 24)                                         | open                                    |
| S-293 | sentence | T0                                                   | open                                    |
| S-294 | sentence | T1                                                   | open                                    |
| S-295 | sentence | T0                                                   | open                                    |
| S-296 | sentence | T2 (keyset stability)                                | open                                    |
| S-297 | sentence | T4                                                   | open                                    |
| S-298 | sentence | F (point 12)                                         | finding: F-090; AuthzDecide             |
| S-299 | sentence | F (point 12)                                         | finding: F-090; AuthzDecide             |
| S-300 | sentence | T1                                                   | open                                    |
| S-301 | sentence | T1                                                   | open                                    |
| S-302 | sentence | NM (runner, out of scope)                            | open                                    |
| S-303 | sentence | NM (runner)                                          | open                                    |
| S-304 | sentence | NM (runner)                                          | open                                    |
| S-305 | sentence | F (point 24)                                         | open                                    |
| S-306 | sentence | T1                                                   | open                                    |
| S-307 | sentence | NM (runner)                                          | open                                    |
| S-308 | sentence | NM (runner)                                          | open                                    |
| S-309 | sentence | NM (runner); relay mapping in EV-29                  | open                                    |
| S-310 | sentence | T1                                                   | open                                    |
| S-311 | sentence | F (point 24)                                         | open                                    |
| S-312 | sentence | T1                                                   | open                                    |
| S-313 | sentence | T3                                                   | open                                    |
| S-314 | sentence | T1                                                   | open                                    |
| S-315 | sentence | T1                                                   | open                                    |
| S-316 | sentence | NM (runner)                                          | open                                    |
| S-317 | sentence | NM (runner)                                          | open                                    |
| S-318 | sentence | NM (runner)                                          | open                                    |
| S-319 | sentence | NM (runner)                                          | open                                    |
| S-320 | sentence | NM (UI)                                              | open                                    |
| S-321 | sentence | T3                                                   | covered: AuthzTenancy                   |
| S-322 | sentence | F (point 24)                                         | open                                    |
| S-323 | sentence | F (point 24)                                         | open                                    |
| S-324 | sentence | NM (deployment wiring)                               | open                                    |
| S-325 | sentence | NM (deployment wiring)                               | open                                    |
| S-326 | sentence | T1                                                   | open                                    |
| S-327 | sentence | NM (test-design statement)                           | open                                    |
| S-328 | sentence | F (point 24) + T1                                    | open                                    |
| S-329 | sentence | NM in D1 (D2 `runPublic`)                            | open                                    |
| S-330 | sentence | T1                                                   | open                                    |
| S-331 | sentence | T1                                                   | open                                    |
| S-332 | sentence | NM in D1 (D5)                                        | open                                    |
| S-333 | sentence | T3                                                   | open                                    |
| S-334 | sentence | T1                                                   | open                                    |
| S-335 | sentence | T1                                                   | open                                    |
| S-336 | sentence | T1                                                   | open                                    |
| S-337 | sentence | NM in D1 (D5)                                        | open                                    |
| S-338 | sentence | NM in D1 (D5); F (point 28)                          | open                                    |
| S-339 | sentence | T3                                                   | open                                    |
| S-340 | sentence | T0                                                   | covered: AuthzTenancy                   |
| S-341 | sentence | T1                                                   | covered: RunCompose                     |
| S-342 | sentence | T1                                                   | covered: RunCompose                     |
| S-343 | sentence | T1                                                   | open                                    |
| S-344 | sentence | T1                                                   | open                                    |
| S-345 | sentence | T1                                                   | open                                    |
| S-346 | sentence | T1                                                   | open                                    |
| S-347 | sentence | T1                                                   | open                                    |
| S-348 | sentence | T1                                                   | open                                    |
| S-349 | sentence | T1                                                   | open                                    |
| S-350 | sentence | T1                                                   | open                                    |
| S-351 | sentence | NM (runner)                                          | open                                    |
| S-352 | sentence | NM (runner)                                          | open                                    |
| S-353 | sentence | F (point 24, stale)                                  | open                                    |
| S-354 | sentence | T1 (`sandboxFor`)                                    | open                                    |
| S-355 | sentence | NM in D1 (D4)                                        | not modelled: D4 transcript project key |
| S-356 | sentence | T1                                                   | finding: F-088; AuthzDecide             |
| S-357 | sentence | T1                                                   | covered: AuthzDecide                    |
| S-358 | sentence | T3                                                   | covered: AuthzTenancy                   |
| S-359 | sentence | T1                                                   | open                                    |
| S-360 | sentence | NM (route-inventory gate; D7 T5)                     | open                                    |
| S-361 | sentence | NM (operational endpoint)                            | open                                    |
| S-362 | sentence | T3                                                   | not modelled: telemetry outside D1      |
| S-363 | sentence | T1                                                   | open                                    |
| S-364 | sentence | T4 (server ↔ SDK framing)                            | open                                    |
| S-365 | sentence | T2                                                   | covered: AuthzTenancy                   |
| S-366 | sentence | T2                                                   | open                                    |
| S-367 | sentence | NM (deployment wiring)                               | open                                    |
| S-368 | sentence | F (point 24)                                         | open                                    |

## Completed D1 evidence

### Reading order and build

Read the shared Prelude and Contracts models, then Authz, RunCompose, BehaviourRuns,
LifecycleRun and RunAccounting, EventsSse, SdkRuns, and CliRuns; finish with the T0–T4 theorem
families and RAccess/RStream adversarial models. The module reading order and integrated
`lake build` command are above. The unit reports record narrow builds, vector generation, real
TypeScript replays, axiom/import/citation audits, and restored mutation passes. The integrated
`pnpm formal:check` passed after the layer and behaviour imports were registered.

### What users can rely on

- **Request and response shapes (T0):** ContractsFoundation and ContractsRuns pin identifiers,
  problem envelopes, run/session codecs, constants, and list query mapping. EventsSse pins event
  vocabularies, payloads, cursors, and frames. SdkRuns and CliRuns pin their public request and
  command decisions.
- **Run actions (T1):** AuthzDecide and AuthzTenancy pin policy, scope, resolver order, and
  concealment. AuthzRunToken pins claims and gateway decisions. RunCompose pins parser, session,
  model, tool, sandbox, and environment decisions. BehaviourRuns covers all seven run routes and
  their reachable problem paths through real handlers. LifecycleRun pins transitions and ledger
  outcomes.
- **Sequences and isolation (T2/T3):** LifecycleRun establishes terminal absorption, timestamps,
  closed logs, token-state distinctions, and abstract accounting sequences. EventsSse establishes
  event allocation, retention, replay and reserved-name refusal. RAccess proves bounded
  cross-workspace and other-member route properties, and RStream checks stream-specific attacker
  actions; both use real handler or app replays where their reports say so.
- **Boundary disagreements (T4):** RunCompose, LifecycleRun, EventsSse, AuthzRunToken, SdkRuns,
  and CliRuns give concrete current/target witnesses. [Triage](d1-runs-triage.md) classifies the
  corresponding product, document, contract, and ambiguous findings.

### Attacker model and findings

The adversarial units vary caller workspace and role, ownership, browser-token scope, gateway
run-token validity, and stream timing while holding the named run or agent request fixed. Their
claims are conditional on the ownership and scoped-store premises stated in those reports.
[The RAccess report](../units/adversarial-runs-access.md) and
[the RStream report](../units/adversarial-runs-stream.md) identify the proved predicates and real
replays. **Security finding withheld; see the private ledger.**

The [triage ledger](d1-runs-triage.md) records each D1 disagreement and its disposition.
The confirmed, contract-preserving product repairs landed in PRs #282–#294, each with a regression
that failed against the old behavior. They cover the PostgreSQL terminal stream tail, proxy bearer
scheme, SDK SSE parsing and reconnect, empty model rejection, archived-session reuse, initial
stream truncation, public runtime-error text, duplicate terminal events, project reassignment
racing run creation, run-scope UUID spelling, malformed agent-ID precedence, and the explicit
revoke-token capability. The D1 model and generated vectors were updated after those merges.
The documentation repairs include F-001, F-080–F-083, F-085, F-087, F-090, F-092, F-093, F-095,
F-099, earlier F-060/F-065, and the triaged SDK, CLI, SSE and historical ADR drift. F-094's
unreachable permission cells are also explained. The remaining
public-policy and contract choices are recorded in
[proposed ADR-0064](../../adr/0064-d1-public-contract-choices-after-formal-runs-review.md);
database check proposals remain in the separate proposed P1 ADR. These proposals do not assert
that the corresponding product behavior has changed.

### Mutation and model limits

Each unit report gives its author mutation pass and clean restoration. Independent passes killed
all six fresh SDK and all six fresh CLI definition mutations, and the RStream targeted recheck
killed its three formerly surviving mutations after proof repair. ContractsRuns, LifecycleRun,
EventsSse, AuthzRunToken, RunCompose, BehaviourRuns, RAccess, and RStream reports record their
own initial survivors, repairs, and final named build results. These counts concern chosen
mutants, not a measured fraction of every possible product defect.

Lean abstracts cryptography, network scheduling, filesystem isolation, persistence timing,
provider payload extraction, and terminal-width rendering. The reports distinguish pure-model
proofs from in-memory, PostgreSQL, public SDK/CLI, and real app replays. D2 owns share charging,
D4 owns transcript project-key matching, and D5 owns the full session route. Checklist rows
still `open` have no direct completed-unit mapping; they are not silently counted as proved.
