import AgentWorkspace.Er.Current.Identity
import Vectors.Common

/-!
Vectors for the identity cluster (`concept-identity`): the closed enumerations, the 31 refined
checks with their SQL and boundary rows, every foreign key of the cluster with its
multiplicities, the authenticated-principal constructors, hand-built principals and `GET /api/me`,
the invitation state function, the browser-token TTL bound, the bearer grammars and the API-key
display prefix.
-/

namespace Vectors.ConceptIdentity

open Lean AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Identity
  AgentWorkspace.Concepts.Workspace AgentWorkspace.Concepts.Membership
  AgentWorkspace.Concepts.BrowserToken AgentWorkspace.Concepts.Principal
  AgentWorkspace.Concepts.Invitation

private def wf (n : String) : String := s!"AgentWorkspace.Theorems.WellFormed.ConceptIdentity.{n}"
private def nm (n : String) : String := s!"AgentWorkspace.Theorems.Normative.ConceptIdentity.{n}"
private def iv (n : String) : String := s!"AgentWorkspace.Theorems.Invariants.ConceptIdentity.{n}"
private def rf (n : String) : String := s!"AgentWorkspace.Theorems.Refinement.ConceptIdentity.{n}"
private def mt (n : String) : String := s!"AgentWorkspace.Theorems.Meta.ConceptIdentity.{n}"

private def strs (xs : List String) : Json := Json.arr (xs.map Json.str).toArray

private def opt (o : Option String) : Json := match o with
  | some s => Json.str s
  | none => Json.null

/-! ## Enumerations -/

/-- Strings no enumeration of the cluster admits. -/
def invalidSpellings : List String :=
  ["", "Owner", "OWNER", " owner", "owner ", "member", "api-key", "api_key", "apiKey", "Run",
    "runs", "project", "viewer\u0000"]

def enumVectors : List Vector :=
  let members : List Vector := [
    { id := "enum/role", input := Json.mkObj [("enum", "role")],
      expected := Json.mkObj [("members", strs (WireEnum.wires Role))],
      witnesses := [wf "role_wires_match_contract", wf "role_checks_hold_the_four_roles"] },
    { id := "enum/principal-kind/wire", input := Json.mkObj [("enum", "principal-kind-wire")],
      expected := Json.mkObj [("members", strs (WireEnum.wires Kind))],
      witnesses := [wf "principal_kind_wires_match_contract"] },
    { id := "enum/principal-kind/storage", input := Json.mkObj [("enum", "principal-kind-storage")],
      expected := Json.mkObj [("members", strs storageSpellings)],
      witnesses := [wf "principal_kind_storage_matches_schema"] },
    { id := "enum/scope-kind", input := Json.mkObj [("enum", "scope-kind")],
      expected := Json.mkObj [("members", strs (WireEnum.wires ScopeKind))],
      witnesses := [wf "scope_kind_wires_match_contract_and_schema"] },
    { id := "enum/via", input := Json.mkObj [("enum", "via")],
      expected := Json.mkObj [("members", strs (WireEnum.wires Via))],
      witnesses := [wf "via_wires_match_server"] },
    { id := "enum/invitation-state", input := Json.mkObj [("enum", "invitation-state")],
      expected := Json.mkObj [("members", strs (WireEnum.wires InvitationState))],
      witnesses := [wf "invitation_state_wires"] }]
  let parse := (WireEnum.wires Role ++ invalidSpellings).map fun s =>
    ({ id := s!"parse-role/{(Json.str s).compress}", input := Json.mkObj [("value", s)],
       expected := Json.mkObj [("role", opt ((parseRole s).map WireEnum.toWire))],
       witnesses := [wf "parse_role_refuses_unknown_spelling", wf "role_json_round_trips"] } : Vector)
  let wireKind := ["membership", "api_key", "api-key", ""].map fun s =>
    ({ id := s!"wire-kind/{(Json.str s).compress}", input := Json.mkObj [("storage", s)],
       expected := Json.mkObj [("wire", opt (wireKindOfStorage? s))],
       witnesses := [wf "wire_kind_maps_storage_to_wire"] } : Vector)
  members ++ parse ++ wireKind

