import AgentWorkspace.Theorems.Invariants.AzureGateway
import Vectors.Common

namespace Vectors.AzureGateway

open Lean AgentWorkspace.Behaviour.AzureGateway

private def ingressName : Ingress → String
  | .internal => "internal"
  | .external => "external"

private def ingressVector (enabled : Bool) : Vectors.Vector :=
  { id := if enabled then "dynamic-sessions" else "environment-only",
    input := Json.mkObj [("dynamicSessionsEnabled", toJson enabled)],
    expected := Json.mkObj [("ingress", toJson (ingressName (configuredIngress enabled)))],
    witnesses := [if enabled then
      "AgentWorkspace.Theorems.Invariants.AzureGateway.dynamic_sessions_reach_configured_gateway"
      else "AgentWorkspace.Theorems.Invariants.AzureGateway.no_dynamic_sessions_keep_gateway_internal"] }

def files : List (String × Json) :=
  [("ingress.json", Vectors.file "azure-gateway"
    "Gateway ingress selected for each Dynamic Sessions deployment mode"
    [ingressVector true, ingressVector false])]

end Vectors.AzureGateway
