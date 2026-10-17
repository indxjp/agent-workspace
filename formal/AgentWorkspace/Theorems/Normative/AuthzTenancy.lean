import AgentWorkspace.Theorems.Invariants.AuthzTenancy

/-!
T1 — the documented tenancy sentences, one theorem each: a scope names a workspace that exists;
each credential selects exactly one workspace (a session its slug's, an API key the one it was
minted in, a browser token its minter's), and a credential that is no longer live (a revoked or
expired key or token, a revoked minter or minting key, a terminal run, an archived session)
selects none, an expiry instant being already dead; a run
is looked up only inside the caller's workspace, after the route's own gates in their order, so an
absent or foreign run is `404 run_not_found`; `authorise` returns a resolver's refusal without
`decide()` and otherwise follows `decide()`; the workspace routes refuse API keys and conceal
non-membership (a `404`, never a `403`) and malformed ids; the key guard refuses each named
traversal and the empty key outside a listing; the tenant session scope has exactly two arms and
names its first failing field, its project key is
1–64 characters of `[A-Za-z0-9_-]` naming no Windows device, and a workspace id always makes a valid
one.
-/

namespace AgentWorkspace.Theorems.Normative.AuthzTenancy

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Authz.Tenancy
  AgentWorkspace.Authz.Decide AgentWorkspace.Concepts.BrowserToken

/-! ## The workspace scope -/

private theorem find_mem {α : Type} {p : α → Bool} {l : List α} {r : α} (h : l.find? p = some r) :
    r ∈ l ∧ p r = true := ⟨List.mem_of_find?_eq_some h, List.find?_some h⟩

private theorem colIs_eq {r : Row} {c v : String} (h : colIs r c v = true) : r.get c = some v := by
  simpa [colIs] using h

/-- A resolver mints a scope only after a `workspaces` row answered: by id, the row with that id;
by slug, the row with that slug, whose id the scope carries. -/
@[aw_spec (tier := T1) (doc := "docs/adr/W2-DB-02-the-repository-shape.md#decision")
  (ts := "packages/core/src/db/repositories/scope.ts#WorkspaceScopeResolver")]
theorem resolved_scope_names_an_existing_workspace (st : State) (key : String) (s : WorkspaceScope) :
    (forWorkspaceId st key = some s →
      ∃ r ∈ st .workspaces, r.get "id" = some key ∧ s.workspaceId = key) ∧
    (forWorkspaceSlug st key = some s →
      ∃ r ∈ st .workspaces, r.get "slug" = some key ∧ r.get "id" = some s.workspaceId) := by
  constructor
  · intro h
    simp only [forWorkspaceId, Option.bind_eq_some_iff, Option.map_eq_some_iff] at h
    obtain ⟨r, hr, v, hv, rfl⟩ := h
    obtain ⟨hmem, hp⟩ := find_mem hr
    have := colIs_eq hp
    exact ⟨r, hmem, this, by rw [this] at hv; cases hv; rfl⟩
  · intro h
    simp only [forWorkspaceSlug, Option.bind_eq_some_iff, Option.map_eq_some_iff] at h
    obtain ⟨r, hr, v, hv, rfl⟩ := h
    obtain ⟨hmem, hp⟩ := find_mem hr
    exact ⟨r, hmem, colIs_eq hp, hv⟩

/-! ## Workspace selection, per credential -/

/-- A session selects the workspace its verified slug names: the principal's workspace id is that
`workspaces` row's id, and its principal is an unrevoked `workspace_principals` row of that same
workspace; it is a `session` principal with no browser-token scope. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#31-credentials")
  (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")
  (ts := "apps/web/server/rbac/principal.ts#fromSession")]
theorem session_principal_is_in_the_session_workspace (st : State) (claims : SessionClaims)
    (p : RequestPrincipal) (h : identifySessionCurrent st claims = .workspace p) :
    (∃ w ∈ st .workspaces, w.get "slug" = some claims.ws ∧ w.get "id" = some p.workspaceId) ∧
    (∃ pr ∈ st .workspacePrincipals, pr.get "id" = some p.principalId ∧
      pr.get "workspace_id" = some p.workspaceId ∧ pr.get "revoked_at" = none) ∧
    p.via = .session ∧ p.scope = none := by
  unfold identifySessionCurrent at h
  split at h
  · cases h
  · rename_i m hm
    split at h
    · rename_i p' hp
      cases h
      simp only [resolveMembership, Option.bind_eq_bind, Option.bind_eq_some_iff, Option.pure_def,
        Option.some.injEq] at hm
      obtain ⟨w, hw, wid, hwid, u, hu, uid, huid, name, hname, mr, hmr, mid, hmid, role, hrole,
        pr, hpr, pid, hpid, rfl⟩ := hm
      unfold fromSession at hp
      split at hp
      · cases hp
      · split at hp
        · cases hp
        · cases hp
          obtain ⟨hwmem, hwp⟩ := find_mem hw
          obtain ⟨hprmem, hprp⟩ := find_mem hpr
          simp only [colIs, Bool.and_eq_true, beq_iff_eq, Option.isNone_iff_eq_none] at hprp
          exact ⟨⟨w, hwmem, colIs_eq hwp, hwid⟩, ⟨pr, hprmem, hpid, hprp.1.1.1, hprp.2⟩, rfl, rfl⟩
    · cases h

/-- An API key selects the workspace it was minted in: the principal's workspace is the key row's
(the one whose hash was presented), and its principal row is paired with the key in that same
workspace. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#32-workspace-selection")
  (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")
  (ts := "apps/web/server/rbac/principal.ts#fromApiKey")]
theorem api_key_principal_is_in_the_key_workspace (st : State) (keyHash : String) (now : Nat)
    (i : ApiKeyIdentity) (h : authenticateApiKey st keyHash now = some i) :
    ∃ k ∈ st .apiKeys, k.get "key_hash" = some keyHash ∧
      k.get "workspace_id" = some (fromApiKey i).workspaceId ∧
      ∃ pr ∈ st .workspacePrincipals, pr.get "id" = some (fromApiKey i).principalId ∧
        pr.get "workspace_id" = some (fromApiKey i).workspaceId := by
  unfold authenticateApiKey at h
  dsimp only at h
  split at h
  · cases h
  · rename_i k pr hfind
    simp only [Option.bind_eq_bind, Option.bind_eq_some_iff, Option.pure_def, Option.some.injEq] at h
    obtain ⟨pid, hpid, kid, hkid, ws, hws, name, hname, role, hrole, rfl⟩ := h
    obtain ⟨hmem, hp⟩ := find_mem hfind
    simp only [Bool.and_eq_true] at hp
    simp only [List.mem_flatMap, List.mem_map, List.mem_filter, Prod.mk.injEq] at hmem
    obtain ⟨k', hk', pr', ⟨hpr', hpair⟩, rfl, rfl⟩ := hmem
    simp only [Bool.and_eq_true] at hpair
    have hpw : pr'.get "workspace_id" = k'.get "workspace_id" := by
      have := hpair.1
      unfold colsEq at this
      split at this
      · rename_i x y hx hy
        simp only [beq_iff_eq] at this
        rw [hx, hy, this]
      · cases this
    exact ⟨k', hk', colIs_eq hp.1.1.1, hws, pr', hpr', hpid, by rw [hpw, hws]; rfl⟩

/-- A browser token selects its minter's workspace, which is the token row's own: the principal is
the minter's (re-read in the token's workspace) with the token's scope attached. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/composition/session-rbac.ts#installRbacApi")
  (ts := "apps/web/server/rbac/principal.ts#fromBrowserToken")]
