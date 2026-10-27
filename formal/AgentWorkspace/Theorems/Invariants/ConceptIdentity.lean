import ErSnapshot
import AgentWorkspace.Er.Current.Identity
import AgentWorkspace.Theorems.Invariants.ErCore

/-!
T2 — what holds in every state the identity tables can be in.

"Every state" is every `Er.Core.consistent catalogue` state (the constraints PostgreSQL enforces),
or every `Er.Current.Identity.consistent` state where a theorem needs the refined checks. As in the
`er-core` unit, these are the invariants each operation of the cluster must preserve; the
operations themselves are Phase 3 and 4.

* **Tenancy, per foreign key.** `aw_identity_relationship_theorems` instantiates `er-core`'s
  generic isolation lemma for every foreign key of the cluster that carries a workspace:
  `<fk>_keeps_one_workspace`.
* **Cardinality, per foreign key.** For every foreign key, `<fk>_parent_is_unique` (a referencing
  row has exactly one parent) and, where every key column is `NOT NULL`, `<fk>_is_required` (every
  row references one); where the child's key columns are a key of the child,
  `<fk>_child_is_unique` (a parent has at most one such child).
* **Uniqueness, per unique key.** `<key>_identifies_a_row` for every total unique key of the
  eight tables (a hash, an email, a slug, an OIDC pair, a membership per user and workspace, …).
* **The concepts' shapes.** A principal row always decodes to one source, a browser-token row to
  one scope; a membership links exactly one user and one workspace; a principal has exactly one
  source row; a browser token exactly one minter.
* **Time.** Once an API key or a browser token stops being live, or stops being admitted, it never
  becomes so again at a later instant, and a resolved invitation keeps its state.
* **Coverage (RF-101's target).** In a consistent state that meets the coverage target, every
  membership and every API key has exactly one principal row, in its own workspace.

**Witness.** `Witness.state` is a consistent state with two workspaces, one user in both (with
different roles), a second user, an OIDC binding, three membership principals, an API key and its
principal (acting for a membership principal), an invitation, a model connection, an agent, a session, a run and two browser tokens
(one per scope kind), an endpoint client with its agent, its bound key and an OAuth access token
it holds for a member, and a passing Test Runtime of the first workspace's `docker` driver. It
references through every foreign key of the cluster.
-/

namespace AgentWorkspace.Theorems.Invariants.ConceptIdentity

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Identity
  AgentWorkspace.Concepts.Workspace AgentWorkspace.Concepts.ApiKey
  AgentWorkspace.Concepts.BrowserToken AgentWorkspace.Concepts.Principal
  AgentWorkspace.Concepts.Invitation
open AgentWorkspace.Theorems.Invariants.ErCore (reference_preserves_tenant
  principal_has_exactly_one_source)
open AgentWorkspace.Er.Current.Identity.Lemmas

/-! ## The witness state -/

namespace Witness

private def ts : List (String × String) := [("created_at", "1000"), ("updated_at", "1000")]

/-- Two workspaces; Ada is Owner of the first and Viewer of the second, Bob is Builder of the
first; an OIDC binding for Ada; the three membership principals; an API key of the first workspace
and its principal, which acts for Ada's; an invitation Ada sent; a model connection that is the first workspace's
default; an agent, a session and a run; a run-scoped token minted by the key and a session-scoped
token minted by Ada, already revoked; an A2A endpoint client acting for Ada, naming the agent,
with the API key bound to it and an OAuth access token it holds for Ada; and the first workspace's
passing Test Runtime of `docker`. -/
def state : State
  | .workspaces =>
    [⟨[("id", "w1"), ("slug", "acme"), ("name", "Acme"), ("public_sharing_enabled", "true"),
       ("default_model_connection_id", "c1"), ("default_model", "claude")] ++ ts⟩,
     ⟨[("id", "w2"), ("slug", "globex"), ("name", "Globex"), ("public_sharing_enabled", "false")] ++
       ts⟩]
  | .users =>
    [⟨[("id", "u1"), ("email", "ada@example.com"), ("name", "Ada")] ++ ts⟩,
     ⟨[("id", "u2"), ("email", "bob@example.com"), ("name", "Bob")] ++ ts⟩]
  | .userIdentities =>
    [⟨[("id", "i1"), ("issuer", "https://id.example.com"), ("subject", "sub-ada"),
       ("user_id", "u1")] ++ ts⟩]
  | .memberships =>
    [⟨[("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner")] ++ ts⟩,
     ⟨[("id", "m2"), ("workspace_id", "w2"), ("user_id", "u1"), ("role", "viewer")] ++ ts⟩,
     ⟨[("id", "m3"), ("workspace_id", "w1"), ("user_id", "u2"), ("role", "builder")] ++ ts⟩]
  | .workspacePrincipals =>
    [⟨[("id", "p1"), ("workspace_id", "w1"), ("kind", "membership"), ("membership_id", "m1"),
       ("activated_at", "1000"), ("created_at", "1000")]⟩,
     ⟨[("id", "p2"), ("workspace_id", "w1"), ("kind", "api_key"), ("api_key_id", "k1"),
       ("activated_at", "1000"), ("acts_for_principal_id", "p1"), ("created_at", "1000")]⟩,
     ⟨[("id", "p3"), ("workspace_id", "w2"), ("kind", "membership"), ("membership_id", "m2"),
       ("activated_at", "1000"), ("created_at", "1000")]⟩,
     ⟨[("id", "p4"), ("workspace_id", "w1"), ("kind", "membership"), ("membership_id", "m3"),
       ("activated_at", "1000"), ("created_at", "1000")]⟩]
  | .apiKeys =>
    [⟨[("id", "k1"), ("workspace_id", "w1"), ("name", "CI"), ("role", "builder"),
       ("key_prefix", "ak_live_AAAAAAAAAAAAAAAAAAAAAA"), ("key_hash", "h-k1"),
       ("expires_at", "9000")] ++ ts⟩]
  | .invitations =>
    [⟨[("id", "v1"), ("workspace_id", "w1"), ("email", "carol@example.com"), ("role", "viewer"),
       ("invited_by", "u1"), ("token_hash", "h-v1"), ("expires_at", "5000")] ++ ts⟩]
  | .modelConnections =>
    [⟨[("id", "c1"), ("workspace_id", "w1"), ("name", "default"), ("provider", "anthropic"),
       ("config", "{}")] ++ ts⟩]
  | .agents =>
    [⟨[("id", "a1"), ("workspace_id", "w1"), ("name", "General"), ("instructions", "Help."),
       ("permissions", "{}"), ("owner_principal_id", "p1")] ++ ts⟩]
  | .sessions =>
    [⟨[("id", "s1"), ("workspace_id", "w1"), ("user_id", "u1"), ("owner_principal_id", "p1"),
       ("agent_id", "a1"), ("status", "active")] ++ ts⟩]
  | .runs =>
    [⟨[("id", "r1"), ("workspace_id", "w1"), ("session_id", "s1"), ("status", "queued"),
       ("input_tokens", "0"), ("output_tokens", "0"), ("cache_read_input_tokens", "0"),
       ("cache_creation_input_tokens", "0"), ("cost_usd", "0"), ("cost_currency", "USD"),
       ("tool_calls", "0"), ("accounting_state", "pending"), ("tool_connector_ids", "{}"), ("file_grants", "{}"), ("approved_tool_calls", "[]"), ("consumed_tool_calls", "[]")] ++ ts⟩]
  | .browserTokens =>
    [⟨[("id", "t1"), ("workspace_id", "w1"), ("minted_by_principal_id", "p2"),
       ("scope_kind", "run"), ("run_id", "r1"), ("token_hash", "h-t1"), ("expires_at", "1300"),
       ("created_at", "1000")]⟩,
     ⟨[("id", "t2"), ("workspace_id", "w1"), ("minted_by_principal_id", "p1"),
       ("scope_kind", "session"), ("session_id", "s1"), ("token_hash", "h-t2"),
       ("expires_at", "1300"), ("revoked_at", "1100"), ("created_at", "1000")]⟩]
  | .cliSessions =>
    [⟨[("id", "cs1"), ("workspace_id", "w1"), ("user_id", "u2"), ("user_code", "ABCDEFGH"),
       ("status", "active"), ("approval_expires_at", "1100"), ("token_hash", "h-cs1"),
       ("expires_at", "1300"), ("created_at", "1000")]⟩,
     ⟨[("id", "cs2"), ("workspace_id", "w2"), ("user_id", "u1"), ("user_code", "HGFEDCBA"),
       ("status", "revoked"), ("approval_expires_at", "1100"), ("token_hash", "h-cs2"),
       ("expires_at", "1300"), ("revoked_at", "1200"), ("created_at", "1000")]⟩]
  | .endpointClients =>
    [⟨[("id", "ec1"), ("workspace_id", "w1"), ("name", "General"), ("kind", "a2a-agent"),
       ("acts_for_principal_id", "p1"), ("created_by_principal_id", "p1"),
       ("redirect_uris", "{}")] ++ ts⟩]
  | .endpointClientAgents =>
    [⟨[("client_id", "ec1"), ("workspace_id", "w1"), ("agent_id", "a1")]⟩]
  | .endpointClientApiKeys =>
    [⟨[("api_key_id", "k1"), ("client_id", "ec1"), ("workspace_id", "w1")]⟩]
  | .oauthTokens =>
    [⟨[("id", "ot1"), ("workspace_id", "w1"), ("client_id", "ec1"), ("kind", "access"),
       ("token_hash", "h-ot1"), ("subject_principal_id", "p1"),
       ("resource", "https://aw.example/api/a2a/agents/general"), ("family_id", "f1"),
       ("expires_at", "1300"), ("created_at", "1000")]⟩]
  | .runtimeVerifications =>
    [⟨[("id", "rv1"), ("workspace_id", "w1"), ("driver_id", "docker"),
       ("configuration_key", "cfg1"), ("fingerprint", "fp1"), ("verified_at", "1000"),
       ("expires_at", "2000")]⟩]
  | _ => []

private theorem core_consistent : Er.Core.consistent catalogue state = true := by decide +kernel

private theorem consistent : Er.Current.Identity.consistent state = true := by decide +kernel

private theorem covers_target : everySourceHasPrincipal state = true := by decide +kernel

private theorem references_every_relationship :
    relationships.all (fun rel => (findRef state rel.table rel.fk).isSome) = true := by
  decide +kernel

end Witness

private theorem references_of_findRef {st : State} {t : TableName} {fk : ForeignKey}
    (hfk : fk ∈ (catalogue t).foreignKeys) {r r' : Row} (h : findRef st t fk = some (r, r')) :
    References catalogue st t fk r r' := by
  unfold findRef at h
  obtain ⟨a, ha, hf⟩ := List.exists_of_findSome?_eq_some h
  split at hf
  · rename_i hp
    obtain ⟨b, hb, hab⟩ := Option.map_eq_some_iff.mp hf
    cases hab
    exact ⟨hfk, ha, List.mem_of_find?_eq_some hb, hp, by simpa using List.find?_some hb⟩
  · cases hf