/-! ## Checks -/

def rowJson (r : Row) : Json := Json.mkObj (r.cells.map fun (c, v) => (c, Json.str v))

/-- The column and pattern of a regular-expression check, if it is one. -/
def patternOf : CheckExpr → Option (String × String)
  | .matches c .slug => some (c, "slug")
  | .matches c .email => some (c, "email")
  | _ => none

def checkVectors : List Vector :=
  checks.map fun (t, n, e) =>
    let (acc, rej) := match samples.find? (·.1 == n) with
      | some (_, a, r) => (a, r)
      | none => ([], [])
    let pat := patternOf e
    { id := s!"check/{n}",
      input := Json.mkObj [("table", TableName.toWire t), ("check", n)],
      expected := Json.mkObj [
        ("sql", e.render (TableName.toWire t)),
        ("pattern", match pat with | some (_, p) => Json.str p | none => Json.null),
        ("column", match pat with | some (c, _) => Json.str c | none => Json.null),
        ("accepted", Json.arr (acc.map rowJson).toArray),
        ("refused", Json.arr (rej.map rowJson).toArray)],
      witnesses := [wf s!"{n}_renders_as_snapshot", wf s!"{n}_separates_its_samples",
        wf "refined_checks_cover_the_cluster"] }

/-! ## Relationships -/

def relationshipVectors : List Vector :=
  relationships.map fun rel =>
    let fk := rel.fk
    let cls := classify catalogue rel.table fk
    let tenancy := cls == .rootReference || cls == .tenantPaired || cls == .siblingPaired
    let w := [iv s!"{fk.name}_parent_is_unique"] ++
      (if tenancy then [iv s!"{fk.name}_keeps_one_workspace"] else []) ++
      (if parentMultiplicity rel.table fk == .exactlyOne then [iv s!"{fk.name}_is_required"]
        else []) ++
      (if childMultiplicity rel.table fk == .atMostOne then [iv s!"{fk.name}_child_is_unique"]
        else [])
    { id := s!"relationship/{fk.name}",
      input := Json.mkObj [("table", TableName.toWire rel.table), ("foreignKey", fk.name)],
      expected := Json.mkObj [
        ("columns", strs fk.columns), ("refTable", TableName.toWire fk.refTable),
        ("refColumns", strs fk.refColumns), ("onDelete", WireEnum.toWire fk.onDelete),
        ("class", WireEnum.toWire cls),
        ("parent", WireEnum.toWire (parentMultiplicity rel.table fk)),
        ("child", WireEnum.toWire (childMultiplicity rel.table fk))],
      witnesses := w }

def uniqueVectors : List Vector :=
  tables.flatMap fun t => ((catalogue t).uniques.filter (·.partialNullColumns.isEmpty)).map fun u =>
    { id := s!"unique/{u.name}",
      input := Json.mkObj [("table", TableName.toWire t), ("unique", u.name)],
      expected := Json.mkObj [("columns", strs u.columns)],
      witnesses := [iv s!"{u.name}_identifies_a_row"] }

/-! ## Authenticated principals -/

def scopeJson (s : Scope) : Json :=
  Json.mkObj [("kind", WireEnum.toWire s.kind), ("id", s.id)]

def actorJson (a : Actor) : Json :=
  Json.mkObj [("principalId", a.principalId), ("kind", a.kind.toStorage),
    ("workspaceId", a.workspaceId), ("label", a.label), ("userId", opt a.userId),
    ("actor", a.actor), ("role", WireEnum.toWire a.role), ("via", WireEnum.toWire a.via),
    ("apiKeyId", opt a.apiKeyId),
    ("scope", match a.scope with | some s => scopeJson s | none => Json.null),
    ("ownerPrincipalId", a.ownerPrincipalId),
    ("wellFormed", a.wellFormed)]

