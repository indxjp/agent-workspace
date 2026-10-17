# Unit `er-synthesis` — the concept tangle resolved on paper and in proofs (phase P1c)

The synthesis of phase P1: the five concept clusters' views of today's schema put together into
one, a cleaned-up target ER model with one meaning per term, a refinement map from today onto the
target with T4 theorems on what it keeps and where the two diverge, the concept glossary
([`docs/formal/concepts.md`](../concepts.md)) with a generated target ER diagram, and one ADR draft
per proposed cleanup.

| File                                                                                                | What it holds                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `formal/AgentWorkspace/Er/Current.lean`                                                             | `Cluster`, `refinedBy`, `checkSemantics`, whole-schema `consistent`, `ownerColumn?`, transactions (`Stmt`, `run`, `commit`, `Reachable`), `deleteRow`, and `Witness.state` (a row in every one of the 39 tables) with `Witness.load` |
| `formal/AgentWorkspace/Er/Target.lean`                                                              | The target `schema`, `nonReferenceIdColumns`, `tableName`, `ownerColumn?`, target row checks and `consistent`, `violations`, `erDiagram`, the session-claim `Resolution` model, the `glossary` and `conflations`                     |
| `formal/AgentWorkspace/Er/Refinement.lean`                                                          | `toTarget` / `mapRow`, `fkImage`, the divergence lists, the twelve one-cell `Divergence` states, the five `Refusals` (one per cluster), the `TargetCells`, the `ResolutionCells` and `DeleteWitness`                                 |
| `formal/AgentWorkspace/Theorems/{WellFormed,Normative,Invariants,Refinement,Meta}/ErSynthesis.lean` | the theorems, by tier                                                                                                                                                                                                                |
| `formal/Vectors/ErSynthesis.lean` → `formal/generated/vectors/er-synthesis/`                        | `clusters.json` (39), `keys.json` (107), `owners.json` (9), `divergence.json` (35), `refusals.json` (5), `diagram.json` (1), `glossary.json` (64)                                                                                    |
| `tests/formal/er-synthesis.test.ts`                                                                 | replays every vector against the live Drizzle schema, `renderValueList`, `workspacePrincipalKinds`, `PRINCIPAL_KINDS`, `MODEL_PROVIDERS` and the concept page (236 tests)                                                            |
| `docs/formal/concepts.md`                                                                           | the glossary, the conflations, whole-schema tenancy, the target ER diagram and the Current → Target mapping                                                                                                                          |
| `docs/adr/FORMAL-P1-*.md`                                                                           | ten ADR drafts, status proposed                                                                                                                                                                                                      |

## Modelling decisions

- **Whole-schema consistency is the conjunction of the five cluster views.**
  `Er.Current.consistent st` is `Identity.consistent ∧ Catalog.consistent ∧
Configuration.consistentConfig ∧ Work.workConsistent ∧ Publication.consistent`. Each view already
  contains `Er.Core.consistent catalogue`, so the conjunction adds exactly the 68 refined checks
  and the identity cluster's cell typing. `checkSemantics` gives each check the meaning of its
  table's own cluster; the two checks that two clusters refine (the default-model pairs) are proved
  to mean the same in both (`shared_checks_agree`).
- **T2 is stated over operation sequences.** A `Stmt` inserts, deletes or updates a row; a
  transaction is a list of them; `commit P` keeps the state a transaction leaves only if `P` holds
  there, else rolls back; `Reachable P` is the closure of the empty database. Checking constraints
  only at commit admits more intermediate states than PostgreSQL's per-statement checking, so an
  invariant proved over `Reachable` holds for every write sequence the real database accepts. This
  closes the "T2 is state-only" gap the cluster units recorded, for the tenancy invariants.
- **The target is a `Schema` over the same 39 tables.** Every `Er.Core` predicate and lemma applies
  to it unchanged (`tableWellFormed`, `pairingComplete`, `idColumnsCovered`, the isolation lemmas).
  Renames of tables are a naming layer (`Target.tableName`); column renames, re-keyings and new
  columns are schema edits. State-level invariants the schema cannot express (source coverage,
  typed runtime connections) are part of `Target.consistent`.
- **The target's new checks are renamed where their spelling changes.** Today's
  `workspace_principals_source_xor` is hard-wired to `api_key` in `Er.Core.otherCheckHolds`, so the
  target's check is `workspace_principals_source_matches_kind`, with the `api-key` spelling.
