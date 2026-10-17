# F-authz-tenancy — tenant selection and isolation

Unit of D1 ([domain checklist](../domains/d1-runs.md)). It builds the shared tenancy module that
every domain reuses. It is built on `Er/Current`, reusing its `State`, `Stmt`, `commit`,
`consistent` and `Reachable`, and on `Er.Core.tenantOf`. It redefines no table, row or
constraint.

```sh
cd formal && lake build AgentWorkspace.Authz.Tenancy \
  AgentWorkspace.Theorems.{WellFormed,Normative,Invariants,Adversarial,Refinement,Meta}.AuthzTenancy \
  Vectors.AuthzTenancy
```

## What is modelled (`formal/AgentWorkspace/Authz/Tenancy.lean`)

| Part                     | TypeScript                                                                                                                             | Lean                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Workspace scope          | `scope.ts`: the database and in-memory resolvers, `isWorkspaceScope`, `requireWorkspaceScope`                                          | `forWorkspaceId`, `forWorkspaceSlug`, `inMemoryForId/Slug`, `ScopeValue`, `requireWorkspaceScope`          |
| Selection, session       | `root.resolveMembership`, then `Principal.fromSession` at `session-rbac.ts:274`                                                        | `resolveMembership`, `fromSession`, `identifySessionCurrent`                                               |
| Selection, API key       | `authenticateApiKeyHash`, `Principal.fromApiKey`                                                                                       | `authenticateApiKey`, `fromApiKey`                                                                         |
| Selection, browser token | `resolveBrowserTokenActor`: active row, scoped run or session check, `principalById`, `Principal.fromBrowserToken`                     | `resolveBrowserToken`, `principalById`, `fromDirectoryRecord`, `fromBrowserToken`                          |
| Scoped repository        | `WHERE workspace_id = scope`; rows built from the scope                                                                                | `scopedSelect`, `RepoWrite.compile` (a `Stmt` list), `repoCommit` (`commit` under `Er.Current.consistent`) |
| Run lookup               | `findRunForPrincipal` (`api.ts:331`), `findRunWorkspace`, `createRepositoryRunStore.get`, the four run routes' steps before the lookup | `storeGet`, `findRunForPrincipal`, `findRunWorkspace`, `dbStoreGet`, `runPreflight`, `runRoute`            |
| Object store             | `createScopedObjectStore`, `evaluateRelativePath`                                                                                      | `keyGuard`, `fullKey`, `scopedObjectOp` with `…Current` (non-blank id) and `…Target` (also no `/`)         |
| Tenant session scope     | `validateTenantSessionScope`                                                                                                           | `validateTenantSessionScope` over `JValue`                                                                 |
| 404 before `decide()`    | `authorise` (`rbac/http.ts`), `requireResourceAccess`, `memberOwnershipResolver`, `ownerOwnershipResolver`, `getForMember`             | `authoriseFlow`, `resolveMembershipView`, `memberResolver`, `ownerResolver`, `getForMember`                |
| F-007                    | `tenancy.test.ts` rule 1 and `leadingIndexedColumns`                                                                                   | `testRule1`, `leadingIndexedColumns` (transcribed, and replayed against live Drizzle)                      |

## Theorems (55)