theorem browser_token_principal_is_in_the_token_workspace (st : State) (tokenHash : String)
    (now : Nat) (p : RequestPrincipal) (h : resolveBrowserToken st tokenHash now = some p) :
    ∃ b ∈ st .browserTokens, b.get "token_hash" = some tokenHash ∧
      b.get "workspace_id" = some p.workspaceId ∧
      b.get "minted_by_principal_id" = some p.principalId ∧
      p.via = .browserToken ∧ p.scope.isSome = true := by
  simp only [resolveBrowserToken, Option.bind_eq_bind, Option.bind_eq_some_iff, Option.pure_def,
    Option.some.injEq] at h
  obtain ⟨b, hb, ws, hws, scope, _, ts, _, mid, hmid, rec, hrec, rfl⟩ := h
  obtain ⟨hbmem, hbp⟩ := find_mem hb
  simp only [Bool.and_eq_true] at hbp
  have hrecws : rec.workspaceId = ws ∧ rec.principalId = mid := by
    unfold principalById at hrec
    simp only [Option.bind_eq_bind, Option.bind_eq_some_iff] at hrec
    obtain ⟨pr, _, hk⟩ := hrec
    split at hk
    · simp only [Option.bind_eq_some_iff, Option.pure_def, Option.some.injEq] at hk
      obtain ⟨_, _, _, _, _, _, _, _, _, _, _, _, rfl⟩ := hk
      exact ⟨rfl, rfl⟩
    · simp only [Option.bind_eq_some_iff] at hk
      obtain ⟨_, _, _, _, hk⟩ := hk
      split at hk
      · cases hk
      · split at hk
        · cases hk
        · simp only [Option.bind_eq_some_iff, Option.pure_def, Option.some.injEq] at hk
          obtain ⟨_, _, _, _, rfl⟩ := hk
          exact ⟨rfl, rfl⟩
  refine ⟨b, hbmem, colIs_eq hbp.1.1, ?_, ?_, rfl, rfl⟩
  · simp only [fromBrowserToken, fromDirectoryRecord, hrecws.1]; exact hws
  · simp only [fromBrowserToken, fromDirectoryRecord, hrecws.2]; exact hmid

/-! ## A credential that is no longer live selects no workspace -/

/-- `Principal.fromSession` refuses a workspace whose slug is not the verified session's. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/rbac/principal.ts#fromSession")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
theorem session_for_another_workspace_is_refused (claims : SessionClaims) (ws : SessionWorkspace)
    (role : String) (identity : MemberIdentity) (hslug : ws.slug ≠ claims.ws) :
    fromSession claims ws role identity = .error .workspaceMismatch := by
  simp [fromSession, hslug]

/-- `Principal.fromSession` refuses an identity whose principal id, user id or label is blank, even
for the session's own workspace. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/rbac/principal.ts#fromSession")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
theorem session_with_a_blank_identity_is_refused (claims : SessionClaims) (ws : SessionWorkspace)
    (role : String) (identity : MemberIdentity) (hslug : ws.slug = claims.ws)
    (hblank : Text.isBlank identity.principalId = true ∨ Text.isBlank identity.userId = true ∨
      Text.isBlank identity.label = true) :
    fromSession claims ws role identity = .error .incompleteIdentity := by
  rcases hblank with h | h | h <;> simp [fromSession, hslug, h]

