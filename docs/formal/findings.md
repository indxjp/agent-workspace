# Formal programme — findings ledger

Disagreements the formalisation exposed: between two documents, or between a document and the
code. The code is today's truth, and a document that disagrees with it is a finding (charter §8).
Each entry names the exact sentence and code location, the Lean statements and a proposed
resolution. Security findings that hold against today's code are reported privately to the Owner
and appear here only once resolved.

Severity: **security**, **correctness**, **documentation**, **naming**.

| Id | Severity | Summary | Status |
| --- | --- | --- | --- |
| F-001 | documentation | A `queued` run can reach a terminal status directly | corrected in D1 |
| F-002 | correctness | projects_default_agent_workspace_fk and sessions_project_workspace_fk are composite ON DELETE SET NULL keys that include the NOT NULL workspace_id (P1-foundation) | open |
| F-003 | documentation | docs/sdk/07-structure-map.md §3 says 'created_at and updated_at are present on every table' (P1-foundation) | open |
| F-004 | documentation | docs/sdk/07-structure-map.md §3 says 'every cross-table foreign key is composite on (id, workspace_id)' (P1-foundation) | open |
| F-005 | documentation | Code comments disagree with the schema (P1-foundation) | open |
| F-006 | naming | workspace_principals.kind stores api_key, which fails oneOf's SAFE_VALUE, so its CHECK is hand-written while the wire uses api-key (P1-foundation) | open |
| F-007 | documentation | The model's tenancy rule differs from tenancy.test.ts rule 1, and the docstring now says so instead of claiming equivalence (P1-foundation) | open |
| F-008 | correctness | Spec §20.6.1 says a workspace share is readable by 'any member of the workspace with a role that allows viewing' (P1-publication) | open |
| F-009 | documentation | 04 §2 says shares carry ownerPrincipalId (P1-publication) | open |
| F-010 | correctness | A subjectId of a single space passes PublishShareRequestSchema (min(1)) but fails shares_subject_id_not_blank (P1-publication) | open |
| F-011 | documentation | The spec §27 column list for shares omits six of today's columns (P1-publication) | open |
| F-012 | correctness | The database admits an agent share with no mode, and a budget on a share that is not runnable (P1-publication) | open |
| F-013 | correctness | shares.subject_id is polymorphic text with no foreign key, and the service does not always resolve it (P1-publication) | open |
| F-014 | naming | Every publish is audited as session-published, whatever the subject type (P1-publication) | open |
| F-015 | naming | share_views counts page opens and admitted runnable messages together (P1-publication) | open |
| F-016 | documentation | The contract says `stopped` means the budget ran out (P1-publication) | open |
| F-017 | documentation | Setting setPublicSharingEnabled(false) suspends every unrevoked share, whatever its visibility, and turning it back on clears every suspension (P1-publication) | open |
| F-018 | documentation | 'A share is a copy of what it published' does not hold for project and skill shares, which store whatever snapshot the client sends (RF-103) (P1-publication) | open |
| F-019 | security | withheld pending Owner review | withheld |
| F-020 | correctness | 04 §5.4: 'driverConfig.image must be a sha256-pinned reference on create.' parseCreateRuntimeProfileInput enforces it for every driver including local… (P1-configuration) | open |
| F-021 | naming | Blank names disagree: model-connection and runtime-connection names are refused when blank after JS trim (U+3000 refused), the runtime-profile contrac… (P1-configuration) | open |
| F-022 | documentation | Roadmap S-19 ('PATCH accepts null for the nullable sizing fields and runtimeConnectionId') does not say whether allowedDomains, persistPaths and drive… (P1-configuration) | open |
| F-023 | correctness | Contract accepts fractional cpu (0.5) but runtime_profiles.cpu is a PostgreSQL integer (P1-configuration) | open |
| F-024 | correctness | 04 §5.4 'positive safe integers with no ceiling' for memoryMb/diskMb/timeouts, but the columns are 32-bit integer (P1-configuration) | open |
| F-025 | correctness | runtime_profiles.runtime_connection_id references any secrets row (P1-configuration) | open |
| F-026 | correctness | decodeDriver does not check the catalogue (P1-configuration) | open |
| F-027 | naming | Reserved names (MODEL_CONNECTION_*, RUNTIME_CONNECTION__*) are ordinary secret names (P1-configuration) | open |
| F-028 | documentation | Runtime-connection label encoding is not injective ('primary host' and 'PRIMARY_HOST' collide) (P1-configuration) | open |
| F-029 | correctness | §5.3 'Model choice .. (P1-configuration) | open |
| F-030 | naming | Model-connection credential has no foreign key (P1-configuration) | open |
| F-031 | correctness | Runtime-profile contract accepts a space-only name that runtime_profiles_name_not_blank refuses (unclassified 23514) (P1-configuration) | open |
| F-032 | naming | inventory §4 lists which resources carry no workspaceId (P1-configuration) | open |
| F-033 | correctness | References into secrets disagree on delete (connector RESTRICT vs profile SET NULL) (P1-configuration) | open |
| F-034 | naming | parseCreateRuntimeConnectionInput is an open parser (ignores unknown keys) while every other configuration parser is closed (P1-configuration) | open |
| F-035 | documentation | encodeSegment upper-cases with Unicode-aware toUpperCase (straße -> STRASSE, ıd -> ID), contrary to its comment (P1-configuration) | open |
| F-036 | documentation | WORKSPACE_SLUG_MAX_LENGTH = 64 (and the handler's bound) exceeds what workspaces_slug_format admits (63) (P1-identity) | open |
| F-037 | correctness | MeResponseSchema comment says 'userId is null for exactly an API-key principal' but the Zod object accepts mismatched kind/userId (P1-identity) | open |
| F-038 | correctness | RF-101 'one human principal per Membership and one machine principal per APIKey' (P1-identity) | open |
| F-039 | naming | 'Principal' names both the durable workspace_principals row and the per-request authenticated object (RF-101's ActorContext) (P1-identity) | open |
| F-040 | correctness | Principal.fromDirectoryRecord copies userId/apiKeyId unchecked against kind (P1-identity) | open |
| F-041 | documentation | Er/Core.lean principalSourceXor docstring is wrong at NULL kind (SQL gives FALSE for a row with no kind and no source) (P1-identity) | open |
| F-042 | documentation | Not-blank checks (length(btrim(x)) > 0) strip only spaces (P1-identity) | open |
| F-043 | naming | invitations.invited_by is a users.id, the pre-RF-101 attribution vocabulary (P1-identity) | open |
| F-044 | correctness | Session identity is keyed by email (SessionClaims.sub) and resolveMembership(email, slug), contradicting user-identities.ts's statement that (issuer, … (P1-identity) | open |
| F-045 | naming | Session claims carry an always-'owner' role that is ignored (P1-identity) | open |
| F-046 | correctness | DirectoryRoot.resolveRole does not check principal revocation, unlike resolveMembership/principalById (P1-identity) | open |
| F-047 | correctness | principalById re-checks key expiry against Date.now() while authenticateApiKeyHash uses the caller's now (P1-identity) | open |
| F-048 | correctness | POST /api/connectors admits a whitespace-only name (parseCreateConnectorBody /^.{1,200}$/u) that mcp_servers_name_not_blank then refuses, so the DB, n… (P1-catalog) | open |
| F-049 | correctness | AgentResourceRepository.replace reports a repeated file id as unknown-file (naming an existing file) but silently merges repeated skill and connector ids (P1-catalog) | open |
| F-050 | documentation | 04 §2 says every own/other row carries ownerPrincipalId (P1-catalog) | open |
| F-051 | documentation | ownership-and-sharing draws the grant edge to 'a person or API key', but a grant can only name an active membership principal (P1-catalog) | open |
| F-052 | documentation | ownership-and-sharing 'What you can and cannot do today' says per-agent Viewer grants have no SDK method, contradicting its own verb table and 04 §5.9… (P1-catalog) | open |
| F-053 | naming | agent_grants stores user_id and the run check reads by user, while docs say authorisation compares principals (P1-catalog) | open |
| F-054 | documentation | 04 §5.7 marks SkillSummary.id optional (P1-catalog) | open |
| F-055 | naming | 'Grant' names two relations (P1-catalog) | open |
| F-056 | naming | One concept, three names (P1-catalog) | open |
| F-057 | documentation | ownership-and-sharing says putting a file or skill in the catalog makes you its owner_principal_id (P1-catalog) | open |
| F-058 | correctness | files.ts says storage_key may diverge from path, but renameFilesByPrefix cuts the key by the old prefix length whatever it holds, so a diverged key na… (P1-catalog) | open |
| F-059 | documentation | 04 §5.9 does not say what PUT /api/agents/:id/resources answers (P1-catalog) | open |
| F-060 | documentation | F-1: docs/sdk/04-api-specification.md §2 says every own/other row including runs carries ownerPrincipalId; runs has no owner_principal_id and RunResou… (P1-work) | corrected in D1 |
| F-061 | naming | F-2: three names for one identifier. sessions.claude_session_id is free text, but recordReportedSessionIdentity refuses any id other than sessions.id;… (P1-work) | open |
| F-062 | correctness | F-3: session_transcripts.project_key is 'the caller's workspace id by construction' (packages/contracts/src/sessions.ts), enforced by the repository o… (P1-work) | open |
| F-063 | correctness | F-4: run_usage_records.provider is free text while runs.provider is the closed MODEL_PROVIDERS set; the ledger rule 'an unpriced response is recorded … (P1-work) | open |
| F-064 | documentation | F-5: audit_events_actor_principal_workspace_fk is NO ACTION in the catalogue and the 0022 snapshot, but migration 0020 deploys ON DELETE SET NULL (act… (P1-work) | open |
| F-065 | naming | F-6: 'session' means both the sessions resource and the browser sign-in session (auth.kind 'session', SessionPrincipal, workspaces-and-principals.mdx … (P1-work) | corrected in D1 |
| F-066 | documentation | F-7: length(btrim(x)) > 0 checks (projects_name_not_blank, audit label checks) strip spaces only, so tab/newline-only names pass the database while th… (P1-work) | open |
| F-067 | correctness | F-8: RunCostSchema.amount is documented as 'A decimal string, never a float' but is z.string().min(1); the only decimal guard is an inline regex in th… (P1-work) | open |
| F-068 | correctness | Grants are keyed by user id although 'Authorisation always compares principals, never user ids' (docs/sdk/site/concepts/workspaces-and-principals.mdx) (P1-synthesis) | open |
| F-069 | correctness | RF-101 'one principal per Membership and per APIKey' is not enforced by the schema (workspace-principals.ts) (P1-synthesis) | open |
| F-070 | naming | Connector / MCP server / mcpServerIds name one concept (mcp-servers.ts) (P1-synthesis) | open |
| F-071 | documentation | 04 §2 says shares carry ownerPrincipalId (P1-synthesis) | open |
| F-072 | correctness | shares.subject_id is the only unpaired reference between tenant-carrying rows (P1-synthesis) | open |
| F-073 | correctness | Two composite ON DELETE SET NULL keys (projects default agent, sessions project) cannot execute (P1-synthesis) | open |
| F-074 | naming | Principal kind stored 'api_key' but 'api-key' on the wire (P1-synthesis) | open |
| F-075 | correctness | A secret's purpose is only a naming convention (P1-synthesis) | open |
| F-076 | correctness | Six documented row invariants are not database checks (agent model pair, SDK session id = session id per recordReportedSessionIdentity / work F-2, tra… (P1-synthesis) | open |
| F-077 | correctness | Session identity is keyed by email and the token carries a constant role claim (P1-synthesis) | open |
| F-078 | documentation | docs/sdk/07-structure-map.md §3 draws users \|\|--o{ invitations (exactly one inviter) though invited_by is nullable SET NULL, and workspaces }o--o\| mod… (P1-synthesis) | open |
| F-079 | naming | 'owner' is both a role value and the owning principal (P1-synthesis) | open |
| F-080 | documentation | The architecture describes both Drizzle cycle edges as composite foreign keys | corrected in D1 |
| F-081 | naming | Two theorem citations name a local variable instead of the tenancy test's constant | corrected in D1 |
| F-082 | documentation | No product document explains when run timestamps are set | corrected in D1 |
| F-083 | documentation | UUID v4 prose disagrees with the accepting schema | corrected in D1 |
| F-084 | correctness | Strict response envelopes conflict with the additive-response versioning promise | error bodies fixed; success schemas awaiting triage |
| F-085 | documentation | Problem-code prose overstates the validation rule | corrected in D1 |
| F-086 | naming | Three Phase-1 string predicate copies remain | open |
| F-087 | documentation | The role table disagrees with the five reachable Admin and audit cells | corrected in D1 |
| F-088 | correctness | A granted Builder can be denied an agent run allowed to a granted Viewer | awaiting triage |
| F-089 | correctness | Admin token revocation differs between `decide()` and its handler | corrected in D1 |
| F-090 | documentation | An earlier ADR's Admin run verbs lack an amendment note | corrected in D1 |
| F-091 | correctness | Run-scope UUID comparison is case sensitive | fixed in PR #292 |
| F-092 | documentation | Run-scope prose lists fewer shapes than its authorisation grammar | corrected in D1 |
| F-093 | documentation | `sessions/messages` is classified without a declared route | corrected in D1 |
| F-094 | documentation | Builder run grants on three resources are unreachable | corrected in D1 |
| F-095 | documentation | Malformed workspace ids answer 404 under the concealment rule | corrected in D1 |
| F-096 | correctness | Racing termination can log two terminal run statuses | fixed in PR #290 |
| F-097 | correctness | Ordinary finish leaves browser-token rows active | awaiting policy decision |
| F-098 | correctness | Preparation failure records a running transition | awaiting policy decision |
| F-099 | documentation | Accounting failure can be superseded by later settlement | corrected in D1 |
| F-100 | correctness | Repository event follow can lose the terminal tail | fixed in PR #282 |
| F-101 | correctness | SDK frame splitting differs on a lone carriage return | fixed in PR #284 |
| F-102 | correctness | A terminal run makes its browser token unusable for a final read | awaiting policy decision |
| F-103 | correctness | Archived sessions can be reused for a new run | fixed in PR #286 |
| F-104 | correctness | Server start parser accepts an empty model rejected by the contract | fixed in PR #285 |
| F-105 | correctness | Proxy rejects valid browser-token bearer scheme casing | fixed in PR #283 |
| F-106 | documentation | RuntimeProfile.lean does not model the driverConfig credential-key refusal (ADR-0088 D2) | open |
| F-107 | documentation | The run-start model has no `422` configuration-refusal branch | open (follow-up) |
| F-108 | documentation | §9's route block gained the tool route, which the gateway-ingress model does not yet model | open (follow-up) |
| F-109 | documentation | A ceiling refusal is audited as `agent-changed`, and the run-start ceiling branch is not modelled | open (follow-up) |

## F-001 — A `queued` run can reach a terminal status directly

- **Document.** `docs/sdk/site/concepts/run-lifecycle.mdx`, "From `start` to a terminal status" and
  "Open questions": *"neither states whether a `queued` run can reach a terminal status without ever
  being `running` … This diagram draws only the transition the code and prose describe"*. The
  diagram draws `queued → running → {completed, failed, cancelled}` only.
- **Code.** `packages/core/src/db/repositories/runs.ts` `finish` moves any non-terminal run
  (`notInArray(runs.status, terminal)`), including a queued one, and stamps `startedAt` if it is
  missing. `InMemoryRunStore.finish` does the same. Interrupt (ADR SDK-03-RUN-235) writes
  `cancelled` on any live run.
- **Lean.** `AgentWorkspace.Theorems.Normative.queued_run_may_finish_directly`:
  `∀ t, t.isTerminal → RunTransition .queued t`.
- **Resolution.** Documentation. Add the three `queued → terminal` edges to the diagram and close
  that open question. The code is right: a cancel before the runtime claims the run must be
  possible. Done in `docs/sdk/site/concepts/run-lifecycle.mdx` on D1.

## F-002 — projects_default_agent_workspace_fk and sessions_project_workspace_fk are composite ON DELETE SET NULL keys that include the NOT NULL workspace_id

- **Raised by.** P1-foundation ([unit report](units/er-core.md)). Severity: correctness.
- **Finding.** projects_default_agent_workspace_fk and sessions_project_workspace_fk are composite ON DELETE SET NULL keys that include the NOT NULL workspace_id. Deleting a project's default agent, or a project that has sessions, therefore fails with 23502 instead of clearing the reference. tenancy.test.ts's referenceIdentityOf comment names this hazard. Lean: Meta.ErCore.unexecutable_set_null_keys and project_default_agent_set_null_violates_not_null (now derived from the catalogue key and column).
- **Source.** packages/core/src/db/schema/projects.ts#projects_default_agent_workspace_fk; packages/core/src/db/schema/sessions.ts#sessions_project_workspace_fk; packages/core/src/db/repositories/agents.ts
- **Proposed resolution.** ADR or issue: use the sibling pattern (a single-column SET NULL plus a composite NO ACTION) or PostgreSQL 15+ ON DELETE SET NULL (default_agent_id), and add a regression test that deletes a default agent.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-003 — docs/sdk/07-structure-map.md §3 says 'created_at and updated_at are present on every table'

- **Raised by.** P1-foundation ([unit report](units/er-core.md)). Severity: documentation.
- **Finding.** docs/sdk/07-structure-map.md §3 says 'created_at and updated_at are present on every table'. project_files and project_mcp_servers have neither, and 12 more tables have no updated_at. Lean: Meta.ErCore.timestamps_are_not_on_every_table.
- **Source.** docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces
- **Proposed resolution.** Docs fix.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-004 — docs/sdk/07-structure-map.md §3 says 'every cross-table foreign key is composite on (id, workspace_id)'

- **Raised by.** P1-foundation ([unit report](units/er-core.md)). Severity: documentation.
- **Finding.** docs/sdk/07-structure-map.md §3 says 'every cross-table foreign key is composite on (id, workspace_id)'. The 7 references to users and the 6 SET NULL siblings are single-column. Lean: Meta.ErCore.single_column_references_are_global_or_siblings.
- **Source.** docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces
- **Proposed resolution.** Docs fix: say 'tenant-paired, by itself or by a sibling'.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-005 — Code comments disagree with the schema

- **Raised by.** P1-foundation ([unit report](units/er-core.md)). Severity: documentation.
- **Finding.** Code comments disagree with the schema. workspaces.ts and users.ts say there are 'exactly two' tables with no workspace_id, but there are three (user_identities too). columns.ts says 'Every table's primary key is a database-generated UUID', but six tables are keyed otherwise. Lean: Meta.ErCore.three_tables_carry_no_workspace_id and Meta.ErCore.primary_keys_other_than_id (moved from T1 to T5 this round).
- **Source.** packages/core/src/db/schema/workspaces.ts; packages/core/src/db/schema/users.ts; packages/core/src/db/schema/columns.ts#primaryKeyId
- **Proposed resolution.** Comment fixes in a docs PR.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-006 — workspace_principals.kind stores api_key, which fails oneOf's SAFE_VALUE, so its CHECK is hand-written while the wire uses api-key

- **Raised by.** P1-foundation ([unit report](units/er-core.md)). Severity: naming.
- **Finding.** workspace_principals.kind stores api_key, which fails oneOf's SAFE_VALUE, so its CHECK is hand-written while the wire uses api-key. Lean: Meta.ErCore.only_principal_kind_escapes_the_value_gate.
- **Source.** packages/core/src/db/schema/workspace-principals.ts#workspace_principals_kind_valid
- **Proposed resolution.** Record only; leave the rename to the Target ER.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-007 — The model's tenancy rule differs from tenancy.test.ts rule 1, and the docstring now says so instead of claiming equivalence

- **Raised by.** P1-foundation ([unit report](units/er-core.md)). Severity: documentation.
- **Finding.** `tenancyWellFormed` is stricter than the repository test on the scoped column's UUID type and the root primary key, but weaker on the leading tenant index. The predicates differ off the catalogue; both hold on all 33 current tables. Lean: `tenancy_rules_agree_on_the_catalogue`, `tenancy_rules_differ_off_the_catalogue`.
- **Source.** `formal/AgentWorkspace/Er/Core.lean#tenancyWellFormed`; `formal/AgentWorkspace/Authz/Tenancy.lean#testRule1`; `packages/core/src/db/schema/tenancy.test.ts#TENANT_COLUMN`.
- **Resolution.** The model now represents the leading tenant index, replays it against Drizzle and documents the distinction from the repository test.
- **Outcome.** Closed as documentation in D1.

## F-008 — Spec §20.6.1 says a workspace share is readable by 'any member of the workspace with a role that allows viewing'

- **Raised by.** P1-publication ([unit report](units/concept-publication.md)). Severity: correctness.
- **Finding.** Spec §20.6.1 says a workspace share is readable by 'any member of the workspace with a role that allows viewing'. Today only its publisher and Owners/Admins can read one: GET /api/shares filters on role and publisher, and /p/<token> opens public shares only, so private and workspace shares behave the same. The Lean filter listedFor is now replayed against the real GET handler.
- **Source.** docs/spec.md#2061-three-visibilities-for-every-shareable-object vs apps/web/app/api/shares/route.ts#GET; Lean listedFor, Meta.a_member_cannot_read_another's_workspace_share, Meta.private_and_workspace_shares_list_alike
- **Proposed resolution.** Issue: add a read path for workspace members, or an ADR plus docs fix stating that `workspace` behaves as `private` today.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-009 — 04 §2 says shares carry ownerPrincipalId

- **Raised by.** P1-publication ([unit report](units/concept-publication.md)). Severity: documentation.
- **Finding.** 04 §2 says shares carry ownerPrincipalId. The shares table has publisher_principal_id instead, and ShareResource carries neither column.
- **Source.** docs/sdk/04-api-specification.md#2-resource-model; Meta.shares_carry_a_publisher_not_an_owner
- **Proposed resolution.** Docs fix now. ADR for the Target: rename the column to owner_principal_id, or expose publisherPrincipalId on the wire.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-010 — A subjectId of a single space passes PublishShareRequestSchema (min(1)) but fails shares_subject_id_not_blank

- **Raised by.** P1-publication ([unit report](units/concept-publication.md)). Severity: correctness.
- **Finding.** A subjectId of a single space passes PublishShareRequestSchema (min(1)) but fails shares_subject_id_not_blank. The request therefore passes validation and returns 500, not 400.
- **Source.** apps/web/server/shares/core/input.ts#PublishShareRequestSchema vs shares_subject_id_not_blank; Meta.a_space_subject_id_passes_validation_but_not_the_database
- **Proposed resolution.** Issue: refine subjectId in the request schema and the contract with the same predicate the database check uses.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-011 — The spec §27 column list for shares omits six of today's columns

- **Raised by.** P1-publication ([unit report](units/concept-publication.md)). Severity: documentation.
- **Finding.** The spec §27 column list for shares omits six of today's columns.
- **Source.** docs/spec.md#27-minimal-database-model; Meta.specification_column_list_is_a_strict_subset
- **Proposed resolution.** Docs fix.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-012 — The database admits an agent share with no mode, and a budget on a share that is not runnable

- **Raised by.** P1-publication ([unit report](units/concept-publication.md)). Severity: correctness.
- **Finding.** The database admits an agent share with no mode, and a budget on a share that is not runnable. Only the service maintains §27's 'agents only' and 'runnable links only'.
- **Source.** docs/spec.md#27-minimal-database-model; Target agentHasMode/budgetOnlyRunnable; Refinement.current_admits_an_agent_share_without_mode, current_admits_a_budget_on_a_definition_share
- **Proposed resolution.** ADR plus migration adding two CHECK constraints.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-013 — shares.subject_id is polymorphic text with no foreign key, and the service does not always resolve it

- **Raised by.** P1-publication ([unit report](units/concept-publication.md)). Severity: correctness.
- **Finding.** shares.subject_id is polymorphic text with no foreign key, and the service does not always resolve it. A share can name a missing subject, a subject of the wrong type, or a subject of another workspace. The last case is now pinned by current_admits_a_cross_workspace_subject.
- **Source.** apps/web/server/composition/register.ts#subjectOwnership; Target subjectResolves; Refinement.current_admits_a_dangling_subject, current_admits_a_subject_of_the_wrong_type, current_admits_a_cross_workspace_subject
- **Proposed resolution.** Issue (with RF-103): resolve the subject on the server in publish. ADR: tenant-paired foreign keys for each subject type.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-014 — Every publish is audited as session-published, whatever the subject type

- **Raised by.** P1-publication ([unit report](units/concept-publication.md)). Severity: naming.
- **Finding.** Every publish is audited as session-published, whatever the subject type.
- **Source.** apps/web/server/shares/core/service.ts#ShareService vs docs/spec.md §20.6.2 rule 6
- **Proposed resolution.** ADR: rename the action to share-published, or add the subject type to the audit label.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-015 — share_views counts page opens and admitted runnable messages together

- **Raised by.** P1-publication ([unit report](units/concept-publication.md)). Severity: naming.
- **Finding.** share_views counts page opens and admitted runnable messages together.
- **Source.** packages/core/src/db/schema/share-views.ts; ShareView docstring
- **Proposed resolution.** ADR: add a kind column or a separate table; add a docs note on viewCount meanwhile.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-016 — The contract says `stopped` means the budget ran out

- **Raised by.** P1-publication ([unit report](units/concept-publication.md)). Severity: documentation.
- **Finding.** The contract says `stopped` means the budget ran out. The manual kill switch also sets it, and resolve then refuses the page altogether.
- **Source.** packages/contracts/src/shares.ts; Normative.stopped_link_does_not_open
- **Proposed resolution.** Docs fix to the contract comment.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-017 — Setting setPublicSharingEnabled(false) suspends every unrevoked share, whatever its visibility, and turning it back on clears every suspension

- **Raised by.** P1-publication ([unit report](units/concept-publication.md)). Severity: documentation.
- **Finding.** Setting setPublicSharingEnabled(false) suspends every unrevoked share, whatever its visibility, and turning it back on clears every suspension.
- **Source.** docs/spec.md#2064-administration
- **Proposed resolution.** Docs fix; Phase 4 models the transition.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-018 — 'A share is a copy of what it published' does not hold for project and skill shares, which store whatever snapshot the client sends (RF-103)

- **Raised by.** P1-publication ([unit report](units/concept-publication.md)). Severity: documentation.
- **Finding.** 'A share is a copy of what it published' does not hold for project and skill shares, which store whatever snapshot the client sends (RF-103).
- **Source.** docs/sdk/site/concepts/ownership-and-sharing.mdx#beyond-one-workspace
- **Proposed resolution.** Docs note until RF-103 lands.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-019 — security — withheld pending Owner review

Raised by P1-publication. Details are in the private ledger, outside the repository.

## F-020 — 04 §5.4: 'driverConfig.image must be a sha256-pinned reference on create.' parseCreateRuntimeProfileInput enforces it for every driver including local…

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: correctness.
- **Finding.** 04 §5.4: 'driverConfig.image must be a sha256-pinned reference on create.' parseCreateRuntimeProfileInput enforces it for every driver including local although its error says 'non-local runtime profiles must pin an image by sha256 digest', and parseUpdateRuntimeProfilePatch applies no pin rule, so a later PATCH can replace a pinned image with a tag. Latent today: no driver reads driverConfig.image (drivers take the image from host options with their own requireDigest). Lean: Meta.image_rule_ignores_the_driver, RuntimeProfile.createImageAccepted/isSha256Pinned, per-driver cells <driver>_profile_create_requires_a_pinned_image.
- **Source.** docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes; apps/web/server/runtimes/contract.ts#parseCreateRuntimeProfileInput, #parseUpdateRuntimeProfilePatch
- **Proposed resolution.** Issue: apply the same pin rule on PATCH and say 'on create and update' in §5.4 before any driver consumes driverConfig.image; fix the error text (drop 'non-local') or exempt local if intended.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-021 — Blank names disagree: model-connection and runtime-connection names are refused when blank after JS trim (U+3000 refused), the runtime-profile contrac…

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: naming.
- **Finding.** Blank names disagree: model-connection and runtime-connection names are refused when blank after JS trim (U+3000 refused), the runtime-profile contract accepts any non-empty name and its CHECK strips spaces only (U+3000 or a tab is a valid profile name); apiKey/credential of spaces accepted. Lean: Meta.blank_name_rules_disagree.
- **Source.** packages/run-protocol/src/schemas.ts#RuntimeProfile; apps/web/server/models/contract.ts#parseCreateModelConnection; apps/web/server/runtimes/connections.ts#parseCreateRuntimeConnectionInput
- **Proposed resolution.** ADR or 04 §4 rule: a configuration name is non-blank after JS trim, enforced by the contract and mirrored by a CHECK over the same set; credentials stay opaque non-empty strings.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-022 — Roadmap S-19 ('PATCH accepts null for the nullable sizing fields and runtimeConnectionId') does not say whether allowedDomains, persistPaths and drive…

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: documentation.
- **Finding.** Roadmap S-19 ('PATCH accepts null for the nullable sizing fields and runtimeConnectionId') does not say whether allowedDomains, persistPaths and driverConfig (also nullable on the resource) can be cleared. Lean: RuntimeProfile.s19ClearableFields, Refinement.s19_target_clears_sizing_but_not_required_fields.
- **Source.** docs/sdk/04-api-specification.md#8-server-changes-this-specification-requires
- **Proposed resolution.** Docs fix: name the clearable fields exactly in the S-19 row.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-023 — Contract accepts fractional cpu (0.5) but runtime_profiles.cpu is a PostgreSQL integer

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: correctness.
- **Finding.** Contract accepts fractional cpu (0.5) but runtime_profiles.cpu is a PostgreSQL integer. Lean: Meta.contract_cpu_fraction_is_not_storable.
- **Source.** packages/contracts/src/runtimes.ts#RUNTIME_PROFILE_BOUNDS; packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles
- **Proposed resolution.** Issue/ADR: numeric or millicores column, or whole cores only.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-024 — 04 §5.4 'positive safe integers with no ceiling' for memoryMb/diskMb/timeouts, but the columns are 32-bit integer

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: correctness.
- **Finding.** 04 §5.4 'positive safe integers with no ceiling' for memoryMb/diskMb/timeouts, but the columns are 32-bit integer; 2^31 passes and overflows. Lean: Meta.contract_size_bound_exceeds_the_integer_column.
- **Source.** docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes
- **Proposed resolution.** Cap at 2147483647 in contract and docs, or widen to bigint.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-025 — runtime_profiles.runtime_connection_id references any secrets row

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: correctness.
- **Finding.** runtime_profiles.runtime_connection_id references any secrets row; a profile can name a plain secret or a model-connection credential. Lean: Refinement.current_diverges_from_typed_runtime_connections.
- **Source.** packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles
- **Proposed resolution.** ADR RF-204: typed runtime_connections table or secret kind column with composite key.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-026 — decodeDriver does not check the catalogue

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: correctness.
- **Finding.** decodeDriver does not check the catalogue: RUNTIME_CONNECTION__FOO__X lists with driver 'foo', which RuntimeConnectionResourceSchema rejects. Lean: Meta.decoded_driver_may_be_outside_the_catalogue.
- **Source.** apps/web/server/runtimes/connections.ts#decodeDriver
- **Proposed resolution.** Filter list() by runtimeDriverIds or refuse reserved prefixes in parseSecretName.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-027 — Reserved names (MODEL_CONNECTION_*, RUNTIME_CONNECTION__*) are ordinary secret names

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: naming.
- **Finding.** Reserved names (MODEL_CONNECTION_*, RUNTIME_CONNECTION__*) are ordinary secret names; GET /api/secrets lists credentials and runtime connections (Owner-only). Lean: Meta.reserved_names_are_ordinary_secret_names.
- **Source.** docs/sdk/04-api-specification.md#55-secrets--awsecrets
- **Proposed resolution.** Resolved by the RF-204 ADR.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-028 — Runtime-connection label encoding is not injective ('primary host' and 'PRIMARY_HOST' collide)

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: documentation.
- **Finding.** Runtime-connection label encoding is not injective ('primary host' and 'PRIMARY_HOST' collide); undocumented in §5.4. Lean: Meta.connection_label_encoding_collides.
- **Source.** apps/web/server/runtimes/connections.ts#encodeSegment
- **Proposed resolution.** Docs fix in §5.4.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-029 — §5.3 'Model choice ..

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: correctness.
- **Finding.** §5.3 'Model choice ... is always the pair (modelConnectionId, model)' but agents/runs have no pair check and deleting a connection leaves agents.model set. Lean: Meta.agent_model_may_outlive_its_connection, Meta.set_null_alone_breaks_the_default_model_pair.
- **Source.** docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels; packages/core/src/db/schema/agents.ts#agents
- **Proposed resolution.** Issue: agents_model_pair check and clear agents.model with the defaults, or document the orphan.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-030 — Model-connection credential has no foreign key

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: naming.
- **Finding.** Model-connection credential has no foreign key; found by name MODEL_CONNECTION_<id>; stale schema header. Lean: Meta.model_connection_credential_has_no_foreign_key.
- **Source.** apps/web/server/models/store.ts#modelConnectionSecretName
- **Proposed resolution.** ADR RF-204 credential_secret_id composite key; fix header.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-031 — Runtime-profile contract accepts a space-only name that runtime_profiles_name_not_blank refuses (unclassified 23514)

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: correctness.
- **Finding.** Runtime-profile contract accepts a space-only name that runtime_profiles_name_not_blank refuses (unclassified 23514); model_connections has no name check. Lean: Meta.blank_profile_name_passes_the_contract_but_not_the_check, Meta.model_connection_name_has_no_database_check.
- **Source.** packages/run-protocol/src/schemas.ts#RuntimeProfile
- **Proposed resolution.** Trimmed non-blank refinement and a model_connections_name_not_blank migration.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-032 — inventory §4 lists which resources carry no workspaceId

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: naming.
- **Finding.** inventory §4 lists which resources carry no workspaceId; within this cluster only RuntimeProfileResource carries one. Lean: Meta.only_the_profile_resource_carries_workspace_id.
- **Source.** docs/formal/inventory.md#4-tenant-isolation-predicates
- **Proposed resolution.** Record for contracts phase.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-033 — References into secrets disagree on delete (connector RESTRICT vs profile SET NULL)

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: correctness.
- **Finding.** References into secrets disagree on delete (connector RESTRICT vs profile SET NULL). Lean: Meta.secret_references_disagree_on_delete.
- **Source.** packages/core/src/db/schema/mcp-servers.ts#mcpServers
- **Proposed resolution.** Decide in the S-10 ADR.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-034 — parseCreateRuntimeConnectionInput is an open parser (ignores unknown keys) while every other configuration parser is closed

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: naming.
- **Finding.** parseCreateRuntimeConnectionInput is an open parser (ignores unknown keys) while every other configuration parser is closed; 04 states no rule. Lean: Meta.runtime_connection_create_ignores_unknown_fields over RuntimeProfile.connectionCreateAccepts vs Secret.closedBodyAccepts.
- **Source.** apps/web/server/runtimes/connections.ts#parseCreateRuntimeConnectionInput
- **Proposed resolution.** Refuse unknown keys there and state the rule in 04 §4.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-035 — encodeSegment upper-cases with Unicode-aware toUpperCase (straße -> STRASSE, ıd -> ID), contrary to its comment

- **Raised by.** P1-configuration ([unit report](units/concept-configuration.md)). Severity: documentation.
- **Finding.** encodeSegment upper-cases with Unicode-aware toUpperCase (straße -> STRASSE, ıd -> ID), contrary to its comment. Lean: Meta.connection_encoding_model_is_ascii_only.
- **Source.** apps/web/server/runtimes/connections.ts#encodeSegment
- **Proposed resolution.** Docs fix or map non-[A-Za-z0-9] to _ before upper-casing.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-036 — WORKSPACE_SLUG_MAX_LENGTH = 64 (and the handler's bound) exceeds what workspaces_slug_format admits (63)

- **Raised by.** P1-identity ([unit report](units/concept-identity.md)). Severity: documentation.
- **Finding.** WORKSPACE_SLUG_MAX_LENGTH = 64 (and the handler's bound) exceeds what workspaces_slug_format admits (63): a 64-character slug passes the route bound and is refused by the database.
- **Source.** packages/contracts/src/workspaces.ts#WORKSPACE_SLUG_MAX_LENGTH vs packages/core/src/db/schema/workspaces.ts#workspaces_slug_format; Lean Meta.ConceptIdentity.slug_bound_is_off_by_one
- **Proposed resolution.** Issue: set constant and handler bound to 63, or document 'at most 63'.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-037 — MeResponseSchema comment says 'userId is null for exactly an API-key principal' but the Zod object accepts mismatched kind/userId

- **Raised by.** P1-identity ([unit report](units/concept-identity.md)). Severity: correctness.
- **Finding.** MeResponseSchema comment says 'userId is null for exactly an API-key principal' but the Zod object accepts mismatched kind/userId.
- **Source.** packages/contracts/src/team.ts#MeResponseSchema; Lean MeResponse.acceptedCurrent / acceptedTarget, Refinement.me_schema_target_refines_current
- **Proposed resolution.** Issue: discriminated union on kind.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-038 — RF-101 'one human principal per Membership and one machine principal per APIKey'

- **Raised by.** P1-identity ([unit report](units/concept-identity.md)). Severity: correctness.
- **Finding.** RF-101 'one human principal per Membership and one machine principal per APIKey': the schema enforces at most one principal per source but not at least one (unenforced invariant).
- **Source.** packages/core/src/db/schema/workspace-principals.ts; Lean Er.Current.Identity.consistent (Current) vs consistentTarget (Target); Refinement.principal_coverage_target_refines_current; Invariants.target_gives_each_membership_exactly_one_principal
- **Proposed resolution.** ADR draft: deferrable constraint trigger or invert the reference (source carries principal_id NOT NULL).
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-039 — 'Principal' names both the durable workspace_principals row and the per-request authenticated object (RF-101's ActorContext)

- **Raised by.** P1-identity ([unit report](units/concept-identity.md)). Severity: naming.
- **Finding.** 'Principal' names both the durable workspace_principals row and the per-request authenticated object (RF-101's ActorContext).
- **Source.** apps/web/server/rbac/principal.ts#Principal; docs/sdk/04-api-specification.md §1.1; Lean Concepts.Principal.Principal vs Actor
- **Proposed resolution.** Docs fix in concepts.md: WorkspacePrincipal vs authenticated principal; rename actor field to displayActor (issue).
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-040 — Principal.fromDirectoryRecord copies userId/apiKeyId unchecked against kind

- **Raised by.** P1-identity ([unit report](units/concept-identity.md)). Severity: correctness.
- **Finding.** Principal.fromDirectoryRecord copies userId/apiKeyId unchecked against kind; incoherent record yields an instance isPrincipal refuses (unreachable today).
- **Source.** apps/web/server/rbac/principal.ts#fromDirectoryRecord; Lean Meta.from_directory_record_accepts_an_incoherent_record
- **Proposed resolution.** Issue: discriminated record type.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-041 — Er/Core.lean principalSourceXor docstring is wrong at NULL kind (SQL gives FALSE for a row with no kind and no source)

- **Raised by.** P1-identity ([unit report](units/concept-identity.md)). Severity: documentation.
- **Finding.** Er/Core.lean principalSourceXor docstring is wrong at NULL kind (SQL gives FALSE for a row with no kind and no source); unreachable since kind is NOT NULL.
- **Source.** formal/AgentWorkspace/Er/Core.lean#principalSourceXor; Lean Meta.core_source_xor_differs_from_sql_at_null_kind
- **Proposed resolution.** Programme-internal: fix er-core docstring or use CheckExpr.xor in synthesis.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-042 — Not-blank checks (length(btrim(x)) > 0) strip only spaces

- **Raised by.** P1-identity ([unit report](units/concept-identity.md)). Severity: documentation.
- **Finding.** Not-blank checks (length(btrim(x)) > 0) strip only spaces; tab/newline-only names pass the database backstop.
- **Source.** packages/core/src/db/schema/*.ts *_not_blank; Lean Meta.blank_checks_admit_whitespace_other_than_spaces
- **Proposed resolution.** Reword schema comments or tighten check in a later migration (issue).
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-043 — invitations.invited_by is a users.id, the pre-RF-101 attribution vocabulary

- **Raised by.** P1-identity ([unit report](units/concept-identity.md)). Severity: naming.
- **Finding.** invitations.invited_by is a users.id, the pre-RF-101 attribution vocabulary.
- **Source.** packages/core/src/db/schema/invitations.ts#invitedBy; Lean Normative.invited_by_is_a_user_that_may_be_deleted
- **Proposed resolution.** Target ER: add invited_by_principal_id (tenant-paired).
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-044 — Session identity is keyed by email (SessionClaims.sub) and resolveMembership(email, slug), contradicting user-identities.ts's statement that (issuer, …

- **Raised by.** P1-identity ([unit report](units/concept-identity.md)). Severity: correctness.
- **Finding.** Session identity is keyed by email (SessionClaims.sub) and resolveMembership(email, slug), contradicting user-identities.ts's statement that (issuer, subject) is the stable key.
- **Source.** apps/web/server/auth/session.ts#SessionClaims; packages/core/src/db/repositories/root.ts#resolveMembership
- **Proposed resolution.** ADR draft: mint sub as users.id and resolve by user id.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-045 — Session claims carry an always-'owner' role that is ignored

- **Raised by.** P1-identity ([unit report](units/concept-identity.md)). Severity: naming.
- **Finding.** Session claims carry an always-'owner' role that is ignored: a permission-shaped field in an identity token.
- **Source.** apps/web/server/auth/session.ts#SessionClaims
- **Proposed resolution.** Issue: drop the claim at next token version.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-046 — DirectoryRoot.resolveRole does not check principal revocation, unlike resolveMembership/principalById

- **Raised by.** P1-identity ([unit report](units/concept-identity.md)). Severity: correctness.
- **Finding.** DirectoryRoot.resolveRole does not check principal revocation, unlike resolveMembership/principalById; only the RBAC test harness uses it.
- **Source.** packages/core/src/db/repositories/directory.ts#resolveRole; apps/web/server/rbac/testing.ts
- **Proposed resolution.** Issue: route harness through resolveMembership or remove resolveRole.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-047 — principalById re-checks key expiry against Date.now() while authenticateApiKeyHash uses the caller's now

- **Raised by.** P1-identity ([unit report](units/concept-identity.md)). Severity: correctness.
- **Finding.** principalById re-checks key expiry against Date.now() while authenticateApiKeyHash uses the caller's now; two instants per request, untestable with an injected clock.
- **Source.** packages/core/src/db/repositories/directory.ts#principalById; Lean principalResolves (Target: one instant)
- **Proposed resolution.** Issue: pass now through principalById.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-048 — POST /api/connectors admits a whitespace-only name (parseCreateConnectorBody /^.{1,200}$/u) that mcp_servers_name_not_blank then refuses, so the DB, n…

- **Raised by.** P1-catalog ([unit report](units/concept-catalog.md)). Severity: correctness.
- **Finding.** POST /api/connectors admits a whitespace-only name (parseCreateConnectorBody /^.{1,200}$/u) that mcp_servers_name_not_blank then refuses, so the DB, not the route, rejects it with an unmapped CHECK violation instead of 400 invalid_body.
- **Source.** docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors vs apps/web/server/connectors/contract.ts#parseCreateConnectorBody; Lean Meta.ConceptCatalog.blank_connector_name_passes_the_parser_but_not_the_check
- **Proposed resolution.** Issue: refuse names blank after btrim in the parser, add a regression test, state 'not blank' in 04 §5.8.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-049 — AgentResourceRepository.replace reports a repeated file id as unknown-file (naming an existing file) but silently merges repeated skill and connector ids

- **Raised by.** P1-catalog ([unit report](units/concept-catalog.md)). Severity: correctness.
- **Finding.** AgentResourceRepository.replace reports a repeated file id as unknown-file (naming an existing file) but silently merges repeated skill and connector ids.
- **Source.** packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider; Lean Concepts.Grant.replace, Meta.ConceptCatalog.repeated_ids_are_treated_differently_by_kind
- **Proposed resolution.** Issue: merge repeated file entries or refuse all three kinds with a distinct duplicate-* outcome; document in 04 §5.9.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-050 — 04 §2 says every own/other row carries ownerPrincipalId

- **Raised by.** P1-catalog ([unit report](units/concept-catalog.md)). Severity: documentation.
- **Finding.** 04 §2 says every own/other row carries ownerPrincipalId; FileResourceSchema and SkillDetailSchema carry neither owner nor creator.
- **Source.** docs/sdk/04-api-specification.md#2-resource-model; packages/contracts/src/{files,skills}.ts; Lean Meta.ConceptCatalog.file_and_skill_bodies_carry_no_owner
- **Proposed resolution.** Docs fix now; ADR draft/issue to add ownerPrincipalId to both bodies.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-051 — ownership-and-sharing draws the grant edge to 'a person or API key', but a grant can only name an active membership principal

- **Raised by.** P1-catalog ([unit report](units/concept-catalog.md)). Severity: documentation.
- **Finding.** ownership-and-sharing draws the grant edge to 'a person or API key', but a grant can only name an active membership principal.
- **Source.** docs/sdk/site/concepts/ownership-and-sharing.mdx#catalog-assignment-grant; Lean Meta.ConceptCatalog.an_api_key_principal_cannot_be_granted
- **Proposed resolution.** Docs fix: 'a person (membership principal)'.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-052 — ownership-and-sharing 'What you can and cannot do today' says per-agent Viewer grants have no SDK method, contradicting its own verb table and 04 §5.9…

- **Raised by.** P1-catalog ([unit report](units/concept-catalog.md)). Severity: documentation.
- **Finding.** ownership-and-sharing 'What you can and cannot do today' says per-agent Viewer grants have no SDK method, contradicting its own verb table and 04 §5.9 (aw.agents.getGrants/replaceGrants exist).
- **Source.** docs/sdk/site/concepts/ownership-and-sharing.mdx#what-you-can-and-cannot-do-today vs #catalog-assignment-grant
- **Proposed resolution.** Docs fix: name aw.agents.replaceGrants.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-053 — agent_grants stores user_id and the run check reads by user, while docs say authorisation compares principals

- **Raised by.** P1-catalog ([unit report](units/concept-catalog.md)). Severity: naming.
- **Finding.** agent_grants stores user_id and the run check reads by user, while docs say authorisation compares principals; a revoked membership principal's grant would vanish from listPrincipalIds but still satisfy hasGrant (latent today).
- **Source.** docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal; apps/web/server/agents/run-ownership.ts#resolveAgentRunOwnership; Lean Grant.{grantsRead,hasGrant,runOwnership}, Meta.revoked_principal_keeps_a_hidden_grant
- **Proposed resolution.** ADR draft: key agent_grants by membership principal and check by principal id, or document the exception.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-054 — 04 §5.7 marks SkillSummary.id optional

- **Raised by.** P1-catalog ([unit report](units/concept-catalog.md)). Severity: documentation.
- **Finding.** 04 §5.7 marks SkillSummary.id optional; the contract requires it.
- **Source.** docs/sdk/04-api-specification.md#57-skills--awskills; packages/contracts/src/skills.ts#SkillSummarySchema
- **Proposed resolution.** Docs fix: id required.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-055 — 'Grant' names two relations

- **Raised by.** P1-catalog ([unit report](units/concept-catalog.md)). Severity: naming.
- **Finding.** 'Grant' names two relations: agent_grants (person to agent, binary) and the data-plane page's 'read-only grant' (an agent_files assignment with access).
- **Source.** docs/sdk/site/concepts/data-plane.mdx#how-a-file-a-skill-and-a-secret-move-through-it; Lean Meta.grant_names_two_different_relations
- **Proposed resolution.** Glossary: 'assignment' for agent_files/agent_skills/agent_mcp_servers, 'grant' only for agent_grants; docs fix.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-056 — One concept, three names

- **Raised by.** P1-catalog ([unit report](units/concept-catalog.md)). Severity: naming.
- **Finding.** One concept, three names: connector (wire/SDK), MCP server (mcp_servers tables and columns), mcpServerIds (project wire) next to connectorIds (agent wire).
- **Source.** packages/core/src/db/schema/{mcp-servers,agent-mcp-servers,project-mcp-servers}.ts; Lean Normative.connector_is_an_mcp_servers_row
- **Proposed resolution.** Target ER: rename to connectors/agent_connectors/project_connectors and connectorIds in one migration + contract ADR.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-057 — ownership-and-sharing says putting a file or skill in the catalog makes you its owner_principal_id

- **Raised by.** P1-catalog ([unit report](units/concept-catalog.md)). Severity: documentation.
- **Finding.** ownership-and-sharing says putting a file or skill in the catalog makes you its owner_principal_id; putFile/putSkill upserts at an existing path/name keep the previous owner and creator.
- **Source.** docs/sdk/site/concepts/ownership-and-sharing.mdx#what-you-can-and-cannot-do-today vs packages/core/src/db/repositories/resource-catalogs.ts#CatalogFile/#CatalogSkill; Lean Meta.ConceptCatalog.uploading_over_an_existing_path_does_not_make_the_caller_owner
- **Proposed resolution.** Docs fix: 'you become the owner of a new file or skill; overwriting an existing path or name keeps its owner'.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-058 — files.ts says storage_key may diverge from path, but renameFilesByPrefix cuts the key by the old prefix length whatever it holds, so a diverged key na…

- **Raised by.** P1-catalog ([unit report](units/concept-catalog.md)). Severity: correctness.
- **Finding.** files.ts says storage_key may diverge from path, but renameFilesByPrefix cuts the key by the old prefix length whatever it holds, so a diverged key names no object after a subtree move.
- **Source.** packages/core/src/db/schema/files.ts header; resource-catalogs.ts renameFilesByPrefix; Lean File.renameByPrefix, Meta.rename_rewrites_a_diverged_key_blindly
- **Proposed resolution.** ADR draft: make storage_key = path an invariant, or leave the key alone on rename.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-059 — 04 §5.9 does not say what PUT /api/agents/:id/resources answers

- **Raised by.** P1-catalog ([unit report](units/concept-catalog.md)). Severity: documentation.
- **Finding.** 04 §5.9 does not say what PUT /api/agents/:id/resources answers; the repository answers the stored read-back (narrowed, skill/connector repeats merged, each list in ascending id order), not the request.
- **Source.** docs/sdk/04-api-specification.md#59-agents--awagents; packages/core/src/db/repositories/agent-resources.ts (return read(agentId)); Lean Grant.replace/readBack, Invariants.replace_answers_in_id_order
- **Proposed resolution.** Docs fix: 'the answer is the stored assignment set: narrowed, de-duplicated, each list ordered by id'.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-060 — F-1: docs/sdk/04-api-specification.md §2 says every own/other row including runs carries ownerPrincipalId; runs has no owner_principal_id and RunResou…

- **Raised by.** P1-work ([unit report](units/concept-work.md)). Severity: documentation.
- **Finding.** F-1: docs/sdk/04-api-specification.md §2 says every own/other row including runs carries ownerPrincipalId; runs has no owner_principal_id and RunResourceSchema has no ownerPrincipalId. A run is owned through its session. Lean: Meta.ConceptWork.runs_carry_no_owner_principal, Normative.ConceptWork.run_reaches_exactly_one_owner, run_join_agrees_with_the_row_reference.
- **Source.** docs/sdk/04-api-specification.md#2-resource-model vs packages/core/src/db/schema/runs.ts#runs
- **Proposed resolution.** Docs fix: drop runs from the list and add 'a run is owned through its session'; same clarification in ownership-and-sharing.mdx.
- **Outcome.** corrected in D1 in the API resource model and ownership concepts page.

## F-061 — F-2: three names for one identifier. sessions.claude_session_id is free text, but recordReportedSessionIdentity refuses any id other than sessions.id;…

- **Raised by.** P1-work ([unit report](units/concept-work.md)). Severity: naming.
- **Finding.** F-2: three names for one identifier. sessions.claude_session_id is free text, but recordReportedSessionIdentity refuses any id other than sessions.id; transcript routes are keyed :claudeSessionId while session_transcripts.session_id references sessions.id; 04 §5.11 calls it providerSessionId. Lean Current: Session.identityCurrent, Meta.ConceptWork.database_admits_a_foreign_sdk_session_id, sdk_session_key_is_redundant_under_the_identity.
- **Source.** apps/web/server/composition/session-launch.ts#recordReportedSessionIdentity, packages/core/src/db/schema/sessions.ts#claudeSessionId
- **Proposed resolution.** ADR draft: add CHECK (claude_session_id IS NULL OR claude_session_id = id::text), or replace the column with sdk_reported_at and drop the redundant unique index; rename the route segment to :sessionId.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-062 — F-3: session_transcripts.project_key is 'the caller's workspace id by construction' (packages/contracts/src/sessions.ts), enforced by the repository o…

- **Raised by.** P1-work ([unit report](units/concept-work.md)). Severity: correctness.
- **Finding.** F-3: session_transcripts.project_key is 'the caller's workspace id by construction' (packages/contracts/src/sessions.ts), enforced by the repository only; no database check ties it to workspace_id. Lean: Meta.ConceptWork.database_admits_a_transcript_under_another_key; Target Transcript.projectKeyIsWorkspace.
- **Source.** packages/core/src/db/schema/session-transcripts.ts#sessionTranscripts
- **Proposed resolution.** Issue: add CHECK (project_key = workspace_id::text) or drop the redundant column.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-063 — F-4: run_usage_records.provider is free text while runs.provider is the closed MODEL_PROVIDERS set; the ledger rule 'an unpriced response is recorded …

- **Raised by.** P1-work ([unit report](units/concept-work.md)). Severity: correctness.
- **Finding.** F-4: run_usage_records.provider is free text while runs.provider is the closed MODEL_PROVIDERS set; the ledger rule 'an unpriced response is recorded at cost_usd = 0' has no check. Lean: Meta.ConceptWork.usage_record_provider_is_open_text, ledger_admits_an_unpriced_charge.
- **Source.** packages/core/src/db/schema/run-usage-records.ts#runUsageRecords
- **Proposed resolution.** Issue: add oneOf provider check and CHECK (price_table_version IS NOT NULL OR cost_usd = 0), or document why the ledger is open.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-064 — F-5: audit_events_actor_principal_workspace_fk is NO ACTION in the catalogue and the 0022 snapshot, but migration 0020 deploys ON DELETE SET NULL (act…

- **Raised by.** P1-work ([unit report](units/concept-work.md)). Severity: documentation.
- **Finding.** F-5: audit_events_actor_principal_workspace_fk is NO ACTION in the catalogue and the 0022 snapshot, but migration 0020 deploys ON DELETE SET NULL (actor_principal_id). Lean: Meta.ConceptWork.audit_actor_key_is_recorded_as_no_action.
- **Source.** migrations/meta/0022_snapshot.json vs migrations/0020_sparkling_nova.sql
- **Proposed resolution.** er-core follow-up: record SET NULL (cols) in OnDelete; note in docs/sdk/07-structure-map.md §3.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-065 — F-6: 'session' means both the sessions resource and the browser sign-in session (auth.kind 'session', SessionPrincipal, workspaces-and-principals.mdx …

- **Raised by.** P1-work ([unit report](units/concept-work.md)). Severity: naming.
- **Finding.** F-6: 'session' means both the sessions resource and the browser sign-in session (auth.kind 'session', SessionPrincipal, workspaces-and-principals.mdx 'A session proves identity').
- **Source.** docs/sdk/site/concepts/workspaces-and-principals.mdx
- **Proposed resolution.** Docs fix: call the credential the 'browser session' / 'sign-in session' wherever it is not the sessions resource.
- **Outcome.** corrected in D1 in the architecture and workspaces-and-principals pages.

## F-066 — F-7: length(btrim(x)) > 0 checks (projects_name_not_blank, audit label checks) strip spaces only, so tab/newline-only names pass the database while th…

- **Raised by.** P1-work ([unit report](units/concept-work.md)). Severity: documentation.
- **Finding.** F-7: length(btrim(x)) > 0 checks (projects_name_not_blank, audit label checks) strip spaces only, so tab/newline-only names pass the database while the project routes refuse them. Lean: Meta.ConceptWork.blank_checks_trim_spaces_only.
- **Source.** packages/core/src/db/schema/projects.ts#projects_name_not_blank
- **Proposed resolution.** Issue (low): use name ~ '\S' or btrim with explicit whitespace set; until then document the route as the stricter gate.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-067 — F-8: RunCostSchema.amount is documented as 'A decimal string, never a float' but is z.string().min(1); the only decimal guard is an inline regex in th…

- **Raised by.** P1-work ([unit report](units/concept-work.md)). Severity: correctness.
- **Finding.** F-8: RunCostSchema.amount is documented as 'A decimal string, never a float' but is z.string().min(1); the only decimal guard is an inline regex in the PostgreSQL settlement path. Lean: Usage.isDecimal (now cited only to the numeric column), WellFormed.ConceptWork.decimal_text_edge_cases.
- **Source.** packages/contracts/src/runs.ts#RunCostSchema
- **Proposed resolution.** Issue (low): export a DECIMAL_AMOUNT_PATTERN from contracts and use it in RunCostSchema.amount and the settlement guard.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-068 — Grants are keyed by user id although 'Authorisation always compares principals, never user ids' (docs/sdk/site/concepts/workspaces-and-principals.mdx)

- **Raised by.** P1-synthesis ([unit report](units/er-synthesis.md)). Severity: correctness.
- **Finding.** Grants are keyed by user id although 'Authorisation always compares principals, never user ids' (docs/sdk/site/concepts/workspaces-and-principals.mdx); code packages/core/src/db/schema/agent-grants.ts. Lean: diverges_at_a_grant_without_principal / target_grant_names_one_principal_of_its_workspace.
- **Source.** docs/adr/FORMAL-P1-grants-name-principals.md
- **Proposed resolution.** ADR draft FORMAL-P1-grants-name-principals (proposed)
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-069 — RF-101 'one principal per Membership and per APIKey' is not enforced by the schema (workspace-principals.ts)

- **Raised by.** P1-synthesis ([unit report](units/er-synthesis.md)). Severity: correctness.
- **Finding.** RF-101 'one principal per Membership and per APIKey' is not enforced by the schema (workspace-principals.ts). Lean: diverges_at_a_source_without_principal.
- **Source.** docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md#rf-101
- **Proposed resolution.** ADR draft FORMAL-P1-every-source-has-a-principal (proposed)
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-070 — Connector / MCP server / mcpServerIds name one concept (mcp-servers.ts)

- **Raised by.** P1-synthesis ([unit report](units/er-synthesis.md)). Severity: naming.
- **Finding.** Connector / MCP server / mcpServerIds name one concept (mcp-servers.ts). Lean: table_names_diverge_exactly_at.
- **Source.** docs/sdk/04-api-specification.md#58
- **Proposed resolution.** ADR draft FORMAL-P1-connector-is-the-only-name (proposed)
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-071 — 04 §2 says shares carry ownerPrincipalId

- **Raised by.** P1-synthesis ([unit report](units/er-synthesis.md)). Severity: documentation.
- **Finding.** 04 §2 says shares carry ownerPrincipalId; shares.ts stores publisher_principal_id; invitations.invited_by has no principal. Lean: owner_columns_diverge_exactly_at.
- **Source.** docs/sdk/04-api-specification.md#2-resource-model
- **Proposed resolution.** ADR draft FORMAL-P1-one-owner-vocabulary (proposed)
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-072 — shares.subject_id is the only unpaired reference between tenant-carrying rows

- **Raised by.** P1-synthesis ([unit report](units/er-synthesis.md)). Severity: correctness.
- **Finding.** shares.subject_id is the only unpaired reference between tenant-carrying rows; missing, wrongly typed or cross-workspace subjects are consistent today. Lean: diverges_at_a_dangling_subject, diverges_at_a_cross_workspace_subject, diverges_at_a_wrongly_typed_subject; target: target_share_subject_stays_in_workspace, target_refuses_two_subjects. Publication finding 6; no data crosses a tenant today (client-authored label/snapshot).
- **Source.** packages/core/src/db/schema/shares.ts
- **Proposed resolution.** ADR draft FORMAL-P1-share-subject-is-a-typed-reference (proposed)
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-073 — Two composite ON DELETE SET NULL keys (projects default agent, sessions project) cannot execute

- **Raised by.** P1-synthesis ([unit report](units/er-synthesis.md)). Severity: correctness.
- **Finding.** Two composite ON DELETE SET NULL keys (projects default agent, sessions project) cannot execute; deleting a default agent fails. Lean: set_null_diverges_exactly_at, deleting_a_default_agent_diverges.
- **Source.** packages/core/src/db/schema/projects.ts
- **Proposed resolution.** ADR draft FORMAL-P1-set-null-keys-use-the-sibling-pattern (proposed)
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-074 — Principal kind stored 'api_key' but 'api-key' on the wire

- **Raised by.** P1-synthesis ([unit report](units/er-synthesis.md)). Severity: naming.
- **Finding.** Principal kind stored 'api_key' but 'api-key' on the wire; escapes the oneOf DDL value gate. Lean: value_gate_diverges_exactly_at.
- **Source.** packages/core/src/db/schema/workspace-principals.ts
- **Proposed resolution.** ADR draft FORMAL-P1-principal-kind-has-one-spelling (proposed)
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-075 — A secret's purpose is only a naming convention

- **Raised by.** P1-synthesis ([unit report](units/er-synthesis.md)). Severity: correctness.
- **Finding.** A secret's purpose is only a naming convention; a runtime profile can name a plain secret as its runtime connection. Lean: diverges_at_an_untyped_runtime_connection.
- **Source.** packages/core/src/db/schema/runtime-profiles.ts
- **Proposed resolution.** ADR draft FORMAL-P1-secret-purpose-is-typed (proposed)
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-076 — Six documented row invariants are not database checks (agent model pair, SDK session id = session id per recordReportedSessionIdentity / work F-2, tra…

- **Raised by.** P1-synthesis ([unit report](units/er-synthesis.md)). Severity: correctness.
- **Finding.** Six documented row invariants are not database checks (agent model pair, SDK session id = session id per recordReportedSessionIdentity / work F-2, transcript key, agent share mode, budget only runnable, ledger provider set). Lean: the diverges_at_* theorems; ledger_providers_are_the_run_providers ties the proposed set to MODEL_PROVIDERS.
- **Source.** docs/formal/units/concept-work.md#findings; apps/web/server/composition/session-launch.ts#recordReportedSessionIdentity
- **Proposed resolution.** ADR draft FORMAL-P1-documented-row-invariants-are-checks (proposed)
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-077 — Session identity is keyed by email and the token carries a constant role claim

- **Raised by.** P1-synthesis ([unit report](units/er-synthesis.md)). Severity: correctness.
- **Finding.** Session identity is keyed by email and the token carries a constant role claim; 'principal' and 'session' each name two things. Lean: current_identity_breaks_on_an_email_change, role_claim_carries_no_information; target_identity_survives_an_email_change, resolution_by_id_refines_resolution_by_email.
- **Source.** apps/web/server/auth/session.ts#SessionClaims; packages/core/src/db/repositories/root.ts#resolveMembership
- **Proposed resolution.** ADR draft FORMAL-P1-identity-permission-tenant-selection (proposed)
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-078 — docs/sdk/07-structure-map.md §3 draws users \|\|--o{ invitations (exactly one inviter) though invited_by is nullable SET NULL, and workspaces }o--o\| mod…

- **Raised by.** P1-synthesis ([unit report](units/er-synthesis.md)). Severity: documentation.
- **Finding.** docs/sdk/07-structure-map.md §3 draws users ||--o{ invitations (exactly one inviter) though invited_by is nullable SET NULL, and workspaces }o--o| model_connections though the paired key allows at most one workspace per connection.
- **Source.** docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces
- **Proposed resolution.** Docs fix: correct both edges or regenerate §3 from Target.cardinality as concepts.md does
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-079 — 'owner' is both a role value and the owning principal

- **Raised by.** P1-synthesis ([unit report](units/er-synthesis.md)). Severity: naming.
- **Finding.** 'owner' is both a role value and the owning principal; creator, publisher, minter, actor are further owner-like words. Lean: Meta.ErSynthesis.every_conflation_is_resolved.
- **Source.** docs/formal/concepts.md#conflations-today
- **Proposed resolution.** Docs fix done in concepts.md
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-080 — The Drizzle cycle has one composite foreign key

- **Raised by.** D1 Phase-1 debt review, er-core. Severity: documentation.
- **Finding.** `docs/architecture.md#dependency-rules` described tenant-scoped composite foreign keys in both directions. `workspaces.default_model_connection_id` pairs with the workspace id; `model_connections.workspace_id` references a workspace by one column.
- **Source.** `packages/core/src/db/schema/workspaces.ts#workspaces`; `packages/core/src/db/schema/model-connections.ts#modelConnections`.
- **Lean.** `AgentWorkspace.Theorems.WellFormed.ErCore`.
- **Outcome.** Corrected in `docs/architecture.md` on D1.

## F-081 — Two theorem citations named a local variable

- **Raised by.** D1 Phase-1 debt review, er-core. Severity: naming.
- **Finding.** Two theorem attributes cited `tenancy.test.ts#rootReferences`, which is local to one test case, rather than the stable `TENANT_COLUMN` constant.
- **Source.** `packages/core/src/db/schema/tenancy.test.ts#TENANT_COLUMN`.
- **Lean.** `Invariants.ErSynthesis.tenant_row_has_exactly_one_workspace`; `Normative.ConceptIdentity.identity_rows_belong_to_exactly_one_workspace`.
- **Outcome.** Both citations corrected on D1.

## F-082 — Run timestamp semantics lack a product document

- **Raised by.** D1 Phase-1 debt review, concept-work. Severity: documentation.
- **Finding.** The stores stamp `startedAt` when a queued run starts and `endedAt` when the first terminal status is set. A queued run that becomes terminal receives both stamps in that transition. No product document states this lifecycle rule.
- **Source.** `apps/web/server/runs/memory-store.ts#InMemoryRunStore`; `packages/core/src/db/repositories/runs.ts#RunRepository`.
- **Lean.** `Invariants.ConceptWork`.
- **Outcome.** The timestamp rules are now documented in `docs/sdk/site/concepts/run-lifecycle.mdx`.

## F-083 — UUID v4 prose disagrees with the accepting schema

- **Raised by.** D1 contracts foundation, CF-1 ([unit report](units/contracts-foundation.md)). Severity: documentation.
- **Finding.** SPEC §4 says UUID v4, while `UUID_PATTERN` accepts other versions, nil, non-RFC variants and upper case. Lean: `Refinement.ContractsFoundation.uuid_current_diverges_from_v4_target`.
- **Source.** `docs/sdk/04-api-specification.md#4-wire-format-and-versioning`; `packages/contracts/src/identifiers.ts#UUID_PATTERN`.
- **Resolution.** §4 now distinguishes server-minted UUID v4 IDs from the broader accepting parser. Outcome: documentation corrected in D1.

## F-084 — Strict envelopes conflict with additive response versioning

- **Raised by.** D1 contracts foundation, CF-2 ([unit report](units/contracts-foundation.md)). Severity: correctness.
- **Finding.** An added response field makes an older strict SDK parser discard the known problem code. Lean: `Meta.ContractsFoundation.additive_top_level_field_loses_the_code`, `additive_inner_field_loses_the_code`.
- **Source.** `docs/sdk/04-api-specification.md#4-wire-format-and-versioning`; `packages/contracts/src/problem.ts#ApiProblemSchema`; `packages/sdk/src/http.ts#readProblem`.
- **Resolution.** For error bodies, `readProblem` now drops the keys an envelope does not know before parsing it, so an added field keeps the code; the contracts schemas stay strict. Lean: `Contracts.Problem.normaliseLenient`, replayed as the `read` field of `problem-envelopes.json`. Outcome: error bodies fixed in the SDK; whether the `.strict()` success schemas follow, or the versioning promise is narrowed, awaits triage.

## F-085 — Problem-code prose overstates validation

- **Raised by.** D1 contracts foundation, CF-3 ([unit report](units/contracts-foundation.md)). Severity: documentation.
- **Finding.** The schema accepts any nonempty string as a problem code, including whitespace, while SPEC §4 calls it machine-readable. Lean: `WellFormed.ContractsFoundation.problem_code_min_one`.
- **Source.** `packages/contracts/src/problem.ts#ApiProblemSchema`; `docs/sdk/04-api-specification.md#4-wire-format-and-versioning`.
- **Resolution.** §4 now states the actual nonempty-string schema rule, including whitespace input. Outcome: documentation corrected in D1; a stricter public schema remains an Owner decision.

## F-086 — Three string predicate copies remain

- **Raised by.** D1 contracts foundation, CF-4 ([unit report](units/contracts-foundation.md)). Severity: naming.
- **Finding.** Phase-1 concept modules repeat the JavaScript string predicates now proved equal to `Prelude.Text`.
- **Source.** `formal/AgentWorkspace/Concepts/{Agent,Connector,ModelConnection}.lean`.
- **Resolution.** Delegate to the shared definitions during integration when imports allow it. Outcome: open.

## F-087 — The documented role table disagrees with reachable cells

- **Raised by.** D1 authorisation decision, AD-1 ([unit report](units/authz-decide.md)). Severity: documentation.
- **Finding.** SPEC §3.3 misstates Admin access to secrets and projects and audit access for Admin, Builder and Viewer; it omits `me` and `setup`. Lean: `Normative.AuthzDecide.documented_table_diverges_exactly_at`.
- **Source.** `docs/sdk/04-api-specification.md#33-role-resource-permission-table`; `apps/web/server/rbac/permissions.ts#POLICY`.
- **Resolution.** §3.3 and the concepts page now show the shipped Admin secrets/projects and audit cells plus `me` and `setup`. Outcome: documentation corrected in D1.

## F-088 — A granted Builder can be denied an agent run

- **Raised by.** D1 authorisation decision, AD-2 ([unit report](units/authz-decide.md)). Severity: correctness.
- **Finding.** A Builder's `own` run grant rejects `permitted` ownership, while a Viewer's `permitted` grant accepts it. Lean: `Adversarial.AuthzDecide.granted_builder_cannot_run_the_agent_a_granted_viewer_can`.
- **Source.** `apps/web/server/agents/run-ownership.ts#resolveAgentRunOwnership`; `apps/web/server/rbac/decide.ts#applyGrant`.
- **Resolution.** ADR-0152 (roles are monotonic) gives Builder `run: permitted` on agents and makes `permitted` admit `own` as well as granted agents, so a granted Builder runs what a granted Viewer runs and still not an ungranted, unowned agent. Lean: `Meta.AuthzDecide.granted_builder_runs_the_agent_a_granted_viewer_can`, `Meta.AuthzDecide.roles_are_monotonic`. Outcome: fixed.

## F-089 — Admin token revocation differs between decision and handler

- **Raised by.** D1 authorisation decision, AD-3 ([unit report](units/authz-decide.md)). Severity: correctness.
- **Finding.** `decide()` denied Admin on the revoke route while the handler allowed Admin. The repaired Lean model proves `Normative.AuthzDecide.revoke_capability_matches_roles` and `Meta.AuthzDecide.decide_and_the_revoke_gate_agree_for_every_role`.
- **Source.** `apps/web/server/runs/api.ts#revokeRunTokens`; `apps/web/server/rbac/permissions.ts#POLICY`.
- **Resolution.** [PR #294](https://github.com/indxjp/agent-workspace/pull/294) gave revocation a dedicated decision capability and routed the handler through it. Outcome: fixed; the role matrix and real route regressions failed before the repair.

## F-090 — Earlier Admin-run ADR lacks an amendment note

- **Raised by.** D1 authorisation decision, AD-4 ([unit report](units/authz-decide.md)). Severity: documentation.
- **Finding.** W9-AUTH-165 describes Admin runs as read-only; SDK-03-RUN-235 gives Admin the run verb that code implements. Lean: `Normative.AuthzDecide.admin_run_verbs_adrs_disagree_at_one_cell`.
- **Source.** `docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md`; `apps/web/server/rbac/permissions.ts#POLICY`.
- **Resolution.** W9-AUTH-165 now names SDK-03-RUN-235 as its amendment. Outcome: documentation corrected in D1.

## F-091 — Run-scope UUID comparison is case sensitive

- **Raised by.** D1 authorisation decision, AD-5 ([unit report](units/authz-decide.md)). Severity: correctness.
- **Finding.** The same UUID spelled with upper-case hex passed identifier validation but failed run-scope matching. The repaired Lean model proves `Meta.AuthzDecide.run_scope_id_accepts_equivalent_uuid_spelling`.
- **Source.** `apps/web/server/rbac/decide.ts#checkTokenScope`.
- **Resolution.** [PR #292](https://github.com/indxjp/agent-workspace/pull/292) compares validated UUIDs canonically while retaining exact comparison for other identifiers. The route-matrix regression failed before repair and passed afterward. Outcome: fixed and merged.

## F-092 — Run-scope prose lists fewer shapes than its grammar

- **Raised by.** D1 authorisation decision, AD-6 ([unit report](units/authz-decide.md)). Severity: documentation.
- **Finding.** SPEC §3.1.1 lists two run-scope routes, while the grammar permits GET and HEAD on additional run subresource shapes that later answer 405. Lean: `Adversarial.AuthzDecide.run_scope_passes_every_get_on_its_runs_shapes`.
- **Source.** `docs/sdk/04-api-specification.md#311-browser-token-scope-grammar`; `apps/web/server/rbac/decide.ts#TOKEN_SCOPE_GRAMMAR`.
- **Resolution.** §3.1.1 now distinguishes scope classification from shipped route handlers. Outcome: documentation corrected in D1.

## F-093 — Classified sessions/messages route is undeclared

- **Raised by.** D1 authorisation decision, AD-7 ([unit report](units/authz-decide.md)). Severity: documentation.
- **Finding.** The authorisation subresource table classifies `sessions/messages`, while no route declares the POST described by SPEC §34. Lean: `Meta.AuthzDecide.classified_sub_without_a_declared_route`.
- **Source.** `apps/web/server/rbac/permissions.ts#SPEC_34_SUB_RESOURCES`; `docs/sdk/04-api-specification.md#34-route-role-table`.
- **Resolution.** SPEC §34 now marks the route as unshipped and points to the current session continuation route. Outcome: documentation corrected in D1.

## F-094 — Builder run grants on three resources are unreachable

- **Raised by.** D1 authorisation decision, AD-8 ([unit report](units/authz-decide.md)). Severity: documentation.
- **Finding.** `OWN_WRITES` has a run grant for skills, files and connectors, although none has a run subresource. Lean: `Normative.AuthzDecide.role_table_builder_skills`.
- **Source.** `apps/web/server/rbac/permissions.ts#OWN_WRITES`.
- **Resolution.** The ownership concepts page now distinguishes those unused cells from callable run routes. Outcome: documentation corrected in D1.

## F-095 — Malformed workspace ids answer 404 despite the general malformed-input rule

- **Raised by.** D1 authorisation tenancy ([unit report](units/authz-tenancy.md)). Severity: documentation.
- **Finding.** Workspace ownership resolution answers `404 workspace_not_found` for a malformed workspace id before checking the caller, while the API specification's general convention says malformed input is 400. Lean: `malformed_workspace_id_is_not_found_for_every_caller`.
- **Source.** `apps/web/server/workspaces/access.ts#resolveMembershipView`; `docs/sdk/04-api-specification.md#4-conventions`.
- **Resolution.** §5.1 now states the deliberate `404 workspace_not_found` concealment exception. Outcome: documentation corrected in D1.

## F-096 — Racing termination can log two terminal run statuses

- **Raised by.** D1 lifecycle ([unit report](units/lifecycle-run.md)). Severity: correctness.
- **Finding.** Interrupt and launcher conclusion each appended a terminal event before the first-call-wins `finish`. Both appends could succeed while only one status was stored. The repaired Lean model proves `interrupt_conclude_race_agrees`.
- **Source.** `apps/web/server/composition/wiring/run-api.ts#interruptRun`; `apps/web/server/runs/launcher.ts#conclude`.
- **Resolution.** [PR #290](https://github.com/indxjp/agent-workspace/pull/290) commits the winning terminal state and event together under the existing per-run lock and transaction. The shared memory/PostgreSQL race regression failed before repair and passed afterward. Outcome: fixed and merged.

## F-097 — Ordinary finish leaves browser-token rows active

- **Raised by.** D1 lifecycle ([unit report](units/lifecycle-run.md)). Severity: correctness.
- **Finding.** Finishing a run revokes gateway run tokens but does not revoke its browser-token rows. A later resolution refuses the terminal run, so storage and effective access differ. Lean: `finish_leaves_browser_token_row`.
- **Source.** `packages/core/src/db/repositories/runs.ts#finish`; `apps/web/server/composition/wiring/run-api.ts#revokeAllRunTokensFor`.
- **Resolution.** Triage whether row revocation is required or effective access alone is the contract. Outcome: awaiting triage.

## F-098 — Preparation failure records a running transition

- **Raised by.** D1 lifecycle ([unit report](units/lifecycle-run.md)). Severity: documentation.
- **Finding.** The launcher stamps `startedAt` and appends `running` before preparation can fail, even when no runtime has been contacted. Lean: `preparation_failure_path`.
- **Source.** `apps/web/server/runs/launcher.ts`.
- **Resolution.** Triage whether `running` names preparation or runtime execution, then correct code or lifecycle prose. Outcome: awaiting triage.

## F-099 — Accounting failure can be superseded by later settlement

- **Raised by.** D1 lifecycle ([unit report](units/lifecycle-run.md)). Severity: documentation.
- **Finding.** A later usage record recomputes accounting and can move `failed` to a settled state; the lifecycle page does not explain that transition. Lean: `later_settlement_supersedes_failure`.
- **Source.** `packages/core/src/db/repositories/runs.ts#recordUsage`; `docs/sdk/site/concepts/run-lifecycle.mdx`.
- **Resolution.** The run lifecycle page now states that accounting failure can be superseded by later settlement. Outcome: documentation corrected in D1.

## F-100 — Repository event follow can lose the terminal tail

- **Raised by.** D1 event stream ([unit report](units/events-sse.md)). Severity: correctness.
- **Finding.** The repository stream could list events, then observe a terminal run and exit after a concurrent final append. The in-memory stream waits for the cursor to reach the final event. The original divergence was `repository_follow_can_lose_terminal_tail`; the repaired model proves `repository_follow_delivers_terminal_tail` and `repository_terminal_read_drains_tail`.
- **Source.** `apps/web/server/runs/repository-store.ts#openStream`.
- **Resolution.** [PR #282](https://github.com/indxjp/agent-workspace/pull/282) added a controlled PostgreSQL interleaving regression and a final durable drain after terminal status becomes visible. The regression failed before the change and passed after it; the full run-store suite passed 132/132. Outcome: fixed and merged.

## F-101 — SDK frame splitting differs on a lone carriage return

- **Raised by.** D1 event stream ([unit report](units/events-sse.md)). Severity: correctness.
- **Finding.** The server relay treated a lone carriage return as a line break, while the SDK splitter accepted LF and CRLF only. The original divergence was `lone_cr_splitter_divergence`; the repaired model proves `lone_cr_splitter_agrees`.
- **Source.** `packages/sdk/src/events/sse.ts#splitSseFrames`; `apps/web/server/runs/relay.ts`.
- **Resolution.** [PR #284](https://github.com/indxjp/agent-workspace/pull/284) normalizes lone CR across chunk boundaries and handles a final CR at end of stream. The regression failed before repair and the SDK suite passed 352/352 afterward. Outcome: fixed and merged.

## F-102 — A terminal run makes its browser token unusable for a final read

- **Raised by.** D1 run-token authorisation ([unit report](units/authz-run-token.md)). Severity: correctness.
- **Finding.** Run-scoped browser-token resolution refuses a terminal run, although the documented read/follow scope and SDK outcome flow require a final run read. Lean: `terminal_run_read_diverges`.
- **Source.** `apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor`; `docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1`.
- **Resolution.** Triage the intended lifetime and fix the resolver or contract with a terminal-read regression. Outcome: awaiting triage.

## F-103 — Archived sessions can be reused for a new run

- **Raised by.** D1 run composition ([unit report](units/run-compose.md)). Severity: correctness.
- **Finding.** The requested-session branch checked workspace, agent, owner and project but not session status. An archived session with a Claude session id was returned for resume. The original divergence was `archived_session_reuse_diverges`; the repaired model proves `archived_session_reuse_refused`.
- **Source.** `apps/web/server/composition/wiring/run-api.ts#openSession`; `apps/web/server/composition/session-launch.ts#sessionForLaunch`.
- **Resolution.** [PR #286](https://github.com/indxjp/agent-workspace/pull/286) added a PostgreSQL-backed regression through the composed run API and rejects archived requested sessions. The regression failed before repair and all four suite tests passed afterward. Outcome: fixed and merged.

## F-104 — Server start parser accepts an empty model rejected by the contract

- **Raised by.** D1 run composition ([unit report](units/run-compose.md)). Severity: correctness.
- **Finding.** The server parser accepted a valid model connection id paired with `model: ""`, while the public `StartRunRequestSchema` rejected a blank model. The original divergence was `server_accepts_empty_model_contract_refuses`; the repaired model proves `server_rejects_empty_model_with_contract`.
- **Source.** `apps/web/server/runs/api.ts#parseStartRunBody`; `packages/contracts/src/runs.ts#StartRunRequestSchema`.
- **Resolution.** [PR #285](https://github.com/indxjp/agent-workspace/pull/285) rejects an empty model at the server boundary. Its real handler regression failed before repair and passed after it. Outcome: fixed and merged.

## F-105 — Proxy rejects valid browser-token bearer scheme casing

- **Raised by.** D1 adversarial access ([unit report](units/adversarial-runs-access.md)). Severity: correctness.
- **Finding.** The browser-token parser accepts the HTTP bearer scheme case-insensitively, but the proxy's earlier exact prefix check returned 401 for lowercase or mixed case before the run route could verify the token. The route and scope allowlist did not require that spelling.
- **Source.** `apps/web/proxy.ts#isBrowserTokenExemptRoute`; `apps/web/server/rbac/browser-token.ts#readBearerBrowserTokenAttempt`.
- **Resolution.** [PR #283](https://github.com/indxjp/agent-workspace/pull/283) uses the parser's bearer-scheme grammar while retaining the exact token prefix and route shapes. The proxy regression failed before the change and all 14 proxy tests passed afterward. Outcome: fixed and merged.

## F-106 — RuntimeProfile.lean does not model the driverConfig credential-key refusal

- **Raised by.** PR #401 review (issue #380 item 6). Severity: documentation.
- **Finding.** Since ADR-0088 D2, `POST /api/runtime-profiles` and `PATCH /api/runtime-profiles/:id`
  refuse a `driverConfig` key whose words name a credential, and a `driverConfig` nested deeper than
  32 levels. The model in `formal/AgentWorkspace/Concepts/RuntimeProfile.lean` still treats
  `driverConfig` as any object on create and update, so its accepted-input set is wider than the
  contract's.
- **Source.** `apps/web/server/runtimes/contract.ts#refuseDriverConfigCredentials`;
  `docs/adr/0088-a-builder-reads-runtime-profiles-and-a-profile-carries-no-credential.md`.
- **Proposed resolution.** Follow-up in the configuration domain: model the refusal on the write
  path only (stored rows still read), with a vector for a credential key, a reference key
  (`secretRef`) and the depth bound.
- **Outcome.** open. To be triaged in its domain (handover §5.2 step 7).

## F-107 — The run-start model has no `422` configuration-refusal branch

- **Raised by.** [PR #403](https://github.com/indxjp/agent-workspace/pull/403) review (issue #393). Severity: documentation.
- **Finding.** `startRun` now refuses a start whose agent has no runtime profile, or whose model ladder resolves nothing usable, with `422` and a `RUN_START_PROBLEM_CODES` code (`agent_runtime_profile_missing`, `model_connection_unresolved`, `model_unavailable`, `model_credential_rejected`), and creates no run. For a start that opens a new session the check runs **before** `openSession`, so it also precedes `409 session_not_usable` and creates no session; for a follow-up it runs after the session is found usable. `formal/AgentWorkspace/Behaviour/Runs.lean#step`'s `.start` branch goes from `session_not_usable` straight to `202` and models neither this refusal nor its order, so no theorem states that a refused start leaves `runs` (and, for a new session, the session table) unchanged. The engine checks before it (`409 session_engine_mismatch`, `422 engine_not_installed`) are likewise unmodelled.
- **Source.** `apps/web/server/runs/api.ts#startRun`; `apps/web/server/compose/run-preflight.ts#createRunPreflight`; `formal/AgentWorkspace/Behaviour/Runs.lean#step`.
- **Resolution.** Follow-up: add an optional preflight outcome to the `.start` request, branch on it before `sessionUsable` when no session is requested and after it otherwise, and prove that every refusal leaves the state unchanged. Outcome: open.

## F-108 — §9's route block gained the tool route, which the gateway-ingress model does not yet model

- **Raised by.** S2-02d (issue #529). Severity: documentation.
- **Finding.** `docs/spec.md` §9's fenced block now ends with `POST /v1/tools/:connectorId/mcp` (ADR-0113 C16), and `createGatewayApplication(...).routes` serves it. `createRouter` keeps the six model routes, so `formal/AgentWorkspace/Behaviour/GatewayIngress.lean#Route` and its theorems still hold of the router, but `route_table_is_the_spec_contract`'s docstring ("exactly §9's fenced block") now describes six of the block's seven lines. That file is outside S2-02d's ownership and stays byte-unchanged.
- **Source.** `packages/gateway/src/index.ts#createGatewayApplication`; `packages/gateway/src/tools/authorize.ts#authorizeToolCall`; `formal/AgentWorkspace/Theorems/WellFormed/GatewayIngress.lean#route_table_is_the_spec_contract`.
- **Resolution.** S2-02d adds `Behaviour/GatewayIngress.lean#Ingress`, which embeds `Route` unchanged and adds the tool class, and `toolDecision`, which mirrors `verifyRunToken` then `authorizeToolCall`. `Theorems/Adversarial/GatewayIngress.lean#ingress_paths_are_the_spec_contract` is the theorem over the whole seven-line block, with `tool_ingress_is_unmetered`, `tool_ingress_never_resolves_a_model_key` and `model_ingress_is_route`; `Theorems/Adversarial/AuthzRunToken.lean` proves the C16 refusals. `tools.json` in both families is replayed by `tests/formal/gateway-ingress.test.ts` and `tests/formal/authz-run-token.test.ts`. What remains is the docstring of `route_table_is_the_spec_contract`, to be reworded to "the model routes of §9's block" by a unit that owns that file. Outcome: modelled; docstring open.

## F-109 — A ceiling refusal is audited as `agent-changed`, and the run-start ceiling branch is not modelled

- **Raised by.** S2-04b (issue #535). Severity: documentation.
- **Finding.** Every write that would make an agent wider than `AW_DEPLOYMENT_POLICY` answers `403 policy_cannot_widen` and, unless it is a dry run, writes one §36 row. `auditActions` (`packages/core/src/db/schema/audit-events.ts`) has no refusal action and adding one needs a core migration, so the row reuses `agent-changed` with the label `<name>: refused policy_cannot_widen <details>`; the §36 screen therefore shows a refusal as a change. Separately, `startRun` now refuses an explicit `modelOverride` outside the ceiling's `models` before any session or run exists, and `formal/AgentWorkspace/Behaviour/Runs.lean#step`'s `.start` branch does not model that refusal or its order, extending F-107.
- **Source.** `apps/web/server/policy-ceiling/ceiling.ts#createCeilingFor`; `apps/web/server/composition/setup.ts#setupCeilingRefusal`; `apps/web/server/runs/api.ts#startRun`; `formal/AgentWorkspace/Behaviour/Runs.lean#step`.
- **Resolution.** Follow-up: a dedicated refusal action in the core lane (with its migration), and the ceiling branch in the `.start` model alongside F-107's preflight branch. Outcome: open.
