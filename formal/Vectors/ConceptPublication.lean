import AgentWorkspace.Er.Current.Publication
import AgentWorkspace.Prelude.Json
import Vectors.Common

/-!
Vectors for the publication concept: the share vocabularies, the three cluster tables, the
cluster's refined checks, a grid of typed shares (row encoding, database and service invariants,
derived state, whether the public link opens, and the wire rendering), and the publish-option
pairing and field bounds of `POST /api/shares`.
-/

namespace Vectors.ConceptPublication

open Lean AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Share
open AgentWorkspace.Concepts (Membership.Role)
open AgentWorkspace.Er.Current.Publication (tables checkSql checkSemantics? foreignKeys)

private def T0 (n : String) : String := "AgentWorkspace.Theorems.WellFormed.ConceptPublication." ++ n
private def T1 (n : String) : String := "AgentWorkspace.Theorems.Normative.ConceptPublication." ++ n
private def T2 (n : String) : String := "AgentWorkspace.Theorems.Invariants.ConceptPublication." ++ n
private def T5 (n : String) : String := "AgentWorkspace.Theorems.Meta.ConceptPublication." ++ n

private def optStr : Option String → Json
  | none => Json.null
  | some s => Json.str s

private def optNat : Option Nat → Json
  | none => Json.null
  | some n => toJson n

private def strs (l : List String) : Json := toJson l

/-! ## Vocabularies -/

private def vocabularyVectors {α : Type} [WireEnum α] (name : String) (nearMisses : List String)
    (witnesses : List String) : List Vector :=
  let members := (WireEnum.all : List α).map WireEnum.toWire
  let valid := members.zipIdx.map fun (w, i) =>
    ({ id := s!"vocabulary/{name}/valid/{w}",
       input := Json.mkObj [("vocabulary", name), ("value", w)],
       expected := Json.mkObj [("valid", true), ("index", toJson i)],
       witnesses := witnesses ++ [T0 "share_vocabularies_round_trip"] } : Vector)
  let invalid := nearMisses.map fun w =>
    ({ id := s!"vocabulary/{name}/invalid/{(Json.str w).compress}",
       input := Json.mkObj [("vocabulary", name), ("value", w)],
       expected := Json.mkObj [("valid", false), ("index", Json.null)],
       witnesses := [T0 "share_vocabularies_reject_near_misses"] } : Vector)
  valid ++ invalid

def vocabularies : List Vector :=
  vocabularyVectors (α := SubjectType) "subject-type"
      ["", "Agent", "AGENT", " agent", "agent ", "file", "files", "run", "workspace", "agents"]
      [T0 "subject_type_wires", T1 "shareable_objects_are_exactly_four"] ++
    vocabularyVectors (α := Visibility) "visibility"
      ["", "Public", "public ", "link", "org", "internal", "shared", "workspaces"]
      [T0 "visibility_wires", T1 "three_visibilities"] ++
    vocabularyVectors (α := Mode) "mode"
      ["", "run", "Runnable", "definitions", "view", "live"] [T0 "mode_wires"] ++
    vocabularyVectors (α := Expiry) "expiry"
      ["", "24h", "24 hours", "1 day", "7 day", "30days", "Never", "forever", "0"]
      [T0 "expiry_wires", T1 "expiry_options_and_lifetimes"]

/-! ## Tables -/

private def columnJson (c : Column) : Json :=
  Json.mkObj [("name", c.name), ("type", toJson c.type), ("notNull", c.notNull)]

private def fkJson (t : TableName) (fk : ForeignKey) : Json :=
  Json.mkObj [("name", fk.name), ("columns", strs fk.columns),
    ("refTable", WireEnum.toWire fk.refTable), ("refColumns", strs fk.refColumns),
    ("onDelete", WireEnum.toWire fk.onDelete), ("inline", fk.inline),
    ("class", WireEnum.toWire (classify catalogue t fk))]

