import AgentWorkspace.Concepts.Principal
import AgentWorkspace.Concepts.Invitation

/-!
# Today's identity tables

The fourteen tables of the identity cluster — `workspaces`, `users`, `user_identities`,
`memberships`, `workspace_principals`, `api_keys`, `invitations`, `browser_tokens`,
`cli_sessions`, `endpoint_clients`, `endpoint_client_agents`, `endpoint_client_api_keys`,
`oauth_tokens`, `runtime_verifications` — as `Er/Core.lean`'s `catalogue` records them (columns, foreign keys, unique keys,
closed-set checks, all compared with the live Drizzle schema and the 0031 snapshot by the `er-core`
suite), plus the one thing `Er/Core.lean` leaves to the clusters: the **meaning of every other
check**.

`Er/Core.lean` records 36 checks of these tables only by name (`Check.other`), and gives only
`workspace_principals_source_xor` a semantics. This module gives each of the 36 a `CheckExpr`: a
small SQL expression language whose `render` is exactly the text `drizzle-kit` stored in
the latest snapshot (`Er.Snapshot.file`) (the conformance suite compares them), and whose `eval` is
SQL's three-valued logic — a check passes unless its expression is `FALSE`.

`consistent` is the database's own constraint set with the refined checks added, plus the typing
of timestamp and boolean cells (a timestamp cell is a decimal numeral, `Concepts.Workspace`).