def meJson (m : MeResponse) : Json :=
  Json.mkObj [("principalId", m.principalId), ("kind", WireEnum.toWire m.kind),
    ("role", WireEnum.toWire m.role), ("workspaceId", m.workspaceId), ("userId", opt m.userId),
    ("label", m.label)]

def recordJson (r : DirectoryRecord) : Json :=
  Json.mkObj [("principalId", r.principalId), ("kind", r.kind.toStorage),
    ("workspaceId", r.workspaceId), ("role", WireEnum.toWire r.role), ("label", r.label),
    ("userId", opt r.userId), ("apiKeyId", opt r.apiKeyId),
    ("actsForPrincipalId", opt r.actsForPrincipalId)]

/-- Every kind × role × user-id presence × key-id presence × acts-for presence. -/
def records : List DirectoryRecord :=
  (WireEnum.all : List Kind).flatMap fun k => (WireEnum.all : List Role).flatMap fun role =>
    [some "u1", none].flatMap fun u => [some "k1", none].flatMap fun key =>
      [none, some "p9"].map fun actsFor => ⟨"p1", k, "w1", role, "Ada", u, key, actsFor⟩

def scopes : List Scope :=
  [.run ⟨"0b6f9a52-6f7e-4d3c-9f0a-7d1c2b3a4e5f"⟩, .session ⟨"9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f"⟩]

def principalVectors : List Vector :=
  let fromRecord := records.map fun r =>
    let a := fromDirectoryRecord r
    ({ id := s!"from-directory-record/{r.kind.toStorage}/{WireEnum.toWire r.role}/user={r.userId.isSome}/key={r.apiKeyId.isSome}/acts-for={r.actsForPrincipalId.isSome}",
       input := Json.mkObj [("constructor", "fromDirectoryRecord"), ("record", recordJson r)],
       expected := Json.mkObj [("principal", actorJson a), ("coherent", r.coherent),
         ("me", if a.wellFormed then meJson a.me else Json.null)],
       witnesses := [wf "from_directory_record_well_formed_iff_coherent",
         mt "from_directory_record_accepts_an_incoherent_record",
         iv "owner_is_the_actor_or_the_principal_it_acts_for"] ++
         (if r.kind == .membership then [nm "membership_owns_what_it_writes"] else []) } : Vector)
  let fromKey := (WireEnum.all : List Role).flatMap fun role =>
    [none, some "p9"].map fun actsFor =>
    let i : ApiKeyIdentity := ⟨"p2", "k1", "w1", role, "CI", actsFor⟩
    let a := fromApiKey i
    ({ id := s!"from-api-key/{WireEnum.toWire role}/acts-for={actsFor.isSome}",
       input := Json.mkObj [("constructor", "fromApiKey"),
         ("identity", Json.mkObj [("principalId", i.principalId), ("apiKeyId", i.apiKeyId),
           ("workspaceId", i.workspaceId), ("role", WireEnum.toWire i.role), ("label", i.label),
           ("actsForPrincipalId", opt i.actsForPrincipalId)])],
       expected := Json.mkObj [("principal", actorJson a), ("me", meJson a.me)],
       witnesses := [wf "from_api_key_is_well_formed", nm "api_key_has_no_user_and_no_membership",
         nm "me_user_id_is_null_exactly_for_an_api_key",
         if actsFor.isSome then nm "local_key_owns_through_the_principal_it_acts_for"
           else nm "hosted_api_key_owns_what_it_writes",
         iv "owner_is_the_actor_or_the_principal_it_acts_for"] } :
      Vector)
  let fromToken := (records.filter (·.coherent)).flatMap fun r => scopes.map fun s =>
    let a := fromBrowserToken (fromDirectoryRecord r) s
    ({ id := s!"from-browser-token/{r.kind.toStorage}/{WireEnum.toWire r.role}/{WireEnum.toWire s.kind}/acts-for={r.actsForPrincipalId.isSome}",
       input := Json.mkObj [("constructor", "fromBrowserToken"), ("record", recordJson r),
         ("scope", scopeJson s)],
       expected := Json.mkObj [("principal", actorJson a), ("me", meJson a.me)],
       witnesses := [wf "from_browser_token_is_well_formed",
         nm "browser_token_is_attenuation_not_a_fourth_identity",
         nm "browser_token_owns_and_acts_as_its_minter"] } : Vector)
  fromRecord ++ fromKey ++ fromToken

