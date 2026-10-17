# Unit `concept-publication` — shares, share views and share run charges (phase P1b)

The publication concept cluster, built on `Er/Core.lean` and `Prelude/Ids.lean`: what a share is
as the database and the wire contract know it, its invariants, its derived lifecycle states, its
relationships, and today's three tables with every key and check.

| File                                                                                                       | What it holds                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formal/AgentWorkspace/Concepts/Share.lean`                                                                | `SubjectType`, `Visibility`, `Mode`, `Expiry`, `ShareState` (`WireEnum`s), `Decimal`, the typed rows `Share`/`ShareView`/`ShareRunCharge` and `toRow`, `dbValid`, `wellPublished`, `stateAt`, `publiclyOpen`, `url?`, `resourceKeys`, `listedFor`, `optionsFit`, `publishDecision`, `Share.resolveAt` |
| `formal/AgentWorkspace/Er/Current/Publication.lean`                                                        | the nine foreign keys by name, the SQL and row semantics of the five non-closed-set checks, `Publication.consistent`, and the `Target` reading                                                                                                                                                        |
| `formal/AgentWorkspace/Theorems/{WellFormed,Normative,Invariants,Refinement,Meta}/ConceptPublication.lean` | the theorems, by tier                                                                                                                                                                                                                                                                                 |
| `formal/Vectors/ConceptPublication.lean` → `formal/generated/vectors/concept-publication/`                 | `vocabularies.json` (46), `tables.json` (3), `checks.json` (5), `shares.json` (177), `options.json` (192), `fields.json` (20), `publish.json` (544), `resolve.json` (576), `listing.json` (24), `visitor-limit.json` (1): 1588 vectors                                                                |
| `tests/formal/concept-publication.test.ts`                                                                 | package side: contracts and schema vocabularies, the live Drizzle tables (`getTableConfig`), the 0025 snapshot's check SQL, and the contracts' `ShareResourceSchema`/`ShareListItemSchema`                                                                                                            |
| `apps/web/formal/concept-publication.test.ts`                                                              | application side (D-012): `PublishShareRequestSchema`, `toShareResource`, `ShareService.publish` (release gate injected, fake repositories), `ShareService.resolve` with passphrases under fake timers, the real `GET /api/shares` behind the real RBAC decision, `RunnableShareService.message`      |

## Modelling decisions

- **Vocabularies live in the concept for now.** `Contracts/Shares.lean` (Phase 2) does not exist
  yet and `Contracts` may not import `Concepts`, so the four share vocabularies are defined in
  `Concepts/Share.lean`, in the `as const` order of `packages/contracts/src/shares.ts`. The
  synthesis step can move them into the contracts module and re-export them.
- **Typed rows encode into `Er.Core` rows.** `Share.cells` lists every column of `shares` in
  declaration order, with `none` for SQL `NULL`; `rowOf` drops the `NULL`s. T0 proves the cell
  names are exactly the catalogue's column names for every value of the typed row, and T2 proves
  each field is read back from its own column (`share_row_encodes_fields`), so the ER lemmas and
  the typed invariants talk about the same rows. Instants are epoch milliseconds (`Nat`); amounts
  are decimal strings read exactly by `Decimal.parse?` (PostgreSQL's rounding of extra fraction
  digits is not modelled).
- **The five non-closed-set checks are refined here.** `Er.Core.otherCheckHolds` leaves them true;
  `checkSemantics?` gives each its SQL meaning, with SQL's three-valued reading (a `NULL` operand
  passes), and `Publication.consistent` is `Er.Core.consistent` plus those checks. The SQL text is
  pinned in `checkSql` and replayed against the snapshot. `notBlankSql` follows PostgreSQL's
  one-argument `btrim`, which strips spaces only.
- **Database invariants vs service invariants.** `Share.dbValid` is what PostgreSQL enforces;
  `Share.wellPublished` adds what `ShareService.publish` and `PublishShareRequestSchema` maintain
  (a mode exactly on agent shares, a budget exactly on runnable ones, `include` only on session
  shares, the `pub_` token prefix). `optionsFit` is the request schema's pairing rule.
- **The service's decisions are pure functions.** `publishDecision` is `ShareService.publish`
  after the schema: in order, `public` while public sharing is off, `runnable` while the D-06
  release gate is closed (`runnableReleased = false`, mirroring the constant
  `runnablePublicLinksEnabled()`), and `runnable` by a Builder or Viewer are refused with
  `invalid_share` and the service's exact message; otherwise it writes the effective mode
  (`definition` by default on an agent, none elsewhere), a budget only when runnable (default
  `20`), `expires_at = now + lifetime`, and a passphrase hash when a passphrase was given. The
  gate is an input so the vectors cover both positions; `ShareService`'s constructor takes it the
  same way. `Share.resolveAt` is `ShareService.resolve`: a closed link is `share_unavailable`
  whatever the passphrase; an open one with a passphrase is `invalid_passphrase` unless the right
  one is presented. `listedFor role viewer share` is the `GET /api/shares` filter.
- **States, not transitions.** A share has no status column. `stateAt` derives `revoked`,
  `suspended`, `stopped`, `expired` or `live` in that precedence, and `publiclyOpen` is the
  availability test of `ShareService.resolve` and `findShareWorkspace` (public and live). The
  transitions (`revoke`, `setSuspended`, `setPublicSharingEnabled`, `stop`, `reserveVisitorMessage`,
  `linkRun`) belong to Phase 3 `Behaviour/Shares.lean` and Phase 4 `Lifecycle/Share.lean`.
- **The Target reading.** `Publication.Target.consistent` adds three constraints that the service
  maintains or the documents promise but no constraint enforces: an agent share has a mode
  (`agentHasMode`), only a runnable share has a budget (`budgetOnlyRunnable`), and the subject id
  names a row of the subject type's table in the share's own workspace (`subjectResolves`).
- **Witness state.** `Invariants.ConceptPublication.Witness.state` is a consistent state (by
  `decide +kernel`) with two workspaces, a member, its principal, an agent, a session, a queued run,
  a public runnable agent share of that agent built from a typed `Share`, a view and the run's
  charge. Every hypothesis-bearing T2 theorem is instantiated on it, and it also meets the Target.

## Theorems (111: 23 T0, 39 T1, 34 T2, 8 T4, 7 T5; plus traced definitions)

- **T0 (WellFormed).** Vocabulary order and spelling (`subject_type_wires`, `visibility_wires`,
  `mode_wires`, `expiry_wires`, `share_state_wires`), JSON round trip and near-miss refusal,
  `subject_table_is_injective`; the typed rows name exactly their tables' columns
  (`share_cells_are_the_columns`, and for views and charges) with no duplicate name; the nine keys
  are exactly the catalogue's (`cluster_foreign_keys_are_the_catalogue's`) with classes 3 root, 1
  global, 5 tenant-paired (`cluster_foreign_key_classes`); every non-closed-set check has SQL and a
  semantics and they are exactly the catalogue's (`refined_checks_are_the_catalogue's`,
  `cluster_checks_all_refined`); the closed sets are the vocabularies; decimal edge cases
  (`decimal_parse_edges`, `non_negative_amount_edges`, `decimal_micros_edges`,
  `numeric_12_4_bounds`) and `include_json_text`.
- **T1 (Normative).** Spec §20.6.1: `shareable_objects_are_exactly_four`, `files_are_not_shareable`,
  `three_visibilities`, `only_a_public_share_opens`, `live_public_share_always_opens`. §20.6.2:
  `expiry_options_and_lifetimes`, `expiry_and_passphrase_are_optional`, `revoked_link_never_opens`,
  `expiry_closes_the_link_at_its_instant` (the boundary `expires_at <= now`),
  `passphrase_length_bounds`, `passphrase_is_stored_exactly_when_given`,
  `passphrase_gates_an_open_link`, `link_without_passphrase_opens_for_everyone`. §20.6.3:
  `default_runnable_budget_is_twenty_dollars`, `runnable_budget_defaults_to_twenty`,
  `agent_share_defaults_to_definition`, `five_messages_per_visitor_per_hour`,
  `budget_is_exhausted_at_the_cap`, `stopped_link_does_not_open`. §20.6.4:
  `suspended_link_does_not_open`, `state_fields_are_always_rendered`,
  `public_share_refused_while_public_sharing_is_off` (also 04 §5.13). §21 (Viewer):
  `runnable_requires_owner_or_admin`. §27: `one_table_for_every_shareable_object` (one `NOT NULL`
  `subject_type` over the four types, one `subject_id` that no key reads). 04 §5.13:
  `url_exactly_when_public`, `token_never_crosses_the_wire_as_a_field`,
  `view_count_only_on_list_items`, `list_is_mine_or_all_for_admins`,
  `runnable_is_refused_in_this_release`. The contract comments of `PublishShareCommand` and
  `ShareIncludeSchema` (cited as TS symbols): `mode_budget_and_definition_are_agent_only`,
  `budget_requires_runnable_mode`, `include_and_transcript_are_session_only`,
  `every_option_fits_its_subject`, `budget_must_be_positive`. 07 §3:
  `every_share_has_a_publisher_principal`, `creator_is_legacy_nullable_attribution`. Schema:
  `charge_is_keyed_by_the_run`, `share_children_cascade`, `share_children_carry_no_principal`.
- **T2 (Invariants).** Tenant isolation per paired key, instantiating
  `paired_reference_preserves_tenant` (any state): `share_and_publisher_share_a_workspace`,
  `share_and_creator_membership_share_a_workspace`, `view_and_share_share_a_workspace`,
  `charge_and_share_share_a_workspace`, `charge_and_run_share_a_workspace`, and their composition
  `charge_funds_runs_of_its_share's_workspace`. Cardinalities in consistent states:
  `share_has_exactly_one_workspace`, `share_has_exactly_one_publisher`,
  `view_has_exactly_one_share`, `charge_has_exactly_one_share`, `charge_has_exactly_one_run`,
  `run_is_funded_by_at_most_one_share`, `token_names_at_most_one_share` (global, so the unscoped
  `/p/<token>` lookup resolves at most one workspace), `share_creator_is_a_member`. Closed sets:
  `share_subject_type_decodes`, `share_visibility_decodes`, `share_mode_decodes`. Refined checks:
  `share_with_mode_is_an_agent_share`, `share_amounts_are_non_negative`,
  `share_subject_id_is_not_blank`, `charge_is_non_negative`. Typed rows:
  `share_row_encodes_fields`, `share_db_valid_iff_row_checks`, `charge_db_valid_iff_row_check`,
  `well_published_share_passes_the_checks`, `well_published_requires_the_pub_prefix`. The
  publishing service: `published_mode_and_budget_fit`, `no_runnable_share_is_published_today`,
  `no_public_share_is_published_while_sharing_is_off`, `published_expiry_counts_from_now`.
  Opening: `resolve_opens_iff`, `closed_link_is_unavailable_whatever_the_passphrase`. Time:
  `closed_link_stays_closed`, `expired_state_is_permanent`.