/-- A revoked or expired API key selects no workspace: when every `api_keys` row with the presented
hash is revoked, or carries an expiry that is not after `now`, authentication answers nothing (a
revoked, expired and unknown key are indistinguishable). -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#31-credentials")
  (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")]
theorem revoked_or_expired_api_key_selects_no_workspace (st : State) (keyHash : String) (now : Nat)
    (hdead : ∀ k ∈ st .apiKeys, k.get "key_hash" = some keyHash →
      (k.get "revoked_at").isSome = true ∨
        ((k.get "expires_at").isSome = true ∧ after (k.get "expires_at") now = false)) :
    authenticateApiKey st keyHash now = none := by
  unfold authenticateApiKey
  dsimp only
  rw [List.find?_eq_none.2]
  intro kp hkp hp
  simp only [List.mem_flatMap, List.mem_map, List.mem_filter] at hkp
  obtain ⟨k, hk, pr, _, rfl⟩ := hkp
  simp only [Bool.and_eq_true, Bool.or_eq_true, Option.isNone_iff_eq_none] at hp
  obtain ⟨⟨⟨hh, hrev⟩, _⟩, hexp⟩ := hp
  rcases hdead k hk (colIs_eq hh) with h | ⟨hs, ha⟩
  · simp [hrev] at h
  · rcases hexp with h | h
    · simp [h] at hs
    · simp [h] at ha

/-- An API key whose workspace principal is revoked selects no workspace, even while the key row
itself is live. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#31-credentials")
  (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")]
theorem api_key_of_a_revoked_principal_selects_no_workspace (st : State) (keyHash : String)
    (now : Nat) (hrev : ∀ pr ∈ st .workspacePrincipals, (pr.get "revoked_at").isSome = true) :
    authenticateApiKey st keyHash now = none := by
  unfold authenticateApiKey
  dsimp only
  rw [List.find?_eq_none.2]
  intro kp hkp hp
  simp only [List.mem_flatMap, List.mem_map, List.mem_filter] at hkp
  obtain ⟨k, hk, pr, ⟨hpr, _⟩, rfl⟩ := hkp
  simp only [Bool.and_eq_true, Option.isNone_iff_eq_none] at hp
  have := hrev pr hpr
  simp [hp.1.2] at this

private theorem principalById_live (st : State) (ws pid : String) (now : Nat) (rec : DirectoryRecord)
    (h : principalById st ws pid now = some rec) :
    rec.workspaceId = ws ∧ rec.principalId = pid ∧
      ∃ pr ∈ st .workspacePrincipals, pr.get "id" = some pid ∧ pr.get "workspace_id" = some ws ∧
        pr.get "revoked_at" = none := by
  unfold principalById at h
  simp only [Option.bind_eq_bind, Option.bind_eq_some_iff] at h
  obtain ⟨pr, hpr, hk⟩ := h
  obtain ⟨hmem, hp⟩ := find_mem hpr
  simp only [colIs, Bool.and_eq_true, beq_iff_eq, Option.isNone_iff_eq_none] at hp
  have live : ∃ pr ∈ st .workspacePrincipals, pr.get "id" = some pid ∧
      pr.get "workspace_id" = some ws ∧ pr.get "revoked_at" = none :=
    ⟨pr, hmem, hp.1.2, hp.1.1, hp.2⟩
  split at hk
  · simp only [Option.bind_eq_some_iff, Option.pure_def, Option.some.injEq] at hk
    obtain ⟨_, _, _, _, _, _, _, _, _, _, _, _, rfl⟩ := hk
    exact ⟨rfl, rfl, live⟩
  · simp only [Option.bind_eq_some_iff] at hk
    obtain ⟨_, _, _, _, hk⟩ := hk
    split at hk
    · cases hk
    · split at hk
      · cases hk
      · simp only [Option.bind_eq_some_iff, Option.pure_def, Option.some.injEq] at hk
        obtain ⟨_, _, _, _, rfl⟩ := hk
        exact ⟨rfl, rfl, live⟩

private theorem unpack_browser_token {st : State} {tokenHash : String} {now : Nat}
    {p : RequestPrincipal} (h : resolveBrowserToken st tokenHash now = some p) :
    ∃ b ∈ st .browserTokens, colIs b "token_hash" tokenHash = true ∧
      b.get "revoked_at" = none ∧ after (b.get "expires_at") now = true ∧
      b.get "workspace_id" = some p.workspaceId ∧
      (∃ rec, principalById st p.workspaceId p.principalId now = some rec ∧ p.kind = rec.kind ∧
        p.role = rec.role ∧ p.apiKeyId = rec.apiKeyId) ∧
      ∃ ts, p.scope = some ts ∧
        (if colIs b "scope_kind" "run" then do
            let rid ← b.get "run_id"
            let run ← (scopedSelect st ⟨p.workspaceId⟩ .runs (colIs · "id" rid)).head?
            if runTerminal run then none else some (Scope.run ⟨rid⟩)
          else do
            let sid ← b.get "session_id"
            let se ← (scopedSelect st ⟨p.workspaceId⟩ .sessions (colIs · "id" sid)).head?
            if colIs se "status" "archived" then none else some (Scope.session ⟨sid⟩) :
          Option Scope) = some ts := by
  simp only [resolveBrowserToken, Option.bind_eq_bind, Option.bind_eq_some_iff, Option.pure_def,
    Option.some.injEq] at h
  obtain ⟨b, hb, ws, hws, scope, hscope, ts, hts, mid, hmid, rec, hrec, rfl⟩ := h
  obtain ⟨hbmem, hbp⟩ := find_mem hb
  simp only [Bool.and_eq_true, Option.isNone_iff_eq_none] at hbp
  obtain ⟨hrw, hrp, _⟩ := principalById_live st ws mid now rec hrec
  have hsw : scope = ⟨ws⟩ := by
    obtain ⟨_, _, _, e⟩ := (resolved_scope_names_an_existing_workspace st ws scope).1 hscope
    cases scope; simp only at e; rw [e]
  subst hsw
  refine ⟨b, hbmem, hbp.1.1, hbp.1.2, hbp.2, ?_, ⟨rec, ?_, rfl, rfl, rfl⟩, ts, rfl, ?_⟩
  · simp only [fromBrowserToken, fromDirectoryRecord, hrw]; exact hws
  · simp only [fromBrowserToken, fromDirectoryRecord, hrw, hrp]; exact hrec
  · simp only [fromBrowserToken, fromDirectoryRecord, hrw]; exact hts

/-- A browser token selects a workspace only while it is live: its row is unrevoked and its expiry
is after `now` (an expired or revoked token authenticates as nothing). -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/composition/session-rbac.ts#installRbacApi")]
theorem browser_token_selection_requires_a_live_token (st : State) (tokenHash : String) (now : Nat)
    (p : RequestPrincipal) (h : resolveBrowserToken st tokenHash now = some p) :
    ∃ b ∈ st .browserTokens, b.get "token_hash" = some tokenHash ∧ b.get "revoked_at" = none ∧
      after (b.get "expires_at") now = true := by
  obtain ⟨b, hb, hh, hr, he, _⟩ := unpack_browser_token h
  exact ⟨b, hb, colIs_eq hh, hr, he⟩

/-- A browser token selects a workspace only while its minting principal is unrevoked in the token's
workspace and, for a key-minted token, while the minting API key itself is neither revoked nor
expired; the role it carries is the one the directory holds now (the member's current membership
role, or the key's role): revoking the minting key or principal, or demoting the minting member,
takes effect on the token's next call. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "packages/core/src/db/repositories/directory.ts#principalById")]
theorem browser_token_selection_requires_a_live_minter (st : State) (tokenHash : String) (now : Nat)
    (p : RequestPrincipal) (h : resolveBrowserToken st tokenHash now = some p) :
    (∃ pr ∈ st .workspacePrincipals, pr.get "id" = some p.principalId ∧
      pr.get "workspace_id" = some p.workspaceId ∧ pr.get "revoked_at" = none) ∧
    (p.kind = .apiKey → ∃ k ∈ st .apiKeys, k.get "workspace_id" = some p.workspaceId ∧
      k.get "id" = p.apiKeyId ∧ k.get "role" = some p.role ∧ k.get "revoked_at" = none ∧
      ((k.get "expires_at").isNone = true ∨ after (k.get "expires_at") now = true)) ∧
    (p.kind = .membership → ∃ m ∈ st .memberships, m.get "workspace_id" = some p.workspaceId ∧
      m.get "role" = some p.role) := by
  obtain ⟨_, _, _, _, _, _, ⟨rec, hrec, hkind, hrole, hkid⟩, _⟩ := unpack_browser_token h
  obtain ⟨_, hm, hk⟩ :=
    Invariants.AuthzTenancy.principal_by_id_reads_only_its_workspace st _ _ now rec hrec
  refine ⟨(principalById_live st _ _ now rec hrec).2.2, fun hp => ?_, fun hp => ?_⟩
  · obtain ⟨k, hkm, hws, hid, hr, _, hrev, hexp⟩ := hk (hkind ▸ hp)
    exact ⟨k, hkm, hws, hkid ▸ hid, hrole ▸ hr, hrev, hexp⟩
  · obtain ⟨m, hmm, hws, hr, _⟩ := hm (hkind ▸ hp)
    exact ⟨m, hmm, hws, hrole ▸ hr⟩

/-- An expiry cell is exclusive: a credential whose `expires_at` is the instant `t` is live at
`now` exactly when `now < t` (`gt(expires_at, now)`), so at its expiry instant it is already dead. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")
  (ts := "packages/core/src/db/repositories/directory.ts#principalById")]
theorem expiry_instant_is_exclusive (t now : Nat) :
    after (some (Concepts.Workspace.instantText t)) now = true ↔ now < t := by
  simp [after, Concepts.Workspace.instantOf?, Concepts.Workspace.parseInstant?_instantText]

/-- A run-scoped browser token selects a workspace only while its run exists in the token's
workspace and has not reached a terminal status (`cancelled`, `completed`, `failed`). -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/composition/session-rbac.ts#installRbacApi")]
theorem browser_token_for_a_run_requires_a_live_run (st : State) (tokenHash : String) (now : Nat)
    (p : RequestPrincipal) (h : resolveBrowserToken st tokenHash now = some p) (rid : RunId)
    (hs : p.scope = some (.run rid)) :
    ∃ r ∈ st .runs, r.get "id" = some rid.val ∧ r.get "workspace_id" = some p.workspaceId ∧
      runTerminal r = false := by
  obtain ⟨b, _, _, _, _, _, _, ts, hts, hsel⟩ := unpack_browser_token h
  rw [hs, Option.some.injEq] at hts
  subst hts
  split at hsel
  · simp only [Option.bind_eq_bind, Option.bind_eq_some_iff] at hsel
    obtain ⟨rid', _, run, hrun, hlast⟩ := hsel
    split at hlast
    · cases hlast
    · rename_i hterm
      simp only [Option.some.injEq, Scope.run.injEq] at hlast
      subst hlast
      have hmem : run ∈ scopedSelect st ⟨p.workspaceId⟩ .runs (colIs · "id" rid') :=
        List.mem_of_mem_head? hrun
      unfold scopedSelect at hmem
      rw [List.mem_filter, Bool.and_eq_true, beq_iff_eq] at hmem
      exact ⟨run, hmem.1, colIs_eq hmem.2.2, hmem.2.1, by simpa using hterm⟩
  · simp only [Option.bind_eq_bind, Option.bind_eq_some_iff] at hsel
    obtain ⟨_, _, _, _, hlast⟩ := hsel
    split at hlast <;> simp at hlast

/-- A session-scoped browser token selects a workspace only while its session exists in the token's
workspace and is not archived. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/composition/session-rbac.ts#installRbacApi")]
theorem browser_token_for_a_session_requires_a_live_session (st : State) (tokenHash : String)
    (now : Nat) (p : RequestPrincipal) (h : resolveBrowserToken st tokenHash now = some p)
    (sid : SessionId) (hs : p.scope = some (.session sid)) :
    ∃ se ∈ st .sessions, se.get "id" = some sid.val ∧ se.get "workspace_id" = some p.workspaceId ∧
      colIs se "status" "archived" = false := by
  obtain ⟨b, _, _, _, _, _, _, ts, hts, hsel⟩ := unpack_browser_token h
  rw [hs, Option.some.injEq] at hts
  subst hts
  split at hsel
  · simp only [Option.bind_eq_bind, Option.bind_eq_some_iff] at hsel
    obtain ⟨_, _, _, _, hlast⟩ := hsel
    split at hlast <;> simp at hlast
  · simp only [Option.bind_eq_bind, Option.bind_eq_some_iff] at hsel
    obtain ⟨sid', _, se, hse, hlast⟩ := hsel
    split at hlast
    · cases hlast
    · rename_i harch
      simp only [Option.some.injEq, Scope.session.injEq] at hlast
      subst hlast
      have hmem : se ∈ scopedSelect st ⟨p.workspaceId⟩ .sessions (colIs · "id" sid') :=
        List.mem_of_mem_head? hse
      unfold scopedSelect at hmem
      rw [List.mem_filter, Bool.and_eq_true, beq_iff_eq] at hmem
      exact ⟨se, hmem.1, colIs_eq hmem.2.2, hmem.2.1, by simpa using harch⟩

/-! ## Run lookup -/

private theorem find_bind_eq (i ws : String) :
    ∀ l : List Row, IdsDistinct l →
      ((l.find? (colIs · "id" i)).bind fun r => if colIs r "workspace_id" ws then some r else none) =
        l.find? (fun r => colIs r "id" i && colIs r "workspace_id" ws)
  | [], _ => rfl
  | a :: l, hd => by
    rw [IdsDistinct, List.pairwise_cons] at hd
    rw [List.find?_cons, List.find?_cons]
    cases ha : colIs a "id" i <;> cases hw : colIs a "workspace_id" ws
    · simpa using find_bind_eq i ws l hd.2
    · simpa using find_bind_eq i ws l hd.2
    · simp only [Option.bind_some, hw, Bool.and_false, Bool.false_eq_true, ite_false]
      symm
      rw [List.find?_eq_none]
      intro b hb hq
      simp only [Bool.and_eq_true] at hq
      have hai := colIs_eq ha
      have hbi := colIs_eq hq.1
      rcases hd.1 b hb with h | h
      · rw [hai] at h; cases h
      · exact h (hai.trans hbi.symm)
    · simp [hw]

/-- `findRunForPrincipal` is a lookup inside the caller's workspace: with run ids unique (the
primary key), it answers the run of that id among the caller's workspace's runs, and nothing
else — the run of another workspace and an absent run are both `null`. -/
@[aw_spec (tier := T1) (doc := "docs/adr/W1-CP-04-start-run-request-shape.md#decision")
  (ts := "apps/web/server/runs/api.ts#findRunForPrincipal")]
theorem run_lookup_is_scoped_to_the_caller (st : State) (ws runId : String)
    (hd : IdsDistinct (st .runs)) :
    findRunForPrincipal st ws runId = (workspaceView st .runs ws).find? (colIs · "id" runId) := by
  unfold findRunForPrincipal storeGet workspaceView
  rw [find_bind_eq runId ws _ hd, List.find?_filter]
  congr 1
  funext r
  have : rowTenant .runs r = r.get "workspace_id" := rfl
  simp only [this, colIs]
  cases r.get "id" == some runId <;> cases r.get "workspace_id" == some ws <;> decide

/-- Once a run route's own preflight has passed (for `revoke-tokens` its scope gate, role gate and
id check; for the other three routes the id check), it answers `404 run_not_found` with the message
"no run <id> in this workspace." for a run id with no run in the caller's workspace — whether the id
names no run at all or a run of another workspace — before the handler reads the run: never
`403`. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (ts := "apps/web/server/runs/api.ts#readRun")]
theorem run_route_answers_404_for_absent_or_foreign_runs {α : Type} (route : RunRoute) (st : State)
    (caller : RunCaller) (runId : String) (k : Row → Except RunProblem α)
    (hd : IdsDistinct (st .runs)) (hpre : runPreflight route caller runId = none)
    (hnone : ∀ r ∈ st .runs, r.get "id" = some runId → r.get "workspace_id" ≠ some caller.workspaceId) :
    runRoute route st caller runId k =
      .error ⟨404, "run_not_found", "no run " ++ runId ++ " in this workspace."⟩ := by
  have hf : findRunForPrincipal st caller.workspaceId runId = none := by
    rw [run_lookup_is_scoped_to_the_caller _ _ _ hd, List.find?_eq_none]
    intro r hr hid
    unfold workspaceView at hr
    rw [List.mem_filter, beq_iff_eq] at hr
    exact hnone r hr.1 (colIs_eq hid) hr.2
  simp only [runRoute, hpre, hf]
  rfl

/-- `revokeRunTokens` refuses a browser-token caller with `403 token_out_of_scope` first: whatever
its role and whatever the path id (well-formed or not), a scoped caller never reaches the role gate,
the id check or the run lookup. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#revokeRunTokens")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
theorem revoke_tokens_refuses_a_browser_token_first (ws role runId : String) :
    runPreflight .revokeTokens ⟨ws, role, true⟩ runId =
      some ⟨403, "token_out_of_scope", "a browser token’s scope does not reach revoking run tokens."⟩ := by
  simp [runPreflight]

/-- `revokeRunTokens` refuses an unscoped caller whose role is neither owner nor admin with
`403 run_token_revoke_forbidden`, before it checks the path id: a malformed id from such a caller is
still `403`, not `400`. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#revokeRunTokens")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")]
theorem revoke_tokens_requires_owner_or_admin_before_the_id_check (ws role runId : String)
    (hrole : role ≠ "owner" ∧ role ≠ "admin") :
    runPreflight .revokeTokens ⟨ws, role, false⟩ runId =
      some ⟨403, "run_token_revoke_forbidden",
        "only a workspace owner or admin may revoke active run tokens."⟩ := by
  simp [runPreflight, revokeTokensRoleGate, hrole.1, hrole.2]

/-- A run route whose earlier gates passed (every caller, for `read`, `events` and `interrupt`; an
unscoped owner or admin, for `revoke-tokens`) answers `400 invalid_run_id` for a path id that is not
a canonical UUID, and passes a canonical one on to the lookup. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#readRun")
  (ts := "apps/web/server/runs/api.ts#revokeRunTokens")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")]
theorem run_route_checks_the_id_after_its_gates (route : RunRoute) (caller : RunCaller)
    (runId : String)
    (hgate : route = .revokeTokens →
      caller.browserScoped = false ∧ (caller.role = "owner" ∨ caller.role = "admin")) :
    (Uuid.isCanonical runId = false → runPreflight route caller runId =
      some ⟨400, "invalid_run_id", "the run id in the path is not a UUID."⟩) ∧
    (Uuid.isCanonical runId = true → runPreflight route caller runId = none) := by
  cases route with
  | revokeTokens =>
    obtain ⟨hs, hr⟩ := hgate rfl
    have hg : revokeTokensRoleGate caller.role = true := by
      rcases hr with h | h <;> simp [revokeTokensRoleGate, h]
    exact ⟨fun hid => by simp [runPreflight, hs, hg, hid],
      fun hid => by simp [runPreflight, hs, hg, hid]⟩
  | read => exact ⟨fun hid => by simp [runPreflight, hid], fun hid => by simp [runPreflight, hid]⟩
  | events => exact ⟨fun hid => by simp [runPreflight, hid], fun hid => by simp [runPreflight, hid]⟩
  | interrupt =>
    exact ⟨fun hid => by simp [runPreflight, hid], fun hid => by simp [runPreflight, hid]⟩

/-! ## 404 before decide, and the workspace routes -/

/-- When an ownership resolver refuses, `authorise` returns the resolver's result as it is and
never consults `decide()`: whatever `decide()` would say, the answer is the same. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/W9-AUTH-117-ownership-resolver-and-404-before-decide.md#decision")
  (ts := "apps/web/server/rbac/http.ts#authorise")]