/-- Hand-built authenticated principals, outside the constructors: every kind × verifier × scope
(none, a run, a session) × user-id presence × key-id presence × owner (its own principal or
another). `isPrincipal` must give each the model's `wellFormed` verdict — in particular it refuses
a browser-token actor with no scope, a session or API-key actor with one, and a membership actor
whose owner is not itself. -/
def actorVectors : List Vector :=
  let scopeChoices : List (Option Scope) := none :: scopes.map some
  (WireEnum.all : List Kind).flatMap fun k => (WireEnum.all : List Via).flatMap fun via =>
    scopeChoices.flatMap fun sc => [some "u1", none].flatMap fun u => [some "k1", none].flatMap
      fun key => [("self", "p1"), ("other", "p9")].map fun (ownerName, owner) =>
      let a : Actor := ⟨"p1", k, "w1", "Ada", u, "Ada", .builder, via, key, sc, owner⟩
      let scopeName := match sc with | some s => WireEnum.toWire s.kind | none => "none"
      let coherent := a.scope.isSome == (a.via == .browserToken)
      { id := s!"actor/{k.toStorage}/{WireEnum.toWire via}/scope={scopeName}/user={u.isSome}/key={key.isSome}/owner={ownerName}",
        input := Json.mkObj [("constructor", "new"), ("principal", actorJson a)],
        expected := Json.mkObj [("wellFormed", a.wellFormed)],
        witnesses := (if coherent then [wf "well_formed_actor_has_a_scope_iff_via_browser_token"]
          else [wf "actor_with_a_scope_its_verifier_does_not_carry_is_refused",
            wf "well_formed_actor_has_a_scope_iff_via_browser_token"]) ++
          (if owner == a.principalId then []
            else [iv "owner_differs_from_the_actor_only_for_an_api_key"]) }

/-- `GET /api/me` bodies: every kind × user-id presence, and empty strings. -/
def meVectors : List Vector :=
  let bodies : List MeResponse :=
    (WireEnum.all : List Kind).flatMap (fun k => [some "u1", none].map fun u =>
      ⟨"p1", k, .viewer, "w1", u, "Ada"⟩) ++
    [⟨"", .membership, .owner, "w1", some "u1", "Ada"⟩, ⟨"p1", .apiKey, .owner, "w1", some "", "CI"⟩,
     ⟨"p1", .apiKey, .owner, "", none, "CI"⟩, ⟨"p1", .membership, .admin, "w1", some "u1", ""⟩]
  bodies.map fun m =>
    { id := s!"me/{(meJson m).compress}", input := meJson m,
      expected := Json.mkObj [("acceptedCurrent", m.acceptedCurrent),
        ("acceptedTarget", m.acceptedTarget)],
      witnesses := [rf "me_schema_target_refines_current",
        rf "me_rules_agree_on_well_formed_principals"] }

/-! ## Invitation states -/

def invitationVectors : List Vector :=
  let exp : Nat := 1800000000000
  let created : Nat := 1790000000000
  [none, some (created + 1000)].flatMap fun rev => [none, some (created + 2000)].flatMap fun acc =>
    ([exp - 1, exp, exp + 1] : List Nat).map fun (now : Nat) =>
      let i : Invitation := ⟨⟨"v1"⟩, ⟨"w1"⟩, "carol@example.com", .viewer, some ⟨"u1"⟩, "h",
        exp, acc, rev, created, created⟩
      { id := s!"invitation-state/revoked={rev.isSome}/accepted={acc.isSome}/now={now}",
        input := Json.mkObj [("expiresAt", exp), ("acceptedAt", (acc.map toJson).getD Json.null),
          ("revokedAt", (rev.map toJson).getD Json.null), ("createdAt", created), ("now", toJson now)],
        expected := Json.mkObj [("state", WireEnum.toWire (i.stateAt now)),
          ("unresolved", i.unresolved)],
        witnesses := [nm "invitation_state_precedence", iv "invitation_resolution_is_stable",
          nm "expired_invitation_still_blocks_a_duplicate"] }