private def uniqueJson (u : UniqueKey) : Json :=
  Json.mkObj [("name", u.name), ("columns", strs u.columns), ("kind", WireEnum.toWire u.kind),
    ("partialNullColumns", strs u.partialNullColumns)]

private def checkJson (t : TableName) : Check → Json
  | .oneOf n c vs => Json.mkObj [("name", n), ("kind", "one-of"), ("column", c), ("values", strs vs)]
  | .other n =>
    Json.mkObj [("name", n), ("kind", "other"),
      ("sql", optStr ((checkSql.find? fun p => p.1 == t && p.2.1 == n).map (·.2.2)))]

def tableVectors : List Vector :=
  tables.map fun t =>
    let s := catalogue t
    { id := s!"table/{WireEnum.toWire t}",
      input := Json.mkObj [("table", WireEnum.toWire t), ("tsExport", s.tsExport)],
      expected := Json.mkObj [
        ("columns", Json.arr (s.columns.map columnJson).toArray),
        ("primaryKey", strs s.primaryKey),
        ("foreignKeys", Json.arr (s.foreignKeys.map (fkJson t)).toArray),
        ("uniques", Json.arr (s.uniques.map uniqueJson).toArray),
        ("checks", Json.arr (s.checks.map (checkJson t)).toArray)],
      witnesses := [T0 "cluster_foreign_keys_are_the_catalogue's", T0 "cluster_foreign_key_classes",
        T0 "refined_checks_are_the_catalogue's", T0 "closed_set_checks_are_the_vocabularies",
        T0 "cluster_checks_all_refined", T1 "share_children_cascade",
        T1 "every_share_has_a_publisher_principal", T1 "charge_is_keyed_by_the_run"] }

/-! ## Refined checks -/

private def rowJson (r : Row) : Json := Json.mkObj (r.cells.map fun (c, v) => (c, Json.str v))

/-- Sample rows for each refined check: the column values the check reads. -/
private def checkCases : String → List Row
  | "shares_agent_mode_only" =>
    [⟨[("subject_type", "agent"), ("mode", "definition")]⟩,
     ⟨[("subject_type", "agent"), ("mode", "runnable")]⟩, ⟨[("subject_type", "agent")]⟩,
     ⟨[("subject_type", "session"), ("mode", "definition")]⟩,
     ⟨[("subject_type", "project"), ("mode", "runnable")]⟩, ⟨[("subject_type", "skill")]⟩]
  | "shares_budget_nonnegative" =>
    [⟨[]⟩, ⟨[("budget_cap_usd", "0")]⟩, ⟨[("budget_cap_usd", "20.0000")]⟩,
     ⟨[("budget_cap_usd", "-0.0001")]⟩, ⟨[("budget_cap_usd", "-0")]⟩]
  | "shares_spend_nonnegative" =>
    [⟨[("spent_usd", "0")]⟩, ⟨[("spent_usd", "0.000001")]⟩, ⟨[("spent_usd", "-0.000001")]⟩,
     ⟨[("spent_usd", "-0.000000")]⟩]
  | "shares_subject_id_not_blank" =>
    [⟨[("subject_id", "a1")]⟩, ⟨[("subject_id", "")]⟩, ⟨[("subject_id", " ")]⟩,
     ⟨[("subject_id", "   ")]⟩, ⟨[("subject_id", "\t")]⟩, ⟨[("subject_id", " x ")]⟩]
  | "share_run_charges_nonnegative" =>
    [⟨[("charged_usd", "0")]⟩, ⟨[("charged_usd", "0.5")]⟩, ⟨[("charged_usd", "-0.000001")]⟩]
  | _ => []

def checkVectors : List Vector :=
  checkSql.map fun (t, n, sql) =>
    { id := s!"check/{n}",
      input := Json.mkObj [("table", WireEnum.toWire t), ("name", n)],
      expected := Json.mkObj [("sql", sql),
        ("cases", Json.arr ((checkCases n).map fun r =>
          Json.mkObj [("row", rowJson r), ("holds", toJson ((checkSemantics? n r).getD true))]).toArray)],
      witnesses := [T0 "refined_checks_are_the_catalogue's", T0 "non_negative_amount_edges",
        T2 "share_db_valid_iff_row_checks", T2 "charge_db_valid_iff_row_check",
        T5 "a_space_subject_id_passes_validation_but_not_the_database"] }