theorem resolver_refusal_bypasses_decide (p : RequestPrincipal)
    (resolve : RequestPrincipal → ResolverOutcome) (status : Nat) (code : String)
    (hres : resolve p = .refuse status code) (decideFn : RequestPrincipal → Ownership → Decision) :
    authoriseFlow true (some p) resolve decideFn = .problem status code := by
  simp [authoriseFlow, hres]

/-- When the resolver answers an ownership, `authorise` follows `decide()`: allow runs the handler
with that ownership, deny is `403` with the decision's code (`token_out_of_scope` for a scope
denial, otherwise `forbidden`), and refuse is `500 authorisation_undecidable` — a deny is never
turned into a `404`. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/rbac/http.ts#authorise")
  (doc := "docs/adr/W9-AUTH-117-ownership-resolver-and-404-before-decide.md#decision")]
theorem authorise_follows_decide_after_an_ownership (p : RequestPrincipal)
    (resolve : RequestPrincipal → ResolverOutcome) (o : Ownership) (hres : resolve p = .ownership o)
    (decideFn : RequestPrincipal → Ownership → Decision) :
    (∀ f, decideFn p o = .allow f → authoriseFlow true (some p) resolve decideFn = .allowed o) ∧
    (∀ f, decideFn p o = .deny f none →
      authoriseFlow true (some p) resolve decideFn = .problem 403 "forbidden") ∧
    (∀ f sd, decideFn p o = .deny f (some sd) →
      authoriseFlow true (some p) resolve decideFn = .problem 403 "token_out_of_scope") ∧
    (∀ r, decideFn p o = .refuse r →
      authoriseFlow true (some p) resolve decideFn = .problem 500 "authorisation_undecidable") := by
  refine ⟨fun f h => ?_, fun f h => ?_, fun f sd h => ?_, fun r h => ?_⟩ <;>
    simp [authoriseFlow, hres, h, Decision.code]