**Relationships.** `relationships` lists every foreign key of the cluster with the two
multiplicities the schema fixes: how many parents a child row has (exactly one when every key
column is `NOT NULL`, at most one otherwise) and how many children a parent row has (at most one
when the child's key columns are themselves a key of the child, many otherwise).
-/

namespace AgentWorkspace.Er.Current.Identity

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Workspace
  AgentWorkspace.Concepts.User

/-- The fourteen tables of the identity cluster. `cli_sessions` (SDK-10, #242, ADR-0083) is one
`aw login` of one person, referenced through their membership. Then come ADR-0134's endpoint
clients: what one external platform may reach (`endpoint_clients`), the agents it names
(`endpoint_client_agents`), the API keys bound to it (`endpoint_client_api_keys`) and the OAuth
codes and tokens issued to it for a member (`oauth_tokens`, part 3). The last,
`runtime_verifications`, is the workspace's record of which runtime drivers passed Test Runtime
(#827); it references only the workspace. -/
@[aw_spec (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
def tables : List TableName :=
  [.workspaces, .users, .userIdentities, .memberships, .workspacePrincipals, .apiKeys,
    .invitations, .browserTokens, .cliSessions, .endpointClients, .endpointClientAgents,
    .endpointClientApiKeys, .oauthTokens, .runtimeVerifications]

/-! ## A SQL fragment for the identity checks -/

/-- A comparison operator of a check. -/
inductive Rel where
  | gt
  | ge
  deriving DecidableEq, Repr

/-- The operator as SQL spells it. -/
def Rel.toSql : Rel → String
  | .gt => ">"
  | .ge => ">="

/-- `a REL b` on instants. -/
def Rel.apply : Rel → Instant → Instant → Bool
  | .gt, a, b => b < a
  | .ge, a, b => b ≤ a

/-- A regular expression a check matches a column against. -/
inductive Pattern where
  | slug
  | email
  /-- `cli_sessions.user_code`: exactly eight upper-case ASCII letters. -/
  | userCode
  deriving DecidableEq, Repr

/-- The regular expression exactly as the check writes it. -/
def Pattern.toSql : Pattern → String
  | .slug => "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
  | .email => "^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$"
  | .userCode => "^[A-Z]{8}$"

/-- `^[A-Z]{8}$`: eight characters, each an upper-case ASCII letter
(`cli_sessions_user_code_shape`). -/
def userCodeShape (s : String) : Bool :=
  let cs := s.toList
  cs.length == 8 && cs.all fun c => 'A' ≤ c && c ≤ 'Z'

/-- Whether a value matches the pattern (`Concepts.Workspace.slugFormat`,
`Concepts.User.emailShape`). -/
def Pattern.test : Pattern → String → Bool
  | .slug => slugFormat
  | .email => emailShape
  | .userCode => userCodeShape

/-- The number of elements of a PostgreSQL array literal as a cell holds it: `{}` has none, and
otherwise the elements are the comma-separated items between the braces (the sample values never
quote an element). -/
def arrayCardinality (s : String) : Nat :=
  if s == "{}" then 0 else (s.toList.filter (· == ',')).length + 1

/-- The shapes the 36 non-closed-set checks of the identity tables take. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")
  (ts := "packages/core/src/db/schema/browser-tokens.ts#browserTokens")
  (ts := "packages/core/src/db/schema/invitations.ts#invitations")
  (ts := "packages/core/src/db/schema/cli-sessions.ts#cliSessions")]
inductive CheckExpr where
  /-- `length(btrim(c)) > 0`. -/
  | notBlank (c : String)
  /-- `c = lower(c)`. -/
  | lowercase (c : String)
  /-- `c ~ '<pattern>'`. -/
  | «matches» (c : String) (p : Pattern)
  /-- `(a is null) = (b is null)`. -/
  | nullIff (a b : String)
  /-- `a is null or a REL b`. -/
  | nullOr (a : String) (rel : Rel) (b : String)
  /-- `a REL b`. -/
  | cmp (a : String) (rel : Rel) (b : String)
  /-- `a is null or b is null`. -/
  | eitherNull (a b : String)
  /-- `(k = 'v1' and c1 is not null and c2 is null) or (k = 'v2' and c2 is not null and c1 is
  null)`: the column `k` names which of two id columns is set. -/
  | xor (k v1 c1 v2 c2 : String)
  /-- `(k in ('v', …)) = (c is not null and …)` — or `(k = 'v') = (…)` for one value: the column
  `k` takes one of the values `vs` exactly when every column of `cs` is set. -/
  | valueIffPresent (k : String) (vs : List String) (cs : List String)
  /-- `a is null or k = 'v'`: column `a` may be set only on a row whose `k` is `v`. -/
  | nullOrEquals (a k v : String)
  /-- `a is null or a <> b`: column `a`, when set, differs from column `b`. -/
  | nullOrDistinct (a b : String)
  /-- `cardinality(c) <= n`: the array column `c` holds at most `n` elements. -/
  | atMostElements (c : String) (n : Nat)
  deriving DecidableEq, Repr

/-! ### Three-valued evaluation -/

/-- Kleene conjunction (`none` is SQL `NULL`). -/
def and3 : Option Bool → Option Bool → Option Bool
  | some false, _ => some false
  | _, some false => some false
  | some true, some true => some true
  | _, _ => none

/-- Kleene disjunction. -/
def or3 : Option Bool → Option Bool → Option Bool
  | some true, _ => some true
  | _, some true => some true
  | some false, some false => some false
  | _, _ => none

/-- `c = 'v'`: `NULL` when `c` is. -/
def eqText (r : Row) (c v : String) : Option Bool := (r.get c).map (· == v)

/-- `a <> b` on two text cells: `NULL` when either is `NULL`. -/
def neCells (r : Row) (a b : String) : Option Bool :=
  match r.get a, r.get b with
  | some x, some y => some (x != y)
  | _, _ => none

/-- `a REL b` on two timestamp cells: `NULL` when either is `NULL` (or is not a timestamp). -/
def cmpCells (r : Row) (a : String) (rel : Rel) (b : String) : Option Bool :=
  match instantOf? (r.get a), instantOf? (r.get b) with
  | some x, some y => some (rel.apply x y)
  | _, _ => none

/-- The value of a check expression on a row, in SQL's three-valued logic. -/
def CheckExpr.eval (r : Row) : CheckExpr → Option Bool
  | .notBlank c => (r.get c).map Concepts.Workspace.notBlank
  | .lowercase c => (r.get c).map Concepts.User.lowercase
  | .matches c p => (r.get c).map p.test
  | .nullIff a b => some ((r.get a).isNone == (r.get b).isNone)
  | .nullOr a rel b => or3 (some (r.get a).isNone) (cmpCells r a rel b)
  | .cmp a rel b => cmpCells r a rel b
  | .eitherNull a b => some ((r.get a).isNone || (r.get b).isNone)
  | .xor k v1 c1 v2 c2 =>
    or3 (and3 (and3 (eqText r k v1) (some (r.get c1).isSome)) (some (r.get c2).isNone))
      (and3 (and3 (eqText r k v2) (some (r.get c2).isSome)) (some (r.get c1).isNone))
  | .valueIffPresent k vs cs =>
    (r.get k).map fun v => vs.contains v == cs.all fun c => (r.get c).isSome
  | .nullOrEquals a k v => or3 (some (r.get a).isNone) (eqText r k v)
  | .nullOrDistinct a b => or3 (some (r.get a).isNone) (neCells r a b)
  | .atMostElements c n => (r.get c).map fun v => decide (arrayCardinality v ≤ n)

/-- A check holds on a row unless its expression is `FALSE` (a `NULL` check passes). -/
def CheckExpr.holds (e : CheckExpr) (r : Row) : Bool := e.eval r != some false

/-! ### Rendering: the text `drizzle-kit` stores -/

/-- `"table"."column"`. -/
def quote (table c : String) : String := "\"" ++ table ++ "\".\"" ++ c ++ "\""

/-- `'a', 'b'`: a value list as a check writes it. -/
def valueList (vs : List String) : String := ", ".intercalate (vs.map fun v => "'" ++ v ++ "'")

/-- The SQL of a check on `table`, exactly as the 0031 snapshot records it. -/
def CheckExpr.render (table : String) : CheckExpr → String
  | .notBlank c => "length(btrim(" ++ quote table c ++ ")) > 0"
  | .lowercase c => quote table c ++ " = lower(" ++ quote table c ++ ")"
  | .matches c p => quote table c ++ " ~ '" ++ p.toSql ++ "'"
  | .nullIff a b => "(" ++ quote table a ++ " is null) = (" ++ quote table b ++ " is null)"
  | .nullOr a rel b =>
    quote table a ++ " is null or " ++ quote table a ++ " " ++ rel.toSql ++ " " ++ quote table b
  | .cmp a rel b => quote table a ++ " " ++ rel.toSql ++ " " ++ quote table b
  | .eitherNull a b => quote table a ++ " is null or " ++ quote table b ++ " is null"
  | .xor k v1 c1 v2 c2 =>
    "(" ++ quote table k ++ " = '" ++ v1 ++ "' and " ++ quote table c1 ++ " is not null and " ++
      quote table c2 ++ " is null)\n        or (" ++ quote table k ++ " = '" ++ v2 ++ "' and " ++
      quote table c2 ++ " is not null and " ++ quote table c1 ++ " is null)"
  | .valueIffPresent k vs cs =>
    let lhs := match vs with
      | [v] => quote table k ++ " = '" ++ v ++ "'"
      | _ => quote table k ++ " in (" ++ valueList vs ++ ")"
    "(" ++ lhs ++ ") = (" ++
      " and ".intercalate (cs.map fun c => quote table c ++ " is not null") ++ ")"
  | .nullOrEquals a k v => quote table a ++ " is null or " ++ quote table k ++ " = '" ++ v ++ "'"
  | .nullOrDistinct a b => quote table a ++ " is null or " ++ quote table a ++ " <> " ++ quote table b
  | .atMostElements c n => "cardinality(" ++ quote table c ++ ") <= " ++ toString n

/-! ### The 36 checks -/

/-- Every non-closed-set check of the identity tables, with its meaning, table by table in
`tables` order and, within a table, in the order `catalogue` lists them. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspaces.ts#workspaces")
  (ts := "packages/core/src/db/schema/users.ts#users")
  (ts := "packages/core/src/db/schema/user-identities.ts#userIdentities")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")
  (ts := "packages/core/src/db/schema/api-keys.ts#apiKeys")
  (ts := "packages/core/src/db/schema/invitations.ts#invitations")
  (ts := "packages/core/src/db/schema/browser-tokens.ts#browserTokens")
  (ts := "packages/core/src/db/schema/cli-sessions.ts#cliSessions")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
def checks : List (TableName × String × CheckExpr) :=
  [(.workspaces, "workspaces_slug_format", .matches "slug" .slug),
   (.workspaces, "workspaces_name_not_blank", .notBlank "name"),
   (.workspaces, "workspaces_default_model_pair",
     .nullIff "default_model_connection_id" "default_model"),
   (.users, "users_email_lowercase", .lowercase "email"),
   (.users, "users_email_shape", .matches "email" .email),
   (.users, "users_name_not_blank", .notBlank "name"),
   (.userIdentities, "user_identities_issuer_not_blank", .notBlank "issuer"),
   (.userIdentities, "user_identities_subject_not_blank", .notBlank "subject"),
   (.workspacePrincipals, "workspace_principals_source_xor",
     .xor "kind" "membership" "membership_id" "api_key" "api_key_id"),
   (.workspacePrincipals, "workspace_principals_revoked_after_activation",
     .nullOr "revoked_at" .ge "activated_at"),
   (.workspacePrincipals, "workspace_principals_acts_for_api_key_only",
     .nullOrEquals "acts_for_principal_id" "kind" "api_key"),
   (.workspacePrincipals, "workspace_principals_acts_for_not_self",
     .nullOrDistinct "acts_for_principal_id" "id"),
   (.apiKeys, "api_keys_name_not_blank", .notBlank "name"),
   (.apiKeys, "api_keys_key_prefix_not_blank", .notBlank "key_prefix"),
   (.apiKeys, "api_keys_key_hash_not_blank", .notBlank "key_hash"),
   (.apiKeys, "api_keys_expires_after_created", .nullOr "expires_at" .gt "created_at"),
   (.apiKeys, "api_keys_revoked_after_created", .nullOr "revoked_at" .ge "created_at"),
   (.invitations, "invitations_email_lowercase", .lowercase "email"),
   (.invitations, "invitations_email_shape", .matches "email" .email),
   (.invitations, "invitations_token_hash_not_blank", .notBlank "token_hash"),
   (.invitations, "invitations_expires_after_created", .cmp "expires_at" .gt "created_at"),
   (.invitations, "invitations_accepted_after_created", .nullOr "accepted_at" .ge "created_at"),
   (.invitations, "invitations_revoked_after_created", .nullOr "revoked_at" .ge "created_at"),
   (.invitations, "invitations_not_accepted_and_revoked", .eitherNull "accepted_at" "revoked_at"),
   (.browserTokens, "browser_tokens_scope_xor",
     .xor "scope_kind" "run" "run_id" "session" "session_id"),
   (.browserTokens, "browser_tokens_expiry_after_created", .cmp "expires_at" .gt "created_at"),
   (.browserTokens, "browser_tokens_revoked_after_created", .nullOr "revoked_at" .ge "created_at"),
   (.cliSessions, "cli_sessions_user_code_shape", .matches "user_code" .userCode),
   (.cliSessions, "cli_sessions_token_iff_issued",
     .valueIffPresent "status" ["active", "revoked"] ["token_hash", "expires_at"]),
   (.cliSessions, "cli_sessions_revoked_iff_status",
     .valueIffPresent "status" ["revoked"] ["revoked_at"]),
   (.cliSessions, "cli_sessions_expiry_after_created", .nullOr "expires_at" .gt "created_at"),
   (.endpointClients, "endpoint_clients_tool_names_mcp_only",
     .nullOrEquals "tool_names" "kind" "mcp-project"),
   (.endpointClients, "endpoint_clients_redirect_uris_max", .atMostElements "redirect_uris" 10),
   (.endpointClients, "endpoint_clients_revoked_after_created",
     .nullOr "revoked_at" .ge "created_at"),
   (.oauthTokens, "oauth_tokens_code_fields",
     .valueIffPresent "kind" ["code"] ["code_challenge", "redirect_uri"]),
   (.oauthTokens, "oauth_tokens_expiry_after_created", .cmp "expires_at" .gt "created_at")]

/-- The refined checks of one table. -/
def checksOf (t : TableName) : List (String × CheckExpr) :=
  (checks.filter (·.1 == t)).map (·.2)

/-- The meaning of a named check, if it is one of the 36. -/
def semantics? (n : String) : Option CheckExpr := (checks.find? (·.2.1 == n)).map (·.2.2)

/-- The names of the checks `catalogue` records without a semantics, for one table. -/
def otherCheckNames (t : TableName) : List String :=
  (catalogue t).checks.filterMap fun
    | .other n => some n
    | .oneOf .. => none

/-! ## Sample rows: what each check accepts and refuses

For every one of the 36 checks, rows it accepts and rows it refuses, chosen at the boundaries the
check draws (a `NULL`, an equal timestamp, a 63- and a 64-character slug, a tab-only name, a
second `@`, a ten- and an eleven-element array). The T0 theorems `<check>_separates_its_samples` pin each verdict, and the vectors carry
them. Each row holds only the columns its check reads. -/

/-- A row of the given cells. -/
def row (cells : List (String × String)) : Row := ⟨cells⟩

/-- A string of `n` copies of `c`. -/
def rep (n : Nat) (c : Char) : String := String.ofList (List.replicate n c)

/-- Accepted and refused sample rows, by check name. -/
def samples : List (String × List Row × List Row) :=
  [("workspaces_slug_format",
     [row [("slug", "a")], row [("slug", "default")], row [("slug", "0-a")],
      row [("slug", "a--b")], row [("slug", rep 63 'a')], row []],
     [row [("slug", "")], row [("slug", "-a")], row [("slug", "a-")], row [("slug", "A")],
      row [("slug", "a_b")], row [("slug", "a b")], row [("slug", rep 64 'a')]]),
   ("workspaces_name_not_blank",
     [row [("name", "One")], row [("name", " x ")], row [("name", "\t")]],
     [row [("name", "")], row [("name", "   ")]]),
   ("workspaces_default_model_pair",
     [row [], row [("default_model_connection_id", "c1"), ("default_model", "m")]],
     [row [("default_model_connection_id", "c1")], row [("default_model", "m")]]),
   ("users_email_lowercase",
     [row [("email", "a@example.com")], row [("email", "a.b+c@d.e")]],
     [row [("email", "A@example.com")], row [("email", "a@Example.com")]]),
   ("users_email_shape",
     [row [("email", "a@example.com")], row [("email", "a.b@c.d")], row [("email", "a@b.c.d")],
      row [("email", "a@b..c")]],
     [row [("email", "a@example")], row [("email", "a@.com")], row [("email", "a@com.")],
      row [("email", "@example.com")], row [("email", "a b@example.com")],
      row [("email", "a@@example.com")], row [("email", "a@b@c.com")], row [("email", "")],
      row [("email", "a@exa\tmple.com")]]),
   ("users_name_not_blank",
     [row [("name", "Ada")]],
     [row [("name", "")], row [("name", " ")]]),
   ("user_identities_issuer_not_blank",
     [row [("issuer", "https://id.example.com")]],
     [row [("issuer", "")], row [("issuer", "  ")]]),
   ("user_identities_subject_not_blank",
     [row [("subject", "248289761001")]],
     [row [("subject", "")], row [("subject", " ")]]),
   ("workspace_principals_source_xor",
     [row [("kind", "membership"), ("membership_id", "m1")],
      row [("kind", "api_key"), ("api_key_id", "k1")],
      row [("membership_id", "m1")]],
     [row [("kind", "membership")], row [("kind", "api_key")],
      row [("kind", "membership"), ("membership_id", "m1"), ("api_key_id", "k1")],
      row [("kind", "membership"), ("api_key_id", "k1")],
      row [("kind", "api_key"), ("membership_id", "m1")],
      row [("kind", "api-key"), ("api_key_id", "k1")], row []]),
   ("workspace_principals_revoked_after_activation",
     [row [("activated_at", "10")], row [("activated_at", "10"), ("revoked_at", "10")],
      row [("activated_at", "10"), ("revoked_at", "11")]],
     [row [("activated_at", "10"), ("revoked_at", "9")]]),
   ("workspace_principals_acts_for_api_key_only",
     [row [("kind", "membership")], row [("kind", "api_key")],
      row [("kind", "api_key"), ("acts_for_principal_id", "p1")],
      row [("acts_for_principal_id", "p1")]],
     [row [("kind", "membership"), ("acts_for_principal_id", "p1")],
      row [("kind", "api-key"), ("acts_for_principal_id", "p1")]]),
   ("workspace_principals_acts_for_not_self",
     [row [("id", "p2")], row [("id", "p2"), ("acts_for_principal_id", "p1")],
      row [("acts_for_principal_id", "p1")]],
     [row [("id", "p2"), ("acts_for_principal_id", "p2")]]),
   ("api_keys_name_not_blank", [row [("name", "CI")]], [row [("name", "")], row [("name", "  ")]]),
   ("api_keys_key_prefix_not_blank",
     [row [("key_prefix", "ak_live_AAAAAAAAAAAAAAAAAAAAAA")]], [row [("key_prefix", "")]]),
   ("api_keys_key_hash_not_blank", [row [("key_hash", "ab12")]], [row [("key_hash", " ")]]),
   ("api_keys_expires_after_created",
     [row [("created_at", "10")], row [("created_at", "10"), ("expires_at", "11")]],
     [row [("created_at", "10"), ("expires_at", "10")],
      row [("created_at", "10"), ("expires_at", "9")]]),
   ("api_keys_revoked_after_created",
     [row [("created_at", "10")], row [("created_at", "10"), ("revoked_at", "10")]],
     [row [("created_at", "10"), ("revoked_at", "9")]]),
   ("invitations_email_lowercase",
     [row [("email", "a@example.com")]], [row [("email", "Ada@example.com")]]),
   ("invitations_email_shape",
     [row [("email", "a@example.com")]], [row [("email", "a@example")], row [("email", "a@b@c.d")]]),
   ("invitations_token_hash_not_blank",
     [row [("token_hash", "ab12")]], [row [("token_hash", "")]]),
   ("invitations_expires_after_created",
     [row [("created_at", "10"), ("expires_at", "11")], row [("created_at", "10")]],
     [row [("created_at", "10"), ("expires_at", "10")]]),
   ("invitations_accepted_after_created",
     [row [("created_at", "10")], row [("created_at", "10"), ("accepted_at", "10")]],
     [row [("created_at", "10"), ("accepted_at", "9")]]),
   ("invitations_revoked_after_created",
     [row [("created_at", "10")], row [("created_at", "10"), ("revoked_at", "12")]],
     [row [("created_at", "10"), ("revoked_at", "9")]]),
   ("invitations_not_accepted_and_revoked",
     [row [], row [("accepted_at", "11")], row [("revoked_at", "11")]],
     [row [("accepted_at", "11"), ("revoked_at", "12")]]),
   ("browser_tokens_scope_xor",
     [row [("scope_kind", "run"), ("run_id", "r1")],
      row [("scope_kind", "session"), ("session_id", "s1")]],
     [row [("scope_kind", "run")], row [("scope_kind", "session")],
      row [("scope_kind", "run"), ("run_id", "r1"), ("session_id", "s1")],
      row [("scope_kind", "run"), ("session_id", "s1")],
      row [("scope_kind", "session"), ("run_id", "r1")], row []]),
   ("browser_tokens_expiry_after_created",
     [row [("created_at", "10"), ("expires_at", "310")]],
     [row [("created_at", "10"), ("expires_at", "10")],
      row [("created_at", "10"), ("expires_at", "5")]]),
   ("browser_tokens_revoked_after_created",
     [row [("created_at", "10")], row [("created_at", "10"), ("revoked_at", "10")]],
     [row [("created_at", "10"), ("revoked_at", "9")]]),
   ("cli_sessions_user_code_shape",
     [row [("user_code", "ABCDEFGH")], row [("user_code", "ZZZZZZZZ")], row []],
     [row [("user_code", "ABCDEFG")], row [("user_code", "ABCDEFGHI")],
      row [("user_code", "abcdefgh")], row [("user_code", "ABCD-EFG")],
      row [("user_code", "ABCDEFG1")], row [("user_code", "")]]),
   ("cli_sessions_token_iff_issued",
     [row [("status", "approved")], row [("status", "denied")],
      row [("status", "active"), ("token_hash", "ab12"), ("expires_at", "11")],
      row [("status", "revoked"), ("token_hash", "ab12"), ("expires_at", "11")]],
     [row [("status", "active")], row [("status", "active"), ("token_hash", "ab12")],
      row [("status", "revoked"), ("expires_at", "11")],
      row [("status", "approved"), ("token_hash", "ab12"), ("expires_at", "11")]]),
   ("cli_sessions_revoked_iff_status",
     [row [("status", "active")], row [("status", "revoked"), ("revoked_at", "12")]],
     [row [("status", "revoked")], row [("status", "active"), ("revoked_at", "12")],
      row [("status", "approved"), ("revoked_at", "12")]]),
   ("cli_sessions_expiry_after_created",
     [row [("created_at", "10")], row [("created_at", "10"), ("expires_at", "11")]],
     [row [("created_at", "10"), ("expires_at", "10")],
      row [("created_at", "10"), ("expires_at", "9")]]),
   ("endpoint_clients_tool_names_mcp_only",
     [row [("kind", "a2a-agent")], row [("kind", "mcp-project")],
      row [("kind", "mcp-project"), ("tool_names", "{search}")],
      row [("tool_names", "{search}")]],
     [row [("kind", "a2a-agent"), ("tool_names", "{search}")],
      row [("kind", "a2a-agent"), ("tool_names", "{}")]]),
   ("endpoint_clients_redirect_uris_max",
     [row [("redirect_uris", "{}")], row [("redirect_uris", "{https://a.example/cb}")],
      row [("redirect_uris", "{a,b,c,d,e,f,g,h,i,j}")]],
     [row [("redirect_uris", "{a,b,c,d,e,f,g,h,i,j,k}")]]),
   ("endpoint_clients_revoked_after_created",
     [row [("created_at", "10")], row [("created_at", "10"), ("revoked_at", "10")]],
     [row [("created_at", "10"), ("revoked_at", "9")]]),
   ("oauth_tokens_code_fields",
     [row [("kind", "code"), ("code_challenge", "ch1"), ("redirect_uri", "https://a.example/cb")],
      row [("kind", "access")], row [("kind", "refresh")]],
     [row [("kind", "code")], row [("kind", "code"), ("code_challenge", "ch1")],
      row [("kind", "access"), ("code_challenge", "ch1"),
        ("redirect_uri", "https://a.example/cb")]]),
   ("oauth_tokens_expiry_after_created",
     [row [("created_at", "10"), ("expires_at", "11")]],
     [row [("created_at", "10"), ("expires_at", "10")],
      row [("created_at", "10"), ("expires_at", "9")]])]

/-- The check `n` accepts every accepted sample and refuses every refused one, and has samples on
both sides. -/
def separatesSamples (n : String) : Bool :=
  match semantics? n, samples.find? (·.1 == n) with
  | some e, some (_, acc, rej) =>
    !acc.isEmpty && !rej.isEmpty && acc.all e.holds && rej.all fun r => !e.holds r
  | _, _ => false

/-! ## Typed cells and the refined consistency -/

/-- A cell is well typed for its column: the column exists, a timestamp is a decimal numeral and a
boolean is `true` or `false`. -/
def cellTyped (s : TableSpec) (cell : String × String) : Bool :=
  match s.column? cell.1 with
  | none => false
  | some col =>
    match col.type with
    | .timestamptz => (parseInstant? cell.2).isSome
    | .boolean => cell.2 == "true" || cell.2 == "false"
    | _ => true

/-- Every cell of the row is well typed, and no column appears twice. -/
def rowTyped (t : TableName) (r : Row) : Bool :=
  r.cells.all (cellTyped (catalogue t)) && decide (r.cells.map (·.1)).Nodup

/-- Row `r` is one PostgreSQL would store in table `t`, as far as the row alone decides: it names
only columns of `t`, has every `NOT NULL` column, is well typed, and passes every closed-set check
and every refined check. (Keys and references need the rest of the state.) -/
def rowAdmitted (t : TableName) (r : Row) : Bool :=
  r.cells.all (fun c => (catalogue t).hasColumn c.1) &&
    (catalogue t).columns.all (fun col => !col.notNull || (r.get col.name).isSome) &&
    rowTyped t r && (catalogue t).checks.all (checkHolds [r]) &&
    (checksOf t).all fun (_, e) => e.holds r

/-- Every refined check of table `t` holds on every row, and every row is well typed. -/
def tableChecksHold (st : State) (t : TableName) : Bool :=
  (st t).all fun r => rowTyped t r && (checksOf t).all fun (_, e) => e.holds r

/-- Today's identity cluster is consistent: every constraint of `catalogue` holds
(`Er.Core.consistent`), and on the fourteen identity tables every refined check holds and every
cell is well typed. -/
@[aw_spec (ts := "packages/core/src/db/schema/index.ts")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
def consistent (st : State) : Bool :=
  Er.Core.consistent catalogue st && tables.all (tableChecksHold st)

/-! ## Relationships and their multiplicities -/

/-- How many rows of the other side one row relates to. -/
inductive Multiplicity where
  | exactlyOne
  | atMostOne
  | many
  deriving DecidableEq, Repr

/-- The spelling of a multiplicity, for vectors. -/
def Multiplicity.toWire : Multiplicity → String
  | .exactlyOne => "exactly-one"
  | .atMostOne => "at-most-one"
  | .many => "many"

instance : WireEnum Multiplicity where
  all := [.exactlyOne, .atMostOne, .many]
  toWire := Multiplicity.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- How many parent rows one child row references: exactly one when every key column is
`NOT NULL`, at most one when some is nullable (`MATCH SIMPLE` leaves such a row unconstrained). -/
def parentMultiplicity (t : TableName) (fk : ForeignKey) : Multiplicity :=
  if fk.columns.all (catalogue t).isNotNull then .exactlyOne else .atMostOne

/-- How many child rows reference one parent row: at most one when the child's key columns form a
key of the child table, many otherwise. -/
def childMultiplicity (t : TableName) (fk : ForeignKey) : Multiplicity :=
  if (catalogue t).isKey fk.columns then .atMostOne else .many

/-- One relationship of the cluster: a foreign key declared by an identity table. -/
structure Relationship where
  table : TableName
  fk : ForeignKey
  deriving Repr

/-- Every foreign key the fourteen identity tables declare. -/
@[aw_spec (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
def relationships : List Relationship :=
  tables.flatMap fun t => (catalogue t).foreignKeys.map fun fk => ⟨t, fk⟩

/-- The foreign key named `n` of table `t` (the default key when there is none). -/
def fkOf (t : TableName) (n : String) : ForeignKey := ((catalogue t).foreignKey? n).getD default

/-- Every column of the primary key, or of some total unique key, of table `t` is among `cols`:
two rows that agree on `cols` agree on that key. -/
def coversKey (t : TableName) (cols : List String) : Bool :=
  (catalogue t).primaryKey.all cols.contains ||
    (catalogue t).uniques.any fun u => u.partialNullColumns.isEmpty && u.columns.all cols.contains

/-- The first row of `t` that references a row of the foreign key's target in state `st`, with
that parent row. -/
def findRef (st : State) (t : TableName) (fk : ForeignKey) : Option (Row × Row) :=
  (st t).findSome? fun r =>
    if r.present fk.columns then
      ((st fk.refTable).find? fun r' => r'.project fk.refColumns == r.project fk.columns).map (r, ·)
    else none

/-! ## Source coverage: today and the target -/

/-- RF-101's target: every membership and every API key of a state has a principal
("one human principal per Membership and one machine principal per APIKey"). -/
@[aw_spec (doc := "docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md#rf-101--introduce-workspaceprincipal-and-split-identity-ownership-and-attribution")]
def everySourceHasPrincipal (st : State) : Bool :=
  (st .memberships).all (fun m => (st .workspacePrincipals).any fun p =>
      p.get "workspace_id" == m.get "workspace_id" && p.get "membership_id" == m.get "id") &&
    (st .apiKeys).all fun k => (st .workspacePrincipals).any fun p =>
      p.get "workspace_id" == k.get "workspace_id" && p.get "api_key_id" == k.get "id"

/-- `consistentTarget`: today's constraints plus source coverage. -/
def consistentTarget (st : State) : Bool := consistent st && everySourceHasPrincipal st

/-! ## Lemmas on consistent states

The `er-core` unit keeps its helper lemmas private to its theorem files, so the ones the identity
theorems need are stated here, once, for `catalogue`. They are not catalogue entries (no
`@[aw_spec]`); the tiered theorems in `Theorems/*/ConceptIdentity.lean` are. -/

namespace Lemmas

theorem table_consistent {S : Schema} {st : State} (hc : Er.Core.consistent S st = true)
    (t : TableName) : tableConsistent S st t = true :=
  List.all_eq_true.mp hc t (WireEnum.complete t)

theorem get_eq_of_project_eq {r1 r2 : Row} {cs : List String} {c : String}
    (hc : c ∈ cs) (h : r1.project cs = r2.project cs) : r1.get c = r2.get c :=
  (List.map_inj_left.mp h) c hc

theorem project_eq_of_subset {r1 r2 : Row} {cs ds : List String}
    (hsub : ∀ d ∈ ds, d ∈ cs) (h : r1.project cs = r2.project cs) :
    r1.project ds = r2.project ds :=
  List.map_inj_left.mpr fun d hd => get_eq_of_project_eq (hsub d hd) h

theorem present_of_subset {r : Row} {cs ds : List String} (hsub : ∀ d ∈ ds, d ∈ cs)
    (h : r.present cs = true) : r.present ds = true := by
  simp only [Row.present, List.all_eq_true] at h ⊢
  exact fun d hd => h d (hsub d hd)

theorem key_holds_elim {rows : List Row} {cols : List String}
    (h : keyHolds rows cols [] = true) {r1 r2 : Row} (h1 : r1 ∈ rows) (h2 : r2 ∈ rows)
    (hp : r1.present cols = true) (he : r1.project cols = r2.project cols) : r1 = r2 := by
  simp only [keyHolds, List.all_nil] at h
  rw [List.filter_eq_self.mpr (fun _ _ => rfl), List.all_eq_true] at h
  have := h r1 h1
  simp only [hp, Bool.not_true, Bool.false_or, List.all_eq_true] at this
  have := this r2 h2
  simp only [he, bne_self_eq_false, Bool.false_or, beq_iff_eq] at this
  exact this

/-- Two rows of table `t` that agree on a set of columns covering a key of `t` are the same row. -/
theorem unique_of_covers {st : State} (hc : Er.Core.consistent catalogue st = true)
    {t : TableName} {cols : List String} (hk : coversKey t cols = true) {r1 r2 : Row}
    (h1 : r1 ∈ st t) (h2 : r2 ∈ st t) (hp : r1.present cols = true)
    (he : r1.project cols = r2.project cols) : r1 = r2 := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  simp only [coversKey, Bool.or_eq_true, List.all_eq_true, List.any_eq_true, Bool.and_eq_true,
    List.isEmpty_iff, List.contains_iff_mem] at hk
  rcases hk with hpk | ⟨u, hu, hpn, hcols⟩
  · exact key_holds_elim h.1.1.1.2 h1 h2 (present_of_subset hpk hp) (project_eq_of_subset hpk he)
  · have hkey := h.1.1.2 u hu
    rw [hpn] at hkey
    exact key_holds_elim hkey h1 h2 (present_of_subset hcols hp) (project_eq_of_subset hcols he)

theorem fk_parent {st : State} (hc : Er.Core.consistent catalogue st = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (catalogue t).foreignKeys) {r : Row}
    (hr : r ∈ st t) (hp : r.present fk.columns = true) :
    ∃ r' ∈ st fk.refTable, r'.project fk.refColumns = r.project fk.columns := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have := List.all_eq_true.mp (h.1.2 fk hfk) r hr
  simp only [hp, Bool.not_true, Bool.false_or, List.any_eq_true, beq_iff_eq] at this
  exact this

theorem not_null_present {st : State} (hc : Er.Core.consistent catalogue st = true)
    {t : TableName} {cols : List String} (hnn : cols.all (catalogue t).isNotNull = true) {r : Row}
    (hr : r ∈ st t) : r.present cols = true := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  simp only [Row.present, List.all_eq_true] at hnn ⊢
  intro c hcm
  obtain ⟨col, hcol, hc'⟩ := List.any_eq_true.mp (hnn c hcm)
  simp only [Bool.and_eq_true, beq_iff_eq] at hc'
  have := h.1.1.1.1 col hcol
  simp only [notNullHolds, hc'.2, Bool.not_true, Bool.false_or, List.all_eq_true] at this
  rw [← hc'.1]
  exact this r hr

/-- A referencing row has exactly one parent, when the referenced columns cover a key of the
parent. -/
theorem exactly_one_parent {st : State} (hc : Er.Core.consistent catalogue st = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (catalogue t).foreignKeys)
    (hk : coversKey fk.refTable fk.refColumns = true) {r : Row} (hr : r ∈ st t)
    (hp : r.present fk.columns = true) :
    ∃ r' ∈ st fk.refTable, r'.project fk.refColumns = r.project fk.columns ∧
      ∀ r'' ∈ st fk.refTable, r''.project fk.refColumns = r.project fk.columns → r'' = r' := by
  obtain ⟨r', hr', he⟩ := fk_parent hc hfk hr hp
  refine ⟨r', hr', he, fun r'' hr'' he'' => ?_⟩
  have hlen : fk.refColumns.length = fk.columns.length := by
    have := congrArg List.length he
    simpa [Row.project] using this
  have hpres : r''.present fk.refColumns = true := by
    simp only [Row.present, List.all_eq_true]
    intro c hcm
    obtain ⟨i, hi, rfl⟩ := List.getElem_of_mem hcm
    have := congrArg (·[i]?) he''
    simp only [Row.project, List.getElem?_map, List.getElem?_eq_getElem hi,
      List.getElem?_eq_getElem (hlen ▸ hi), Option.map_some, Option.some.injEq] at this
    rw [this]
    simp only [Row.present, List.all_eq_true] at hp
    exact hp _ (List.getElem_mem _)
  exact unique_of_covers hc hk hr'' hr' hpres (he''.trans he.symm)

/-- A child row whose key names parent columns `pairs` carries, in each paired column, the
parent's value. -/
theorem get_eq_of_mem_pairs {r r' : Row} :
    ∀ {cs rcs : List String} {c rc : String},
      (c, rc) ∈ cs.zip rcs → r'.project rcs = r.project cs → r'.get rc = r.get c
  | [], _, _, _, h, _ => by simp at h
  | _ :: _, [], _, _, h, _ => by simp at h
  | x :: xs, y :: ys, c, rc, h, hp => by
    simp only [Row.project, List.map_cons, List.cons.injEq] at hp
    simp only [List.zip_cons_cons, List.mem_cons, Prod.mk.injEq] at h
    rcases h with ⟨rfl, rfl⟩ | h
    · exact hp.1
    · exact get_eq_of_mem_pairs h hp.2

/-- Through a key that pairs the child's column `c` with the parent's `id` and the two
`workspace_id` columns, any parent row whose `id` is the child's `c` is in the child's
workspace: the key pins one parent row in that workspace, and `id` is the parent's primary key. -/
theorem paired_parent_same_workspace {st : State} (hc : Er.Core.consistent catalogue st = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (catalogue t).foreignKeys) {c : String}
    (hpair : ((c, "id") ∈ fk.pairs ∧ ("workspace_id", "workspace_id") ∈ fk.pairs) ∧
      (catalogue fk.refTable).primaryKey = ["id"]) {r p : Row} (hr : r ∈ st t)
    (hpres : r.present fk.columns = true) (hp : p ∈ st fk.refTable)
    (hid : p.get "id" = r.get c) : p.get "workspace_id" = r.get "workspace_id" := by
  obtain ⟨⟨h1, h2⟩, hpk⟩ := hpair
  obtain ⟨p', hp', he⟩ := fk_parent hc hfk hr hpres
  have hid' : p'.get "id" = r.get c := get_eq_of_mem_pairs h1 he
  have hws' : p'.get "workspace_id" = r.get "workspace_id" := get_eq_of_mem_pairs h2 he
  have hcpres : (r.get c).isSome = true := by
    simp only [Row.present, List.all_eq_true] at hpres
    exact hpres c (List.of_mem_zip h1).1
  have heq : p = p' := by
    have h := table_consistent hc fk.refTable
    simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
    have hkey := h.1.1.1.2
    rw [hpk] at hkey
    exact key_holds_elim hkey hp hp' (by simp [Row.present, hid, hcpres])
      (by simp [Row.project, hid, hid'])
  rw [heq, hws']

end Lemmas

end AgentWorkspace.Er.Current.Identity
