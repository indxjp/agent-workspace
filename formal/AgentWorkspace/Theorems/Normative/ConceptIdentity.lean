import AgentWorkspace.Theorems.Invariants.ConceptIdentity

/-!
T1 — documented sentences about workspaces, users, memberships, principals, API keys,
invitations and browser tokens, each pinned to the schema, the concept model or the TypeScript
function that implements it.
-/

namespace AgentWorkspace.Theorems.Normative.ConceptIdentity

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Identity
  AgentWorkspace.Er.Current.Identity.Lemmas AgentWorkspace.Concepts.Workspace AgentWorkspace.Concepts.User
  AgentWorkspace.Concepts.Membership AgentWorkspace.Concepts.ApiKey
  AgentWorkspace.Concepts.BrowserToken AgentWorkspace.Concepts.Principal
  AgentWorkspace.Concepts.Invitation

/-! ## Workspace, principal, role -/

/-- "Every membership and every API key carries exactly one of four roles": the `role` column of
`memberships` and of `api_keys` is `NOT NULL` and checked against exactly the four roles. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#membership-roles")
  (ts := "packages/core/src/db/schema/memberships.ts#memberships_role_valid")
  (ts := "packages/core/src/db/schema/api-keys.ts#api_keys_role_valid")]
theorem every_membership_and_api_key_carries_one_of_four_roles :
    (catalogue .memberships).isNotNull "role" = true ∧ (catalogue .apiKeys).isNotNull "role" = true ∧
      (catalogue .memberships).oneOfCheck? "memberships_role_valid" =
        some ("role", ["owner", "admin", "builder", "viewer"]) ∧
      (catalogue .apiKeys).oneOfCheck? "api_keys_role_valid" =
        some ("role", ["owner", "admin", "builder", "viewer"]) := by decide +kernel

/-- "A principal is … a membership … or an API key … Never a bare user": a principal row has no
`user_id` column, its kind is one of the two sources, and every source is one of the two kinds. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#11-vocabulary")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")]
theorem principal_is_a_membership_or_an_api_key_never_a_bare_user :
    (catalogue .workspacePrincipals).hasColumn "user_id" = false ∧
      (catalogue .workspacePrincipals).oneOfCheck? "workspace_principals_kind_valid" =
        some ("kind", ["membership", "api_key"]) ∧
      ∀ s : Source, s.kind = .membership ∨ s.kind = .apiKey := by
  refine ⟨by decide +kernel, by decide +kernel, fun s => ?_⟩
  cases s <;> simp [Source.kind]

/-- "An API key has no user behind it and no membership row; it *is* the principal": `api_keys`
has no `user_id` and no `membership_id`, and the principal an API key authenticates as names no
user. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")
  (ts := "packages/core/src/db/schema/api-keys.ts#apiKeys")
  (ts := "apps/web/server/rbac/principal.ts#fromApiKey")]
theorem api_key_has_no_user_and_no_membership :
    (catalogue .apiKeys).hasColumn "user_id" = false ∧
      (catalogue .apiKeys).hasColumn "membership_id" = false ∧
      ∀ i : ApiKeyIdentity, (fromApiKey i).userId = none ∧ (fromApiKey i).kind = .apiKey :=
  ⟨by decide +kernel, by decide +kernel, fun _ => ⟨rfl, rfl⟩⟩

/-- "It holds one role fixed at mint time": the key's role is one column of its row, not a scope
list, and the principal it authenticates as has exactly that role. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#api-keys-act-for-one-workspace-with-no-human-membership")
  (ts := "packages/core/src/db/schema/api-keys.ts#apiKeys")]
theorem api_key_acts_with_one_role :
    (catalogue .apiKeys).column? "role" = some ⟨"role", .text, true⟩ ∧
      (catalogue .apiKeys).hasColumn "permissions" = false ∧
      (catalogue .apiKeys).hasColumn "scopes" = false ∧
      ∀ i : ApiKeyIdentity, (fromApiKey i).role = i.role :=
  ⟨by decide +kernel, by decide +kernel, by decide +kernel, fun _ => rfl⟩

/-- "`userId` is `null` for exactly an API-key principal": the `GET /api/me` view of any
well-formed authenticated principal has a user id exactly when it is a membership. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/team.ts#MeResponseSchema")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")]
theorem me_user_id_is_null_exactly_for_an_api_key (a : Actor) (h : a.wellFormed = true) :
    (a.me.kind = .apiKey ↔ a.me.userId = none) := by
  obtain ⟨pid, kind, ws, label, user, actor, role, via, key, scope, owner⟩ := a
  cases kind <;> cases user <;> simp_all [Actor.wellFormed, Actor.me]

example : ((fromApiKey ⟨"p", "k", "w", .viewer, "CI", none⟩).me.kind = .apiKey ↔
    (fromApiKey ⟨"p", "k", "w", .viewer, "CI", none⟩).me.userId = none) :=
  me_user_id_is_null_exactly_for_an_api_key _ rfl