/-! ## Typed shares -/

private def includeJson (i : Include) : Json :=
  Json.mkObj ((i.technicalDetails.map (fun b => [("technicalDetails", toJson b)])).getD [] ++
    (i.outputFiles.map (fun b => [("outputFiles", toJson b)])).getD [])

private def shareJson (s : Share) : Json :=
  Json.mkObj [("id", s.id.val), ("workspaceId", s.workspace.val), ("token", s.token),
    ("subjectType", s.subjectType.toWire), ("subjectId", s.subjectId),
    ("subjectLabel", s.subjectLabel), ("visibility", s.visibility.toWire),
    ("mode", optStr (s.mode.map Mode.toWire)), ("snapshot", optStr s.snapshot),
    ("include", includeJson s.«include»), ("budgetCapUsd", optStr s.budgetCapUsd),
    ("spentUsd", s.spentUsd), ("stopped", s.stopped), ("expiresAt", optNat s.expiresAt),
    ("passphraseHash", optStr s.passphraseHash),
    ("createdBy", optStr (s.createdBy.map (·.val))),
    ("publisherPrincipalId", s.publisher.val), ("revokedAt", optNat s.revokedAt),
    ("suspendedAt", optNat s.suspendedAt), ("createdAt", toJson s.createdAt)]

/-- The base share of the grid: a live, public agent definition share. -/
private def base : Share :=
  { id := ⟨"00000000-0000-4000-8000-000000000001"⟩,
    workspace := ⟨"00000000-0000-4000-8000-000000000002"⟩, token := "pub_vector-token",
    subjectType := .agent, subjectId := "00000000-0000-4000-8000-000000000005",
    subjectLabel := "General", visibility := .«public», mode := some .definition,
    snapshot := none, «include» := {}, budgetCapUsd := none, spentUsd := "0", stopped := false,
    expiresAt := none, passphraseHash := none,
    createdBy := some ⟨"00000000-0000-4000-8000-000000000003"⟩,
    publisher := ⟨"00000000-0000-4000-8000-000000000004"⟩, revokedAt := none,
    suspendedAt := none, createdAt := 0 }

private def now : Nat := 1000000

private def lifecycleShares : List (String × Share) :=
  (WireEnum.all : List Visibility).flatMap fun v =>
    [false, true].flatMap fun rev => [false, true].flatMap fun sus => [false, true].flatMap
      fun stop => [("none", none), ("past", some (now - 1)), ("exact", some now),
        ("future", some (now + 1))].map fun (en, e) =>
        (s!"{v.toWire}/revoked={rev}/suspended={sus}/stopped={stop}/expiry={en}",
          { base with
            visibility := v
            revokedAt := if rev then some 500 else none
            suspendedAt := if sus then some 600 else none
            stopped := stop
            expiresAt := e })

private def shapeShares : List (String × Share) :=
  (WireEnum.all : List SubjectType).flatMap fun t =>
    [none, some Mode.definition, some Mode.runnable].flatMap fun m =>
      [none, some "20", some "-1"].flatMap fun b =>
        [({} : Include), { technicalDetails := some true }].map fun i =>
          (s!"{t.toWire}/mode={(m.map Mode.toWire).getD "null"}/budget={b.getD "null"}/include={Include.toJsonText i}",
            { base with subjectType := t, mode := m, budgetCapUsd := b, «include» := i })

private def edgeShares : List (String × Share) :=
  [("subject-id-space", { base with subjectId := " " }),
   ("subject-id-tab", { base with subjectId := "\t" }),
   ("spent-negative", { base with spentUsd := "-0.000001" }),
   ("spent-signed-zero", { base with spentUsd := "-0.000000" }),
   ("token-without-prefix", { base with token := "abc" }),
   ("private-with-passphrase", { base with visibility := .«private», passphraseHash := some "h" }),
   ("workspace-without-creator", { base with visibility := .workspace, createdBy := none }),
   ("runnable-exhausted", { base with
      mode := some .runnable
      budgetCapUsd := some "20"
      spentUsd := "20.000000" }),
   ("runnable-below-cap", { base with
      mode := some .runnable
      budgetCapUsd := some "20"
      spentUsd := "19.999999" })]

