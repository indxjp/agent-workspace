import AgentWorkspace.Er.Core
import AgentWorkspace.Concepts.Membership

/-!
# The publication concept: shares, share views and share run charges

A **share** publishes one subject (an agent, a session, a project or a skill) of a workspace at a
visibility, as a server-held snapshot. It is the only mechanism that reaches outside a workspace
today (`docs/sdk/site/concepts/ownership-and-sharing.mdx`, "Beyond one workspace"). Two child
records hang off it:

* a **share view** (`share_views`) is one recorded opening of a public link, or one admitted
  visitor message of a runnable link (both are written to the same table);
* a **share run charge** (`share_run_charges`) attributes one run, launched by a visitor of a
  runnable link, to the share whose budget funds it. The run is the key, so a run is funded by at
  most one share.

This module states the concept as the database and the wire contract know it:

* the closed vocabularies (`SubjectType`, `Visibility`, `Mode`, `Expiry`) as `WireEnum`s, in the
  order of the TypeScript `as const` arrays of `packages/contracts/src/shares.ts`;
* the typed rows (`Share`, `ShareView`, `ShareRunCharge`) with every column that carries meaning,
  and their encoding as `Er.Core.Row`s (`toRow`), so the ER lemmas apply to them;
* the database invariants (`Share.dbValid`, …) and the documented invariants the publishing service
  maintains on top of them (`Share.wellPublished`);
* the derived lifecycle **states** (`ShareState`; the transitions are Phase 4's
  `Lifecycle/Share.lean`), and whether a public link opens at a given instant (`publiclyOpen`);
* the wire projection (`toShareResource`), which never carries the token except inside the public
  `url`, and who lists a share (`listedFor`, the `GET /api/shares` filter);
* the publish decision of `ShareService.publish` (`publishDecision`: public sharing off, the D-06
  runnable release gate, runnable by Owner or Admin only, and the defaults it writes), and the
  opening decision of `ShareService.resolve` with its passphrase gate (`Share.resolveAt`).

Time is an input: instants are milliseconds since the epoch (`Nat`). Money is a PostgreSQL
`numeric` rendered as a decimal string (`Decimal`).

**Choice.** The share vocabularies are defined here, in the concept layer, because the Phase 2
contracts module for `./shares` does not exist yet and `Contracts` may not import `Concepts`. The
synthesis step may move them into `Contracts/Shares.lean` and re-export them.
-/

namespace AgentWorkspace.Concepts.Share

open AgentWorkspace AgentWorkspace.Er.Core

/-! ## Vocabularies -/