/-- Before any resolver or `decide()` runs, `authorise` answers `503 rbac_runtime_not_configured`
when the runtime is not wired and `401 unauthenticated` when no principal was identified. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/rbac/http.ts#authorise")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
theorem authorise_refuses_before_resolving (principal : Option RequestPrincipal)
    (resolve : RequestPrincipal → ResolverOutcome)
    (decideFn : RequestPrincipal → Ownership → Decision) :
    authoriseFlow false principal resolve decideFn = .problem 503 "rbac_runtime_not_configured" ∧
      authoriseFlow true none resolve decideFn = .problem 401 "unauthenticated" := by
  simp [authoriseFlow]

/-- Every workspace route refuses an API-key caller with `403 api_key_not_permitted` (for a
well-formed id), before any membership is read. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#32-workspace-selection")
  (doc := "docs/adr/W9-WS-119-api-key-callers-are-refused.md#decision")
  (ts := "apps/web/server/workspaces/access.ts#apiKeyRefusal")]
theorem api_key_caller_is_refused_on_workspace_routes (repo : WorkspaceRepo) (id : String)
    (p : RequestPrincipal) (directory : List MemberSummary) (hid : Uuid.isCanonical id = true)
    (hkey : p.via = .apiKey) :
    memberResolver repo id p directory = .refuse 403 "api_key_not_permitted" ∧
      ownerResolver repo id p directory = .refuse 403 "api_key_not_permitted" := by
  simp [memberResolver, ownerResolver, resolveMembershipView, hid, hkey, apiKeyNotPermitted]

/-- A workspace route answers `404 workspace_not_found` for a path id that is not a canonical UUID,
for every caller — an API key included: the id check comes before the API-key refusal. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/workspaces/access.ts#resolveMembershipView")
  (doc := "docs/adr/W9-WS-119-api-key-callers-are-refused.md#decision")]
theorem malformed_workspace_id_is_not_found_for_every_caller (repo : WorkspaceRepo) (id : String)
    (p : RequestPrincipal) (directory : List MemberSummary) (hid : Uuid.isCanonical id = false) :
    memberResolver repo id p directory = .refuse 404 "workspace_not_found" ∧
      ownerResolver repo id p directory = .refuse 404 "workspace_not_found" := by
  simp [memberResolver, ownerResolver, resolveMembershipView, hid, workspaceNotFound]

/-- A workspace the caller belongs to with a lesser role is measured, not concealed: the owner
resolver answers `other` (so `decide()`'s `403` applies) while the member resolver answers `own`. -/
@[aw_spec (tier := T1) (doc := "docs/adr/W9-WS-119-workspace-resource-authorisation-and-lifecycle.md")
  (ts := "apps/web/server/workspaces/access.ts#ownerOwnershipResolver")]
theorem lesser_member_is_measured_not_concealed (repo : WorkspaceRepo) (id : String)
    (p : RequestPrincipal) (directory : List MemberSummary) (u role : String)
    (hid : Uuid.isCanonical id = true) (hkey : p.via ≠ .apiKey)
    (hu : resolveMemberUserId directory p.actor = some u) (hm : getForMember repo id u = some role)
    (hrole : role ≠ "owner") :
    ownerResolver repo id p directory = .ownership .other ∧
      memberResolver repo id p directory = .ownership .own := by
  have hv : resolveMembershipView repo id p directory = .ok role := by
    simp [resolveMembershipView, hid, hkey, hu, hm]
  simp [ownerResolver, memberResolver, hv, hrole]

/-- A workspace the caller does not belong to answers exactly as one that does not exist: for a
well-formed id and a caller that is not an API key, when the caller's email names no member, or the
member it names holds no membership of that workspace (because there is none, or because the
workspace does not exist), both resolvers answer `404 workspace_not_found` — never `403`. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#32-workspace-selection")
  (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "apps/web/server/workspaces/access.ts#resolveMembershipView")]
theorem non_member_or_absent_workspace_is_not_found (repo : WorkspaceRepo) (id : String)
    (p : RequestPrincipal) (directory : List MemberSummary) (hid : Uuid.isCanonical id = true)
    (hkey : p.via ≠ .apiKey)
    (hnm : ∀ u, resolveMemberUserId directory p.actor = some u → getForMember repo id u = none) :
    memberResolver repo id p directory = .refuse 404 "workspace_not_found" ∧
      ownerResolver repo id p directory = .refuse 404 "workspace_not_found" := by
  have hv : resolveMembershipView repo id p directory = .error (.refuse 404 "workspace_not_found") := by
    cases hu : resolveMemberUserId directory p.actor with
    | none => simp [resolveMembershipView, hid, hkey, hu, workspaceNotFound]
    | some u => simp [resolveMembershipView, hid, hkey, hu, hnm u hu, workspaceNotFound]
  simp [memberResolver, ownerResolver, hv]

/-! ## The object-store key guard -/

/-- The empty key, which would name the workspace root itself, is refused as `empty-key` for a put,
get, delete and either side of a copy, and is accepted only as a listing prefix, where it lists the
workspace's own root `workspaces/<ws>`. -/
@[aw_spec (tier := T1) (doc := "docs/adr/W2-CP-03-object-key-safety.md#context")
  (ts := "packages/core/src/storage/object-store.ts#createScopedObjectStore")]
