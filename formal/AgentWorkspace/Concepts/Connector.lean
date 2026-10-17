import AgentWorkspace.Concepts.File

/-!
# Connector — one configured MCP server or tool connector

A **connector** is one row of `mcp_servers` (`packages/core/src/db/schema/mcp-servers.ts`); the
two words name one concept, and `IdKind.connector` is that table. Since migration 0036 a row has a
`kind` (ADR-0113 C15). An `mcp` connector (`Connector`) is reached either by launching a command
(`stdio`) or over a URL (`http`, `sse`), and authenticates with nothing (`none`) or with a
credential sealed as a `secrets` row and referenced by `credential_secret_id`, never stored as a
value (spec §8). A tool connector (`ToolConnector`, kind `openapi` or `postgres`) is a separate
row type: it has no transport, command, arguments or URL, its configuration is the `tool_config`
JSON object, its `auth_type` is pinned to `none`, and a `postgres` connector always names its
credential. The tool connectors a run may call are snapshotted by id into
`runs.tool_connector_ids` (ADR-0113 C16), which `Er.Core` records.

An MCP row's shape is fixed by seven CHECK constraints, which make `command` and `url` a one-of
chosen by the transport and `credential_secret_id` present exactly when the authentication type
needs it; since 0036 they are guarded by `kind <> 'mcp' or …`, and five per-kind checks fix the
tool rows. Whether an `openapi` connector's credential matches its `tool_config.auth` is enforced
by the server, not the database. The wire (`ConnectorResourceSchema`) replaces the secret
reference by `hasCredential`.

`parseCreateConnectorBody` (`apps/web/server/connectors/contract.ts`) is the create-body admission
rule that is meant to establish those invariants before the database sees a row; it is modelled
here exactly, error messages included, so that its relation to the CHECKs is a theorem. Connectors
have no lifecycle states beyond `enabled`, which is `true` at creation and flipped only by the
field update `PATCH /api/connectors/:id` (S-20).
-/

namespace AgentWorkspace.Concepts.Connector

open AgentWorkspace

/-! ## Kind, transport and authentication type -/

