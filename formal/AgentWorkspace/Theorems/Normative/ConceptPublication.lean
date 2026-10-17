import AgentWorkspace.Er.Current.Publication

/-!
T1 — the documented sentences about shares, each stated as a theorem and cited.

Sources: `docs/spec.md` §20.6 (sharing and publishing) and §27 (the `shares` table),
`docs/sdk/04-api-specification.md` §2 and §5.13, `docs/sdk/07-structure-map.md` §3 (the ER
diagram), `docs/sdk/site/concepts/ownership-and-sharing.mdx`, and the contract comments of
`packages/contracts/src/shares.ts`.
-/

namespace AgentWorkspace.Theorems.Normative.ConceptPublication

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Share
open AgentWorkspace.Concepts (Membership.Role)
open AgentWorkspace.Er.Current.Publication (sharesPublisherKey tables)

/-! ## What can be shared -/

/-- "Shareable objects are exactly: agent, session, project, skill": the subject types are those
four, and each names the table of its kind. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")
  (ts := "packages/contracts/src/shares.ts#SHARE_SUBJECT_TYPES")]
theorem shareable_objects_are_exactly_four :
    WireEnum.wires SubjectType = ["agent", "session", "project", "skill"] ∧
      (WireEnum.all : List SubjectType).map SubjectType.table =
        [.agents, .sessions, .projects, .skills] := by decide

/-- "Files are not independently shareable": no subject type names the `files` table. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")
  (ts := "packages/contracts/src/shares.ts#SHARE_SUBJECT_TYPES")]
theorem files_are_not_shareable (t : SubjectType) : t.table ≠ .files := by
  cases t <;> decide

/-- "`shares` is one table for every shareable object, not one table per type": one `NOT NULL`
`subject_type` column whose check admits exactly the four subject types, and one `NOT NULL`
`subject_id` column that no foreign key of `shares` reads, so a single row shape carries every
type's subject. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#27-minimal-database-model")
  (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem one_table_for_every_shareable_object :
    (catalogue .shares).isNotNull "subject_type" = true ∧
      (catalogue .shares).isNotNull "subject_id" = true ∧
      (catalogue .shares).oneOfCheck? "shares_subject_type_valid" =
        some ("subject_type", WireEnum.wires SubjectType) ∧
      ((catalogue .shares).foreignKeys.all fun fk => !fk.columns.contains "subject_id") = true := by
  decide

/-- "Three visibilities, for every shareable object": private, workspace and public, stored in the
`NOT NULL` column `visibility`. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")
  (ts := "packages/contracts/src/shares.ts#SHARE_VISIBILITIES")]
theorem three_visibilities :
    WireEnum.wires Visibility = ["private", "workspace", "public"] ∧
      (catalogue .shares).isNotNull "visibility" = true := by decide

/-! ## Expiry, passphrase, budget, limits -/

/-- "Optional expiry (`24 h`, `7 days`, `30 days`, `never`)": the four options, of 24 hours, 7
days and 30 days, and `never` sets no expiry. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2062-publishing-a-session-run-history")
  (ts := "apps/web/server/shares/core/service.ts#EXPIRY_MS")]
theorem expiry_options_and_lifetimes :
    WireEnum.wires Expiry = ["24 h", "7 days", "30 days", "never"] ∧
      Expiry.hours24.durationMs? = some (24 * 60 * 60 * 1000) ∧
      Expiry.days7.durationMs? = some (7 * 24 * 60 * 60 * 1000) ∧
      Expiry.days30.durationMs? = some (30 * 24 * 60 * 60 * 1000) ∧
      Expiry.never.durationMs? = none := by decide

/-- "Optional expiry … and optional passphrase. Neither is required": both columns are nullable. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2062-publishing-a-session-run-history")
  (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem expiry_and_passphrase_are_optional :
    (catalogue .shares).isNotNull "expires_at" = false ∧
      (catalogue .shares).isNotNull "passphrase_hash" = false ∧
      (catalogue .shares).hasColumn "expires_at" = true ∧
      (catalogue .shares).hasColumn "passphrase_hash" = true := by decide

/-- "Budget cap $20 total": a runnable share published without a cap gets twenty dollars, which
fits `budget_cap_usd numeric(12, 4)`. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2063-publishing-an-agent")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem default_runnable_budget_is_twenty_dollars :
    ((Decimal.parse? defaultRunnableBudgetUsd).bind Decimal.toMicros?) = some 20000000 ∧
      ((Decimal.parse? defaultRunnableBudgetUsd).map (Decimal.fits 12 4)) = some true := by decide

/-- "Per-visitor limit 5 messages per hour": the limit is five and the window one hour. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2063-publishing-an-agent")
  (ts := "apps/web/server/shares/runnable/service.ts#RunnableShareService")]
