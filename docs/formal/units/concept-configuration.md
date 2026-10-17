# Unit `concept-configuration`: model connections, runtime profiles and secrets (phase P1b)

This unit formalises the configuration cluster. It covers the three concepts a workspace
configures once and every agent then refers to: the **model connection**, the **runtime profile**
(with the **runtime connection** it may name) and the **secret**. It builds on `Er/Core.lean` and
`Prelude/Ids.lean` from `er-core` and redefines nothing that unit defines.

| File                                                                                                                     | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formal/AgentWorkspace/Concepts/Secret.lean`                                                                             | `Algorithm` (a `WireEnum`), the envelope sizes and bounds, the name shape (`isValidName`), value bounds, `Envelope`, `Secret`, the wire `Resource` and `toResource`, the value-bearing fields and columns, `Operation` with `operationsCurrent`/`operationsTarget`, the naming conventions (`Purpose`, `purposeOf`, `modelConnectionSecretName`), and the key-level request parsers (`closedBodyAccepts`, `openBodyAccepts`, `createAccepts`, `replaceAccepts`)                                                                                                                                                                                                                                               |
| `formal/AgentWorkspace/Concepts/ModelConnection.lean`                                                                    | `Provider` and `ConfigField` (`WireEnum`s), the rule table `rule`, `Config`, `isComplete`, `configAccepted`, `configValuesAccepted`, `Readiness` and `ready`, `ModelConnection`, the wire `Resource` and `toResource`, the create and update field sets with their key-level parsers (`createAccepts`, `updateAccepts`), the value rules (`nameAccepted`, `apiKeyAccepted`), the JavaScript blank set (`isJsTrimmedCode`, `isJsTrimmed`, `isBlank`), and `ModelChoice`                                                                                                                                                                                                                                        |
| `formal/AgentWorkspace/Concepts/RuntimeProfile.lean`                                                                     | `Driver`, `NetworkPolicy` and `Filesystem` (`WireEnum`s), the `Decimal` model of a JSON number with the contract bounds and the `integer` column range, `RuntimeProfile`, the required create fields, `createAccepts`, the `PATCH` model (`updateFields`, `PatchValue`, `patchAcceptsCurrent`, the S-19 `patchAcceptsTarget`), the create-time image rule (`isSha256Pinned`, `Image`, `createImageAccepted`), the resource field sets, the runtime-connection parser and value rules (`connectionCreateAccepts`, `connectionTextAccepted`, `connectionCredentialAccepted`), and the runtime-connection name encoding (`encodeSegment`, `encodeSecretName`) and decoding (`decodeDriver`, `decodeKnownDriver`) |
| `formal/AgentWorkspace/Er/Current/Configuration.lean`                                                                    | the cluster, its 16 foreign keys (`clusterForeignKeys`), `inbound`, the delete behaviour (`deleteClearsReference`, `deleteNeverBlocked`), the semantics of the cluster's other checks (`configCheckHolds`, `refinedChecks`, `consistentConfig`), the maps from concept rows to `Er.Core` rows, the typed-reference target (`runtimeConnectionsTyped`) and a witness state (`Witness.state`)                                                                                                                                                                                                                                                                                                                   |
| `formal/AgentWorkspace/Theorems/{WellFormed,Normative,Invariants,Adversarial,Refinement,Meta}/ConceptConfiguration.lean` | the theorems, by tier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `formal/Vectors/ConceptConfiguration.lean` → `formal/generated/vectors/concept-configuration/`                           | 20 vector files, 612 vectors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tests/formal/concept-configuration.test.ts`                                                                             | replays the vectors against the packages: the live Drizzle tables, the `0025` snapshot's `CHECK` bodies, the schema and contract arrays, `renderValueList`, the contract Zod schemas, `CreateRuntimeProfileInput` and `UpdateRuntimeProfileInput`, and `String.prototype.trim` over the whole BMP (197 tests)                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/web/formal/concept-configuration.test.ts`                                                                          | replays the vectors against the server: `parseCreateModelConnection`, `parseUpdateModelConnection`, `isModelConnectionConfigComplete`, `toModelConnectionResource`, `modelConnectionSecretName`, `parseSecretName`, `parseSecretValue`, `parseCreateSecretBody`, `parseReplaceSecretBody`, `parseCreateRuntimeConnectionInput`, `parseCreateRuntimeProfileInput`, `parseUpdateRuntimeProfilePatch`, the in-memory secrets store, and the in-memory and secrets-backed runtime-connection stores (551 tests)                                                                                                                                                                                                   |

## Modelling decisions

- **One module per concept, above the ER layer.** Each concept module states its fields as the
  database and the wire know them, its invariants as predicates, and its derived states (only
  model-connection readiness has any). Transitions such as create, rotate and delete are left to
  Phase 4. `Er/Current/Configuration.lean` imports the three concepts and maps each concept row
  onto an `Er.Core.Row` (`secretRow`, `modelConnectionRow`, `runtimeProfileRow`). T0 proves that a
  valid concept row satisfies every check of its table.