/-- "A user is deliberately NOT workspace-scoped … Anything that differs per workspace — a role
… — belongs on `memberships`": `users` has neither `workspace_id` nor `role`, `memberships` has
both. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/users.ts#users")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
theorem the_role_is_on_the_membership_not_the_user :
    (catalogue .users).hasColumn "workspace_id" = false ∧ (catalogue .users).hasColumn "role" = false ∧
      (catalogue .memberships).isNotNull "workspace_id" = true ∧
      (catalogue .memberships).isNotNull "role" = true := by decide +kernel

/-- "Every resource below belongs to exactly one [workspace]": each tenant-scoped identity table
has exactly one reference to `workspaces`, over a `NOT NULL` `workspace_id`. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#11-vocabulary")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_COLUMN")]
theorem identity_rows_belong_to_exactly_one_workspace :
    [TableName.memberships, .workspacePrincipals, .apiKeys, .invitations, .browserTokens,
      .cliSessions, .endpointClients, .endpointClientAgents, .endpointClientApiKeys,
      .oauthTokens].all
      (fun t => (catalogue t).isNotNull "workspace_id" &&
        ((catalogue t).foreignKeys.filter fun fk => classify catalogue t fk == .rootReference).length
          == 1) = true := by decide +kernel

/-- A slug selects at most one workspace: `workspaces_slug_key` is a unique index on the
`NOT NULL` column `slug`. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/workspaces.ts#workspaces_slug_key")]
theorem a_slug_selects_at_most_one_workspace :
    (catalogue .workspaces).uniqueSignature? "workspaces_slug_key" = some (["slug"], .index, [], []) ∧
      (catalogue .workspaces).isNotNull "slug" = true := by decide +kernel

/-- "A person holds at most one role per workspace": `(workspace_id, user_id)` is a unique
constraint of `memberships`. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/memberships.ts#memberships_workspace_user_key")]
theorem a_person_holds_at_most_one_role_per_workspace :
    (catalogue .memberships).uniqueSignature? "memberships_workspace_user_key" =
      some (["workspace_id", "user_id"], .constraint, [], []) := by decide +kernel

/-- "One (issuer, subject) binds to exactly one user, forever": the pair is a unique constraint,
and its `user_id` is `NOT NULL` and references `users`. -/
@[aw_spec (tier := T1)
  (ts := "packages/core/src/db/schema/user-identities.ts#user_identities_issuer_subject_key")]
theorem an_oidc_subject_binds_exactly_one_user :
    (catalogue .userIdentities).uniqueSignature? "user_identities_issuer_subject_key" =
        some (["issuer", "subject"], .constraint, [], []) ∧
      (catalogue .userIdentities).isNotNull "user_id" = true ∧
      (catalogue .userIdentities).foreignKeySignature? "user_identities_user_id_users_id_fk" =
        some (["user_id"], .users, ["id"], .cascade) := by decide +kernel

/-- "The source pair is tenant-paired … Deleting a membership cascades its principal row away":
both source keys of `workspace_principals` are `ON DELETE CASCADE` (a removed membership's
principal is deleted, not revoked). -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#2-state-machines")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_membership_workspace_fk")]
theorem principal_sources_cascade :
    (catalogue .workspacePrincipals).foreignKeySignature?
        "workspace_principals_membership_workspace_fk" =
        some (["workspace_id", "membership_id"], .memberships, ["workspace_id", "id"], .cascade) ∧
      (catalogue .workspacePrincipals).foreignKeySignature?
        "workspace_principals_api_key_workspace_fk" =
        some (["workspace_id", "api_key_id"], .apiKeys, ["workspace_id", "id"], .cascade) := by
  decide +kernel

/-- The first two membership rows of the witness state: Ada in two workspaces with two roles. -/
private theorem ada_rows :
    (Invariants.ConceptIdentity.Witness.state .memberships).take 2 =
      [⟨[("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner"),
          ("created_at", "1000"), ("updated_at", "1000")]⟩,
       ⟨[("id", "m2"), ("workspace_id", "w2"), ("user_id", "u1"), ("role", "viewer"),
          ("created_at", "1000"), ("updated_at", "1000")]⟩] := rfl

private theorem not_one_value_for_two {f : Option String → Option String} {a b : String}
    (hne : a ≠ b) (ha : some a = f (some "u1")) (hb : some b = f (some "u1")) : False :=
  hne (Option.some.inj (ha.trans hb.symm))

/-- "A session proves identity; RBAC proves permission; a repository scope proves tenant
selection. None substitutes for another": no function of the user alone gives, over every
consistent state, the workspace or the role of that user's memberships, while the workspace
together with the user does fix the role. -/
@[aw_spec (tier := T1) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#three-separate-questions-three-separate-mechanisms")
  (ts := "packages/core/src/db/schema/users.ts#users")
  (ts := "packages/core/src/db/schema/memberships.ts#memberships_workspace_user_key")]