/-! ## Browser-token TTL -/

def ttlVectors : List Vector :=
  ([0, 1, 59, 60, 61, 300, 3599, 3600, 3601, 86400] : List Nat).map fun (ttl : Nat) =>
    { id := s!"ttl/{ttl}", input := Json.mkObj [("ttlSeconds", toJson ttl)],
      expected := Json.mkObj [("accepted", ttlAccepted ttl)],
      witnesses := [nm "token_ttl_is_bounded"] }

/-! ## Bearer shapes -/

/-- The bearer samples of one grammar: the exact shape, each half one short and one long, the
other credential's prefix, a non-base64url character in each half, `_` inside the halves (legal),
a wrong separator, surrounding space, the display prefix alone and the empty string. -/
def bearerSamples (pfx other : String) (idLen secLen : Nat) : List (String × String) :=
  let a (n : Nat) := String.ofList (List.replicate n 'A')
  let b (n : Nat) := String.ofList (List.replicate n 'b')
  [("exact", pfx ++ a idLen ++ "_" ++ b secLen),
   ("id-short", pfx ++ a (idLen - 1) ++ "_" ++ b secLen),
   ("id-long", pfx ++ a (idLen + 1) ++ "_" ++ b secLen),
   ("secret-short", pfx ++ a idLen ++ "_" ++ b (secLen - 1)),
   ("secret-long", pfx ++ a idLen ++ "_" ++ b (secLen + 1)),
   ("other-prefix", other ++ a idLen ++ "_" ++ b secLen),
   ("id-bad-char", pfx ++ a (idLen - 1) ++ "." ++ "_" ++ b secLen),
   ("secret-bad-char", pfx ++ a idLen ++ "_" ++ b (secLen - 1) ++ "+"),
   ("underscores-inside", pfx ++ String.ofList (List.replicate idLen '_') ++ "_" ++
      String.ofList (List.replicate secLen '-')),
   ("wrong-separator", pfx ++ a idLen ++ "." ++ b secLen),
   ("trailing-space", pfx ++ a idLen ++ "_" ++ b secLen ++ " "),
   ("display-prefix-only", pfx ++ a idLen),
   ("empty", "")]

def bearerVectors : List Vector :=
  let key := Concepts.ApiKey.prefix_
  let tok := Concepts.BrowserToken.prefix_
  let one (cred : String) (shaped : String → Bool) (pfx other : String) (idLen secLen : Nat) :
      List Vector :=
    (bearerSamples pfx other idLen secLen).map fun (name, s) =>
      { id := s!"bearer/{cred}/{name}", input := Json.mkObj [("credential", cred), ("bearer", s)],
        expected := Json.mkObj [("shaped", shaped s),
          ("otherShaped", if cred == "api-key" then Concepts.BrowserToken.presentedShaped s
            else Concepts.ApiKey.presentedShaped s)],
        witnesses := [nm "presented_bearers_follow_the_credential_table",
          iv "no_bearer_is_both_an_api_key_and_a_browser_token"] }
  one "api-key" Concepts.ApiKey.presentedShaped key tok Concepts.ApiKey.idLength
      Concepts.ApiKey.secretLength ++
    one "browser-token" Concepts.BrowserToken.presentedShaped tok key
      Concepts.BrowserToken.idLength Concepts.BrowserToken.secretLength

