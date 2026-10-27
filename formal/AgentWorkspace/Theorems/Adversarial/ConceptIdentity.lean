import AgentWorkspace.Theorems.Invariants.ConceptIdentity

/-!
T3 — what a caller who controls ids and request bodies cannot achieve with the identity tables.

The attacker controls every id they write into a row (including ids copied from another
workspace) and the scope they ask a browser token for. They must not obtain: a browser token
minted in another workspace's name, a token scoped to another workspace's run or session, a
principal backed by another workspace's membership or API key, a browser token admitted on a run
or session other than its own, or a browser token admitted as a principal other than its minter
or outside its workspace, or an API key that outlives the principal it acts for (S1-24).

The composite keys make the first four unrepresentable in a consistent state: whatever row a
forged id names, the key pins a parent with the child's `workspace_id`, and the parent's `id` is
its primary key, so the named row *is* that parent. The admission theorems quantify over every
scoped row and every principal row a request could resolve.
-/

namespace AgentWorkspace.Theorems.Adversarial.ConceptIdentity

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Identity
  AgentWorkspace.Er.Current.Identity.Lemmas AgentWorkspace.Concepts.Membership
  AgentWorkspace.Concepts.BrowserToken AgentWorkspace.Concepts.Principal
  AgentWorkspace.Concepts.Workspace

private abbrev W := Invariants.ConceptIdentity.Witness.state

private theorem w_consistent : Er.Core.consistent catalogue W = true := by decide +kernel

/-- Whatever principal id a browser-token row names as its minter, in every consistent state the
principal with that id belongs to the token's workspace: no token is minted in the name of
another workspace's principal. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_minter_workspace_fk")]
theorem foreign_principal_cannot_mint_a_browser_token (st : Er.Core.State)
    (hc : Er.Core.consistent catalogue st = true) {t p : Row} (ht : t ∈ st .browserTokens)
    (hp : p ∈ st .workspacePrincipals) (hid : p.get "id" = t.get "minted_by_principal_id") :
    p.get "workspace_id" = t.get "workspace_id" :=
  paired_parent_same_workspace (t := .browserTokens)
    (fk := fkOf .browserTokens "browser_tokens_minter_workspace_fk") hc (by decide +kernel) (by decide +kernel) ht
    (not_null_present (t := .browserTokens) hc (by decide +kernel) ht) hp hid

example : (⟨[("id", "p2"), ("workspace_id", "w1"), ("kind", "api_key"), ("api_key_id", "k1"),
    ("activated_at", "1000"), ("acts_for_principal_id", "p1"), ("created_at", "1000")]⟩ : Row).get "workspace_id" = some "w1" :=
  foreign_principal_cannot_mint_a_browser_token W w_consistent (t := (W .browserTokens).head!)
    (by decide +kernel) (by decide +kernel) (by decide +kernel)

/-- Whatever run id a run-scoped browser-token row names, in every consistent state the run with
that id belongs to the token's workspace: a token cannot be scoped to another workspace's run. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_run_workspace_fk")]
theorem foreign_run_cannot_scope_a_browser_token (st : Er.Core.State)
    (hc : Er.Core.consistent catalogue st = true) {t run : Row} (ht : t ∈ st .browserTokens)
    (hset : (t.get "run_id").isSome = true) (hr : run ∈ st .runs)
    (hid : run.get "id" = t.get "run_id") : run.get "workspace_id" = t.get "workspace_id" := by
  have hws : (t.get "workspace_id").isSome = true := by
    have := not_null_present (t := .browserTokens) (cols := ["workspace_id"]) hc (by decide +kernel) ht
    simpa [Row.present] using this
  exact paired_parent_same_workspace (t := .browserTokens)
    (fk := fkOf .browserTokens "browser_tokens_run_workspace_fk") hc (by decide +kernel) (by decide +kernel) ht
    (by simp [fkOf, Row.present, catalogue, TableSpec.foreignKey?, hset, hws]) hr hid

example : ((W .runs).head!).get "workspace_id" = ((W .browserTokens).head!).get "workspace_id" :=
  foreign_run_cannot_scope_a_browser_token W w_consistent (by decide +kernel) (by decide +kernel) (by decide +kernel)
    (by decide +kernel)