- **T4 (Refinement).** `target_refines_current`, `well_published_share_meets_the_target_checks`,
  `witness_state_meets_the_target`, and the five stated divergences, each a consistent current
  state the Target refuses: `current_admits_an_agent_share_without_mode`,
  `current_admits_a_budget_on_a_definition_share`, `current_admits_a_dangling_subject`,
  `current_admits_a_subject_of_the_wrong_type`, `current_admits_a_cross_workspace_subject` (a `w1`
  share naming agent `a2` of `w2`; the same row in `w2` resolves, so the Target's same-workspace
  conjunct is what refuses it).
- **T5 (Meta).** Findings pinned: `a_member_cannot_read_another's_workspace_share`,
  `private_and_workspace_shares_list_alike`, `private_and_workspace_shares_never_open`,
  `shares_carry_a_publisher_not_an_owner`,
  `a_space_subject_id_passes_validation_but_not_the_database`,
  `specification_column_list_is_a_strict_subset` (§27),
  `budget_is_not_tied_to_runnable_mode_in_the_database`.

Every theorem with hypotheses has an `example` witness in its file or a positive vector.

**Mutation coverage.** Swapping two vocabulary members fails the `*_wires` theorems and the
vocabulary replay. Editing a column, key, class, unique key or check of the three tables fails a T0
theorem and the Drizzle replay. Changing a check's SQL fails the snapshot replay; loosening a check's
semantics (for example letting a session carry a mode) breaks `share_db_valid_iff_row_checks` or
`share_with_mode_is_an_agent_share`. Turning `expires_at <= now` into `<` breaks
`expiry_closes_the_link_at_its_instant` and the `expiry=exact` share vectors. Opening a
non-public share breaks `only_a_public_share_opens` and the `ShareService.resolve` replay. Adding
`token` (or any persistence-only key) to `resourceKeys` breaks
`token_never_crosses_the_wire_as_a_field` and the `toShareResource` replay. Loosening `optionsFit`
breaks the three pairing theorems and 192 request-schema vectors. Dropping the same-workspace
conjunct of `Target.subjectResolves` breaks `current_admits_a_cross_workspace_subject` (checked).
Dropping the `pub_` prefix conjunct of `wellPublished` breaks
`well_published_requires_the_pub_prefix` (checked), and the publish replay checks the prefix of
every token the real service mints. Reordering or dropping a refusal in `publishDecision` breaks the
refusal theorems and the 544 `ShareService.publish` vectors; letting a wrong passphrase through
breaks `passphrase_gates_an_open_link` and the `resolve.json` replay; making `listedFor` read the
visibility or drop the publisher test breaks `list_is_mine_or_all_for_admins` and the `GET` replay. Dropping the tenant column from a
paired key breaks its isolation theorem (`isPaired` is decided) and `cluster_foreign_key_classes`.