theorem five_messages_per_visitor_per_hour :
    visitorMessageLimit = 5 ∧ visitorWindowMs = 60 * 60 * 1000 := by decide

/-- "Budget cap $20 total, then the link stops accepting messages": a runnable share whose spend
has reached its cap is exhausted, and one below its cap is not. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2063-publishing-an-agent")
  (ts := "packages/core/src/db/repositories/shares.ts#reserveVisitorMessage")]
theorem budget_is_exhausted_at_the_cap (s : Share) (hcap : s.budgetCapUsd = some "20") :
    (s.spentUsd = "20.000000" → s.budgetExhausted = true) ∧
      (s.spentUsd = "19.999999" → s.budgetExhausted = false) := by
  refine ⟨fun h => ?_, fun h => ?_⟩ <;> simp [Share.budgetExhausted, hcap, h] <;> decide

example : ∃ s : Share, s.budgetCapUsd = some "20" :=
  ⟨{ (default : Share) with budgetCapUsd := some "20" }, rfl⟩

/-! ## Publish options -/

/-- "`mode` and `budgetCapUsd` are for an agent share only": a command for any other subject that
fits carries no mode, no budget and no agent definition. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/shares.ts#PublishShareCommand")
  (ts := "apps/web/server/shares/core/input.ts#PublishShareRequestSchema")]
theorem mode_budget_and_definition_are_agent_only (t : SubjectType) (m : Option Mode)
    (i b tr d : Bool) (ht : t ≠ .agent) (h : optionsFit t m i b tr d = true) :
    m = none ∧ b = false ∧ d = false := by
  cases t <;> cases m <;> cases i <;> cases b <;> cases tr <;> cases d <;> simp_all [optionsFit]

/-- "`budgetCapUsd` further requires `runnable` mode": an agent command with a budget that fits
is a runnable one. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/shares.ts#PublishShareCommand")]
theorem budget_requires_runnable_mode (m : Option Mode) (i tr d : Bool)
    (h : optionsFit .agent m i true tr d = true) : m = some .runnable := by
  cases m with
  | none => simp [optionsFit] at h
  | some m => cases m <;> simp_all [optionsFit]

/-- "`include` is for a session share only": a command for any other subject that fits carries
no `include` and no transcript. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/shares.ts#ShareIncludeSchema")]
theorem include_and_transcript_are_session_only (t : SubjectType) (m : Option Mode)
    (i b tr d : Bool) (ht : t ≠ .session) (h : optionsFit t m i b tr d = true) :
    i = false ∧ tr = false := by
  cases t <;> cases m <;> cases i <;> cases b <;> cases tr <;> cases d <;> simp_all [optionsFit]

/-- A command with no options fits every subject type, and each option passes the request schema
on the subject that takes it (the service then refuses `runnable`; see
`runnable_is_refused_in_this_release`). -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")
  (ts := "apps/web/server/shares/core/input.ts#PublishShareRequestSchema")]
theorem every_option_fits_its_subject (t : SubjectType) :
    optionsFit t none false false false false = true ∧
      optionsFit .agent (some .runnable) false true false true = true ∧
      optionsFit .agent (some .definition) false false false true = true ∧
      optionsFit .session none true false true false = true := by
  cases t <;> decide

/-- A passphrase is 1 to 1024 code units long (`SHARE_PASSPHRASE_MAX_LENGTH`). -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2062-publishing-a-session-run-history")
  (ts := "packages/contracts/src/shares.ts#SHARE_PASSPHRASE_MAX_LENGTH")]
theorem passphrase_length_bounds :
    passphraseAccepted 1 = true ∧ passphraseAccepted 1024 = true ∧
      passphraseAccepted 0 = false ∧ passphraseAccepted 1025 = false := by decide

/-- "`budgetCapUsd`: a positive amount in USD": zero and negative budgets are refused, any positive
amount is accepted. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/shares.ts#PublishShareCommand")]
theorem budget_must_be_positive :
    budgetAccepted "0" = false ∧ budgetAccepted "-1" = false ∧ budgetAccepted "-0" = false ∧
      budgetAccepted "0.01" = true ∧ budgetAccepted "20" = true := by decide