theorem identity_determines_neither_tenant_nor_role :
    (¬ ∃ tenantOf : Option String → Option String, ∀ st : Er.Core.State,
        Er.Current.Identity.consistent st = true → ∀ m ∈ st .memberships,
          m.get "workspace_id" = tenantOf (m.get "user_id")) ∧
      (¬ ∃ roleOf : Option String → Option String, ∀ st : Er.Core.State,
        Er.Current.Identity.consistent st = true → ∀ m ∈ st .memberships,
          m.get "role" = roleOf (m.get "user_id")) ∧
      (∀ st : Er.Core.State, Er.Core.consistent catalogue st = true →
        ∀ m1 ∈ st .memberships, ∀ m2 ∈ st .memberships,
          m1.get "workspace_id" = m2.get "workspace_id" → m1.get "user_id" = m2.get "user_id" →
            m1.get "role" = m2.get "role") := by
  have hw : Er.Current.Identity.consistent Invariants.ConceptIdentity.Witness.state = true := by
    decide +kernel
  have mem : ∀ r ∈ (Invariants.ConceptIdentity.Witness.state .memberships).take 2,
      r ∈ Invariants.ConceptIdentity.Witness.state .memberships := fun _ h => List.mem_of_mem_take h
  rw [ada_rows] at mem
  refine ⟨fun ⟨f, hf⟩ => ?_, fun ⟨f, hf⟩ => ?_, fun st hc m1 h1 m2 h2 hws hu => ?_⟩
  · exact not_one_value_for_two (a := "w1") (b := "w2") (by decide +kernel)
      (hf _ hw _ (mem _ List.mem_cons_self))
      (hf _ hw _ (mem _ (List.mem_cons_of_mem _ List.mem_cons_self)))
  · exact not_one_value_for_two (a := "owner") (b := "viewer") (by decide +kernel)
      (hf _ hw _ (mem _ List.mem_cons_self))
      (hf _ hw _ (mem _ (List.mem_cons_of_mem _ List.mem_cons_self)))
  · have hp : m1.present ["workspace_id", "user_id"] = true :=
      not_null_present (t := .memberships) hc (by decide +kernel) h1
    have := unique_of_covers (t := .memberships) (cols := ["workspace_id", "user_id"]) hc
      (by decide +kernel) h1 h2 hp (by simp [Row.project, hws, hu])
    rw [this]

example : ∀ m1 ∈ Invariants.ConceptIdentity.Witness.state .memberships,
    ∀ m2 ∈ Invariants.ConceptIdentity.Witness.state .memberships,
      m1.get "workspace_id" = m2.get "workspace_id" → m1.get "user_id" = m2.get "user_id" →
        m1.get "role" = m2.get "role" :=
  identity_determines_neither_tenant_nor_role.2.2 _ (by decide +kernel)

/-! ## Credentials -/

/-- "Key hashes are globally unique, because presentation looks a key up by it", and so are
browser-token hashes: neither unique key includes `workspace_id`. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/api-keys.ts#api_keys_key_hash_key")
  (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_hash_key")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
theorem credential_hashes_are_globally_unique :
    (catalogue .apiKeys).uniqueSignature? "api_keys_key_hash_key" = some (["key_hash"], .index, [], []) ∧
      (catalogue .browserTokens).uniqueSignature? "browser_tokens_hash_key" =
        some (["token_hash"], .index, [], []) := by decide +kernel

/-- "Shown once": neither the API-key resource nor the invitation resource has a field for the
secret or its hash. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#shown-once-minted-keys-and-invitation-tokens")
  (ts := "packages/contracts/src/api-keys.ts#ApiKeyResourceSchema")
  (ts := "packages/contracts/src/invitations.ts#InvitationResourceSchema")]
theorem credentials_never_appear_in_resources :
    Concepts.ApiKey.resourceFields.all (fun f => !Concepts.ApiKey.credentialFields.contains f) =
        true ∧
      Concepts.Invitation.resourceFields.all
        (fun f => !Concepts.Invitation.credentialFields.contains f) = true := by
  decide +kernel

/-- "The minting principal's role is re-read from the directory on every request, never carried in
the token": a browser-token row has no role column, and names its minter by a `NOT NULL`
principal id. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "packages/core/src/db/schema/browser-tokens.ts#mintedByPrincipalId")]
theorem browser_token_carries_no_role :
    (catalogue .browserTokens).hasColumn "role" = false ∧
      (catalogue .browserTokens).isNotNull "minted_by_principal_id" = true := by decide +kernel