private theorem mem_relationships {rel : Relationship} (h : rel ∈ relationships) :
    rel.fk ∈ (catalogue rel.table).foreignKeys := by
  simp only [relationships, List.mem_flatMap, List.mem_map] at h
  obtain ⟨t, _, fk, hfk, rfl⟩ := h
  exact hfk

/-- The witness state references through every foreign key of the cluster, so every hypothesis
of the per-key theorems below is satisfiable. -/
example : ∀ rel ∈ relationships, ∃ r r',
    References catalogue Witness.state rel.table rel.fk r r' := by
  intro rel hrel
  have := List.all_eq_true.mp Witness.references_every_relationship rel hrel
  obtain ⟨⟨r, r'⟩, hf⟩ := Option.isSome_iff_exists.mp this
  exact ⟨r, r', references_of_findRef (mem_relationships hrel) hf⟩

example : Er.Core.consistent catalogue Witness.state = true := Witness.core_consistent

/-! ## Per foreign key and per unique key -/

section Generator

open Lean Elab Command

private def mkDocComment (text : String) : TSyntax ``Lean.Parser.Command.docComment :=
  ⟨mkNode ``Lean.Parser.Command.docComment #[mkAtom "/--", mkAtom (text ++ " -/")]⟩

private def ctorName (sql : String) : Name :=
  match sql.splitOn "_" with
  | [] => .anonymous
  | w :: ws => Name.mkSimple (w ++ String.join (ws.map String.capitalize))

private def tableTerm (t : TableName) : Term := mkIdent (``TableName ++ ctorName (TableName.toWire t))