example := mode_budget_and_definition_are_agent_only .session none true false true false
  (by decide) (by decide)
example := budget_requires_runnable_mode (some .runnable) false false true (by decide)
example := include_and_transcript_are_session_only .agent (some .definition) false false false
  true (by decide) (by decide)

/-! ## Opening a link -/

/-- "Public: anyone with the link, unauthenticated": only a public share opens through
`/p/<token>`; a private or workspace share never does, at any instant. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")
  (ts := "packages/core/src/db/repositories/root.ts#findShareWorkspace")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem only_a_public_share_opens (s : Share) (now : Nat) (h : s.publiclyOpen now = true) :
    s.visibility = .«public» := by
  unfold Share.publiclyOpen at h
  cases hv : s.visibility <;> simp_all

/-- "A published link is revocable. Revoking is immediate and permanent for that link": a revoked
share is in state `revoked` and does not open, at every instant. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2062-publishing-a-session-run-history")
  (ts := "packages/core/src/db/repositories/shares.ts#revoke")]
theorem revoked_link_never_opens (s : Share) (h : s.revokedAt.isSome = true) (now : Nat) :
    s.stateAt now = .revoked ∧ s.publiclyOpen now = false := by
  simp [Share.stateAt, Share.publiclyOpen, h]

/-- "Existing public links are suspended, not deleted, when the policy is turned off": a
suspended, unrevoked share is in state `suspended` and does not open. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2064-administration")
  (ts := "packages/core/src/db/repositories/shares.ts#setPublicSharingEnabled")]
theorem suspended_link_does_not_open (s : Share) (hr : s.revokedAt = none)
    (h : s.suspendedAt.isSome = true) (now : Nat) :
    s.stateAt now = .suspended ∧ s.publiclyOpen now = false := by
  simp [Share.stateAt, Share.publiclyOpen, h, hr]

/-- "A single 'Stop accepting messages' control, and an automatic stop on budget": a stopped
share that is neither revoked nor suspended is in state `stopped` and does not open. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2063-publishing-an-agent")
  (ts := "packages/core/src/db/repositories/shares.ts#stop")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem stopped_link_does_not_open (s : Share) (hr : s.revokedAt = none) (hs : s.suspendedAt = none)
    (h : s.stopped = true) (now : Nat) :
    s.stateAt now = .stopped ∧ s.publiclyOpen now = false := by
  simp [Share.stateAt, Share.publiclyOpen, h, hr, hs]

/-- "Optional expiry": a share whose expiry has come (`expires_at <= now`) does not open, and at
the instant before it a public share with no other cause still opens. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2062-publishing-a-session-run-history")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem expiry_closes_the_link_at_its_instant (s : Share) (e : Nat) (he : s.expiresAt = some e)
    (hv : s.visibility = .«public») (hr : s.revokedAt = none) (hs : s.suspendedAt = none)
    (hst : s.stopped = false) :
    s.publiclyOpen e = false ∧ (0 < e → s.publiclyOpen (e - 1) = true) := by
  refine ⟨?_, fun hpos => ?_⟩
  · simp [Share.publiclyOpen, Share.stateAt, Share.expiredAt, he, hr, hs, hst]
  · simp [Share.publiclyOpen, Share.stateAt, Share.expiredAt, he, hr, hs, hst, hv]
    omega

/-- A public share that is not revoked, suspended, stopped or expiring opens at every instant. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem live_public_share_always_opens (s : Share) (hv : s.visibility = .«public»)
    (hr : s.revokedAt = none) (hs : s.suspendedAt = none) (hst : s.stopped = false)
    (he : s.expiresAt = none) (now : Nat) : s.publiclyOpen now = true ∧ s.stateAt now = .live := by
  simp [Share.publiclyOpen, Share.stateAt, Share.expiredAt, hv, hr, hs, hst, he]

private def openShare : Share :=
  { (default : Share) with visibility := .«public», expiresAt := some 10 }

example : openShare.visibility = .«public» := only_a_public_share_opens openShare 3 (by decide)
example := revoked_link_never_opens { openShare with revokedAt := some 1 } rfl 3
example := suspended_link_does_not_open { openShare with suspendedAt := some 1 } rfl rfl 3
example := stopped_link_does_not_open { openShare with stopped := true } rfl rfl rfl 3
example := expiry_closes_the_link_at_its_instant openShare 10 rfl rfl rfl rfl rfl
example := live_public_share_always_opens { openShare with expiresAt := none } rfl rfl rfl rfl rfl 5
example := budget_is_exhausted_at_the_cap
  { (default : Share) with budgetCapUsd := some "20", spentUsd := "20.000000" } rfl