| Tier                                 | Theorem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T0                                   | `key_guard_accepts_only_its_own_safe_input`: the key guard is a filter. It returns its input or refuses it, and an accepted key has no `%`, `\`, control character or leading `/`.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| T1, scope and selection              | `resolved_scope_names_an_existing_workspace`; `session_principal_is_in_the_session_workspace`; `session_selects_target_membership_after_foreign_first`; `api_key_principal_is_in_the_key_workspace`; `browser_token_principal_is_in_the_token_workspace`                                                                                                                                                                                                                                                                                                                                                           |
| T1, dead credentials                 | `session_for_another_workspace_is_refused`; `session_with_a_blank_identity_is_refused`; `revoked_or_expired_api_key_selects_no_workspace`; `api_key_of_a_revoked_principal_selects_no_workspace`; `expiry_instant_is_exclusive` (live iff `now < expires_at`); `browser_token_selection_requires_a_live_token`; `browser_token_selection_requires_a_live_minter` (the minter's principal row, and for a key-minted token the minting key's `revoked_at` and `expires_at`, plus the directory's current role); `browser_token_for_a_run_requires_a_live_run`; `browser_token_for_a_session_requires_a_live_session` |
| T1, run routes                       | `run_lookup_is_scoped_to_the_caller`; `run_route_answers_404_for_absent_or_foreign_runs` (the literal `404 run_not_found` and its message); `revoke_tokens_refuses_a_browser_token_first`; `revoke_tokens_requires_owner_or_admin_before_the_id_check`; `run_route_checks_the_id_after_its_gates` (`400 invalid_run_id`, then the lookup)                                                                                                                                                                                                                                                                          |
| T1, `authorise` and workspace routes | `resolver_refusal_bypasses_decide`; `authorise_follows_decide_after_an_ownership` (allow, `403 forbidden` or `403 token_out_of_scope`, `500`); `authorise_refuses_before_resolving` (`503`, `401`); `api_key_caller_is_refused_on_workspace_routes`; `malformed_workspace_id_is_not_found_for_every_caller`; `non_member_or_absent_workspace_is_not_found` (`404`, never `403`); `lesser_member_is_measured_not_concealed`; `via_wire_spellings`                                                                                                                                                                   |
| T1, key guard                        | `empty_key_is_refused_except_as_the_root_listing`; `key_guard_refuses_each_named_traversal` (ADR W2-CP-03's named rules, and the legal `..config/x.txt`)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| T1, tenant session scope             | `tenant_scope_verdict_has_two_arms`; `tenant_scope_rejections_follow_the_field_order`; `workspace_id_is_a_valid_project_key`; `project_key_is_one_to_sixty_four_characters`; `project_key_character_class` (all 128 ASCII characters, checked against ranges transcribed independently); `windows_device_names_are_refused_in_any_case` (every device name, in mixed case, and near misses)                                                                                                                                                                                                                        |
| T2                                   | `scoped_select_reads_only_its_workspace`; `principal_by_id_reads_only_its_workspace` (role, label, user and key come from rows of the asked workspace); `repository_write_touches_only_its_workspace` (every row outside the scope's workspace, including global rows, is unchanged after commit or rollback); `object_keys_carry_their_workspace`; `object_keys_of_two_workspaces_are_disjoint` (neither a key nor a segment prefix is shared)                                                                                                                                                                    |
| T3                                   | `forged_scope_is_refused`; `scoped_read_is_blind_to_other_workspaces`; `run_route_sees_only_the_callers_workspace` (noninterference over every route, caller, id and continuation); `foreign_run_is_indistinguishable_from_absent`; `workspace_resolvers_conceal_foreign_workspaces`; `accepted_key_cannot_escape_the_workspace_root` (no empty, `.`, `..` or marker segment)                                                                                                                                                                                                                                      |
| T4                                   | `database_run_lookup_refines_memory_lookup` (S-321); `in_memory_resolver_refines_database_resolver`; `in_memory_slug_resolver_refines_database_resolver` (last row wins; equal under unique slugs); `object_store_current_agrees_with_target_on_uuids`; `object_store_current_diverges_at_slash_workspace_id`                                                                                                                                                                                                                                                                                                      |
| T5                                   | `tenancy_rules_agree_on_the_catalogue`; `tenancy_rules_differ_off_the_catalogue` (F-007); `session_slug_check_is_dead_at_its_call_site`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Every theorem with hypotheses has an `example` witness in its file or a positive vector. Repair
round 2 removed a dead `have` from the T0 proof and re-cited
`malformed_workspace_id_is_not_found_for_every_caller` (see finding 5). Repair round 1 removed `repository_write_preserves_consistency`. It held for any transaction by the
definition of `Er.Current.commit`, so it said nothing about scoping.

## Vectors and conformance (1051 vectors, 1053 tests, all passing)

| File                        | Cases | Replayed against                                                                                                |
| --------------------------- | ----: | --------------------------------------------------------------------------------------------------------------- |
| `scope-resolver.json`       |    30 | `createInMemoryWorkspaceScopeResolver`, plus `requireWorkspaceScope` on each minted scope                       |
| `scope-forgery.json`        |     6 | `requireWorkspaceScope` (a cast literal, `Object.create(prototype)`, and non-objects)                           |
| `object-keys.json`          |   418 | `createScopedObjectStore` over a recording backend: keys × 6 operations, workspace-id acceptance, the collision |
| `tenant-session-scope.json` |   261 | `validateTenantSessionScope`                                                                                    |
| `tenancy-rule.json`         |    39 | Live Drizzle `getTableConfig`: leading index columns and rule 1, per table                                      |
| `run-concealment.json`      |   160 | The real `readRun`, `streamRunEvents`, `interruptRun` and `revokeRunTokens` over `InMemoryRunStore`             |
| `principal-selection.json`  |    13 | `Principal.fromSession`, `fromApiKey` and `fromBrowserToken`, plus `isPrincipal`                                |
| `workspace-access.json`     |    50 | `memberOwnershipResolver` and `ownerOwnershipResolver` over the in-memory directory and repository              |
| `authorise.json`            |    80 | `requireResourceAccess` through `installRbacHarness`, which runs the resolver and then `decide()`               |

The replay suites are `tests/formal/authz-tenancy.test.ts`, which reaches package code through
the package exports, and `apps/web/formal/authz-tenancy.test.ts`, which covers application code
(D-012). `run-concealment.json` is the real request path. For the same id, a foreign run and an
absent run get the same status, code and message.

## Mutation pass

Each mutation was applied to `Authz/Tenancy.lean` and the six theorem modules were rebuilt. The
file was then restored byte for byte (`cmp`). Rounds 0 and 1 ran the 34 mutations in the first
table. An independent verifier then ran 13 fresh mutations, and 8 of them survived at theorem level
(caught only by a vector, an `example` or a proof script). Repair round 2 added theorems for them
and re-ran all 13 with a script; the second table records the result.

Independent verifier round 3 removed the target-workspace predicate from
`resolveMembership`'s membership lookup. That mutation survived the prior one-way session
selection theorem. `session_selects_target_membership_after_foreign_first` now gives one user a
foreign membership before a valid target-workspace membership and requires the target principal
to be selected. The exact mutation fails at this theorem. Its source was restored byte for byte,
and the narrow theorem target rebuilt cleanly.

| Repair round 2 mutation                                | Caught by (theorem)                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `segmentRule` admits `..`                              | `key_guard_refuses_each_named_traversal` (and `accepted_key_cannot_escape_the_workspace_root`) |
| `segmentRule` drops the reserved-marker rule           | `key_guard_refuses_each_named_traversal` (and `accepted_key_cannot_escape_the_workspace_root`) |
| a non-member gets `403 forbidden`                      | `non_member_or_absent_workspace_is_not_found`                                                  |
| an unknown actor gets `403 forbidden`                  | `non_member_or_absent_workspace_is_not_found`                                                  |
| `principalById`'s membership join drops `workspace_id` | `principal_by_id_reads_only_its_workspace`                                                     |
| `principalById` ignores the key's `revoked_at`         | `principal_by_id_reads_only_its_workspace`                                                     |
| `principalById` ignores the key's `expires_at`         | `principal_by_id_reads_only_its_workspace`                                                     |
| `inMemoryForSlug` takes the first match                | `in_memory_slug_resolver_refines_database_resolver`                                            |
| `inMemoryForSlug` returns the slug as the id           | `in_memory_slug_resolver_refines_database_resolver`                                            |
| `configDirBlank` answered as `configDirNotString`      | `tenant_scope_rejections_follow_the_field_order`                                               |
| `Via.toWire` spells `browser_token`                    | `via_wire_spellings`                                                                           |
| `after` uses `≤`                                       | `expiry_instant_is_exclusive`                                                                  |
| put/get/delete accept the empty key                    | `empty_key_is_refused_except_as_the_root_listing`                                              |

Rounds 0 and 1 (34 mutations):

| Mutation                                                      | Caught by                                                                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| a cast literal passes `isWorkspaceScope`                      | `forged_scope_is_refused`                                                                                  |
| `findRunForPrincipal` drops the workspace check               | `run_lookup_is_scoped_to_the_caller`                                                                       |
| `withWorkspace` keeps the caller's tenant                     | `repository_write_touches_only_its_workspace` (via its compile lemma)                                      |
| the target rule drops "no `/`"                                | `object_keys_of_two_workspaces_are_disjoint`, the divergence theorem                                       |
| the prefix loses its `/`                                      | `object_keys_carry_their_workspace`, the divergence theorem                                                |
| the project-key bound goes from 64 to 32                      | `workspace_id_is_a_valid_project_key`                                                                      |
| a resolver refusal reaches `decide()`                         | `resolver_refusal_bypasses_decide`                                                                         |
| `getForMember` ignores the user                               | `workspace_resolvers_conceal_foreign_workspaces`                                                           |
| `audit_events` loses its tenant index                         | `tenancy_rules_agree_on_the_catalogue`, `tenancy_rules_differ_off_the_catalogue`                           |
| `fromSession` compares the id rather than the slug            | `session_slug_check_is_dead_at_its_call_site`, the session selection theorem                               |
| an update drops the new-row tenant conjunct                   | `repository_write_touches_only_its_workspace`                                                              |
| the API-key refusal is dropped                                | `api_key_caller_is_refused_on_workspace_routes`                                                            |
| the slug resolver returns the slug                            | `resolved_scope_names_an_existing_workspace`                                                               |
| the key guard admits `%`                                      | `key_guard_accepts_only_its_own_safe_input`                                                                |
| swap `token_out_of_scope` and `run_token_revoke_forbidden`    | `revoke_tokens_refuses_a_browser_token_first`                                                              |
| the project-key bound goes from 64 to 65                      | `project_key_is_one_to_sixty_four_characters`                                                              |
| the project-key class drops `-`                               | `project_key_character_class`, `workspace_id_is_a_valid_project_key`                                       |
| the device list drops `nul`                                   | `windows_device_names_are_refused_in_any_case`                                                             |
| the device list drops `lpt0` to `lpt9`                        | `windows_device_names_are_refused_in_any_case`                                                             |
| `resolveBrowserToken` drops the terminal-run check            | `browser_token_for_a_run_requires_a_live_run`                                                              |
| `resolveBrowserToken` drops the archived-session check        | `browser_token_for_a_session_requires_a_live_session`                                                      |
| `resolveBrowserToken` drops the token's `revoked_at` check    | `browser_token_selection_requires_a_live_token`                                                            |
| `principalById` drops `revoked_at`                            | `browser_token_selection_requires_a_live_minter`                                                           |
| `authenticateApiKey` drops the key's `revoked_at` check       | `revoked_or_expired_api_key_selects_no_workspace`                                                          |
| `authenticateApiKey` drops the expiry check                   | `revoked_or_expired_api_key_selects_no_workspace`                                                          |
| `authenticateApiKey` drops the principal's `revoked_at` check | `api_key_of_a_revoked_principal_selects_no_workspace`                                                      |
| `resolveMembershipView` checks the API key before the UUID    | `malformed_workspace_id_is_not_found_for_every_caller`                                                     |
| `runNotFound` answers `403`                                   | `run_route_answers_404_for_absent_or_foreign_runs`                                                         |
| `fromSession` drops the blank-label check                     | `session_with_a_blank_identity_is_refused`                                                                 |
| the revoke-tokens role gate is skipped                        | `revoke_tokens_requires_owner_or_admin_before_the_id_check`                                                |
| the revoke preflight checks the id first                      | `revoke_tokens_refuses_a_browser_token_first`, `revoke_tokens_requires_owner_or_admin_before_the_id_check` |
| `authorise` maps a deny to `404`                              | `authorise_follows_decide_after_an_ownership`                                                              |
| `authorise` changes its default deny code                     | `authorise_follows_decide_after_an_ownership`                                                              |
| `authorise` answers `500` when unconfigured                   | `authorise_refuses_before_resolving`                                                                       |

## Findings

1. **Correctness.** `createScopedObjectStore` accepts a workspace id that contains `/`, because it
   only checks for a blank string (`packages/core/src/storage/object-store.ts:191`). With such an
   id, workspace `a` key `b/c` and workspace `a/b` key `c` are the same backend key,
   `workspaces/a/b/c`. Listing the root of `a` also lists `a/b`'s objects.
   - This is safe today. Every production caller passes a server-minted UUID
     (`principal.workspaceId`), and the theorems `object_store_current_agrees_with_target_on_uuids`
     and `object_keys_of_two_workspaces_are_disjoint` show that the key disjointness holds for
     those ids.
   - The failure is shown by `object_store_current_diverges_at_slash_workspace_id` and by the
     vector test "two workspaces reach one backend key today".
   - Proposed resolution: refuse `/` in the workspace id, or require `isUuid`, as a
     defence-in-depth fix with a regression test.
2. **Documentation.** `Principal.fromSession`'s workspace-correspondence check
   (`apps/web/server/rbac/principal.ts:189`) can never fire at its only production call site. That
   site passes `slug: verified.claims.ws` (`apps/web/server/composition/session-rbac.ts:276`), so
   the slug it compares with the claims is the claims' own.
   - The binding of a session to its workspace comes only from `resolveMembership`'s slug lookup.
     `session_principal_is_in_the_session_workspace` proves that the binding is sound.
   - The check is dead at that site: `session_slug_check_is_dead_at_its_call_site`.
   - Proposed resolution: return the workspace's stored slug from `resolveMembership` and pass
     that, or correct the comment.
3. **F-007, triaged.** The model's rule (`Er.Core.tenancyWellFormed`) and `tenancy.test.ts` rule 1
   are different predicates. `tenancy_rules_differ_off_the_catalogue` shows the two ways they
   differ: a `text` `workspace_id` passes the test's rule and fails the model's, and a missing
   tenant index passes the model's rule and fails the test's.
   - Both rules hold of all 39 tables today (`tenancy_rules_agree_on_the_catalogue`).
   - The index fact is now modelled as `leadingIndexedColumns` and replayed against the live
     Drizzle tables.
   - Proposed resolution: close F-007 as a documentation item, and point `tenancyWellFormed`'s
     docstring at `Authz/Tenancy.testRule1`.
4. **Observation (suspicious point 14), not a new finding.** A run id spelled in upper case
   passes `isUuid`, but `InMemoryRunStore` looks it up by exact string and answers `404`. The
   PostgreSQL `uuid` lookup would find the run. The model follows the in-memory store (vector
   `own-upper`). This does not leak across tenants.
5. **Documentation.** A malformed workspace id answers `404 workspace_not_found`
   (`apps/web/server/workspaces/access.ts:104`), but `docs/sdk/04-api-specification.md` §4 says
   "400 malformed/invalid". No document states the `404`; ADR W9-WS-119-2 states only that the
   `isUuid` check comes before the API-key refusal. Lean: `malformed_workspace_id_is_not_found_for_every_caller`
   now cites that ADR and the code, not §4. Proposed resolution: document the `404` in §5.1 (it
   conceals like a foreign id, which is defensible) or answer `400 invalid_workspace_id`.

No security finding holds against today's code.

## Gaps

- `resolveMembership`, `authenticateApiKey`, `resolveBrowserToken`, the database resolver and
  the PostgreSQL repositories are proved against transcriptions but not replayed. They need a
  database, which the `heavy-checks` suites cover.
- A `DELETE`'s `ON DELETE` cascade (`Er.Current.deleteRow`) is not restated as a scoped
  operation. The ErCore unit's `no_cross_tenant_reference` covers it.
- The key guard is exact for keys without `%`. Any key with `%` is refused, but the model does not
  say by which rule. The backend's second guard call, the one it runs on the full key, belongs to
  D4.
- The working tree also has edits to files this unit does not own: citation fixes in
  `Theorems/Invariants/ErSynthesis.lean` and `Theorems/Normative/ConceptIdentity.lean`, and the
  integration lines in `formal/AgentWorkspace.lean` and `formal/Vectors/Main.lean`. This unit did
  not make them in repair round 1. It did not revert them either, because concurrent units or the
  integrator may depend on them. The integrator should decide who owns them.

## Coverage

| Item         | Covered by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-3.4        | `run_route_answers_404_for_absent_or_foreign_runs`, `foreign_run_is_indistinguishable_from_absent`, `run_route_checks_the_id_after_its_gates`, `revoke_tokens_refuses_a_browser_token_first`, `revoke_tokens_requires_owner_or_admin_before_the_id_check`; `run-concealment.json` (the real route handlers)                                                                                                                                                                                                                            |
| AZ-22        | `run_lookup_is_scoped_to_the_caller`, `run_route_sees_only_the_callers_workspace`; `run-concealment.json` for all four run routes                                                                                                                                                                                                                                                                                                                                                                                                      |
| AZ-23        | Structural only: `findAgent` reads through a workspace-bound store (`scoped_read_is_blind_to_other_workspaces`). The handler's `404 agent_not_found` belongs to the runs behaviour unit.                                                                                                                                                                                                                                                                                                                                               |
| AZ-24        | `scoped_select_reads_only_its_workspace`, `accepted_key_cannot_escape_the_workspace_root`, `in_memory_slug_resolver_refines_database_resolver`, `repository_write_touches_only_its_workspace`, `forged_scope_is_refused`, `database_run_lookup_refines_memory_lookup`; F-007 triaged                                                                                                                                                                                                                                                   |
| AZ-25        | The three selection theorems (`p.scope = none` for a session, `isSome` for a browser token); `session_for_another_workspace_is_refused`, `session_with_a_blank_identity_is_refused`, `revoked_or_expired_api_key_selects_no_workspace`, `api_key_of_a_revoked_principal_selects_no_workspace`; `principal-selection.json`                                                                                                                                                                                                              |
| AZ-26        | `browser_token_principal_is_in_the_token_workspace` (the minter is re-read in the token's workspace); `browser_token_selection_requires_a_live_token`, `browser_token_selection_requires_a_live_minter`, `browser_token_for_a_run_requires_a_live_run`, `browser_token_for_a_session_requires_a_live_session`, `principal_by_id_reads_only_its_workspace`, `expiry_instant_is_exclusive` (a revoked or expired minting key, a terminal run, an archived session, a revoked minter, or a revoked or expired token selects no workspace) |
| AZ-31        | `resolver_refusal_bypasses_decide`, `workspace_resolvers_conceal_foreign_workspaces`, `non_member_or_absent_workspace_is_not_found`, `api_key_caller_is_refused_on_workspace_routes`, `malformed_workspace_id_is_not_found_for_every_caller`, `lesser_member_is_measured_not_concealed`; `workspace-access.json`, `authorise.json`                                                                                                                                                                                                     |
| S-26         | The "404 also for cross-tenant, never 403" clause: `run_route_answers_404_for_absent_or_foreign_runs`. The body-error clauses are suspicious point 8, which is not this unit's.                                                                                                                                                                                                                                                                                                                                                        |
| S-267        | `run_route_answers_404_for_absent_or_foreign_runs`, `foreign_run_is_indistinguishable_from_absent`; vectors for `read` and `events`                                                                                                                                                                                                                                                                                                                                                                                                    |
| S-321        | `database_run_lookup_refines_memory_lookup` (`findRunWorkspace` yields only an id). Memoisation is not modelled because it is a cache over a pure function.                                                                                                                                                                                                                                                                                                                                                                            |
| S-340        | `tenant_scope_verdict_has_two_arms`, `workspace_id_is_a_valid_project_key`, `project_key_is_one_to_sixty_four_characters`, `project_key_character_class`, `windows_device_names_are_refused_in_any_case`; `tenant-session-scope.json`                                                                                                                                                                                                                                                                                                  |
| S-341, S-342 | Not modelled here: `compileRunRequest` and the environment derivation belong to `Behaviour/RunCompose`.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| S-355        | Not modelled here: the transcript `project_key` mismatch is D4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| S-358        | `resolver_refusal_bypasses_decide`, `authorise_follows_decide_after_an_ownership`, `authorise_refuses_before_resolving`; `authorise.json`                                                                                                                                                                                                                                                                                                                                                                                              |
| S-362        | Not modelled: telemetry is outside D1's run routes. Its shape (a required workspace id) is the scoped-read pattern.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| S-365        | Covered by ErCore's `no_cross_tenant_reference` and `reference_preserves_tenant` over `runs_session_workspace_fk`. Not restated here.                                                                                                                                                                                                                                                                                                                                                                                                  |
| F-007        | Triaged: `tenancy_rules_agree_on_the_catalogue`, `tenancy_rules_differ_off_the_catalogue`; `tenancy-rule.json`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| F-062        | Not modelled here: the transcript key is sessions (D4). `workspace_id_is_a_valid_project_key` covers the run side (`projectKey = workspaceId`).                                                                                                                                                                                                                                                                                                                                                                                        |