theorem empty_key_is_refused_except_as_the_root_listing (acceptWs : String → Bool) (ws : String)
    (h : acceptWs ws = true) :
    scopedObjectOp acceptWs ws (.put "") = .unsafeKey .emptyKey ∧
    scopedObjectOp acceptWs ws (.get "") = .unsafeKey .emptyKey ∧
    scopedObjectOp acceptWs ws (.delete "") = .unsafeKey .emptyKey ∧
    scopedObjectOp acceptWs ws (.copy "" "a") = .unsafeKey .emptyKey ∧
    scopedObjectOp acceptWs ws (.copy "a" "") = .unsafeKey .emptyKey ∧
    scopedObjectOp acceptWs ws (.list "") = .backend ["workspaces/" ++ ws] ∧
    scopedObjectOp acceptWs ws (.listPrefix "") = .backend ["workspaces/" ++ ws] := by
  have ha : keyGuard "a" false = .ok "a" := rfl
  have he : ∀ b, keyGuard "" b = if b then .ok "" else .error .emptyKey := by
    intro b; cases b <;> rfl
  simp [scopedObjectOp, h, guardJoin, ha, he, Except.map, fullKey, joinPrefixed, workspaceKeyPrefix]

/-- The guard's named refusals, each on its own key (ADR W2-CP-03's list): a `..` or `.` segment
(`dot-segment`), an empty segment (`empty-segment`), the metadata marker in any case
(`reserved-name`), a leading `/` or drive letter (`absolute`), a backslash, a control character and
a percent-encoded traversal; while `..config/x.txt` and `...hidden/y` stay legal. -/
@[aw_spec (tier := T1) (doc := "docs/adr/W2-CP-03-object-key-safety.md#decision")
  (ts := "packages/core/src/storage/key-safety.ts#evaluateRelativePath")]
theorem key_guard_refuses_each_named_traversal :
    keyGuard ".." false = .error .dotSegment ∧ keyGuard "a/../b" false = .error .dotSegment ∧
    keyGuard "a/./b" false = .error .dotSegment ∧ keyGuard "a//b" false = .error .emptySegment ∧
    keyGuard "a/" false = .error .emptySegment ∧
    keyGuard "x/__objectstore_meta__" false = .error .reservedName ∧
    keyGuard "x/a__OBJECTSTORE_META__.json" false = .error .reservedName ∧
    keyGuard "/etc/passwd" false = .error .absolute ∧ keyGuard "C:/x" false = .error .absolute ∧
    keyGuard "a\\b" false = .error .backslash ∧ keyGuard "a\x00b" false = .error .controlCharacter ∧
    keyGuard "w1/..%2f..%2fetc" false = .error .percentEncoded ∧
    keyGuard "..config/x.txt" false = .ok "..config/x.txt" ∧
    keyGuard "...hidden/y" false = .ok "...hidden/y" := by
  exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

/-! ## Wire spellings -/

/-- The three credential kinds are spelled `session`, `api-key` and `browser-token` on the wire, in
`principal.ts`'s order (transcribed independently from §3.1's table). -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#31-credentials")
  (ts := "apps/web/server/rbac/principal.ts#Via")]
theorem via_wire_spellings :
    (WireEnum.all (α := Via)).map WireEnum.toWire = ["session", "api-key", "browser-token"] := by
  decide

/-! ## The tenant session scope -/

/-- `validateTenantSessionScope` names the first field that fails, in order: not an object; a
`configDir` that is missing or not a string; a blank `configDir`; a `projectKey` that is missing or
not a string; a key failing the SDK pattern; a Windows device name. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/schemas.ts#validateTenantSessionScope")
  (doc := "docs/adr/W1-CORE-01-tenant-project-key-validated-before-the-run.md#decision")]
theorem tenant_scope_rejections_follow_the_field_order (fs : List (String × JValue)) (cd pk : String) :
    validateTenantSessionScope (.str cd) = .rejected .notAnObject ∧
    ((∀ c, JValue.lookup "configDir" fs ≠ some (.str c)) →
      validateTenantSessionScope (.obj fs) = .rejected .configDirNotString) ∧
    (JValue.lookup "configDir" fs = some (.str cd) → Text.isBlank cd = true →
      validateTenantSessionScope (.obj fs) = .rejected .configDirBlank) ∧
    (JValue.lookup "configDir" fs = some (.str cd) → Text.isBlank cd = false →
      (∀ k, JValue.lookup "projectKey" fs ≠ some (.str k)) →
      validateTenantSessionScope (.obj fs) = .rejected .projectKeyNotString) ∧
    (JValue.lookup "configDir" fs = some (.str cd) → Text.isBlank cd = false →
      JValue.lookup "projectKey" fs = some (.str pk) → sdkProjectDirName pk = false →
      validateTenantSessionScope (.obj fs) = .rejected .projectKeyPattern) ∧
    (JValue.lookup "configDir" fs = some (.str cd) → Text.isBlank cd = false →
      JValue.lookup "projectKey" fs = some (.str pk) → sdkProjectDirName pk = true →
      sdkWindowsDeviceName pk = true →
      validateTenantSessionScope (.obj fs) = .rejected .projectKeyDevice) := by
  refine ⟨rfl, fun hc => ?_, fun hc hb => ?_, fun hc hb hk => ?_, fun hc hb hk hp => ?_,
    fun hc hb hk hp hd => ?_⟩
  · cases h : JValue.lookup "configDir" fs with
    | none => simp [validateTenantSessionScope, h]
    | some v =>
      cases v with
      | str c => exact absurd h (hc c)
      | _ => simp [validateTenantSessionScope, h]
  · simp [validateTenantSessionScope, hc, hb]
  · cases h : JValue.lookup "projectKey" fs with
    | none => simp [validateTenantSessionScope, hc, hb, h]
    | some v =>
      cases v with
      | str k => exact absurd h (hk k)
      | _ => simp [validateTenantSessionScope, hc, hb, h]
  · simp [validateTenantSessionScope, hc, hb, hk, hp]
  · simp [validateTenantSessionScope, hc, hb, hk, hp, hd]

/-- `validateTenantSessionScope` has two arms and no third: it answers `ok` exactly when the input
is an object whose `configDir` is a non-blank string and whose `projectKey` is a string the SDK's
own validator accepts and that names no Windows device, and then it returns both unchanged. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/W1-CORE-01-tenant-project-key-validated-before-the-run.md#decision")
  (ts := "packages/core/src/schemas.ts#validateTenantSessionScope")]