/-! ## The wire -/

/-- "`url` (`/p/<token>`) only when public": a share carries a URL exactly when it is public, and
that URL is `/p/` followed by its token. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")
  (ts := "packages/contracts/src/shares.ts#PUBLIC_URL_INVARIANT")
  (ts := "apps/web/app/api/shares/route.ts#toShareResource")]
theorem url_exactly_when_public (s : Share) :
    (s.url?.isSome = true ↔ s.visibility = .«public») ∧
      (s.visibility = .«public» → s.url? = some ("/p/" ++ s.token)) := by
  unfold Share.url? publicUrlPrefix
  cases hv : s.visibility <;> simp

/-- "The token of a private or workspace share never crosses the wire": no rendered key is the
token or another persistence-only column, and a non-public share renders no `url`. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")
  (ts := "packages/contracts/src/shares.ts#ShareResourceSchema")
  (ts := "apps/web/app/api/shares/route.ts#toShareResource")]
theorem token_never_crosses_the_wire_as_a_field (v : Visibility) (withViewCount : Bool) :
    (persistenceOnlyKeys.all fun k => !(resourceKeys v withViewCount).contains k) = true ∧
      (v ≠ .«public» → (resourceKeys v withViewCount).contains "url" = false) := by
  cases v <;> cases withViewCount <;> decide

/-- "`viewCount` is present on list items only": the key is rendered exactly when a count is
given. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")
  (ts := "packages/contracts/src/shares.ts#ShareListItemSchema")]
theorem view_count_only_on_list_items (v : Visibility) (withViewCount : Bool) :
    (resourceKeys v withViewCount).contains "viewCount" = withViewCount := by
  cases v <;> cases withViewCount <;> decide

/-- "Suspended links stay listed with their state visible": every rendering carries the
revocation, suspension, stop and expiry fields. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2064-administration")
  (ts := "apps/web/app/api/shares/route.ts#toShareResource")]
theorem state_fields_are_always_rendered (v : Visibility) (withViewCount : Bool) :
    (["revokedAt", "suspendedAt", "stopped", "expiresAt"].all
      (resourceKeys v withViewCount).contains) = true := by
  cases v <;> cases withViewCount <;> decide

/-- "List (mine, or all as Admin/Owner)": an Owner or Admin lists every share of the workspace,
and a Builder or Viewer lists a share exactly when it published it. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")
  (ts := "apps/web/app/api/shares/route.ts#GET")]
theorem list_is_mine_or_all_for_admins (role : Membership.Role) (viewer : PrincipalId) (s : Share) :
    (ownerOrAdmin role = true → listedFor role viewer s = true) ∧
      (ownerOrAdmin role = false → (listedFor role viewer s = true ↔ s.publisher = viewer)) := by
  cases role <;> simp [listedFor, ownerOrAdmin]

/-! ## Publish refusals and defaults -/

/-- "`400 invalid_share` (… public sharing disabled …)" and "it must be enforced server-side":
a `public` request while public sharing is off is refused with `invalid_share`, whatever the
subject, mode, role and release gate. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")
  (doc := "docs/spec.md#2064-administration")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem public_share_refused_while_public_sharing_is_off (r : PublishRequest)
    (role : Membership.Role) (runnableEnabled : Bool) (now : Nat) (hv : r.visibility = .«public») :
    publishDecision r role false runnableEnabled now = .refused .publicSharingOff ∧
      PublishRefusal.publicSharingOff.code = "invalid_share" := by
  simp [publishDecision, hv, PublishRefusal.code]