- **The DB enums live in the concept modules.** `Provider`, `Driver`, `NetworkPolicy`,
  `Filesystem` and `Algorithm` mirror the schema arrays (`modelProviders`, `runtimeProfileDrivers`,
  …), because a `CHECK` constraint has the same list. The test pins each to its contract array
  too. The Phase 2 contract units cannot import `Concepts`, so they will declare their own wire
  enums. A T4 equality between the two copies is then their job.
- **A `bytea` cell is its octet length.** Every check on `secrets`' value columns reads only
  `octet_length`, so `Envelope` stores lengths, and `secretRow` writes hexadecimal text with two
  digits per byte. The model therefore makes the schema comment's own point: the checks assert
  the parts and their sizes, never that the bytes are ciphertext.
- **The cluster's own checks are refined here, not in `er-core`.** `Er.Core.otherCheckHolds`
  belongs to `er-core`, so this unit defines `configCheckHolds` for its checks: the name shape,
  the master key, the five envelope sizes, `runtime_profiles_name_not_blank`, and the two
  `…_default_model_pair` checks that constrain how a model connection is referenced.
  `consistentConfig` is `consistent catalogue` with those checks added. A T0 vector pins every
  constant in them (32, 12, 16, the regex, `btrim`) to the snapshot's `CHECK` body.
- **SQL blank and JavaScript blank differ, and the model keeps both.** `sqlNotBlank` is
  `length(btrim(s)) > 0`. PostgreSQL's one-argument `btrim` strips spaces only. `isBlank` is
  JavaScript's `trim() === ''` over the full ECMAScript _WhiteSpace_ and _LineTerminator_ set
  (`isJsTrimmedCode`: TAB, VT, FF, SP, NBSP, ZWNBSP, every `Zs` separator, LF, CR, LS, PS).
  `blank_is_the_js_trim_set` proves that across the whole BMP the model's set is exactly
  `jsTrimCodePoints`, an independent transcription of the ECMAScript definition, and `trim.json`
  replays that list against `String.prototype.trim` on all 65 536 code units. The config vectors
  also include one value per such character, and a zero-width space, which `trim` keeps.
- **Numbers are decimals.** A JSON number is modelled as `mantissa · 10^-exponent` (Lean's
  `JsonNumber`), so `0.5` is exact. The model states the contract bounds and the PostgreSQL
  `integer` range side by side.
- **The runtime-connection encoding is modelled over character lists.** This makes the round trip
  provable for every label: `decode_inverts_encode` and
  `encoded_connection_name_is_a_runtime_connection_secret`. The model's upper-casing is
  ASCII-only, so the model claims fidelity on ASCII labels only (`isAsciiLabel`). JavaScript's
  `toUpperCase` also maps some non-ASCII letters (`ß` becomes `SS`, `ı` becomes `I`, `ﬁ` becomes
  `FI`). `jsUpperCaseDivergences` records those three labels with the name the code stores; the
  T5 theorem `connection_encoding_model_is_ascii_only` states that the model differs on each, and
  `runtime-connection-unicode.json` checks against the real store that the code stores exactly
  the recorded name. The encode vectors otherwise use ASCII and one BMP letter (`é`) that both
  sides map to `_`.
- **Request parsers are functions over key sets.** A request parser is modelled by what it does
  with the keys of a body whose present values are each valid: `Secret.closedBodyAccepts fields
required keys` (every required key present, no key outside `fields`) or
  `Secret.openBodyAccepts required keys` (required keys present, any other key ignored). Each
  parser is one of them (`ModelConnection.createAccepts`/`updateAccepts`,
  `Secret.createAccepts`/`replaceAccepts`, `RuntimeProfile.createAccepts`,
  `RuntimeProfile.connectionCreateAccepts`), and the T1 theorems are stated over these functions:
  a closed parser refuses every body with an unknown key (`closed_body_refuses_an_unknown_key`),
  an open parser keeps accepting when keys are added (`open_body_ignores_added_keys`), and so on.
  The value rules are separate predicates (`nameAccepted`, `apiKeyAccepted`,
  `connectionTextAccepted`, `connectionCredentialAccepted`, `isSha256Pinned`). The vectors derive
  every expected answer (required keys, refused keys, ignored keys, empty and full bodies) by
  running these functions, not by copying the lists.
- **A `PATCH` body is a list of `(key, null | value)`.** `patchAcceptsCurrent` is today's
  `UpdateRuntimeProfileInput` (`.optional()` members refuse `null`); `patchAcceptsTarget` is
  roadmap S-19, which lets `null` clear the fields S-19 names. T4 proves today refines the target.
