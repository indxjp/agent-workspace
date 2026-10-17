# Unit `concept-identity` — the identity cluster (phase P1b)

Workspaces, users and their OIDC identities, memberships and roles, principals (durable and
authenticated), API keys, invitations and browser tokens: one Lean module per concept, today's
eight tables with the meaning of every check, and theorems on cardinality, composite-key tenancy,
one-of shapes, uniqueness and the documented sentences about these concepts.

| File                                                                                                                | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formal/AgentWorkspace/Concepts/Workspace.lean`                                                                     | `Workspace` (the tenant), `WorkspaceState` (`active`/`archived`), `Instant` and its row encoding, `notBlank`, `slugFormat`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `formal/AgentWorkspace/Concepts/User.lean`                                                                          | `User`, `UserIdentity` (OIDC `(issuer, subject)`), `emailShape`, `lowercase`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `formal/AgentWorkspace/Concepts/Membership.lean`                                                                    | `Role` (a `WireEnum`), `parseRole`, `Membership`, its row codec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `formal/AgentWorkspace/Concepts/ApiKey.lean`                                                                        | the `ak_live_` constants, `bearerShaped` (the anchored fixed-length bearer grammar both credentials share), `presentedShaped` (`API_KEY_PATTERN`) and `displayPrefixShaped` (`API_KEY_DISPLAY_PREFIX_PATTERN`), `ApiKey`, `ApiKeyState`, `live` (the key half of `authenticateApiKeyHash`), resource and credential field lists                                                                                                                                                                                                                                                                                                                                                                                 |
| `formal/AgentWorkspace/Concepts/BrowserToken.lean`                                                                  | `ScopeKind`, `Scope` (run xor session as a sum type), TTL bounds, the `awt_live_` constants and `presentedShaped` (`BROWSER_TOKEN_PATTERN`), `BrowserToken`, `TokenState`, `live` (the token row's half), `scopeOfRow?`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `formal/AgentWorkspace/Concepts/Principal.lean`                                                                     | `Kind` (wire and storage spellings), `Source` (membership xor API key), durable `Principal`, `PrincipalState`, `active`, `sourceOfRow?`; **admission** — `apiKeyAdmitted` (`authenticateApiKeyHash`: key live and its principal row not revoked), `principalResolves` (`principalById`: principal active and its membership still present or its key live), `ScopedRow` (with `ScopedRow.scope`) / `scopeOpen` and `browserTokenAdmitted` (`resolveBrowserTokenActor`, spec §3.1.1 "Revocation"); the authenticated principal `Actor`, `Via`, `wellFormed` (`isPrincipal`), the constructors `fromDirectoryRecord` / `fromApiKey` / `fromBrowserToken`, `MeResponse` with its `…Current` / `…Target` acceptance |
| `formal/AgentWorkspace/Concepts/Invitation.lean`                                                                    | `Invitation`, `InvitationState` and `stateAt` (`invitationStateOf`), `unresolved` (the partial index's notion of pending), resource and credential field lists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `formal/AgentWorkspace/Er/Current/Identity.lean`                                                                    | the eight tables, `CheckExpr` (a SQL fragment with three-valued `eval` and a `render` equal to the snapshot's text), the 31 refined `checks` and their boundary `samples`, typed rows, `consistent`, `relationships` with parent/child `Multiplicity`, `everySourceHasPrincipal` / `consistentTarget` (RF-101), and the `Lemmas` on consistent states                                                                                                                                                                                                                                                                                                                                                           |
| `formal/AgentWorkspace/Theorems/{WellFormed,Normative,Invariants,Adversarial,Refinement,Meta}/ConceptIdentity.lean` | the theorems, by tier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `formal/Vectors/ConceptIdentity.lean` → `formal/generated/vectors/concept-identity/`                                | `enums`, `checks`, `relationships`, `uniques`, `principals`, `actors`, `me`, `invitation-states`, `token-ttl`, `bearers`, `display-prefixes`, `constants` (284 vectors)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/web/formal/concept-identity.test.ts`                                                                          | replays them against the real TypeScript (288 tests); in `apps/web` per D-012 because it imports `apps/web/server/rbac/*` and `apps/web/components/team/invitations-model.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Modelling decisions

- **Owner and actor (S1-24, issue #509, migration 0035).** `workspace_principals` gained
  `acts_for_principal_id`, the self-referencing tenant-paired key
  `workspace_principals_acts_for_workspace_fk` (`NO ACTION`) and two refined checks
  (`workspace_principals_acts_for_api_key_only`, `workspace_principals_acts_for_not_self`, the
  `CheckExpr` shapes `nullOrEquals` and `nullOrDistinct`). `Principal.actsFor`, `Actor.ownerPrincipalId`
  and the `actsForPrincipalId` of `ApiKeyIdentity` and `DirectoryRecord` model the new fields:
  `fromApiKey` owns through `actsFor.getD principalId`, `fromDirectoryRecord` does so for an API-key
  record only (a membership owns what it writes), and `fromBrowserToken` copies the minter's owner.
  `Actor.wellFormed` requires owner = principal unless the kind is an API key. Admission and
  resolution (`apiKeyAdmitted`, `principalResolves`, `browserTokenAdmitted`) take the re-read
  acts-for principal as an optional `ActsForRow` (absent means not found, so an acting key is
  refused) and require it to be the named, active membership principal of the same workspace with
  its membership present (`actsForStands`). The repair the local start runs before the sweep is the
  pure `reassignLocalOwnership` / `backfillActsFor` / `repairLocalOwnership` over owned rows, proved
  idempotent and to leave every row no local key owns unchanged
  (`Invariants.reassign_local_ownership_is_idempotent`, `repair_local_ownership_is_idempotent`,
  `repair_keeps_rows_no_local_key_owns`, `repair_leaves_no_row_owned_by_a_local_key`);
  `Normative.hosted_api_key_owns_what_it_writes`, `local_key_owns_through_the_principal_it_acts_for`,
  `membership_owns_what_it_writes`, `browser_token_owns_and_acts_as_its_minter`,
  `Invariants.owner_differs_from_the_actor_only_for_an_api_key`,
  `owner_is_the_actor_or_the_principal_it_acts_for` and
  `Adversarial.key_never_outlives_the_principal_it_acts_for` carry the rest. The repair is not
  replayed by a vector (it is a database transaction; `packages/core`'s
  `local-runtime-ownership.test.ts` exercises it against PostgreSQL), and `Authz/Tenancy.lean`'s
  state-level `authenticateApiKey` / `principalById` do not model the acts-for join (their theorems
  are about workspace selection, which the extra conjunct only narrows).

- **One-of shapes are sum types.** A principal's source is `Source.membership m | Source.apiKey k`
  and a browser token's scope is `Scope.run r | Scope.session s`. The database's XOR checks are then
  theorems about `toRow` (`principal_row_is_admitted`, `browser_token_row_is_admitted`) and about
  decoding (`principal_source_round_trips`, `browser_token_scope_round_trips`); on an arbitrary
  row the decoders succeed exactly when the XOR check evaluates to `TRUE`
  (`source_of_row_decodes_iff_source_xor_is_true`, `scope_of_row_decodes_iff_scope_xor_is_true`, and
  the `…_holds` forms for a row with a kind), and in every consistent state every row decodes to
  exactly one (`principal_row_has_one_source`, `browser_token_row_has_one_scope`).
- **Every check has a meaning.** `Er/Core.lean` records 25 checks of these tables by name only.
  `CheckExpr` gives each a meaning in SQL's three-valued logic (a check passes unless it is
  `FALSE`). Its `render` is compared, at elaboration time, with the body `drizzle-kit` recorded in
  `migrations/meta/0025_snapshot.json` (`<check>_renders_as_snapshot`), so the meaning cannot drift
  from the DDL. Its `eval` is pinned on boundary rows (`<check>_separates_its_samples`).
- **Time is an input.** `Instant` is milliseconds since the epoch; a timestamp cell is its decimal
  numeral, read by `parseInstant?` (written over `String.toList` so the kernel can evaluate sample
  rows, with `parseInstant?_instantText` as its round trip). States (`stateAt`, `live`) take `now`.
- **Two principals.** The durable `workspace_principals` row (`Principal`) and the authenticated
  frozen object handlers receive (`Actor`, mirroring `apps/web/server/rbac/principal.ts`) are kept
  apart; `Actor.wellFormed` is the structural half of `Principal.isPrincipal`.
- **Admission has a row half and a principal half.** `ApiKey.live` and `BrowserToken.live` are
  only the credential row's own filter. `apiKeyAdmitted` adds the joined `workspace_principals`
  row (`revoked_at IS NULL`, directory.ts `authenticateApiKeyHash`); `browserTokenAdmitted` adds the
  scoped run or session (present, the one the scope names, not terminal) and the minter
  (`principalById`: principal active, membership present or key live). The scoped row and the
  source row are inputs (`Option ScopedRow`, `SourceRow`), so the model states what the resolver
  decides from what it reads, not how it reads it. `now` abstracts `greatest(now(), $now)`.
- **`Role` lives in `Concepts/Membership.lean`** because the concept layer is the first to need it.
  The Phase 2 contracts unit for `team` mirrors the same wire enumeration; the synthesis should
  make one import the other.
- **`consistent` refines `Er.Core.consistent`** with the 31 refined checks and cell typing on the
  eight tables. Most T2 theorems need only `Er.Core.consistent`; the scope decoding needs the refined
  `browser_tokens_scope_xor`, which `Er/Core.lean` does not interpret.
- **Helper lemmas are public in `Er/Current/Identity.lean` (`Lemmas`).** The `er-core` ones are
  private to their theorem file, and the Invariants and Adversarial files both need them. They
  carry no `@[aw_spec]` and are not catalogue entries.
- **Multiplicities are derived, then checked twice.** `parentMultiplicity` (every key column
  `NOT NULL` → exactly one parent) and `childMultiplicity` (the child's key columns form a key →
  at most one child) are computed from `catalogue`; the generated T2 theorems prove what they claim
  in every consistent state, and the suite re-derives both from the live Drizzle objects.

## Theorems (211 theorems, 173 catalogued definitions)

- **T0 (84).** Bounds: `identity_bounds_mirror_the_contracts` (API-key name 120, invitation token
  4096, user email 320, user and workspace name 200). Enumerations: `role_wires_match_contract`, `role_json_round_trips`,
  `parse_role_refuses_unknown_spelling`, `role_checks_hold_the_four_roles`,
  `principal_kind_wires_match_contract`, `principal_kind_storage_matches_schema`,
  `principal_kind_storage_round_trips`, `wire_kind_maps_storage_to_wire`,
  `scope_kind_wires_match_contract_and_schema`, `via_wires_match_server`, `invitation_state_wires`.
  Checks: `refined_checks_cover_the_cluster`, and the generated `<check>_renders_as_snapshot` and
  `<check>_separates_its_samples` for all 25 checks; `source_xor_refines_core` (the three-valued
  reading equals `Er/Core.lean`'s `principalSourceXor` whenever `kind` is set). Codecs:
  `principal_source_round_trips`, `browser_token_scope_round_trips`, `membership_row_round_trips`;
  the decoders against the XOR checks on **arbitrary** rows:
  `source_of_row_decodes_iff_source_xor_is_true`, `source_of_row_decodes_iff_source_xor_holds`,
  `scope_of_row_decodes_iff_scope_xor_is_true`, `scope_of_row_decodes_iff_scope_xor_holds`.
  Constructors: `from_api_key_is_well_formed`, `from_directory_record_well_formed_iff_coherent`,
  `from_browser_token_is_well_formed`; `isPrincipal`'s scope invariant on **hand-built** actors:
  `well_formed_actor_has_a_scope_iff_via_browser_token`,
  `actor_with_a_scope_its_verifier_does_not_carry_is_refused`. Concept values are admitted rows:
  `{workspace,user,user_identity,membership,principal,api_key,invitation,browser_token}_row_is_admitted`
  (every column known, every `NOT NULL` set, well typed, every closed-set and refined check passing).
- **T1 (36).** Bearers: `presented_bearers_follow_the_credential_table` ("`ak_live_<22>_<43>`",
  "`awt_live_<22>_<43>`": prefixes, half lengths, and the grammar accepting exactly those lengths),
  `browser_token_grammar_is_the_api_key_grammar`, `display_prefix_cannot_authenticate`
  ("`ak_live_<key id>` … cannot authenticate": a display-prefix-shaped string is neither a presented
  key nor a presented token). §3.1.1 "Revocation": `browser_token_revocation` (expiry, a terminal
  scoped run, an archived scoped session, a revoked minter each stop a token). Admission, the
  principal half (definition checks of the resolvers, T1 since they are one call each, not state
  invariants): `revoked_principal_never_admits_its_api_key` (inventory §2, "Revoking an API key sets
  … `workspace_principals.revoked_at`"), `api_key_is_admitted_only_through_its_own_principal`,
  `browser_token_dies_with_its_minter`, `removed_membership_no_longer_resolves` (a deleted membership
  stops resolving its principal and every token it minted),
  `api_key_minter_resolves_only_through_its_own_live_key` (the key row read must be the principal's
  own key, live), `membership_minter_resolves_iff_active_and_present`,
  `browser_token_without_its_scoped_row_is_refused`. Sentences: "exactly one of four roles"; "a
  membership or an API key … never a bare user"; "an API key has no user behind it and no membership
  row"; "one role fixed at mint time"; "`userId` is `null` for exactly an API-key principal"; the role
  is on the membership, not the user; every identity row belongs to exactly one workspace; a slug
  selects at most one workspace; at most one role per workspace (the `memberships_workspace_user_key`
  comment); "one (issuer, subject) binds to exactly one user"; principal sources cascade;
  **identity decides neither tenant nor role** (`identity_determines_neither_tenant_nor_role`, the
  architecture rule "a session proves identity; RBAC proves permission; a repository scope proves
  tenant selection. None substitutes for another": **no function of the user alone** yields, over
  every consistent state, the workspace or the role of that user's memberships, while the pair
  (workspace, user) does fix the role in every consistent state); credential hashes are globally
  unique; credentials never appear in resources; a browser token carries no role; "attenuation, not
  a fourth identity"; "scoped to exactly one run or session"; the TTL bound; API-key state
  precedence; invitation state precedence; "never both accepted and revoked"; "an expired row …
  continues to block a duplicate"; `invited_by` is a user that may be deleted; the default model is
  one pair; archived iff stamped.
- **T2 (72).** Admission over time: `api_key_admission_is_lost_for_good`,
  `browser_token_admission_is_lost_for_good`; bearers:
  `no_bearer_is_both_an_api_key_and_a_browser_token`; RF-101 coverage target, universally:
  `target_gives_each_membership_exactly_one_principal` and
  `target_gives_each_api_key_exactly_one_principal` (in every consistent state meeting the target,
  each source has exactly one principal row naming it, in its own workspace). Generated per foreign
  key of the cluster (15 keys): `<fk>_keeps_one_workspace` (12, every key that carries a workspace,
  instantiating `er-core`'s `reference_preserves_tenant`), `<fk>_parent_is_unique` (15),
  `<fk>_is_required` (12, every key over `NOT NULL` columns), `<fk>_child_is_unique` (2: one
  principal per membership, one per API key). Generated per total unique key (12):
  `<key>_identifies_a_row` (a key hash, a token hash, an email, a slug, an OIDC pair, a membership per
  user and workspace, an API-key name per workspace, …). By hand: `principal_row_has_one_source`,
  `browser_token_row_has_one_scope`, `membership_links_exactly_one_user_and_one_workspace`,
  `membership_principal_has_exactly_one_membership`, `api_key_principal_has_exactly_one_api_key`, and
  time: `api_key_liveness_is_lost_for_good`, `api_key_live_iff_active`,
  `browser_token_liveness_is_lost_for_good`, `browser_token_live_iff_active`,
  `invitation_resolution_is_stable`.
- **T3 (10).** Whatever id a writer copies into a row: `foreign_principal_cannot_mint_a_browser_token`,
  `foreign_run_cannot_scope_a_browser_token`, `foreign_session_cannot_scope_a_browser_token`,
  `foreign_membership_cannot_back_a_principal`, `foreign_api_key_cannot_back_a_principal` (the key
  pins a parent in the child's workspace and the parent's `id` is its primary key, so the named row
  is that parent); `forged_principal_source_is_refused` (a concrete forged state is inconsistent).
  Whatever scoped row and principal row a request resolves:
  `browser_token_acts_only_on_its_own_scoped_row` (the admitted row's scope is the token's scope),
  `token_for_one_run_cannot_act_on_another_run` ("a token minted for run R cannot act on run R′"),
  `token_for_one_session_cannot_act_on_another_session`,
  `browser_token_acts_only_as_its_minter_in_its_workspace` (an admitted token's minter row has the
  token's `mintedBy` id and the token's workspace).
- **T4 (4).** `principal_coverage_target_refines_current` and
  `principal_coverage_target_is_satisfiable` (RF-101); `me_schema_target_refines_current` and
  `me_rules_agree_on_well_formed_principals`.
- **T5 (5).** `slug_bound_is_off_by_one`, `admitted_slugs_are_shorter_than_the_contract_bound`,
  `blank_checks_admit_whitespace_other_than_spaces`, `core_source_xor_differs_from_sql_at_null_kind`,
  `from_directory_record_accepts_an_incoherent_record`.

**Witnesses.** `Invariants.ConceptIdentity.Witness.state` is consistent under both `consistent`s
and the RF-101 target: two workspaces (the first with a default model connection), Ada as Owner of
the first and Viewer of the second, Bob as Builder of the first, an OIDC binding, three membership
principals, an API key and its principal, an invitation, a connection, an agent, a session, a run,
a run-scoped token minted by the key and a revoked session-scoped token minted by Ada. It
references through every foreign key of the cluster (proved by `findRef`), gives every unique key a
row, and every hand-written T2/T3 theorem with hypotheses has an `example` satisfying them (on it,
or on concrete concept values). Each admission theorem's example shows both verdicts (the admitted
case and the refused one). The T4 divergence uses a state with a membership and no principal; the
workspace half of RF-101 coverage is shown necessary by an `example` on a crossed state (a
principal of another workspace naming the source's id does not cover it).

**Mutation coverage.** Checked by mutating the model and rebuilding the six theorem modules, each
mutation fails at least one theorem:

| Mutation (in `Concepts/Principal.lean`)                                           | Caught by                                                                                                                   |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `browserTokenAdmitted` drops `minter.workspace == t.workspace` (M1)               | `Adversarial.browser_token_acts_only_as_its_minter_in_its_workspace` and its example                                        |
| `scopeOpen` drops `r == r'` in the run branch (M2)                                | `Adversarial.browser_token_acts_only_on_its_own_scoped_row`, `token_for_one_run_cannot_act_on_another_run`                  |
| `principalResolves`: a removed membership still resolves (`present` → `true`, M4) | `Normative.removed_membership_no_longer_resolves`                                                                           |
| `Actor.wellFormed` drops the via/scope conjunct (M9)                              | `WellFormed.well_formed_actor_has_a_scope_iff_via_browser_token` and its example; the `actors.json` replay of `isPrincipal` |
| `sourceOfRow?`'s membership arm accepts a row with `api_key_id` set (M11)         | `WellFormed.source_of_row_decodes_iff_source_xor_is_true` and its example                                                   |
| `principalResolves`'s key branch drops `k.id == id` (M12)                         | `Normative.api_key_minter_resolves_only_through_its_own_live_key` and its example                                           |

