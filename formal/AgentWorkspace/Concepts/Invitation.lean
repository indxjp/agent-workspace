import AgentWorkspace.Concepts.Membership

/-!
# The invitation concept

An **invitation** is an offer of one role in one workspace to one email address, redeemed with a
single-use, expiring secret (`packages/core/src/db/schema/invitations.ts`). Accepting it creates a
membership (`docs/sdk/04-api-specification.md` §2: `Invitation(email, Role, token shown once) ─▶
Membership`). The row stores only `token_hash`; the wire resource (`InvitationResourceSchema`) has
no token and no hash.

**Who invited.** `invited_by` is a `users.id` (not a membership, not a principal), nullable, and
`SET NULL` when that user is deleted: attribution outlives the inviter.

**States.** Four, derived from timestamps with a fixed precedence — revoked, then accepted, then
expired (`expires_at ≤ now`), then pending (`invitationStateOf`). The database's partial unique
index has a different, time-free notion of *pending*: neither accepted nor revoked, so an expired
but unresolved invitation still blocks a second one to the same address.
-/

namespace AgentWorkspace.Concepts.Invitation

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Workspace
  AgentWorkspace.Concepts.Membership AgentWorkspace.Concepts.User

/-- `INVITATION_TOKEN_MAX_LENGTH`. -/
@[aw_spec (ts := "packages/contracts/src/invitations.ts#INVITATION_TOKEN_MAX_LENGTH")]
def tokenMaxLength : Nat := 4096

/-- An invitation, with every column of `invitations`. -/
@[aw_spec (ts := "packages/core/src/db/schema/invitations.ts#invitations")
  (ts := "packages/contracts/src/invitations.ts#InvitationResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
structure Invitation where
  id : InvitationId
  workspace : WorkspaceId
  email : String
  role : Role
  invitedBy : Option UserId
  tokenHash : String
  expiresAt : Instant
  acceptedAt : Option Instant
  revokedAt : Option Instant
  createdAt : Instant
  updatedAt : Instant
  deriving DecidableEq, Repr

/-- The checks of `invitations` as a predicate on the concept. -/
@[aw_spec (ts := "packages/core/src/db/schema/invitations.ts#invitations")]
def Invitation.valid (i : Invitation) : Bool :=
  lowercase i.email && emailShape i.email && notBlank i.tokenHash && i.createdAt < i.expiresAt &&
    i.acceptedAt.all (i.createdAt ≤ ·) && i.revokedAt.all (i.createdAt ≤ ·) &&
    (i.acceptedAt.isNone || i.revokedAt.isNone)

/-- The four states a client shows, in the order the contract lists them. -/
@[aw_spec (ts := "apps/web/components/team/invitations-model.ts#InvitationState")
  (ts := "packages/contracts/src/invitations.ts#InvitationResourceSchema")
  (doc := "docs/formal/inventory.md#2-state-machines")]
inductive InvitationState where
  | pending
  | expired
  | accepted
  | revoked
  deriving DecidableEq, Repr, Inhabited

/-- The spelling of a state. -/
def InvitationState.toWire : InvitationState → String
  | .pending => "pending"
  | .expired => "expired"
  | .accepted => "accepted"
  | .revoked => "revoked"

instance : WireEnum InvitationState where
  all := [.pending, .expired, .accepted, .revoked]
  toWire := InvitationState.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- `invitationStateOf`: revoked, then accepted, then expired (`expiresAt ≤ now`), then pending. -/
@[aw_spec (ts := "apps/web/components/team/invitations-model.ts#invitationStateOf")]
def Invitation.stateAt (i : Invitation) (now : Instant) : InvitationState :=
  if i.revokedAt.isSome then .revoked
  else if i.acceptedAt.isSome then .accepted
  else if i.expiresAt ≤ now then .expired
  else .pending

/-- The partial unique index's notion of pending: neither accepted nor revoked, whatever the
clock says (`WHERE accepted_at IS NULL AND revoked_at IS NULL`). -/
@[aw_spec (ts := "packages/core/src/db/schema/invitations.ts#invitations_workspace_email_pending_key")]
def Invitation.unresolved (i : Invitation) : Bool := i.acceptedAt.isNone && i.revokedAt.isNone

/-- The `invitations` row of an invitation. -/
def Invitation.toRow (i : Invitation) : Row :=
  ⟨[("id", i.id.val), ("workspace_id", i.workspace.val), ("email", i.email),
     ("role", WireEnum.toWire i.role)] ++
    cell? "invited_by" (i.invitedBy.map (·.val)) ++
    [("token_hash", i.tokenHash), ("expires_at", instantText i.expiresAt)] ++
    cell? "accepted_at" (i.acceptedAt.map instantText) ++
    cell? "revoked_at" (i.revokedAt.map instantText) ++
    [("created_at", instantText i.createdAt), ("updated_at", instantText i.updatedAt)]⟩

/-- The fields of `InvitationResourceSchema`, in declaration order: no token, no hash. -/
@[aw_spec (ts := "packages/contracts/src/invitations.ts#InvitationResourceSchema")]
def resourceFields : List String :=
  ["id", "email", "role", "invitedBy", "expiresAt", "acceptedAt", "revokedAt", "createdAt"]

/-- The credential material of an invitation: the plaintext token (and the link that embeds it),
which only the issue and resend responses carry, and the stored hash. -/
@[aw_spec (ts := "packages/contracts/src/invitations.ts#IssuedInvitationResponseSchema")]
def credentialFields : List String := ["token", "tokenHash", "link"]

end AgentWorkspace.Concepts.Invitation
