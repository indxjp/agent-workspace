import AgentWorkspace.Concepts.User

/-!
# The membership concept and the five roles

A **membership** binds one user to one workspace and gives them exactly one role there
(`packages/core/src/db/schema/memberships.ts`: "A person holds at most one role per workspace").
It is the human half of a principal: a membership principal *is* a membership acting in its
workspace. A membership carries the role; the user carries none.

**Roles.** Spec §21's four, in its order of presentation, then the Agent Store's `guest` — the
presentation order is **not** a privilege order (`apps/web/server/rbac/core/roles.ts`). The same
five values are `MEMBERSHIP_ROLES` on the wire, `ROLES` in the server and the `role` check of
`memberships`. `guest` is **not conferrable**: no route hands it out (it is written only by the
email-link sign-in, into the demo workspace made for that visitor), so `api_keys` and `invitations`
stay on the four (`CONFERRABLE_ROLES`, `conferrableRoles` in the schema). `Role` is defined here because the concept layer is the first to need
it; the contracts unit of Phase 2 mirrors the same wire enumeration.
-/

namespace AgentWorkspace.Concepts.Membership

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Workspace

/-- Spec §21's four roles then `guest`, in `MEMBERSHIP_ROLES` order. -/
@[aw_spec (ts := "packages/contracts/src/team.ts#MEMBERSHIP_ROLES")
  (ts := "packages/core/src/db/schema/memberships.ts#membershipRoles")
  (ts := "apps/web/server/rbac/core/roles.ts#ROLES")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#membership-roles")]
inductive Role where
  | owner
  | admin
  | builder
  | viewer
  | guest
  deriving DecidableEq, Repr, Inhabited

/-- The wire spelling of a role. -/
def Role.toWire : Role → String
  | .owner => "owner"
  | .admin => "admin"
  | .builder => "builder"
  | .viewer => "viewer"
  | .guest => "guest"

instance : WireEnum Role where
  all := [.owner, .admin, .builder, .viewer, .guest]
  toWire := Role.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- `isConferrable`: whether some caller may ever hand the role out through the API. Every role
but `guest`; `conferral.ts` refuses `guest` whoever asks. -/
@[aw_spec (ts := "apps/web/server/rbac/core/roles.ts#isConferrable")
  (ts := "packages/contracts/src/team.ts#CONFERRABLE_ROLES")]
def Role.isConferrable : Role → Bool
  | .guest => false
  | _ => true

/-- `CONFERRABLE_ROLES`: the four wire spellings `api_keys` and `invitations` check against. -/
def conferrableWires : List String :=
  (WireEnum.all : List Role).filter Role.isConferrable |>.map WireEnum.toWire

/-- `parseRole`: a role, or `none` for anything that is not exactly one of the five spellings
(no default, no case folding). -/
@[aw_spec (ts := "apps/web/server/rbac/core/roles.ts#parseRole")]
def parseRole (s : String) : Option Role := WireEnum.ofWire? s

/-- A membership: one user in one workspace, with one role. -/
@[aw_spec (ts := "packages/core/src/db/schema/memberships.ts#memberships")
  (ts := "packages/contracts/src/team.ts#MembershipResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
structure Membership where
  id : MembershipId
  workspace : WorkspaceId
  user : UserId
  role : Role
  createdAt : Instant
  updatedAt : Instant
  deriving DecidableEq, Repr

/-- The `memberships` row of a membership. -/
def Membership.toRow (m : Membership) : Row :=
  ⟨[("id", m.id.val), ("workspace_id", m.workspace.val), ("user_id", m.user.val),
    ("role", WireEnum.toWire m.role), ("created_at", instantText m.createdAt),
    ("updated_at", instantText m.updatedAt)]⟩

/-- Read a `memberships` row back; `none` when a column is missing or the role is not one of the
five. -/
def Membership.ofRow? (r : Row) : Option Membership := do
  let id ← r.get "id"
  let ws ← r.get "workspace_id"
  let user ← r.get "user_id"
  let role ← (r.get "role").bind parseRole
  let created ← instantOf? (r.get "created_at")
  let updated ← instantOf? (r.get "updated_at")
  pure ⟨⟨id⟩, ⟨ws⟩, ⟨user⟩, role, created, updated⟩

end AgentWorkspace.Concepts.Membership