private def lifecycleWitnesses : List String :=
  [T2 "closed_link_stays_closed", T1 "only_a_public_share_opens", T1 "revoked_link_never_opens",
    T1 "suspended_link_does_not_open", T1 "stopped_link_does_not_open",
    T1 "expiry_closes_the_link_at_its_instant", T1 "live_public_share_always_opens",
    T1 "url_exactly_when_public", T5 "private_and_workspace_shares_never_open"]

private def shapeWitnesses : List String :=
  [T2 "share_row_encodes_fields", T2 "share_db_valid_iff_row_checks",
    T1 "token_never_crosses_the_wire_as_a_field", T1 "view_count_only_on_list_items",
    T1 "budget_is_exhausted_at_the_cap", T2 "well_published_requires_the_pub_prefix"]

private def shareVector (witnesses : List String) : String × Share → Vector
  | (name, s) =>
    { id := s!"share/{name}",
      input := Json.mkObj [("share", shareJson s), ("now", toJson now)],
      expected := Json.mkObj [
        ("row", rowJson s.toRow),
        ("dbValid", s.dbValid),
        ("wellPublished", s.wellPublished),
        ("state", s.stateAt now |>.toWire),
        ("publiclyOpen", s.publiclyOpen now),
        ("budgetExhausted", s.budgetExhausted),
        ("url", optStr s.url?),
        ("keys", strs (resourceKeys s.visibility false)),
        ("listKeys", strs (resourceKeys s.visibility true))],
      witnesses }

def shareVectors : List Vector :=
  lifecycleShares.map (shareVector lifecycleWitnesses) ++
    (shapeShares ++ edgeShares).map (shareVector shapeWitnesses)

/-! ## Publish options and fields -/

def optionVectors : List Vector :=
  (WireEnum.all : List SubjectType).flatMap fun t =>
    [none, some Mode.definition, some Mode.runnable].flatMap fun m =>
      [false, true].flatMap fun (i : Bool) => [false, true].flatMap fun (b : Bool) =>
        [false, true].flatMap fun (tr : Bool) => [false, true].map fun (d : Bool) =>
          { id := s!"options/{t.toWire}/mode={(m.map Mode.toWire).getD "none"}/include={i}/budget={b}/transcript={tr}/definition={d}",
            input := Json.mkObj [("subjectType", t.toWire), ("mode", optStr (m.map Mode.toWire)),
              ("include", toJson i), ("budget", toJson b), ("transcript", toJson tr),
              ("definition", toJson d)],
            expected := Json.mkObj [("fits", optionsFit t m i b tr d)],
            witnesses := [T1 "mode_budget_and_definition_are_agent_only",
              T1 "budget_requires_runnable_mode", T1 "include_and_transcript_are_session_only",
              T1 "every_option_fits_its_subject"] }

private def fieldVector (field value : String) (accepted : Bool) (extra : List (String × Json))
    (witnesses : List String) : Vector :=
  { id := s!"field/{field}/{(Json.str value).compress}",
    input := Json.mkObj [("field", field), ("value", value)],
    expected := Json.mkObj ([("accepted", toJson accepted)] ++ extra), witnesses }

def fieldVectors : List Vector :=
  (["a1", "", " ", "   ", "\t", " x "].map fun v =>
      fieldVector "subjectId" v (subjectIdAccepted v) [("databaseAccepts", toJson (notBlankSql v))]
        [T5 "a_space_subject_id_passes_validation_but_not_the_database",
          T2 "share_subject_id_is_not_blank"]) ++
    ([0, 1, 2, 1023, 1024, 1025, 2048].map fun n =>
      fieldVector "passphraseLength" (toString n) (passphraseAccepted n) []
        [T1 "passphrase_length_bounds"]) ++
    (["0", "-0", "-1", "0.01", "1", "20", "0.000001"].map fun v =>
      fieldVector "budgetCapUsd" v (budgetAccepted v) [] [T1 "budget_must_be_positive"])