/-- "Runnable public links remain compiled off; … a typed request the server refuses (`400
invalid_share`)": with the release gate as it is today, an agent request for `runnable` mode that
public sharing does not already refuse is refused as unreleased, for every role. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")
  (ts := "apps/web/server/shares/runnable/feature.ts#runnablePublicLinksEnabled")
  (ts := "packages/contracts/src/shares.ts#SHARE_MODES")]
theorem runnable_is_refused_in_this_release (r : PublishRequest) (role : Membership.Role)
    (publicSharingEnabled : Bool) (now : Nat) (ht : r.subjectType = .agent)
    (hm : r.mode = some .runnable) (hp : r.visibility ≠ .«public» ∨ publicSharingEnabled = true) :
    publishDecision r role publicSharingEnabled runnableReleased now =
      .refused .runnableUnreleased := by
  have hpub : (r.visibility == .«public» && !publicSharingEnabled) = false := by
    rcases hp with hp | hp
    · cases hv : r.visibility <;> simp_all
    · simp [hp]
  simp [publishDecision, hpub, PublishRequest.effectiveMode, ht, hm, runnableReleased]

/-- "Publishing a **runnable** public link … requires Admin or Owner": were the release gate
open, a Builder's or Viewer's runnable request is still refused, and an Owner's or Admin's is
admitted. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#viewer")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem runnable_requires_owner_or_admin (r : PublishRequest) (role : Membership.Role) (now : Nat)
    (ht : r.subjectType = .agent) (hm : r.mode = some .runnable) :
    (ownerOrAdmin role = false →
      publishDecision r role true true now = .refused .runnableNeedsOwnerOrAdmin) ∧
    (ownerOrAdmin role = true → ∃ p, publishDecision r role true true now = .published p) := by
  constructor
  · intro h
    simp [publishDecision, PublishRequest.effectiveMode, ht, hm, h]
  · intro h
    simp [publishDecision, PublishRequest.effectiveMode, ht, hm, h]

/-- "Definition sharing is the default": an admitted agent share published without a mode is a
`definition` share, and it carries no budget. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2063-publishing-an-agent")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem agent_share_defaults_to_definition (r : PublishRequest) (role : Membership.Role)
    (pse re : Bool) (now : Nat) (p : Published) (ht : r.subjectType = .agent) (hm : r.mode = none)
    (h : publishDecision r role pse re now = .published p) :
    p.mode = some .definition ∧ p.budgetCapUsd = none := by
  simp only [publishDecision, PublishRequest.effectiveMode, ht, hm] at h
  split at h
  · cases h
  · simp at h
    subst h
    simp

/-- "Budget cap $20 total": an admitted runnable share published without a cap gets
`defaultRunnableBudgetUsd`, and one published with a cap keeps it. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2063-publishing-an-agent")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem runnable_budget_defaults_to_twenty (r : PublishRequest) (role : Membership.Role)
    (now : Nat) (ht : r.subjectType = .agent) (hm : r.mode = some .runnable)
    (hv : r.visibility ≠ .«public») (ho : ownerOrAdmin role = true) :
    publishDecision r role false true now = .published
      { mode := some .runnable, budgetCapUsd := some (r.budgetCapUsd.getD "20"),
        expiresAt := (r.expiry.getD .never).expiresAt? now,
        hasPassphraseHash := r.passphrase.any (!·.isEmpty) } := by
  have hpub : (r.visibility == .«public») = false := by
    cases hv' : r.visibility <;> simp_all
  simp [publishDecision, PublishRequest.effectiveMode, ht, hm, hpub, ho, defaultRunnableBudgetUsd]

/-- "Optional passphrase": a passphrase given at publish time is stored (as a hash), and none is
stored when none is given. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2062-publishing-a-session-run-history")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem passphrase_is_stored_exactly_when_given (r : PublishRequest) (role : Membership.Role)
    (pse re : Bool) (now : Nat) (p : Published)
    (h : publishDecision r role pse re now = .published p) :
    p.hasPassphraseHash = r.passphrase.any (!·.isEmpty) := by
  unfold publishDecision at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · cases h
        rfl

/-- "Optional … passphrase" on opening: a public link that is open and has a passphrase opens
only for the right passphrase, and answers `invalid_passphrase` to a missing or wrong one. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2062-publishing-a-session-run-history")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem passphrase_gates_an_open_link (s : Share) (now : Nat) (ho : s.publiclyOpen now = true)
    (hp : s.passphraseRequired = true) :
    s.resolveAt now .right = .opened ∧ s.resolveAt now .wrong = .invalidPassphrase ∧
      s.resolveAt now .absent = .invalidPassphrase ∧
      ResolveOutcome.invalidPassphrase.code? = some "invalid_passphrase" := by
  simp [Share.resolveAt, ho, hp, ResolveOutcome.code?]

/-- "Neither is required": an open public link without a passphrase opens for every visitor,
whatever it presents. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#2062-publishing-a-session-run-history")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem link_without_passphrase_opens_for_everyone (s : Share) (now : Nat)
    (ho : s.publiclyOpen now = true) (hp : s.passphraseHash = none) (a : PassphraseAttempt) :
    s.resolveAt now a = .opened := by
  simp [Share.resolveAt, Share.passphraseRequired, ho, hp]

private def agentRequest : PublishRequest :=
  { subjectType := .agent, visibility := .«private» }

private def protectedShare : Share :=
  { (default : Share) with visibility := .«public», passphraseHash := some "h" }

example := public_share_refused_while_public_sharing_is_off
  { agentRequest with visibility := .«public» } .owner true 0 rfl
example := runnable_is_refused_in_this_release { agentRequest with mode := some .runnable } .owner
  true 0 rfl rfl (.inr rfl)
example := runnable_requires_owner_or_admin { agentRequest with mode := some .runnable } .viewer 0
  rfl rfl
example := agent_share_defaults_to_definition agentRequest .viewer true false 0
  { mode := some .definition, budgetCapUsd := none, expiresAt := none, hasPassphraseHash := false }
  rfl rfl (by decide)
example := runnable_budget_defaults_to_twenty { agentRequest with mode := some .runnable } .admin 0
  rfl rfl (by decide) rfl
example := passphrase_is_stored_exactly_when_given { agentRequest with passphrase := some "x" }
  .builder true false 0
  { mode := some .definition, budgetCapUsd := none, expiresAt := none, hasPassphraseHash := true }
  (by decide)
example := passphrase_gates_an_open_link protectedShare 0 (by decide) rfl
example := link_without_passphrase_opens_for_everyone { protectedShare with passphraseHash := none }
  0 (by decide) rfl .absent
example := list_is_mine_or_all_for_admins .builder ⟨"p"⟩ default

/-! ## Relationships -/

/-- The ER diagram's `workspace_principals ||--o{ shares : "publisher_principal_id"`: every share
has a non-null publisher, and the key to its principal is tenant-paired. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/shares.ts#shares_publisher_principal_workspace_fk")]
theorem every_share_has_a_publisher_principal :
    (catalogue .shares).isNotNull "publisher_principal_id" = true ∧
      sharesPublisherKey ∈ (catalogue .shares).foreignKeys ∧
      classify catalogue .shares sharesPublisherKey = .tenantPaired := by decide

/-- The ER diagram's `shares.created_by FK`: the legacy creator column is nullable (an API-key
principal has no user) and references `users`, paired with a membership of the same workspace. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/shares.ts#shares_creator_workspace_fk")]
theorem creator_is_legacy_nullable_attribution :
    (catalogue .shares).isNotNull "created_by" = false ∧
      (catalogue .shares).foreignKeySignature? "shares_created_by_users_id_fk" =
        some (["created_by"], .users, ["id"], .restrict) ∧
      (catalogue .shares).foreignKeySignature? "shares_creator_workspace_fk" =
        some (["workspace_id", "created_by"], .memberships, ["workspace_id", "user_id"],
          .noAction) := by decide

/-- "`run_id` is the primary key because a run may be funded by at most one share": the charge
table is keyed by the run alone. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem charge_is_keyed_by_the_run :
    (catalogue .shareRunCharges).primaryKey = ["run_id"] ∧
      TableName.idKind? .shareRunCharges = none := by decide

/-- Deleting a share deletes its views and its charges (`ON DELETE CASCADE`), and deleting a run
deletes its charge; deleting the workspace deletes all three tables' rows. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/share-views.ts#share_views_share_workspace_fk")
  (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem share_children_cascade :
    ((catalogue .shareViews).foreignKey? "share_views_share_workspace_fk").map (·.onDelete) =
        some .cascade ∧
      ((catalogue .shareRunCharges).foreignKey? "share_run_charges_share_workspace_fk").map
        (·.onDelete) = some .cascade ∧
      ((catalogue .shareRunCharges).foreignKey? "share_run_charges_run_workspace_fk").map
        (·.onDelete) = some .cascade ∧
      (tables.all fun t => (catalogue t).foreignKeys.all fun fk =>
        fk.refTable != .workspaces || fk.onDelete == .cascade) = true := by decide

/-- "The share view and run charge tables are public share-page accounting, out of scope for the
SDK": neither carries an owner or publisher column. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/07-structure-map.md#tables-the-sdk-does-not-reach")
  (ts := "packages/core/src/db/schema/share-views.ts#shareViews")]
theorem share_children_carry_no_principal :
    (["owner_principal_id", "publisher_principal_id"].all fun c =>
      !(catalogue .shareViews).hasColumn c && !(catalogue .shareRunCharges).hasColumn c) = true := by
  decide

end AgentWorkspace.Theorems.Normative.ConceptPublication