/-- Whatever session id a session-scoped browser-token row names, in every consistent state the
session with that id belongs to the token's workspace. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_session_workspace_fk")]
theorem foreign_session_cannot_scope_a_browser_token (st : Er.Core.State)
    (hc : Er.Core.consistent catalogue st = true) {t s : Row} (ht : t ∈ st .browserTokens)
    (hset : (t.get "session_id").isSome = true) (hs : s ∈ st .sessions)
    (hid : s.get "id" = t.get "session_id") : s.get "workspace_id" = t.get "workspace_id" := by
  have hws : (t.get "workspace_id").isSome = true := by
    have := not_null_present (t := .browserTokens) (cols := ["workspace_id"]) hc (by decide +kernel) ht
    simpa [Row.present] using this
  exact paired_parent_same_workspace (t := .browserTokens)
    (fk := fkOf .browserTokens "browser_tokens_session_workspace_fk") hc (by decide +kernel) (by decide +kernel)
    ht (by simp [fkOf, Row.present, catalogue, TableSpec.foreignKey?, hset, hws]) hs hid

example : ((W .sessions).head!).get "workspace_id" =
    ((W .browserTokens).getD 1 default).get "workspace_id" :=
  foreign_session_cannot_scope_a_browser_token W w_consistent (by decide +kernel) (by decide +kernel) (by decide +kernel)
    (by decide +kernel)