/-! ## Publishing, opening and listing -/

private def roles : List Membership.Role := WireEnum.all

private def requestJson (r : PublishRequest) : Json :=
  Json.mkObj [("subjectType", r.subjectType.toWire), ("visibility", r.visibility.toWire),
    ("mode", optStr (r.mode.map Mode.toWire)), ("budgetCapUsd", optStr r.budgetCapUsd),
    ("expiry", optStr (r.expiry.map Expiry.toWire)), ("passphrase", optStr r.passphrase)]

private def outcomeJson : PublishOutcome → Json
  | .published p => Json.mkObj [("outcome", "published"),
      ("mode", optStr (p.mode.map Mode.toWire)), ("budgetCapUsd", optStr p.budgetCapUsd),
      ("expiresAt", optNat p.expiresAt), ("hasPassphraseHash", toJson p.hasPassphraseHash),
      ("tokenPrefix", tokenPrefix)]
  | .refused r => Json.mkObj [("outcome", "refused"), ("code", r.code), ("message", r.message)]

private def publishWitnesses : List String :=
  [T1 "public_share_refused_while_public_sharing_is_off", T1 "runnable_is_refused_in_this_release",
    T1 "runnable_requires_owner_or_admin", T1 "agent_share_defaults_to_definition",
    T1 "runnable_budget_defaults_to_twenty", T1 "passphrase_is_stored_exactly_when_given",
    T2 "published_mode_and_budget_fit", T2 "no_runnable_share_is_published_today",
    T2 "no_public_share_is_published_while_sharing_is_off",
    T2 "published_expiry_counts_from_now", T2 "well_published_requires_the_pub_prefix"]

/-- The requests the schema accepts, over subject, visibility, mode and budget: a mode only on an
agent, a budget only with `runnable`. -/
private def publishRequests : List PublishRequest :=
  (WireEnum.all : List SubjectType).flatMap fun t =>
    (WireEnum.all : List Visibility).flatMap fun v =>
      (if t == .agent then [none, some Mode.definition, some Mode.runnable] else [none]).flatMap
        fun m => (if m == some .runnable then [none, some "5", some "12.5"] else [none]).map
          fun b => { subjectType := t, visibility := v, mode := m, budgetCapUsd := b }

/-- Expiry and passphrase variations on an admitted session share. -/
private def publishExtras : List PublishRequest :=
  [none, some Expiry.hours24, some .days7, some .days30, some .never].flatMap fun e =>
    [none, some "open sesame"].map fun p =>
      { subjectType := .session, visibility := .workspace, expiry := e, passphrase := p }

def publishVectors : List Vector :=
  (publishRequests ++ publishExtras).flatMap fun r => roles.flatMap fun role =>
    [false, true].flatMap fun (pse : Bool) => [false, true].map fun (re : Bool) =>
      { id := s!"publish/{r.subjectType.toWire}/{r.visibility.toWire}/mode={(r.mode.map Mode.toWire).getD "none"}/budget={r.budgetCapUsd.getD "none"}/expiry={(r.expiry.map Expiry.toWire).getD "none"}/passphrase={r.passphrase.isSome}/role={WireEnum.toWire role}/publicSharing={pse}/runnableGate={re}",
        input := Json.mkObj [("request", requestJson r), ("role", WireEnum.toWire role),
          ("publicSharingEnabled", toJson pse), ("runnableEnabled", toJson re),
          ("now", toJson now)],
        expected := outcomeJson (publishDecision r role pse re now),
        witnesses := publishWitnesses }

private def resolveWitnesses : List String :=
  [T1 "passphrase_gates_an_open_link", T1 "link_without_passphrase_opens_for_everyone",
    T2 "resolve_opens_iff", T2 "closed_link_is_unavailable_whatever_the_passphrase"]

