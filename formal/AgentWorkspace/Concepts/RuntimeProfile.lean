import AgentWorkspace.Concepts.ModelConnection

/-!
# The runtime-profile concept (and the runtime connection it may name)

A **runtime profile** is a named, reusable description of *where and within which limits* an
agent's runs execute: a driver, optional sizing, a required network policy, a required
filesystem mode, timeouts, and a per-driver escape hatch (`driverConfig`). Spec §15.1 defines it;
the database knows it as a row of `runtime_profiles`
(`packages/core/src/db/schema/runtime-profiles.ts`); the wire knows it as
`RuntimeProfileResourceSchema` (`packages/contracts/src/runtimes.ts`). An agent refers to a profile;
it never copies one.

A **runtime connection** is the endpoint and credential a driver needs to reach a cluster, session
pool or registry (spec §14.9: "endpoint + credentials, stored as a secret"). It has no table: it is
a `secrets` row whose name encodes the driver (`RUNTIME_CONNECTION__<DRIVER>__<LABEL>`) and whose
value is the sealed JSON `{endpoint, credential}`. `runtime_profiles.runtime_connection_id`
references `secrets.id`. The encoding and its partial inverse are modelled here over character
lists, as `apps/web/server/runtimes/connections.ts` implements them **for ASCII labels**: the model
upper-cases ASCII only, while JavaScript's `toUpperCase` is Unicode-aware (`ß` becomes `SS`, the
dotless `ı` becomes `I`, the ligature `ﬁ` becomes `FI`). For a label outside ASCII the model and
the code can disagree; `jsUpperCaseDivergences` records the known cases and the Meta theorems state
the restriction.

**Numbers.** The wire carries JavaScript numbers; the model reads one as a decimal
`mantissa · 10^-exponent`, which is exact for every literal a request can carry. The columns are
PostgreSQL `integer` (32-bit), so the model also states what the column accepts.