/-- "Attenuation, not a fourth identity": a browser-token principal is its minter's identity —
the same principal, kind, workspace, user and key — with `via = browser-token` and the scope
attached. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/principal.ts#fromBrowserToken")]
theorem browser_token_is_attenuation_not_a_fourth_identity (m : Actor) (s : Scope) :
    (fromBrowserToken m s).principalId = m.principalId ∧ (fromBrowserToken m s).kind = m.kind ∧
      (fromBrowserToken m s).workspaceId = m.workspaceId ∧
      (fromBrowserToken m s).userId = m.userId ∧ (fromBrowserToken m s).apiKeyId = m.apiKeyId ∧
      (fromBrowserToken m s).via = .browserToken ∧ (fromBrowserToken m s).scope = some s :=
  ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

/-- "A browser token is scoped to exactly one run or session": the row of any browser token sets
exactly one of `run_id` and `session_id`. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#which-credential-for-which-job")
  (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_scope_xor")]
theorem browser_token_is_scoped_to_exactly_one_run_or_session (t : BrowserToken) :
    (t.toRow.get "run_id").isSome = !(t.toRow.get "session_id").isSome := by
  obtain ⟨id, ws, m, sc, hash, exp, rev, cr⟩ := t
  cases sc <;> cases rev <;> rfl

/-- "`60 ≤ ttlSeconds ≤ 3600`, default `300`": the mint request admits exactly the TTLs in the
closed interval, and the default is inside it. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "packages/contracts/src/tokens.ts#MintTokenRequestSchema")]
theorem token_ttl_is_bounded (ttl : Nat) :
    (ttlAccepted ttl = true ↔ 60 ≤ ttl ∧ ttl ≤ 3600) ∧ ttlAccepted defaultTtlSeconds = true ∧
      defaultTtlSeconds = 300 := by
  refine ⟨?_, by decide +kernel, rfl⟩
  simp only [ttlAccepted, minTtlSeconds, maxTtlSeconds, Bool.and_eq_true]
  exact ⟨fun ⟨a, b⟩ => ⟨of_decide_eq_true a, of_decide_eq_true b⟩,
    fun ⟨a, b⟩ => ⟨decide_eq_true a, decide_eq_true b⟩⟩

/-- An API key's state follows `revoked > expired > active`, and an expiry that has exactly
arrived is expired (`expires_at > now` is what admits a key). -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
theorem api_key_state_precedence (k : ApiKey) (now : Instant) :
    (k.revokedAt.isSome = true → k.stateAt now = .revoked) ∧
      (k.revokedAt = none → k.expiresAt = some now → k.stateAt now = .expired) := by
  refine ⟨fun h => by simp [ApiKey.stateAt, h], fun h1 h2 => by simp [ApiKey.stateAt, h1, h2]⟩

/-! ## Invitations -/

/-- "The four states … a consumer derives … with a fixed precedence": revoked, then accepted, then
expired (`expiresAt ≤ now`), then pending. -/
@[aw_spec (tier := T1) (ts := "apps/web/components/team/invitations-model.ts#invitationStateOf")
  (ts := "packages/contracts/src/invitations.ts#InvitationResourceSchema")]
theorem invitation_state_precedence (i : Invitation) (now : Instant) :
    (i.revokedAt.isSome = true → i.stateAt now = .revoked) ∧
      (i.revokedAt = none → i.acceptedAt.isSome = true → i.stateAt now = .accepted) ∧
      (i.revokedAt = none → i.acceptedAt = none → i.expiresAt ≤ now → i.stateAt now = .expired) ∧
      (i.revokedAt = none → i.acceptedAt = none → now < i.expiresAt →
        i.stateAt now = .pending) := by
  refine ⟨fun h => by simp [Invitation.stateAt, h], fun h1 h2 => by simp [Invitation.stateAt, h1, h2],
    fun h1 h2 h3 => by simp [Invitation.stateAt, h1, h2, h3], fun h1 h2 h3 => ?_⟩
  simp [Invitation.stateAt, h1, h2, Nat.not_le.mpr h3]

/-- "An invitation is redeemed once … Accepted-then-revoked would be a row whose two terminal
timestamps disagree": a valid invitation is never both accepted and revoked. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/invitations.ts#invitations_not_accepted_and_revoked")]
theorem invitation_is_never_both_accepted_and_revoked (i : Invitation) (h : i.valid = true) :
    ¬(i.acceptedAt.isSome = true ∧ i.revokedAt.isSome = true) := by
  intro ⟨ha, hr⟩
  cases hacc : i.acceptedAt <;> cases hrev : i.revokedAt <;>
    simp_all [Invitation.valid]

example : ¬((some 20 : Option Instant).isSome = true ∧ (none : Option Instant).isSome = true) :=
  invitation_is_never_both_accepted_and_revoked
    ⟨⟨"i"⟩, ⟨"w"⟩, "a@b.co", .viewer, none, "h", 50, some 20, none, 10, 10⟩ (by decide +kernel)

/-- "An expired row is still pending until it is resent or revoked, so it continues to block a
duplicate": an invitation that `invitationStateOf` calls expired is still unresolved, and the
partial unique index refuses a second invitation to the same address beside it. -/
@[aw_spec (tier := T1)
  (ts := "packages/core/src/db/schema/invitations.ts#invitations_workspace_email_pending_key")]