/-- Display-prefix samples: the exact `ak_live_<22>` head, a half one short and one long, a
non-base64url character, the browser-token prefix, a whole presented key, and the empty string. -/
def displayVectors : List Vector :=
  let a (n : Nat) := String.ofList (List.replicate n 'A')
  let key := Concepts.ApiKey.prefix_
  let tok := Concepts.BrowserToken.prefix_
  let samples : List (String × String) :=
    [("exact", key ++ a 22), ("underscores", key ++ String.ofList (List.replicate 22 '_')),
     ("id-short", key ++ a 21), ("id-long", key ++ a 23), ("bad-char", key ++ a 21 ++ "."),
     ("browser-token-prefix", tok ++ a 22), ("whole-key", key ++ a 22 ++ "_" ++ a 43),
     ("trailing-space", key ++ a 22 ++ " "), ("empty", "")]
  samples.map fun (name, s) =>
    let display := Concepts.ApiKey.displayPrefixShaped s
    { id := s!"display-prefix/{name}", input := Json.mkObj [("value", s)],
      expected := Json.mkObj [("displayShaped", display),
        ("keyShaped", Concepts.ApiKey.presentedShaped s),
        ("tokenShaped", Concepts.BrowserToken.presentedShaped s)],
      witnesses := [nm "display_prefix_cannot_authenticate"] }

/-! ## Constants the findings pin -/

def constantVectors : List Vector :=
  [{ id := "tables", input := Json.mkObj [("cluster", "identity")],
     expected := Json.mkObj [("tables", strs (tables.map TableName.toWire))],
     witnesses := [wf "refined_checks_cover_the_cluster"] },
   { id := "constant/workspace-slug-max-length", input := Json.mkObj [("constant", "WORKSPACE_SLUG_MAX_LENGTH")],
     expected := Json.mkObj [("value", slugMaxLengthContract),
       ("longestAdmittedSlug", 63)],
     witnesses := [mt "slug_bound_is_off_by_one",
       mt "admitted_slugs_are_shorter_than_the_contract_bound"] },
   { id := "constant/api-key-prefix", input := Json.mkObj [("constant", "API_KEY_PREFIX")],
     expected := Json.mkObj [("value", Concepts.ApiKey.prefix_)],
     witnesses := [nm "presented_bearers_follow_the_credential_table"] },
   { id := "constant/api-key-id-length", input := Json.mkObj [("constant", "API_KEY_ID_LENGTH")],
     expected := Json.mkObj [("value", Concepts.ApiKey.idLength)],
     witnesses := [nm "presented_bearers_follow_the_credential_table"] },
   { id := "constant/api-key-secret-length",
     input := Json.mkObj [("constant", "API_KEY_SECRET_LENGTH")],
     expected := Json.mkObj [("value", Concepts.ApiKey.secretLength)],
     witnesses := [nm "presented_bearers_follow_the_credential_table"] },
   { id := "constant/api-key-name-max-length",
     input := Json.mkObj [("constant", "API_KEY_NAME_MAX_LENGTH")],
     expected := Json.mkObj [("value", Concepts.ApiKey.nameMaxLength)],
     witnesses := [wf "identity_bounds_mirror_the_contracts"] },
   { id := "constant/browser-token-prefix", input := Json.mkObj [("constant", "BROWSER_TOKEN_PREFIX")],
     expected := Json.mkObj [("value", Concepts.BrowserToken.prefix_)],
     witnesses := [nm "presented_bearers_follow_the_credential_table"] },
   { id := "constant/browser-token-id-length",
     input := Json.mkObj [("constant", "BROWSER_TOKEN_ID_LENGTH")],
     expected := Json.mkObj [("value", Concepts.BrowserToken.idLength)],
     witnesses := [nm "presented_bearers_follow_the_credential_table",
       nm "browser_token_grammar_is_the_api_key_grammar"] },
   { id := "constant/browser-token-secret-length",
     input := Json.mkObj [("constant", "BROWSER_TOKEN_SECRET_LENGTH")],
     expected := Json.mkObj [("value", Concepts.BrowserToken.secretLength)],
     witnesses := [nm "presented_bearers_follow_the_credential_table",
       nm "browser_token_grammar_is_the_api_key_grammar"] },
   { id := "constant/invitation-token-max-length",
     input := Json.mkObj [("constant", "INVITATION_TOKEN_MAX_LENGTH")],
     expected := Json.mkObj [("value", Concepts.Invitation.tokenMaxLength)],
     witnesses := [wf "identity_bounds_mirror_the_contracts"] },
   { id := "constant/user-email-max-length",
     input := Json.mkObj [("constant", "USER_EMAIL_MAX_LENGTH")],
     expected := Json.mkObj [("value", Concepts.User.emailMaxLength)],
     witnesses := [wf "identity_bounds_mirror_the_contracts"] },
   { id := "constant/user-name-max-length", input := Json.mkObj [("constant", "USER_NAME_MAX_LENGTH")],
     expected := Json.mkObj [("value", Concepts.User.nameMaxLength)],
     witnesses := [wf "identity_bounds_mirror_the_contracts"] },
   { id := "constant/workspace-name-max-length",
     input := Json.mkObj [("constant", "WORKSPACE_NAME_MAX_LENGTH")],
     expected := Json.mkObj [("value", nameMaxLengthContract)],
     witnesses := [wf "identity_bounds_mirror_the_contracts"] },
   { id := "constant/browser-token-default-ttl",
     input := Json.mkObj [("constant", "BROWSER_TOKEN_DEFAULT_TTL_SECONDS")],
     expected := Json.mkObj [("value", defaultTtlSeconds)], witnesses := [nm "token_ttl_is_bounded"] },
   { id := "resource-fields/api-key", input := Json.mkObj [("resource", "ApiKeyResource")],
     expected := Json.mkObj [("fields", strs Concepts.ApiKey.resourceFields),
       ("credentials", strs Concepts.ApiKey.credentialFields)],
     witnesses := [nm "credentials_never_appear_in_resources"] },
   { id := "resource-fields/invitation", input := Json.mkObj [("resource", "InvitationResource")],
     expected := Json.mkObj [("fields", strs Concepts.Invitation.resourceFields),
       ("credentials", strs Concepts.Invitation.credentialFields)],
     witnesses := [nm "credentials_never_appear_in_resources"] }]

