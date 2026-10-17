# Unit `er-core` — the shared ER foundation (phase P1a)

The layer every concept cluster imports: typed identifiers, the 39-table catalogue as data, rows
and states, the database constraints as decidable predicates, the tenancy classification of every
foreign key, and the isolation lemmas that turn "tenant-paired" into "cannot cross a workspace".

| File                                                                                            | What it holds                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `formal/AgentWorkspace/Prelude/Ids.lean`                                                        | `IdKind`, `Id (k : IdKind)`, the `…Id` aliases, composite keys, `Uuid.isCanonical`                                              |
| `formal/AgentWorkspace/Er/Core.lean`                                                            | `TableName` (a `WireEnum`), `TableSpec`, `catalogue`, `Row`, `State`, the constraint predicates, `classify`, `renderValueList?` |
| `formal/AgentWorkspace/Theorems/{WellFormed,Normative,Invariants,Adversarial,Meta}/ErCore.lean` | the theorems, by tier                                                                                                           |
| `formal/Vectors/ErCore.lean` → `formal/generated/vectors/er-core/`                              | `tables.json`, `catalogue.json`, `one-of.json`, `references.json`, `uuid.json`                                                  |
| `tests/formal/er-core.test.ts`                                                                  | replays the vectors against the live Drizzle objects, the 0025 snapshot, `renderValueList` and `isUuid`                         |

## Modelling decisions

- **Identifiers: one phantom-kinded structure.** `Id (k : IdKind)` wraps the UUID string. One
  derivation gives `DecidableEq`, `Repr`, `Hashable` and `Ord` for every kind, and ids of different
  kinds have different types. `IdKind` has one constructor per table whose primary key is `id`
  (27 of them). `connector` is `mcp_servers` and `principal` is `workspace_principals`. The six
  tables keyed otherwise get key structures: `RunEventKey`, `SessionTranscriptKey`,
  `SessionMessageKey`, `ProjectFileKey` and `ProjectConnectorKey`, and `share_run_charges` is keyed
  by a `RunId`. `TableName.idKind?` maps tables to kinds, and T0 proves that map is a bijection
  onto the `id`-keyed tables.
- **The catalogue is data, transcribed mechanically.** A generator read the drizzle-kit snapshot
  `migrations/meta/0025_snapshot.json` (the latest journal entry) and the schema sources
  (for the exported table names and whether each FK is declared inline). The suite compares the
  result, in both directions, with the live Drizzle table objects (through Drizzle's own
  `getTableConfig`) and with the snapshot.
- **Rows are untyped.** A `Row` maps column names to text, and a missing column means `NULL`. FK,
  unique and not-null semantics only look at equality, so clusters can map their typed concept
  rows onto `Row` and reuse the lemmas. `fkHolds` is PostgreSQL `MATCH SIMPLE`. `keyHolds` treats
  `NULL`s as distinct and filters partial indexes by their `WHERE … IS NULL`. `checkHolds` covers
  the 23 closed-set checks and, through `otherCheckHolds`, the tenant-isolation check
  `workspace_principals_source_xor` (`principalSourceXor`, with SQL's three-valued reading of a
  `NULL` kind). The other 67 checks are recorded by name so that clusters can refine them.
- **The tenancy rule and `tenancy.test.ts` differ in two stated ways.** `tenancyWellFormed`
  follows rule 1 (a `NOT NULL` `workspace_id` with exactly one single-column reference to
  `workspaces.id`, and no `workspace_id` on an exempt table). It is stricter in requiring the
  column to be `uuid` and the root to be keyed by `id`. It is weaker in not requiring
  `workspace_id` to lead an index, because non-unique indexes are not modelled. The
  `ON DELETE CASCADE` of root references is a separate T0 fact (`every_root_reference_cascades`),
  not part of the rule.
- **Schema edits.** `Schema.update`, `TableSpec.mapColumn` and `TableSpec.mapForeignKey` build a
  schema from `catalogue` by editing one table. The negative T0 theorems use them, and a Target
  model can too.
- **Tenancy.** `root` is `workspaces`, where the row's own `id` is its tenant. `global` is `users`
  and `user_identities`. `scoped` is the other 30 tables. `classify` mirrors the buckets in
  `tenancy.test.ts`: `root-reference`, `global-reference`, `tenant-paired`, `sibling-paired` and
  `unpaired`. The `workspaces` self-pairing on `id` is the same rule applied to the root, not a
  special case.