theorem expired_invitation_still_blocks_a_duplicate :
    let old : Invitation := ⟨⟨"v1"⟩, ⟨"w1"⟩, "carol@example.com", .viewer, none, "h1", 50, none,
      none, 10, 10⟩
    let new : Invitation := ⟨⟨"v2"⟩, ⟨"w1"⟩, "carol@example.com", .admin, none, "h2", 500, none,
      none, 100, 100⟩
    old.stateAt 100 = .expired ∧ old.unresolved = true ∧
      keyHolds [old.toRow, new.toRow] ["workspace_id", "email"] ["accepted_at", "revoked_at"] =
        false := by decide +kernel

/-- "`invited_by` references `users`, not `memberships` … `ON DELETE SET NULL`": the inviter is a
nullable user id that outlives the inviter's account, not a membership or a principal. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/invitations.ts#invitedBy")]
theorem invited_by_is_a_user_that_may_be_deleted :
    (catalogue .invitations).foreignKeySignature? "invitations_invited_by_users_id_fk" =
        some (["invited_by"], .users, ["id"], .setNull) ∧
      (catalogue .invitations).isNotNull "invited_by" = false ∧
      (catalogue .invitations).hasColumn "invited_by_principal_id" = false := by decide +kernel

/-! ## Workspaces -/

/-- "Written and cleared as one pair, never one without the other": a workspace's row sets the
default connection exactly when it sets the default model. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/workspaces.ts#workspaces_default_model_pair")]
theorem workspace_default_model_is_one_pair (w : Workspace) :
    (w.toRow.get "default_model_connection_id").isSome = (w.toRow.get "default_model").isSome := by
  obtain ⟨id, slug, name, pub, dm, arch, cr, up⟩ := w
  cases dm <;> cases arch <;> rfl

/-- The two states of a workspace are `active` (no archive stamp) and `archived`. -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#2-state-machines")
  (ts := "packages/core/src/db/schema/workspaces.ts#archivedAt")]
theorem workspace_is_archived_iff_stamped (w : Workspace) :
    w.state = .archived ↔ w.archivedAt.isSome = true := by
  unfold Workspace.state
  split <;> simp_all

/-! ## Bearer shapes and admission -/

/-- A presented bearer assembled from a prefix and two halves of `idLen` and `secLen` characters. -/
def sampleBearer (pfx : String) (idLen secLen : Nat) : String :=
  pfx ++ String.ofList (List.replicate idLen 'A') ++ "_" ++
    String.ofList (List.replicate secLen 'b')

/-- "`Authorization: Bearer ak_live_<22>_<43>`" and "`awt_live_<22>_<43>`": the key grammar is
the prefix `ak_live_`, a 22-character public half and a 43-character secret half; the browser-token
grammar is the same with the prefix `awt_live_`; and each accepts exactly those half lengths. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#31-credentials")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "packages/contracts/src/api-keys.ts#API_KEY_PATTERN")
  (ts := "packages/contracts/src/tokens.ts#BROWSER_TOKEN_PATTERN")]
theorem presented_bearers_follow_the_credential_table :
    Concepts.ApiKey.prefix_ = "ak_live_" ∧ Concepts.ApiKey.idLength = 22 ∧
      Concepts.ApiKey.secretLength = 43 ∧ Concepts.BrowserToken.prefix_ = "awt_live_" ∧
      Concepts.BrowserToken.idLength = 22 ∧ Concepts.BrowserToken.secretLength = 43 ∧
      Concepts.ApiKey.presentedShaped (sampleBearer "ak_live_" 22 43) = true ∧
      Concepts.ApiKey.presentedShaped (sampleBearer "ak_live_" 21 43) = false ∧
      Concepts.ApiKey.presentedShaped (sampleBearer "ak_live_" 22 44) = false ∧
      Concepts.BrowserToken.presentedShaped (sampleBearer "awt_live_" 22 43) = true ∧
      Concepts.BrowserToken.presentedShaped (sampleBearer "awt_live_" 23 43) = false ∧
      Concepts.BrowserToken.presentedShaped (sampleBearer "awt_live_" 22 42) = false := by
  refine ⟨rfl, rfl, rfl, rfl, rfl, rfl, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> decide +kernel

/-- "The same anchored fixed-length grammar as `ak_live_` — a 22-character public half and a
43-character secret half": a browser token's halves have exactly an API key's lengths, and only the
prefix differs. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "packages/contracts/src/tokens.ts#BROWSER_TOKEN_ID_LENGTH")
  (ts := "packages/contracts/src/tokens.ts#BROWSER_TOKEN_SECRET_LENGTH")]