Beyond these: changing any refined check's meaning or SQL fails its `<check>_renders_as_snapshot`
or `<check>_separates_its_samples` (and the suite's comparison with the snapshot). Loosening the
three-valued logic fails the samples with a `NULL` column. Dropping any other conjunct of
`Actor.wellFormed` fails `from_directory_record_well_formed_iff_coherent` (removing `apiKeyId.isNone`
for a membership breaks it) and the `actors.json` replay, which is exhaustive over kind × verifier ×
scope × user-id presence × key-id presence (72 hand-built instances). Swapping two role, kind or
scope spellings fails the `*_wires_*` theorems and the enumeration replay. Changing a foreign key's
columns or nullability changes its multiplicities and fails the relationship replay; removing a key
of the parent fails the generated `_parent_is_unique` (`coversKey` by `decide`). Letting a concept's
`toRow` omit a `NOT NULL` column or write the other source column fails its `_row_is_admitted` and
round-trip theorems. Changing any identity constant fails `identity_bounds_mirror_the_contracts` or
`presented_bearers_follow_the_credential_table`, and the suite compares each constants vector with
the contracts export and, where `apps/web/server/rbac` keeps its own copy, with that too. Dropping
either `workspace_id` equality from `everySourceHasPrincipal` breaks the crossed-state `example`
and, for the target theorems, their uniqueness proof over `(workspace_id, source)`.

## Glossary

One meaning per term. Where today's code or documents use a term for something else, the alias
is listed and, where it is a conceptual problem, it is a finding below.

| Term                                               | Meaning                                                                                                                                                                                                                       | Today's aliases and conflations                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace**                                      | The tenant: the isolation boundary every tenant-owned row belongs to exactly one of. A row of `workspaces`, whose own `id` is its tenant column. Selected by `id` or by its unique `slug`.                                    | The session token carries the tenant as the **slug** (`claims.ws`); repository scopes carry the **id**. `SessionWorkspace` holds both.                                                                                                                                          |
| **User**                                           | A global human identity: a lower-case, unique email and a display name. Carries no workspace and no role.                                                                                                                     | Session identity is keyed by **email** (`claims.sub`), not by the user id or the OIDC subject (finding 9).                                                                                                                                                                      |
| **User identity**                                  | One OIDC `(issuer, subject)` pair bound to exactly one user, forever.                                                                                                                                                         | —                                                                                                                                                                                                                                                                               |
| **Membership**                                     | One user in one workspace with exactly one role; at most one per (workspace, user). The human source of a principal.                                                                                                          | 04 §1.1 defines a membership principal as "a user in a workspace, with a role", which is the membership, not the durable principal row (which has no role).                                                                                                                     |
| **Role**                                           | One of `owner`, `admin`, `builder`, `viewer`, carried by a membership, an API key or an invitation. Not a privilege order.                                                                                                    | Session claims also carry `role: 'owner'`, always, and it is ignored (finding 10).                                                                                                                                                                                              |
| **Principal** (durable, `WorkspacePrincipal`)      | A row of `workspace_principals`: the workspace-local identity that owns rows and receives authorisation decisions. Exactly one source (a membership or an API key), an activation and a revocation stamp. Never a bare user.  | "Principal" also names the authenticated object (next row), and the RF-101 `ActorContext`.                                                                                                                                                                                      |
| **Authenticated principal** (`Actor` in the model) | What a verified credential resolves to for one request: the durable principal's id, kind and workspace, the role read from its source _now_, a display label, the verifier (`via`) and, for a browser token only, a scope.    | The TypeScript class is named `Principal`; its `actor` field is a compatibility display string (email or key label), not an identity (finding 4).                                                                                                                               |
| **Principal kind**                                 | `membership` or `api-key` (wire).                                                                                                                                                                                             | Stored and typed server-side as `api_key` (er-core finding 5).                                                                                                                                                                                                                  |
| **Credential / verifier (`via`)**                  | How the caller proved identity: `session`, `api-key`, or `browser-token`.                                                                                                                                                     | A browser token is not a third identity kind: its `via` is `browser-token` but its kind is the minter's.                                                                                                                                                                        |
| **API key**                                        | A machine credential of one workspace with one fixed role; it _is_ its principal's source. Stored as a globally unique SHA-256 hash and a displayable prefix.                                                                 | The `api_keys` header calls the role "§22's permissions".                                                                                                                                                                                                                       |
| **Invitation**                                     | An offer of one role in one workspace to one email, redeemed once with an expiring secret; accepting creates a membership. States derived from timestamps: revoked > accepted > expired > pending.                            | The partial unique index's "pending" is **unresolved** (not accepted, not revoked), which includes expired rows. `invited_by` is a **user** id, the pre-RF-101 attribution vocabulary (finding 15).                                                                             |
| **Browser token**                                  | A short-lived bearer minted by a session or API-key principal, attenuating it to exactly one run or one session. Carries no role.                                                                                             | —                                                                                                                                                                                                                                                                               |
| **Minter**                                         | The durable principal that minted a browser token (`minted_by_principal_id`); re-resolved on every request.                                                                                                                   | —                                                                                                                                                                                                                                                                               |
| **Label**                                          | Display attribution (a member's name or a key's name). Never an authorisation input.                                                                                                                                          | `actor` (same role, different spelling).                                                                                                                                                                                                                                        |
| **Identity / permission / tenant selection**       | Three separate questions: who is calling (a verified credential → a principal), what that principal may do (its role, via RBAC), which workspace's rows a query may touch (a repository scope). None substitutes for another. | Conflated where identity is keyed by a mutable attribute (email) and where a token carries a role it does not use (findings 9, 10). `identity_determines_neither_tenant_nor_role` states that no function of the user decides either, while (workspace, user) decides the role. |

## Findings

No security finding: every reference between identity rows is tenant-paired and the T3 theorems
hold against today's schema. The `er-core` findings 4 and 5 (the "exactly two tables" comments and
the `api_key` spelling) apply to this cluster too and are not repeated.

