import AgentWorkspace.Authz.Roles
import AgentWorkspace.Authz.Resources

/-!
# The permission table (`POLICY`)

`apps/web/server/rbac/permissions.ts`: a permission is `(role, resource, operation) → grant`, a
grant is one of four widths (`none`, `own`, `permitted`, `any`), and each role is declared as a
fallback plus an override per named resource. Owner's fallback is `EVERYTHING` (with a
`workspaces` override); every other role's fallback is `NOTHING`.

The model transcribes `POLICY` **literally**, as the same fallback-plus-override shape with the
same named constants, so each of the 4 × 32 × 3 = 384 cells is computed the way `grantsFor`
computes it. The per-cell theorems (`Theorems.Normative.AuthzDecide`) pin every cell against an
independent transcription of the document table in `docs/sdk/04-api-specification.md` §3.3.
-/

namespace AgentWorkspace.Authz.Permissions

open AgentWorkspace AgentWorkspace.Concepts.Membership AgentWorkspace.Authz.Resources

/-- `Operation`: what a caller is trying to do to a resource. -/
@[aw_spec (ts := "apps/web/server/rbac/permissions.ts#Operation")
  (doc := "docs/spec.md#21-users-and-rbac")]
inductive Operation where
  | read | write | run
  deriving DecidableEq, Repr, Inhabited

/-- The TypeScript spelling of an operation. -/
def Operation.toWire : Operation → String
  | .read => "read" | .write => "write" | .run => "run"

instance : WireEnum Operation where
  all := [.read, .write, .run]
  toWire := Operation.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- `Grant`: how wide a permission is. -/
@[aw_spec (ts := "apps/web/server/rbac/permissions.ts#Grant")
  (doc := "docs/sdk/04-api-specification.md#33-roles")]
inductive Grant where
  | none | own | permitted | any
  deriving DecidableEq, Repr, Inhabited

/-- The TypeScript spelling of a grant. -/
def Grant.toWire : Grant → String
  | .none => "none" | .own => "own" | .permitted => "permitted" | .any => "any"

instance : WireEnum Grant where
  all := [.none, .own, .permitted, .any]
  toWire := Grant.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- `Grants`: the three operations' grants for one (role, resource) pair. -/
@[aw_spec (ts := "apps/web/server/rbac/permissions.ts#Grants")]
structure Grants where
  read : Grant
  write : Grant
  run : Grant
  deriving DecidableEq, Repr, Inhabited

/-- The grant for one operation. -/
def Grants.get (g : Grants) : Operation → Grant
  | .read => g.read
  | .write => g.write
  | .run => g.run

/-- `NOTHING`. -/
def NOTHING : Grants := ⟨.none, .none, .none⟩
/-- `EVERYTHING`. -/
def EVERYTHING : Grants := ⟨.any, .any, .any⟩
/-- `MANAGE`: full control, no run verb. -/
def MANAGE : Grants := ⟨.any, .any, .none⟩
/-- `OWN_WRITES`: read any, write and run own. -/
def OWN_WRITES : Grants := ⟨.any, .own, .own⟩
/-- `OWN_ONLY`: the caller's own rows. -/
def OWN_ONLY : Grants := ⟨.own, .own, .none⟩
/-- `OWN_READS`: readable where owned. -/
def OWN_READS : Grants := ⟨.own, .none, .none⟩
/-- `READ_ONLY`: readable across the workspace. -/
def READ_ONLY : Grants := ⟨.any, .none, .none⟩
/-- `WORKSPACE_MEMBER_SCOPED`: issue #119's `workspaces` grant, identical for all four roles. -/
def WORKSPACE_MEMBER_SCOPED : Grants := ⟨.own, .own, .none⟩

/-- One role's declaration: a fallback and the resources §21 names for it. -/
structure RolePolicy where
  fallback : Grants
  byResource : List (Resource × Grants)

/-- `POLICY`, role by role, in the order and with the constants `permissions.ts` uses. -/
@[aw_spec (ts := "apps/web/server/rbac/permissions.ts#POLICY")
  (doc := "docs/sdk/04-api-specification.md#33-roles") (doc := "docs/spec.md#21-users-and-rbac")]