**The workspace default.** At most one profile per workspace carries the default mark
(`workspace_default`, issue #504); an agent version that names no runtime profile resolves to it
when the version is applied. The mark is `true` or `NULL`, never `false`, so the plain unique key
on `(workspace_id, workspace_default)` admits at most one marked profile per workspace.

**States.** A profile has no stored status. Transitions belong to the behaviour phase.
-/

namespace AgentWorkspace.Concepts.RuntimeProfile

open AgentWorkspace

/-! ## Closed sets -/

/-- The runtime drivers (`runtimeProfileDrivers`, `RUNTIME_DRIVERS`), in spec §14.2 order. -/
@[aw_spec (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfileDrivers")
  (ts := "packages/contracts/src/runtimes.ts#RUNTIME_DRIVERS")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
inductive Driver where
  | local
  | sandboxRuntime
  | docker
  | kubernetes
  | gkeAgentSandbox
  | acaSessions
  | awsAgentcore
  | awsEcs
  | cloudRunSandbox
  | cloudRunService
  | external
  | vercelSandbox
  | cloudflareSandbox
  deriving DecidableEq, Repr, Inhabited

/-- The wire and column spelling of a driver. -/
def Driver.toWire : Driver → String
  | .local => "local"
  | .sandboxRuntime => "sandbox-runtime"
  | .docker => "docker"
  | .kubernetes => "kubernetes"
  | .gkeAgentSandbox => "gke-agent-sandbox"
  | .acaSessions => "aca-sessions"
  | .awsAgentcore => "aws-agentcore"
  | .awsEcs => "aws-ecs"
  | .cloudRunSandbox => "cloud-run-sandbox"
  | .cloudRunService => "cloud-run-service"
  | .external => "external"
  | .vercelSandbox => "vercel-sandbox"
  | .cloudflareSandbox => "cloudflare-sandbox"

instance : WireEnum Driver where
  all := [.local, .sandboxRuntime, .docker, .kubernetes, .gkeAgentSandbox, .acaSessions,
    .awsAgentcore, .awsEcs, .cloudRunSandbox, .cloudRunService, .external,
    .vercelSandbox, .cloudflareSandbox]
  toWire := Driver.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

/-- What a runtime may reach over the network (`runtimeProfileNetworkPolicies`,
`RUNTIME_NETWORK_POLICIES`). -/
@[aw_spec (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfileNetworkPolicies")
  (ts := "packages/contracts/src/runtimes.ts#RUNTIME_NETWORK_POLICIES")
  (doc := "docs/sdk/site/concepts/data-plane.mdx#what-never-changes")]
inductive NetworkPolicy where
  | none
  | restricted
  | «open»
  deriving DecidableEq, Repr, Inhabited

/-- The wire spelling of a network policy. -/
def NetworkPolicy.toWire : NetworkPolicy → String
  | .none => "none"
  | .restricted => "restricted"
  | .«open» => "open"

instance : WireEnum NetworkPolicy where
  all := [.none, .restricted, .«open»]
  toWire := NetworkPolicy.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

/-- Whether the working tree is writable (`runtimeProfileFilesystems`, `RUNTIME_FILESYSTEM_MODES`). -/
@[aw_spec (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfileFilesystems")
  (ts := "packages/contracts/src/runtimes.ts#RUNTIME_FILESYSTEM_MODES")]
inductive Filesystem where
  | readOnly
  | readWrite
  deriving DecidableEq, Repr, Inhabited

/-- The wire spelling of a filesystem mode. -/
def Filesystem.toWire : Filesystem → String
  | .readOnly => "read-only"
  | .readWrite => "read-write"

instance : WireEnum Filesystem where
  all := [.readOnly, .readWrite]
  toWire := Filesystem.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

/-! ## Numbers and bounds -/

/-- A number as a request carries it: `mantissa · 10^-exponent`. -/
structure Decimal where
  mantissa : Int
  exponent : Nat := 0
  deriving DecidableEq, Repr, Inhabited

/-- The number is greater than zero. -/
def Decimal.isPositive (d : Decimal) : Bool := decide (0 < d.mantissa)

/-- The number is a whole number. -/
def Decimal.isInteger (d : Decimal) : Bool := d.mantissa % ((10 : Int) ^ d.exponent) == 0

/-- The whole part (exact when `isInteger`). -/
def Decimal.toInt (d : Decimal) : Int := d.mantissa / ((10 : Int) ^ d.exponent)

/-- `Number.MAX_SAFE_INTEGER`, the ceiling `RUNTIME_PROFILE_BOUNDS` uses. -/
@[aw_spec (ts := "packages/contracts/src/runtimes.ts#RUNTIME_PROFILE_BOUNDS")]
def maxSafeInteger : Int := 9007199254740991

/-- The largest value of a PostgreSQL `integer` column. -/
def int4Max : Int := 2147483647

/-- The smallest value of a PostgreSQL `integer` column. -/
def int4Min : Int := -2147483648

/-- `RUNTIME_PROFILE_BOUNDS.cpu`: greater than zero; fractions are allowed. -/
@[aw_spec (ts := "packages/contracts/src/runtimes.ts#RUNTIME_PROFILE_BOUNDS")
  (ts := "packages/core/src/schemas.ts#RuntimeProfile")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
def cpuAccepted (d : Decimal) : Bool := d.isPositive

/-- `RUNTIME_PROFILE_BOUNDS` for `memoryMb`, `diskMb`, `timeoutSeconds` and `idleTimeoutSeconds`:
a whole number in `[1, MAX_SAFE_INTEGER]`. -/
@[aw_spec (ts := "packages/contracts/src/runtimes.ts#RUNTIME_PROFILE_BOUNDS")
  (ts := "packages/core/src/schemas.ts#RuntimeProfile")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
def sizeAccepted (d : Decimal) : Bool :=
  d.isInteger && decide (1 ≤ d.toInt) && decide (d.toInt ≤ maxSafeInteger)

/-- What a PostgreSQL `integer` column stores without an error: a whole number in the 32-bit range. -/
def integerColumnAccepts (d : Decimal) : Bool :=
  d.isInteger && decide (int4Min ≤ d.toInt) && decide (d.toInt ≤ int4Max)

/-! ## The stored row -/

/-- One `runtime_profiles` row as the concept knows it (sizing as the `integer` columns store
it; the three `jsonb` columns as present or absent). -/
@[aw_spec (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")
  (doc := "docs/spec.md#151-profile-schema")]
structure RuntimeProfile where
  id : RuntimeProfileId
  workspace : WorkspaceId
  name : String
  driver : Driver
  runtimeConnection : Option SecretId
  cpu : Option Int := none
  memoryMb : Option Int := none
  diskMb : Option Int := none
  networkPolicy : NetworkPolicy
  allowedDomains : Option (List String) := none
  filesystem : Filesystem
  persistPaths : Option (List String) := none
  timeoutSeconds : Option Int := none
  idleTimeoutSeconds : Option Int := none
  hasDriverConfig : Bool := false
  /-- Whether this is its workspace's default runtime profile (`workspace_default`, issue #504):
  stored `true` when it is and `NULL` otherwise, never `false`. -/
  workspaceDefault : Bool := false
  createdAt : String
  updatedAt : String
  deriving DecidableEq, Repr, Inhabited

/-- `runtime_profiles_name_not_blank`. -/
def RuntimeProfile.valid (p : RuntimeProfile) : Bool := Secret.sqlNotBlank p.name

/-- The profile name the contract accepts (`z.string().min(1)`): any non-empty string, blank or
not. -/
@[aw_spec (ts := "packages/core/src/schemas.ts#RuntimeProfile")
  (ts := "packages/contracts/src/runtimes.ts#RuntimeProfileResourceSchema")]
def nameAcceptedByContract (s : String) : Bool := !s.isEmpty

/-- The fields `POST /api/runtime-profiles` accepts: every member of spec §15.1's `RuntimeProfile`
but the server-assigned `id`. -/
@[aw_spec (ts := "packages/core/src/schemas.ts#CreateRuntimeProfileInput")
  (doc := "docs/spec.md#151-profile-schema")]
def createFields : List String :=
  ["name", "driver", "runtimeConnectionId", "cpu", "memoryMb", "diskMb", "networkPolicy",
    "allowedDomains", "filesystem", "persistPaths", "timeoutSeconds", "idleTimeoutSeconds",
    "driverConfig"]

/-- The fields `POST /api/runtime-profiles` requires (spec §15.1's non-optional members). -/
@[aw_spec (ts := "packages/core/src/schemas.ts#CreateRuntimeProfileInput")
  (doc := "docs/spec.md#151-profile-schema")]
def requiredCreateFields : List String := ["name", "driver", "networkPolicy", "filesystem"]

/-- `CreateRuntimeProfileInput` (a `.strict()` object) over the keys of a body, each present value
valid: closed, with the four required members. -/
@[aw_spec (ts := "packages/core/src/schemas.ts#CreateRuntimeProfileInput")
  (ts := "apps/web/server/runtimes/contract.ts#parseCreateRuntimeProfileInput")]
def createAccepts (keys : List String) : Bool :=
  Secret.closedBodyAccepts createFields requiredCreateFields keys

/-- The fields `PATCH /api/runtime-profiles/:id` accepts: `UpdateRuntimeProfileInput` is
`CreateRuntimeProfileInput.partial()`, so every creatable field and nothing else. -/
@[aw_spec (ts := "packages/core/src/schemas.ts#UpdateRuntimeProfileInput")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
def updateFields : List String := createFields

/-- The profile fields that may be absent (`null` on the resource): every creatable field the create
body does not require. -/
def nullableFields : List String := createFields.filter (!requiredCreateFields.contains ·)

/-- A value a `PATCH` body carries for one key: JSON `null`, or a value valid for that field. -/
inductive PatchValue where
  | null
  | value
  deriving DecidableEq, Repr, Inhabited

/-- The fields whose `null` is itself a value rather than a clear: a profile reads back
`allowedDomains: null` for "no domains", so a `PATCH` may send that value back (BH061-080). -/
@[aw_spec (ts := "packages/core/src/schemas.ts#UpdateRuntimeProfileInput")]
def nullAsValueFields : List String := ["allowedDomains"]

/-- Today's `PATCH /api/runtime-profiles/:id` (`UpdateRuntimeProfileInput`, whose members are
`.optional()` and so refuse `null`): every key is an updatable field carrying a value; `null`
is refused for every field except where `null` is itself a value (`nullAsValueFields`), so a
nullable field can be changed but not cleared. -/
@[aw_spec (ts := "packages/core/src/schemas.ts#UpdateRuntimeProfileInput")
  (ts := "apps/web/server/runtimes/contract.ts#parseUpdateRuntimeProfilePatch")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
def patchAcceptsCurrent (body : List (String × PatchValue)) : Bool :=
  body.all fun (k, v) => updateFields.contains k && (v == .value || nullAsValueFields.contains k)

/-- The fields roadmap S-19 lets a `PATCH` clear: "the nullable sizing fields and
`runtimeConnectionId`", read as the sizing and timeout members. Whether `allowedDomains`,
`persistPaths` and `driverConfig` are meant too the row does not say. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#8-server-changes-this-specification-requires")]
def s19ClearableFields : List String :=
  ["runtimeConnectionId", "cpu", "memoryMb", "diskMb", "timeoutSeconds", "idleTimeoutSeconds"]

/-- The documented target (roadmap S-19): `null` clears a field S-19 names; every other field still
cannot be cleared, and a field whose `null` is a value accepts it as today. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#8-server-changes-this-specification-requires")]
def patchAcceptsTarget (body : List (String × PatchValue)) : Bool :=
  body.all fun (k, v) =>
    updateFields.contains k &&
      (v == .value || s19ClearableFields.contains k || nullAsValueFields.contains k)

/-! ## The pinned image rule -/

/-- A lower-case hexadecimal digit (`[0-9a-f]`). -/
def isLowerHex (c : Char) : Bool := ('0' ≤ c && c ≤ '9') || ('a' ≤ c && c ≤ 'f')

/-- A character the regular-expression `.` does not match: LF, CR, LS, PS. -/
def isRegexLineTerminator (c : Char) : Bool :=
  c.toNat == 0x0A || c.toNat == 0x0D || c.toNat == 0x2028 || c.toNat == 0x2029

/-- `/^.+@sha256:[0-9a-f]{64}$/u`: a non-empty single-line reference, then `@sha256:`, then exactly
64 lower-case hexadecimal digits at the very end. -/
@[aw_spec (ts := "apps/web/server/runtimes/contract.ts#parseCreateRuntimeProfileInput")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
def isSha256Pinned (s : String) : Bool :=
  let cs := s.toList
  let n := cs.length
  decide (73 ≤ n) && (cs.take (n - 72)).all (!isRegexLineTerminator ·) &&
    ((cs.drop (n - 72)).take 8 == "@sha256:".toList) && (cs.drop (n - 64)).all isLowerHex

/-- What a create body's `driverConfig.image` holds. -/
inductive Image where
  /-- No `driverConfig`, or no `image` key in it. -/
  | absent
  /-- A string. -/
  | text (s : String)
  /-- Any other JSON value (a number, an object, `null`, …). -/
  | nonText
  deriving DecidableEq, Repr, Inhabited

/-- `parseCreateRuntimeProfileInput`'s image rule: an absent image passes, a string must be
`sha256`-pinned, anything else is refused. The driver is an argument because the error message
speaks of "non-local runtime profiles"; the rule does not read it. -/
@[aw_spec (ts := "apps/web/server/runtimes/contract.ts#parseCreateRuntimeProfileInput")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
def createImageAccepted (_driver : Driver) : Image → Bool
  | .absent => true
  | .text s => isSha256Pinned s
  | .nonText => false

/-- The field names of `RuntimeProfileResourceSchema`. -/
@[aw_spec (ts := "packages/contracts/src/runtimes.ts#RuntimeProfileResourceSchema")]
def resourceFields : List String :=
  ["id", "workspaceId", "name", "driver", "runtimeConnectionId", "cpu", "memoryMb", "diskMb",
    "networkPolicy", "allowedDomains", "filesystem", "persistPaths", "timeoutSeconds",
    "idleTimeoutSeconds", "driverConfig", "createdAt", "updatedAt"]

/-! ## Runtime connections: the secret-name encoding -/

/-- The field names of `RuntimeConnectionResourceSchema`: no endpoint, no credential. -/
@[aw_spec (ts := "packages/contracts/src/runtimes.ts#RuntimeConnectionResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
def connectionResourceFields : List String := ["id", "name", "driver", "createdAt"]

/-- The fields `POST /api/runtime-connections` takes; `endpoint` and `credential` are sealed. -/
@[aw_spec (ts := "apps/web/server/runtimes/connections.ts#parseCreateRuntimeConnectionInput")]
def connectionCreateFields : List String := ["name", "driver", "endpoint", "credential"]

/-- The fields `POST /api/runtime-connections` requires: all four. -/
@[aw_spec (ts := "apps/web/server/runtimes/connections.ts#parseCreateRuntimeConnectionInput")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
def connectionCreateRequiredFields : List String := ["name", "driver", "endpoint", "credential"]

/-- `parseCreateRuntimeConnectionInput` over the keys of a body (each present value valid): it
requires its four fields and, unlike the other configuration request parsers, is open: it ignores
every other key. -/
@[aw_spec (ts := "apps/web/server/runtimes/connections.ts#parseCreateRuntimeConnectionInput")]
def connectionCreateAccepts (keys : List String) : Bool :=
  Secret.openBodyAccepts connectionCreateRequiredFields keys

/-- The value rule for a runtime connection's `name` and `endpoint`: not blank after JavaScript's
`trim`. -/
@[aw_spec (ts := "apps/web/server/runtimes/connections.ts#parseCreateRuntimeConnectionInput")]
def connectionTextAccepted (s : String) : Bool := !ModelConnection.isBlank s

/-- The value rule for a runtime connection's `credential`: any non-empty string. -/
@[aw_spec (ts := "apps/web/server/runtimes/connections.ts#parseCreateRuntimeConnectionInput")]
def connectionCredentialAccepted (s : String) : Bool := !s.isEmpty

/-- A character of `secrets.name`'s alphabet after the first: `A-Z`, `0-9`. -/
def isUpperAlnum (c : Char) : Bool := ('A' ≤ c && c ≤ 'Z') || ('0' ≤ c && c ≤ '9')

/-- `encodeSegment`: upper-case, then every character outside `A-Z0-9` becomes `_`. -/
@[aw_spec (ts := "apps/web/server/runtimes/connections.ts#encodeSegment")]
def encodeSegment (cs : List Char) : List Char :=
  cs.map fun c => let u := Secret.upperAscii c; if isUpperAlnum u then u else '_'

/-- A label the encoding model is faithful on: every character is ASCII. -/
def isAsciiLabel (label : String) : Bool := label.toList.all fun c => c.toNat < 128

/-- Labels outside ASCII on which JavaScript's Unicode-aware `toUpperCase` makes the real
`encodeSecretName("docker", label)` differ from the model's ASCII upper-casing: the label and the
name the code stores (`none` when the code refuses the label). -/
@[aw_spec (ts := "apps/web/server/runtimes/connections.ts#encodeSegment")]
def jsUpperCaseDivergences : List (String × Option String) :=
  [("straße", some "RUNTIME_CONNECTION__DOCKER__STRASSE"),
    ("ıd", some "RUNTIME_CONNECTION__DOCKER__ID"),
    ("ﬁle", some "RUNTIME_CONNECTION__DOCKER__FILE")]

/-- `SECRET_NAME_LABEL = /^[A-Z][A-Z0-9_]*$/`. -/
def isLabel : List Char → Bool
  | [] => false
  | c :: rest => Secret.isNameHead c && rest.all Secret.isNameTail

/-- `encodeSecretName(driver, label)`: `RUNTIME_CONNECTION__<DRIVER>__<LABEL>`, or `none` when the
encoded label does not start with a letter or the name exceeds 128 characters. -/
@[aw_spec (ts := "apps/web/server/runtimes/connections.ts#encodeSecretName")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
def encodeSecretName (driver label : String) : Option String :=
  let l := encodeSegment label.toList
  if !isLabel l then none
  else
    let n := Secret.runtimeConnectionPrefix.toList ++ encodeSegment driver.toList ++ ['_', '_'] ++ l
    if n.length ≤ 128 then some (String.ofList n) else none

/-- ASCII lower case, as `toLowerCase` does on ASCII. -/
def lowerAscii (c : Char) : Char := if 'A' ≤ c && c ≤ 'Z' then Char.ofNat (c.toNat + 32) else c

/-- `decodeDriver` over characters: after the prefix, the text up to the first `__`, lower case,
with `_` read back as `-`. -/
def decodeDriverChars (cs : List Char) : Option (List Char) :=
  let p := Secret.runtimeConnectionPrefix.toList
  if p.isPrefixOf cs then
    (Secret.splitAtDoubleUnderscore (cs.drop p.length)).map fun (d, _) =>
      d.map fun c => let l := lowerAscii c; if l == '_' then '-' else l
  else none

/-- `decodeDriver(name)`: the driver half of a runtime-connection secret name, or `none` when the
name is not one. Nothing checks that the result is a known driver. -/
@[aw_spec (ts := "apps/web/server/runtimes/connections.ts#decodeDriver")]
def decodeDriver (name : String) : Option String :=
  (decodeDriverChars name.toList).map String.ofList

/-- A decoded driver that names a member of the catalogue. -/
def decodeKnownDriver (name : String) : Option Driver :=
  (decodeDriver name).bind WireEnum.ofWire?

end AgentWorkspace.Concepts.RuntimeProfile