- **Normative lists are replayed, not only stated.** Every field list a T1 theorem rests on
  (`ModelConnection.createFields`/`createRequiredFields`/`updateFields`,
  `Secret.createFields`/`replaceFields`, `RuntimeProfile.createFields`/`requiredCreateFields`,
  `connectionCreateFields`/`connectionCreateRequiredFields`, `Secret.operationsCurrent`) is
  emitted in `request-fields.json` or `secret-operations.json`. The suites check that the real
  parser accepts a body with exactly those keys, refuses it without each required key, accepts it
  without each optional key, and refuses (or, for runtime connections, ignores) every other
  candidate key. For profiles the replay reads `CreateRuntimeProfileInput.shape`. For operations it
  reads the method names of the in-memory `WorkspaceSecretsStore`.
- **The provider rule table is transcribed twice.** `documentedConfigRules` (in the Normative
  module) transcribes 04 §5.3 and `MODEL_PROVIDER_CONFIG_RULES` independently of
  `ModelConnection.rule`. The 15 generated cell theorems read their verdict from the
  transcription and check `rule` against it, and `rule_is_the_documented_table` states the whole
  equality. A change to either table therefore breaks a cell theorem.
- **The per-FK tenancy theorems instantiate `er-core`'s generic lemma.** A command elaborator,
  `aw_config_fk_theorems`, generates one T2 theorem per key in `clusterForeignKeys`, and each is
  a use of `no_cross_tenant_reference`. The T3 theorems are phrased for an attacker's rows (an id
  copied from another workspace) and derive their conclusion from those T2 theorems. The
  connector case uses id uniqueness, because the composite key has no sibling.
- **Witnesses.** `Witness.state` is a consistent state (`consistentConfig`, checked by
  `decide +kernel`) in which each of the 16 keys is populated. Two workspaces reuse the
  connection and secret names. Every hypothesis-bearing theorem has an `example` built on this
  state, or on a forged variant of it for T3.

## Theorems (271 catalogue entries: 21 T0, 74 T1, 41 T2, 9 T3, 4 T4, 17 T5, 105 traced definitions)

- **T0 (WellFormed).** The wire spellings and order of the six closed sets. The five
  `…_check_is_the_…_enum` theorems state that each database closed-set check is exactly the
  concept enumeration. The value lists pass the DDL gate. `cluster_foreign_keys_are_complete`
  shows the list of 16 keys is exact in both directions, and `cluster_foreign_keys_are_paired`
  gives the tenancy class of each. The encoding theorems
  (`encoded_connection_name_is_a_runtime_connection_secret`, `decode_inverts_encode` for all 11
  drivers and every label, `credential_name_has_the_model_connection_purpose` for every id). The
  concept-row theorems (`valid_secret_satisfies_the_secret_checks`,
  `valid_profile_satisfies_the_profile_checks`, `model_connection_satisfies_the_provider_check`).
  `readiness_agrees_with_ready`.