def policy : Role → RolePolicy
  | .owner => { fallback := EVERYTHING, byResource := [(.workspaces, WORKSPACE_MEMBER_SCOPED)] }
  | .admin =>
    { fallback := NOTHING
      byResource := [
        (.agents, EVERYTHING),
        (.apiKeys, MANAGE),
        -- ADR-0152: roles are monotonic, so Admin runs connectors as Builder runs its own.
        (.connectors, EVERYTHING),
        -- Issue #949 (ADR-0134): an endpoint client is credential-bearing configuration.
        (.endpointClients, EVERYTHING),
        -- Issue #1293 (ADR-0144): a trigger starts runs as its owner; Admin manages every one.
        -- ADR-0152: `EVERYTHING`, so Admin covers Builder's `run: own` (unreachable by any path).
        (.triggers, EVERYTHING),
        (.memberships, MANAGE),
        (.invitations, MANAGE),
        (.me, READ_ONLY),
        (.metrics, READ_ONLY),
        (.engines, READ_ONLY),
        -- Issue #968: the platform catalogue, same cell and reading as `engines`.
        (.platforms, READ_ONLY),
        (.modelConnections, MANAGE),
        -- Issue #1690 (storage design Q-22): Owner and Admin connect and change a bucket.
        (.storageConnections, MANAGE),
        -- Issue #250 (ADR-SDK-18-N3-250 D6): Owner and Admin decide where run outcomes are sent.
        (.webhooks, MANAGE),
        (.models, MANAGE),
        (.runtimeProfiles, MANAGE),
        (.runtimes, MANAGE),
        (.runtimeConnections, MANAGE),
        -- ADR-0152: every project, as Builder holds its own.
        (.projects, MANAGE),
        (.shares, MANAGE),
        (.sharingPolicies, READ_ONLY),
        (.users, MANAGE),
        (.sessions, OWN_ONLY),
        (.runs, { READ_ONLY with run := .any }),
        -- ADR-0116: Admin holds `skills` and `files` the way it holds `agents`.
        (.skills, EVERYTHING),
        (.files, EVERYTHING),
        -- Issue #790: content-addressed code-tool bundles; whoever saves versions uploads them.
        (.toolBundles, MANAGE),
        (.workspaces, WORKSPACE_MEMBER_SCOPED),
        (.tokens, ⟨.none, .any, .none⟩) ] }
  | .builder =>
    { fallback := NOTHING
      byResource := [
        -- ADR-0152: `run` permitted (own or granted), so Builder covers Viewer's `permitted`.
        (.agents, { OWN_WRITES with run := .permitted }),
        (.skills, OWN_WRITES),
        (.files, OWN_WRITES),
        (.connectors, OWN_WRITES),
        (.endpointClients, OWN_WRITES),
        -- Issue #1293: a Builder edits, rotates and removes the triggers it owns.
        (.triggers, OWN_WRITES),
        (.toolBundles, MANAGE),
        (.runtimeProfiles, READ_ONLY),
        -- Issue #1690 (Q-22): a Member reads the connections an agent can be granted; never writes.
        (.storageConnections, READ_ONLY),
        (.projects, OWN_ONLY),
        (.sessions, OWN_ONLY),
        (.shares, OWN_ONLY),
        (.sharingPolicies, READ_ONLY),
        (.runs, { OWN_READS with run := .own }),
        (.me, READ_ONLY),
        (.metrics, READ_ONLY),
        (.engines, READ_ONLY),
        -- Issue #968: the platform catalogue, same cell and reading as `engines`.
        (.platforms, READ_ONLY),
        (.workspaces, WORKSPACE_MEMBER_SCOPED),
        (.tokens, ⟨.none, .own, .none⟩) ] }
  | .viewer =>
    { fallback := NOTHING
      byResource := [
        (.agents, ⟨.any, .none, .permitted⟩),
        (.sessions, OWN_READS),
        (.runs, { OWN_READS with run := .own }),
        (.shares, OWN_ONLY),
        (.sharingPolicies, READ_ONLY),
        (.me, READ_ONLY),
        (.metrics, READ_ONLY),
        (.engines, READ_ONLY),
        -- Issue #968: the platform catalogue, same cell and reading as `engines`.
        (.platforms, READ_ONLY),
        (.workspaces, WORKSPACE_MEMBER_SCOPED) ] }

/-- `grantsFor`: the override for the resource if the role names it, else the fallback. -/
@[aw_spec (ts := "apps/web/server/rbac/permissions.ts#grantsFor")]
def grantsFor (role : Role) (resource : Resource) : Grants :=
  match ((policy role).byResource.find? (·.1 == resource)) with
  | some (_, g) => g
  | none => (policy role).fallback

/-- One cell of the table. -/
def grantFor (role : Role) (resource : Resource) (op : Operation) : Grant :=
  (grantsFor role resource).get op

/-- The breadth order on grants: `none` is narrowest, `any` widest, and `own` is within
`permitted`, which admits the caller's own rows as well as granted ones (ADR-0152). -/
def Grant.le : Grant → Grant → Bool
  | .none, _ => true
  | .own, .own => true
  | .own, .permitted => true
  | .own, .any => true
  | .permitted, .permitted => true
  | .permitted, .any => true
  | .any, .any => true
  | _, _ => false

/-! ## The table as `docs/sdk/04-api-specification.md` §3.3 prints it

An independent transcription of the document's table, phrase by phrase, so that the per-cell
theorems compare two readings rather than restate one. §3.3 says the table "is
`apps/web/server/rbac/permissions.ts` as of this document's date". -/

