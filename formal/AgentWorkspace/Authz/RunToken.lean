import AgentWorkspace.Contracts.Runs

/-!
Run-scoped gateway credentials and the separate browser-token resolution rule. The HMAC primitive
is an external assumption: this model begins after signature verification has returned its verdict.
It does not claim that arbitrary bytes cannot forge a SHA-256 MAC.
-/

namespace AgentWorkspace.Authz.RunToken

open AgentWorkspace AgentWorkspace.Contracts.Runs

def defaultTtlSeconds : Int := 300
def validTtl (ttl : Int) : Bool := 1 ≤ ttl && ttl ≤ 3600
def nonblank (s : String) : Bool := !Text.isBlank s

structure Subject where
  runId : String
  sessionId : String
  workspaceId : String
  agentId : String
  modelConnectionId : String
  deriving DecidableEq, Repr

def Subject.valid (s : Subject) : Bool :=
  nonblank s.runId && nonblank s.sessionId && nonblank s.workspaceId &&
    nonblank s.agentId && nonblank s.modelConnectionId

structure Claims extends Subject where
  version : Int
  tokenId : String
  issuedAt : Int
  expiresAt : Int
  deriving DecidableEq, Repr

/-- The strict JSON claims schema. `issuedAt` and `expiresAt` use Zod's safe integer range. -/
def claimsShape : JValue → Bool
  | .obj fs =>
    Obj.onlyKeys ["version", "tokenId", "runId", "sessionId", "workspaceId", "agentId",
      "modelConnectionId", "issuedAt", "expiresAt"] fs &&
    ((JValue.lookup "version" fs).bind JValue.asInt? == some 1) &&
    (["tokenId", "runId", "sessionId", "workspaceId", "agentId", "modelConnectionId"].all
      fun name => (JValue.lookup name fs).any fun j =>
        match j with
        | .str s => nonblank s
        | _ => false) &&
    (JValue.lookup "issuedAt" fs).any (fun j => ((Codec.int none none).decode j).isSome) &&
    (JValue.lookup "expiresAt" fs).any (fun j => ((Codec.int none none).decode j).isSome) &&
    (match (JValue.lookup "issuedAt" fs).bind JValue.asInt?,
      (JValue.lookup "expiresAt" fs).bind JValue.asInt? with
      | some issued, some expires => issued < expires
      | _, _ => false)
  | _ => false

def claimsCodec : Codec JValue := checked claimsShape

/-- Issuance rejects blank subject fields and invalid TTL before signing. The injected random id
and clock are not separately validated by `issue`; a bad injected value fails later at verify. -/
def issueClaims (subject : Subject) (tokenId : String) (now ttl : Int) : Option Claims :=
  if subject.valid && validTtl ttl then
    some { toSubject := subject, version := 1, tokenId := tokenId, issuedAt := now, expiresAt := now + ttl }
  else none

inductive Verification where
  | invalid
  | expired
  | valid (claims : Claims)
  deriving DecidableEq, Repr

/-- The signature, JSON and schema verdicts are produced by the real codec. -/
def verifyVerdict (signatureValid claimsValid : Bool) (claims : Claims) (now : Int) : Verification :=
  if !signatureValid || !claimsValid then .invalid
  else if now ≥ claims.expiresAt then .expired
  else .valid claims

structure RegistryEntry where
  workspaceId : String
  runId : String
  tokenId : String
  tokenHash : String
  expiresAt : Int
  revoked : Bool
  deriving DecidableEq, Repr

/-- The tenant-scoped `isActive`: every identity component must match, revocation is absent, and
the stored expiry is strictly later than the read's clock. -/
def isActive (entry : RegistryEntry) (workspaceId runId tokenId tokenHash : String)
    (now : Int) : Bool :=
  entry.workspaceId == workspaceId && entry.runId == runId && entry.tokenId == tokenId &&
    entry.tokenHash == tokenHash && !entry.revoked && now < entry.expiresAt

inductive RevokeOutcome where
  | revoked
  | alreadyRevoked
  | notFound
  deriving DecidableEq, Repr