| #   | Severity      | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Where                                                                                                                                        | Lean                                                                                                                                                                                                                                                                                              | Proposed resolution                                                                                                                                                                                            |
| --- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | documentation | `packages/contracts/src/workspaces.ts`: "_The bounds `POST /api/workspaces` applies to its two fields_" — `WORKSPACE_SLUG_MAX_LENGTH = 64`, and the handler reads `slug` with a bound of 64 (`apps/web/server/workspaces/handlers.ts`, `readString(object.body, 'slug', 64)`). `workspaces_slug_format` (`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`) admits at most 63 characters, so a 64-character slug passes the route's bound and is refused by the database as `invalid-slug`.                                                | `packages/contracts/src/workspaces.ts#WORKSPACE_SLUG_MAX_LENGTH`; `packages/core/src/db/schema/workspaces.ts#workspaces_slug_format`         | `Meta.ConceptIdentity.slug_bound_is_off_by_one`, `admitted_slugs_are_shorter_than_the_contract_bound`                                                                                                                                                                                             | Issue: set the constant and the handler bound to 63 (the DNS-label length the regex encodes), or say "at most 63" in the docs. The outcome is still a `400`, so it is a contract accuracy fix.                 |
| 2   | correctness   | `MeResponseSchema`'s comment: "_`userId` is `null` for exactly an API-key principal_". The Zod object accepts `kind: 'api-key'` with a non-null `userId`, and `kind: 'membership'` with `null`.                                                                                                                                                                                                                                                                                                                                   | `packages/contracts/src/team.ts#MeResponseSchema`                                                                                            | Current `MeResponse.acceptedCurrent`, Target `acceptedTarget`; `Refinement.ConceptIdentity.me_schema_target_refines_current`, `me_rules_agree_on_well_formed_principals` (the server never builds a mismatched body)                                                                              | Issue: make the schema a discriminated union on `kind` (`membership` → `userId: string`, `api-key` → `userId: null`), which the SDK then enforces on the way in.                                               |
| 3   | correctness   | RF-101: "_Backfill one human principal per Membership and one machine principal per APIKey_". The schema guarantees at most one principal per source (`workspace_principals_workspace_{membership,api_key}_key`) but not at least one: a membership with no principal is a consistent state, and such a member cannot sign in (`resolveMembership` returns `null`) or be granted anything by principal. The repositories always create the pair in one transaction, so this is an unenforced invariant, not an observed defect.   | `packages/core/src/db/schema/workspace-principals.ts`; `packages/core/src/db/repositories/directory.ts` (`createMembership`, `createApiKey`) | Current `Er.Current.Identity.consistent`, Target `consistentTarget` (`everySourceHasPrincipal`); `Refinement.ConceptIdentity.principal_coverage_target_refines_current`                                                                                                                           | ADR draft for the Target ER (synthesis): either a deferrable constraint trigger, or invert the reference so the source carries `principal_id NOT NULL` (tenant-paired).                                        |
| 4   | naming        | "Principal" names two different things: the durable `workspace_principals` row and the per-request authenticated object (`apps/web/server/rbac/principal.ts`), which adds the current role, `via`, `scope`, `label` and a compatibility `actor` string. RF-101 calls the second an `ActorContext`.                                                                                                                                                                                                                                | `apps/web/server/rbac/principal.ts#Principal`; `docs/sdk/04-api-specification.md` §1.1                                                       | `Concepts.Principal.Principal` vs `Concepts.Principal.Actor`                                                                                                                                                                                                                                      | Docs fix in `docs/formal/concepts.md` (synthesis): _WorkspacePrincipal_ for the row, _authenticated principal_ for the object; rename the `actor` field `displayActor` when the class is next touched (issue). |
| 5   | correctness   | `Principal.fromDirectoryRecord` copies `userId` and `apiKeyId` without checking them against `kind`, so an incoherent record builds a frozen principal that `Principal.isPrincipal` refuses. Its only caller passes `principalById`'s answer, which is coherent by construction, so nothing reachable produces one today.                                                                                                                                                                                                         | `apps/web/server/rbac/principal.ts#fromDirectoryRecord`                                                                                      | `Meta.ConceptIdentity.from_directory_record_accepts_an_incoherent_record`; `WellFormed.ConceptIdentity.from_directory_record_well_formed_iff_coherent`                                                                                                                                            | Issue: take a discriminated record (`{kind: 'membership', userId} \| {kind: 'api_key', apiKeyId}`) so the incoherent shape does not type-check.                                                                |
| 6   | documentation | `Er/Core.lean`'s docstring of `principalSourceXor`: "_the check passes, only when `kind` is `NULL`_". It returns `true` for every row with a `NULL` kind, but SQL's three-valued reading of `workspace_principals_source_xor` is `FALSE` for a row with no kind and no source (both disjuncts are `NULL AND FALSE`). Unreachable, since `kind` is `NOT NULL`.                                                                                                                                                                     | `formal/AgentWorkspace/Er/Core.lean#principalSourceXor`                                                                                      | `Meta.ConceptIdentity.core_source_xor_differs_from_sql_at_null_kind`; `WellFormed.ConceptIdentity.source_xor_refines_core` (they agree whenever `kind` is set)                                                                                                                                    | Programme-internal: correct the `er-core` docstring, or replace `principalSourceXor` by `CheckExpr.xor` in the synthesis.                                                                                      |
| 7   | documentation | The database's not-blank checks (`length(btrim(x)) > 0`) strip only U+0020, while the routes trim all whitespace. A name of tabs or line feeds that reaches a table another way (the case the users.ts comment calls the backstop's purpose) passes.                                                                                                                                                                                                                                                                              | `packages/core/src/db/schema/*.ts` `*_not_blank` checks                                                                                      | `Meta.ConceptIdentity.blank_checks_admit_whitespace_other_than_spaces`, `workspaces_name_not_blank_separates_its_samples`                                                                                                                                                                         | Record, low: say "not empty after trimming spaces" in the schema comments, or tighten to `~ '[^[:space:]]'` in a later migration (issue).                                                                      |
| 8   | naming        | `invitations.invited_by` is a `users.id`, the legacy human-attribution vocabulary RF-101 moved every other creator column away from. An API key cannot invite (the route refuses it), so no machine attribution is lost today.                                                                                                                                                                                                                                                                                                    | `packages/core/src/db/schema/invitations.ts#invitedBy`                                                                                       | `Normative.ConceptIdentity.invited_by_is_a_user_that_may_be_deleted`                                                                                                                                                                                                                              | Target ER (synthesis): add `invited_by_principal_id` (tenant-paired, `SET NULL` by sibling pattern) and keep `invited_by` as display attribution.                                                              |
| 9   | correctness   | `user-identities.ts`: "_email alone is not stable enough to be the identity key … `(issuer, subject)` is what OIDC itself guarantees is stable_". Yet a session's subject claim is the user's **email** (`SessionClaims.sub`, "the … email address, lower-cased"), and every request resolves its principal by email and slug (`DatabaseRoot.resolveMembership(email, workspaceSlug)`). Identity is keyed by a mutable attribute; the OIDC pair is used only at sign-in. No route updates `users.email` today, so this is latent. | `apps/web/server/auth/session.ts#SessionClaims`; `packages/core/src/db/repositories/root.ts#resolveMembership`                               | not modelled (sessions are Phase 3); glossary entry _User_                                                                                                                                                                                                                                        | ADR draft: mint `sub` as `users.id` (a token-version bump) and resolve the membership by user id.                                                                                                              |
| 10  | naming        | Session claims carry `role: 'owner'`, always, and verification rejects any other value; the role is ignored and read from the directory per request. A permission-shaped field in an identity token invites the conflation the architecture rule forbids.                                                                                                                                                                                                                                                                         | `apps/web/server/auth/session.ts#SessionClaims`                                                                                              | glossary entry _Role_                                                                                                                                                                                                                                                                             | Issue: drop the claim at the next token version.                                                                                                                                                               |
| 11  | correctness   | `DirectoryRoot.resolveRole(email, workspaceId)` (PostgreSQL and memory implementations) does not check that the membership's principal is active, unlike `resolveMembership` and `principalById`. Only the RBAC test harness calls it (`apps/web/server/rbac/testing.ts`), so tests resolve roles by a rule production does not use.                                                                                                                                                                                              | `packages/core/src/db/repositories/directory.ts#resolveRole`; `apps/web/server/rbac/testing.ts`                                              | Principal `PrincipalState` (`active`/`revoked`)                                                                                                                                                                                                                                                   | Issue: route the harness through `resolveMembership`, or remove `resolveRole` from the port.                                                                                                                   |
| 12  | correctness   | `principalById` re-checks an API key's expiry against `Date.now()`, while `authenticateApiKeyHash` uses the caller's `now` (`greatest(now(), $now)`). The same key can be judged at two different instants on one request, and the check is not testable with an injected clock.                                                                                                                                                                                                                                                  | `packages/core/src/db/repositories/directory.ts#principalById`                                                                               | `ApiKey.live` takes `now` (abstracting `greatest(now(), $now)`); `Principal.principalResolves` judges the minting key at the same `now` as the token, i.e. the model states the Target (one instant per request); `api_key_liveness_is_lost_for_good`, `browser_token_admission_is_lost_for_good` | Issue: pass `now` through `principalById`.                                                                                                                                                                     |