## Glossary

One meaning per term.

- **Share.** One published subject of one workspace: a row of `shares`. It is the only mechanism
  that reaches outside a workspace today.
- **Subject.** What a share publishes: the pair (`subject_type`, `subject_id`). `subject_type`
  names the table (`agents`, `sessions`, `projects`, `skills`); `subject_id` is that row's id as
  text, with no foreign key.
- **Subject label.** A display string for the subject, client-authored until RF-103.
- **Visibility.** Who may open the share: `private`, `workspace` or `public`. Only `public` has a
  link that opens (`/p/<token>`).
- **Mode.** How an _agent_ share behaves for its visitor: `definition` (read the configuration) or
  `runnable` (send messages; compiled off by D-06). Other subjects have no mode.
- **Snapshot.** The server-held JSON document a visitor sees. A redacted copy for a session with a
  transcript and for an agent with a definition; whatever the client sent otherwise (today).
- **Include.** What a session share reveals beyond the conversation (`technicalDetails`,
  `outputFiles`).
- **Token.** The secret of the link. Globally unique; never a wire field; it appears on the wire
  only inside a public share's `url`.
- **Publisher.** The principal that published the share (`publisher_principal_id`); the share's
  owner for authorisation (`own`/`other`).
- **Creator.** Legacy human attribution (`created_by`): the publishing user, `NULL` for an API-key
  principal.
