# Unit `concept-work` — projects, sessions, runs, run events and usage (phase P1b)

The work cluster: what a project, a session (with its transcripts), a run (with its tokens), a run
event and a unit of usage are, as the database, the wire contract and the documents know them; the
invariants each carries; how they relate; and where the three disagree. It is built on the
`er-core` foundation (`Er/Core.lean`, `Prelude/Ids.lean`), which it imports and does not redefine.

| File                                                                                     | What it holds                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `formal/AgentWorkspace/Concepts/Project.lean`                                            | `ProjectVisibility`, `ProjectListFilter` (`WireEnum`s), `ProjectState`, `Project`, `hasNonSpace` (`btrim`), the two project invariants, `state`, `listedBy`                                                                                                                    |
| `formal/AgentWorkspace/Concepts/Session.lean`                                            | `SessionStatus`, `Session`, `LaunchMode`, `resumable`, `launchMode`, `recordReported`, `identityCurrent`; transcript keys: `isProjectKey`, `isWindowsDeviceName`, `tenantScopeOk` (blankness by `ModelConnection.isBlank`), `isWireSubpath`, `Transcript`, `TranscriptMessage` |
| `formal/AgentWorkspace/Concepts/Run.lean`                                                | `ModelProvider`, `Run` (reusing `Contracts.RunStatus`), the six run invariants, `durationMs`, `create`, `stamp`, `lastStamp`, `agentVia`, `ownerVia`; `RunToken` and its two invariants                                                                                        |
| `formal/AgentWorkspace/Concepts/RunEvent.lean`                                           | `RunEvent`, the frame vocabulary (`controlFrameNames`, `runStatusEvent`, `relayedEventNames`, `FrameKind`, `isEventName`), `sequencesOf`, `isWindow`, `logContiguous`                                                                                                          |
| `formal/AgentWorkspace/Concepts/Usage.lean`                                              | decimal text (`isDecimal`, `isZeroDecimal`, `isNonNegDecimal`), `Counters`, `totalTokens`, `AccountingState`, `UsageRecord`, `ledgerAccounting`                                                                                                                                |
| `formal/AgentWorkspace/Er/Current/Work.lean`                                             | `workTables`, `AuditAction`, `AuditEvent`, the concept-to-row encoders, `workCheck` (semantics of the 15 checks `Er.Core` records by name only), `workCheckSql`, `workConsistent`, `workFk`, `Cardinality`, `fkCardinality`                                                    |
| `formal/AgentWorkspace/Theorems/{WellFormed,Normative,Invariants,Meta}/ConceptWork.lean` | the theorems, by tier                                                                                                                                                                                                                                                          |
| `formal/Vectors/ConceptWork.lean` → `formal/generated/vectors/concept-work/`             | ten vector files, 360 vectors                                                                                                                                                                                                                                                  |
| `tests/formal/concept-work.test.ts`                                                      | package side: enums, foreign keys, checks, check verdicts, transcript keys, event names, owner fields (307 tests)                                                                                                                                                              |
| `apps/web/formal/concept-work.test.ts`                                                   | application side (D-012): `InMemoryRunStore`, `renderRun`, `sessionForLaunch`, `recordReportedSessionIdentity` (53 tests)                                                                                                                                                      |

## Modelling decisions

