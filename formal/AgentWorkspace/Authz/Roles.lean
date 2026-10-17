import AgentWorkspace.Concepts.Membership

/-!
# The four roles, as `decide()` reads them

The role vocabulary is the concept layer's `Concepts.Membership.Role` (spec §21's four, in
`ROLES` order) and `parseRole` (an exact-spelling decoder). This module does not redefine either;
it names what `apps/web/server/rbac/roles.ts` adds for the decision function:

- `decide()` receives the role as an untyped runtime value and **re-parses** it, so the model's
  query carries the role as the raw string (`RoleInput`), never as an already-trusted `Role`.
- An unrecognised role is **refused**, never downgraded to the least-privileged role
  (`requireRole`'s message: "An unrecognised role is refused, never downgraded").
- The `ROLES` order is presentation order, **not** a privilege order; `Meta.AuthzDecide` states
  where the grant table fails to be monotone in it.
-/

namespace AgentWorkspace.Authz.Roles

open AgentWorkspace AgentWorkspace.Concepts.Membership

/-- The role as it reaches `decide()`: whatever string the membership row or API-key row
carried, before any parse. -/
abbrev RoleInput := String

/-- `ROLES`, in the order `roles.ts` lists them. -/
@[aw_spec (ts := "apps/web/server/rbac/roles.ts#ROLES")]
def roles : List Role := WireEnum.all

/-- `parseRole` at `decide()`'s first step: the role, or `none` (then `decide()` refuses). -/
@[aw_spec (ts := "apps/web/server/rbac/roles.ts#parseRole")]
def parseRoleInput (s : RoleInput) : Option Role := parseRole s

end AgentWorkspace.Authz.Roles