- **Revoked, suspended, stopped, expired, live.** The derived states (`stateAt`), in that
  precedence. Revoked is permanent; suspended follows the workspace's public-sharing policy;
  stopped is the kill switch or the budget guard; expired is `expires_at <= now`.
- **Budget, spend, charge.** A runnable share's cap (`budget_cap_usd`), its running total
  (`spent_usd`), and the per-run attribution (`share_run_charges.charged_usd`).
- **Share view.** One row of `share_views`: an opening of a public link or an admitted visitor
  message (see finding 8).

**Aliases and conflations found.**

- _Share subject vs share visibility vs mode._ Three independent axes that the UI and the admin
  list (spec §20.6.4, "Customer Support Agent agent Workspace", "Invoice Triage agent Runnable")
  print in one column, as if `runnable` were a fourth visibility. In the model a runnable link is
  `visibility = public` and `mode = runnable`; `runnable` with `private` or `workspace` visibility is
  representable but never opens.
- _Publisher vs owner vs creator._ `shares` names its owner `publisher_principal_id` where every
  other ownable table says `owner_principal_id`; 04 §2 says shares carry `ownerPrincipalId`; the
  admin page says "created by", which is the legacy `created_by`, not the publisher (finding 2).
- _Stopped._ One flag for two causes (manual kill switch, automatic budget stop), described on the
  wire as budget exhaustion only (finding 9).
- _View._ `share_views` counts page opens and visitor messages alike (finding 8).
- _Session-published._ The audit action for publishing any subject type (finding 7).

## Findings