/-- What a share publishes (`SHARE_SUBJECT_TYPES`, `shares.subject_type`). -/
@[aw_spec (ts := "packages/contracts/src/shares.ts#SHARE_SUBJECT_TYPES")
  (ts := "packages/core/src/db/schema/shares.ts#shareSubjectTypes")
  (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")]
inductive SubjectType where
  | agent
  | session
  | project
  | skill
  deriving DecidableEq, Repr, Inhabited

/-- The wire and database spelling of a subject type. -/
def SubjectType.toWire : SubjectType → String
  | .agent => "agent"
  | .session => "session"
  | .project => "project"
  | .skill => "skill"

instance : WireEnum SubjectType where
  all := [.agent, .session, .project, .skill]
  toWire := SubjectType.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- The table a subject lives in: the polymorphic target of `shares.subject_id`, which no foreign
key enforces. -/
@[aw_spec (ts := "apps/web/server/composition/wiring/projects.ts#subjectOwnership")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
def SubjectType.table : SubjectType → TableName
  | .agent => .agents
  | .session => .sessions
  | .project => .projects
  | .skill => .skills

/-- Who may open a share (`SHARE_VISIBILITIES`, `shares.visibility`). -/
@[aw_spec (ts := "packages/contracts/src/shares.ts#SHARE_VISIBILITIES")
  (ts := "packages/core/src/db/schema/shares.ts#shareVisibilities")
  (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")]
inductive Visibility where
  | «private»
  | workspace
  | «public»
  deriving DecidableEq, Repr, Inhabited

/-- The wire and database spelling of a visibility. -/
def Visibility.toWire : Visibility → String
  | .«private» => "private"
  | .workspace => "workspace"
  | .«public» => "public"

instance : WireEnum Visibility where
  all := [.«private», .workspace, .«public»]
  toWire := Visibility.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- How an agent share behaves for its visitor (`SHARE_MODES`, `shares.mode`). -/
@[aw_spec (ts := "packages/contracts/src/shares.ts#SHARE_MODES")
  (ts := "packages/core/src/db/schema/shares.ts#shareModes")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
inductive Mode where
  | definition
  | runnable
  deriving DecidableEq, Repr, Inhabited

/-- The wire and database spelling of a mode. -/
def Mode.toWire : Mode → String
  | .definition => "definition"
  | .runnable => "runnable"

instance : WireEnum Mode where
  all := [.definition, .runnable]
  toWire := Mode.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- How long a share stays open, counted from publication (`SHARE_EXPIRIES`). -/
@[aw_spec (ts := "packages/contracts/src/shares.ts#SHARE_EXPIRIES")
  (doc := "docs/spec.md#2062-publishing-a-session-run-history")]
inductive Expiry where
  | hours24
  | days7
  | days30
  | never
  deriving DecidableEq, Repr, Inhabited

/-- The wire spelling of an expiry. -/
def Expiry.toWire : Expiry → String
  | .hours24 => "24 h"
  | .days7 => "7 days"
  | .days30 => "30 days"
  | .never => "never"

instance : WireEnum Expiry where
  all := [.hours24, .days7, .days30, .never]
  toWire := Expiry.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- The lifetime of an expiry in milliseconds, `none` for `never` (`EXPIRY_MS`). -/
@[aw_spec (ts := "apps/web/server/shares/core/service.ts#EXPIRY_MS")]
def Expiry.durationMs? : Expiry → Option Nat
  | .hours24 => some 86400000
  | .days7 => some 604800000
  | .days30 => some 2592000000
  | .never => none

/-- `expires_at` of a share published at `createdAt` with expiry `e`. -/
def Expiry.expiresAt? (e : Expiry) (createdAt : Nat) : Option Nat :=
  e.durationMs?.map (createdAt + ·)

/-! ## Constants of the concept -/

/-- The longest passphrase `POST /api/shares` accepts, in string code units. -/
@[aw_spec (ts := "packages/contracts/src/shares.ts#SHARE_PASSPHRASE_MAX_LENGTH")]
def passphraseMaxLength : Nat := 1024

/-- Every share token starts with `pub_` (`ShareService.publish`). -/
@[aw_spec (ts := "apps/web/server/shares/core/service.ts#ShareService")]
def tokenPrefix : String := "pub_"

/-- The public link of a share is `/p/<token>` (`toShareResource`). -/
@[aw_spec (ts := "apps/web/server/shares/core/resource.ts#toShareResource")
  (ts := "packages/contracts/src/shares.ts#PUBLIC_URL_INVARIANT")]
def publicUrlPrefix : String := "/p/"

/-- The budget, in USD, a runnable share gets when the publisher names none. -/
@[aw_spec (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
def defaultRunnableBudgetUsd : String := "20"

/-- The number of messages one visitor may send a runnable share per window. -/
@[aw_spec (ts := "apps/web/server/shares/runnable/service.ts#RunnableShareService")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
def visitorMessageLimit : Nat := 5

/-- The rolling window of the per-visitor limit, in milliseconds (one hour). -/
@[aw_spec (ts := "apps/web/server/shares/runnable/service.ts#RunnableShareService")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
def visitorWindowMs : Nat := 3600000

/-! ## Decimal amounts

`budget_cap_usd numeric(12, 4)`, `spent_usd numeric(14, 6)` and `charged_usd numeric(14, 6)` reach
the application as decimal strings (`budgetCapUsd`, `spentUsd` on the wire). The model reads such a
string exactly: an optional sign, integer digits, and optional fraction digits. -/

/-- A decimal literal: its sign, its integer digits and its fraction digits. -/
structure Decimal where
  negative : Bool
  intDigits : List Char
  fracDigits : List Char
  deriving DecidableEq, Repr, Inhabited

/-- A character `0`–`9`. -/
def isDigit (c : Char) : Bool := '0' ≤ c && c ≤ '9'

/-- Parse a decimal literal: `-`? digits+ (`.` digits+)?. Anything else (empty, a `+`, spaces,
exponents, a bare `.`) is `none`. -/
@[aw_spec (ts := "packages/core/src/db/schema/shares.ts#shares")]
def Decimal.parse? (s : String) : Option Decimal :=
  let (neg, rest) := match s.toList with
    | '-' :: cs => (true, cs)
    | cs => (false, cs)
  let intPart := rest.takeWhile isDigit
  let tail := rest.drop intPart.length
  if intPart.isEmpty then none
  else match tail with
    | [] => some ⟨neg, intPart, []⟩
    | '.' :: frac =>
      if !frac.isEmpty && frac.all isDigit then some ⟨neg, intPart, frac⟩ else none
    | _ => none

/-- The value is zero: every digit is `0`. -/
def Decimal.isZero (d : Decimal) : Bool := d.intDigits.all (· == '0') && d.fracDigits.all (· == '0')

/-- The value is `≥ 0` (SQL `x >= 0`): it has no sign, or it is a signed zero. -/
def Decimal.isNonNegative (d : Decimal) : Bool := !d.negative || d.isZero

/-- The value is `> 0`. -/
def Decimal.isPositive (d : Decimal) : Bool := !d.negative && !d.isZero

/-- The value fits `numeric(p, s)`: at most `s` fraction digits and at most `p - s` significant
integer digits. (PostgreSQL rounds extra fraction digits instead of refusing them; the model keeps
the stricter reading, which every value the application writes satisfies.) -/
def Decimal.fits (p s : Nat) (d : Decimal) : Bool :=
  d.fracDigits.length ≤ s && (d.intDigits.dropWhile (· == '0')).length ≤ p - s

/-- The natural number a digit list denotes. -/
def digitsValue (ds : List Char) : Nat :=
  ds.foldl (fun n c => 10 * n + (c.toNat - '0'.toNat)) 0

/-- The value in millionths (the six-decimal ledger scale), when it has at most six fraction
digits. -/
def Decimal.toMicros? (d : Decimal) : Option Int :=
  if d.fracDigits.length ≤ 6 then
    let m : Nat := digitsValue d.intDigits * 1000000 +
      digitsValue (d.fracDigits ++ List.replicate (6 - d.fracDigits.length) '0')
    some (if d.negative then -(m : Int) else m)
  else none

/-- A decimal string is a non-negative amount (`… >= 0`). A string that is not a decimal is not. -/
def nonNegativeAmount (s : String) : Bool := (Decimal.parse? s).any Decimal.isNonNegative

/-! ## Typed rows -/

/-- What a session share reveals beyond the conversation (`ShareIncludeSchema`). -/
@[aw_spec (ts := "packages/contracts/src/shares.ts#ShareIncludeSchema")
  (doc := "docs/spec.md#2062-publishing-a-session-run-history")]
structure Include where
  technicalDetails : Option Bool := none
  outputFiles : Option Bool := none
  deriving DecidableEq, Repr, Inhabited

/-- Nothing was opted into (the `{}` the server stores when no `include` was sent). -/
def Include.isEmpty (i : Include) : Bool := i.technicalDetails.isNone && i.outputFiles.isNone

/-- The JSON text of an `include` object, keys in schema order. -/
def Include.toJsonText (i : Include) : String :=
  let entries := [("technicalDetails", i.technicalDetails), ("outputFiles", i.outputFiles)].filterMap
    fun (k, v) => v.map fun b => s!"\"{k}\":{if b then "true" else "false"}"
  "{" ++ ",".intercalate entries ++ "}"

/-- One row of `shares`, typed. `snapshot` is the stored JSON document as text; instants are
milliseconds since the epoch; amounts are decimal strings. -/
@[aw_spec (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "packages/core/src/db/repositories/shares.ts#ShareRecord")
  (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")]
structure Share where
  id : ShareId
  workspace : WorkspaceId
  /-- The secret link token, globally unique (`shares_token_key`). -/
  token : String
  subjectType : SubjectType
  /-- The subject's id as text: no foreign key; the table is `subjectType.table`. -/
  subjectId : String
  /-- A display label, client-authored today (RF-103). -/
  subjectLabel : String
  visibility : Visibility
  mode : Option Mode
  snapshot : Option String
  «include» : Include
  budgetCapUsd : Option String
  spentUsd : String
  /-- The link no longer accepts messages: the kill switch was used or the budget ran out. -/
  stopped : Bool
  expiresAt : Option Nat
  passphraseHash : Option String
  /-- Legacy human attribution: the publishing user, `null` for an API-key principal. -/
  createdBy : Option UserId
  /-- The principal that published the share: the share's owner for authorisation. -/
  publisher : PrincipalId
  revokedAt : Option Nat
  suspendedAt : Option Nat
  createdAt : Nat
  deriving DecidableEq, Repr, Inhabited

/-- One row of `share_views`: an opening of a public link, or an admitted visitor message. -/
@[aw_spec (ts := "packages/core/src/db/schema/share-views.ts#shareViews")
  (ts := "packages/core/src/db/repositories/shares.ts#ShareViewRepository")]
structure ShareView where
  id : ShareViewId
  workspace : WorkspaceId
  share : ShareId
  /-- The opaque visitor key (a versioned HMAC of the client address), when one was resolved. -/
  visitorKey : Option String
  createdAt : Nat
  deriving DecidableEq, Repr, Inhabited

/-- One row of `share_run_charges`: the share whose budget funds one run. Keyed by the run. -/
@[aw_spec (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")
  (ts := "packages/core/src/db/repositories/shares.ts#linkRun")]
structure ShareRunCharge where
  run : RunId
  workspace : WorkspaceId
  share : ShareId
  chargedUsd : String
  createdAt : Nat
  updatedAt : Nat
  deriving DecidableEq, Repr, Inhabited

/-! ## Encoding typed rows as `Er.Core` rows -/

/-- A row from `(column, value?)` pairs: a `none` value is SQL `NULL`, so the column is absent. -/
def rowOf (cells : List (String × Option String)) : Row :=
  ⟨cells.filterMap fun (c, v) => v.map (c, ·)⟩

/-- An instant as the row stores it. -/
def instant (n : Nat) : String := toString n

/-- The column cells of a share, in `shares` column order. -/
def Share.cells (s : Share) : List (String × Option String) :=
  [("id", some s.id.val), ("workspace_id", some s.workspace.val), ("token", some s.token),
    ("subject_type", some s.subjectType.toWire), ("subject_id", some s.subjectId),
    ("subject_label", some s.subjectLabel), ("visibility", some s.visibility.toWire),
    ("mode", s.mode.map Mode.toWire), ("snapshot", s.snapshot),
    ("include", some s.«include».toJsonText), ("budget_cap_usd", s.budgetCapUsd),
    ("spent_usd", some s.spentUsd), ("stopped", some (if s.stopped then "true" else "false")),
    ("expires_at", s.expiresAt.map instant), ("passphrase_hash", s.passphraseHash),
    ("created_by", s.createdBy.map (·.val)), ("publisher_principal_id", some s.publisher.val),
    ("revoked_at", s.revokedAt.map instant), ("suspended_at", s.suspendedAt.map instant),
    ("created_at", some (instant s.createdAt))]

/-- The share as a `shares` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/shares.ts#shares")]
def Share.toRow (s : Share) : Row := rowOf s.cells

/-- The column cells of a share view, in `share_views` column order. -/
def ShareView.cells (v : ShareView) : List (String × Option String) :=
  [("id", some v.id.val), ("workspace_id", some v.workspace.val), ("share_id", some v.share.val),
    ("visitor_key", v.visitorKey), ("created_at", some (instant v.createdAt))]

/-- The view as a `share_views` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/share-views.ts#shareViews")]
def ShareView.toRow (v : ShareView) : Row := rowOf v.cells

/-- The column cells of a run charge, in `share_run_charges` column order. -/
def ShareRunCharge.cells (c : ShareRunCharge) : List (String × Option String) :=
  [("run_id", some c.run.val), ("workspace_id", some c.workspace.val),
    ("share_id", some c.share.val), ("charged_usd", some c.chargedUsd),
    ("created_at", some (instant c.createdAt)), ("updated_at", some (instant c.updatedAt))]

/-- The charge as a `share_run_charges` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")]
def ShareRunCharge.toRow (c : ShareRunCharge) : Row := rowOf c.cells

/-! ## Invariants the database enforces -/

/-- `shares_agent_mode_only`: only an agent share has a mode. -/
@[aw_spec (ts := "packages/core/src/db/schema/shares.ts#shares")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
def Share.modeOnlyForAgent (s : Share) : Bool := s.mode.isNone || s.subjectType == .agent

/-- `shares_budget_nonnegative`: the budget cap is absent or `≥ 0`. -/
def Share.budgetNonNegative (s : Share) : Bool := s.budgetCapUsd.all nonNegativeAmount

/-- `shares_spend_nonnegative`: the spend is `≥ 0`. -/
def Share.spendNonNegative (s : Share) : Bool := nonNegativeAmount s.spentUsd

/-- `shares_subject_id_not_blank`: `length(btrim(subject_id)) > 0`. PostgreSQL's one-argument
`btrim` removes spaces only, so a tab or a newline is not blank to the database. -/
def notBlankSql (s : String) : Bool := s.toList.any (· != ' ')

/-- The four non-closed-set checks of `shares`, on the typed row. -/
@[aw_spec (ts := "packages/core/src/db/schema/shares.ts#shares")]
def Share.dbValid (s : Share) : Bool :=
  s.modeOnlyForAgent && s.budgetNonNegative && s.spendNonNegative && notBlankSql s.subjectId

/-- `share_run_charges_nonnegative`: the accumulated charge is `≥ 0`. -/
@[aw_spec (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")]
def ShareRunCharge.dbValid (c : ShareRunCharge) : Bool := nonNegativeAmount c.chargedUsd

/-! ## Invariants the publishing service maintains

The database admits more than the service ever writes. `ShareService.publish` gives every agent
share a mode (`definition` by default), gives a budget to a runnable share only (defaulting to
`20`), and the request schema lets `include` through for a session share only. -/

/-- A share as `ShareService.publish` writes it: the database checks hold; the share has a mode
exactly when its subject is an agent; it has a budget exactly when it is runnable; a non-session
share includes nothing; the token has the `pub_` prefix; and it starts unstopped, unrevoked,
unsuspended and with nothing spent. -/
@[aw_spec (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (ts := "apps/web/server/shares/core/input.ts#PublishShareRequestSchema")
  (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")]
def Share.wellPublished (s : Share) : Bool :=
  s.dbValid && (s.mode.isSome == (s.subjectType == .agent)) &&
    (s.budgetCapUsd.isSome == (s.mode == some .runnable)) &&
    (s.subjectType == .session || s.«include».isEmpty) &&
    tokenPrefix.toList.isPrefixOf s.token.toList

/-! ## Which publish options a subject takes

`POST /api/shares` refuses a command whose options do not fit its subject (`400 invalid_share`):
a mode, an agent definition and a budget belong to an agent share, a budget further needs the
`runnable` mode, and a transcript and an `include` belong to a session share. -/

/-- The publish options fit the subject type: `mode`, `definition` and `budgetCapUsd` only on an
agent share, `budgetCapUsd` only with `mode: 'runnable'`, `transcript` and `include` only on a
session share (`PublishShareRequestSchema`'s refinement). -/
@[aw_spec (ts := "apps/web/server/shares/core/input.ts#PublishShareRequestSchema")
  (ts := "packages/contracts/src/shares.ts#PublishShareCommand")
  (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")]
def optionsFit (t : SubjectType) (mode : Option Mode)
    (hasInclude hasBudget hasTranscript hasDefinition : Bool) : Bool :=
  (t == .agent || (mode.isNone && !hasDefinition && !hasBudget)) &&
    (t != .agent || !hasBudget || mode == some .runnable) &&
    (t == .session || (!hasTranscript && !hasInclude))

/-- A subject id the request accepts: any non-empty string (`z.string().min(1)`). -/
@[aw_spec (ts := "apps/web/server/shares/core/input.ts#PublishShareRequestSchema")]
def subjectIdAccepted (s : String) : Bool := !s.isEmpty

/-- A passphrase length the request accepts: 1 to `SHARE_PASSPHRASE_MAX_LENGTH` code units. -/
@[aw_spec (ts := "apps/web/server/shares/core/input.ts#PublishShareRequestSchema")
  (ts := "packages/contracts/src/shares.ts#SHARE_PASSPHRASE_MAX_LENGTH")]
def passphraseAccepted (length : Nat) : Bool := 1 ≤ length && length ≤ passphraseMaxLength

/-- A budget the request accepts: a positive number (`z.number().positive().finite()`), here read
from its decimal spelling. -/
@[aw_spec (ts := "apps/web/server/shares/core/input.ts#PublishShareRequestSchema")
  (ts := "packages/contracts/src/shares.ts#PublishShareCommand")]
def budgetAccepted (s : String) : Bool := (Decimal.parse? s).any Decimal.isPositive

/-! ## Lifecycle states (derived; the transitions are Phase 4)

A share has no status column. Its state is derived from `revoked_at`, `suspended_at`, `stopped`
and `expires_at`, in that order of precedence (inventory §2 lists the same five). -/

/-- The derived lifecycle state of a share. -/
@[aw_spec (ts := "packages/core/src/db/repositories/shares.ts#ShareRepository")
  (doc := "docs/formal/inventory.md#2-state-machines")]
inductive ShareState where
  /-- Open: nothing below applies. -/
  | live
  /-- `revoked_at` is set: permanent (`DELETE /api/shares/:id`). -/
  | revoked
  /-- `suspended_at` is set: the workspace turned public sharing off. -/
  | suspended
  /-- `stopped`: the kill switch or the budget guard. -/
  | stopped
  /-- `expires_at` has passed. -/
  | expired
  deriving DecidableEq, Repr, Inhabited

/-- The wire spelling of a state, for vectors. -/
def ShareState.toWire : ShareState → String
  | .live => "live"
  | .revoked => "revoked"
  | .suspended => "suspended"
  | .stopped => "stopped"
  | .expired => "expired"

instance : WireEnum ShareState where
  all := [.live, .revoked, .suspended, .stopped, .expired]
  toWire := ShareState.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- The link has expired at `now`: `expires_at <= now` (`ShareService.resolve`). -/
def Share.expiredAt (s : Share) (now : Nat) : Bool := s.expiresAt.any (· ≤ now)

/-- The state of a share at instant `now`. -/
@[aw_spec (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (doc := "docs/formal/inventory.md#2-state-machines")]
def Share.stateAt (s : Share) (now : Nat) : ShareState :=
  if s.revokedAt.isSome then .revoked
  else if s.suspendedAt.isSome then .suspended
  else if s.stopped then .stopped
  else if s.expiredAt now then .expired
  else .live

/-- A public link opens at `now` (before any passphrase): the share is public and live. This is
the availability test of `ShareService.resolve` and of the unscoped token lookup
`findShareWorkspace`, which only finds public shares. -/
@[aw_spec (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (ts := "packages/core/src/db/repositories/root.ts#findShareWorkspace")
  (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")]
def Share.publiclyOpen (s : Share) (now : Nat) : Bool :=
  s.visibility == .«public» && s.stateAt now == .live

/-- Opening the link asks for a passphrase exactly when one was set. -/
def Share.passphraseRequired (s : Share) : Bool := s.passphraseHash.isSome

/-- The budget of a runnable share is exhausted: `spent_usd >= budget_cap_usd`. A share without a
budget is never exhausted (and never runnable). -/
@[aw_spec (ts := "packages/core/src/db/repositories/shares.ts#reserveVisitorMessage")]
def Share.budgetExhausted (s : Share) : Bool :=
  match s.budgetCapUsd.bind Decimal.parse? |>.bind Decimal.toMicros?,
      (Decimal.parse? s.spentUsd).bind Decimal.toMicros? with
  | some cap, some spent => decide (cap ≤ spent)
  | _, _ => false

/-! ## The wire projection -/

/-- The keys `toShareResource` renders, in its order, for a share with this visibility, with or
without a view count. -/
@[aw_spec (ts := "apps/web/server/shares/core/resource.ts#toShareResource")
  (ts := "packages/contracts/src/shares.ts#ShareResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")]
def resourceKeys (v : Visibility) (withViewCount : Bool) : List String :=
  ["id", "subjectType", "subjectId", "subjectLabel", "visibility", "mode", "snapshot", "include",
    "budgetCapUsd", "spentUsd", "stopped", "expiresAt", "revokedAt", "suspendedAt", "createdAt"] ++
    (if withViewCount then ["viewCount"] else []) ++
    (if v == .«public» then ["url"] else [])

/-- The persistence-only columns that must never cross the wire as fields. -/
@[aw_spec (ts := "apps/web/server/shares/core/resource.ts#toShareResource")
  (ts := "packages/contracts/src/shares.ts#ShareResourceSchema")]
def persistenceOnlyKeys : List String :=
  ["token", "passphraseHash", "workspaceId", "createdBy", "publisherPrincipalId"]

/-- The public URL a share carries on the wire: `/p/<token>` for a public share, absent otherwise. -/
@[aw_spec (ts := "apps/web/server/shares/core/resource.ts#toShareResource")
  (ts := "packages/contracts/src/shares.ts#PUBLIC_URL_INVARIANT")
  (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")]
def Share.url? (s : Share) : Option String :=
  if s.visibility == .«public» then some (publicUrlPrefix ++ s.token) else none

/-- Who sees a share in `GET /api/shares` today: an Owner or Admin sees every share of the
workspace, anyone else only the shares it published (`share.publisherPrincipalId ===
actor.principalId`). -/
@[aw_spec (ts := "apps/web/app/api/shares/route.ts#GET")
  (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")]
def listedFor (role : Membership.Role) (viewer : PrincipalId) (s : Share) : Bool :=
  role == .owner || role == .admin || decide (s.publisher = viewer)

/-! ## Publishing: what `ShareService.publish` admits and writes

`ShareService.publish` receives a request the schema already accepted (`optionsFit` above) and
decides, in this order: a `public` share is refused while the workspace's public sharing is off;
an agent share's mode defaults to `definition`; a `runnable` share is refused while the release
gate (`runnablePublicLinksEnabled()`, constant `false` under D-06) is closed; and a `runnable`
share needs an Owner or Admin. Every refusal is `400 invalid_share`. An admitted request is
written with its mode, a budget only when runnable (default `$20`), `expires_at` counted from
`now`, a hash only when a passphrase was given, and a fresh `pub_` token. -/

/-- The part of a publish request the service's decision reads. -/
@[aw_spec (ts := "apps/web/server/shares/core/input.ts#PublishShareInput")]
structure PublishRequest where
  subjectType : SubjectType
  visibility : Visibility
  mode : Option Mode := none
  /-- The requested budget, as the decimal spelling of the JSON number. -/
  budgetCapUsd : Option String := none
  expiry : Option Expiry := none
  passphrase : Option String := none
  deriving DecidableEq, Repr, Inhabited

/-- Why `ShareService.publish` refuses an otherwise valid request. -/
@[aw_spec (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (ts := "packages/contracts/src/shares.ts#SHARES_PROBLEM_CODES")
  (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")]
inductive PublishRefusal where
  /-- A `public` share while the workspace's public sharing is off. -/
  | publicSharingOff
  /-- A `runnable` share while the D-06 release gate is closed. -/
  | runnableUnreleased
  /-- A `runnable` share by a Builder or Viewer. -/
  | runnableNeedsOwnerOrAdmin
  deriving DecidableEq, Repr, Inhabited

/-- The problem code of every publish refusal (`SHARES_PROBLEM_CODES.invalid_share`, 400). -/
def PublishRefusal.code (_ : PublishRefusal) : String := "invalid_share"

/-- The public message of each refusal, as `ShareService.publish` words it. -/
@[aw_spec (ts := "apps/web/server/shares/core/service.ts#ShareService")]
def PublishRefusal.message : PublishRefusal → String
  | .publicSharingOff => "Public sharing is disabled for this workspace."
  | .runnableUnreleased => "Runnable public links are not available in this release (D-06)."
  | .runnableNeedsOwnerOrAdmin => "Runnable links require Admin or Owner."

/-- What an admitted publish writes, beyond what the request carries verbatim. -/
structure Published where
  mode : Option Mode
  budgetCapUsd : Option String
  expiresAt : Option Nat
  hasPassphraseHash : Bool
  deriving DecidableEq, Repr, Inhabited

/-- The outcome of `ShareService.publish`. -/
inductive PublishOutcome where
  | published (p : Published)
  | refused (r : PublishRefusal)
  deriving DecidableEq, Repr, Inhabited

/-- The mode an admitted share gets: an agent's requested mode, `definition` by default; none for
any other subject (a mode on another subject is dropped). -/
def PublishRequest.effectiveMode (r : PublishRequest) : Option Mode :=
  if r.subjectType == .agent then some (r.mode.getD .definition) else none

/-- An Owner or an Admin. -/
def ownerOrAdmin (role : Membership.Role) : Bool := role == .owner || role == .admin

/-- `ShareService.publish` for a request the schema accepted, by a caller of `role`, with the
workspace's public-sharing policy, the runnable release gate, at instant `now`. -/
@[aw_spec (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (ts := "apps/web/server/shares/runnable/feature.ts#runnablePublicLinksEnabled")
  (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")]
def publishDecision (r : PublishRequest) (role : Membership.Role)
    (publicSharingEnabled runnableEnabled : Bool) (now : Nat) : PublishOutcome :=
  if r.visibility == .«public» && !publicSharingEnabled then .refused .publicSharingOff
  else if r.effectiveMode == some .runnable && !runnableEnabled then .refused .runnableUnreleased
  else if r.effectiveMode == some .runnable && !ownerOrAdmin role then
    .refused .runnableNeedsOwnerOrAdmin
  else .published
    { mode := r.effectiveMode
      budgetCapUsd :=
        if r.effectiveMode == some .runnable then some (r.budgetCapUsd.getD defaultRunnableBudgetUsd)
        else none
      expiresAt := (r.expiry.getD .never).expiresAt? now
      hasPassphraseHash := r.passphrase.any (!·.isEmpty) }

/-- The release gate of runnable links today: closed (D-06). -/
@[aw_spec (ts := "apps/web/server/shares/runnable/feature.ts#runnablePublicLinksEnabled")
  (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")]
def runnableReleased : Bool := false

/-! ## Opening a public link: `ShareService.resolve` -/

/-- What a visitor presents for a passphrase. -/
inductive PassphraseAttempt where
  | absent
  | wrong
  | right
  deriving DecidableEq, Repr, Inhabited

/-- The spelling of an attempt, for vectors. -/
def PassphraseAttempt.toWire : PassphraseAttempt → String
  | .absent => "absent"
  | .wrong => "wrong"
  | .right => "right"

/-- The outcome of opening a link. -/
inductive ResolveOutcome where
  | opened
  /-- `404 share_unavailable`: not public, revoked, suspended, stopped or expired. -/
  | unavailable
  /-- `403 invalid_passphrase`: the link is open but the passphrase is missing or wrong. -/
  | invalidPassphrase
  deriving DecidableEq, Repr, Inhabited

/-- The problem code of an outcome, `none` when the link opened. -/
def ResolveOutcome.code? : ResolveOutcome → Option String
  | .opened => none
  | .unavailable => some "share_unavailable"
  | .invalidPassphrase => some "invalid_passphrase"

/-- `ShareService.resolve` at instant `now`: a closed link is unavailable whatever the passphrase;
an open link with a passphrase opens only for the right one; an open link without one opens. -/
@[aw_spec (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (doc := "docs/spec.md#2062-publishing-a-session-run-history")]
def Share.resolveAt (s : Share) (now : Nat) (a : PassphraseAttempt) : ResolveOutcome :=
  if !s.publiclyOpen now then .unavailable
  else if s.passphraseRequired && a != .right then .invalidPassphrase
  else .opened

end AgentWorkspace.Concepts.Share
