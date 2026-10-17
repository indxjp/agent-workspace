/-! The Azure ingress decision is a deployment input; reachability assumes Azure's documented
boundary between a Container Apps environment and Dynamic Sessions. Authentication starts after
the HTTP request reaches the gateway. -/

namespace AgentWorkspace.Behaviour.AzureGateway

inductive Caller where
  | environmentApp
  | dynamicSession
  deriving DecidableEq, Repr

inductive Ingress where
  | internal
  | external
  deriving DecidableEq, Repr

def configuredIngress (dynamicSessionsEnabled : Bool) : Ingress :=
  if dynamicSessionsEnabled then .external else .internal

def reachable : Caller → Ingress → Bool
  | .environmentApp, _ => true
  | .dynamicSession, .external => true
  | .dynamicSession, .internal => false

/-- A reachable model route still needs successful run-token authentication. -/
def modelRequestAllowed (caller : Caller) (ingress : Ingress)
    (runTokenAuthenticated : Bool) : Bool :=
  reachable caller ingress && runTokenAuthenticated

end AgentWorkspace.Behaviour.AzureGateway
