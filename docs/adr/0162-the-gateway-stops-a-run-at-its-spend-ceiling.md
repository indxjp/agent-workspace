# ADR-0162 — The gateway stops a run at its spend ceiling

Status: accepted — the run ceiling is built by U5.4b (#1524); the session ceiling is decided here and deferred
Date: 2026-11-01
Decided by: the implementing agent of U5.4a (issue #1523, agent portal programme, tracker #1476), on the Owner's delegation for the programme. The recommendations of the issue are taken with the corrections in "What changed since the issue was written"
Scope: `packages/gateway` (`auth.ts`, `database.ts`, a run-ceiling admission beside `daily-cost.ts`), `packages/contracts` (`runs.ts`: `StartRunRequest.spendCeilingUsd`, the run resource, the run-failure code `run_budget_reached`), `packages/core` (`runs.spend_ceiling_usd`), `apps/web` (run start, compose, the run view), `packages/sdk` (`runs.start`), `packages/aw` (`aw runs start`), the engine adapters (`packages/engine`, `packages/engine-openai-agents`, `packages/engine-mastra`, `packages/engine-pi`); amends ADR-0102 SD6 and ADR-0074 D7; takes over the scope of #342

## Context

Long or automatic work — triggers (ADR-0144), recipes, agent teams (ADR-0104) — needs a cost cap
that the platform enforces whatever the engine does, and that the run view can name when it fires.
The portal implementation guide calls it F-3 and splits it into this record (U5.4a) and its build
(U5.4b, #1524). #342 asks for the same per-run cap for every engine. This record decides both.

### What enforces spend today

Checked on the branch this record lands on.

- **The per-run cap is enforced by the engines, inside the runner.** `limits.maxBudgetUsd` flows
  from the agent's policy, met with the deployment ceiling's `limits.maxBudgetUsd`
  (`meetPolicyCeiling`, `packages/contracts/src/policy-ceiling.ts`) and lowered by a trusted
  in-process override (`lowerLimits`, `apps/web/server/compose/run-request.ts`), into the portable
  request (`packages/run-protocol/src/schemas.ts`).
  - Claude Agent SDK: the SDK's own `maxBudgetUsd` (`packages/engine-claude-agent-sdk/src/compile.ts`).
    Its `error_max_budget_usd` result maps to the stop reason `max_budget`
    (`packages/run-protocol/src/claude-sdk-events.ts`).
  - OpenAI Agents: an adapter-side cap priced from a **provisional** table
    (`packages/engine-openai-agents/src/budget.ts`, ADR-0074 D7). Mastra and pi use the same
    provisional cap through the port's `provisionalBudget`
    (`packages/engine/src/compile-checks.ts`). All three refuse a cap on a model the table does not
    price, `engine_capability_unsupported` at compile.
  - None of these is a platform guarantee: they run next to the agent, in the sandbox.
- **The gateway already refuses on cost, per workspace per UTC day.** #1851 (slice 3b) built
  `maxCostPerDayUsd` (`packages/contracts/src/policy-ceiling.ts`) and the admission seam
  `GatewayAdmission.admit(claims)`, which `createAuthenticatedGateway`
  (`packages/gateway/src/auth.ts`) calls after authentication and before `router.fetch`, only for
  the three metered dialects. `createDailyCostAdmission` (`packages/gateway/src/daily-cost.ts`)
  ends the run `failed` with `daily_cost_cap_reached: <message>` through `DailyCostLedger.endRun`,
  and only then answers `403 permission_error`; when the end cannot be written it answers `503
daily_cost_unavailable`. It answers `403`, not `429`, because an SDK retries a `429` whatever its
  error type says. ADR-0102 SD6 carries that amendment.
- **The gateway meters each response.** `recordUsage` adds each response's cost to `runs.cost_usd`
  (`numeric(14,6)`) in the same transaction as its `run_usage_records` row
  (`packages/core/src/db/repositories/runs.ts`). A model the catalogue (`packages/gateway/src/pricing.ts`)
  does not price is recorded at cost 0 and the run's `accounting_state` is `unavailable`.
- **The gateway reads the run row on every call.** `createDatabaseGatewayRunResolver`
  (`packages/gateway/src/database.ts`) reads the run to refuse a terminal one, so its cost and a
  ceiling stored on it come from the same read. `RunResolution` does not return them today.
- **The run row does not store a cap.** `maxBudgetUsd` lives only in the composed request sent to
  the runner.
- **Stop reasons.** `AGENT_STOP_REASONS` already has `max_budget`
  (`packages/contracts/src/run-events.ts`). It travels only on the `agent.result` frame; `runs` has
  no stop-reason column and the console renders none.
- **Failure codes.** A run names why it failed through `runs.error = '<code>: <message>'`, read back
  by `parseRunFailure` (`packages/contracts/src/runs.ts`), which the SDK uses. The run view prints
  `run.error` raw.
- **Sessions are not summed.** Each run of a session has its own `cost_usd`; nothing sums a session
  or caps it.
- **Agent teams.** A child run keeps its own `cost_usd`; the root's `treeCost` is a read-time sum
  (ADR-0104 decision 7).

### What changed since the issue was written

The issue's As-Is predates #1851. Two of its statements are out of date, and this record corrects
them rather than reopening the issue:

- "`maxCostPerDayUsd` is refused as not built" and "Per-day stays refused": the per-day cap is built
  and enforced at the gateway (above). This record builds on its refusal path.
- "The gateway meters but never refuses on cost": it refuses on the workspace's daily spend. It
  does not refuse on a run's spend, which is what this record adds.

## Decision

### 1. Where: a second admission in the gateway, next to the daily cap

The run ceiling is checked in `createAuthenticatedGateway`, after `authenticateGatewayRequest` and
before `router.fetch`, for the metered dialects only (`/v1/messages`, `/v1/responses`,
`/v1/chat/completions`). `/v1/models` and `count_tokens` stay open, as they are for the daily cap.

- The resolver's existing run read returns the run's `cost_usd` and `spend_ceiling_usd` on the
  `active` resolution, so the check costs no extra query. The decision is a pure function of those
  two decimals, compared as integer micro-dollars (never as floats): refuse when a ceiling is set
  and `cost_usd ≥ spend_ceiling_usd`.
- It runs before the daily-cost admission, because it needs no read of its own. Either refusal
  ends the run; the first one to fire names it.
- **The rule is "no new model call once spent ≥ ceiling".** A call that starts below the ceiling is
  forwarded and settled in full. The overshoot is bounded by the cost of the responses already in
  flight when the ceiling is crossed: one response for an engine that makes one model call at a
  time, which every adapter does today. A streamed response's settlement is awaited before its
  stream closes (bounded by the settlement timeout), so the next call normally reads the settled
  cost; a settlement that outlasts the timeout can let one more call through.

### 2. Which ceiling: the lowest of three, stored on the run

The effective run ceiling is the minimum of the values that are set:

1. the agent's `limits.maxBudgetUsd` (the version the run pins);
2. the deployment ceiling's `limits.maxBudgetUsd` (ADR-0102 SD5/SD6);
3. an optional per-start `spendCeilingUsd` on `StartRunRequest` (positive, finite, at most six
   decimal places), and a trusted in-process `limits.maxBudgetUsd` override (evaluations).

`spendCeilingUsd` may only narrow. A value above the lower of (1) and (2) is
`403 policy_cannot_widen` with `details` naming the path `spendCeilingUsd`, as ADR-0102 SD6 refuses
any explicit value above the ceiling. When neither (1) nor (2) is set it is the ceiling.

- It is stored once, when the run row is inserted, as **`runs.spend_ceiling_usd numeric(14,6)
NULL`** — `numeric(14,6)` to match `runs.cost_usd`, not the `bigint` micro-dollars an earlier
  draft of the plan used. `NULL` means no ceiling. The migration is additive.
- The stored value is the run's ceiling for its whole life. Compose passes
  `min(composed limits.maxBudgetUsd, spend_ceiling_usd)` to the engine, so the engine-native cap
  (decision 6) is never looser than the gateway's. An agent edit after the start applies to the
  next run.
- The run resource gains `spendCeilingUsd: string | null` (a decimal string, as `cost.amount` is).
  The four names: contract field and SDK option `spendCeilingUsd`, column `spend_ceiling_usd`, CLI
  flag `aw runs start --spend-ceiling-usd <usd>` (ADR-0114 names them alike, so the guide's shorter
  `--ceiling` is not used).
- **Agent-team members, continuations, triggers and recipes.** Each run start computes its own
  effective ceiling as any start does. A child run of a team (ADR-0104) gets its member agent's
  limit met with the deployment ceiling, never the lead's, which matches ADR-0104 decision 5. A
  ceiling over a whole run tree (the lead plus its children) is **deferred**: `treeCost` is a
  read-time sum, and a tree ceiling would need the gateway to sum the tree on each call. It is
  added only when a reference app needs it, under its own amendment of this record.

### 3. The session ceiling: decided, and deferred

- **Decided.** A session ceiling is an optional `sessions.spend_ceiling_usd numeric(14,6) NULL`,
  set when the session is created and never widened. The same admission checks it against
  `sum(runs.cost_usd) where session_id = <the run's session>`, read with the run (one aggregate on
  an indexed column), and ends the run as decision 5 does, with the run-failure code
  `session_budget_reached`. Every later run start in that session is refused with the same code.
- **Deferred.** No `sessions` column, contract field or code lands now. U5.4b builds the run
  ceiling only. The session ceiling is built when a reference app of the programme needs it, by
  amending this record's status; until then a long conversation is bounded by each run's ceiling
  and by the workspace's daily cap.
- **Per-day is not deferred: it exists.** `maxCostPerDayUsd` is the #1851 cap and is out of this
  record's scope. A per-workspace or per-person budget beyond it is not decided here.

### 4. The gateway's answer: `403` in the provider dialect, code `run_budget_reached`

The refused call answers with the body every gateway refusal already uses,
`{ "type": "error", "error": { "type": "permission_error", "code": "run_budget_reached", "message": … } }`,
which carries both the Anthropic `error.type` and the OpenAI `error.code`, so every engine sees a
hard provider error and ends its turn.

The status is **`403`, not the `429` (or `402`) the issue suggested**: the daily cap proved that an
SDK retries a `429` whatever its type says, and a ceiling does not lift by waiting. `402` would be a
status no other gateway refusal uses and no SDK documents. The `403` is answered only after the
run's end is written (decision 5); an engine that read a `403` from a live run as a rejected key
would otherwise end the run `model_credential_rejected` (issue #661).

### 5. How the run ends: the daily cap's end-run path, no new port

The gateway ends the run itself, through the **same end-run semantics the daily cap uses**
(`DailyCostLedger.endRun` and its database adapter, `runs.finish(runId, 'failed', error)`). The run
ceiling admission takes an `endRun(workspaceId, runId, error)` dependency of that signature,
implemented by the same adapter; the `BudgetRecorder.reached(runId)` port the issue proposed is
**not** added, because it would be a second way to write the same transition.

- The run moves to `failed` with `runs.error = 'run_budget_reached: The run stopped at its spend
ceiling of <n> USD.'`, `<n>` being `spend_ceiling_usd` without trailing zeros. The move is the
  repository's guarded stop: a run that is already terminal keeps its status and its error, so the
  error is written only when none is set yet. The resolver refuses every later call of a terminal
  run (`token_revoked`).
- If the end cannot be written the call answers `503 api_error` with the code
  `run_budget_unavailable`, the run is not ended, and the next call tries again; never `403`. This
  is the daily cap's `daily_cost_unavailable` rule under the run's own code, so a log tells which
  admission failed.
- When the runner reports its own end afterwards, the guarded stop keeps the gateway's.
- **`run_budget_reached` joins the run-failure code set**: a `RUN_BUDGET_REACHED` constant beside
  `RUNTIME_CAPACITY_EXHAUSTED`, in `RunFailure['code']`, recognised by `parseRunFailure`. It is not a
  run-start problem code: no start can have spent its ceiling. The gateway's `AdmissionRefusal.code`
  widens to include it.
- **Relation to `daily_cost_cap_reached`.** The same refusal path — the same admission seam, the same
  `403` after the same end-run write, the same `503` when the write fails — at a different scope:
  the daily cap is the workspace's spend today, the run ceiling is this run's own `cost_usd`.
- **No new stop reason.** `budget_reached` is rejected: `max_budget` exists and the Claude SDK maps
  to it. An adapter that already reads the gateway's error code (as the Claude adapter does for
  `token_*`) maps a `run_budget_reached` refusal to `agent.result { stopReason: 'max_budget' }`; one
  that cannot reports `error`. Neither matters to the run view, which reads the failure code, not the
  stop reason.

### 6. Engine caps: the Claude SDK's stays, the provisional caps are retired

- The Claude Agent SDK keeps receiving `maxBudgetUsd` (decision 2's lower value): defence in depth,
  at no cost, and its own stop is still `max_budget`. A run it stops ends as the runner reports it.
- The provisional caps of OpenAI Agents, Mastra and pi are **retired** with #342: `budget.ts`, the
  port's `provisionalBudget` and its price table go, and so does their compile-time refusal of a cap
  on an unpriced model. Those engines declare that they leave the cap to the gateway. Only the
  gateway prices, from the deployment's catalogue, so ADR-0065 D6's single billing source holds and
  the second table disappears.
- **A run on an unpriced model is not capped.** Its responses are recorded at cost 0 with
  `accounting_state = 'unavailable'`, so `cost_usd` never reaches the ceiling. This is deliberate and
  differs from the daily cap, which refuses unpriced spend: refusing would make every run with a
  ceiling on an unpriced model unrunnable, which is the provisional cap's refusal this record
  retires. An operator who needs a hard bound on such a model prices it in the catalogue or sets
  `maxCostPerDayUsd`. The run view says the ceiling was not enforced (decision 7).

### 7. The run view renders from the failure code

- A run whose `parseRunFailure(run.error).code` is `run_budget_reached` shows "Stopped at its spend
  ceiling (<n> USD)" / 「利用上限（<n> USD）に達したため停止しました」, `<n>` taken from
  `run.spendCeilingUsd`, never parsed from the message text.
- A run with a ceiling whose `accountingState` is `unavailable` shows "This run's model has no
  price, so its spend ceiling could not be enforced." / 「このランのモデルには価格がないため、利用上限を適用できませんでした。」
- Both strings are in the ja and en catalogues, and the run detail shows the ceiling next to the
  cost when one is set.

## Alternatives considered

- **Carry the ceiling as a signed run-token claim, as `dailyCostCapUsd` is.** Rejected: the run's
  cost has to be read from the run row anyway, the run view needs the ceiling to name it, and a
  claim can only be read by the gateway. A column serves both from one fact.
- **Keep the engines' caps and fix the price table.** Rejected (#342): the cap runs in the sandbox,
  next to the agent, and a second price table disagrees with the catalogue by construction.
- **A new `BudgetRecorder` port.** Rejected in decision 5: the daily cap already writes the same
  transition, guarded, with the same failure handling.
- **Answer `429`, or `402`.** Rejected in decision 4.
- **A new stop reason `budget_reached`.** Rejected in decision 5.
- **Build the session ceiling now.** Deferred in decision 3: no reference app needs it yet, and the
  run ceiling plus the daily cap bound every session today.

## Consequences

- U5.4b (#1524) builds decisions 1, 2 and 4–7 and closes #342 when its acceptance items are met:
  an additive migration for `runs.spend_ceiling_usd`; `StartRunRequest.spendCeilingUsd` and
  `RunResource.spendCeilingUsd`; `RUN_BUDGET_REACHED` in `parseRunFailure`; the resolver's
  `active` resolution carrying cost and ceiling; the admission and its `503`; the SDK option and the
  CLI flag; the adapters' retirement of the provisional cap; the run view's two messages in ja and
  en. A run with a tiny ceiling stops with `run_budget_reached` on every engine.
- ADR-0102 SD6 gains a pointer: the per-run part of D13 (`limits.maxBudgetUsd`, "cost per run") is
  gateway-enforced from U5.4b on.
- ADR-0074 D7 is retired by this record when U5.4b lands; until then it stays in force.
- The share-link charge model (`share_run_charges`, spec §20.6.3) is unchanged.
- The session ceiling and a run-tree ceiling remain declared gaps until a reference app needs them.

## Related decisions

- [ADR-0102](0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md) — the
  policy ceiling (SD5, SD6) and the daily cap's amendment this record builds on.
- [ADR-0074](0074-the-openai-agents-sdk-runs-a-plain-agent-behind-the-port.md) — D7, the provisional
  adapter budget this record retires.
- [ADR-0065](0065-an-agents-engine-is-an-extension-point-behind-one-port.md) — D6, the gateway as
  the single billing source.
- [ADR-0068](0068-openai-wire-protocols-are-passthrough-ingress.md) — D9, unpriced settlement.
- [ADR-0104](0104-a-team-is-a-resource.md) — child runs
  and `treeCost`.
- [ADR-0114](0114-the-sdk-and-the-cli-give-each-operation-one-name.md) — the names alike.
- Issues #1523 (this record), #1524 (its build), #342 (per-run budget for every engine), #1851 (the
  daily cap), #661 (how an engine reads a gateway refusal).