def files : List (String × Json) :=
  [("enums.json", file "concept-identity"
      "The identity enumerations, parseRole and wireKind" enumVectors),
   ("checks.json", file "concept-identity"
      "The 31 refined checks of the identity tables: SQL and boundary rows" checkVectors),
   ("relationships.json", file "concept-identity"
      "Every foreign key of the identity tables, with its tenancy class and multiplicities"
      relationshipVectors),
   ("uniques.json", file "concept-identity"
      "Every total unique key of the identity tables" uniqueVectors),
   ("principals.json", file "concept-identity"
      "The Principal constructors (directory record, API key, browser token) and GET /api/me"
      principalVectors),
   ("actors.json", file "concept-identity"
      "Hand-built authenticated principals: isPrincipal against Actor.wellFormed" actorVectors),
   ("display-prefixes.json", file "concept-identity"
      "The ak_live_<key id> display prefix: shaped, and never a presented key or token"
      displayVectors),
   ("me.json", file "concept-identity"
      "GET /api/me bodies: today's schema and the documented rule" meVectors),
   ("invitation-states.json", file "concept-identity"
      "invitationStateOf: every resolution × three instants around the expiry" invitationVectors),
   ("token-ttl.json", file "concept-identity" "The browser-token TTL bound" ttlVectors),
   ("bearers.json", file "concept-identity"
      "The ak_live_ and awt_live_ bearer grammars: exact shapes and every near miss" bearerVectors),
   ("constants.json", file "concept-identity"
      "Bounds and resource field lists the theorems pin" constantVectors)]

end Vectors.ConceptIdentity