| #   | Severity      | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Lean                                                                                                                                                                                                                                     | Proposed resolution                                                                                                                                                                         |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | correctness   | `docs/spec.md` §20.6.1: "_Workspace any member of the workspace with a role that allows viewing_". Today no member other than the publisher or an Owner/Admin can read a workspace share: `GET /api/shares` (`apps/web/app/api/shares/route.ts#GET`) filters on role and publisher only, and `/p/<token>` (`root.ts#findShareWorkspace`, `ShareService.resolve`) opens public shares only. `private` and `workspace` behave identically.                                                                                                                                                                                  | Current `listedFor` (replayed against the real `GET /api/shares`), `publiclyOpen`; `Meta.a_member_cannot_read_another's_workspace_share`, `Meta.private_and_workspace_shares_list_alike`, `Meta.private_and_workspace_shares_never_open` | Issue: implement a workspace-member read path for `workspace` shares, or ADR + docs fix stating that `workspace` is reserved and behaves as `private` today.                                |
| 2   | documentation | `docs/sdk/04-api-specification.md` §2: "_every row that can be "own" or "other" (…, shares) carries `ownerPrincipalId`_". `shares` has `publisher_principal_id`, and `ShareResource` carries neither, so an SDK caller cannot tell its own shares from others'. The ownership page's "_every row a principal creates carries an `owner_principal_id`_" has the same gap.                                                                                                                                                                                                                                                  | `Meta.shares_carry_a_publisher_not_an_owner`                                                                                                                                                                                             | Docs fix now (name `publisher_principal_id` as the share's owner column); ADR for the Target: rename to `owner_principal_id` or add `publisherPrincipalId` to the wire resource.            |
| 3   | correctness   | `PublishShareRequestSchema` (`apps/web/server/shares/core/input.ts`) and `ShareResourceSchema` accept `subjectId: " "` (`min(1)`), but `shares_subject_id_not_blank` (`length(btrim(subject_id)) > 0`) refuses it, so the insert fails after validation passed and surfaces as a non-domain error (`500 internal_error`) instead of `400 invalid_share`. Replayed: `fields.json` `field/subjectId/" "` is accepted by the real schema.                                                                                                                                                                                    | `Meta.a_space_subject_id_passes_validation_but_not_the_database`; `notBlankSql`, `subjectIdAccepted`                                                                                                                                     | Issue: refine `subjectId` with the same predicate (`trim(' ')` non-empty) in the request schema and the contract; add a regression test.                                                    |
| 4   | documentation | `docs/spec.md` §27's `shares` column list omits `token`, `subject_label`, `stopped`, `publisher_principal_id`, `suspended_at` and `created_at`, and says `snapshot` is for sessions only; `docs/sdk/07-structure-map.md` §3 lists the abbreviation explicitly, the spec does not.                                                                                                                                                                                                                                                                                                                                         | `Meta.specification_column_list_is_a_strict_subset`                                                                                                                                                                                      | Docs fix: point §27 at the schema file, or list the six columns.                                                                                                                            |
| 5   | correctness   | The database admits an agent share with no mode and a budget on a non-runnable share: only `shares_agent_mode_only` exists. Spec §27: "_`mode` … (agents only)_", "_`budget_cap_usd` runnable links only_"; contracts: "_`null` unless the share is a runnable agent_". The service maintains both, so no bad row exists today, but nothing stops another writer.                                                                                                                                                                                                                                                         | Target `agentHasMode`, `budgetOnlyRunnable`; `Refinement.current_admits_an_agent_share_without_mode`, `current_admits_a_budget_on_a_definition_share`, `Meta.budget_is_not_tied_to_runnable_mode_in_the_database`                        | ADR + migration: `CHECK (subject_type <> 'agent' OR mode IS NOT NULL)` and `CHECK (budget_cap_usd IS NULL OR mode = 'runnable')`.                                                           |
| 6   | correctness   | `shares.subject_id` is polymorphic text with no foreign key, and the service does not check it for every caller: `subjectOwnership` (`apps/web/server/composition/register.ts`) answers `unknown` for agents, skills, and any id not found in the workspace, and an Owner's or Admin's `MANAGE`/`EVERYTHING` grant allows `unknown`. A share can therefore name a missing subject, another workspace's id, or an id of the wrong type. No data crosses a tenant today because the label and snapshot are client-authored (RF-103). This also qualifies er-core finding 3's proposed wording ("_checked by the service_"). | Target `subjectResolves`; `Refinement.current_admits_a_dangling_subject`, `current_admits_a_subject_of_the_wrong_type`, `current_admits_a_cross_workspace_subject`                                                                       | Issue (with RF-103): resolve the subject server-side in `publish` and refuse an unknown one; ADR for the Target ER: one nullable, tenant-paired FK per subject type plus a one-of check.    |
| 7   | naming        | `ShareService.publish` audits every publish as `session-published`, whatever the subject type (`apps/web/server/shares/core/service.ts`), while spec §20.6.2 rule 6 asks for "_who, what, and which visibility_".                                                                                                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                        | ADR: rename the action to `share-published` (an `audit_events_action_valid` change) or add the subject type to the label.                                                                   |
| 8   | naming        | `share_views` holds two kinds of event: page opens (`ShareService.resolve` records one with no visitor key) and admitted runnable messages (`reserveVisitorMessage` inserts one with the visitor key). `viewCount` counts both, and the dormant `/p/<token>/messages` route writes both rows for one message.                                                                                                                                                                                                                                                                                                             | `ShareView` docstring                                                                                                                                                                                                                    | ADR for the Target ER: a `kind` column or a separate `share_messages` table; docs note on `viewCount` meanwhile.                                                                            |
| 9   | documentation | Contract `stopped`: "_`true` once the budget was exhausted; the link no longer runs_"; spec §20.6.3: "_then the link stops accepting messages_". Code: `stop(id)` (the manual kill switch) sets it too, and `ShareService.resolve` treats a stopped share as unavailable altogether, so the page no longer opens either.                                                                                                                                                                                                                                                                                                  | `Normative.stopped_link_does_not_open`                                                                                                                                                                                                   | Docs fix in `packages/contracts/src/shares.ts` ("stopped by the kill switch or the budget guard; the link no longer opens"), or an issue if a stopped definition page should stay viewable. |
| 10  | documentation | Spec §20.6.4: "_Existing public links are suspended … when the policy is turned off_". `setPublicSharingEnabled(false)` stamps `suspended_at` on every non-revoked share of any visibility, and `true` clears every suspension, including one set by `setSuspended`.                                                                                                                                                                                                                                                                                                                                                      | (transition; Phase 4 `Lifecycle/Share.lean`)                                                                                                                                                                                             | Docs fix ("every unrevoked share is suspended"), and Phase 4 models the transition.                                                                                                         |
| 11  | documentation | `docs/sdk/site/concepts/ownership-and-sharing.mdx`: "_A share is a copy of what it published at publish time_". For a project or skill share (and an agent share without a definition) the stored snapshot is whatever the client sent, or nothing; the contract comment on `PublishShareCommand` ("_this command never carries a transcript, a definition or a snapshot_") describes the SDK, not the route. 04 §5.13 already names this as RF-103.                                                                                                                                                                      | —                                                                                                                                                                                                                                        | Docs note on the concept page until RF-103 lands.                                                                                                                                           |

Security finding withheld; see the private ledger. It is an observation recorded while reading the
code that `Share.resolveAt` models, not a counterexample to any theorem of this unit (the unit has
no T3 theorem it would falsify); the orchestrator should confirm with the Owner (§13) that the
ledger entry exists before this unit's status is accepted.

## Gaps

- `checks.json` carries each refined check's verdict on sample rows, but the conformance suite
  replays only the check SQL against the 0025 snapshot: the unit suites have no PostgreSQL, so the
  verdicts are not evaluated by the database. A `heavy-checks` suite could insert the sample rows.
- `Share.budgetExhausted` mirrors the SQL expression inside `reserveVisitorMessage`
  (`budget_cap_usd is not null and spent_usd >= budget_cap_usd`); it is proved against the spec
  (`budget_is_exhausted_at_the_cap`) but not replayed, for the same reason (no PostgreSQL in the
  unit suite). The limit and window `RunnableShareService.message` passes to the reservation, and
  the `$20` default budget written by `publish`, are replayed.
- The publish replay drives `ShareService.publish` with the release gate as a constructor
  argument, so both gate positions are replayed; `runnablePublicLinksEnabled()` itself is the
  constant `false` (`runnableReleased`). The `POST /api/shares` route's own ownership and RBAC
  step before `publish` (04 §5.13: a Builder or Viewer cannot publish an agent or skill share) is
  not modelled here; it belongs to the authorisation unit.
- The share state transitions (revoke, suspend, policy switch, stop, visitor reservation,
  run linking) are not modelled; `ShareState` only names the states.
- The vocabularies should move to `Contracts/Shares.lean` in Phase 2 (see the modelling decisions).
- The Target reading lives in `Er/Current/Publication.lean` as `Publication.Target`; the synthesis
  step owns `Er/Target.lean` and the refinement map.
- `Decimal` reads amounts exactly; PostgreSQL's rounding of excess fraction digits and the
  `numeric(p, s)` overflow error are modelled only as `Decimal.fits`.