theorem browser_token_grammar_is_the_api_key_grammar :
    Concepts.BrowserToken.idLength = Concepts.ApiKey.idLength ∧
      Concepts.BrowserToken.secretLength = Concepts.ApiKey.secretLength ∧
      Concepts.BrowserToken.prefix_ ≠ Concepts.ApiKey.prefix_ := by decide +kernel

/-- §3.1.1 "Revocation": a browser token stops authenticating when its `expiresAt` passes, when its
scoped run reaches `cancelled`, `completed` or `failed`, when its scoped session is archived, or when
its minting principal is revoked. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")]
theorem browser_token_revocation (t : BrowserToken) (target : Option ScopedRow) (m : Principal)
    (src : SourceRow) (now : Instant) :
    (t.expiresAt ≤ now → browserTokenAdmitted t target m src now = false) ∧
      (∀ r st, st.isTerminal = true →
        browserTokenAdmitted t (some (.run r st)) m src now = false) ∧
      (∀ s, browserTokenAdmitted t (some (.session s .archived)) m src now = false) ∧
      (m.revokedAt.isSome → browserTokenAdmitted t target m src now = false) := by
  refine ⟨fun h => ?_, fun r st h => ?_, fun s => ?_, fun h => ?_⟩
  · have : t.live now = false := by simp [BrowserToken.live]; intro; omega
    simp [browserTokenAdmitted, this]
  · have : scopeOpen t.scope (some (.run r st)) = false := by
      cases t.scope <;> simp [scopeOpen, h]
    simp [browserTokenAdmitted, this]
  · have : scopeOpen t.scope (some (.session s .archived)) = false := by
      cases t.scope <;> simp [scopeOpen]
    simp [browserTokenAdmitted, this]
  · have : principalResolves m src now = false := by
      simp [principalResolves, Principal.active, Option.isSome_iff_ne_none.mp h]
    simp [browserTokenAdmitted, this]

/-- A session-scoped token minted by a member, live until 300. -/
private def sessionToken : BrowserToken := ⟨⟨"t"⟩, ⟨"w"⟩, ⟨"p"⟩, .session ⟨"s"⟩, "h", 300, none, 10⟩

/-- Its minter. -/
private def member (rev : Option Instant) : Principal :=
  ⟨⟨"p"⟩, ⟨"w"⟩, .membership ⟨"m"⟩, 10, rev, 10, none⟩

example : browserTokenAdmitted sessionToken (some (.session ⟨"s"⟩ .active)) (member none)
      (.membership true) 100 = true ∧
    browserTokenAdmitted sessionToken (some (.session ⟨"s"⟩ .archived)) (member none)
      (.membership true) 100 = false ∧
    browserTokenAdmitted sessionToken (some (.session ⟨"s"⟩ .active)) (member (some 50))
      (.membership true) 100 = false ∧
    browserTokenAdmitted sessionToken (some (.session ⟨"s"⟩ .active)) (member none)
      (.membership true) 300 = false ∧
    browserTokenAdmitted { sessionToken with scope := .run ⟨"r"⟩ } (some (.run ⟨"r"⟩ .running))
      (member none) (.membership true) 100 = true ∧
    browserTokenAdmitted { sessionToken with scope := .run ⟨"r"⟩ } (some (.run ⟨"r"⟩ .completed))
      (member none) (.membership true) 100 = false := by decide +kernel

/-! ## Admission: the principal half -/

/-- A live key of workspace `w`. -/
private def nKey : ApiKey := ⟨⟨"k"⟩, ⟨"w"⟩, "CI", .builder, "p", "h", none, some 500, none, 10, 10⟩

/-- The key's principal row, revoked at `rev` if given. -/
private def nKeyPrincipal (rev : Option Instant) : Principal :=
  ⟨⟨"p"⟩, ⟨"w"⟩, .apiKey ⟨"k"⟩, 10, rev, 10, none⟩

