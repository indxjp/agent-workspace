#!/usr/bin/env sh
set -eu

# This is a real-cluster evidence producer, not a fixture. It deliberately refuses a non-kind
# context and mutable image references. It validates the chart lifecycle and policy pre-flight;
# the runtime driver's A.12 scenarios remain a separate live suite.
cluster="${1:-agent-workspace}"
namespace="${VALIDATION_NAMESPACE:-agent-workspace-validation}"
artifact="${VALIDATION_ARTIFACT:-artifacts/kubernetes-chart-lifecycle.json}"

case "$cluster" in *[!a-z0-9-]*|'') echo 'cluster name must match [a-z0-9-]+' >&2; exit 2 ;; esac
case "$namespace" in default|kube-system|kube-public|*[!a-z0-9-]*|'')
  echo 'VALIDATION_NAMESPACE must be a dedicated DNS-label namespace' >&2
  exit 2
  ;;
esac

for dependency in kind kubectl helm; do
  command -v "$dependency" >/dev/null || { echo "$dependency is required" >&2; exit 1; }
done
: "${WEB_IMAGE:?set WEB_IMAGE to an immutable image digest}"
: "${GATEWAY_IMAGE:?set GATEWAY_IMAGE to an immutable image digest}"
: "${RUNNER_MANAGER_IMAGE:?set RUNNER_MANAGER_IMAGE to an immutable image digest}"
: "${RUNTIME_IMAGE:?set RUNTIME_IMAGE to an immutable image digest}"
require_digest() {
  printf '%s\n' "$2" | grep -Eq '@sha256:[0-9a-f]{64}$' || {
    echo "$1 must end in @sha256:<64 lowercase hex>" >&2; exit 2;
  }
}
require_digest WEB_IMAGE "$WEB_IMAGE"
require_digest GATEWAY_IMAGE "$GATEWAY_IMAGE"
require_digest RUNNER_MANAGER_IMAGE "$RUNNER_MANAGER_IMAGE"
require_digest RUNTIME_IMAGE "$RUNTIME_IMAGE"

if ! kind get clusters | grep -Fx "$cluster" >/dev/null; then
  scripts/dev-cluster/up.sh "$cluster"
fi
context="$(kubectl config current-context)"
if [ "$context" != "kind-$cluster" ]; then
  echo "refusing context $context; expected kind-$cluster" >&2
  exit 1
fi

runtime_args=''
if [ -n "${RUNTIME_CLASS_NAME:-}" ]; then
  kubectl get runtimeclass "$RUNTIME_CLASS_NAME" >/dev/null
  runtime_args="--set-string runtimeClassName=$RUNTIME_CLASS_NAME"
fi

wait_for_deployments() {
  for workload in web gateway runner-manager; do
    kubectl -n "$namespace" rollout status "deployment/agent-workspace-$workload" --timeout=10m
  done
}

cleanup() {
  helm uninstall agent-workspace-validation --namespace "$namespace" >/dev/null 2>&1 || true
  kubectl delete namespace "$namespace" --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

helm lint infra/helm/agent-workspace \
  --set-string images.web="$WEB_IMAGE" \
  --set-string images.gateway="$GATEWAY_IMAGE" \
  --set-string images.runnerManager="$RUNNER_MANAGER_IMAGE" \
  --set-string images.runtime.claude-agent-sdk="$RUNTIME_IMAGE"
kubectl create namespace "$namespace"
# shellcheck disable=SC2086 -- runtime_args is either empty or one fixed Helm flag/value pair.
helm upgrade --install agent-workspace-validation infra/helm/agent-workspace \
  --namespace "$namespace" \
  --set-string images.web="$WEB_IMAGE" \
  --set-string images.gateway="$GATEWAY_IMAGE" \
  --set-string images.runnerManager="$RUNNER_MANAGER_IMAGE" \
  --set-string images.runtime.claude-agent-sdk="$RUNTIME_IMAGE" \
  $runtime_args \
  --wait --timeout 10m
wait_for_deployments
kubectl -n "$namespace" get poddisruptionbudget agent-workspace-web >/dev/null

# A changed pod-template annotation forces a real rolling update. Then Helm rollback proves the
# prior revision remains installable; both operations must return every Deployment to Available.
revision="validation-$(date -u +%Y%m%dT%H%M%SZ)"
# shellcheck disable=SC2086 -- see the fixed runtime_args declaration above.
helm upgrade agent-workspace-validation infra/helm/agent-workspace \
  --namespace "$namespace" --reuse-values \
  --set-string rollout.revision="$revision" \
  $runtime_args \
  --wait --timeout 10m
wait_for_deployments
helm rollback agent-workspace-validation 1 --namespace "$namespace" --wait --timeout 10m
wait_for_deployments

# Teardown is part of the lifecycle proof, so run it fail-closed rather than delegating it to the
# best-effort exit trap. Verify both the Helm release and its dedicated namespace are gone before
# publishing evidence that says the lifecycle passed.
helm uninstall agent-workspace-validation --namespace "$namespace" --wait --timeout 10m
release_list="$(
  helm list --namespace "$namespace" --filter '^agent-workspace-validation$' --output json
)"
if [ "$release_list" != '[]' ]; then
  echo 'Helm release still exists after uninstall' >&2
  exit 1
fi
kubectl delete namespace "$namespace" --wait=true --timeout=10m
namespace_list="$(kubectl get namespace "$namespace" --ignore-not-found -o name)"
if [ -n "$namespace_list" ]; then
  echo 'validation namespace still exists after deletion' >&2
  exit 1
fi
trap - EXIT INT TERM

mkdir -p "$(dirname "$artifact")"
cat >"$artifact" <<EOF
{
  "kind": "kubernetes-chart-lifecycle",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "cluster": "$cluster",
  "context": "$context",
  "namespace": "$namespace",
  "webImage": "$WEB_IMAGE",
  "gatewayImage": "$GATEWAY_IMAGE",
  "runnerManagerImage": "$RUNNER_MANAGER_IMAGE",
  "runtimeImage": "$RUNTIME_IMAGE",
  "install": "passed",
  "rollingUpgrade": "passed",
  "rollback": "passed",
  "uninstall": "passed",
  "namespaceCleanup": "passed",
  "a12RuntimeConformance": "not-run"
}
EOF
echo "chart lifecycle passed; evidence written to $artifact"