def revokeOne (entry : Option RegistryEntry) : Option RegistryEntry × RevokeOutcome :=
  match entry with
  | none => (none, .notFound)
  | some row => if row.revoked then (some row, .alreadyRevoked)
    else (some { row with revoked := true }, .revoked)

def revokeForRun (rows : List RegistryEntry) (workspaceId runId : String) :
    List RegistryEntry × Nat :=
  rows.foldr (fun row (acc, count) =>
    if row.workspaceId == workspaceId && row.runId == runId && !row.revoked then
      ({ row with revoked := true } :: acc, count + 1)
    else (row :: acc, count)) ([], 0)

inductive Resolution where
  | active
  | revoked
  | deleted
  | missing
  deriving DecidableEq, Repr

inductive GatewayDecision where
  | allow
  | deny (status : Nat) (code : String)
  deriving DecidableEq, Repr

/-- `authenticateGatewayRequest`'s observable first-failure order. -/
def authenticate (hasBearer : Bool) (verification : Verification)
    (expectedRunId : Option String) (resolution : Resolution) : GatewayDecision :=
  if !hasBearer then .deny 401 "token_missing"
  else match verification with
  | .invalid => .deny 401 "token_invalid"
  | .expired => .deny 401 "token_expired"
  | .valid claims =>
    if expectedRunId.any (· != claims.runId) then .deny 403 "token_run_mismatch"
    else match resolution with
    | .revoked => .deny 401 "token_revoked"
    | .deleted => .deny 410 "run_deleted"
    | .missing => .deny 404 "run_not_found"
    | .active => .allow

def gatewayMessage : String → String
  | "token_missing" => "A gateway run token is required."
  | "token_expired" => "The gateway run token has expired."
  | "token_invalid" => "The gateway run token is invalid."
  | "token_run_mismatch" => "The gateway token belongs to a different run."
  | "token_revoked" => "The gateway run token has been revoked."
  | "run_deleted" => "The run named by this gateway token was deleted."
  | "run_not_found" => "The run named by this gateway token does not exist."
  | _ => ""

def gatewayEnvelope (code : String) : JValue := .obj
  [("type", .str "error"), ("error", .obj
    [("type", .str "authentication_error"), ("code", .str code),
      ("message", .str (gatewayMessage code))])]

structure RunRow where
  id : String
  workspaceId : String
  sessionId : String
  agentId : String
  deriving DecidableEq, Repr

/-- Transcript authentication builds a runner principal only after token registry activity and
the run row's three scoped claims all agree. -/
def runnerPrincipal (active : Bool) (claims : Claims) (run : Option RunRow) : Bool :=
  active && run.any fun row => row.id == claims.runId &&
    row.workspaceId == claims.workspaceId && row.sessionId == claims.sessionId &&
    row.agentId == claims.agentId

inductive BrowserScope where
  | run
  | session
  deriving DecidableEq, Repr

structure BrowserResolutionInput where
  scope : BrowserScope
  tokenFound : Bool
  workspaceFound : Bool
  targetFound : Bool
  runTerminal : Bool
  sessionArchived : Bool
  minterFound : Bool
  deriving DecidableEq, Repr

/-- Today's `resolveBrowserTokenActor`: a terminal run and an archived session both make the
browser token unauthenticated before route-level authorisation. -/
def browserCurrent (input : BrowserResolutionInput) : Bool :=
  input.tokenFound && input.workspaceFound && input.targetFound && input.minterFound &&
    (match input.scope with
    | .run => !input.runTerminal
    | .session => !input.sessionArchived)

/-- For the documented read/follow use, terminal runs remain readable with the same scoped
token. Session archive still ends a session-scoped token. -/
def browserReadTarget (input : BrowserResolutionInput) : Bool :=
  input.tokenFound && input.workspaceFound && input.targetFound && input.minterFound &&
    (match input.scope with
    | .run => true
    | .session => !input.sessionArchived)

end AgentWorkspace.Authz.RunToken