- **T1 (Normative).** `rule_is_the_documented_table`, and 15 generated cell theorems, one per
  provider and config field (`azure_openai_requires_api_version`, `anthropic_refuses_deployment`,
  …), each checking `rule` against the independent transcription. The accepted config
  sets per provider. `accepted_config_is_complete` and `blank_config_values_are_refused`.
  The blank set: `blank_is_the_js_trim_set` (the whole BMP) and `blank_values_by_character`
  (every whitespace character, and ZWSP, NEL and U+180E as non-blank).
  Readiness: `missing_credential_is_reported_first` (for every provider and config, no credential
  is `noCredential`, so a missing credential is reported before an incomplete config),
  `incomplete_config_with_credential` and `azure_empty_readiness`; without a credential a
  connection is never ready, the optional-`baseUrl` providers
  are ready with a credential alone, and OpenAI-compatible and Azure are covered by their own
  theorems. Write-only and immutable fields: no credential or value field on any resource, the
  provider cannot be patched (an `apiKey` patch replaces the saved key), a secret's name cannot be
  replaced, and every value column is a `NOT NULL` `bytea`. The spec §23 example names, the name boundaries and the value
  bounds. The secret operations today and in the target. The request parsers over key sets:
  `closed_body_refuses_an_unknown_key`, `open_body_ignores_added_keys`,
  `model_connection_create_requires_name_provider_and_api_key`,
  `model_connection_update_is_name_config_and_key`, `secret_bodies_are_closed`,
  `secret_name_is_not_replaceable` (every replace body carrying `name` is refused),
  `profile_create_fields_are_the_resource_less_server_fields` and
  `runtime_connection_create_requires_every_field`. The value rules:
  `model_connection_name_is_not_blank_and_api_key_not_empty` and
  `runtime_connection_values_are_not_blank`. The profile `PATCH`: `patch_cannot_clear_a_field`
  (any body with a `null` is refused, §5.4 "can change but not clear") and
  `patch_changes_any_creatable_field`. The image rule of §5.4 ("`driverConfig.image` must be a
  `sha256`-pinned reference on create"): `sha256_pin_boundaries` and 11 generated
  `<driver>_profile_create_requires_a_pinned_image` cell theorems, one per driver. The numeric bounds of 04 §5.4:
  `cpu_must_be_positive` (0 and -1 refused, 0.5 and 1 accepted) and
  `profile_sizes_are_positive_safe_integers` (0, -1, 0.5 and `MAX_SAFE_INTEGER + 1` refused, 1 and
  `MAX_SAFE_INTEGER` accepted). The required and optional profile fields. `connection_name_is_stored_encoded` (the §5.4 example). The connection is a secret
  reference. `deleting_a_model_connection_is_never_blocked`,
  `deleting_a_runtime_profile_is_never_blocked` and `model_connection_references`. Per-workspace
  name keys. The configuration rows have no owner.
- **T2 (Invariants).** 16 generated `<fk>_preserves_tenant` theorems. Each model connection,
  runtime profile and secret has exactly one workspace.
  `profile_connection_is_one_secret_of_its_workspace`. Each id identifies one row (three
  theorems) and each name is unique in its workspace (three theorems). The stored provider,
  driver, network policy, filesystem mode and algorithm are members of their enumerations.
  `stored_secret_is_well_formed`, and `default_model_is_set_with_its_connection` for workspaces
  and projects.
- **T3 (Adversarial).** A runtime profile cannot name another workspace's connection. An agent
  cannot use another workspace's model connection or profile. A project or a workspace cannot
  default to another workspace's connection, and a run cannot record one. A connector cannot use
  another workspace's secret. Each holds for an arbitrary state and arbitrary rows, and a forged
  state witnesses each. Non-interference: `secret_resource_ignores_the_value` and
  `model_connection_resource_ignores_the_credential`.
- **T4 (Refinement).** `current_diverges_from_typed_runtime_connections`: a state that
  PostgreSQL accepts, and in which every cluster check holds, has a profile that names a plain
  secret, while the witness state satisfies the typed target.
  `encoded_connections_refine_the_typed_target`: on every state whose referenced secrets carry
  names that `encodeSecretName` produced, the target holds. `patch_current_refines_target`: every
  profile `PATCH` accepted today is accepted by S-19, and
  `s19_target_clears_sizing_but_not_required_fields` shows the extension is strict and stops at
  the required fields.
- **T5 (Meta).** One theorem per finding below (including `image_rule_ignores_the_driver` and
  `blank_name_rules_disagree`), and
  `connection_encoding_model_is_ascii_only`, which states where the encoding model is faithful.

**Mutation coverage.**

- _Rule table._ Flipping one cell of `rule` (for example OpenAI-compatible `required := []`)
  breaks `rule_is_the_documented_table`, its generated cell theorem, the accepted-sets theorems
  and `openai_compatible_ready_iff_base_url`, and the config vectors then fail against
  `parseCreateModelConnection` and `MODEL_PROVIDER_CONFIG_RULES`. Checked by mutation in repair
  round 1.
- _Readiness._ Dropping the credential from `ready` breaks `no_credential_is_never_ready`.
  Reordering `readiness` so an incomplete config is reported before a missing credential breaks
  `missing_credential_is_reported_first` (repair round 2), and the config vectors now carry
  `readinessWithoutCredential`, replayed against `toModelConnectionResource`'s `hasCredential`.
- _Blank set._ Dropping any code point from `isJsTrimmedCode` (U+3000 was checked by mutation in
  repair round 2) or adding one breaks `blank_is_the_js_trim_set` and
  `blank_values_by_character`, and the `trim.json` replay against `String.prototype.trim`.
- _Request parsers._ Making a closed parser open (or the reverse) breaks
  `runtime_connection_create_ignores_unknown_fields` and the per-parser T1 theorems, and the
  request vectors (derived from the functions) then fail against the real parsers.
- _Image pin._ Loosening `isSha256Pinned` (upper-case hex, any digest length, an empty reference)
  breaks `sha256_pin_boundaries`; making the rule read the driver breaks
  `image_rule_ignores_the_driver`; both fail the 187 image vectors against
  `parseCreateRuntimeProfileInput`.
- _Profile `PATCH`._ Accepting `null` today breaks `patch_cannot_clear_a_field`; the patch vectors
  fail against `UpdateRuntimeProfileInput` and `parseUpdateRuntimeProfilePatch`.
- _Closed sets._ Swapping two values of an enumeration breaks its `*_wires` theorem, its
  `*_check_is_the_*_enum` theorem, and the Vitest array comparison.
- _Credentials on the wire._ Adding a credential or value field to a resource breaks
  `*_has_no_*_field`. The vectors also check that the real `.strict()` schema refuses each
  forbidden field.
- _Tenancy check._ Dropping the tenancy pairing from a key (in `er-core`'s catalogue) breaks
  `cluster_foreign_keys_are_paired`, its generated T2 theorem and every T3 theorem that goes
  through it.
- _Delete behaviour._ Changing an inbound `ON DELETE` breaks `model_connection_references` or
  `deleting_*_is_never_blocked`, and the Drizzle replay of `inbound`.
- _Encoding._ Changing the prefix, the separator or the label check breaks
  `connection_name_is_stored_encoded`, `decode_inverts_encode` or the 187 encode vectors.
- _Bounds._ Changing a bound breaks `secret_value_bounds`, `secret_name_boundaries`,
  `cpu_must_be_positive` or `profile_sizes_are_positive_safe_integers`, and the number vectors.
  Loosening the size lower bound to 0 or the `cpu` bound to `>= 0` was checked by mutation in
  repair round 1: each breaks its T1 theorem.
- _Field lists._ Adding `provider` to `updateFields`, dropping `value` from `replaceFields` or
  making a profile field required breaks its T1 theorem, and a change on the TypeScript side
  (`parseUpdateModelConnection`'s `allowed`, `REPLACE_FIELDS`, `CreateRuntimeProfileInput`) fails
  the `request-fields.json` replay.

## Glossary

Each term of the cluster has one meaning here.

- **Model connection.** One workspace-scoped, named way to reach one model provider: the
  provider, the non-secret `config`, and a write-only credential. It is a row of
  `model_connections` plus a `secrets` row named `MODEL_CONNECTION_<id>`.
- **Provider.** The API family a model connection speaks (`anthropic`, `anthropic-compatible`,
  `openai`, `azure-openai`, `openai-compatible`). It is an attribute of a connection, not a
  resource. Do not confuse it with the **runtime provider** (§1.1: the engine that executes an
  agent, `claude-agent-sdk`) or the **runtime driver**.
- **Model.** A provider-side model id discovered through a ready connection. A **model choice**
  is always the pair `(model connection, model)`.
- **Credential.** The secret value of a model connection, runtime connection or connector.
  Credentials are write-only: one goes in, and the wire carries at most `hasCredential`.
- **Readiness.** A property of a model connection that is derived on every read, never stored:
  it has a credential and its config has every field the provider requires.
- **Runtime driver.** Where a run executes (11 values). It is chosen by a runtime profile.
- **Runtime profile.** A named, reusable description of where and within which limits runs
  execute: a driver, sizing, the network policy, the filesystem mode, timeouts and
  `driverConfig`. Agents refer to a profile and never copy it.
- **Runtime connection.** The endpoint and credential a driver needs (spec §14.9). Today it is a
  `secrets` row named `RUNTIME_CONNECTION__<DRIVER>__<LABEL>` whose value is the sealed
  `{endpoint, credential}`.
- **Secret.** One envelope-encrypted value of a workspace with an environment-variable-shaped
  name. The value is write-only and the metadata is readable.
- **Secret purpose** (a model term, not a code term). What a secrets row is for: `plain`,
  `modelConnectionCredential` or `runtimeConnection`. Today only the name records it.

**Aliases and conflations found today**

- _Connection and secret._ A runtime connection **is** a secrets row. `GET /api/secrets` lists
  runtime connections and model-connection credentials beside plain secrets, and
  `runtime_profiles.runtime_connection_id` can name any of the three (findings 3 to 5).
- _Model connection and provider._ The route's list key is `models`, while its items are
  connections (documented in `ModelConnectionListResponseSchema`). "Provider" also names the
  runtime provider in §1.1.
- _Model connection and credential._ No foreign key joins them. The only link is the name
  `MODEL_CONNECTION_<id>` (finding 8). The header of `schema/model-connections.ts` still says
  that "Wave 2 attaches the credential", which is stale.
- _Write-only values._ The rule is enforced by resource shape (T1) and by non-interference
  (T3). The database checks do not prove encryption (see `Envelope`).
- _Blank._ Three meanings coexist: JavaScript `trim() === ''` (model-connection and
  runtime-connection names, config values), PostgreSQL `btrim` (spaces only:
  `runtime_profiles_name_not_blank`, `secrets_master_key_id_not_blank`) and `min(1)` (the profile
  name contract). The model keeps each as its own predicate (`isBlank`, `sqlNotBlank`,
  `nameAcceptedByContract`); findings 9 and 15.
- _Runtime connection as a resource._ `04-api-specification.md` §2 lists `RuntimeConnection` as
  its own resource, but it has no table and no identifier kind (`runtime_connections_have_no_table`).

## Findings

| #   | Severity      | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Lean                                                                                                                                                                     | Proposed resolution                                                                                                                                                                                                                                        |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | correctness   | `packages/contracts/src/runtimes.ts` (`RUNTIME_PROFILE_BOUNDS`): "_`cpu` is a count of cores and may be fractional (`0.5`)_", and `packages/core/src/schemas.ts` `RuntimeProfile.cpu` accepts `0.5`. But `runtime_profiles.cpu` is `integer('cpu')`, so `POST /api/runtime-profiles { cpu: 0.5 }` passes validation and fails in PostgreSQL (`22P02`, not classified by `runtime-profiles.ts`'s `classifyWriteFailure`), which is expected to surface as a 500. The HTTP outcome was not reproduced against a database.                                                                                                                                    | `Meta.contract_cpu_fraction_is_not_storable`; `RuntimeProfile.cpuAccepted` vs `integerColumnAccepts`                                                                     | Issue or ADR. Store `cpu` as `numeric` (or millicores as an integer), or restrict the contract and the docs to whole cores. Add a repository test that creates `cpu: 0.5`.                                                                                 |
| 2   | correctness   | `04-api-specification.md` §5.4: "_`memoryMb`/`diskMb`/`timeoutSeconds`/`idleTimeoutSeconds` positive safe integers with no ceiling_". The columns are 32-bit `integer`s, so `2^31` passes the contract and overflows (`22003`).                                                                                                                                                                                                                                                                                                                                                                                                                            | `Meta.contract_size_bound_exceeds_the_integer_column`                                                                                                                    | Issue. Cap at `2147483647` in `RUNTIME_PROFILE_BOUNDS`, `schemas.ts` and the docs, or widen the columns to `bigint`.                                                                                                                                       |
| 3   | correctness   | `runtime_profiles.runtime_connection_id` references any `secrets` row of the workspace. A profile can name a plain secret or a model-connection credential as its "runtime connection". §5.5 already names this ("_the convention is a naming one until RF-204 replaces it with typed foreign keys_").                                                                                                                                                                                                                                                                                                                                                     | `Refinement.current_diverges_from_typed_runtime_connections`; target `runtimeConnectionsTyped`                                                                           | ADR (RF-204): a `runtime_connections` table, or a secret `kind` column with a check and a composite key that includes it. Until then, check the purpose in the profile repository.                                                                         |
| 4   | correctness   | `decodeDriver` does not check the catalogue. An owner-created secret named `RUNTIME_CONNECTION__FOO__X` (or `RUNTIME_CONNECTION____X`) lists under `GET /api/runtime-connections` with driver `foo` (or `""`), and `RuntimeConnectionResourceSchema` rejects that body. The replay confirms this against the real store and schema.                                                                                                                                                                                                                                                                                                                        | `Meta.decoded_driver_may_be_outside_the_catalogue`; `RuntimeProfile.decodeKnownDriver`                                                                                   | Issue. Filter `list()` by `runtimeDriverIds`, or refuse the reserved prefixes in `parseSecretName`.                                                                                                                                                        |
| 5   | naming        | The names reserved for credentials and runtime connections are ordinary secret names. `POST /api/secrets` accepts `RUNTIME_CONNECTION__DOCKER__FORGED` and `MODEL_CONNECTION_…`, and `GET /api/secrets` lists runtime connections and credentials (documented in §5.5 and in the `connections.ts` header). Secrets are Owner-only, so this is not an escalation.                                                                                                                                                                                                                                                                                           | `Meta.reserved_names_are_ordinary_secret_names`; `Secret.purposeOf`                                                                                                      | Record. Resolved by the RF-204 ADR together with finding 3.                                                                                                                                                                                                |
| 6   | documentation | The label encoding is not injective (`primary host` and `PRIMARY_HOST` both store `RUNTIME_CONNECTION__DOCKER__PRIMARY_HOST`, so the second create is a `409`). The code documents this, but §5.4 does not.                                                                                                                                                                                                                                                                                                                                                                                                                                                | `Meta.connection_label_encoding_collides`                                                                                                                                | Docs fix in §5.4: "names that differ only in case or punctuation conflict".                                                                                                                                                                                |
| 7   | correctness   | §5.3: "_Model choice on an agent, project, or run is always the pair `(modelConnectionId, model)`, never one without the other._" `agents` (and `runs`) have no pair check. Deleting a connection sets `agents.model_connection_id` to `NULL` and leaves `agents.model`, which is exactly an agent with a model and no connection. The repository clears the pair for workspaces and projects only.                                                                                                                                                                                                                                                        | `Meta.agent_model_may_outlive_its_connection`, `Meta.set_null_alone_breaks_the_default_model_pair`, `Invariants.default_model_is_set_with_its_connection`                | Issue. Add an `agents_model_pair` check and clear `agents.model` in the same transaction as the workspace and project defaults, or state in §5.3 what an orphaned `model` means. How agent resolution treats such a row was not verified.                  |
| 8   | naming        | A model connection's credential has no foreign key: it is found by the name `MODEL_CONNECTION_<id>`, and orphans are reconciled by prefix (`reconcileOrphanedCredentials`). The `schema/model-connections.ts` header still says the credential is future work.                                                                                                                                                                                                                                                                                                                                                                                             | `Meta.model_connection_credential_has_no_foreign_key`                                                                                                                    | ADR (RF-204): a `credential_secret_id` composite key like `mcp_servers`. Fix the stale header comment in a docs PR.                                                                                                                                        |
| 9   | correctness   | The contract accepts a runtime-profile name made of spaces (`z.string().min(1)`), but `runtime_profiles_name_not_blank` refuses it, and `classifyWriteFailure` does not map the `23514`. A tab-only name passes both, because `btrim` strips spaces only. `model_connections` has no name check at all; only the route trims.                                                                                                                                                                                                                                                                                                                              | `Meta.blank_profile_name_passes_the_contract_but_not_the_check`, `Meta.model_connection_name_has_no_database_check`                                                      | Issue. Give the profile name a trimmed non-blank refinement in `schemas.ts`, and add `model_connections_name_not_blank` in a migration. Decide once whether "blank" means spaces only or all whitespace.                                                   |
| 10  | naming        | `docs/formal/inventory.md` §4: "_`ModelConnectionResource`, `SecretResource`, `ApiKeyResource` and `InvitationResource` carry no `workspaceId`_". Within this cluster only `RuntimeProfileResource` carries one.                                                                                                                                                                                                                                                                                                                                                                                                                                           | `Meta.only_the_profile_resource_carries_workspace_id`                                                                                                                    | Record for the contracts phase. Drop the field at the next major, or document why profiles carry it.                                                                                                                                                       |
| 11  | correctness   | The references into `secrets` disagree on deletion: a connector's credential is `RESTRICT` and a profile's connection is `SET NULL`. Once `secrets.remove` (S-10) exists, deleting a connector's credential will be refused while deleting a profile's connection will silently detach it.                                                                                                                                                                                                                                                                                                                                                                 | `Meta.secret_references_disagree_on_delete`                                                                                                                              | Decide in the S-10 ADR: one behaviour, with its problem code.                                                                                                                                                                                              |
| 12  | naming        | `parseCreateRuntimeConnectionInput` reads `name`, `driver`, `endpoint` and `credential` and ignores every other key, while `parseCreateModelConnection`, `parseUpdateModelConnection`, `parseCreateSecretBody`, `parseReplaceSecretBody` and `CreateRuntimeProfileInput` (`.strict()`) refuse an unknown key with `400`. `04-api-specification.md` states no rule for unknown request keys. The replay confirms both behaviours.                                                                                                                                                                                                                           | `Meta.runtime_connection_create_ignores_unknown_fields`; `RuntimeProfile.connectionCreateAccepts` (open) vs `Secret.closedBodyAccepts`                                   | Issue. Refuse unknown keys in `parseCreateRuntimeConnectionInput` as the other configuration parsers do, and state the rule once in `04-api-specification.md` §4.                                                                                          |
| 13  | documentation | `connections.ts` documents `encodeSegment` as mapping "every character outside `secrets.name`'s alphabet" to `_`, but it upper-cases first with Unicode-aware `toUpperCase`, so `straße` stores `…__STRASSE`, `ıd` stores `…__ID` (colliding with `id`) and `ﬁle` stores `…__FILE`. The label is not only non-injective (finding 6) but also changes length.                                                                                                                                                                                                                                                                                               | `Meta.connection_encoding_model_is_ascii_only`; `RuntimeProfile.jsUpperCaseDivergences`                                                                                  | Docs fix in the `connections.ts` comment and §5.4, or map every character outside `[A-Za-z0-9]` to `_` before upper-casing so the encoding is ASCII-only and length-preserving.                                                                            |
| 14  | correctness   | `04-api-specification.md` §5.4: "_`driverConfig.image` must be a `sha256`-pinned reference on create._" `parseCreateRuntimeProfileInput` enforces it for **every** driver including `local`, while its error text says "_non-local runtime profiles must pin an image by sha256 digest_". `parseUpdateRuntimeProfilePatch` does not apply the rule at all, so the pin holds on create only (as the sentence says, but a later `PATCH` can replace a pinned image with a tag). Today no driver reads `driverConfig.image` (the image comes from the host's driver options, which enforce their own `requireDigest`), so the gap is latent, not exploitable. | `Meta.image_rule_ignores_the_driver`; `RuntimeProfile.createImageAccepted`, `isSha256Pinned`; cell theorems `<driver>_profile_create_requires_a_pinned_image`            | Issue. Apply the same pin rule in `parseUpdateRuntimeProfilePatch` (and state "on create and update" in §5.4) before any driver starts reading `driverConfig.image`; fix the error text to drop "non-local", or exempt `local` if that is the intent.      |
| 15  | naming        | Blank names disagree across the cluster: model-connection and runtime-connection names are refused when blank after JavaScript `trim` (so a name of one U+3000 is refused), the runtime-profile contract accepts any non-empty name and its database check strips spaces only (so U+3000 or a tab is a valid profile name), and a model-connection `apiKey` or runtime-connection `credential` of spaces is accepted.                                                                                                                                                                                                                                      | `Meta.blank_name_rules_disagree`; `ModelConnection.nameAccepted`, `RuntimeProfile.connectionTextAccepted`, `RuntimeProfile.nameAcceptedByContract`, `Secret.sqlNotBlank` | Decide once (ADR or `04` §4): "a name is not blank after JavaScript `trim`" for every configuration name, enforced by the contract and mirrored by a `CHECK` that uses a regex over the same set. Keep credentials as opaque non-empty strings and say so. |
| 16  | documentation | Roadmap S-19 (`04` §8) says `PATCH` will accept `null` for "_the nullable sizing fields and `runtimeConnectionId`_", but `allowedDomains`, `persistPaths` and `driverConfig` are nullable on the resource too and the row does not say whether they can be cleared.                                                                                                                                                                                                                                                                                                                                                                                        | `Refinement.s19_target_clears_sizing_but_not_required_fields`; `RuntimeProfile.s19ClearableFields`                                                                       | Docs fix in the S-19 row: name the clearable fields exactly (the model reads "sizing" as `cpu`, `memoryMb`, `diskMb`, `timeoutSeconds`, `idleTimeoutSeconds`).                                                                                             |

No security finding: every reference that touches the cluster is tenant-paired, T3 proves that a
cross-workspace pointer is refused in every state, and the name-convention issues (findings 3 to 5) are reachable only by the Owner, who can already read and write every secret. Finding 14 is
supply-chain relevant but latent: no driver consumes `driverConfig.image` today.

## Gaps

- **No operations; T2 is state invariants, not preservation.** Every Invariants theorem states
  a property of every consistent state, as in `er-core`; none states that an operation preserves
  it. Create, update, rotate, delete and the repository's pair-clearing step belong to Phase 4,
  which must carry these invariants forward as preservation theorems. The pair finding is shown
  statically (`set_null_alone_breaks_the_default_model_pair`), not by an operation.
- **Problem codes are not modelled.** The §5.3–§5.5 problem codes (`invalid_model_connection_id`,
  `model_connection_not_found`, `model_connection_name_conflict`, `invalid_body`,
  `invalid_runtime_profile_id`, `runtime_profile_not_found`, `unknown_runtime_connection`,
  `runtime_profile_name_conflict`, `runtime_connection_name_conflict`, `secret_name_conflict`,
  `invalid_secret_id`, `secret_not_found`, the `*_runtime_not_configured` codes and
  `network_policy_not_enforceable`) have no definition here. The parsers are modelled as
  accept/refuse only; mapping a refusal or a store outcome to its code belongs to the Contracts
  and Behaviour phases.
- **Key-level and value-level rules are separate.** The request parsers are modelled over key
  sets with every present value valid, and the value rules as separate predicates; the model does
  not combine them into one parser over JSON bodies (for example a body with an unknown key _and_
  a blank name). The profile value bounds (`cpu`, sizes) and the image rule are the only
  profile value rules modelled; `allowedDomains`/`persistPaths` element rules (`min(1)`) are not.
- **The image rule on update.** `parseUpdateRuntimeProfilePatch` is replayed only with
  `driverConfig: {}`; its (absent) image rule is recorded as finding 14, not vectored.
- **Private encoder.** `encodeSecretName`, `encodeSegment` and `decodeDriver` are private to
  `connections.ts`, so they are replayed through the two stores' `create` and `list`.
  `PROVIDER_CONFIG_SPEC` is private, so it is replayed through the parsers and through the
  exported contract table.
- **No PostgreSQL oracle.** The `integer` range and the `btrim` semantics are compared with the
  Drizzle column type and the snapshot's `CHECK` body, then evaluated in TypeScript. Findings 1,
  2 and 9 were not reproduced against a database in this unit.
- **Egress and URLs are not modelled.** The config vectors use a valid absolute URL and an
  egress stub that allows it. Unknown config keys (`config.foo`) are not modelled.
- **Operations target.** `Secret.operationsTarget` (adding `remove`, S-10) is documentation only:
  the replay checks that today's store has exactly `operationsCurrent` and no `remove`.
- **Unicode upper-casing.** The model upper-cases ASCII only. Its encoding claims are faithful
  on ASCII labels (`isAsciiLabel`). The three recorded non-ASCII divergences are pinned against
  the real store, but no general model of Unicode case mapping exists.
- **`secret-names.json` purposes.** They are replayed only through the runtime-connection
  listing. The model-connection prefix constant is private to `models/store.ts`.
- **No crypto.** `resolveByName`, the envelope cryptography and the master-key providers are not
  modelled. `Envelope` records sizes only.
- **Concept enums versus contract modules.** The DB-level enums live in `Concepts`. A Phase 2
  contract module has to redeclare them, because `Contracts` cannot import `Concepts`.