/-- Every lifecycle share, with and without a passphrase, against each attempt. -/
def resolveVectors : List Vector :=
  lifecycleShares.flatMap fun (name, s) => [false, true].flatMap fun (hasPass : Bool) =>
    [PassphraseAttempt.absent, .wrong, .right].map fun a =>
      let s' := { s with passphraseHash := if hasPass then some "hash" else none }
      let o := s'.resolveAt now a
      { id := s!"resolve/{name}/passphrase={hasPass}/attempt={a.toWire}",
        input := Json.mkObj [("share", shareJson s'), ("now", toJson now),
          ("attempt", a.toWire)],
        expected := Json.mkObj [("opened", toJson (o == .opened)), ("code", optStr o.code?)],
        witnesses := resolveWitnesses }

private def viewer : PrincipalId := ⟨"00000000-0000-4000-8000-000000000009"⟩

/-- Every role, as the publisher or not, against a share of every visibility. -/
def listingVectors : List Vector :=
  roles.flatMap fun role => [false, true].flatMap fun (isPublisher : Bool) =>
    (WireEnum.all : List Visibility).map fun v =>
      let s := { base with visibility := v, publisher := if isPublisher then viewer else base.publisher }
      { id := s!"listing/{WireEnum.toWire role}/publisher={isPublisher}/{v.toWire}",
        input := Json.mkObj [("role", WireEnum.toWire role), ("viewer", viewer.val),
          ("share", shareJson s)],
        expected := Json.mkObj [("listed", toJson (listedFor role viewer s))],
        witnesses := [T1 "list_is_mine_or_all_for_admins",
          T5 "a_member_cannot_read_another's_workspace_share",
          T5 "private_and_workspace_shares_list_alike"] }

/-- The per-visitor limit a runnable share reserves with. -/
def visitorLimitVectors : List Vector :=
  [{ id := "visitor-limit/runnable-message",
     input := Json.mkObj [("now", toJson now)],
     expected := Json.mkObj [("limit", toJson visitorMessageLimit),
       ("windowMs", toJson visitorWindowMs)],
     witnesses := [T1 "five_messages_per_visitor_per_hour"] }]

def files : List (String × Json) :=
  [("vocabularies.json",
      file "concept-publication"
        "SHARE_SUBJECT_TYPES, SHARE_VISIBILITIES, SHARE_MODES, SHARE_EXPIRIES: every member in order, and near misses"
        vocabularies),
   ("tables.json",
      file "concept-publication"
        "The shares, share_views and share_run_charges tables: columns, keys with tenancy class, unique keys and checks"
        tableVectors),
   ("checks.json",
      file "concept-publication"
        "The five non-closed-set checks of the cluster: their SQL and their verdict on sample rows"
        checkVectors),
   ("shares.json",
      file "concept-publication"
        "Typed shares: row encoding, database and service invariants, derived state, public availability and the wire rendering"
        shareVectors),
   ("options.json",
      file "concept-publication"
        "POST /api/shares: which options fit which subject type (every combination)" optionVectors),
   ("fields.json",
      file "concept-publication"
        "POST /api/shares: subject id, passphrase length and budget bounds" fieldVectors),
   ("publish.json",
      file "concept-publication"
        "ShareService.publish: refusals (public sharing off, runnable unreleased, runnable by a Builder or Viewer) and what an admitted share is written with"
        publishVectors),
   ("resolve.json",
      file "concept-publication"
        "ShareService.resolve: every lifecycle share, with and without a passphrase, against a missing, wrong and right passphrase"
        resolveVectors),
   ("listing.json",
      file "concept-publication"
        "GET /api/shares: which shares each role lists, as publisher or not, for every visibility"
        listingVectors),
   ("visitor-limit.json",
      file "concept-publication"
        "RunnableShareService.message: the per-visitor limit and window it reserves with"
        visitorLimitVectors)]

end Vectors.ConceptPublication