/-- Whatever membership id a principal row names, in every consistent state the membership with
that id belongs to the principal's workspace: no principal is backed by another workspace's
member. -/
@[aw_spec (tier := T3) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_membership_workspace_fk")]
theorem foreign_membership_cannot_back_a_principal (st : Er.Core.State)
    (hc : Er.Core.consistent catalogue st = true) {p m : Row} (hp : p ∈ st .workspacePrincipals)
    (hset : (p.get "membership_id").isSome = true) (hm : m ∈ st .memberships)
    (hid : m.get "id" = p.get "membership_id") : m.get "workspace_id" = p.get "workspace_id" := by
  have hws : (p.get "workspace_id").isSome = true := by
    have := not_null_present (t := .workspacePrincipals) (cols := ["workspace_id"]) hc
      (by decide +kernel) hp
    simpa [Row.present] using this
  exact paired_parent_same_workspace (t := .workspacePrincipals)
    (fk := fkOf .workspacePrincipals "workspace_principals_membership_workspace_fk") hc
    (by decide +kernel) (by decide +kernel) hp
    (by simp [fkOf, Row.present, catalogue, TableSpec.foreignKey?, hset, hws]) hm hid

example : ((W .memberships).head!).get "workspace_id" =
    ((W .workspacePrincipals).head!).get "workspace_id" :=
  foreign_membership_cannot_back_a_principal W w_consistent (by decide +kernel) (by decide +kernel) (by decide +kernel)
    (by decide +kernel)

/-- Whatever API-key id a principal row names, in every consistent state the key with that id
belongs to the principal's workspace. -/
@[aw_spec (tier := T3) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_api_key_workspace_fk")]
theorem foreign_api_key_cannot_back_a_principal (st : Er.Core.State)
    (hc : Er.Core.consistent catalogue st = true) {p k : Row} (hp : p ∈ st .workspacePrincipals)
    (hset : (p.get "api_key_id").isSome = true) (hk : k ∈ st .apiKeys)
    (hid : k.get "id" = p.get "api_key_id") : k.get "workspace_id" = p.get "workspace_id" := by
  have hws : (p.get "workspace_id").isSome = true := by
    have := not_null_present (t := .workspacePrincipals) (cols := ["workspace_id"]) hc
      (by decide +kernel) hp
    simpa [Row.present] using this
  exact paired_parent_same_workspace (t := .workspacePrincipals)
    (fk := fkOf .workspacePrincipals "workspace_principals_api_key_workspace_fk") hc
    (by decide +kernel) (by decide +kernel) hp
    (by simp [fkOf, Row.present, catalogue, TableSpec.foreignKey?, hset, hws]) hk hid

example : ((W .apiKeys).head!).get "workspace_id" =
    ((W .workspacePrincipals).getD 1 default).get "workspace_id" :=
  foreign_api_key_cannot_back_a_principal W w_consistent (by decide +kernel) (by decide +kernel) (by decide +kernel)
    (by decide +kernel)

/-- A principal row in one workspace that names another workspace's membership makes the state
inconsistent: the forged row is refused. -/
@[aw_spec (tier := T3) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_membership_workspace_fk")]
theorem forged_principal_source_is_refused :
    Er.Core.consistent catalogue (fun t => if t = .workspacePrincipals then
      ⟨[("id", "p9"), ("workspace_id", "w2"), ("kind", "membership"), ("membership_id", "m1"),
        ("activated_at", "1000"), ("created_at", "1000")]⟩ :: W t else W t) = false := by
  decide +kernel

/-! ## Admission: whatever rows the caller can point a token at -/

/-- The run-scoped token the admission examples use, minted by `p` in `w`, live until 300. -/
private def advToken : BrowserToken := ⟨⟨"t"⟩, ⟨"w"⟩, ⟨"p"⟩, .run ⟨"r"⟩, "h", 300, none, 10⟩

/-- Its minter, a membership principal of `w`. -/
private def advMinter : Principal := ⟨⟨"p"⟩, ⟨"w"⟩, .membership ⟨"m"⟩, 10, none, 10, none⟩

/-- Whatever scoped row a request resolves, a browser token is admitted only on the very run or
session its row names: the admitted row's scope is the token's scope. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")]
theorem browser_token_acts_only_on_its_own_scoped_row (t : BrowserToken) (row : ScopedRow)
    (m : Principal) (src : SourceRow) (now : Instant)
    (h : browserTokenAdmitted t (some row) m src now = true) : row.scope = t.scope := by
  simp only [browserTokenAdmitted, Bool.and_eq_true] at h
  have hs := h.1.1.1.2
  revert hs
  cases ht : t.scope <;> cases row <;> simp [scopeOpen, ScopedRow.scope] <;> intros <;> simp_all

example : (ScopedRow.run ⟨"r"⟩ .running).scope = advToken.scope :=
  browser_token_acts_only_on_its_own_scoped_row _ _ advMinter (.membership true) 100 (by decide +kernel)

/-- A token minted for run `R` cannot act on any other run `R′`, whatever that run's status, the
minter, or the instant. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")]
theorem token_for_one_run_cannot_act_on_another_run (t : BrowserToken) (r r' : RunId)
    (hs : t.scope = .run r) (hne : r' ≠ r) (st : Contracts.RunStatus) (m : Principal)
    (src : SourceRow) (now : Instant) :
    browserTokenAdmitted t (some (.run r' st)) m src now = false := by
  cases h : browserTokenAdmitted t (some (.run r' st)) m src now with
  | false => rfl
  | true =>
    have := browser_token_acts_only_on_its_own_scoped_row _ _ _ _ _ h
    simp [ScopedRow.scope, hs] at this
    exact absurd this hne

example : browserTokenAdmitted advToken (some (.run ⟨"r2"⟩ .running)) advMinter
      (.membership true) 100 = false ∧
    browserTokenAdmitted advToken (some (.run ⟨"r"⟩ .running)) advMinter
      (.membership true) 100 = true :=
  ⟨token_for_one_run_cannot_act_on_another_run _ ⟨"r"⟩ ⟨"r2"⟩ rfl (by decide +kernel) _ _ _ _, by decide⟩

/-- A token minted for session `S` cannot act on any other session `S′`. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")]
theorem token_for_one_session_cannot_act_on_another_session (t : BrowserToken) (s s' : SessionId)
    (hs : t.scope = .session s) (hne : s' ≠ s) (st : Concepts.Session.SessionStatus)
    (m : Principal) (src : SourceRow) (now : Instant) :
    browserTokenAdmitted t (some (.session s' st)) m src now = false := by
  cases h : browserTokenAdmitted t (some (.session s' st)) m src now with
  | false => rfl
  | true =>
    have := browser_token_acts_only_on_its_own_scoped_row _ _ _ _ _ h
    simp [ScopedRow.scope, hs] at this
    exact absurd this hne

example : browserTokenAdmitted { advToken with scope := .session ⟨"s"⟩ }
      (some (.session ⟨"s2"⟩ .active)) advMinter (.membership true) 100 = false ∧
    browserTokenAdmitted { advToken with scope := .session ⟨"s"⟩ }
      (some (.session ⟨"s"⟩ .active)) advMinter (.membership true) 100 = true :=
  ⟨token_for_one_session_cannot_act_on_another_session _ ⟨"s"⟩ ⟨"s2"⟩ rfl (by decide +kernel) _ _ _ _,
    by decide⟩

/-- Whatever principal row a caller gets a browser token checked against, an admitted token acts
only as the principal its row names as minter, and only if that principal is in the token's own
workspace. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")
  (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_minter_workspace_fk")]
theorem browser_token_acts_only_as_its_minter_in_its_workspace (t : BrowserToken)
    (target : Option ScopedRow) (m : Principal) (src : SourceRow) (now : Instant)
    (h : browserTokenAdmitted t target m src now = true) :
    m.id = t.mintedBy ∧ m.workspace = t.workspace := by
  simp only [browserTokenAdmitted, Bool.and_eq_true, beq_iff_eq] at h
  exact ⟨h.1.1.2, h.1.2⟩

example : browserTokenAdmitted advToken (some (.run ⟨"r"⟩ .running))
      { advMinter with workspace := ⟨"w2"⟩ } (.membership true) 100 = false ∧
    browserTokenAdmitted advToken (some (.run ⟨"r"⟩ .running))
      { advMinter with id := ⟨"p2"⟩ } (.membership true) 100 = false ∧
    advMinter.workspace = advToken.workspace :=
  ⟨by decide +kernel, by decide +kernel,
    (browser_token_acts_only_as_its_minter_in_its_workspace _ (some (.run ⟨"r"⟩ .running)) _
      (.membership true) 100 (by decide +kernel)).2⟩

/-! ## A key never outlives the principal it acts for (issue #509, S1-24) -/

/-- Whatever the key row, the key's own principal row, the instant and the token say, a key that
acts for a principal is refused once that principal is revoked or its membership is gone (or it
cannot be re-read at all): the key is not admitted, its principal no longer resolves, and no browser
token it minted is admitted. -/
@[aw_spec (tier := T3)
  (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")
  (ts := "packages/core/src/db/repositories/directory.ts#principalById")
  (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")
  (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")]
theorem key_never_outlives_the_principal_it_acts_for (k : Concepts.ApiKey.ApiKey) (p : Principal) (a : PrincipalId)
    (ha : p.actsFor = some a) (target : Option ActsForRow)
    (hgone : ∀ t, target = some t → t.principal.active = false ∨ t.membershipPresent = false)
    (src : SourceRow) (now : Instant) :
    apiKeyAdmitted k p now target = false ∧ principalResolves p src now target = false ∧
      ∀ (b : BrowserToken) (row : Option ScopedRow),
        browserTokenAdmitted b row p src now target = false := by
  have hs : actsForStands p target = false := by
    unfold actsForStands
    rw [ha]
    cases target with
    | none => rfl
    | some t =>
      rcases hgone t rfl with h | h <;> simp [h]
  refine ⟨by simp [apiKeyAdmitted, hs], ?_, fun b row => ?_⟩
  · simp [principalResolves, hs]
  · simp [browserTokenAdmitted, principalResolves, hs]

/-- The bootstrap admin's membership principal, revoked at `rev` if given. -/
private def admin (rev : Option Instant) : Principal :=
  ⟨⟨"p-admin"⟩, ⟨"w"⟩, .membership ⟨"m-admin"⟩, 10, rev, 10, none⟩

/-- A local runtime key, live until 500, and its principal, which acts for the admin. -/
private def localKey : Concepts.ApiKey.ApiKey := ⟨⟨"k"⟩, ⟨"w"⟩, "aw dev local runtime x", .admin, "p", "h", none,
  some 500, none, 10, 10⟩

private def localKeyPrincipal : Principal :=
  ⟨⟨"p-key"⟩, ⟨"w"⟩, .apiKey ⟨"k"⟩, 10, none, 10, some ⟨"p-admin"⟩⟩

example : apiKeyAdmitted localKey localKeyPrincipal 100 (some ⟨admin none, true⟩) = true ∧
    apiKeyAdmitted localKey localKeyPrincipal 100 (some ⟨admin (some 50), true⟩) = false ∧
    apiKeyAdmitted localKey localKeyPrincipal 100 (some ⟨admin none, false⟩) = false ∧
    apiKeyAdmitted localKey localKeyPrincipal 100 none = false :=
  ⟨by decide +kernel,
    (key_never_outlives_the_principal_it_acts_for _ _ _ rfl _
      (fun t h => by cases h; exact Or.inl rfl) (.apiKey (some localKey)) 100).1,
    (key_never_outlives_the_principal_it_acts_for _ _ _ rfl _
      (fun t h => by cases h; exact Or.inr rfl) (.apiKey (some localKey)) 100).1,
    (key_never_outlives_the_principal_it_acts_for _ _ _ rfl none
      (fun t h => by cases h) (.apiKey (some localKey)) 100).1⟩

/-- Pointing the key at another workspace's principal of the same id, or at an API-key principal,
does not keep it admitted either. -/
example : apiKeyAdmitted localKey localKeyPrincipal 100
      (some ⟨{ admin none with workspace := ⟨"w2"⟩ }, true⟩) = false ∧
    apiKeyAdmitted localKey localKeyPrincipal 100
      (some ⟨{ admin none with source := .apiKey ⟨"k9"⟩ }, true⟩) = false := by decide +kernel

end AgentWorkspace.Theorems.Adversarial.ConceptIdentity