/-- "Revoking an API key sets `api_keys.revoked_at` and `workspace_principals.revoked_at`": a key
whose principal row is revoked is not admitted, however live the key row itself is. -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#2-state-machines")
  (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")]
theorem revoked_principal_never_admits_its_api_key (k : ApiKey) (p : Principal) (now : Instant)
    (h : p.active = false) : apiKeyAdmitted k p now = false := by
  simp [apiKeyAdmitted, h]

example : nKey.live 100 = true ∧ apiKeyAdmitted nKey (nKeyPrincipal (some 50)) 100 = false ∧
    apiKeyAdmitted nKey (nKeyPrincipal none) 100 = true :=
  ⟨rfl, revoked_principal_never_admits_its_api_key _ _ _ rfl, by decide⟩

/-- A key is admitted only through its own principal: the principal row must be in the key's
workspace and name exactly this key as its source. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")]
theorem api_key_is_admitted_only_through_its_own_principal (k : ApiKey) (p : Principal)
    (now : Instant) (target : Option ActsForRow) (h : apiKeyAdmitted k p now target = true) :
    p.workspace = k.workspace ∧ p.source = .apiKey k.id ∧ p.kind = .apiKey := by
  simp only [apiKeyAdmitted, Bool.and_eq_true, beq_iff_eq] at h
  exact ⟨h.1.1.1.1, h.1.1.1.2, by simp [Principal.kind, h.1.1.1.2, Source.kind]⟩

example : apiKeyAdmitted nKey (nKeyPrincipal none) 100 = true ∧
    apiKeyAdmitted nKey { nKeyPrincipal none with workspace := ⟨"w2"⟩ } 100 = false ∧
    apiKeyAdmitted nKey { nKeyPrincipal none with source := .apiKey ⟨"k2"⟩ } 100 = false :=
  ⟨by decide +kernel, by decide +kernel, by decide⟩

/-- A browser token whose minter no longer resolves — its principal row revoked, its membership
gone, or its minting key revoked or expired — is not admitted, whatever the token row and its scope
say. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/repositories/directory.ts#principalById")
  (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
theorem browser_token_dies_with_its_minter (t : BrowserToken) (target : Option ScopedRow)
    (m : Principal) (src : SourceRow) (now : Instant) (h : principalResolves m src now = false) :
    browserTokenAdmitted t target m src now = false := by
  simp [browserTokenAdmitted, h]

/-- The run-scoped token the key mints: live until 300. -/
private def nRunToken : BrowserToken := ⟨⟨"t"⟩, ⟨"w"⟩, ⟨"p"⟩, .run ⟨"r"⟩, "h", 300, none, 10⟩

example : browserTokenAdmitted nRunToken (some (.run ⟨"r"⟩ .running)) (nKeyPrincipal none)
      (.apiKey (some { nKey with revokedAt := some 20 })) 100 = false ∧
    browserTokenAdmitted nRunToken (some (.run ⟨"r"⟩ .running)) (nKeyPrincipal none)
      (.apiKey (some nKey)) 100 = true :=
  ⟨browser_token_dies_with_its_minter _ _ _ _ _ (by decide +kernel), by decide⟩

/-- A membership principal whose membership row is gone no longer resolves, and a browser token it
minted is no longer admitted, whatever the principal row, the token row and the scope say. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/repositories/directory.ts#principalById")
  (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")
  (doc := "docs/formal/inventory.md#2-state-machines")]
theorem removed_membership_no_longer_resolves (p : Principal) (now : Instant) :
    principalResolves p (.membership false) now = false ∧
      ∀ (t : BrowserToken) (target : Option ScopedRow),
        browserTokenAdmitted t target p (.membership false) now = false := by
  have h : principalResolves p (.membership false) now = false := by
    rcases p with ⟨id, ws, source, act, rev, cr, actsFor⟩
    cases source <;> simp [principalResolves]
  exact ⟨h, fun t target => browser_token_dies_with_its_minter t target p _ now h⟩

/-- A key-minted principal resolves only through its own key row, and only while that key is live
and the principal row active. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/repositories/directory.ts#principalById")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
theorem api_key_minter_resolves_only_through_its_own_live_key (p : Principal) (k : ApiKey)
    (now : Instant) (target : Option ActsForRow)
    (h : principalResolves p (.apiKey (some k)) now target = true) :
    p.source = .apiKey k.id ∧ k.live now = true ∧ p.active = true := by
  rcases p with ⟨id, ws, source, act, rev, cr, actsFor⟩
  cases source with
  | membership _ => simp [principalResolves] at h
  | apiKey kid =>
    simp only [principalResolves, Option.any_some, Bool.and_eq_true, beq_iff_eq] at h
    exact ⟨by rw [h.1.2.1], h.1.2.2, h.1.1⟩

example : principalResolves (nKeyPrincipal none) (.apiKey (some nKey)) 100 = true ∧
    principalResolves (nKeyPrincipal none) (.apiKey (some { nKey with id := ⟨"k2"⟩ })) 100 =
      false :=
  ⟨by decide +kernel, by decide⟩

example : (nKeyPrincipal none).source = .apiKey nKey.id :=
  (api_key_minter_resolves_only_through_its_own_live_key _ _ 100 none (by decide +kernel)).1

/-- A membership-minted principal (which acts for no one, `workspace_principals_acts_for_api_key_only`)
resolves exactly while its principal row is active and its membership row stands. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/repositories/directory.ts#principalById")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_acts_for_api_key_only")]
theorem membership_minter_resolves_iff_active_and_present (p : Principal) (mid : MembershipId)
    (hs : p.source = .membership mid) (ha : p.actsFor = none) (present : Bool) (now : Instant)
    (target : Option ActsForRow) :
    principalResolves p (.membership present) now target = (p.active && present) := by
  rcases p with ⟨id, ws, source, act, rev, cr, actsFor⟩
  subst hs
  subst ha
  cases rev <;> cases present <;> rfl

example : principalResolves (member none) (.membership true) 100 = true :=
  (membership_minter_resolves_iff_active_and_present _ ⟨"m"⟩ rfl rfl true 100 none).trans rfl

/-- A browser token whose scoped run or session row is gone is not admitted. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
theorem browser_token_without_its_scoped_row_is_refused (t : BrowserToken) (m : Principal)
    (src : SourceRow) (now : Instant) : browserTokenAdmitted t none m src now = false := by
  cases hs : t.scope <;> simp [browserTokenAdmitted, scopeOpen, hs]

/-- "`ak_live_<key id>` … cannot authenticate": a string of the display-prefix shape is neither a
presented API key nor a presented browser token. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#the-ak_live_-key-format")
  (ts := "packages/contracts/src/api-keys.ts#API_KEY_DISPLAY_PREFIX_PATTERN")
  (ts := "packages/contracts/src/api-keys.ts#API_KEY_PATTERN")]
theorem display_prefix_cannot_authenticate (s : String)
    (h : Concepts.ApiKey.displayPrefixShaped s = true) :
    Concepts.ApiKey.presentedShaped s = false ∧ Concepts.BrowserToken.presentedShaped s = false := by
  simp only [Concepts.ApiKey.displayPrefixShaped, Bool.and_eq_true, beq_iff_eq] at h
  have hl : s.toList.length = 30 := by
    rw [h.1.1]; decide +kernel
  constructor <;>
    simp [Concepts.ApiKey.presentedShaped, Concepts.BrowserToken.presentedShaped,
      bearerShaped, hl, Concepts.ApiKey.prefix_, Concepts.BrowserToken.prefix_,
      Concepts.ApiKey.idLength, Concepts.ApiKey.secretLength, Concepts.BrowserToken.idLength,
      Concepts.BrowserToken.secretLength]

example : Concepts.ApiKey.presentedShaped ("ak_live_" ++ String.ofList (List.replicate 22 'A')) =
    false :=
  (display_prefix_cannot_authenticate _ (by decide +kernel)).1

/-! ## Owner and actor (issue #509, S1-24) -/

/-- A hosted API key, one that acts for no one, owns what it writes: the owner of the principal it
authenticates as is the key's own principal. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")
  (ts := "apps/web/server/rbac/principal.ts#fromApiKey")]
