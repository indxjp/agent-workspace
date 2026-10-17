# ADR-0124 — Kubernetes sandboxes run in the release namespace under a namespaced Role

Status: accepted
Date: 2026-10-08
Decided by: the issue #854 plan (C5), reviewed in the pull request
Scope: `packages/runtime/src/kubernetes.ts`, `apps/runner/src/manager-start.ts`, `infra/helm/agent-workspace` (`serviceaccount.yaml`, `deployments.yaml`, `networkpolicy.yaml`, `horizontalpodautoscalers.yaml`, `runtime.*`, `objectStore.*`, `providers.*`, `kubernetesApi.*`), `packages/cli/src/deploy` (`AW_HELM_VALUES`), `infra/tests/isolation` (the `kind-chart` lane, `kind-deploy.mjs`)

## Context

[ADR-0123](0123-kubernetes-is-an-aw-deploy-target.md) made `aw deploy`
install the chart, but an agent turn could not run on it. The kubernetes runtime driver created a
Namespace per session, which needs a ClusterRole, and the runner manager refused the driver in a
cluster. The chart also opened no route from the gateway to a model provider or from web to an
object store.

## Decision

- The driver has a shared-namespace mode (`namespace` and `fieldManager` options). It creates no
  Namespace: each sandbox is a Pod in the release namespace, with a Service of the Pod's name so the
  runner manager reaches it, `hostAliases` for the gateway's ClusterIP (the Pod has no cluster DNS
  egress), the `agent-workspace/runtime` and `agent-workspace/session` labels, and its own
  NetworkPolicies named for the Pod (`default-deny-egress-<pod>`, `allow-gateway-egress-<pod>`, and
  with an egress proxy `allow-proxy-egress-<pod>` and `egress-proxy-<pod>`). The per-namespace mode
  is unchanged and remains the default.
- The runner manager serves `RUNTIME_DRIVER=kubernetes` from its pod's ServiceAccount token
  (`inClusterKubernetesClient`, no kubeconfig) and refuses to start outside a cluster. The chart
  sets `RUNTIME_KUBERNETES_NAMESPACE` from the pod's namespace and `RUNTIME_GATEWAY_SERVICE`.
- The Role grants only what the driver calls: `get`, `list`, `watch`, `create` and `delete` on
  `pods` and `networkpolicies`, and `get`, `create` and `delete` on `services`. The `pods/log` and
  `serviceaccounts` grants of the per-namespace mode are dropped. Sandboxes run as the
  `agent-runtime` ServiceAccount, which holds no Role and mounts no token.
- The runner manager runs one replica and is outside the HorizontalPodAutoscaler: its allocation
  registry is in the process, so a second replica would not know the first one's sandboxes.
- The policy set grows to let a turn through: gateway and web to the model providers
  (`providers`), web to the object store (`objectStore`), the runner manager to the Kubernetes API
  (`kubernetesApi`) and to sandbox Pods, and sandbox Pods to the gateway. `database`,
  `objectStore` and `providers` share one `egressTo` helper, so each takes a CIDR or a pod selector.
- `aw deploy` reads an operator values file from `AW_HELM_VALUES` and passes it to Helm between the
  chart's values and its own overlay, so an operator can set what `aw deploy` does not own
  (`providers`, `objectStore`, `runtime.egressProxyImage`).
- A `kind-deploy` CI job installs the chart with `aw deploy`, runs setup (a start, echo and destroy on
  the driver) and one agent turn against an in-cluster fake provider, asserts the session ran in a
  Pod the runner manager created, and runs the isolation cases against Pods it allocates
  (`ISOLATION_LANE=kind-chart`).

## Alternatives

- **A Namespace per session.** Strong isolation, but it needs cluster-wide create and delete on
  Namespaces for a component that handles untrusted code. A namespaced Role bounds the blast radius
  to the release namespace.
- **A separate sandbox namespace.** It would take the sandboxes out of the release's policy set, but
  needs a second Role and Service routing across namespaces. Left as a follow-up; the Role can then
  move there.
- **More manager replicas with a durable registry.** The right end state; a follow-up.

## Consequences

An agent turn runs on the chart, proven on kind. Tool sandboxes are not placed on the kubernetes
driver yet (the manager refuses them with a reason). A sandbox's resources leak if the manager
crashes between creating and recording them; a label reaper is a follow-up. The proof is on kind
under Calico, not on a managed cluster.
