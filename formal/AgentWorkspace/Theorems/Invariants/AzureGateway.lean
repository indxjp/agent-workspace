import AgentWorkspace.Behaviour.AzureGateway
import AgentWorkspace.Trace.Spec

namespace AgentWorkspace.Theorems.Invariants.AzureGateway

open AgentWorkspace.Behaviour.AzureGateway

/-- Enabling Dynamic Sessions makes the configured gateway reachable from their sandboxes. -/
@[aw_spec (tier := T2) (doc := "docs/spec.md#a82-control-plane-on-azure-container-apps") (doc := "docs/deploy/azure-container-apps.md#architecture") (ts := "infra/terraform/azure-container-apps/apps.tf#external_enabled")]
theorem dynamic_sessions_reach_configured_gateway :
    reachable .dynamicSession (configuredIngress true) = true := by decide

/-- Internal ingress cannot carry a model request from a Dynamic Session, even with a valid token. -/
@[aw_spec (tier := T2) (doc := "docs/spec.md#a82-control-plane-on-azure-container-apps") (doc := "docs/deploy/azure-container-apps.md#architecture") (ts := "infra/terraform/azure-container-apps/apps.tf#external_enabled")]
theorem internal_ingress_blocks_dynamic_session :
    modelRequestAllowed .dynamicSession .internal true = false := by decide

/-- Public ingress never grants an unauthenticated caller access to a model route. -/
@[aw_spec (tier := T2) (doc := "docs/spec.md#a82-control-plane-on-azure-container-apps") (doc := "docs/deploy/azure-container-apps.md#architecture") (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")]
theorem external_ingress_still_requires_run_token (caller : Caller) :
    modelRequestAllowed caller .external false = false := by cases caller <;> decide

/-- Disabling Dynamic Sessions leaves the gateway internal and reachable to environment apps. -/
@[aw_spec (tier := T2) (doc := "docs/spec.md#a82-control-plane-on-azure-container-apps") (doc := "docs/deploy/azure-container-apps.md#architecture") (ts := "infra/terraform/azure-container-apps/apps.tf#external_enabled")]
theorem no_dynamic_sessions_keep_gateway_internal :
    configuredIngress false = .internal ∧
    reachable .environmentApp (configuredIngress false) = true := by decide

end AgentWorkspace.Theorems.Invariants.AzureGateway