/-- The phrases §3.3 uses in its cells. -/
inductive DocPhrase where
  /-- "all" -/
  | all
  /-- "manage" -/
  | manage
  /-- "none" -/
  | none
  /-- "read any, run _permitted_" -/
  | readAnyRunPermitted
  /-- "read any, write own, run own or _permitted_" -/
  | readAnyWriteOwnRunPermitted
  /-- "read any, write own" -/
  | readAnyWriteOwn
  /-- "own" -/
  | own
  /-- "sessions own (read)" (the Viewer cell of the "projects, sessions" row) -/
  | sessionsOwnRead
  /-- "read/run any" -/
  | readRunAny
  /-- "read/run own" -/
  | readRunOwn
  /-- "write any" -/
  | writeAny
  /-- "write own" -/
  | writeOwn
  /-- "read" -/
  | read
  /-- "member-scoped: read any membership, write only as Owner of the target" (spans the row) -/
  | memberScoped
  deriving DecidableEq, Repr

/-- What a phrase grants on one resource of its row. -/
def DocPhrase.grants (resource : Resource) : DocPhrase → Grants
  | .all => EVERYTHING
  | .manage => MANAGE
  | .none => NOTHING
  | .readAnyRunPermitted => ⟨.any, .none, .permitted⟩
  | .readAnyWriteOwnRunPermitted => ⟨.any, .own, .permitted⟩
  | .readAnyWriteOwn => ⟨.any, .own, .none⟩
  | .own => OWN_ONLY
  | .sessionsOwnRead => if resource = .sessions then OWN_READS else NOTHING
  | .readRunAny => ⟨.any, .none, .any⟩
  | .readRunOwn => ⟨.own, .none, .own⟩
  | .writeAny => ⟨.none, .any, .none⟩
  | .writeOwn => ⟨.none, .own, .none⟩
  | .read => READ_ONLY
  | .memberScoped => ⟨.own, .own, .none⟩

/-- §3.3's rows: the (Owner, Admin, Builder, Viewer) phrases for each resource the table names;
`none` for the six resources it does not name (`endpoint-clients`, `me`, `setup`,
`storage-connections`, `tool-bundles`, `triggers`). The "audit" of
"metrics, audit" is `audit-events`. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#33-roles")]
def docRow : Resource → Option (DocPhrase × DocPhrase × DocPhrase × DocPhrase)
  | .agents => some (.all, .all, .readAnyWriteOwnRunPermitted, .readAnyRunPermitted)
  | .skills | .files => some (.all, .all, .readAnyWriteOwn, .none)
  | .connectors => some (.all, .all, .readAnyWriteOwn, .none)
  | .runtimeProfiles => some (.all, .manage, .read, .none)
  | .modelConnections | .models | .runtimeConnections | .runtimes
  | .secrets => some (.all, .manage, .none, .none)
  | .projects => some (.all, .manage, .own, .none)
  | .sessions => some (.all, .own, .own, .sessionsOwnRead)
  | .runs => some (.all, .readRunAny, .readRunOwn, .readRunOwn)
  | .memberships | .users | .invitations | .apiKeys | .webhooks => some (.all, .manage, .none, .none)
  | .tokens => some (.all, .writeAny, .writeOwn, .none)
  | .shares => some (.all, .manage, .own, .own)
  | .sharingPolicies => some (.all, .read, .read, .read)
  | .metrics | .auditEvents => some (.all, .read, .read, .read)
  | .engines | .platforms => some (.all, .read, .read, .read)
  | .workspaces => some (.memberScoped, .memberScoped, .memberScoped, .memberScoped)
  | .endpointClients | .me | .setup | .storageConnections | .toolBundles | .triggers => Option.none

/-- The grants §3.3 prints for a role over a resource, or `none` where it is silent. -/
def documentedGrants (role : Role) (resource : Resource) : Option Grants :=
  (docRow resource).map fun (o, a, b, v) =>
    let phrase := match role with
      | .owner => o | .admin => a | .builder => b | .viewer => v
    phrase.grants resource

/-! ## The `(admin, runs)` cell as ADR W9-AUTH-165 states it

W9-AUTH-165 makes Admin's `runs` grant `READ_ONLY` and says "An Admin still cannot start, cancel,
or write a run". SDK-03-RUN-235 later adds `run: 'any'`, and the code follows SDK-03. The table
W9-AUTH-165's text describes differs from `POLICY` in that one cell. -/

/-- `POLICY` as ADR W9-AUTH-165's decision text describes it. -/
@[aw_spec (doc := "docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md#decision")]
def grantsForW9Auth165 (role : Role) (resource : Resource) : Grants :=
  if role = .admin ∧ resource = .runs then READ_ONLY else grantsFor role resource

end AgentWorkspace.Authz.Permissions