## Gaps

- **Admission is not replayed against TypeScript.** `apiKeyAdmitted`, `principalResolves` and
  `browserTokenAdmitted` model database queries (`authenticateApiKeyHash`, `principalById`,
  `findActiveBrowserTokenByHash`) and the closure `resolveBrowserTokenActor` inside
  `apps/web/server/composition/session-rbac.ts`; none is a pure exported function. They are modelled
  from the code, and the bearer grammar in front of them is replayed (`API_KEY_PATTERN`,
  `BROWSER_TOKEN_PATTERN`, `parsePresentedKey`, `parsePresentedBrowserToken`). A replay needs the
  memory directory or a database (Phase 3/4 or `heavy-checks`).
- **Admission is replayed only through its Lean theorems.** The admission T1/T3 theorems (scope
  match, minter workspace, removed membership, key identity) are proved against the model of
  `resolveBrowserTokenActor` and `principalById`; the TypeScript closures are not callable without a
  directory, so no vector exercises them (as above).
- **Invitation redemption is not modelled as an operation.** Single-use redemption and replay of an
  accepted invitation (the §6.1 T3 example), the last-owner guard on `deleteMembership`, and role
  demotion are operations; they carry forward to Phase 3/4. This unit proves only the state facts
  they rest on (`invitation_is_never_both_accepted_and_revoked`, `invitation_resolution_is_stable`,
  the token-hash unique key).