- **The catalogue is not copied.** The twelve tables' columns, keys, foreign keys and closed-set
  checks are already in `Er.Core.catalogue` and pinned to the 0025 snapshot by `er-core`. This
  unit adds meaning on top: `workCheck` gives each of the 15 checks of these tables that are not
  closed sets a semantics over `Row`, under SQL's three-valued logic (a comparison with a `NULL`
  operand passes). `Er.Core.otherCheckHolds` could not be refined in place (it is outside this
  unit's ownership), so `workConsistent = consistent catalogue ∧ workChecksHold` is the work
  cluster's notion of a state PostgreSQL can hold.
- **Concepts are typed; rows are text.** Each concept is a structure with typed ids, enums and
  instants (`Nat`), and `…Cells` encodes it as the row it is stored as. The encoders are proved to
  fit their tables (every `NOT NULL` column filled, only table columns named, closed-set checks
  passed), and the concept invariants are proved **equal** to the row checks
  (`…_invariants_are_the_row_checks`). A mutation on either side therefore fails a theorem.
- **A kernel-reducible number parser.** `String.toNat?` does not reduce in the kernel, so
  `parseNat?` (digits folded with `Nat.ofDigitChars`) reads counters and instants back, and
  `instant_round_trips` proves it inverts `toString` (via `Nat.toNat?_repr`). This is what lets
  `decide +kernel` check the witness states.
- **Money stays text.** Costs are the decimal strings PostgreSQL renders and the wire carries; the
  model only decides "is a non-negative decimal" and "is zero", which is all the checks read.
- **Lifecycle states only; two operation families.** Project `active|archived`, session
  `active|archived`, run status (reused), accounting state. Two operations are modelled, because
  a documented sentence of this cluster is a statement about each: the run store's timestamp
  stamping (`Run.stamp`, driven by `Lifecycle.runStep` in `timedStep`), for
  `runs_ended_at_iff_terminal` and `runs_ended_after_started`; and the event repository's
  `append` (`appendEvent`: allocate `max(sequence) + 1`, insert, prune the run's events at or
  below `next - maxEvents`), for "Sequence numbers are contiguous per run". The other transitions
  (archive/restore, settlement, token revocation, transcript redelivery) are Phase 4.
- **Run ownership and agent are derived.** `Run.agentVia` / `Run.ownerVia` go through the
  session, as the schema does; there is no `Run.agent` or `Run.owner` field. Both need the
  session's id **and** workspace to match (the composite key), and are proved to agree with the
  row reference `runs_session_workspace_fk`.
- **One blankness predicate.** "Not blank" for the tenant session scope's configuration directory
  is `ModelConnection.isBlank`, the full ECMAScript _WhiteSpace_ and _LineTerminator_ set that
  `String.prototype.trim` strips (proved exhaustive against the specification by
  `concept-configuration`); this unit no longer carries its own, narrower copy.
- **Audit events** have no concept module of their own in this unit's ownership; `AuditAction`
  and `AuditEvent` live in `Er/Current/Work.lean`.

## Theorems (179: 59 T0, 70 T1, 41 T2, 9 T5; plus 84 traced definitions)

- **T0 (WellFormed).** The six enumerations equal the catalogue's closed sets, in order
  (`project_visibility_is_the_visibility_check`, `session_status_…`, `run_status_…`,
  `model_provider_…`, `accounting_state_…`, `audit_action_…`), and
  `check_value_lists_match_the_concepts` pins the value lists inlined into the check bodies.
  `every_work_check_is_refined` and `work_check_counts` (15 other checks, 21 checks in all).
  Generated by `aw_work_fk_cardinality_theorems`: one `<fk>_is_exactly_one` / `_is_at_most_one`
  per foreign key of the twelve tables (35), with `work_foreign_key_counts` (24 required, 11
  nullable). Nine `…_row_fits` theorems (one per concept row) and five
  `…_invariants_are_the_row_checks` bridges (project, run, run token, usage record, audit event).
  `instant_round_trips`. Edge cases of the shared text predicates, so that a change to a helper
  both sides of a bridge use still fails a theorem: `decimal_text_edge_cases` (every spelling of
  zero, nonzero, negative and non-`numeric` text), `project_key_edge_cases` (64 characters pass,
  65 and the empty key do not), `windows_device_name_edge_cases`.
  `counters_sum_is_componentwise` (the model's `Counters.sum`
  fold is the counter-by-counter sum, tool calls included; a coherence lemma about the fold, not a
  model of settlement, demoted from T1 in repair round 2).
  `work_constraints_are_satisfiable`: a state consistent under every
  catalogue constraint and every refined check, with a row in every work table and all 35 foreign
  keys in use.
- **T1 (Normative).** Generated by `aw_work_cardinality_theorems`: one theorem per foreign key
  (29) — `<fk>_links_exactly_one_parent` when every key column is `NOT NULL` (so
  `runs_session_workspace_fk_links_exactly_one_parent` is "every run belongs to exactly one
  session", cited to the run-lifecycle page), `<fk>_links_at_most_one_parent` otherwise (exactly
  one once the key is set). Composed: `run_reaches_exactly_one_agent`,
  `run_reaches_exactly_one_owner`, `session_user_is_a_member_of_its_workspace`; the concept join
  `run_reaches_agent_and_owner_only_through_its_own_session` (`agentVia`/`ownerVia` answer exactly
  when the session id and the workspace both match), `run_join_refuses_another_workspace_or_session`
  (same session id in workspace `w2`, or another session: nothing), and
  `run_join_agrees_with_the_row_reference` (a row reference through `runs_session_workspace_fk`
  gives the session's agent and owner). Row checks in every `workConsistent` state (corollaries of
  the checks, retiered from T2 in repair round 2 because they restate consistency rather than show
  preservation; the shared unfolding of `workConsistent` is a private helper): `run_row_has_ended_at_iff_terminal`,
  `run_row_ends_after_it_starts`, `run_row_price_version_iff_priced`,
  `unpriced_run_row_costs_zero`, `work_rows_settle_in_usd`, `work_row_counters_are_natural`,
  `run_token_row_expires_after_creation`, `project_row_invariants`, `audit_row_invariants`. Runs
  and usage: `status_and_accounting_are_independent` (row checks only: all 25 combinations pass
  the six `runs` checks; no claim about which a store path reaches),
  `new_run_is_queued_unpriced_and_well_formed`, `unpriced_run_has_no_version_and_costs_zero`,
  `well_formed_run_ends_iff_terminal`, `total_tokens_is_the_sum_of_four_counters` (no tool calls;
  additive across settlements),
  `duration_needs_both_timestamps` (cited to `resources/runs.mdx` "The run record"),
  `duration_is_end_minus_start`,
  `only_complete_is_settled` (settled implies priced; `partial` is priced but not settled),
  `ledger_accounting_follows_the_priced_rows`. Decimal amounts: `zero_decimal_has_no_nonzero_digit`,
  `negative_nonzero_decimal_is_refused`, `run_checks_refuse_unpriced_or_negative_cost`. Sessions: `resumable_means_active_and_reported`,
  `reported_identity_must_be_the_platform_id`, `main_transcript_has_no_wire_subpath`,
  `workspace_id_is_a_safe_project_key` (every canonical UUID passes the SDK's key validator and is
  no Windows device name), `tenant_scope_accepts_a_workspace_key`, and the refusal direction
  `tenant_scope_refuses_unsafe_keys` (an accepted key is 1 to 64 characters with no `/`, backslash or
  `.`, is not a device name, and the directory is not blank) with `tenant_scope_refusals` (`con`, `COM1`, `lpt9`, empty, 65 characters, `a/b`,
  `..`, a blank directory including the Unicode blanks U+3000, U+2028, U+205F, U+1680, U+FEFF;
  U+200B is not blank), `redelivery_keeps_an_earlier_position`. Events:
  `frame_kinds_are_disjoint_and_only_control_is_transient`, `listed_frame_names_are_well_formed`,
  `event_name_pattern_edges` (1 and 64 characters pass, 65 fail; an empty name, a leading digit,
  `_`, `-` or `.`, a space, `:` or a non-ASCII letter fail; accepted names are at most 64
  characters), `contiguous_log_has_distinct_positive_sequences` (stated over `logContiguous`, so
  per run: no repeat, no `0`; two runs interleaved in one table are each contiguous though the
  table's sequences are not; a gap, a repeat, a reordering and a `0` are refused).
  Projects: `project_default_model_travels_with_its_connection`, `project_list_filters_partition`.
- **T2 (Invariants).** Generic, for any schema: `key_identifies_one_row`,
  `reference_has_one_target`, `set_reference_has_a_target`, `required_reference_has_a_target`.
  Generated by `aw_work_tenant_theorems`: `<fk>_preserves_tenant` for each of the 26 work foreign
  keys whose target carries a tenant (the `er-core` isolation lemma instantiated key by key; the
  three references to `users` are global). Uniqueness consequences: `run_event_sequence_is_unique`, `usage_response_is_recorded_once`,
  `sdk_session_id_is_unique_per_workspace`, `run_token_digest_is_unique`, and
  `uniqueness_keys_refuse_a_second_row`, which uses each of the four to show that adding a second,
  _distinct_ row on the same key to the witness state makes it inconsistent. Operations, by
  induction:
  `store_operations_preserve_run_checks` (every sequence of `markRunning`/`finish` with a clock
  that never runs backwards keeps every run check), `store_stamps_follow_the_status` (what each
  operation writes: `markRunning` on a queued run stamps `startedAt := now`; `finish` on a live run
  stamps `endedAt := now` and `startedAt := old ?? now`; every other call writes nothing: the
  store refuses it, or ignores `finish` on a terminal run),
  `store_durations_are_exact` (every reachable run has `startedAt ≤ endedAt`, so the model's
  natural-number `durationMs` equals the integer difference `renderRun` computes),
  `finished_run_has_a_duration`,
  `recording_keeps_the_session_identity`, and `appending_an_event_keeps_every_log_contiguous` (the
  repository's `append` with retention keeps the appending run's log and every other run's log
  contiguous). Of the 41 T2 theorems, 4 are generic key/reference lemmas, 26 per-key tenancy,
  5 uniqueness and 6 operation invariants.
- **T5 (Meta).** The findings below, pinned: `runs_carry_no_owner_principal`,
  `database_admits_a_foreign_sdk_session_id`, `sdk_session_key_is_redundant_under_the_identity`,
  `transcript_store_is_keyed_by_the_platform_id`, `database_admits_a_transcript_under_another_key`,
  `usage_record_provider_is_open_text`, `ledger_admits_an_unpriced_charge`,
  `blank_checks_trim_spaces_only`, `audit_actor_key_is_recorded_as_no_action`.

**Witnesses.** `WellFormed.ConceptWork.Witness.state` extends the `er-core` witness with a project,
a session (SDK id reported), its main transcript and one message, a completed priced run and a
queued run, an event, a revoked token, a ledger row and an audit row, all encoded through the
concept encoders. `work_constraints_are_satisfiable` proves it consistent; every hypothesis-bearing
T1, T2 and T5 theorem has an `example` on it (or on a one-row variant for the T5 counterexamples).

**Mutation coverage.** Twenty mutations have been run against the theorem modules; each was
applied, the modules rebuilt, and the source restored.

| Mutation                                                     | Caught by                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `finish` stops stamping a missing `startedAt`                | `finished_run_has_a_duration`                                                           |
| a key counted as required when _any_ column is `NOT NULL`    | `work_foreign_key_counts`                                                               |
| `isNonNegDecimal s := isDecimal s` (negative costs accepted) | `decimal_text_edge_cases`, `negative_nonzero_decimal_is_refused`, `run_checks_refuse_…` |
| `isZeroDecimal s := isDecimal s` (every decimal is zero)     | `decimal_text_edge_cases`, `zero_decimal_has_no_nonzero_digit`, `run_checks_refuse_…`   |
| `tenantScopeOk` drops `!isWindowsDeviceName`                 | `tenant_scope_refuses_unsafe_keys`, `tenant_scope_refusals`                             |
| `isProjectKey` bound 64 → 65                                 | `project_key_edge_cases`, `tenant_scope_refusals`                                       |
| `durationMs` computes `e + s`                                | `duration_is_end_minus_start`                                                           |
| `positionAtMostSequence` allows one past the sequence        | `redelivery_keeps_an_earlier_position`                                                  |
| `isWindow` drops `1 ≤ lo`                                    | `contiguous_log_has_distinct_positive_sequences`                                        |
| `Run.agentVia` drops `s.workspace = r.workspace`             | `run_reaches_agent_and_owner_only_through_its_own_session`, `run_join_refuses_…`        |
| `Run.ownerVia` returns `some s.ownerPrincipal` always        | `run_reaches_agent_and_owner_only_through_its_own_session`, `run_join_refuses_…`        |
| `sequencesOf` drops the per-run filter                       | `contiguous_log_has_distinct_positive_sequences`, `appending_an_event_keeps_…` (proof)  |
| `isEventName` tail bound 63 → 64                             | `event_name_pattern_edges`; the `event-names.json` replay against `EVENT_NAME_PATTERN`  |
| `stamp`: `markRunning` no longer stamps `startedAt`          | `store_stamps_follow_the_status` (and the `run-store.json` replay)                      |
| `stamp`: `finish` keeps a missing `startedAt` missing        | `store_stamps_follow_the_status`, `finished_run_has_a_duration`                         |
| `stamp`: `finish` stamps `endedAt := now + 1`                | `store_stamps_follow_the_status`, `store_operations_preserve_run_checks`                |
| `Counters.add` drops the `toolCalls` sum                     | `counters_sum_is_componentwise` (T0)                                                    |
| `Counters.add` swaps the input and output sums               | `counters_sum_is_componentwise` (T0)                                                    |
| `isKeyChar` admits `.`                                       | `project_key_edge_cases` (T0; the build stops there)                                    |
| `endedAfterStarted` loosened to `s ≤ e + 1`                  | `run_invariants_are_the_row_checks` (T0; the build stops there)                         |

What the bridges do and do not catch:

- _Row semantics_: the `…_invariants_are_the_row_checks` bridges catch a change on **one** side
  only (a `workCheck` entry, or a concept invariant, rewritten differently from the other). A
  change to a helper **both** sides call (`isZeroDecimal`, `isNonNegDecimal`, `hasNonSpace`,
  `Uuid.isCanonical`) passes the bridges; for the two decimal helpers the edge-case theorems above
  catch it, `hasNonSpace` is pinned by `blank_checks_trim_spaces_only`, and `Uuid.isCanonical`
  belongs to `er-core`. Loosening a check so that the witness fails it breaks
  `work_constraints_are_satisfiable`.
- _Enumerations_: adding, dropping or reordering a member breaks the `…_is_the_…_check` theorem,
  and the Vitest replay against both TypeScript arrays and the Zod enum.
- _Encoders_: dropping a required cell or misspelling a column breaks `…_row_fits`.
- _Tenancy_: a work key that stops being tenant-paired fails its `<fk>_preserves_tenant` proof.
- _Status stamping_: any change to what `markRunning` or `finish` writes (which timestamp, which
  value, on which status) breaks `store_stamps_follow_the_status`, and the `run-store.json`
  replay against `InMemoryRunStore`. `store_operations_preserve_run_checks` catches only a change
  that produces a row the checks refuse (dropping the `running` stamp does not), and
  `finished_run_has_a_duration` only a finish without a start.
- _Extra transition_: an extra edge in `Lifecycle.runStep` that leaves a terminal run (for example
  `markRunning` from `completed`) breaks `step_well_formed`, because the run would keep an `endedAt`
  while live.

## Glossary — one meaning per term

| Term                   | Meaning in this model                                                                                                                                                                                              | Today's aliases and conflations                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace**          | The tenant; every row of the cluster has exactly one (`workspace_id NOT NULL`).                                                                                                                                    | The transcript `projectKey` is the workspace id by construction (a second copy; F-3).                                                               |
| **Project**            | A container of sessions, instructions, defaults, file and connector selections; `active` or `archived` by `archived_at`.                                                                                           | "project" also names the transcript `project_key` (`CLAUDE_CODE_PROJECT_DIR_NAME`), which is a _workspace_ key, not a project — a naming collision. |
| **Session**            | One conversation with one agent: the continuity between runs (`sessions` row, `SessionResource`).                                                                                                                  | "session" also means the **browser sign-in session** (`auth.kind: 'session'`, the cookie, `SessionPrincipal`, "a session proves identity") — F-6.   |
| **Session id**         | `sessions.id`, the platform's row id (`SessionResource.id`, `StartRunRequest.sessionId`, `RunResource.sessionId`, `session_transcripts.session_id`).                                                               | —                                                                                                                                                   |
| **SDK session id**     | `sessions.claude_session_id`: the id the Claude Agent SDK reported (`claudeSessionId`, `providerSessionId` in 04 §5.11, the `:engineSessionId` path segment). Today it is `NULL` or equal to the session id (F-2). | Three names for one value once reported; the route is keyed by it while the store is keyed by the session id.                                       |
| **Transcript**         | One stored SDK transcript of a session: main (`subpath = ''`) or a subagent's (`subpath` non-empty), key `(workspace, projectKey, session, subpath)`.                                                              | The wire calls the non-empty subpaths "subkeys" and refuses `''`; the database spells the main transcript `''`.                                     |
| **Transcript message** | One delivery of a transcript entry, ordered by `sequence`, placed at `position` (the first delivery's sequence).                                                                                                   | —                                                                                                                                                   |
| **Run**                | One execution of one agent inside one session; its agent, project, initiating user and owner are its session's.                                                                                                    | 04 §2 lists runs among the rows that carry `ownerPrincipalId` (F-1).                                                                                |
| **Run status**         | The run lifecycle (`queued`, `running` live; `completed`, `failed`, `cancelled` terminal).                                                                                                                         | Not the accounting state: the two are independent (`status_and_accounting_are_independent`).                                                        |
| **Accounting state**   | Whether usage settlement is trustworthy (`pending`, `complete`, `partial`, `failed`, `unavailable`); priced = `complete` or `partial`; settled = `complete` only.                                                  | Not the run status; `failed` exists in both vocabularies with different meanings.                                                                   |
| **Usage**              | The five counters (`input`, `output`, `cacheRead`, `cacheCreation` tokens, `toolCalls`); `totalTokens` is the sum of the four token counters.                                                                      | `RunTelemetry.costUsd` is a JSON number while `RunCost.amount` is a decimal string (04 §4 records this).                                            |
| **Ledger row**         | One `run_usage_records` row: one provider response's usage, unique per `(run, provider_response_id)`.                                                                                                              | "usage record" and "ledger row" are the same thing.                                                                                                 |
| **Run event**          | A durable, sequenced stream entry (`run.status` or a relayed runtime event); its `sequence` is the resume cursor, contiguous per run.                                                                              | Control frames (`done`, `run-failed`, `stream-reset`) are frames, not run events.                                                                   |
| **Run token**          | A gateway credential minted for one run; only its digest is stored.                                                                                                                                                | Not a browser token (`browser_tokens`), which may also be scoped to a run.                                                                          |

## Findings

No security finding: every reference of the cluster to a tenant-carrying table is tenant-paired
(26 `<fk>_preserves_tenant` theorems), and the invariants the database does not enforce (F-2, F-3)
are enforced by the repositories today.

| #   | Severity      | Document / code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Lean (Current / Target)                                                                                                                                                                                                                                                                                                                                              | Proposed resolution                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-1 | documentation | `docs/sdk/04-api-specification.md` §2: "Ownership: every row that can be "own" or "other" (agents, skills, files, connectors, projects, sessions, **runs**, shares) carries `ownerPrincipalId`." `runs` has no `owner_principal_id` (`packages/core/src/db/schema/runs.ts`) and `RunResourceSchema` has no `ownerPrincipalId`; a run is own/other by its session's owner (`RunRecord.ownerPrincipalId`, "the exact workspace principal that owns the session").                                                                                                                                                                                              | Current: `Meta.ConceptWork.runs_carry_no_owner_principal`, `Normative.ConceptWork.run_reaches_exactly_one_owner`; vector `owner-field/RunResourceSchema`. Target: unchanged schema, corrected sentence.                                                                                                                                                              | Docs fix: "… (agents, skills, files, connectors, projects, sessions, shares) carries `ownerPrincipalId`; a run is owned through its session." Same clarification for the `runs` row of the role table in `ownership-and-sharing.mdx`.                                                                                                                                                            |
| F-2 | naming        | Three names for one identifier. `sessions.claude_session_id` is free `text`, but `recordReportedSessionIdentity` (`apps/web/server/composition/session-launch.ts`) refuses any reported id other than `sessions.id`, so today it is `NULL` or the platform id. The transcript routes are keyed `:engineSessionId` (`apps/web/server/sessions/api.ts`, "the SDK's session id, not `sessions.id`"), while `session_transcripts.session_id` references `sessions.id`. 04 §5.11 calls it `providerSessionId` and says "the platform id is accepted too".                                                                                                         | Current: `Session.identityCurrent`, `Meta.ConceptWork.database_admits_a_foreign_sdk_session_id`, `sdk_session_key_is_redundant_under_the_identity`, `transcript_store_is_keyed_by_the_platform_id`, `Invariants.ConceptWork.recording_keeps_the_session_identity`. Target: `identityCurrent` as a database check, or the column replaced by a reported-at timestamp. | ADR draft: either add `CHECK (claude_session_id IS NULL OR claude_session_id = id::text)` and keep the name, or replace the column with `sdk_reported_at timestamptz` (resumable = active ∧ reported) and drop the then-redundant unique index `sessions_workspace_claude_session_key`; rename the route segment to `:sessionId` and the doc term to "session id (the SDK uses the same value)". |
| F-3 | correctness   | `session_transcripts.project_key` "is the caller's workspace id by construction" (`packages/contracts/src/sessions.ts`); the repository refuses any other key, but the table has no check tying it to `workspace_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                        | Current: `Meta.ConceptWork.database_admits_a_transcript_under_another_key`; Target: `Transcript.projectKeyIsWorkspace` as a check.                                                                                                                                                                                                                                   | Issue: add `CHECK (project_key = workspace_id::text)` (defence in depth for §25), or drop the redundant `project_key` column and derive the SDK key from `workspace_id`.                                                                                                                                                                                                                         |
| F-4 | correctness   | `runs.provider` is the closed set `MODEL_PROVIDERS`; `run_usage_records.provider`, "the authoritative reconciliation ledger", is free text. The ledger's other application invariant, "an unpriced response is recorded at `cost_usd = '0'`", has no check either.                                                                                                                                                                                                                                                                                                                                                                                           | Current: `Meta.ConceptWork.usage_record_provider_is_open_text`, `Meta.ConceptWork.ledger_admits_an_unpriced_charge`, `Usage.UsageRecord.unpricedIsZero` (not part of `workConsistent`).                                                                                                                                                                              | Issue: add `oneOf('run_usage_records_provider_valid', …, modelProviders)` and `CHECK (price_table_version IS NOT NULL OR cost_usd = 0)` in a migration, or document why the ledger is open.                                                                                                                                                                                                      |
| F-5 | documentation | `audit_events_actor_principal_workspace_fk`: `Er.Core.catalogue` and `migrations/meta/0023_snapshot.json` record `ON DELETE NO ACTION`, but migration `0020_sparkling_nova.sql` deploys `ON DELETE SET NULL ("actor_principal_id")` (the schema comment says Drizzle's DSL cannot express it). The ER model built from the snapshot is wrong about this key's deletion behaviour.                                                                                                                                                                                                                                                                            | Current: `Meta.ConceptWork.audit_actor_key_is_recorded_as_no_action`.                                                                                                                                                                                                                                                                                                | Record the override where the catalogue is transcribed (an `er-core` follow-up: a `SET NULL (cols)` action in `OnDelete`), and note it under `docs/sdk/07-structure-map.md` §3.                                                                                                                                                                                                                  |
| F-6 | naming        | "Session" means both the platform conversation (`sessions`) and the browser sign-in session (`auth.kind: 'session'`, `SessionPrincipal`, `workspaces-and-principals.mdx`: "A session proves identity").                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Glossary above.                                                                                                                                                                                                                                                                                                                                                      | Docs fix: call the credential the "browser session" (or "sign-in session") everywhere it is not the `sessions` resource.                                                                                                                                                                                                                                                                         |
| F-7 | documentation | `length(btrim(x)) > 0` (`projects_name_not_blank`, `audit_events_*_label_not_blank`) strips spaces only, so a name of tabs or line breaks passes the database; the project routes refuse it (`apps/web/server/projects/http.ts` tests `name.trim()`).                                                                                                                                                                                                                                                                                                                                                                                                        | Current: `Meta.ConceptWork.blank_checks_trim_spaces_only`, `Project.hasNonSpace`.                                                                                                                                                                                                                                                                                    | Issue (low): use `name ~ '\S'` or `btrim(name, E' \t\r\n')` so the database agrees with the route; until then, document that the route is the stricter gate.                                                                                                                                                                                                                                     |
| F-8 | correctness   | `RunCostSchema.amount` is documented as "A decimal string, never a float" (`packages/contracts/src/runs.ts`), but the schema is `z.string().min(1)`: `"1e3"`, `"NaN"` or `"abc"` parse. The only decimal guard is the PostgreSQL repository's inline `/^\d{1,8}\.\d{6}$/` on settlement input (`packages/core/src/db/repositories/runs.ts`).                                                                                                                                                                                                                                                                                                                 | Current: `Usage.isDecimal` (the model's reading), `WellFormed.ConceptWork.decimal_text_edge_cases` (non-`numeric` text is not a decimal). Target: the wire schema refines `amount` by the same grammar.                                                                                                                                                              | Issue (low): export a `DECIMAL_AMOUNT_PATTERN` from contracts and use it in `RunCostSchema.amount` and the settlement guard, so the wire, the repository and this model share one predicate that a vector can replay.                                                                                                                                                                            |
| F-9 | documentation | No document says when a run's timestamps are set. `docs/sdk/site/concepts/run-lifecycle.mdx` "From `start` to a terminal status" and `docs/sdk/site/resources/runs.mdx` list `startedAt` / `endedAt` without a rule; "A finished run has an end time and an unfinished one does not" is a schema comment (`packages/core/src/db/schema/runs.ts`, `runs_ended_at_iff_terminal`), and the stamping rules are `RunStore` doc comments (`apps/web/server/runs/store.ts`: "stamping `startedAt`", "stamping `endedAt`") and an inline comment in `InMemoryRunStore.finish` ("a run that is finished without ever having been marked running still gets a start"). | Current: `Run.endedAtIffTerminal`, `Run.stamp`, `Normative.ConceptWork.run_row_has_ended_at_iff_terminal`, `Invariants.ConceptWork.store_stamps_follow_the_status` (cited to the code only).                                                                                                                                                                         | Docs fix (D1): add to the run-lifecycle page: "`startedAt` is set when the run starts running; `endedAt` is set exactly when it reaches a terminal status, and a run that ends without having run gets `startedAt` at the same instant", and cite it from these declarations.                                                                                                                    |

## Gaps

- **Check verdicts replay only where TypeScript has the predicate.** The SQL body of every
  refined check is compared with the snapshot, and `runs_ended_at_iff_terminal` and
  `audit_events_subject_id_shape` verdicts replay against `isTerminalRunStatus` and `isUuid`; the
  other row verdicts (`btrim`, decimals, timestamps) have no TypeScript oracle and are not executed
  against PostgreSQL (no database in the formal suite).
- **Not callable from a test:** the `resumable` derivation is inline in two handlers of
  `apps/web/server/sessions/api.ts`; the ledger's accounting derivation (`pricedCount`) is inline in
  the PostgreSQL repository's settlement transaction; the Windows device-name refusal is private
  to `packages/run-protocol/src/schemas.ts` (it is observed through `validateTenantSessionScope`). The
  `?archived=` filter is replayed against `PROJECT_LIST_FILTERS` only.
- **Phase 4 behaviour:** project archive/restore (`409 project_archived`), session
  archive/restore (`409 session_archived`), run-token revocation, settlement (the ledger update and
  its effect on the run aggregate: a repeated `providerResponseId` adds no tokens, as a
  `'duplicate'` retry or a late priced arrival that updates cost only; including the TypeScript keeping a prior `priceTableVersion`
  when a later attempt is unpriced), and transcript append/redelivery (`positionAtMostSequence` is
  a shape predicate here). Event append with retention is modelled (`appendEvent`) after the
  PostgreSQL repository but not replayed: it needs a database, and the in-memory `RunEventLog`
  (`apps/web/server/runs/store.ts`, `lastId + 1`, drop from the front) is a separate
  implementation whose append/stream API is asynchronous; a replay of it is a follow-up.
- **`agentVia` / `ownerVia` have no TypeScript oracle.** The run's owner is resolved inside the
  run stores (`RunRecord.ownerPrincipalId`) from a session the store looks up itself; the join is
  pinned by theorems (concept and row level), not replayed.
- **Decimal verdicts have no TypeScript oracle.** The decimal reading is pinned by theorems over
  concrete PostgreSQL renderings, not replayed: `RunCostSchema.amount` is `z.string().min(1)` and
  the PostgreSQL repository's `/^\d{1,8}\.\d{6}$/` guard is inline in the settlement
  transaction, so neither is a callable predicate.
- **`workConsistent` is layered, not merged.** `Er.Core.otherCheckHolds` still reads the 15 checks
  as vacuous; `consistent catalogue` alone does not imply them. A later edit of `Er/Core.lean`
  could fold `workCheck` into `otherCheckHolds`.
- **`durationMs` over ill-formed rows.** The model subtracts in `Nat`, `renderRun` subtracts
  numbers; they differ only for a row with `ended_at < started_at`, which
  `runs_ended_after_started` refuses and no store path produces (`store_durations_are_exact`). The
  replay (`run-render.json`) samples only rows that pass the check.
- **Store stamps replay only `InMemoryRunStore`.** The `run-store.json` vectors drive the
  in-memory store; the PostgreSQL repository's `markRunning`/`finish`, which the stamp theorems
  also cite, is not replayed (no database in the formal suite). D1 should replay it.
- **Counter accumulation has no replay.** `recordUsage` adds counters in SQL inside the settlement
  transaction; `counters_sum_is_componentwise` is T0 (about the model's fold) until Phase 4
  models the settlement step and a vector replays it.

## Phase-1 debt (paid in D1)

The open problems of verifier run `wf_c504decc-c19`, one line each.

1. **Uncaught `markRunning` stamp mutation**: fixed; `Invariants.ConceptWork.store_stamps_follow_the_status` states what every operation writes on every status and fails under that mutation (and two further `stamp` mutations; table above).
2. **Inaccurate "Status stamping" claim**: corrected; the bridge paragraph now names `store_stamps_follow_the_status` and says what the other two theorems do not catch.
3. **Loose doc citation on `run_row_has_ended_at_iff_terminal` / `Run.endedAtIffTerminal`**: dropped (also from `well_formed_run_ends_iff_terminal`); they cite the schema check only, and the missing document sentence is finding F-9.
4. **`work_check_holds_on_every_row` cited one table of nine**: resolved by making it a private helper (it is the unfolding of `workConsistent`); the `checks.json` vectors now cite `work_check_counts`.
5. **Near-tautological T1 theorems**: `work_check_holds_on_every_row` made private; `unpriced_ledger_row_costs_zero` removed (a restatement of `UsageRecord.unpricedIsZero`; F-4 stays pinned by `ledger_admits_an_unpriced_charge`); `project_key_length_is_bounded` folded into `tenant_scope_refuses_unsafe_keys`, which now states consequences, not the definition (1–64 characters, no `/`, backslash or `.`, no device name, non-blank directory).
6. **Coverage of `Counters.add` and `durationMs`**: `WellFormed.ConceptWork.counters_sum_is_componentwise` (named `Normative.ConceptWork.settlement_adds_every_counter` until repair 2) ties every counter, `toolCalls` included, to the settlement sum; `Invariants.ConceptWork.store_durations_are_exact` proves that every store-reachable run has `startedAt ≤ endedAt`, so the `Nat` duration is the integer difference; ill-formed rows remain a documented gap (above).
7. **(repair 1) Loose citation on `duration_needs_both_timestamps` / `Run.durationMs`**: fixed; both now cite `docs/sdk/site/resources/runs.mdx#the-run-record`, which states the sentence, instead of 04 §5.12.
8. **(repair 1) Overclaim in `settlement_adds_every_counter`**: fixed; the docstring now says "distinct provider responses" and points to the Phase-4 settlement gap (de-duplication by `providerResponseId`), the duplicated `totalTokens` conjunct is dropped (additivity stays in `total_tokens_is_the_sum_of_four_counters`), and the run-lifecycle doc citation is dropped (it lists the counters but never says they accumulate; the code comment in `recordUsage` does).
9. **(repair 1) `store_stamps_follow_the_status` said "leaves the run as it was"**: corrected; the docstring says those calls are refused (`markRunning` answers `false`, a non-terminal `finish` target rejects or throws) or ignored (`finish` on a terminal run).
10. **(repair 1) Build blocked by the concurrent `er-core` edit**: rebuilt in the live worktree once `ErCore.lean` settled; the full unit check passes.
11. **(repair 2) Stale "Integration" gap**: deleted; `formal/AgentWorkspace.lean` and `formal/Vectors/Main.lean` already import and register the unit's modules and vectors.
12. **(repair 2) `settlement_adds_every_counter` tied to `recordUsage` by name only**: demoted to T0 as `WellFormed.ConceptWork.counters_sum_is_componentwise` (a lemma about the model's fold); it still catches both `Counters.add` mutations; linking it to a modelled settlement step is Phase 4 (Gaps).
13. **(repair 2) PostgreSQL `markRunning`/`finish` not replayed**: kept as a gap (no database in the formal suite), now stated in Gaps; D1 should replay it.
14. **(verify 3) Mixed ledger `.partial` → `.complete` uncaught**: closed by the orchestrator. `Normative.ConceptWork.mixed_ledger_is_partial` states that a ledger with a priced and an unpriced row is `partial`, with a witness, and fails under that mutation.
15. **(verify 3) `controlFrameNames` without `stream-reset` uncaught**: handed to D1's `L-events-sse` unit, whose `Contracts/RunEvents` constants are replayed against the real `CONTROL_FRAME_NAMES`, `RUN_STATUS_EVENT` and `RELAYED_EVENT_NAMES`. A T0 theorem there equates them with `Concepts.RunEvent`'s lists.
16. **(verify 3) Retention bound stated only by an `example`**: closed by the orchestrator. `Invariants.ConceptWork.append_prunes_at_the_cutoff_and_keeps_the_newest` states that every kept event lies above `next - maxEvents` and that the appended event is kept, and it fails under the `≤ cutoff` → `< cutoff` mutation.
17. **(verify 3) `Session.resumable` not replayed, `Run.stamp` ignores `error`, PostgreSQL replays**: carried into D1. The resumable rule meets suspicious point 2 in `L-run-compose`, the `error` column meets `L-lifecycle-run`, and the PostgreSQL store meets the D1 red team.