/-- `connectorKinds` / `CONNECTOR_KINDS` (ADR-0113 C15), in their `as const` order. -/
@[aw_spec (ts := "packages/core/src/db/schema/mcp-servers.ts#connectorKinds")
  (ts := "packages/contracts/src/connectors.ts#CONNECTOR_KINDS")
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")]
inductive Kind where
  | mcp
  | openapi
  | postgres
  deriving DecidableEq, Repr, Inhabited

/-- The wire and database spelling of a connector kind. -/
def Kind.toWire : Kind → String
  | .mcp => "mcp"
  | .openapi => "openapi"
  | .postgres => "postgres"

instance : WireEnum Kind where
  all := [.mcp, .openapi, .postgres]
  toWire := Kind.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- `mcpTransports` / `CONNECTOR_TRANSPORTS`, in §8's order. -/
@[aw_spec (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpTransports")
  (ts := "packages/contracts/src/connectors.ts#CONNECTOR_TRANSPORTS")
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")]
inductive Transport where
  | stdio
  | http
  | sse
  deriving DecidableEq, Repr, Inhabited

/-- The wire and database spelling of a transport. -/
def Transport.toWire : Transport → String
  | .stdio => "stdio"
  | .http => "http"
  | .sse => "sse"

instance : WireEnum Transport where
  all := [.stdio, .http, .sse]
  toWire := Transport.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- `remoteMcpTransports`: the transports reached over a URL. -/
@[aw_spec (ts := "packages/core/src/db/schema/mcp-servers.ts#remoteMcpTransports")]
def Transport.isRemote : Transport → Bool
  | .stdio => false
  | .http | .sse => true

/-- `mcpAuthTypes` / `CONNECTOR_AUTH_TYPES`: §8's None / API Key / Bearer Token / OAuth. -/
@[aw_spec (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpAuthTypes")
  (ts := "packages/contracts/src/connectors.ts#CONNECTOR_AUTH_TYPES")
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")]
inductive AuthType where
  | none
  | apiKey
  | bearer
  | oauth
  deriving DecidableEq, Repr, Inhabited

/-- The wire and database spelling of an authentication type. -/
def AuthType.toWire : AuthType → String
  | .none => "none"
  | .apiKey => "api-key"
  | .bearer => "bearer"
  | .oauth => "oauth"

instance : WireEnum AuthType where
  all := [.none, .apiKey, .bearer, .oauth]
  toWire := AuthType.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- `credentialedMcpAuthTypes`: every authentication type except `none` needs a credential. -/
@[aw_spec (ts := "packages/core/src/db/schema/mcp-servers.ts#credentialedMcpAuthTypes")]
def AuthType.needsCredential : AuthType → Bool
  | .none => false
  | .apiKey | .bearer | .oauth => true

/-! ## The concept and its checks -/

/-- One `mcp_servers` row of kind `mcp`, typed. `args` is the `jsonb` string list (`McpArgs`);
the row's `kind` is `mcp` and its `tool_config` is `NULL` (`Er.Current.Catalog.connectorRow`). -/
@[aw_spec (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
structure Connector where
  id : ConnectorId
  workspace : WorkspaceId
  name : String
  transport : Transport
  command : Option String
  args : Option (List String)
  url : Option String
  authType : AuthType
  credentialSecret : Option SecretId
  enabled : Bool
  createdBy : Option UserId
  owner : PrincipalId
  deriving DecidableEq, Repr

/-- `url ~ '^https?://'`: the URL is an absolute `http` or `https` endpoint. -/
def urlShape (u : String) : Bool :=
  "http://".toList.isPrefixOf u.toList || "https://".toList.isPrefixOf u.toList

namespace Connector

variable (c : Connector)

/-- `mcp_servers_stdio_has_command`: `(transport = 'stdio') = (command is not null)`. -/
def stdioHasCommand : Bool := (c.transport == .stdio) == c.command.isSome

/-- `mcp_servers_remote_has_url`: `(transport in ('http', 'sse')) = (url is not null)`. -/
def remoteHasUrl : Bool := c.transport.isRemote == c.url.isSome

/-- `mcp_servers_args_are_stdio_only`: `args is null or transport = 'stdio'`. -/
def argsStdioOnly : Bool := c.args.isNone || c.transport == .stdio

/-- `mcp_servers_command_not_blank`. -/
def commandNotBlank : Bool := c.command.all File.notBlank

/-- `mcp_servers_url_shape`: `url is null or url ~ '^https?://'`. -/
def urlShapeOk : Bool := c.url.all urlShape

/-- `mcp_servers_credential_required`: `(auth_type in ('api-key', 'bearer', 'oauth')) =
(credential_secret_id is not null)`. -/
def credentialRequired : Bool := c.authType.needsCredential == c.credentialSecret.isSome

/-- `mcp_servers_name_not_blank`. -/
def nameNotBlank : Bool := File.notBlank c.name

/-- Every `mcp_servers` check holds on the row (the two closed sets hold by the types). -/
@[aw_spec (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")]
def valid : Bool :=
  c.stdioHasCommand && c.remoteHasUrl && c.argsStdioOnly && c.commandNotBlank && c.urlShapeOk &&
    c.credentialRequired && c.nameNotBlank

end Connector

/-- `jsonb_typeof(v) = 'object'`, read on the text PostgreSQL renders a `jsonb` value in: an
object is rendered starting with `{`, and no other JSON value is (an array starts with `[`, a
string with `"`, a number, boolean or `null` with neither). -/
def jsonbObject (s : String) : Bool := s.toList.head? == some '{'

/-- One `mcp_servers` row of a tool kind (ADR-0113 C15), typed: no transport, command, arguments
or URL, `auth_type` `none`, and `toolConfig` the text PostgreSQL renders the `tool_config` `jsonb`
value in (only whether it is an object matters to the checks; the server parses the rest with
the contracts schema). `kind` ranges over every kind so that `valid` can refuse `mcp`. -/
@[aw_spec (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")
  (ts := "packages/core/src/db/repositories/mcp-servers.ts#ToolConnectorRecord")
  (doc := "docs/adr/0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md#sd1--tools-are-catalog-connectors-of-kind-openapi-or-postgres")]
structure ToolConnector where
  id : ConnectorId
  workspace : WorkspaceId
  name : String
  kind : Kind
  toolConfig : String
  credentialSecret : Option SecretId
  enabled : Bool
  createdBy : Option UserId
  owner : PrincipalId
  deriving DecidableEq, Repr

namespace ToolConnector

variable (t : ToolConnector)

/-- Every `mcp_servers` check holds on the tool row: the kind is not `mcp`, the `tool_config` is
a JSON object, a `postgres` connector names its credential, and the name is not blank. -/
@[aw_spec (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")
  (doc := "docs/adr/0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md#sd1--tools-are-catalog-connectors-of-kind-openapi-or-postgres")]
def valid : Bool :=
  t.kind != .mcp && jsonbObject t.toolConfig &&
    (t.kind != .postgres || t.credentialSecret.isSome) && File.notBlank t.name

end ToolConnector

/-- The columns of `mcp_servers`, in declaration order. -/
def dbColumns : List String :=
  ["id", "workspace_id", "name", "kind", "transport", "command", "args", "url", "tool_config",
    "openapi_document", "auth_type", "credential_secret_id", "enabled", "created_by",
    "owner_principal_id", "created_at", "updated_at"]

/-! ## The wire -/

/-- `ConnectorResource`: the connector as every route renders it. The secret reference is
replaced by `hasCredential`; there is no field a credential value could occupy. -/
@[aw_spec (ts := "packages/contracts/src/connectors.ts#ConnectorResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")]
structure Resource where
  id : ConnectorId
  workspace : WorkspaceId
  name : String
  transport : Transport
  command : Option String
  args : Option (List String)
  url : Option String
  authType : AuthType
  hasCredential : Bool
  enabled : Bool
  createdBy : Option UserId
  owner : PrincipalId
  deriving DecidableEq, Repr

/-- The rendering of a row (`toResource` in `apps/web/server/connectors/handlers.ts`). -/
def Connector.toResource (c : Connector) : Resource :=
  { id := c.id, workspace := c.workspace, name := c.name, transport := c.transport,
    command := c.command, args := c.args, url := c.url, authType := c.authType,
    hasCredential := c.credentialSecret.isSome, enabled := c.enabled, createdBy := c.createdBy,
    owner := c.owner }

/-- The keys of `ConnectorResourceSchema`, in declaration order. The resource also describes the
tool connectors (ADR-0113 C15): `kind` follows `name` and a missing `kind` means `mcp`; the
`openapi` and `postgres` configurations close the object, and `transport` and `authType` are
`null` for the tool kinds. -/
@[aw_spec (ts := "packages/contracts/src/connectors.ts#ConnectorResourceSchema")]
def wireFields : List String :=
  ["id", "workspaceId", "name", "kind", "transport", "command", "args", "url", "authType",
    "hasCredential", "enabled", "createdBy", "ownerPrincipalId", "createdAt", "updatedAt",
    "openapi", "postgres"]

/-- The keys of `ConnectorResourceSchema` that may be absent from a resource: `kind` (absent
means `mcp`, so an MCP row renders as before the tool kinds) and the per-kind `openapi` and
`postgres` configurations. Every other key of `wireFields` is always present. -/
@[aw_spec (ts := "packages/contracts/src/connectors.ts#ConnectorResourceSchema")]
def wireOptionalFields : List String := ["kind", "openapi", "postgres"]

/-! ## The create-body admission rule (`parseCreateConnectorBody`) -/

/-- One field of a JSON request body, as far as the parser distinguishes it: absent, `null`, a
string, an array of strings, or anything else. -/
inductive Field where
  | absent
  | null
  | str (s : String)
  | strs (l : List String)
  | other
  deriving DecidableEq, Repr, Inhabited

/-- The fields of a JSON object body the parser reads. -/
structure Body where
  name : Field := .absent
  transport : Field := .absent
  authType : Field := .absent
  command : Field := .absent
  url : Field := .absent
  args : Field := .absent
  credential : Field := .absent
  /-- The connector kind (ADR-0113 C15), read by `admit` before any other field. -/
  kind : Field := .absent
  deriving DecidableEq, Repr, Inhabited

/-- What the parser hands the store (`ParsedCreateConnectorInput`). -/
structure Parsed where
  name : String
  transport : Transport
  command : Option String
  args : Option (List String)
  url : Option String
  authType : AuthType
  credential : Option String
  deriving DecidableEq, Repr

/-- A JavaScript `WhiteSpace` or `LineTerminator` code point: what `String.prototype.trim`
removes. -/
def isJsWhitespace (c : Char) : Bool :=
  [9, 10, 11, 12, 13, 32, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF].contains
      c.toNat ||
    (0x2000 ≤ c.toNat && c.toNat ≤ 0x200A)

/-- `s.trim() === ''`. -/
def jsTrimIsEmpty (s : String) : Bool := s.toList.all isJsWhitespace

/-- A code point `.` does not match in a JavaScript regular expression: a line terminator. -/
def isJsLineTerminator (c : Char) : Bool :=
  c.toNat == 10 || c.toNat == 13 || c.toNat == 0x2028 || c.toNat == 0x2029

/-- `CONNECTOR_NAME_MAX_LENGTH`. -/
@[aw_spec (ts := "packages/contracts/src/connectors.ts#CONNECTOR_NAME_MAX_LENGTH")]
def maxNameLength : Nat := 200

/-- `NAME_PATTERN = /^.{1,200}$/u`: one to 200 code points, none a line terminator. -/
def namePattern (s : String) : Bool :=
  let cs := s.toList
  1 ≤ cs.length && cs.length ≤ maxNameLength && cs.all fun c => !isJsLineTerminator c

/-- `JSON.stringify` of a string: quotes, with `"`, `\`, and the C0 controls escaped (the five
short escapes, else `\u00xx` in lower-case hexadecimal). -/
def jsonQuote (s : String) : String :=
  let hex (n : Nat) : Char := if n < 10 then Char.ofNat (48 + n) else Char.ofNat (87 + n)
  let esc : Char → List Char := fun c =>
    if c == '"' then ['\\', '"']
    else if c == '\\' then ['\\', '\\']
    else if c.toNat == 8 then ['\\', 'b']
    else if c.toNat == 9 then ['\\', 't']
    else if c.toNat == 10 then ['\\', 'n']
    else if c.toNat == 12 then ['\\', 'f']
    else if c.toNat == 13 then ['\\', 'r']
    else if c.toNat < 32 then ['\\', 'u', '0', '0', hex (c.toNat / 16), hex (c.toNat % 16)]
    else [c]
  String.ofList ('"' :: (s.toList.flatMap esc ++ ['"']))

/-- The error `name` contributes. -/
def nameErrors : Field → List String
  | .str s => if namePattern s then [] else
      ["\"name\" must be a non-empty string of at most 200 characters"]
  | _ => ["\"name\" must be a non-empty string of at most 200 characters"]

/-- The transport a `transport` field names, if it is a member's spelling. -/
def transportOf : Field → Option Transport
  | .str s => WireEnum.ofWire? s
  | _ => none

/-- `authTypeRaw ?? 'none'`: an absent or `null` authentication type is `none`. -/
def authFieldOf : Field → Field
  | .absent | .null => .str "none"
  | f => f

/-- The authentication type an (effective) `authType` field names, if any. -/
def authOf : Field → Option AuthType
  | .str s => WireEnum.ofWire? s
  | _ => none

/-- The transport-dependent half: the errors, and the command, arguments and URL kept. -/
def shapeOf (b : Body) : Option Transport →
    List String × Option String × Option (List String) × Option String
  | none => ([], none, none, none)
  | some .stdio =>
    let (e1, cmd) : List String × Option String :=
      match b.command with
      | .str s => if jsTrimIsEmpty s then
          (["\"command\" is required and must be non-blank for a stdio connector"], none)
        else ([], some s)
      | _ => (["\"command\" is required and must be non-blank for a stdio connector"], none)
    let (e2, as) : List String × Option (List String) :=
      match b.args with
      | .absent => ([], none)
      | .strs l => ([], some l)
      | _ => (["\"args\" must be an array of strings"], none)
    let e3 : List String :=
      if b.url == .absent then [] else ["\"url\" is not valid for a stdio connector"]
    (e1 ++ e2 ++ e3, cmd, as, none)
  | some _ =>
    let (e1, u) : List String × Option String :=
      match b.url with
      | .str s => if urlShape s then ([], some s) else
          (["\"url\" is required and must be an absolute http(s) URL for a remote connector"],
            none)
      | _ => (["\"url\" is required and must be an absolute http(s) URL for a remote connector"],
          none)
    let e2 : List String :=
      if b.command == .absent then [] else ["\"command\" is not valid for a remote connector"]
    let e3 : List String :=
      if b.args == .absent then [] else ["\"args\" is not valid for a remote connector"]
    (e1 ++ e2 ++ e3, none, none, u)

/-- The credential half: the errors, and the credential kept. `authField` is the effective
`authType` field; a string other than `none` (even one that is not a member) demands a
non-blank credential, and anything else refuses one. -/
def credentialOf (authField credential : Field) : List String × Option String :=
  match authField with
  | .str a =>
    if a != "none" then
      match credential with
      | .str s => if jsTrimIsEmpty s then
          (["\"credential\" is required when \"authType\" is " ++ jsonQuote a], none)
        else ([], some s)
      | _ => (["\"credential\" is required when \"authType\" is " ++ jsonQuote a], none)
    else if credential == .absent then ([], none)
    else (["\"credential\" must not be supplied when \"authType\" is \"none\""], none)
  | _ =>
    if credential == .absent then ([], none)
    else (["\"credential\" must not be supplied when \"authType\" is \"none\""], none)

/-- `parseCreateConnectorBody`: `none` for a body that is not a JSON object, else the ordered
error list or the parsed input, exactly as the TypeScript computes them. -/
@[aw_spec (ts := "apps/web/server/connectors/contract.ts#parseCreateConnectorBody")
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")]
def parseBody : Option Body → Except (List String) Parsed
  | none => .error ["the request body must be a JSON object"]
  | some b =>
    let t? := transportOf b.transport
    let transportErr : List String :=
      if t?.isSome then [] else ["\"transport\" must be one of stdio, http, sse"]
    let a? := authOf (authFieldOf b.authType)
    let authErr : List String :=
      if a?.isSome then [] else ["\"authType\" must be one of none, api-key, bearer, oauth"]
    let shape := shapeOf b t?
    let cred := credentialOf (authFieldOf b.authType) b.credential
    match nameErrors b.name ++ transportErr ++ authErr ++ shape.1 ++ cred.1, b.name, t?, a? with
    | [], .str n, some t, some a =>
      .ok { name := n, transport := t, command := shape.2.1, args := shape.2.2.1,
            url := shape.2.2.2, authType := a, credential := cred.2 }
    | [], _, _, _ => .error ["unreachable"]
    | e :: es, _, _, _ => .error (e :: es)

/-! ## The kind admission (`connectorKindOfBody`, ADR-0113 C15) -/

/-- `KIND_ERROR`: the one error a create body gets when its `kind` names no connector kind. -/
@[aw_spec (ts := "apps/web/server/connectors/contract.ts#KIND_ERROR")]
def kindError : String := "\"kind\" must be one of mcp, openapi, postgres"

/-- The kind a create body's `kind` field selects: an absent field is `mcp`, a member's exact
spelling is that member, and anything else (`null`, another string, a non-string) is none. -/
def kindOf : Field → Option Kind
  | .absent => some .mcp
  | .str s => WireEnum.ofWire? s
  | _ => none

/-- What admission hands on: an MCP body parsed by the unchanged MCP rule, or a tool kind whose
own schema (`admitToolConnector` in `apps/web/server/connectors/tools.ts`) decides the rest. -/
inductive Admission where
  | mcp (p : Parsed)
  | tool (k : Kind)
  deriving DecidableEq, Repr

/-- The create-body admission: `connectorKindOfBody` first, then for `mcp` the MCP rule
`parseCreateConnectorBody` (`parseBody`); a tool kind is handed on without reading another field,
and a `kind` naming no connector kind is refused with `kindError` alone. A body that is not a
JSON object takes the MCP rule, which refuses it. -/
@[aw_spec (ts := "apps/web/server/connectors/contract.ts#connectorKindOfBody")
  (ts := "apps/web/server/connectors/contract.ts#parseCreateConnectorBody")
  (doc := "docs/adr/0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md#sd1--tools-are-catalog-connectors-of-kind-openapi-or-postgres")]
def admit : Option Body → Except (List String) Admission
  | none => (parseBody none).map .mcp
  | some b =>
    match kindOf b.kind with
    | some .mcp => (parseBody (some b)).map .mcp
    | some k => .ok (.tool k)
    | none => .error [kindError]

/-- The row the store writes for a parsed body: the credential, when there is one, sealed as the
secret `sid`. -/
def Parsed.toConnector (p : Parsed) (id : ConnectorId) (ws : WorkspaceId) (sid : SecretId)
    (createdBy : Option UserId) (owner : PrincipalId) : Connector :=
  { id, workspace := ws, name := p.name, transport := p.transport, command := p.command,
    args := p.args, url := p.url, authType := p.authType,
    credentialSecret := p.credential.map fun _ => sid, enabled := true, createdBy, owner }

end AgentWorkspace.Concepts.Connector