- **Role demotion.** §3.1.1's "demoting the minting member takes effect on the token's very next
  call" is a statement about the role re-read, which `fromBrowserToken` copies from the re-read
  minter (`browser_token_is_attenuation_not_a_fourth_identity`); the membership update itself is a
  Phase 4 operation.

- **Row verdicts of the non-pattern checks are not replayed against PostgreSQL.** The unit suite
  has no database. The meaning of each check is tied to the DDL by exact SQL text (Lean and Vitest)
  and pinned on boundary rows in Lean; the two pattern checks' rows are replayed against the
  snapshot's own regular expressions. A replay against a live database belongs in `heavy-checks`.
- **Locale.** `lowercase` is ASCII (`Char.toLower`) and `[:space:]` is the C-locale set; PostgreSQL
  under a UTF-8 collation also folds and classifies non-ASCII characters. Samples are ASCII.
- **`Principal.fromSession` is not replayed.** It needs a signed session token; the suite could mint
  one with `mintSessionToken` (as `principal.test.ts` does). The other three constructors, `isPrincipal`
  and `readMe` are replayed.
- **No operations.** Create, revoke, accept, resend and delete are Phase 3/4. The T2 theorems are
  properties of every consistent state (the obligation each operation inherits), plus the time
  properties of the concepts' states. Finding 3's target is stated as a state predicate, not as
  an operation invariant.
- **`Role` is defined in the concept layer** (see the modelling decisions); the Phase 2 `team`
  contracts unit and the synthesis should make one module own it.
- **Build inputs.** Like `er-core`, `aw_identity_check_theorems` reads the snapshot while the module
  elaborates, and Lake does not track that file; the suite compares every check body with the
  snapshot on every run meanwhile. `Theorems/WellFormed/ConceptIdentity.lean` takes about 40 s to
  build (the eight row-admission proofs).
- **The ER diagram is not regenerated here.** `docs/sdk/07-structure-map.md`'s identity edges agree
  with the model (`memberships |o--o| workspace_principals` is the at-most-one this unit proves);
  the synthesis owns the regenerated diagram and `Er/Target.lean`.
