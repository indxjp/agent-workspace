# Unit `concept-catalog`: agents, skills, files, connectors, assignments and grants (phase P1b)

This unit formalises the catalog cluster: the four catalogued resources (agent, skill, file,
connector) and the tables that link them (the three agent assignment tables, the grant table and the
two project link tables). It is built on `Er/Core.lean` and `Prelude/Ids.lean` and adds nothing to
either.

| File                                                                                                               | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formal/AgentWorkspace/Concepts/File.lean`                                                                         | `FileKind`, the typed `files` row, the path grammar (`pathShape`, `noDotSegments`), the row checks, `underPrefix` / `renameByPrefix` / `deleteByPrefix`, `putFile`, `renameFile` (with its `missing` and unique-key `conflict` outcomes), `deleteFile`, the wire field list                                                                                                                                                                                                                                                   |
| `formal/AgentWorkspace/Concepts/Skill.lean`                                                                        | the `skills` row, `nameShape` (`SKILL_NAME_PATTERN`), `putSkill`, `deleteSkill`, the wire field list                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `formal/AgentWorkspace/Concepts/Connector.lean`                                                                    | `Kind`, `Transport`, `AuthType`, the MCP `mcp_servers` row and its seven checks, the tool connector row (`ToolConnector`, ADR-0113 C15) and its validity, the `ConnectorResource` projection, `parseBody`, an exact model of `parseCreateConnectorBody` including its error messages, and `admit`, the kind admission in front of it (`connectorKindOfBody`, ADR-0113 C15)                                                                                                                                                    |
| `formal/AgentWorkspace/Concepts/Agent.lean`                                                                        | `Permissions`, the `agents` row, `StateCurrent` (one state) and `StateTarget` (adds `archived`), the wire and mutable field lists, and the HTTP field parsers `parseName` / `parseInstructions` / `parseModel` (JavaScript `trim()`, UTF-16 length)                                                                                                                                                                                                                                                                           |
| `formal/AgentWorkspace/Concepts/Grant.lean`                                                                        | `FileAccess` and `narrow`; the assignment, grant and project link rows; `replace` (`AgentResourceRepository.replace`, answering the read-back `readBack`, sorted by id) and `effective` (its read side); `assignmentsBody` (`AgentResourceAssignmentsSchema`); `grantsRead` / `grantsReplace` / `hasGrant`; `runOwnership` (`resolveAgentRunOwnership`); `grantsBody` (`AgentGrantsSchema`)                                                                                                                                   |
| `formal/AgentWorkspace/Er/Current/Catalog.lean`                                                                    | the twelve tables, the semantics of their 22 non-closed-set checks (`clusterCheckHolds`) and the snapshot SQL they are the semantics of (`checkSql`), `consistent` (the core constraints plus these checks), the row encodings of the typed concepts, and `Sample.state` (a row in every table and a reference through each of the 41 foreign keys)                                                                                                                                                                           |
| `formal/AgentWorkspace/Theorems/{WellFormed,Normative,Invariants,Adversarial,Refinement,Meta}/ConceptCatalog.lean` | the theorems, by tier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `formal/Vectors/ConceptCatalog.lean` → `formal/generated/vectors/concept-catalog/`                                 | `tables.json` (22), `enums.json` (13), `skill-names.json` (148), `file-paths.json` (153), `grants-body.json` (14), `constants.json` (5), `connector-bodies.json` (312), `replace.json` (66), `assignments-body.json` (13), `agent-fields.json` (51), `run-ownership.json` (36)                                                                                                                                                                                                                                                |
| `tests/formal/concept-catalog.test.ts`                                                                             | replays the tables against the live Drizzle objects and the 0025 snapshot, the enumerations against the schema and contract constants and `AgentResourceAssignmentsSchema`, the wire field lists against the Zod schemas, skill names against `SKILL_NAME_PATTERN` and the `skills_name_shape` regex, paths against the snapshot's two path regexes, grant bodies against `AgentGrantsSchema`, assignment bodies against `AgentResourceAssignmentsSchema`, and the `replace` outcomes' shapes, kinds and id order (437 tests) |
| `apps/web/formal/concept-catalog.test.ts`                                                                          | replays the connector bodies against the real `connectorKindOfBody` then `parseCreateConnectorBody` (admitted kind and parsed value, or error list and order), the agent fields against the `name` / `instructions` / `model` fields of `UpdateAgentPatchSchema`, and the run-ownership cases against `resolveAgentRunOwnership` through the real runtime registry (413 tests)                                                                                                                                                         |

## Modelling decisions

- **One typed row per concept, and the ER row beside it.** Each concept is a Lean structure with
  typed ids (`FileId`, `PrincipalId`, …) and closed unions for its enumerations. The same data as
  an `Er.Core.Row` is `agentRow` / `connectorRow` / `toolConnectorRow` / `fileRow` / `skillRow`
  (a file's `bigint` size is rendered as its decimal text, `-` first when negative). The T4 theorems show that a
  concept's invariant _is_ its table's checks evaluated on that row, so a theorem about a valid
  `Connector` is a theorem about every `mcp_servers` row PostgreSQL accepts.
- **The cluster refines `Er.Core.otherCheckHolds` without editing it.**
  `Catalog.consistent st = Er.Core.consistent catalogue st && clusterChecksHold st`. The 22
  modelled checks are listed with their exact snapshot SQL (`checkSql`), and the suite fails when
  a body changes. `every_cluster_check_is_modelled` shows no check of the twelve tables is left
  unmodelled. The checks use SQL's three-valued reading: a `NULL` guard passes.
- **`[:cntrl:]`** is modelled as C0, `DEL` and C1 (`U+0000`–`U+001F`, `U+007F`–`U+009F`), which is
  what PostgreSQL's class covers in a UTF-8 database under glibc. The vectors use only those
  characters, not other Unicode controls, because locale-dependent classes are a gap (see
  **Gaps**).
- **`parseCreateConnectorBody` is modelled exactly.** The model covers the order of its errors,
  JavaScript `trim()` whitespace, `/^.{1,200}$/u` (code points, no line terminators) and
  `JSON.stringify` quoting. It is factored into `nameErrors`, `transportOf`, `authFieldOf`,
  `shapeOf` and `credentialOf`, so the relation to the checks is provable. It sits in the concept
  module because it is where the connector's shape invariants are established. The Phase-3
  behaviour unit can import it.
- **Subtree moves rewrite the object key too.** `File.renameByPrefix` mirrors the one `UPDATE` of
  `renameFilesByPrefix`: under the prefix, `path` becomes `newPrefix || substr(path, …)` and a
  file's `storage_key` is cut by the same length (`cutAndPrefix`), whatever it holds.
- **`replace` answers the read-back.** `AgentResourceRepository.replace` returns `read(agentId)`,
  which orders files by `file_id`, skills by `skill_id` and connectors by `mcp_server_id`
  (`orderBy(asc(...))`). The model answers `readBack` (an insertion sort by id, `sortByKey`), so
  the T2 theorems state membership and permutation, not request order, plus the id order itself
  (`replace_answers_in_id_order`). The vectors use canonical lower-case UUIDs, whose text order is
  PostgreSQL's `uuid` order.
- **The HTTP field parsers are modelled exactly.** `Agent.parseName` / `parseInstructions` /
  `parseModel` mirror `apps/web/server/agents/contract.ts`: JavaScript `trim()` whitespace (reusing
  `Connector.isJsWhitespace`), `.length` in UTF-16 code units, and the error messages. Long vector
  strings are run-length encoded (`{ runs: [[text, count], …] }`) so a 100 000-unit bound stays a
  small file.
- **Run ownership is modelled from the resolver.** `Grant.runOwnership` mirrors
  `resolveAgentRunOwnership` (`unknown` / `own` / `permitted` / `other`), including the
  unconfigured runtime, an unwired grants store and a caller with no user.
- **Grants are modelled at the level the repository sees them.** `PrincipalView` (id, the user
  behind a membership principal, revoked) is a _view_ of `workspace_principals ⋈ memberships`, not
  a second definition of a principal. That definition belongs to the identity cluster.
- **Lifecycle.** An agent has one state today and the target adds `archived` (RF-201):
  `StateCurrent` / `StateTarget` with the embedding theorem. Skills, files, connectors, assignments
  and grants have no lifecycle states (a row exists or not; `skills.enabled` and
  `mcp_servers.enabled` are flags, and no route flips the connector's flag today).
- **Generated per-key theorems.** Three command elaborators generate one theorem per foreign key,
  unique key and forgeable id reference, with a witness `example` each on `Sample.state`:
  `aw_catalog_key_theorems` (T2) and `aw_catalog_forgery_theorems` (T3). A key added to the
  catalogue adds a theorem by name.
- **Equation lemmas** of the recursive definitions (`splitSlash`, `dedup`, `firstRepeat.go`,
  `List.lookup`) are generated in the defining modules (private triggers), so they never surface
  as undocumented public theorems in a `Theorems` module.

## Theorems (320 catalogue entries: 23 T0, 35 T1, 127 T2, 23 T3, 7 T4, 10 T5, 95 traced definitions)

- **T0 (WellFormed).** The wire spellings of the four enumerations and their JSON round trip.
  Near misses are refused. Each concept enumeration is exactly its table's closed set
  (`files_kind_check_is_the_kinds`, …), and the remote and credentialed subsets are what the two
  `renderValueList` calls inline. Each concept maps every column of its table, in order (agents,
  files, skills, `mcp_servers` and the six link tables). Every check of the cluster is modelled,
  and all 41 references target an exact key. The constraints are jointly satisfiable
  (`cluster_constraints_are_satisfiable`, by kernel evaluation of `Sample.state`), and the sample
  exercises every reference.
- **T1 (Normative).** 04 §5.8 connector sentences: the credential iff `authType ≠ none`, a URL
  only and always for remote transports and absolute `http(s)`, `args` only with `stdio`, exactly
  one of command and URL, "`hasCredential` says whether one is on file" (two rows that differ only
  in which secret they reference render the same resource), no `credential*` wire field,
  "`authType` defaults to `none`" (also for `null`), and the refusals of a missing or superfluous
  credential and of the other transport's fields, with their exact messages. ADR-0113 SD1 kind
  admission: a body whose `kind` is absent or `"mcp"` takes the MCP rule unchanged, a tool kind
  is handed on without the MCP rule reading another field, and any other `kind` is refused with
  the single kind error. Connector is an `mcp_servers` row. 04 §5.7: a valid skill name is 1–64 characters of `[a-z0-9-]`, with no `/`,
  `.` or upper case, and the documented names and pattern edges. 04 §5.6 and spec §16: the
  documented paths are admitted, and leading, trailing or double slashes, `.` and `..` segments
  and control characters are refused. An admitted path has no empty, `.` or `..` segment. Folder
  and file rows ("a folder occupies no bytes"). `writeFiles` is a ceiling. "There is no `access`
  column" on grants. "Revocation is this constraint" (grant → membership `CASCADE`). Links die
  with either end, and the connector's secret is `RESTRICT`. Owner required and creator legacy
  (04 §2). The ER diagram's optional references, the General agent is an ordinary row, and "a
  resource can sit in the catalog … without being assigned" (an existence theorem). "`name` 1–200
  code points" (`connector_name_is_one_to_200_code_points`) and the HTTP length bounds of agents,
  connectors and skills (`catalog_name_bounds`), replayed against the contract constants. The
  create parser reports an unknown `transport` before an unknown `authType`
  (`transport_error_precedes_auth_type_error`). ADR W9-AUTH-117: `hasGrant` finds a grant exactly
  when a row names the user (`has_grant_iff_a_row_names_the_user`), the run is `permitted` exactly
  when the runtime is configured, the agent is another principal's, the grants store is wired and
  a row names the caller's user (`run_is_permitted_iff_a_grant_row_names_the_caller`), and the
  owner runs as `own` (`the_owner_runs_as_own`). The agent field parsers: a name is accepted, as
  its trimmed form, exactly when that form is non-empty and at most 200 UTF-16 units
  (`agent_name_is_trimmed_and_bounded`, with the astral-character edges), instructions are
  accepted unchanged exactly up to 100 000 units (`agent_instructions_are_untrimmed_and_bounded`),
  and `null` is the default model (`agent_model_null_is_the_default`).
  Citations: the `writeFiles` ceiling cites W9-UI-133 "narrows at read and write"; the General
  agent cites spec §19.5.1 and W1-DB-01 §13; the link-cascade, secret-`RESTRICT` and folder
  sentences, which are schema comments, cite the schema files only.
- **T2 (Invariants).** Generated: for each of the 41 foreign keys,
  `<fk>_joins_one_workspace` instantiates `Er.Core.no_cross_tenant_reference`, and
  `<fk>_names_exactly_one_parent` (26 `NOT NULL` keys) or `<fk>_names_one_parent_when_set`
  (9 nullable keys) gives the cardinality. For each of the 12 unique keys, and the two composite
  primary keys of the project link tables, `<key>_identifies_one_row`. These rest on the generic
  lemmas `reference_names_one_parent`, `mandatory_reference_is_set`, `unique_key_identifies_row`
  and `primary_key_identifies_row`. Each key theorem has a negative witness as well: the first
  sample row and a different row agreeing on the key make `Sample.state` inconsistent (checked by
  kernel evaluation). The key theorems of `agents`, `agent_files`, `agent_skills` and
  `agent_mcp_servers` cite the schema only (no document states those keys). The operations:
  - `replace_assigns_only_catalogued_resources` (quoting "assigning it is what makes one
    particular agent's runs able to load it");
  - `replace_never_widens_past_write_files`;
  - `replace_writes_each_resource_once`;
  - `replace_keeps_every_requested_id` (membership for skills and connectors, a permutation of
    the requested file ids) and `replace_answers_in_id_order`;
  - `replace_reports_the_first_uncatalogued_file`, `…_skill` and `…_connector` (which outcome a
    missing id produces), and `replace_checks_files_then_skills_then_connectors` (the check order
    read back from the answer);
  - `read_narrows_stale_write_access`;
  - `grants_round_trip` (read after replace returns exactly the principals written, under
    one principal per user);
  - `grants_read_names_only_active_members`;
  - `put_file_never_transfers_owner`, `put_file_at_a_new_path_is_owned_by_the_caller` and
    `put_skill_never_transfers_owner`;
  - `rename_file_keeps_the_rows_identity`, `rename_file_is_missing_iff_no_row`,
    `rename_file_never_takes_an_occupied_path`, `rename_file_leaves_other_rows_alone`,
    `delete_file_removes_exactly_that_path` (a folder's children stay) and
    `delete_skill_removes_exactly_that_name`;
  - `accepted_agent_name_passes_the_table_check` (every accepted name satisfies
    `agents_name_not_blank`), `accepted_agent_model_is_default_or_visible`,
    `accepted_instructions_are_the_string_sent` and `accepted_assignment_body_keeps_every_id` (the
    schema admits duplicates, which `replace` refuses for files);
  - `rename_by_prefix_keeps_every_identity`, `rename_by_prefix_leaves_other_rows_alone`,
    `rename_by_prefix_moves_the_rows_under_it`, `rename_by_prefix_keeps_the_key_at_the_path` (a
    catalog whose keys are their paths, as uploads write them, keeps that shape) and
    `delete_by_prefix_keeps_exactly_the_other_rows`;
  - `created_connector_meets_the_shape_checks` (every body the create parser accepts yields a
    row that passes the six shape checks).
- **T3 (Adversarial).** `forged_id_names_a_row_of_the_writers_workspace` (generic): whatever id a
  writer puts in a tenant-paired reference, the parent row with that id is in the writer's
  workspace. It is instantiated for all 19 id references of the cluster (assignments, the grant's
  agent, the two version and two pointer references, project links and the four owner columns), and `forgery_theorems_cover_every_id_reference`
  pins the list. The other adversarial theorems:
  - `grants_name_only_active_membership_principals`: no API-key, revoked or foreign principal can
    be granted;
  - `grants_body_admits_only_distinct_uuids` and
    `case_variant_duplicate_grant_ids_are_refused`;
  - `dot_dot_segment_is_refused_anywhere`: a `..` segment leading, trailing or in the middle,
    whatever surrounds it;
  - `sibling_sharing_leading_characters_is_not_under_the_prefix`: `docs2/…` is never under
    `docs`;
  - `no_grant_row_no_run_permission`: a caller who is not the owner and whose user no grant row
    names (an API-key caller has no user) is never `permitted`.
- **T4 (Refinement).** `connector_invariant_is_the_row_checks` and `tool_connector_invariant_is_the_row_checks` (all twelve `mcp_servers` checks, for an MCP row and a tool row),
  `skill_invariant_is_the_row_checks`, `agent_invariant_is_the_row_checks`
  (`agents_name_not_blank`), `file_invariant_is_the_row_checks` (all six file checks, the two size
  checks read on the decimal text of the `bigint`, through private lemmas on `Int.repr`),
  `file_path_and_key_invariants_are_the_row_checks` (its path-and-key corollary) and
  `current_agent_states_embed_in_the_target`. Negative examples show a blank agent name, a
  negative size, a folder with a size and a folder with a content type each failing its check.
- **T5 (Meta).** Each theorem pins one finding below:
  - `blank_connector_name_passes_the_parser_but_not_the_check`;
  - `repeated_ids_are_treated_differently_by_kind`;
  - `file_and_skill_bodies_carry_no_owner`;
  - `revoked_principal_keeps_a_hidden_grant`;
  - `an_api_key_principal_cannot_be_granted`;
  - `grant_names_two_different_relations`;
  - `skill_names_and_closed_set_values_are_different_slugs`;
  - `rename_rewrites_a_diverged_key_blindly`;
  - `uploading_over_an_existing_path_does_not_make_the_caller_owner`.

**Witnesses.** Every hypothesis-bearing theorem has an `example`, and the outcome, run-ownership
and parser theorems have negative ones too (a user without a grant row runs as `other`; a
request whose file, skill and connector are all unknown reports the file). The 41 + 41 + 17 + 19 generated
theorems use `Sample.state` (its consistency is proved by kernel evaluation). The operation
theorems use small concrete catalogs, principal lists, file lists and parsed bodies. The
connector and file T1 theorems are applied to a valid `stdio` connector with arguments, a valid
`bearer` connector, and a valid folder and file. The vectors are positive witnesses as well.

**Mutation coverage.**

- _Catalogue._ Changing a column, key, `ON DELETE` or closed set of the twelve tables fails the
  Vitest table replay, and the generated per-key theorems where the change moves a class,
  cardinality or key.
- _Concept._ Adding or dropping a concept column fails `*_concept_covers_every_column`.
- _Check semantics._ Dropping or weakening a conjunct of `Connector.valid`, `Skill.valid`,
  `Agent.valid` or `File.valid`, or of any of the 22 `clusterCheckHolds` branches, breaks the T4
  equivalences (checked: `agents_name_not_blank → true`, `files_size_non_negative → true` and
  dropping the `content_type` conjunct of `files_folder_has_no_content` each fail the build). A changed CHECK body in the schema fails the
  `checkSql` replay.
- _Parser._ Letting the parser accept a URL on `stdio`, drop the credential rule or swap two error
  messages breaks `created_connector_meets_the_shape_checks` or a T1 refusal theorem, and fails
  the 312-body replay.
- _Narrowing._ Removing the `writeFiles` ceiling from `replace` or `effective` breaks
  `replace_never_widens_past_write_files`, `read_narrows_stale_write_access` and
  `write_files_is_a_ceiling`.
- _Grants._ Letting `lookupGrantable` accept an API-key or revoked principal breaks
  `grants_name_only_active_membership_principals` and `an_api_key_principal_cannot_be_granted`.
- _Paths._ Widening `noDotSegments` or `underPrefix` (for example to a plain character prefix)
  breaks `dot_dot_segment_is_refused_anywhere` and
  `sibling_sharing_leading_characters_is_not_under_the_prefix`.
- _Tenancy._ Dropping the tenancy check in `classify` breaks every generated
  `…_joins_one_workspace` theorem.
- _Outcome codes._ Reporting a missing skill as `unknown-connector` (or any other swap of the
  three codes) breaks `replace_reports_the_first_uncatalogued_skill` and the check-order theorem
  (checked by building the mutation). Answering in request order breaks
  `replace_answers_in_id_order`.
- _Authorisation._ `hasGrant := true` breaks `has_grant_iff_a_row_names_the_user`,
  `run_is_permitted_iff_a_grant_row_names_the_caller`, `no_grant_row_no_run_permission` and the
  negative witness (checked), and fails the run-ownership replay.
- _Error order._ Swapping the transport and `authType` errors of the create parser breaks
  `transport_error_precedes_auth_type_error` and fails the connector-body replay.

## Glossary

Each term below has one meaning in the model. Aliases in today's code and docs follow it.

| Term                   | Meaning                                                                                                                                   | Today's aliases and conflations                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace catalog**  | The set of skills, files and connectors rows of one workspace: what can be assigned.                                                      | `ResourceCatalogRepository` / "resource catalog" covers only files and skills (the object-store index), never connectors. The target "organisation catalog" (N-2) is a different, cross-workspace concept. |
| **Agent**              | One `agents` row: identity, instructions, model pair, runtime profile, permissions, stored policy, owner.                                 | `AgentResource` is the agent's _body_, not an agent resource; "General agent" is an ordinary row.                                                                                                          |
| **Skill**              | One `skills` row, addressed by its slug `name`, with `SKILL.md` verbatim and an `enabled` flag.                                           | The catalog row's `id` is opaque on the wire.                                                                                                                                                              |
| **File**               | One `files` row: a node of the workspace tree, `file` (with an object key) or `folder` (without).                                         | "Folder" is a file of kind `folder`. The wire `id` is the catalog id, while `/api/files/:id` takes `fileRouteId(path)`.                                                                                    |
| **Connector**          | One `mcp_servers` row: an MCP server reached by `stdio` or `http`/`sse`, with an optional sealed credential.                              | "MCP server", `mcp_servers`, `mcp_server_id`, `mcpServerIds` (project wire), `connectorIds` (agent wire), `IdKind.connector`.                                                                              |
| **Assignment**         | A row of `agent_files` (with `access`), `agent_skills` or `agent_mcp_servers`: an agent may load or call a catalogued resource.           | "resources" (`/api/agents/:id/resources`, `AgentResourceAssignments`), "capabilities" (spec §17 Step 3), "file grant", "a read-only grant" (data-plane page).                                              |
| **Project link**       | A row of `project_files` / `project_mcp_servers`: a project contributes a resource to its sessions.                                       | "project resources", `ProjectResource.fileIds` / `mcpServerIds`.                                                                                                                                           |
| **Grant**              | One `agent_grants` row: a member (by user) may run an agent. It is binary, with no access.                                                | "permitted" (the `decide()` grant width), "Viewer grant". The row stores `user_id`, and the wire (`principalIds`) and docs speak membership principals.                                                    |
| **Access**             | `read` or `read-write` on a file assignment. The _effective_ access is `narrow(writeFiles, stored)`.                                      | —                                                                                                                                                                                                          |
| **Owner**              | `owner_principal_id`: the principal authorisation compares for `own`.                                                                     | —                                                                                                                                                                                                          |
| **Creator**            | `created_by`: legacy human attribution, the creating membership's `user_id` (paired to `memberships`), and `NULL` for an API-key creator. | Wire `createdBy`. It is not an owner and not a principal.                                                                                                                                                  |
| **User id in a grant** | `agent_grants.user_id`: the membership's user, one per (workspace, user).                                                                 | Not a principal id, and not the creator.                                                                                                                                                                   |

"Publisher" (`shares.publisher_principal_id`) is the owner-equivalent of the publication cluster
and is out of this unit's tables.

## Findings

All are proposals: the programme does not change product code (charter §8).

| #   | Severity      | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Document / code                                                                                                                                                                                                                                        | Lean                                                                                                                                                                                                                                                                                               | Proposed resolution                                                                                                                                                                                                           |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | correctness   | `POST /api/connectors` with a whitespace-only `name` (for example three spaces) passes `parseCreateConnectorBody` (`NAME_PATTERN = /^.{1,200}$/u`), but the row fails `mcp_servers_name_not_blank`. The route's own validation, which "means the database's constraints are a backstop", therefore lets the database refuse the insert, with a CHECK violation the route does not map, instead of the documented `400 invalid_body`.                                                                                                                                                                                                     | 04 §5.8 "Create rules: `name` 1–200 code points"; `apps/web/server/connectors/contract.ts#parseCreateConnectorBody`; `packages/core/src/db/schema/mcp-servers.ts` (`mcp_servers_name_not_blank`)                                                       | Current `Concepts.Connector.parseBody`; `Meta.ConceptCatalog.blank_connector_name_passes_the_parser_but_not_the_check`. Target: `parseBody` also requires `File.notBlank name`, and then `created_connector_meets_the_shape_checks` extends to all seven checks.                                   | Issue: refuse a name that is blank after `btrim` in the parser, add a regression test, and state "not blank" in 04 §5.8.                                                                                                      |
| 2   | correctness   | `AgentResourceRepository.replace` refuses a repeated file id as `unknown-file` naming a file that exists, and silently merges repeated skill and connector ids. The same kind of input gets a misleading error for one resource kind and silent acceptance for the others.                                                                                                                                                                                                                                                                                                                                                               | 04 §5.9 (assignments); `packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider`                                                                                                                            | `Concepts.Grant.replace`; `Meta.ConceptCatalog.repeated_ids_are_treated_differently_by_kind`                                                                                                                                                                                                       | Issue: either merge repeated file entries (keeping the narrowed widest access) or refuse all three kinds with a distinct `duplicate-*` outcome and problem code. Document the rule in 04 §5.9.                                |
| 3   | documentation | 04 §2: "every row that can be 'own' or 'other' (agents, skills, files, connectors, …) carries `ownerPrincipalId`". The tables do, but `FileResourceSchema` and `SkillDetailSchema` carry neither `ownerPrincipalId` nor `createdBy`, so an SDK consumer cannot tell which files and skills it may write (Builder `OWN_WRITES`).                                                                                                                                                                                                                                                                                                          | 04 §2 "Ownership"; `packages/contracts/src/files.ts#FileResourceSchema`, `packages/contracts/src/skills.ts#SkillDetailSchema`                                                                                                                          | `Meta.ConceptCatalog.file_and_skill_bodies_carry_no_owner`; wire vectors                                                                                                                                                                                                                           | Docs fix now ("the tables carry it; the file and skill bodies do not expose it yet"). ADR draft or issue: add `ownerPrincipalId` to both bodies.                                                                              |
| 4   | documentation | ownership-and-sharing, "Catalog, assignment, grant": the diagram's grant edge ends at "A person or API key". A grant can only name an active _membership_ principal, and an API-key principal is always `principal-not-found`.                                                                                                                                                                                                                                                                                                                                                                                                           | `docs/sdk/site/concepts/ownership-and-sharing.mdx#catalog-assignment-grant`; `packages/core/src/db/repositories/agent-grants.ts` (`replacePrincipalIds`)                                                                                               | `Meta.ConceptCatalog.an_api_key_principal_cannot_be_granted`; `Adversarial.ConceptCatalog.grants_name_only_active_membership_principals`                                                                                                                                                           | Docs fix: "a person (membership principal)". API keys run agents through their role (own / any), never through a grant.                                                                                                       |
| 5   | documentation | The same page contradicts itself and 04 §5.9. "What you can and cannot do today" says "Let a specific Viewer run a specific agent — The control plane's own UI only, no SDK method yet", while its own verb table, workspaces-and-principals and 04 §5.9 (✅) name `aw.agents.getGrants` / `replaceGrants`, which exist (`packages/sdk/src/resources/agents.ts`).                                                                                                                                                                                                                                                                        | `docs/sdk/site/concepts/ownership-and-sharing.mdx#what-you-can-and-cannot-do-today` vs `#catalog-assignment-grant` and 04 §5.9                                                                                                                         | — (document versus document)                                                                                                                                                                                                                                                                       | Docs fix: "`aw.agents.replaceGrants(agentId, principalIds)`".                                                                                                                                                                 |
| 6   | naming        | A grant is stored against the membership's `user_id`, and the run check reads it by user (`hasGrant(agentId, principal.userId)` in `run-ownership.ts`), while 04 §2 and workspaces-and-principals say "Authorisation always compares principals, never user ids". The round trip `listPrincipalIds ∘ replacePrincipalIds` holds only while each user has exactly one principal. If a membership principal were revoked, its grant would disappear from `listPrincipalIds` but still satisfy `hasGrant`. Today no code path revokes a membership principal (removing a member deletes the membership, which cascades), so this is latent. | 04 §2; `docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal`; `packages/core/src/db/schema/agent-grants.ts`; `apps/web/server/agents/run-ownership.ts#resolveAgentRunOwnership`                                               | Current: `Concepts.Grant.{grantsRead,grantsReplace,hasGrant}`, `Invariants.ConceptCatalog.grants_round_trip` (with its one-principal-per-user hypothesis), `Meta.ConceptCatalog.revoked_principal_keeps_a_hidden_grant`. Target: key grants by `(workspace_id, principal_id)`.                     | ADR draft: key `agent_grants` by the membership principal (composite FK to `workspace_principals (workspace_id, id)`, migrated through `memberships`) and check `hasGrant` by principal id. Otherwise document the exception. |
| 7   | documentation | 04 §5.7: "`SkillSummary { name, …, id? }`" and "an opaque `id?` (the catalog row) rides along". The contract requires `id` (K-4, issue #234); no skill body field is optional.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `docs/sdk/04-api-specification.md#57-skills--awskills`; `packages/contracts/src/skills.ts#SkillSummarySchema`                                                                                                                                          | `Concepts.Skill.wireFields`; the suite asserts that no wire field accepts `undefined`                                                                                                                                                                                                              | Docs fix: `id` (required), and drop the `?`.                                                                                                                                                                                  |
| 8   | naming        | "Grant" names two different relations. `agent_grants` (person → agent, binary) is one. The data-plane page's "a read-only grant as 0o555 dirs" and the `agent-resources.ts` comments' "file grant" mean an `agent_files` assignment with `access`.                                                                                                                                                                                                                                                                                                                                                                                       | `docs/sdk/site/concepts/data-plane.mdx#how-a-file-a-skill-and-a-secret-move-through-it`; `packages/core/src/db/repositories/agent-resources.ts`                                                                                                        | `Meta.ConceptCatalog.grant_names_two_different_relations`                                                                                                                                                                                                                                          | Glossary (above): **assignment** for the three agent-resource tables and **grant** only for `agent_grants`. Docs fix to "a read-only file assignment", and code comments in a follow-up.                                      |
| 9   | naming        | One concept has three names: connector (wire, SDK, CLI, `IdKind`), MCP server (`mcp_servers`, `agent_mcp_servers.mcp_server_id`, `project_mcp_servers`) and `mcpServerIds` (project wire) next to `connectorIds` (agent wire).                                                                                                                                                                                                                                                                                                                                                                                                           | 04 §5.8 heading "Connectors (MCP servers)"; `packages/core/src/db/schema/{mcp-servers,agent-mcp-servers,project-mcp-servers}.ts`; `packages/contracts/src/agents.ts`                                                                                   | `Normative.ConceptCatalog.connector_is_an_mcp_servers_row`                                                                                                                                                                                                                                         | Target ER (synthesis): rename to `connectors` / `agent_connectors` / `project_connectors` and `connectorIds` everywhere, as one migration and contract ADR. Until then the glossary states the alias.                         |
| 10  | documentation | ownership-and-sharing, "What you can and cannot do today": "Put a skill, connector or file in your workspace's catalog … you become its `owner_principal_id`". That holds only for a new path or name. `putFile` / `putSkill` are upserts that "never transfer" an existing row, so re-uploading an existing path keeps the previous owner and creator.                                                                                                                                                                                                                                                                                  | `docs/sdk/site/concepts/ownership-and-sharing.mdx#what-you-can-and-cannot-do-today`; `packages/core/src/db/repositories/resource-catalogs.ts`                                                                                                          | `Meta.ConceptCatalog.uploading_over_an_existing_path_does_not_make_the_caller_owner`; `Invariants.ConceptCatalog.put_file_never_transfers_owner` and `put_skill_never_transfers_owner` (cited to the `CatalogFile` / `CatalogSkill` doc comments), `put_file_at_a_new_path_is_owned_by_the_caller` | Docs fix: "you become the owner of a new file or skill; overwriting an existing path or name keeps its owner".                                                                                                                |
| 11  | correctness   | `files.ts` says `storage_key` "is stored rather than derived from `path` precisely so that renaming a file does not have to rewrite an object — the two identifiers are allowed to diverge". `renameFilesByPrefix` nevertheless rewrites a file's key as `newPrefix \|\| substr(storage_key, char_length(oldPrefix) + 1)`, which is a rename only when the key starts with the old path prefix. Every upload writes `storage_key = path` today, so the coupling holds, but a row whose key diverges (which the schema comment allows) gets a key that names no object after a subtree move.                                              | `packages/core/src/db/schema/files.ts` (header comment); `packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider` (`renameFilesByPrefix`); `apps/web/app/api/files/route.ts` (`storageKey: file.path`) | `Concepts.File.renameByPrefix` / `cutAndPrefix`; `Invariants.ConceptCatalog.rename_by_prefix_keeps_the_key_at_the_path` (holds under `storage_key = path`); `Meta.ConceptCatalog.rename_rewrites_a_diverged_key_blindly`                                                                           | Choose one: document `storage_key = path` as an invariant (drop "allowed to diverge", add a CHECK or a test), or leave the key alone on rename (the object store is keyed by the stable key). ADR draft.                      |
| 12  | documentation | 04 §5.9 gives `PUT /api/agents/:id/resources` the body `AgentResourceAssignments` and says nothing of the answer's content. The repository answers the stored read-back, not the request: files narrowed by `writeFiles`, repeated skill and connector ids merged, and every list in ascending id order. A client comparing the answer with what it sent sees a reordering and a merge it was not told about.                                                                                                                                                                                                                            | `docs/sdk/04-api-specification.md#59-agents--awagents`; `packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider` (`return read(agentId)`)                                                                  | `Concepts.Grant.replace` / `readBack`; `Invariants.ConceptCatalog.replace_answers_in_id_order`, `replace_keeps_every_requested_id`                                                                                                                                                                 | Docs fix: "the answer is the stored assignment set: narrowed, de-duplicated, each list ordered by id".                                                                                                                        |

No security finding. Every reference of the cluster is tenant-paired (T2), every forgeable id
reference is covered by a T3 theorem, and grants cannot name API-key, revoked or foreign
principals.

## Gaps

- **Not replayed against the repositories.** `Grant.replace` / `effective` (agent assignments),
  `grantsRead` / `grantsReplace`, `File.putFile` / `renameFile` / `deleteFile`, `Skill.putSkill` /
  `deleteSkill`, `File.renameByPrefix` and `File.deleteByPrefix` model the PostgreSQL
  repositories, which need a database, and the isolated-database helper
  (`packages/core/src/db/repositories/testing.ts`) is not a package export this unit's suites may
  import. `replace.json` (66 vectors, every outcome kind) is emitted for a DB-backed replay; today
  the suite replays what needs no database: every request is a body `AgentResourceAssignmentsSchema`
  accepts, every expected outcome is a `ReplaceAgentResourcesOutcome` kind, and every `updated`
  answer is a response body whose lists are in ascending id order and hold exactly the requested
  ids. The narrowing and the choice of outcome are not replayed against `replace` itself. The DB
  suites of `packages/core` remain the oracle for those, and a DB-backed formal suite (or a pure
  extraction of the checks) would close the gap. Likewise the row-check semantics
  (`clusterCheckHolds`) are replayed only through their SQL text, not by evaluating rows in
  PostgreSQL.
- **Parsers not modelled.** `parseModelConnectionId`, `parseRuntimeProfileId` and
  `parseAgentPermissions` (the other agent body fields) and the file-entry `.strict()` of
  `AgentResourceAssignmentsSchema` (an unknown key inside an entry) are outside the model; the
  body model assumes the members already have their JSON types.
- **T2 is single-step.** The operation theorems state what one call of each modelled operation
  guarantees; induction over sequences of operations (charter §6.1) is the Phase-3 behaviour
  unit's.
- **Route-level path rules.** 04 §5.6 "no reserved prefixes (`400 reserved_path`)" (`.claude/` and
  the internal metadata paths, `apps/web/server/files/handlers.ts`) and the route's path length
  bound are HTTP admission rules, not `files` checks, and are not in `File.pathAdmitted`; they
  belong to the files behaviour unit.
- **`[:cntrl:]` is locale-dependent.** The model fixes it to C0, `DEL` and C1, and the vectors avoid
  other Unicode control and format characters.
- **Not modelled here.** A `renameFile` or `putFile` that would violate a row CHECK (the database
  refuses it; the model only states the unique-key conflict), column defaults (`enabled`, `size_bytes`, `auth_type`), non-unique indexes,
  `ON DELETE` as a state transition, the agent policy's content (`agents.policy`), the skill
  file-path grammar (ADR-0044) and the object store, the folder `sizeBytes: null` rendering on the
  wire, and the connector credential rotation route.
- **Scope of the operation theorems.** The T2 theorems quantify over consistent states and over the
  modelled operations. Invariant preservation by every route is the Phase-3 behaviour unit's.
- **Overlap with Phase 3.** `Concepts/Connector.lean` holds the create-body parser (a Phase-3-shaped
  artefact) because it establishes the concept's invariants. P3-beh-catalog should import it, not
  redefine it.