theorem tenant_scope_verdict_has_two_arms (j : JValue) (pk cd : String) :
    validateTenantSessionScope j = .ok pk cd ↔
      ∃ fs, j = .obj fs ∧ JValue.lookup "configDir" fs = some (.str cd) ∧
        JValue.lookup "projectKey" fs = some (.str pk) ∧ Text.isBlank cd = false ∧
        sdkProjectDirName pk = true ∧ sdkWindowsDeviceName pk = false := by
  constructor
  · intro h
    cases j with
    | obj fs =>
      simp only [validateTenantSessionScope] at h
      split at h
      · rename_i c hc
        split at h
        · cases h
        · rename_i hb
          split at h
          · rename_i k hk
            split at h
            · cases h
            · rename_i hpat
              split at h
              · cases h
              · rename_i hdev
                cases h
                simp only [Bool.not_eq_true', Bool.not_eq_false] at hb hpat hdev
                exact ⟨fs, rfl, hc, hk, by simpa using hb, by simpa using hpat, by simpa using hdev⟩
          · cases h
      · cases h
    | _ => simp [validateTenantSessionScope] at h
  · rintro ⟨fs, rfl, hc, hk, hb, hpat, hdev⟩
    simp [validateTenantSessionScope, hc, hk, hb, hpat, hdev]

private theorem hex_is_alnum (c : Char) (h : Uuid.isHexDigit c = true) : Text.isAsciiAlnum c = true := by
  simp only [Uuid.isHexDigit, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq] at h
  simp only [Text.isAsciiAlnum, Text.isAsciiAlpha, Text.isAsciiLower, Text.isAsciiUpper,
    Text.isAsciiDigit, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq]
  rcases h with (h | h) | h
  · exact Or.inr h
  · exact Or.inl (Or.inl ⟨h.1, Char.le_trans h.2 (by decide)⟩)
  · exact Or.inl (Or.inr ⟨h.1, Char.le_trans h.2 (by decide)⟩)

private theorem uuid_length (s : String) (h : Uuid.isCanonical s = true) : s.toList.length = 36 := by
  simp only [Uuid.isCanonical, Bool.and_eq_true, beq_iff_eq] at h
  rw [h.1]; decide

/-- A workspace id (a canonical UUID) is always an accepted project key: `sandboxFor` uses the
workspace id as `projectKey`, and the SDK's validator accepts its 36 characters unchanged, so no
run's tenant session key is ever silently dropped. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/compose/run-request.ts#sandboxFor")
  (ts := "packages/core/src/schemas.ts#validateTenantSessionScope")
  (doc := "docs/adr/W1-CORE-01-tenant-project-key-validated-before-the-run.md#decision")]
theorem workspace_id_is_a_valid_project_key (ws configDir : String)
    (hws : Uuid.isCanonical ws = true) (hcd : Text.isBlank configDir = false) :
    validateTenantSessionScope (.obj [("projectKey", .str ws), ("configDir", .str configDir)]) =
      .ok ws configDir := by
  have hlen := uuid_length ws hws
  have hpat : sdkProjectDirName ws = true := by
    simp only [sdkProjectDirName, Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true,
      Bool.or_eq_true, beq_iff_eq]
    refine ⟨⟨by omega, by omega⟩, fun c hc => ?_⟩
    rcases Contracts.Identifiers.canonical_chars ws hws c hc with h | h
    · exact Or.inl (Or.inl (hex_is_alnum c h))
    · exact Or.inr h
  have hdev : sdkWindowsDeviceName ws = false := by
    have hl : (asciiLower ws).length = 36 := by simp [asciiLower, hlen]
    unfold sdkWindowsDeviceName
    split <;> first | rfl | (rename_i heq; rw [heq] at hl; simp at hl)
  exact (tenant_scope_verdict_has_two_arms _ ws configDir).2
    ⟨_, rfl, by rfl, by rfl, hcd, hpat, hdev⟩

/-- The tenant session scope a project key yields, with a fixed non-blank `configDir`. -/
private def withKey (k : String) : TenantScopeVerdict :=
  validateTenantSessionScope (.obj [("projectKey", .str k), ("configDir", .str "/sandbox/.claude")])

/-- `n` copies of `a`, as a string. -/
private def rep (n : Nat) : String := String.join (List.replicate n "a")

/-- A project key is 1 to 64 characters (`{1,64}`): the empty key and a 65-character key are
refused as `projectKeyPattern`, a 1-character and a 64-character key are accepted. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/schemas.ts#SDK_PROJECT_DIR_NAME")
  (doc := "docs/adr/W1-CORE-01-tenant-project-key-validated-before-the-run.md#decision")]
theorem project_key_is_one_to_sixty_four_characters :
    withKey "" = .rejected .projectKeyPattern ∧ withKey (rep 65) = .rejected .projectKeyPattern ∧
      withKey (rep 1) = .ok (rep 1) "/sandbox/.claude" ∧
      withKey (rep 64) = .ok (rep 64) "/sandbox/.claude" := by
  decide

/-- A project key's characters are `[A-Za-z0-9_-]` and nothing else: every one of the 128 ASCII
characters is accepted as a one-character key exactly when it is a letter, a digit, `_` or `-`
(ranges transcribed independently of `Text`). -/
@[aw_spec (tier := T1) (ts := "packages/core/src/schemas.ts#SDK_PROJECT_DIR_NAME")
  (doc := "docs/adr/W1-CORE-01-tenant-project-key-validated-before-the-run.md#decision")]
theorem project_key_character_class :
    (List.range 128).all (fun n =>
      let c := Char.ofNat n
      sdkProjectDirName (String.singleton c) ==
        ((48 ≤ n && n ≤ 57) || (65 ≤ n && n ≤ 90) || (97 ≤ n && n ≤ 122) || n == 95 || n == 45))
      = true := by
  decide

/-- The Windows device names (`con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`) are refused
as project keys in any letter case, while near misses (`com10`, `console`, `nul_`, `lpt`, `coma`)
are accepted. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/schemas.ts#SDK_WINDOWS_DEVICE_NAME")
  (doc := "docs/adr/W1-CORE-01-tenant-project-key-validated-before-the-run.md#decision")]
theorem windows_device_names_are_refused_in_any_case :
    ["con", "CON", "prn", "Prn", "aux", "AUX", "nul", "NUL", "nUl",
      "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "COM1",
      "lpt0", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9", "LpT9"].all
        (fun k => withKey k == .rejected .projectKeyDevice) = true ∧
    ["com10", "console", "nul_", "lpt", "coma", "auxx"].all
        (fun k => withKey k == .ok k "/sandbox/.claude") = true := by
  decide

/-! ## Witnesses -/

/-- A state with one workspace `one` → `w1`, its user, membership and membership principal, and
the runs `r1` of `w1` and `r2` of `w2`. -/
private def small : State
  | .workspaces => [⟨[("id", "w1"), ("slug", "one")]⟩, ⟨[("id", "w2"), ("slug", "two")]⟩]
  | .users => [⟨[("id", "u1"), ("email", "ada@example.com"), ("name", "Ada")]⟩]
  | .memberships => [⟨[("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner")]⟩]
  | .workspacePrincipals =>
    [⟨[("id", "p1"), ("workspace_id", "w1"), ("kind", "membership"), ("membership_id", "m1")]⟩,
     ⟨[("id", "p3"), ("workspace_id", "w1"), ("kind", "api_key"), ("api_key_id", "k1")]⟩]
  | .apiKeys => [⟨[("id", "k1"), ("workspace_id", "w1"), ("name", "CI"), ("role", "builder"),
      ("key_hash", "ab12")]⟩]
  | .browserTokens => [⟨[("id", "bt1"), ("workspace_id", "w1"), ("minted_by_principal_id", "p1"),
      ("scope_kind", "run"), ("run_id", "r1"), ("token_hash", "ef56"), ("expires_at", "1300")]⟩,
      ⟨[("id", "bt2"), ("workspace_id", "w1"), ("minted_by_principal_id", "p1"),
      ("scope_kind", "session"), ("session_id", "s1"), ("token_hash", "gh78"), ("expires_at", "1300")]⟩]
  | .runs => [⟨[("id", "r1"), ("workspace_id", "w1"), ("status", "running")]⟩,
      ⟨[("id", "r2"), ("workspace_id", "w2"), ("status", "running")]⟩]
  | .sessions => [⟨[("id", "s1"), ("workspace_id", "w1"), ("status", "active")]⟩]
  | _ => []

/-- `small` with table `t` replaced by `rows`. -/
private def small' (t : TableName) (rows : List Row) : State := fun u => if u = t then rows else small u

/-- The same user belongs to both workspaces. The foreign membership precedes the target one
in the repository result order, so selecting by user alone would fail to find the target's
principal and deny a valid session. -/
private def foreignMembershipFirst : State
  | .memberships =>
    [⟨[("id", "m2"), ("workspace_id", "w2"), ("user_id", "u1"), ("role", "viewer")]⟩,
     ⟨[("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner")]⟩]
  | .workspacePrincipals =>
    [⟨[("id", "p2"), ("workspace_id", "w2"), ("kind", "membership"),
      ("membership_id", "m2")]⟩,
     ⟨[("id", "p1"), ("workspace_id", "w1"), ("kind", "membership"),
      ("membership_id", "m1")]⟩]
  | t => small t

/-- `resolveMembership` must skip a same-user membership of another workspace and return the
membership principal from the workspace named by the verified session slug. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#31-credentials")
  (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")
  (ts := "apps/web/server/composition/session-rbac.ts#installRbacApi")]
theorem session_selects_target_membership_after_foreign_first :
    resolveMembership foreignMembershipFirst "ada@example.com" "one" =
      some ⟨"p1", "u1", "Ada", "w1", "owner"⟩ ∧
    ∃ p, identifySessionCurrent foreignMembershipFirst ⟨"ada@example.com", "one"⟩ =
      .workspace p ∧ p.workspaceId = "w1" ∧ p.principalId = "p1" := by
  exact ⟨rfl, ⟨_, rfl, rfl, rfl⟩⟩

example : ∃ p, resolveBrowserToken small "gh78" 1000 = some p ∧
    p.scope = some (.session ⟨"s1"⟩) := ⟨_, rfl, rfl⟩

example : ∃ p, resolveBrowserToken small "ef56" 1000 = some p ∧ p.scope = some (.run ⟨"r1"⟩) :=
  ⟨_, rfl, rfl⟩

/- The four ways a browser token stops selecting a workspace: expiry, a terminal run, an archived
session, a revoked minter. -/
example : resolveBrowserToken small "ef56" 1300 = none := by decide
example : resolveBrowserToken (small' .runs [⟨[("id", "r1"), ("workspace_id", "w1"),
    ("status", "completed")]⟩]) "ef56" 1000 = none := by decide