- **Rule 3 of `tenancy.test.ts` is modelled.** `isIdColumn` is the `_id` suffix,
  `nonReferenceIdColumns` mirrors `NON_REFERENCE_ID_COLUMNS` (with the pinned SQL types), and
  `idColumnsCovered` requires every `*_id` column to be covered by a foreign key or declared, never
  both, with every declaration naming an existing column. `pairingComplete` alone can be satisfied
  by deleting a key; a target schema should require both predicates. `classify` also applies the
  rule that a reference to a global table must not include `workspace_id` (it is `unpaired`).
- **Closed unions have codecs.** `IdKind`, `OnDelete`, `Tenancy`, `UniqueKind`, `FkClass` and
  `TableName` are `WireEnum`s. `SqlType` has a parameterised `numeric(p, s)`, so it is not
  finite: it gets `ToJson`/`FromJson` through its SQL spelling (`SqlType.toSql` / `SqlType.ofSql?`).
- **Everything is stated for any `Schema`**, so `Er/Target.lean` can reuse every predicate and
  lemma unchanged.

## Theorems (484 catalogue entries: 422 T0, 13 T1, 11 T2, 6 T3, 8 T5, 24 traced definitions)

- **T0 (WellFormed).** The `aw_er_catalogue_theorems` command elaborator generates
  `table_<name>_is_well_formed` for each of the 39 tables and `<constraint>_is_<class>` for each
  of the 107 foreign keys, so a catalogue edit adds or breaks a theorem by name. The
  foreign-key theorems cite the `tenancy.test.ts` code of their class: `TENANT_COLUMN` (the
  column rule 1 requires the single root reference to be) for root references, `TENANT_EXEMPT` for global references,
  `tenantPairingFault` for paired keys and `referenceIdentityOf` for sibling keys.
  A second elaborator, `aw_er_snapshot_theorems`, reads `migrations/meta/0039_snapshot.json`
  while the file elaborates and generates 257 more theorems whose right-hand sides come from the
  snapshot, not from `catalogue`: `table_<name>_matches_snapshot` (all columns with type and
  `NOT NULL`, the primary key, and the numbers of foreign keys, unique keys and checks) for the 39
  tables; `<fk>_matches_snapshot` (columns, target, target columns, `ON DELETE`) for the 93
  foreign keys; `<unique>_matches_snapshot` (columns, kind, partial filter) for the 41 unique
  keys; and `<check>_matches_snapshot` for the 91 checks. For the 23 closed-set checks, that
  theorem pins the column and the exact value list. For the other 68, it pins that the check is
  recorded as not a closed set.
  _Negative well-formedness._ The positive theorems only assert `= true`, so they cannot notice a
  loosened predicate. Ten negative theorems each edit one cell of `catalogue` (the `Mutant`
  namespace) so that exactly one conjunct fails, and state that the edited table is ill formed:
  `fk_type_mismatch_is_ill_formed` (a `text` child against a `uuid` parent),
  `fk_to_a_non_key_is_ill_formed`, `inline_composite_fk_is_ill_formed`,
  `fk_arity_and_repetition_are_ill_formed`, `nullable_or_empty_primary_key_is_ill_formed`,
  `duplicate_names_are_ill_formed` (column, constraint, and wrong table),
  `malformed_unique_keys_are_ill_formed`, `malformed_closed_set_checks_are_ill_formed`,
  `scoped_tenancy_faults_are_refused` (nullable or non-`uuid` `workspace_id`, no root reference,
  two root references) and `exempt_tenancy_faults_are_refused`. Three boundary theorems pin
  branches the positive theorems cannot see: `composite_root_reference_is_unpaired` (a composite
  key to `workspaces` is `unpaired`, not a root reference), `declared_reference_column_is_refused`
  (rule 3's "never both": declaring an FK-covered column fails the gate) and
  `safe_value_boundaries` (`a-`, `a--b`, `1a`, `-a`, `a_b` and the empty string are refused).
  _Wire spellings._ `fk_class_wires`, `tenancy_wires`, `on_delete_wires` and `unique_kind_wires`
  pin the vector spelling of each closed union. The last two cite the snapshot keys that carry
  the spellings (`onDelete`, `uniqueConstraints`, `isUnique`).
  _Other catalogue facts._ Table-name codec and order, `catalogue_pairing_is_complete`, globally
  unique constraint names, constraint counts, the id-kind bijection, closed-set checks sitting on
  `text` columns, `scoped_tables_reference_the_root_once` (cited to `TENANT_COLUMN`),
  `every_root_reference_cascades` (cited to the snapshot's `onDelete`, since `tenancy.test.ts`
  does not check it), the
  `renderValueList` acceptance criterion, the `MAX_VALUE_LENGTH` boundary pair
  (`slug_of_64_characters_is_safe` / `slug_of_65_characters_is_refused`),
  `global_reference_with_workspace_column_is_unpaired` (the bucket-2 branch, cited to
  `isTenantScoped`), rule 3 (`every_id_column_is_a_reference_or_declared`,
  `uncovered_id_columns`), and the UUID alphabet: `canonical_uuid_is_hex_and_hyphens` states
  that every character is in the literal alphabet `0-9a-fA-F-`, independent of `Uuid.isHexDigit`,
  and `uuid_with_a_non_hex_digit_is_refused` gives the refusals.
- **T1 (Normative).** The tenant root and exemptions. `workspace_id` present exactly on scoped
  tables. `REQUIRED_REFERENCES` (`sessions_member_workspace_fk`). Principal sources are
  tenant-paired, and `principal_has_the_source_its_kind_names` gives
  `workspace_principals_source_xor` its accepted and refused rows. Owner and owner-equivalent
  columns are paired, with their nullability. `agent_grants` stores the membership's `user_id`.
  `closed_set_check_admits_only_its_values` gives a closed-set check (`oneOf`'s
  `CHECK (col IN (…))`) its accepted, refused and `NULL` rows. The 15 composite unique targets. The single partial
  unique key, and `pending_invitations_are_unique_per_address`: two pending invitations to one
  address in one workspace violate it, while an accepted or revoked one, or one in another
  workspace, does not. Runs have no `agent_id`.
- **T2 (Invariants).** These are generic over the schema. `paired_reference_preserves_tenant`
  holds in any state. `sibling_reference_preserves_tenant` holds in consistent states and uses
  the uniqueness of the parent key. `reference_preserves_tenant` covers every classified
  reference. `no_cross_tenant_reference` holds under `pairingComplete`. By induction over
  reference chains, `tenant_path_preserves_tenant` extends this to whole chains.
  `tenant_row_has_workspace` shows every scoped row has a workspace, and
  `null_key_row_preserves_fk` covers `MATCH SIMPLE`. `principal_has_exactly_one_source` shows
  that in every consistent state of today's schema a principal has exactly the source its kind
  names. `closed_set_value_is_in_its_set` states that in every consistent state a closed-set
  column holds `NULL` or one of its values. `scoped_workspace_id_is_the_tenant` and
  `root_id_is_the_tenant` tie the typed readers `Row.workspaceId?` and `Row.id?` to `tenantOf`.
  _Scope of T2 here._ Section 6.1 of the orchestrator prompt defines T2 as "preserved by every
  operation, by induction over operation sequences". This foundation has no operations: its T2
  theorems are properties of every _consistent_ state, which is the invariant each operation
  must preserve. The concept clusters add the operation step: an operation that maps a
  consistent state to a consistent state inherits every lemma here, so the cluster's obligation
  is `consistent S st → consistent S (op st)` for each of its operations.
- **T3 (Adversarial).** `forged_cross_tenant_reference_is_rejected`: whatever ids a writer copies
  into a row, a reference across workspaces makes the state inconsistent. The witness is a forged
  agent in workspace 2 that names workspace 1's connection: removing that one row restores
  consistency. `deleted_reference_is_caught` (generic): deleting every foreign key over an
  undeclared `*_id` column fails `idColumnsCovered`. Its witness,
  `deleting_a_reference_passes_pairing_but_not_the_gate`, deletes the two keys over
  `agents.model_connection_id`: `pairingComplete` stays true and the gate fails.
  `safe_value_has_only_slug_characters` states that an accepted value uses only the 37 literal
  characters `a-z0-9-` (an alphabet written out in the statement, not `isSafeValueChar`).
  `upper_case_value_is_refused` states that an upper-case letter anywhere is refused, and
  `quoted_value_is_refused` does the same for a quote. Together they cover the DDL inlining gate.
- **T5 (Meta).** Eight theorems pin findings 1 to 6 below: `unexecutable_set_null_keys`,
  `project_default_agent_set_null_violates_not_null` (it reads the key's columns and the
  `workspace_id` column from `catalogue`), `timestamps_are_not_on_every_table`,
  `single_column_references_are_global_or_siblings`, `only_principal_kind_escapes_the_value_gate`,
  `three_tables_carry_no_workspace_id` and `primary_keys_other_than_id` (which refutes the
  `columns.ts` comment, so it is T5, not T1), and `drizzle_cycle_is_composite_in_one_direction_only`
  (finding 6; it replaces the former T1 `drizzle_cycle_is_tenant_paired_both_ways`).

**Witnesses.** A concrete consistent state has two workspaces, a user, a membership, a
principal, a connection and an agent. It exercises the root, global, paired and sibling
references, and every hypothesis-bearing theorem has an `example` built on it. The forged state
witnesses the T3 theorem.

**Mutation coverage.**

- _Catalogue edits._ Flipping any catalogue cell breaks a generated snapshot theorem by name,
  and the Vitest replay fails too. That covers a column's type or nullability, a closed-set value
  list, a foreign key's columns, target or `ON DELETE`, a unique key's columns or partial filter,
  and a primary key. Adding or removing a column or constraint does the same. Changing a key's
  tenancy class also fails its `<fk>_is_<class>` theorem.
- _Loosened well-formedness._ Dropping any conjunct of `tableWellFormed`, `fkWellFormed` or
  `tenancyWellFormed` (for example `primaryKey.all isNotNull`, or replacing the column type
  equality with `true`) makes one of the negative T0 theorems false.
- _Wire spellings._ Swapping two codes of `FkClass`, `Tenancy`, `OnDelete` or `UniqueKind`
  fails its `*_wires` theorem.
- _Value gate._ Widening `isSafeValueChar` (for example to `A`–`Z`) makes the statement of
  `safe_value_has_only_slug_characters` false, and the new `aB`, `a-B` and `abC1` vectors fail in
  Vitest. Loosening the length bound to 65 fails `slug_of_65_characters_is_refused`, and
  tightening it to 63 fails `slug_of_64_characters_is_safe`.
- _UUID alphabet._ Widening `Uuid.isHexDigit` (for example `a`–`g`) makes
  `canonical_uuid_is_hex_and_hyphens` and `uuid_with_a_non_hex_digit_is_refused` false.
- _Partial unique keys._ If `keyHolds` ignored the partial filter,
  `pending_invitations_are_unique_per_address` would be false, because it states that an accepted
  invitation coexists with a pending one.
- _Rule 3._ Deleting a foreign key over an undeclared `*_id` column fails
  `every_id_column_is_a_reference_or_declared`.
- _Tenancy check._ Dropping the tenancy check from `classify` breaks the per-FK class theorems
  and `catalogue_pairing_is_complete`.
- _Relaxed constraint semantics._ Letting `fkHolds` or `keyHolds` accept more breaks the T2
  proofs or the T3 forged-state example. Dropping `principalSourceXor` from `otherCheckHolds`
  fails `principal_has_the_source_its_kind_names`. Making the closed-set branch of `checkHolds`
  `true` fails `closed_set_check_admits_only_its_values` (and the proof of
  `closed_set_value_is_in_its_set`).
- _Phase-1 debt mutations, re-run in D1._ Each breaks a named theorem: `idColumnCovered`'s
  never-both branch set to `true` → `declared_reference_column_is_refused`; `workspaceId?` reading
  `id` → `scoped_workspace_id_is_the_tenant`; `id?` reading `workspace_id` →
  `root_id_is_the_tenant`; dropping `fk.columns.length == 1` from `classify` →
  `composite_root_reference_is_unpaired`; dropping the trailing-hyphen or the double-hyphen
  conjunct of `isSafeValue` → `safe_value_boundaries`.

## Glossary notes for the synthesis

- _Connector_ = the `mcp_servers` table (`IdKind.connector`).
- _Runtime connection_ = a `secrets` row (`runtime_profiles.runtime_connection_id → secrets`).
- The _tenant column_ of `workspaces` is `id`.
- A _sibling-paired_ key is a single-column `SET NULL` key whose isolation a composite sibling
  provides.
- The owner vocabulary spans `owner_principal_id`, `publisher_principal_id`,
  `minted_by_principal_id`, `actor_principal_id` and the legacy `created_by`, `user_id` and
  `invited_by`.

## Findings

| #   | Severity      | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Lean                                                                                                                                        | Proposed resolution                                                                                                                                                                                                                                       |
| --- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | correctness   | `projects_default_agent_workspace_fk` and `sessions_project_workspace_fk` are composite `ON DELETE SET NULL` keys that include the `NOT NULL` `workspace_id`. PostgreSQL nulls _every_ key column, so deleting an agent that is any project's default agent fails with `23502` (reproduced on PostgreSQL 17: `null value in column "workspace_id" … violates not-null constraint`). The same happens when deleting a project that has sessions. `AgentRepository.delete` (`packages/core/src/db/repositories/agents.ts`) does not clear `projects.default_agent_id` first, so `DELETE /api/agents/:id` surfaces a database error instead of clearing the default. `tenancy.test.ts`'s own `referenceIdentityOf` comment names the hazard ("a composite `SET NULL` would null `workspace_id` too"). | `Meta.ErCore.unexecutable_set_null_keys`, `project_default_agent_set_null_violates_not_null`; data: `setNullSound = false` in `tables.json` | ADR or issue. Use the sibling pattern `agents.model_connection_id` already uses (a single-column `SET NULL` plus a composite `NO ACTION`), or PostgreSQL 15+ `ON DELETE SET NULL (default_agent_id)`. Add a regression test that deletes a default agent. |
| 2   | documentation | `docs/sdk/07-structure-map.md` §3: "_`created_at` and `updated_at` are present on every table_". `project_files` and `project_mcp_servers` have neither, and 12 more tables have no `updated_at`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `Meta.ErCore.timestamps_are_not_on_every_table`                                                                                             | Docs fix: "`created_at` is present on every table except the two project join tables; `updated_at` only on mutable rows".                                                                                                                                 |
| 3   | documentation | Same section: "_every cross-table foreign key is composite on `(id, workspace_id)`_". The 7 references to `users` (`audit_events.actor_user_id`, `invitations.invited_by`, `memberships.user_id`, `projects.created_by`, `sessions.user_id`, `shares.created_by`, `user_identities.user_id`) and the 6 `SET NULL` siblings are single-column. The principal and membership keys are ordered `(workspace_id, x)`. `shares.subject_id` is polymorphic with no FK, and the sharing service checks its tenant, not the database.                                                                                                                                                                                                                                                                       | `Meta.ErCore.single_column_references_are_global_or_siblings`, `Normative.ErCore.composite_unique_targets`                                  | Docs fix: "every reference between two tenant-scoped tables is tenant-paired, by itself or by a sibling constraint; references to `users` are global; `shares.subject_id` is checked by the service".                                                     |
| 4   | documentation | Code comments: the `workspaces.ts` header says it is "_one of exactly two tables in the schema that carry no `workspace_id`_", and `users.ts` says it is "_the second and last of the two tables exempt_". `TENANT_EXEMPT` has three, including `user_identities`. Also, `columns.ts` says "_Every table's primary key is a database-generated UUID_", but six tables are keyed otherwise.                                                                                                                                                                                                                                                                                                                                                                                                         | `Meta.ErCore.three_tables_carry_no_workspace_id`, `Meta.ErCore.primary_keys_other_than_id`                                                  | Comment fixes in a docs PR, since they are product comments and this programme does not edit product files.                                                                                                                                               |
| 5   | naming        | `workspace_principals.kind` stores `api_key`, which fails `oneOf`'s `SAFE_VALUE`. That is why its CHECK is hand-written, while every other closed set, and the wire (`PRINCIPAL_KINDS`), uses kebab-case `api-key`. This is already documented in `packages/contracts/src/team.ts` and gated by `sdk-conformance.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `Meta.ErCore.only_principal_kind_escapes_the_value_gate`                                                                                    | Record only. A rename needs a data migration, so leave it for the Target ER.                                                                                                                                                                              |

| 6 | documentation | `docs/architecture.md` (Dependency rules): the `workspaces.ts` ↔ `model-connections.ts` cycle "_expresses the tenant-scoped composite foreign keys in both directions_". Only `workspaces → model_connections` is composite (`workspaces_default_model_connection_workspace_fk`, paired on `workspaces.id`, with a single-column `SET NULL` sibling). `model_connections → workspaces` is the single-column root reference `model_connections_workspace_id_workspaces_id_fk` (`packages/core/src/db/schema/model-connections.ts`). | `Meta.ErCore.drizzle_cycle_is_composite_in_one_direction_only` | Docs fix: "That cycle expresses the tenant root reference from `model_connections` and the composite tenant-paired default-connection key from `workspaces`". |
| 7 | naming | `Invariants.ErSynthesis` and `Normative.ConceptIdentity` (other units) still cite `tenancy.test.ts#rootReferences`, a local `const` inside the rule-1 test body, not a declaration. This unit now cites `TENANT_COLUMN`. | — | The owning units switch to `#TENANT_COLUMN`. |

No security finding: every reference between tenant-carrying tables is tenant-paired, and T2 proves
the isolation for every consistent state.

## Gaps

- 67 of the 68 checks that are not closed sets (shape regexes, timestamp ordering, `runs`
  `ended_at_iff_terminal` and similar) are named but have no semantics. The owning clusters
  refine them through `otherCheckHolds`. Only `workspace_principals_source_xor` is modelled here.
- `aw_er_snapshot_theorems` reads the snapshot while the module elaborates, and Lake does not
  track that file as an input. A changed snapshot can therefore leave a cached
  `AgentWorkspace.Theorems.WellFormed.ErCore` olean green. The proper fix is a lakefile change,
  such as an `extraDep` target on the snapshot file or a forced rebuild of the module in
  `formal:check`. `formal/lakefile.lean` is outside this unit's ownership, so the change is
  proposed, not made. The Vitest suite covers the gap meanwhile: it compares every table vector
  with the snapshot JSON on every run, and it checks that 0025 is still the latest journal entry.
- `nonReferenceIdColumns` is compared with the live schema (every uncovered `*_id` column and its
  `getSQLType()`), but not with the `NON_REFERENCE_ID_COLUMNS` literal itself, because that record
  is private to `tenancy.test.ts`.
- The Vitest check of foreign-key tenancy classes re-derives pairing in TypeScript (`pairsAt`)
  instead of calling `tenantPairingFault` and `referenceIdentityOf`. Those are module-private
  functions of the test file `tenancy.test.ts`: they cannot be imported without a product change
  (moving them into an exported, non-test module), and importing the test file itself would
  register its `describe` blocks in this suite. The class bucket of every key is still checked
  against the live Drizzle foreign keys; table shape, `renderValueList` and `isUuid` replay
  against the real code.
- Closed-set check semantics (`checkHolds` on `oneOf`) are proved in Lean but not replayed
  against PostgreSQL: no TypeScript function evaluates a `CHECK` on a row.
- Non-unique indexes are not modelled, so the tenant-index part of rule 1 (`workspace_id` leads an
  index) is not modelled either. See the tenancy-rule decision above.
- `ON DELETE` behaviour is recorded, but deletion itself (cascade propagation) is not modelled as
  a state transition. Finding 1 is shown statically and by a PostgreSQL probe, not by a vector
  replayed against a database.
- The T2 theorems quantify over consistent states, not over operation sequences (see _Scope of T2
  here_). The clusters own the operations.
- The suite compares against Drizzle objects through the declared test escape
  `@agent-workspace/core/db/unscoped`. It resolves `drizzle-orm/pg-core` from
  `@agent-workspace/core`'s own dependency with `createRequire`. CHECK bodies are compared only
  through the snapshot.

## Phase-1 debt (paid in D1)

Open problems of verifier run `wf_c504decc-c19`, and how each ended:

1. `checkHolds` closed-set branch unpinned: fixed by `closed_set_check_admits_only_its_values` (T1: accepting, refusing and `NULL` rows) and `closed_set_value_is_in_its_set` (T2).
2. `idColumnCovered` "never both" unpinned: fixed by `declared_reference_column_is_refused` (T0).
3. Dead `Row.workspaceId?` / `Row.id?`: fixed by `scoped_workspace_id_is_the_tenant` and `root_id_is_the_tenant` (T2), each stated against `tenantOf`.
4. Weak catches: fixed by `composite_root_reference_is_unpaired` (composite root key is `unpaired`, table and pairing fail) and `safe_value_boundaries` (`a-`, `a--b`, `1a` and more refused).
5. Loose T1 Drizzle-cycle citation: recorded as finding 6; the theorem moved to T5 as `drizzle_cycle_is_composite_in_one_direction_only`.
6. Loose anchors: `on_delete_wires` / `every_root_reference_cascades` now cite the snapshot's `onDelete`, `unique_kind_wires` its `uniqueConstraints` / `isUnique`, and root-reference theorems `TENANT_COLUMN`; other units' `rootReferences` cites are finding 7.
7. TS replay re-derives pairing: kept as a gap, because the real helpers are private to a test file (see Gaps).
