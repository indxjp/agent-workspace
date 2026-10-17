import AgentWorkspace.Contracts.Runs

/-! The session fields used when a run starts or resumes. The schema validates `resumable` as a
boolean; the server derives it from active status and a known Claude session id. -/

namespace AgentWorkspace.Contracts.Sessions

open AgentWorkspace AgentWorkspace.Contracts.Runs

def statuses : List String := ["active", "archived"]

def resource : JValue → Bool := object
  [("id", stringMin 1), ("workspaceId", stringMin 1), ("agentId", stringMin 1),
   ("userId", nullable (fun j => (Codec.string.decode j).isSome)),
   ("ownerPrincipalId", stringMin 1),
   ("projectId", nullable (fun j => (Codec.string.decode j).isSome)),
   ("engineSessionId", nullable (fun j => (Codec.string.decode j).isSome)),
   ("engine", nullable (enum Engines.engineIds)),
   ("title", nullable (fun j => (Codec.string.decode j).isSome)),
   ("status", enum statuses), ("resumable", fun j => (Codec.bool.decode j).isSome),
   ("createdAt", instant), ("updatedAt", instant)]

def resourceCodec := checked resource
def response : JValue → Bool := object [("session", resource)]
def listResponse : JValue → Bool := object
  [("sessions", fun j => match j with
    | .arr xs => xs.all resource
    | _ => false), ("projectKey", stringMin 1), ("nextCursor", nullable (stringMin 1))]
def responseCodec := checked response
def listResponseCodec := checked listResponse

/-- The server's derived value, which is stronger than schema acceptance. -/
def derivedResumable (status : String) (engineSessionId : Option String) : Bool :=
  status == "active" && engineSessionId.isSome

end AgentWorkspace.Contracts.Sessions