example : resolveBrowserToken (small' .sessions [⟨[("id", "s1"), ("workspace_id", "w1"),
    ("status", "archived")]⟩]) "gh78" 1000 = none := by decide
example : resolveBrowserToken (small' .workspacePrincipals
    [⟨[("id", "p1"), ("workspace_id", "w1"), ("kind", "membership"), ("membership_id", "m1"),
      ("revoked_at", "900")]⟩]) "ef56" 1000 = none := by decide

/- A revoked key, an expired key, and a live key of a revoked principal select nothing. -/
example : authenticateApiKey (small' .apiKeys [⟨[("id", "k1"), ("workspace_id", "w1"),
    ("name", "CI"), ("role", "builder"), ("key_hash", "ab12"), ("revoked_at", "900")]⟩]) "ab12" 1000
    = none := by decide
example : authenticateApiKey (small' .apiKeys [⟨[("id", "k1"), ("workspace_id", "w1"),
    ("name", "CI"), ("role", "builder"), ("key_hash", "ab12"), ("expires_at", "1000")]⟩]) "ab12"
    1000 = none := by decide
example : authenticateApiKey (small' .workspacePrincipals
    [⟨[("id", "p3"), ("workspace_id", "w1"), ("kind", "api_key"), ("api_key_id", "k1"),
      ("revoked_at", "900")]⟩]) "ab12" 1000 = none := by decide

example : fromSession ⟨"ada@example.com", "one"⟩ ⟨"w1", "one"⟩ "owner" ⟨"p1", "u1", "  "⟩ =
    .error .incompleteIdentity := rfl
example : fromSession ⟨"ada@example.com", "one"⟩ ⟨"w1", "two"⟩ "owner" ⟨"p1", "u1", "Ada"⟩ =
    .error .workspaceMismatch := rfl

example : ("viewer" ≠ "owner" ∧ "viewer" ≠ "admin") ∧
    runPreflight .revokeTokens ⟨"w1", "admin", false⟩ "not-a-uuid" =
      some ⟨400, "invalid_run_id", "the run id in the path is not a UUID."⟩ := by decide

example : Uuid.isCanonical "not-a-uuid" = false := by decide

/-- A viewer's session principal in `w1`. -/
private def viewer : RequestPrincipal :=
  { principalId := "p1", kind := .membership, workspaceId := "w1", label := "Ada",
    actor := "ada@example.com", role := "viewer", via := .session, userId := some "u1",
    apiKeyId := none, scope := none }

example : authoriseFlow true (some viewer) (fun _ => .ownership .own) (fun _ _ => .deny none none) = .problem 403 "forbidden" := by decide

example : forWorkspaceSlug small "one" = some ⟨"w1"⟩ ∧ forWorkspaceId small "w2" = some ⟨"w2"⟩ := by
  decide

example : ∃ p, identifySessionCurrent small ⟨"ada@example.com", "one"⟩ = .workspace p :=
  ⟨_, rfl⟩

example : ∃ i, authenticateApiKey small "ab12" 1000 = some i := ⟨_, rfl⟩

example : ∃ p, resolveBrowserToken small "ef56" 1000 = some p := ⟨_, rfl⟩

example : IdsDistinct (small .runs) ∧ runPreflight .read ⟨"w1", "owner", false⟩ "r2" ≠ none := by
  decide

example : IdsDistinct (small .runs) ∧
    runPreflight .read ⟨"w1", "owner", false⟩ "22222222-2222-4222-8222-222222222222" = none := by
  decide

example : resolveMembershipView ⟨["7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff"],
    [⟨"7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff", "u2", "viewer"⟩]⟩
    "7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff"
    { principalId := "p2", kind := .membership, workspaceId := "w", label := "Bob",
      actor := "bob@example.com", role := "viewer", via := .session, userId := some "u2",
      apiKeyId := none, scope := none } [⟨"bob@example.com", "u2"⟩] = .ok "viewer" := by rfl

example : Uuid.isCanonical "7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff" = true ∧
    Text.isBlank "/sandbox/.claude" = false := by decide

example : validateTenantSessionScope (.obj [("projectKey", .str "w1"), ("configDir", .str "/x")]) =
    .ok "w1" "/x" := by decide

/- The field-order hypotheses, each met: a blank `configDir`, a missing `projectKey`. -/
example : JValue.lookup "configDir" [("configDir", .str " ")] = some (.str " ") ∧
    Text.isBlank " " = true ∧
    validateTenantSessionScope (.obj [("configDir", .str " ")]) = .rejected .configDirBlank := by
  decide
example : validateTenantSessionScope (.obj [("configDir", .str "/x")]) =
    .rejected .projectKeyNotString := by decide

/- A non-member (the workspace exists, the caller holds no membership) and an absent workspace. -/
example : Uuid.isCanonical "7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff" = true ∧
    getForMember ⟨["7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff"],
      [⟨"7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff", "u2", "viewer"⟩]⟩
      "7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff" "u9" = none ∧
    getForMember ⟨[], []⟩ "7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff" "u2" = none := by decide

example : objectWorkspaceIdCurrent "w1" = true := by decide

/- A browser token minted by the API-key principal `p3` stops at the key's expiry instant. -/
example : resolveBrowserToken (small' .browserTokens [⟨[("id", "bt3"), ("workspace_id", "w1"),
    ("minted_by_principal_id", "p3"), ("scope_kind", "run"), ("run_id", "r1"), ("token_hash", "kt"),
    ("expires_at", "1300")]⟩]) "kt" 1000 ≠ none := by decide

end AgentWorkspace.Theorems.Normative.AuthzTenancy
