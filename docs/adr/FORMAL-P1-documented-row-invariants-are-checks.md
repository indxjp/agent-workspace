# ADR-FORMAL-P1-documented-row-invariants-are-checks — Documented row invariants are database checks

Status: proposed
Date: 2026-09-23
Decided by: formal specification programme, unit P1-synthesis (`er-synthesis`); needs Owner ratification
Scope: `packages/core/src/db/schema/{agents,sessions,session-transcripts,shares,run-usage-records}.ts`, a migration

## Context

Six row invariants are documented and maintained by the services, but the database does not
enforce them, so another writer can break them. Each is a one-cell state today's schema admits and
the target refuses (`AgentWorkspace.Theorems.Refinement.ErSynthesis`):

| Invariant                                   | Document / code                                                                                                  | Theorem                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| an agent's model choice is a pair           | 04 §5.3: "_always the pair `(modelConnectionId, model)`, never one without the other_" (configuration finding 7) | `diverges_at_a_model_without_connection`     |
| the SDK session id is the session id        | `recordReportedSessionIdentity` refuses any other (work F-2)                                                     | `diverges_at_a_foreign_sdk_session_id`       |
| a transcript's key is its workspace id      | `packages/contracts/src/sessions.ts`: "_the caller's workspace id by construction_" (work F-3)                   | `diverges_at_a_transcript_under_another_key` |
| an agent share has a mode                   | spec §27: "_`mode` … (agents only)_" (publication finding 5)                                                     | `diverges_at_an_agent_share_without_mode`    |
| only a runnable share has a budget          | spec §27: "_`budget_cap_usd` runnable links only_" (publication finding 5)                                       | `diverges_at_a_budget_on_a_definition_share` |
| a ledger row's provider is a model provider | `runs.provider` is closed, `run_usage_records.provider` is free text (work F-4)                                  | `diverges_at_an_unknown_ledger_provider`     |

## Decision

Add `agents_model_pair` (`(model_connection_id is null) = (model is null)`),
`sessions_sdk_id_is_id` (`claude_session_id is null or claude_session_id = id::text`),
`session_transcripts_project_key_is_workspace` (`project_key = workspace_id::text`),
`shares_agent_has_mode`, `shares_budget_only_runnable` and `oneOf('run_usage_records_provider_valid',
…, modelProviders)`. Clear `agents.model` in the transaction that deletes a connection.

## Alternatives considered

- **Document the gaps instead.** The documents already state the invariants; the gap is enforcement.
- **Drop the redundant columns** (`claude_session_id`, `project_key`). Cleaner for two of the six,
  and a larger change to the transcript store; the checks can land first.

## Consequences

- Existing rows must satisfy the checks before the migration; the services already maintain them,
  and the migration reports any row that does not.
- `every_divergence_cell_is_exact` then states the remaining divergences only.
