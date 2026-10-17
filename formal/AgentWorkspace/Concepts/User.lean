import AgentWorkspace.Concepts.Workspace

/-!
# The user concept and its OIDC identities

A **user** is a global identity, not a tenant object: one person, who may sit in several
workspaces through several memberships (`packages/core/src/db/schema/users.ts`: "A user is
deliberately NOT workspace-scoped"). A user carries no role and no workspace. The database knows
it as a row of `users`; the wire knows it as `UserResourceSchema`
(`packages/contracts/src/team.ts`).

A **user identity** is one OIDC `(issuer, subject)` pair bound to exactly one user
(`packages/core/src/db/schema/user-identities.ts`). It is global too, and the SDK never reaches it
(`docs/sdk/07-structure-map.md`, "Tables the SDK does not reach").

**Email.** Stored lower-case (`users_email_lowercase`) with a shape check (`users_email_shape`).
The model's `lowercase` is ASCII lower case, because Lean's `Char.toLower` is; PostgreSQL's
`lower` also folds non-ASCII letters under a UTF-8 collation (a stated gap of this unit).
-/

namespace AgentWorkspace.Concepts.User

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Workspace

/-- The POSIX `[:space:]` class in the C locale: space, tab, line feed, vertical tab, form feed,
carriage return. -/
def isSpaceChar (c : Char) : Bool :=
  c == ' ' || c == '\t' || c == '\n' || c == Char.ofNat 11 || c == Char.ofNat 12 || c == '\r'

/-- `[^[:space:]@]`. -/
def isEmailChar (c : Char) : Bool := !isSpaceChar c && c != '@'

/-- `[^[:space:]@]+[.][^[:space:]@]+` given that every character is an email character: some
`.` has at least one character on each side. -/
def dotInside : List Char → Bool
  | [] => false
  | _ :: rest => rest.dropLast.contains '.'

/-- `users_email_shape` and `invitations_email_shape`:
`email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'` — exactly one `@`, no whitespace, a
non-empty local part, and a domain with a dot that is neither its first nor its last character. -/
@[aw_spec (ts := "packages/core/src/db/schema/users.ts#users_email_shape")
  (ts := "packages/core/src/db/schema/invitations.ts#invitations_email_shape")]
def emailShape (s : String) : Bool :=
  match s.toList.span (· != '@') with
  | (local_, '@' :: domain) =>
    !local_.isEmpty && local_.all isEmailChar && domain.all isEmailChar && dotInside domain
  | _ => false

/-- `email = lower(email)`, with ASCII lower case. -/
@[aw_spec (ts := "packages/core/src/db/schema/users.ts#users_email_lowercase")
  (ts := "packages/core/src/db/schema/invitations.ts#invitations_email_lowercase")]
def lowercase (s : String) : Bool := s.toList.all fun c => c.toLower == c

/-- `USER_EMAIL_MAX_LENGTH`, the bound the user and membership routes apply. -/
@[aw_spec (ts := "packages/contracts/src/team.ts#USER_EMAIL_MAX_LENGTH")]
def emailMaxLength : Nat := 320

/-- `USER_NAME_MAX_LENGTH`. -/
@[aw_spec (ts := "packages/contracts/src/team.ts#USER_NAME_MAX_LENGTH")]
def nameMaxLength : Nat := 200

/-- A user: a global identity with a unique lower-case email and a display name. -/
@[aw_spec (ts := "packages/core/src/db/schema/users.ts#users")
  (ts := "packages/contracts/src/team.ts#UserResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
structure User where
  id : UserId
  email : String
  name : String
  createdAt : Instant
  updatedAt : Instant
  deriving DecidableEq, Repr

/-- The checks of `users`, as a predicate on the concept. -/
def User.valid (u : User) : Bool := lowercase u.email && emailShape u.email && notBlank u.name

/-- The `users` row of a user. -/
def User.toRow (u : User) : Row :=
  ⟨[("id", u.id.val), ("email", u.email), ("name", u.name), ("created_at", instantText u.createdAt),
    ("updated_at", instantText u.updatedAt)]⟩

/-- An OIDC binding: the pair `(issuer, subject)` names exactly one user, forever. -/
@[aw_spec (ts := "packages/core/src/db/schema/user-identities.ts#userIdentities")]
structure UserIdentity where
  id : UserIdentityId
  issuer : String
  subject : String
  user : UserId
  createdAt : Instant
  updatedAt : Instant
  deriving DecidableEq, Repr

/-- The checks of `user_identities`: neither half of the key is blank. -/
def UserIdentity.valid (i : UserIdentity) : Bool := notBlank i.issuer && notBlank i.subject

/-- The `user_identities` row of an identity. -/
def UserIdentity.toRow (i : UserIdentity) : Row :=
  ⟨[("id", i.id.val), ("issuer", i.issuer), ("subject", i.subject), ("user_id", i.user.val),
    ("created_at", instantText i.createdAt), ("updated_at", instantText i.updatedAt)]⟩

end AgentWorkspace.Concepts.User
