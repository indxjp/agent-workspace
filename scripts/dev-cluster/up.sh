#!/usr/bin/env sh
set -eu

cluster="${1:-agent-workspace}"
command -v kind >/dev/null || { echo 'kind is required' >&2; exit 1; }
command -v kubectl >/dev/null || { echo 'kubectl is required' >&2; exit 1; }
kind create cluster --name "$cluster" --config scripts/dev-cluster/kind-calico.yaml
kubectl wait --for=condition=Ready node --all --timeout=180s
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.30.2/manifests/calico.yaml
kubectl wait --for=condition=Ready pods --all -n kube-system --timeout=300s

# Fail closed unless the cluster positively enforces a deny-all egress policy.
kubectl create namespace network-policy-proof
kubectl -n network-policy-proof apply -f scripts/dev-cluster/network-policy-proof.yaml
kubectl -n network-policy-proof wait --for=condition=Ready pod/deny-probe --timeout=120s
api_ip="$(kubectl get service kubernetes -o jsonpath='{.spec.clusterIP}')"
if kubectl -n network-policy-proof exec deny-probe -- wget -q -T 3 -O /dev/null "https://$api_ip"; then
  echo 'network policy enforcement pre-flight failed: deny pod reached the API service' >&2
  exit 1
fi
echo 'network policy enforcement pre-flight passed'