theorem hosted_api_key_owns_what_it_writes (i : ApiKeyIdentity)
    (h : i.actsForPrincipalId = none) : (fromApiKey i).ownerPrincipalId = i.principalId := by
  simp [fromApiKey, ownerOf, h]

example : (fromApiKey ⟨"p", "k", "w", .admin, "CI", none⟩).ownerPrincipalId = "p" :=
  hosted_api_key_owns_what_it_writes _ rfl

/-- A local runtime key owns what it writes through the membership principal it acts for, while
the actor that audit, version authorship, minted tokens and `GET /api/me` record stays the key's own
principal. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")
  (ts := "apps/web/server/rbac/principal.ts#fromApiKey")
  (ts := "apps/web/server/cli-auth/local-credential.ts#issueLocalApiKey")]
theorem local_key_owns_through_the_principal_it_acts_for (i : ApiKeyIdentity) (a : String)
    (h : i.actsForPrincipalId = some a) :
    (fromApiKey i).ownerPrincipalId = a ∧ (fromApiKey i).principalId = i.principalId ∧
      (fromApiKey i).me.principalId = i.principalId := by
  simp [fromApiKey, ownerOf, h, Actor.me]

example : (fromApiKey ⟨"p-key", "k", "w", .admin, "aw dev local runtime x", some "p-admin"⟩).ownerPrincipalId =
    "p-admin" :=
  (local_key_owns_through_the_principal_it_acts_for _ _ rfl).1

/-- A session's principal (a membership re-read from the directory) owns what it writes, whatever
acts-for value the record carries. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")
  (ts := "apps/web/server/rbac/principal.ts#fromDirectoryRecord")]
theorem membership_owns_what_it_writes (r : DirectoryRecord) (h : r.kind = .membership) :
    (fromDirectoryRecord r).ownerPrincipalId = r.principalId := by
  simp [fromDirectoryRecord, h]

example : (fromDirectoryRecord ⟨"p", .membership, "w", .owner, "Ada", some "u", none,
    some "p9"⟩).ownerPrincipalId = "p" :=
  membership_owns_what_it_writes _ rfl

/-- A browser token owns as its minter owns and acts as its minter acts: both identifiers are the
minter's. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")
  (ts := "apps/web/server/rbac/principal.ts#fromBrowserToken")]
theorem browser_token_owns_and_acts_as_its_minter (m : Actor) (s : Scope) :
    (fromBrowserToken m s).ownerPrincipalId = m.ownerPrincipalId ∧
      (fromBrowserToken m s).principalId = m.principalId := ⟨rfl, rfl⟩

end AgentWorkspace.Theorems.Normative.ConceptIdentity