- **The refinement map is row by row.** `mapRow` edits cells other than `id` and `workspace_id`, so
  the map never drops, adds or re-homes a row (proved for every state). Where a target column is
  derived from another table (a grant's principal, an inviter's principal, a connection's credential)
  it is looked up in the same state; when the lookup fails the cell is `NULL`, and the target's
  constraints decide whether that is allowed.
- **`deleteRow` applies inbound `ON DELETE` actions one level deep.** Enough to exhibit er-core
  finding 1 as an operation (`deleting_a_default_agent_diverges`), not a full cascade engine.
- **Violations are named.** `violationsUnder` lists the names of the constraints a state breaks, so
  each divergence theorem names its cell exactly, not just "inconsistent".
- **The target ER diagram is generated.** `Target.erDiagram` renders the target schema as mermaid
  (every key but the 30 root references and the 9 `SET NULL` siblings); the concept page carries it
  verbatim and the suite compares them.
- **The glossary is data.** `Target.glossary` (64 terms) and `Target.conflations` (10 words) back
  the T5 theorems; `concepts.md` is their prose.

## Theorems (82: 8 T0, 9 T1, 22 T2, 38 T4, 5 T5; 30 traced definitions)

- **T0 (WellFormed).** `cluster_wires`; `clusters_partition_the_tables` (each table in exactly one
  cluster, 39 in all); `every_other_check_is_refined` (81 checks, each with a meaning);
  `only_the_default_model_pairs_are_refined_twice`; `check_semantics_follow_the_owning_cluster`;
  `target_tables_are_well_formed` (all 39, including the tenancy rule);
  `target_checks_all_have_a_meaning`; `er_diagram_draws_each_relationship_once`.
- **T1 (Normative)**, on "a session proves identity; RBAC proves permission; a repository scope
  proves tenant selection". Today's resolution (`resolveCurrent`, the model of
  `DatabaseRoot.resolveMembership(email, slug)`, whose principal lookup `activeMemberPrincipal`
  carries all four of its filters: workspace, membership, `kind = 'membership'`, `revoked_at IS
NULL`): `current_role_is_read_from_the_membership`,
  `current_tenant_selection_requires_a_membership`, `resolved_principal_is_not_revoked`,
  `resolved_principal_is_a_membership_principal`, `a_revoked_principal_never_resolves` (the witness
  with `p1` revoked is consistent and no longer resolves) and
  `a_principal_of_another_kind_never_resolves`. The proposed resolution (`resolveTarget`, cited to
  the ADR, not to today's code): `role_is_read_from_the_membership`,
  `tenant_selection_requires_a_membership`, `identity_does_not_determine_permission` (one user,
  viewer in one workspace and owner in another).
- **T2 (Invariants).** Today: `every_composite_key_is_tenant_paired`,
  `composite_reference_stays_in_workspace` (any state), `no_cross_workspace_reference`,
  `reference_chain_stays_in_workspace`, `reachable_state_satisfies_constraints` (generic),
  `empty_database_is_consistent`, `reachable_state_has_no_cross_workspace_reference`,
  `cross_workspace_write_is_rolled_back`, `tenant_row_has_exactly_one_workspace`,
  `owner_reference_names_exactly_one_principal`, `owner_is_mandatory_except_for_audit_actors`,
  `owned_row_has_exactly_one_owner`, `shared_checks_agree`, and
  `every_cluster_check_is_enforced` (one state per cluster that satisfies every constraint of the
  bare catalogue yet breaks exactly one check only that cluster refines, so whole-schema
  consistency refuses it). Target: `target_has_no_cross_workspace_reference`,
  `target_share_subject_stays_in_workspace`, `target_grant_names_one_principal_of_its_workspace`,
  and the same three over `Reachable Target.consistent` (`target_reachable_state_has_no_cross_workspace_reference`,
  `target_reachable_share_subject_stays_in_workspace`, `target_reachable_grant_names_one_principal`),
  with `target_empty_database_is_consistent` and `target_witness_is_reachable`.
- **T4 (Refinement).** Nothing of tenancy lost: `tenancy_classes_are_unchanged`,
  `every_tenancy_constraint_is_kept` (same class), `every_key_has_an_image`,
  `added_keys_are_tenancy_constraints`, `target_keeps_the_tenancy_rules` (pairing complete and every
  `*_id` declared, both schemas), `refinement_keeps_every_row_in_its_workspace`,
  `refinement_keeps_row_ids`. Schema divergence cells: `keys_diverge_exactly_at` (6),
  `keys_added_exactly_at` (9), `columns_diverge_exactly_at`, `checks_diverge_exactly_at`,
  `table_names_diverge_exactly_at` (3), `set_null_diverges_exactly_at` (2 today, 0 target),
  `value_gate_diverges_exactly_at` (1 today, 0 target), `owner_columns_diverge_exactly_at`
  (`shares`). State divergence cells: `refinement_holds_on_the_witness`,
  `every_divergence_cell_is_exact`, and one `diverges_at_…` per cell (12), plus
  `deleting_a_default_agent_diverges`. Checks only the target has: `target_refuses_two_subjects`
  and `target_refuses_a_subject_in_another_column` (target states whose only fault is
  `shares_subject_matches_type`); `ledger_providers_are_the_run_providers` (the ledger's closed set
  is exactly today's `runs_provider_valid` list, on the same column) and
  `every_run_provider_is_a_valid_ledger_provider`. Identity: `target_identity_survives_an_email_change`,
  `current_identity_breaks_on_an_email_change`, `resolution_by_id_refines_resolution_by_email`,
  `role_claim_carries_no_information`.
- **T5 (Meta).** `glossary_names_are_unique`, `every_alias_names_one_term`,
  `every_conflation_is_resolved`, `every_table_is_home_to_one_term`,
  `identity_permission_and_tenant_selection_are_distinct`.

**Witnesses.** `Er.Current.Witness.state` is consistent under all five views (`decide +kernel`),
is reachable (loading it in one transaction commits), and its image is target-consistent. Every
hypothesis-bearing theorem has an `example`: the composite and chain references of the witness
agent, the reachable witness, a forged transaction that is rolled back (an agent of `w2` naming
`w1`'s model connection through the single-column sibling, the only way a cross-workspace reference
can even be written, since a composite key includes the workspace), the audit event's nullable
actor, the target grant and share subject, the key images, and the resolution of the witness's
two users.

**Mutation coverage.**

- _Drop a tenancy check._ Removing `workspace_id` from any composite key of `catalogue` breaks
  `every_composite_key_is_tenant_paired` (and the Vitest recomputation of pairing); removing it from
  a target key breaks `every_tenancy_constraint_is_kept`, `target_tables_are_well_formed` and
  `target_keeps_the_tenancy_rules`.
- _Loosen a target key or add an unpaired one._ `added_keys_are_tenancy_constraints` and
  `keys_added_exactly_at` fail.
- _Change `fkImage` or the target schema by one cell._ One of the exact divergence lists fails
  (`keys_diverge_exactly_at`, `keys_added_exactly_at`, `columns_diverge_exactly_at`,
  `checks_diverge_exactly_at`), and the Vitest `divergence.json` replay fails when today's schema
  changes instead.
- _Let `mapRow` touch `workspace_id` or `id`._ `refinement_keeps_every_row_in_its_workspace` and
  `refinement_keeps_row_ids` no longer prove.
- _Drop a target check or invariant._ The matching `diverges_at_…` theorem fails (its state becomes
  target-consistent), as does `every_divergence_cell_is_exact`. `shares_subject_matches_type`,
  which no `diverges_at_…` state reaches (the subject keys refuse a wrongly typed subject first),
  is pinned by `target_refuses_two_subjects` and `target_refuses_a_subject_in_another_column`;
  replacing its meaning by `true` was run and both fail.
- _Tighten or loosen the ledger's provider set._ `ledger_providers_are_the_run_providers` and
  `every_run_provider_is_a_valid_ledger_provider` fail (removing `openai` was run); Vitest compares
  both lists with `MODEL_PROVIDERS`.
- _Drop a filter of the session's principal lookup._ Without `revoked_at IS NULL`,
  `resolved_principal_is_not_revoked` and `a_revoked_principal_never_resolves` fail (run); without
  the kind filter, `resolved_principal_is_a_membership_principal` and
  `a_principal_of_another_kind_never_resolves` fail.
- _Drop a cluster from whole-schema consistency._ `every_cluster_check_is_enforced` fails
  (dropping `Publication.consistent` was run).
- _Weaken `commit` (commit without the check)._ `cross_workspace_write_is_rolled_back` and
  `reachable_state_satisfies_constraints` no longer prove.
- _Make the owner key nullable or drop it._ `owner_reference_names_exactly_one_principal` /
  `owner_is_mandatory_except_for_audit_actors` fail, and `owners.json` fails in Vitest.
- _Add an alias to two terms, or a table to two terms._ `every_alias_names_one_term` or
  `every_table_is_home_to_one_term` fails.
- _Edit the diagram by hand._ The concept-page replay fails.

## Glossary notes

The full glossary is [`docs/formal/concepts.md`](../concepts.md#glossary). This unit adds, beyond
the cluster glossaries:

- **owner** (the principal) vs **role** `owner` (a role value): a conflation of one word, now two
  terms. **creator** (legacy display attribution) is neither.
- **identity**, **permission** and **tenant selection** are three terms, and the target keeps them
  apart in the sign-in token (subject by user id, no role claim).
- **subject** is a typed reference in the target; today it is untyped text.

## Findings

All are proposals: the programme changes no product code. The ten conceptual cleanups each have an
ADR draft (status proposed; they need Owner ratification). None is a new security finding: the one
reference the database does not pair (`shares.subject_id`) is publication finding 6, where no data
crosses a tenant today because the label and snapshot are client-authored.

| #    | Severity      | Summary                                                                                                                                                                                                                                                                                                                                                                                 | Lean (Current / Target)                                                                                                                                                       | Proposed resolution                                                                                                 |
| ---- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| S-1  | correctness   | Grants are keyed by user id although "_Authorisation always compares principals, never user ids_" (`workspaces-and-principals.mdx`); catalog finding 6.                                                                                                                                                                                                                                 | `diverges_at_a_grant_without_principal`; `target_grant_names_one_principal_of_its_workspace`                                                                                  | ADR [FORMAL-P1-grants-name-principals](../../adr/FORMAL-P1-grants-name-principals.md)                               |
| S-2  | correctness   | RF-101's "one principal per Membership and per APIKey" is unenforced (identity finding 3).                                                                                                                                                                                                                                                                                              | `diverges_at_a_source_without_principal`                                                                                                                                      | ADR [FORMAL-P1-every-source-has-a-principal](../../adr/FORMAL-P1-every-source-has-a-principal.md)                   |
| S-3  | naming        | Connector / MCP server / `mcpServerIds` name one concept (catalog finding 9).                                                                                                                                                                                                                                                                                                           | `table_names_diverge_exactly_at`                                                                                                                                              | ADR [FORMAL-P1-connector-is-the-only-name](../../adr/FORMAL-P1-connector-is-the-only-name.md)                       |
| S-4  | documentation | 04 §2 "_every row that can be own or other (…, shares) carries `ownerPrincipalId`_"; `shares` says `publisher_principal_id` and the wire carries neither; `invitations.invited_by` is the one creator column with no principal (publication finding 2, identity finding 8).                                                                                                             | `owner_columns_diverge_exactly_at`                                                                                                                                            | ADR [FORMAL-P1-one-owner-vocabulary](../../adr/FORMAL-P1-one-owner-vocabulary.md)                                   |
| S-5  | correctness   | `shares.subject_id` is the only unpaired reference between tenant-carrying rows: a missing, wrongly typed or cross-workspace subject is a consistent state (publication finding 6).                                                                                                                                                                                                     | `diverges_at_a_dangling_subject`, `diverges_at_a_cross_workspace_subject`, `diverges_at_a_wrongly_typed_subject`; `target_share_subject_stays_in_workspace`                   | ADR [FORMAL-P1-share-subject-is-a-typed-reference](../../adr/FORMAL-P1-share-subject-is-a-typed-reference.md)       |
| S-6  | correctness   | Two composite `SET NULL` keys cannot execute; deleting a default agent fails with `23502` (er-core finding 1).                                                                                                                                                                                                                                                                          | `set_null_diverges_exactly_at`, `deleting_a_default_agent_diverges`                                                                                                           | ADR [FORMAL-P1-set-null-keys-use-the-sibling-pattern](../../adr/FORMAL-P1-set-null-keys-use-the-sibling-pattern.md) |
| S-7  | naming        | The principal kind is stored `api_key`, spelled `api-key` on the wire, and escapes the DDL value gate (er-core finding 5).                                                                                                                                                                                                                                                              | `value_gate_diverges_exactly_at`                                                                                                                                              | ADR [FORMAL-P1-principal-kind-has-one-spelling](../../adr/FORMAL-P1-principal-kind-has-one-spelling.md)             |
| S-8  | correctness   | A secret's purpose is only a naming convention: a profile can name a plain secret as its runtime connection, and a model connection's credential has no key (configuration findings 3, 5, 8).                                                                                                                                                                                           | `diverges_at_an_untyped_runtime_connection`                                                                                                                                   | ADR [FORMAL-P1-secret-purpose-is-typed](../../adr/FORMAL-P1-secret-purpose-is-typed.md)                             |
| S-9  | correctness   | Six documented row invariants are not enforced by the database (configuration 7; work F-2, F-3, F-4; publication 5).                                                                                                                                                                                                                                                                    | the six `diverges_at_…` theorems of the table in the ADR                                                                                                                      | ADR [FORMAL-P1-documented-row-invariants-are-checks](../../adr/FORMAL-P1-documented-row-invariants-are-checks.md)   |
| S-10 | correctness   | Identity is keyed by email, the sign-in token carries a constant role claim, and "principal" and "session" each name two things (identity findings 4, 9, 10; work F-6).                                                                                                                                                                                                                 | `current_identity_breaks_on_an_email_change`, `role_claim_carries_no_information`; `target_identity_survives_an_email_change`, `resolution_by_id_refines_resolution_by_email` | ADR [FORMAL-P1-identity-permission-tenant-selection](../../adr/FORMAL-P1-identity-permission-tenant-selection.md)   |
| S-11 | documentation | `docs/sdk/07-structure-map.md` §3 draws `users \|\|--o{ invitations : "invited_by"` (exactly one inviter), but `invitations.invited_by` is nullable with `ON DELETE SET NULL`: the edge is `\|o--o{`. The same diagram draws `workspaces }o--o\| model_connections`, while the tenant-paired key allows at most one workspace per connection (`model_connections \|o--o\| workspaces`). | `Target.cardinality catalogue` (the same function that draws the target diagram)                                                                                              | Docs fix: correct both edges, or regenerate §3 from the model as `concepts.md` does.                                |
| S-12 | naming        | "owner" is both a role value and the owning principal; "creator", "publisher", "minter" and "actor" are further owner-like words.                                                                                                                                                                                                                                                       | `Meta.ErSynthesis.every_conflation_is_resolved`                                                                                                                               | Docs fix, done in `concepts.md`: **owner** (principal), **role** `owner`, **creator**, **minter**, **label**.       |

## Gaps

- **Not replayed against a database.** The state-level results (the witness, the twelve divergence
  states, the delete) are proved in Lean; the suite replays the schema facts they rest on (every key,
  owner column, check and divergence cell) against the live Drizzle objects, not rows against
  PostgreSQL. A `heavy-checks` suite could insert the divergence states and assert which constraint
  PostgreSQL names.
- **Session resolution is a model.** `Target.Resolution` models `resolveMembership(email, slug)`
  (all four filters of its principal lookup) and the session-claim verification; the first reads
  the database through Drizzle and the second is not a pure exported function, so no vector
  replays them (the identity unit records the same gap).
- **`deleteRow` is one level deep**, and `ON DELETE SET NULL (column list)` (migration 0020's
  `audit_events_actor_principal_workspace_fk`, work finding F-5) is not expressible in `Er.Core`,
  whose catalogue records that key as `NO ACTION` from the snapshot. `unsoundSetNull` is therefore
  computed on the snapshot's actions.
- **The refinement is proved schema-wide and row-wise, and on witnesses state-wide.** There is no
  general theorem that every today-consistent state satisfying the target's preconditions maps to
  a target-consistent state; `refinement_holds_on_the_witness` and the divergence cells bound it
  from both sides on concrete states. Target invariants are stated both for consistent and for
  reachable target states.
- **Not registered.** `formal/AgentWorkspace.lean` and `formal/Vectors/Main.lean` must import and
  list this family (`er-synthesis`, `Vectors.ErSynthesis.files`), and `docs/adr/README.md`'s
  generated index must be regenerated (`sh docs/adr/regenerate-index.sh`) for the ten new ADR drafts;
  all three files belong to the integration step.
- **Build time.** `Theorems/Refinement/ErSynthesis.lean` takes about two minutes, mostly the
  `decide +kernel` consistency checks of the 39-table states; `Theorems/Invariants/ErSynthesis.lean`
  about as long.