private def strsTerm (xs : List String) : CommandElabM Term :=
  `([$((xs.map fun x => (Syntax.mkStrLit x : Term)).toArray),*])

private def erDoc : String := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces"

private partial def findRoot (dir : System.FilePath) : IO (Option System.FilePath) := do
  if ← (dir / "packages" / "core" / "src" / "db" / "schema").pathExists then return some dir
  match dir.parent with
  | some p => if p == dir then return none else findRoot p
  | none => return none

private def colsText (cs : List String) : String := ", ".intercalate (cs.map fun c => s!"`{c}`")

/-- Elaborates the per-foreign-key and per-unique-key invariants of the identity tables. -/
elab "aw_identity_relationship_theorems" : command => do
  let file ← IO.FS.realPath (← getFileName)
  let fromFile ← findRoot (file.parent.getD ".")
  let fromCwd ← findRoot (← IO.currentDir)
  let some root := fromFile <|> fromCwd
    | throwError "aw_identity_relationship_theorems: repository root not found"
  for t in tables do
    let s := catalogue t
    let sql := TableName.toWire t
    let path := "packages/core/src/db/schema/" ++ s.source
    let source ← IO.FS.readFile (root / path)
    let cite (n : String) : StrLit :=
      Syntax.mkStrLit (path ++ "#" ++ (if (source.splitOn n).length > 1 then n else s.tsExport))
    let tT := tableTerm t
    for fk in s.foreignKeys do
      let n := fk.name
      let nL := Syntax.mkStrLit n
      let ref := TableName.toWire fk.refTable
      let cls := classify catalogue t fk
      if cls == .rootReference || cls == .tenantPaired || cls == .siblingPaired then
        let thm := mkIdent (Name.mkSimple s!"{n}_keeps_one_workspace")
        let doc := mkDocComment s!"In every consistent state, a `{sql}` row and the `{ref}` row it \
          references through `{n}` belong to the same workspace."
        elabCommand (← `(command|
          $doc:docComment
          @[aw_spec (tier := $(mkIdent `T2)) (doc := $(Syntax.mkStrLit erDoc)) (ts := $(cite n))
            (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
          theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : Er.Core.consistent catalogue st = true) {r r' : Row}
              (h : References catalogue st $tT (fkOf $tT $nL) r r') :
              tenantOf catalogue $tT r = tenantOf catalogue (fkOf $tT $nL).refTable r' :=
            reference_preserves_tenant catalogue st hc (by decide +kernel) (by decide +kernel) h))
      let thm := mkIdent (Name.mkSimple s!"{n}_parent_is_unique")
      let doc := mkDocComment s!"In every consistent state, a `{sql}` row whose \
        {colsText fk.columns} are set references exactly one `{ref}` row through `{n}`."
      elabCommand (← `(command|
        $doc:docComment
        @[aw_spec (tier := $(mkIdent `T2)) (doc := $(Syntax.mkStrLit erDoc)) (ts := $(cite n))]
        theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : Er.Core.consistent catalogue st = true) {r : Row}
            (hr : r ∈ st $tT) (hp : r.present (fkOf $tT $nL).columns = true) :
            ∃ r' ∈ st (fkOf $tT $nL).refTable,
              r'.project (fkOf $tT $nL).refColumns = r.project (fkOf $tT $nL).columns ∧
              ∀ r'' ∈ st (fkOf $tT $nL).refTable,
                r''.project (fkOf $tT $nL).refColumns = r.project (fkOf $tT $nL).columns →
                  r'' = r' :=
          exactly_one_parent hc (by decide +kernel) (by decide +kernel) hr hp))
      if parentMultiplicity t fk == .exactlyOne then
        let thm := mkIdent (Name.mkSimple s!"{n}_is_required")
        let doc := mkDocComment s!"In every consistent state, every `{sql}` row has \
          {colsText fk.columns} set, so it references a `{ref}` row through `{n}`."
        elabCommand (← `(command|
          $doc:docComment
          @[aw_spec (tier := $(mkIdent `T2)) (doc := $(Syntax.mkStrLit erDoc)) (ts := $(cite n))]
          theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : Er.Core.consistent catalogue st = true) {r : Row}
              (hr : r ∈ st $tT) : r.present (fkOf $tT $nL).columns = true :=
            not_null_present (t := $tT) hc (by decide +kernel) hr))
      if childMultiplicity t fk == .atMostOne then
        let thm := mkIdent (Name.mkSimple s!"{n}_child_is_unique")
        let doc := mkDocComment s!"In every consistent state, a `{ref}` row is referenced through \
          `{n}` by at most one `{sql}` row."
        elabCommand (← `(command|
          $doc:docComment
          @[aw_spec (tier := $(mkIdent `T2)) (doc := $(Syntax.mkStrLit erDoc)) (ts := $(cite n))]
          theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : Er.Core.consistent catalogue st = true) {r1 r2 : Row}
              (h1 : r1 ∈ st $tT) (h2 : r2 ∈ st $tT)
              (hp : r1.present (fkOf $tT $nL).columns = true)
              (he : r1.project (fkOf $tT $nL).columns = r2.project (fkOf $tT $nL).columns) :
              r1 = r2 :=
            unique_of_covers hc (by decide +kernel) h1 h2 hp he))
    for u in s.uniques do
      if !u.partialNullColumns.isEmpty || !u.partialNotNullColumns.isEmpty then continue
      let thm := mkIdent (Name.mkSimple s!"{u.name}_identifies_a_row")
      let doc := mkDocComment s!"In every consistent state, two `{sql}` rows that agree on \
        {colsText u.columns} (all set) are the same row (`{u.name}`)."
      let cols ← strsTerm u.columns
      elabCommand (← `(command|
        $doc:docComment
        @[aw_spec (tier := $(mkIdent `T2))
          (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
          (ts := $(cite u.name))]
        theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : Er.Core.consistent catalogue st = true) {r1 r2 : Row}
            (h1 : r1 ∈ st $tT) (h2 : r2 ∈ st $tT) (hp : r1.present $cols = true)
            (he : r1.project $cols = r2.project $cols) : r1 = r2 :=
          unique_of_covers hc (by decide +kernel) h1 h2 hp he))

end Generator

aw_identity_relationship_theorems

/-- The witness state gives every unique key of the cluster a row with the key set: each
`<key>_identifies_a_row` has a row that satisfies its hypotheses (with itself). -/
example : tables.all (fun t => (catalogue t).uniques.all fun u =>
    !u.partialNullColumns.isEmpty || !u.partialNotNullColumns.isEmpty ||
      (Witness.state t).any (·.present u.columns)) = true := by
  decide +kernel

/-! ## The concepts' shapes in every state -/

private theorem single_project (r : Row) (c : String) : r.project [c] = [r.get c] := rfl

/-- In every consistent state, every principal row decodes to exactly one source: the one-of
shape of `Concepts.Principal.Source` is what the database stores. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_source_xor")
  (doc := "docs/sdk/04-api-specification.md#11-vocabulary")]
theorem principal_row_has_one_source (st : Er.Core.State)
    (hc : Er.Core.consistent catalogue st = true) {p : Row} (hp : p ∈ st .workspacePrincipals) :
    (sourceOfRow? p).isSome = true := by
  rcases principal_has_exactly_one_source st hc hp with ⟨hk, hm, ha⟩ | ⟨hk, ha, hm⟩
  · obtain ⟨m, hm'⟩ := Option.isSome_iff_exists.mp hm
    simp [sourceOfRow?, hk, hm', ha]
  · obtain ⟨k, hk'⟩ := Option.isSome_iff_exists.mp ha
    simp [sourceOfRow?, hk, hk', hm]

example : ∀ p ∈ Witness.state .workspacePrincipals, (sourceOfRow? p).isSome = true :=
  fun _ hp => principal_row_has_one_source _ Witness.core_consistent hp

private theorem identity_checks_hold {st : Er.Core.State}
    (hc : Er.Current.Identity.consistent st = true) {t : TableName} (ht : t ∈ tables)
    {r : Row} (hr : r ∈ st t) {n : String} {e : CheckExpr} (he : (n, e) ∈ checksOf t) :
    e.holds r = true := by
  simp only [Er.Current.Identity.consistent, Bool.and_eq_true, List.all_eq_true] at hc
  have := hc.2 t ht
  simp only [tableChecksHold, List.all_eq_true, Bool.and_eq_true] at this
  exact (this r hr).2 (n, e) he

private theorem core_of_identity {st : Er.Core.State}
    (hc : Er.Current.Identity.consistent st = true) : Er.Core.consistent catalogue st = true := by
  simp only [Er.Current.Identity.consistent, Bool.and_eq_true] at hc
  exact hc.1

private theorem scope_kind_present {st : Er.Core.State}
    (hc : Er.Core.consistent catalogue st = true) {r : Row} (hr : r ∈ st .browserTokens) :
    (r.get "scope_kind").isSome = true := by
  have := not_null_present (t := .browserTokens) (cols := ["scope_kind"]) hc (by decide +kernel) hr
  simpa [Row.present] using this

/-- In every consistent state (with the refined checks), every browser-token row decodes to
exactly one scope: a run or a session, never both and never neither. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_scope_xor")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
theorem browser_token_row_has_one_scope (st : Er.Core.State)
    (hc : Er.Current.Identity.consistent st = true) {r : Row} (hr : r ∈ st .browserTokens) :
    (scopeOfRow? r).isSome = true := by
  have hx := identity_checks_hold hc (t := .browserTokens) (by decide +kernel) hr
    (n := "browser_tokens_scope_xor")
    (e := .xor "scope_kind" "run" "run_id" "session" "session_id") (by decide +kernel)
  have hk := scope_kind_present (core_of_identity hc) hr
  obtain ⟨k, hk'⟩ := Option.isSome_iff_exists.mp hk
  simp only [CheckExpr.holds, CheckExpr.eval, eqText, hk', Option.map_some] at hx
  unfold scopeOfRow?
  rw [hk']
  cases hrun : r.get "run_id" <;> cases hses : r.get "session_id" <;>
    simp only [hrun, hses, Option.isSome_none, Option.isNone_none, Option.isSome_some,
      Option.isNone_some] at hx <;>
    cases hb1 : (k == "run") <;> cases hb2 : (k == "session") <;>
    simp [hb1, hb2, and3, or3] at hx <;>
    first
      | (obtain rfl := beq_iff_eq.mp hb1; rfl)
      | (obtain rfl := beq_iff_eq.mp hb2; rfl)

example : ∀ r ∈ Witness.state .browserTokens, (scopeOfRow? r).isSome = true :=
  fun _ hr => browser_token_row_has_one_scope _ Witness.consistent hr

/-- In every consistent state a membership links exactly one user and exactly one workspace: the
`users` row its `user_id` names and the `workspaces` row its `workspace_id` names exist and are
unique. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/core/src/db/schema/memberships.ts#memberships")]
theorem membership_links_exactly_one_user_and_one_workspace (st : Er.Core.State)
    (hc : Er.Core.consistent catalogue st = true) {m : Row} (hm : m ∈ st .memberships) :
    (∃ u ∈ st .users, u.get "id" = m.get "user_id" ∧
        ∀ u' ∈ st .users, u'.get "id" = m.get "user_id" → u' = u) ∧
      (∃ w ∈ st .workspaces, w.get "id" = m.get "workspace_id" ∧
        ∀ w' ∈ st .workspaces, w'.get "id" = m.get "workspace_id" → w' = w) := by
  have hu1 : (fkOf .memberships "memberships_user_id_users_id_fk").columns = ["user_id"] := by
    decide +kernel
  have hu2 : (fkOf .memberships "memberships_user_id_users_id_fk").refColumns = ["id"] := by
    decide +kernel
  have hu3 : (fkOf .memberships "memberships_user_id_users_id_fk").refTable = .users := by decide +kernel
  have hw1 : (fkOf .memberships "memberships_workspace_id_workspaces_id_fk").columns =
      ["workspace_id"] := by decide +kernel
  have hw2 : (fkOf .memberships "memberships_workspace_id_workspaces_id_fk").refColumns =
      ["id"] := by decide +kernel
  have hw3 : (fkOf .memberships "memberships_workspace_id_workspaces_id_fk").refTable =
      .workspaces := by decide +kernel
  constructor
  · have := exactly_one_parent (t := .memberships)
      (fk := fkOf .memberships "memberships_user_id_users_id_fk") hc (by decide +kernel) (by decide +kernel) hm
      (not_null_present (t := .memberships) hc (by decide +kernel) hm)
    simp only [hu1, hu2, hu3, single_project, List.cons.injEq, and_true] at this
    exact this
  · have := exactly_one_parent (t := .memberships)
      (fk := fkOf .memberships "memberships_workspace_id_workspaces_id_fk") hc (by decide +kernel)
      (by decide +kernel) hm (not_null_present (t := .memberships) hc (by decide +kernel) hm)
    simp only [hw1, hw2, hw3, single_project, List.cons.injEq, and_true] at this
    exact this

example : ∀ m ∈ Witness.state .memberships, (∃ u ∈ Witness.state .users,
    u.get "id" = m.get "user_id" ∧
      ∀ u' ∈ Witness.state .users, u'.get "id" = m.get "user_id" → u' = u) ∧
    (∃ w ∈ Witness.state .workspaces, w.get "id" = m.get "workspace_id" ∧
      ∀ w' ∈ Witness.state .workspaces, w'.get "id" = m.get "workspace_id" → w' = w) :=
  fun _ hm => membership_links_exactly_one_user_and_one_workspace _ Witness.core_consistent hm

/-- In every consistent state a membership principal is backed by exactly one membership, and
that membership is in the principal's workspace. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#11-vocabulary")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_membership_workspace_fk")]
theorem membership_principal_has_exactly_one_membership (st : Er.Core.State)
    (hc : Er.Core.consistent catalogue st = true) {p : Row} (hp : p ∈ st .workspacePrincipals)
    (hk : p.get "kind" = some "membership") :
    ∃ m ∈ st .memberships, m.get "workspace_id" = p.get "workspace_id" ∧
      m.get "id" = p.get "membership_id" ∧
      ∀ m' ∈ st .memberships, m'.get "workspace_id" = p.get "workspace_id" →
        m'.get "id" = p.get "membership_id" → m' = m := by
  have hsrc := principal_has_exactly_one_source st hc hp
  have hmem : (p.get "membership_id").isSome = true := by
    rcases hsrc with ⟨_, h, _⟩ | ⟨h, _, _⟩
    · exact h
    · exact absurd (hk.symm.trans h) (by decide +kernel)
  have hws : (p.get "workspace_id").isSome = true := by
    have := not_null_present (t := .workspacePrincipals) (cols := ["workspace_id"]) hc
      (by decide +kernel) hp
    simpa [Row.present] using this
  have hpres : p.present (fkOf .workspacePrincipals
      "workspace_principals_membership_workspace_fk").columns = true := by
    simp [fkOf, Row.present, hmem, hws, catalogue, TableSpec.foreignKey?]
  obtain ⟨m, hm, he, huniq⟩ := exactly_one_parent (t := .workspacePrincipals)
    (fk := fkOf .workspacePrincipals "workspace_principals_membership_workspace_fk") hc
    (by decide +kernel) (by decide +kernel) hp hpres
  have he' : m.get "workspace_id" = p.get "workspace_id" ∧ m.get "id" = p.get "membership_id" := by
    simpa [fkOf, Row.project, catalogue, TableSpec.foreignKey?] using he
  refine ⟨m, hm, he'.1, he'.2, fun m' hm' h1 h2 => huniq m' hm' ?_⟩
  simp [fkOf, Row.project, catalogue, TableSpec.foreignKey?, h1, h2]

example : ∃ m ∈ Witness.state .memberships, m.get "workspace_id" = some "w1" ∧
    m.get "id" = some "m1" ∧
    ∀ m' ∈ Witness.state .memberships, m'.get "workspace_id" = some "w1" →
      m'.get "id" = some "m1" → m' = m :=
  membership_principal_has_exactly_one_membership Witness.state Witness.core_consistent
    (p := ⟨[("id", "p1"), ("workspace_id", "w1"), ("kind", "membership"), ("membership_id", "m1"),
      ("activated_at", "1000"), ("created_at", "1000")]⟩) (by decide +kernel) rfl

/-- In every consistent state an API-key principal is backed by exactly one API key, in the
principal's workspace: "An API key … *is* the principal". -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_api_key_workspace_fk")]
theorem api_key_principal_has_exactly_one_api_key (st : Er.Core.State)
    (hc : Er.Core.consistent catalogue st = true) {p : Row} (hp : p ∈ st .workspacePrincipals)
    (hk : p.get "kind" = some "api_key") :
    ∃ k ∈ st .apiKeys, k.get "workspace_id" = p.get "workspace_id" ∧
      k.get "id" = p.get "api_key_id" ∧
      ∀ k' ∈ st .apiKeys, k'.get "workspace_id" = p.get "workspace_id" →
        k'.get "id" = p.get "api_key_id" → k' = k := by
  have hsrc := principal_has_exactly_one_source st hc hp
  have hkey : (p.get "api_key_id").isSome = true := by
    rcases hsrc with ⟨h, _, _⟩ | ⟨_, h, _⟩
    · exact absurd (hk.symm.trans h) (by decide +kernel)
    · exact h
  have hws : (p.get "workspace_id").isSome = true := by
    have := not_null_present (t := .workspacePrincipals) (cols := ["workspace_id"]) hc
      (by decide +kernel) hp
    simpa [Row.present] using this
  have hpres : p.present (fkOf .workspacePrincipals
      "workspace_principals_api_key_workspace_fk").columns = true := by
    simp [fkOf, Row.present, hkey, hws, catalogue, TableSpec.foreignKey?]
  obtain ⟨k, hkr, he, huniq⟩ := exactly_one_parent (t := .workspacePrincipals)
    (fk := fkOf .workspacePrincipals "workspace_principals_api_key_workspace_fk") hc
    (by decide +kernel) (by decide +kernel) hp hpres
  have he' : k.get "workspace_id" = p.get "workspace_id" ∧ k.get "id" = p.get "api_key_id" := by
    simpa [fkOf, Row.project, catalogue, TableSpec.foreignKey?] using he
  refine ⟨k, hkr, he'.1, he'.2, fun k' hk' h1 h2 => huniq k' hk' ?_⟩
  simp [fkOf, Row.project, catalogue, TableSpec.foreignKey?, h1, h2]

example : ∃ k ∈ Witness.state .apiKeys, k.get "workspace_id" = some "w1" ∧
    k.get "id" = some "k1" ∧
    ∀ k' ∈ Witness.state .apiKeys, k'.get "workspace_id" = some "w1" →
      k'.get "id" = some "k1" → k' = k :=
  api_key_principal_has_exactly_one_api_key Witness.state Witness.core_consistent
    (p := ⟨[("id", "p2"), ("workspace_id", "w1"), ("kind", "api_key"), ("api_key_id", "k1"),
      ("activated_at", "1000"), ("acts_for_principal_id", "p1"), ("created_at", "1000")]⟩)
    (by decide +kernel) rfl

/-! ## Time: liveness is lost for good -/

/-- A key that is not live at an instant is not live at any later instant: revocation and expiry
are both permanent for a fixed row. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
theorem api_key_liveness_is_lost_for_good (k : ApiKey) {t t' : Instant} (hle : t ≤ t')
    (h : k.live t = false) : k.live t' = false := by
  cases hr : k.revokedAt <;> cases he : k.expiresAt <;>
    simp [ApiKey.live, hr, he] at h ⊢ <;> exact Nat.le_trans h hle

example : (ApiKey.live ⟨⟨"k"⟩, ⟨"w"⟩, "CI", .builder, "p", "h", none, some 50, none, 10, 10⟩ 60) =
    false ∧
    (ApiKey.live ⟨⟨"k"⟩, ⟨"w"⟩, "CI", .builder, "p", "h", none, some 50, none, 10, 10⟩ 70) =
      false :=
  ⟨rfl, api_key_liveness_is_lost_for_good _ (t := 60) (t' := 70) (by decide +kernel) rfl⟩

/-- A key is live exactly when its state is `active`. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")]
theorem api_key_live_iff_active (k : ApiKey) (now : Instant) :
    k.live now = true ↔ k.stateAt now = .active := by
  cases hr : k.revokedAt <;> cases he : k.expiresAt <;>
    simp_all [ApiKey.live, ApiKey.stateAt] <;> omega

/-- A browser token that is not live at an instant is not live at any later instant. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/repositories/browser-tokens.ts#findActiveBrowserTokenByHash")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
theorem browser_token_liveness_is_lost_for_good (b : BrowserToken) {t t' : Instant}
    (hle : t ≤ t') (h : b.live t = false) : b.live t' = false := by
  cases hr : b.revokedAt <;> simp [BrowserToken.live, hr] at h ⊢ <;> exact Nat.le_trans h hle

example : (BrowserToken.live ⟨⟨"t"⟩, ⟨"w"⟩, ⟨"p"⟩, .run ⟨"r"⟩, "h", 300, none, 0⟩ 300) = false ∧
    (BrowserToken.live ⟨⟨"t"⟩, ⟨"w"⟩, ⟨"p"⟩, .run ⟨"r"⟩, "h", 300, none, 0⟩ 301) = false :=
  ⟨rfl, browser_token_liveness_is_lost_for_good _ (t := 300) (t' := 301) (by decide +kernel) rfl⟩

/-- A browser token is live exactly when its state is `active`. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/repositories/browser-tokens.ts#findActiveBrowserTokenByHash")]
theorem browser_token_live_iff_active (b : BrowserToken) (now : Instant) :
    b.live now = true ↔ b.stateAt now = .active := by
  cases hr : b.revokedAt <;> simp_all [BrowserToken.live, BrowserToken.stateAt] <;> omega

/-- Once an invitation has left `pending` (revoked, accepted or expired), its state at every later
instant is the same: resolution and expiry are both final for a fixed row. -/
@[aw_spec (tier := T2) (ts := "apps/web/components/team/invitations-model.ts#invitationStateOf")
  (doc := "docs/formal/inventory.md#2-state-machines")]
theorem invitation_resolution_is_stable (i : Invitation) {t t' : Instant} (hle : t ≤ t')
    (h : i.stateAt t ≠ .pending) : i.stateAt t' = i.stateAt t := by
  cases hr : i.revokedAt <;> cases ha : i.acceptedAt <;>
    simp [Invitation.stateAt, hr, ha] at h ⊢ <;> simp [h, Nat.le_trans h hle]

example : (Invitation.stateAt ⟨⟨"i"⟩, ⟨"w"⟩, "a@b.co", .viewer, none, "h", 50, none, none, 10, 10⟩
    90) = (Invitation.stateAt ⟨⟨"i"⟩, ⟨"w"⟩, "a@b.co", .viewer, none, "h", 50, none, none, 10, 10⟩
    60) :=
  invitation_resolution_is_stable _ (t := 60) (t' := 90) (by decide +kernel) (by decide +kernel)

/-! ## Admission over time -/

/-- The key the admission examples use: live until 500, in workspace `w`. -/
private def liveKey : ApiKey :=
  ⟨⟨"k"⟩, ⟨"w"⟩, "CI", .builder, "p", "h", none, some 500, none, 10, 10⟩

/-- The key's principal row, revoked at `rev` if given. -/
private def keyPrincipal (rev : Option Instant) : Principal :=
  ⟨⟨"p"⟩, ⟨"w"⟩, .apiKey ⟨"k"⟩, 10, rev, 10, none⟩

/-- Admission of an API key, once lost, is lost for good: for fixed key and principal rows, a key
not admitted at an instant is not admitted at any later instant. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")
  (doc := "docs/formal/inventory.md#2-state-machines")]
theorem api_key_admission_is_lost_for_good (k : ApiKey) (p : Principal)
    (target : Option ActsForRow) {t t' : Instant} (hle : t ≤ t')
    (h : apiKeyAdmitted k p t target = false) : apiKeyAdmitted k p t' target = false := by
  unfold apiKeyAdmitted at h ⊢
  cases hl : k.live t
  · simp [api_key_liveness_is_lost_for_good k hle hl]
  · simp_all

example : apiKeyAdmitted liveKey (keyPrincipal none) 500 = false ∧
    apiKeyAdmitted liveKey (keyPrincipal none) 600 = false :=
  ⟨by decide +kernel,
    api_key_admission_is_lost_for_good _ _ none (t := 500) (t' := 600) (by decide +kernel) (by decide +kernel)⟩

/-- The run-scoped token the browser-token examples use: minted by `p`, live until 300. -/
private def runToken : BrowserToken := ⟨⟨"t"⟩, ⟨"w"⟩, ⟨"p"⟩, .run ⟨"r"⟩, "h", 300, none, 10⟩

private theorem token_live_earlier (b : BrowserToken) {t t' : Instant} (hle : t ≤ t')
    (h : b.live t' = true) : b.live t = true := by
  cases hl : b.live t
  · rw [browser_token_liveness_is_lost_for_good b hle hl] at h; exact h
  · rfl

private theorem key_live_earlier (k : ApiKey) {t t' : Instant} (hle : t ≤ t')
    (h : k.live t' = true) : k.live t = true := by
  cases hl : k.live t
  · rw [api_key_liveness_is_lost_for_good k hle hl] at h; exact h
  · rfl

private theorem resolves_earlier (m : Principal) (src : SourceRow) (target : Option ActsForRow)
    {t t' : Instant} (hle : t ≤ t')
    (h : principalResolves m src t' target = true) : principalResolves m src t target = true := by
  rcases m with ⟨id, ws, source, act, rev, cr, actsFor⟩
  cases source <;> cases src <;> simp_all [principalResolves]
  rename_i key
  cases key with
  | none => simp_all
  | some k => simp_all [key_live_earlier k hle]

/-- Browser-token admission, once lost to time, is lost for good: for fixed token, scoped and
minter rows, a token not admitted at an instant is not admitted at any later instant. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
theorem browser_token_admission_is_lost_for_good (b : BrowserToken) (target : Option ScopedRow)
    (m : Principal) (src : SourceRow) (actsFor : Option ActsForRow) {t t' : Instant} (hle : t ≤ t')
    (h : browserTokenAdmitted b target m src t actsFor = false) :
    browserTokenAdmitted b target m src t' actsFor = false := by
  -- Only the token's liveness and the minter's resolution depend on the instant; the proof
  -- rewrites those two and is independent of the other conjuncts of the admission.
  unfold browserTokenAdmitted at h ⊢
  cases hl' : b.live t'
  · simp
  · cases hr' : principalResolves m src t' actsFor
    · simp
    · rw [token_live_earlier b hle hl', resolves_earlier m src actsFor hle hr'] at h
      exact h

example : browserTokenAdmitted runToken (some (.run ⟨"r"⟩ .running)) (keyPrincipal none)
      (.apiKey (some liveKey)) 300 = false ∧
    browserTokenAdmitted runToken (some (.run ⟨"r"⟩ .running)) (keyPrincipal none)
      (.apiKey (some liveKey)) 400 = false :=
  ⟨by decide +kernel, browser_token_admission_is_lost_for_good _ _ _ _ none (t := 300) (t' := 400)
    (by decide +kernel) (by decide +kernel)⟩

/-! ## Bearer shapes -/

/-- No string is both a presented API key and a presented browser token: the two grammars fix
different total lengths (74 and 75 characters), so `apps/web/proxy.ts` can tell them apart by
shape alone. -/
@[aw_spec (tier := T2) (ts := "packages/contracts/src/api-keys.ts#API_KEY_PATTERN")
  (ts := "packages/contracts/src/tokens.ts#BROWSER_TOKEN_PATTERN")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
theorem no_bearer_is_both_an_api_key_and_a_browser_token (s : String) :
    ¬ (Concepts.ApiKey.presentedShaped s = true ∧
      Concepts.BrowserToken.presentedShaped s = true) := by
  intro ⟨ha, hb⟩
  simp only [Concepts.ApiKey.presentedShaped, Concepts.BrowserToken.presentedShaped,
    bearerShaped, Bool.and_eq_true, beq_iff_eq] at ha hb
  have h1 := ha.1.1.1.1
  have h2 := hb.1.1.1.1
  rw [h1] at h2
  simp [Concepts.ApiKey.prefix_, Concepts.BrowserToken.prefix_, Concepts.ApiKey.idLength,
    Concepts.ApiKey.secretLength, Concepts.BrowserToken.idLength,
    Concepts.BrowserToken.secretLength] at h2

/-! ## Source coverage is per workspace -/

/-- A state with one membership (if `m`) and one API key (if `k`) of `w1`, whose principal rows
name the right membership and key ids but sit in `w2`. -/
def crossedCoverage (m k : Bool) : State
  | .memberships =>
    if m then [⟨[("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner")]⟩]
    else []
  | .apiKeys =>
    if k then [⟨[("id", "k1"), ("workspace_id", "w1"), ("name", "CI"), ("role", "builder")]⟩]
    else []
  | .workspacePrincipals =>
    (if m then
      [⟨[("id", "p1"), ("workspace_id", "w2"), ("kind", "membership"), ("membership_id", "m1")]⟩]
     else []) ++
    (if k then [⟨[("id", "p2"), ("workspace_id", "w2"), ("kind", "api_key"), ("api_key_id", "k1")]⟩]
     else [])
  | _ => []

/-- In every consistent state that meets RF-101's coverage target, every membership has exactly one
principal row that names it, and that row is in the membership's own workspace ("one human
principal per Membership"). -/
@[aw_spec (tier := T2)
  (doc := "docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md#rf-101--introduce-workspaceprincipal-and-split-identity-ownership-and-attribution")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_workspace_membership_key")]
theorem target_gives_each_membership_exactly_one_principal (st : Er.Core.State)
    (hc : Er.Core.consistent catalogue st = true) (hcov : everySourceHasPrincipal st = true)
    {m : Row} (hm : m ∈ st .memberships) :
    ∃ p ∈ st .workspacePrincipals, p.get "workspace_id" = m.get "workspace_id" ∧
      p.get "membership_id" = m.get "id" ∧
      ∀ p' ∈ st .workspacePrincipals, p'.get "workspace_id" = m.get "workspace_id" →
        p'.get "membership_id" = m.get "id" → p' = p := by
  simp only [everySourceHasPrincipal, Bool.and_eq_true, List.all_eq_true, List.any_eq_true,
    beq_iff_eq] at hcov
  obtain ⟨p, hp, hw, hid⟩ := hcov.1 m hm
  refine ⟨p, hp, hw, hid, fun p' hp' hw' hid' => ?_⟩
  have hmp : m.present ["workspace_id", "id"] = true :=
    not_null_present (t := .memberships) hc (by decide +kernel) hm
  simp only [Row.present, List.all_cons, List.all_nil, Bool.and_true, Bool.and_eq_true] at hmp
  exact unique_of_covers (t := .workspacePrincipals) (cols := ["workspace_id", "membership_id"])
    hc (by decide +kernel) hp' hp (by simp [Row.present, hw', hid', hmp.1, hmp.2])
    (by simp [Row.project, hw, hid, hw', hid'])

example : ∀ m ∈ Witness.state .memberships, ∃ p ∈ Witness.state .workspacePrincipals,
    p.get "workspace_id" = m.get "workspace_id" ∧ p.get "membership_id" = m.get "id" :=
  fun _ hm =>
    let ⟨p, hp, hw, hid, _⟩ := target_gives_each_membership_exactly_one_principal _
      Witness.core_consistent Witness.covers_target hm
    ⟨p, hp, hw, hid⟩

/-- In every consistent state that meets RF-101's coverage target, every API key has exactly one
principal row that names it, and that row is in the key's own workspace ("one machine principal
per APIKey"). -/
@[aw_spec (tier := T2)
  (doc := "docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md#rf-101--introduce-workspaceprincipal-and-split-identity-ownership-and-attribution")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_workspace_api_key_key")]
theorem target_gives_each_api_key_exactly_one_principal (st : Er.Core.State)
    (hc : Er.Core.consistent catalogue st = true) (hcov : everySourceHasPrincipal st = true)
    {k : Row} (hk : k ∈ st .apiKeys) :
    ∃ p ∈ st .workspacePrincipals, p.get "workspace_id" = k.get "workspace_id" ∧
      p.get "api_key_id" = k.get "id" ∧
      ∀ p' ∈ st .workspacePrincipals, p'.get "workspace_id" = k.get "workspace_id" →
        p'.get "api_key_id" = k.get "id" → p' = p := by
  simp only [everySourceHasPrincipal, Bool.and_eq_true, List.all_eq_true, List.any_eq_true,
    beq_iff_eq] at hcov
  obtain ⟨p, hp, hw, hid⟩ := hcov.2 k hk
  refine ⟨p, hp, hw, hid, fun p' hp' hw' hid' => ?_⟩
  have hkp : k.present ["workspace_id", "id"] = true :=
    not_null_present (t := .apiKeys) hc (by decide +kernel) hk
  simp only [Row.present, List.all_cons, List.all_nil, Bool.and_true, Bool.and_eq_true] at hkp
  exact unique_of_covers (t := .workspacePrincipals) (cols := ["workspace_id", "api_key_id"])
    hc (by decide +kernel) hp' hp (by simp [Row.present, hw', hid', hkp.1, hkp.2])
    (by simp [Row.project, hw, hid, hw', hid'])

example : ∀ k ∈ Witness.state .apiKeys, ∃ p ∈ Witness.state .workspacePrincipals,
    p.get "workspace_id" = k.get "workspace_id" ∧ p.get "api_key_id" = k.get "id" :=
  fun _ hk =>
    let ⟨p, hp, hw, hid, _⟩ := target_gives_each_api_key_exactly_one_principal _
      Witness.core_consistent Witness.covers_target hk
    ⟨p, hp, hw, hid⟩

/-- The workspace half of coverage matters: a membership (and, separately, a key) whose id some
principal row names, but from another workspace, is uncovered. -/
example :
    (∀ m ∈ crossedCoverage true false .memberships,
        ∃ p ∈ crossedCoverage true false .workspacePrincipals,
          p.get "membership_id" = m.get "id") ∧
      everySourceHasPrincipal (crossedCoverage true false) = false ∧
      (∀ k ∈ crossedCoverage false true .apiKeys,
        ∃ p ∈ crossedCoverage false true .workspacePrincipals, p.get "api_key_id" = k.get "id") ∧
      everySourceHasPrincipal (crossedCoverage false true) = false := by
  decide +kernel

/-! ## Owner and actor (issue #509, S1-24) -/

/-- Every well-formed authenticated principal owns what it writes unless it is an API key: an owner
that differs from the acting principal belongs to an API-key principal. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/rbac/principal.ts#isPrincipal")
  (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")]
theorem owner_differs_from_the_actor_only_for_an_api_key (a : Actor) (h : a.wellFormed = true)
    (hne : a.ownerPrincipalId ≠ a.principalId) : a.kind = .apiKey := by
  obtain ⟨pid, kind, ws, label, user, actor, role, via, key, scope, owner⟩ := a
  cases kind with
  | apiKey => rfl
  | membership =>
    simp only [Actor.wellFormed, Bool.and_eq_true, beq_iff_eq] at h
    exact absurd h.2.2 hne

example : (fromApiKey ⟨"p-key", "k", "w", .admin, "CI", some "p-admin"⟩).kind = .apiKey :=
  owner_differs_from_the_actor_only_for_an_api_key _ rfl (by decide +kernel)

/-- The owner of every principal the constructors build is its own principal or the principal it
acts for, and a browser token keeps its minter's. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/rbac/principal.ts#fromApiKey")
  (ts := "apps/web/server/rbac/principal.ts#fromDirectoryRecord")
  (ts := "apps/web/server/rbac/principal.ts#fromBrowserToken")
  (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")]
theorem owner_is_the_actor_or_the_principal_it_acts_for :
    (∀ i : ApiKeyIdentity, (fromApiKey i).ownerPrincipalId = i.principalId ∨
        some (fromApiKey i).ownerPrincipalId = i.actsForPrincipalId) ∧
      (∀ r : DirectoryRecord, (fromDirectoryRecord r).ownerPrincipalId = r.principalId ∨
        some (fromDirectoryRecord r).ownerPrincipalId = r.actsForPrincipalId) ∧
      ∀ (m : Actor) (s : Scope), (fromBrowserToken m s).ownerPrincipalId = m.ownerPrincipalId := by
  refine ⟨fun i => ?_, fun r => ?_, fun _ _ => rfl⟩
  · cases h : i.actsForPrincipalId <;> simp [fromApiKey, ownerOf, h]
  · cases hk : r.kind <;> cases h : r.actsForPrincipalId <;>
      simp [fromDirectoryRecord, ownerOf, hk, h]

/-! ### The repair of what earlier local runtime keys own -/

private theorem find_none_iff (locals : List LocalKey) (o : String) :
    locals.find? (·.id == o) = none ↔ ∀ l ∈ locals, l.id ≠ o := by
  simp [List.find?_eq_none]

private theorem repaired_owner_of_find_none {locals : List LocalKey} {target o : String}
    (hf : locals.find? (·.id == o) = none) : repairedOwner locals target o = o := by
  simp [repairedOwner, hf]

/-- After the repair, no owner is a local key's principal. -/
private theorem repaired_owner_is_not_local {locals : List LocalKey} {target : String}
    (h : targetsOutside locals target = true) (o : String) :
    locals.find? (·.id == repairedOwner locals target o) = none := by
  simp only [targetsOutside, Bool.and_eq_true, List.all_eq_true, bne_iff_ne, ne_eq] at h
  rw [find_none_iff]
  unfold repairedOwner
  cases hf : locals.find? (·.id == o) with
  | none => exact (find_none_iff locals o).mp hf
  | some l =>
    have hl : l ∈ locals := List.mem_of_find?_eq_some hf
    intro l' hl'
    cases ha : l.actsFor with
    | none =>
      show l'.id ≠ l.actsFor.getD target
      rw [ha]
      exact h.1 l' hl'
    | some a =>
      have := h.2 l hl
      simp only [ha, Option.all_some, List.all_eq_true, bne_iff_ne, ne_eq] at this
      show l'.id ≠ l.actsFor.getD target
      rw [ha]
      exact this l' hl'

/-- The repair moves every row a local key's principal owns away from local keys: after it, no row
is owned by any local runtime key's principal. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/directory.ts#reassignLocalRuntimeKeyOwnership")
  (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")]
theorem repair_leaves_no_row_owned_by_a_local_key (locals : List LocalKey) (target : String)
    (rows : List OwnedRow) (h : targetsOutside locals target = true) :
    ∀ r ∈ reassignLocalOwnership locals target rows, ∀ l ∈ locals, l.id ≠ r.owner := by
  intro r hr
  simp only [reassignLocalOwnership, List.mem_map] at hr
  obtain ⟨r0, _, rfl⟩ := hr
  exact (find_none_iff _ _).mp (repaired_owner_is_not_local h r0.owner)

/-- The repair is idempotent: running the reassignment a second time changes nothing. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/directory.ts#reassignLocalRuntimeKeyOwnership")
  (ts := "apps/web/server/cli-auth/local-credential.ts#issueLocalApiKey")
  (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")]
theorem reassign_local_ownership_is_idempotent (locals : List LocalKey) (target : String)
    (rows : List OwnedRow) (h : targetsOutside locals target = true) :
    reassignLocalOwnership locals target (reassignLocalOwnership locals target rows) =
      reassignLocalOwnership locals target rows := by
  simp only [reassignLocalOwnership, List.map_map]
  apply List.map_congr_left
  intro r _
  simp [repaired_owner_of_find_none (repaired_owner_is_not_local h r.owner)]

/-- The whole repair (the acts-for backfill and the reassignment) is idempotent: a second start
that runs it on what the first left changes nothing. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/directory.ts#reassignLocalRuntimeKeyOwnership")
  (ts := "apps/web/server/cli-auth/local-credential.ts#issueLocalApiKey")
  (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")]
theorem repair_local_ownership_is_idempotent (locals : List LocalKey) (target : String)
    (rows : List OwnedRow) (h : targetsOutside locals target = true) :
    repairLocalOwnership (repairLocalOwnership locals target rows).1 target
        (repairLocalOwnership locals target rows).2 =
      repairLocalOwnership locals target rows := by
  simp only [repairLocalOwnership, backfillActsFor, reassignLocalOwnership, List.map_map]
  refine Prod.ext ?_ ?_
  · apply List.map_congr_left
    intro l _
    simp
  · apply List.map_congr_left
    intro r _
    have hn := repaired_owner_is_not_local h r.owner
    have hb : (locals.map fun l => { l with actsFor := some (l.actsFor.getD target) }).find?
        (·.id == repairedOwner locals target r.owner) = none := by
      rw [find_none_iff] at hn ⊢
      intro l' hl'
      obtain ⟨l, hl, rfl⟩ := List.mem_map.mp hl'
      exact hn l hl
    simp [repaired_owner_of_find_none hb]

/-- The repair leaves every row whose owner is not a local key's principal as it was: a hosted
key's rows, a member's rows and every other owner keep their owner. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/directory.ts#reassignLocalRuntimeKeyOwnership")
  (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")]
theorem repair_keeps_rows_no_local_key_owns (locals : List LocalKey) (target : String)
    (rows : List OwnedRow) (r : OwnedRow) (hr : r ∈ rows) (h : ∀ l ∈ locals, l.id ≠ r.owner) :
    r ∈ reassignLocalOwnership locals target rows := by
  simp only [reassignLocalOwnership, List.mem_map]
  exact ⟨r, hr, by simp [repaired_owner_of_find_none ((find_none_iff _ _).mpr h)]⟩

/-- Two earlier local keys (one that recorded the principal it acts for, one that did not), the
bootstrap admin's principal, and rows owned by each key, by a hosted key and by a member. -/
private def repairLocals : List LocalKey := [⟨"p-key1", none⟩, ⟨"p-key2", some "p-admin0"⟩]

private def repairRows : List OwnedRow :=
  [⟨"agent-1", "p-key1"⟩, ⟨"session-1", "p-key2"⟩, ⟨"agent-2", "p-hosted"⟩, ⟨"skill-1", "p-ada"⟩]

example : targetsOutside repairLocals "p-admin" = true ∧
    reassignLocalOwnership repairLocals "p-admin" repairRows =
      [⟨"agent-1", "p-admin"⟩, ⟨"session-1", "p-admin0"⟩, ⟨"agent-2", "p-hosted"⟩,
        ⟨"skill-1", "p-ada"⟩] ∧
    backfillActsFor repairLocals "p-admin" = [⟨"p-key1", some "p-admin"⟩, ⟨"p-key2", some "p-admin0"⟩] :=
  by decide +kernel

example : reassignLocalOwnership repairLocals "p-admin"
      (reassignLocalOwnership repairLocals "p-admin" repairRows) =
    reassignLocalOwnership repairLocals "p-admin" repairRows :=
  reassign_local_ownership_is_idempotent _ _ _ (by decide +kernel)

example : repairLocalOwnership (repairLocalOwnership repairLocals "p-admin" repairRows).1 "p-admin"
      (repairLocalOwnership repairLocals "p-admin" repairRows).2 =
    repairLocalOwnership repairLocals "p-admin" repairRows :=
  repair_local_ownership_is_idempotent _ _ _ (by decide +kernel)

example : ⟨"agent-2", "p-hosted"⟩ ∈ reassignLocalOwnership repairLocals "p-admin" repairRows :=
  repair_keeps_rows_no_local_key_owns _ _ _ _ (by decide +kernel) (by decide +kernel)

example : ∀ r ∈ reassignLocalOwnership repairLocals "p-admin" repairRows,
    ∀ l ∈ repairLocals, l.id ≠ r.owner :=
  repair_leaves_no_row_owned_by_a_local_key _ _ _ (by decide +kernel)

/-- Without the hypothesis the repair is not idempotent: a local key that acts for another local
key's principal moves its rows twice. -/
example : let ls : List LocalKey := [⟨"k1", some "k2"⟩, ⟨"k2", none⟩]
    targetsOutside ls "admin" = false ∧
      reassignLocalOwnership ls "admin" (reassignLocalOwnership ls "admin" [⟨"a", "k1"⟩]) ≠
        reassignLocalOwnership ls "admin" [⟨"a", "k1"⟩] := by decide +kernel

end AgentWorkspace.Theorems.Invariants.ConceptIdentity
