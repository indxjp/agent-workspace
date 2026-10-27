import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

describe('Helm production controls', () => {
  it('ships health probes and bounded rolling updates for every workload', () => {
    const deployment = read('infra/helm/agent-workspace/templates/deployments.yaml');
    expect(deployment).toContain('startupProbe:');
    expect(deployment).toContain('readinessProbe:');
    expect(deployment).toContain('livenessProbe:');
    expect(deployment).toContain('type: RollingUpdate');
    expect(deployment).toContain('progressDeadlineSeconds:');
    expect(deployment).toContain('agent-workspace.io/rollout-revision:');
    for (const route of ['"/"', '"/health"', '"/healthz"']) expect(deployment).toContain(route);
  });

  it('gates web readiness, and only readiness, on GET /api/readyz (issue #1562)', () => {
    // A malformed MASTER_ENCRYPTION_KEY fails readiness so a rollout stops; liveness and startup
    // stay on "/" so the same misconfiguration never becomes a restart loop.
    const deployment = read('infra/helm/agent-workspace/templates/deployments.yaml');
    expect(deployment).toMatch(/\$readinessPaths := dict "web" "\/api\/readyz"/u);
    expect(deployment).toMatch(/readinessProbe:\s+httpGet: \{ path: \{\{ index \$readinessPaths /u);
    expect(deployment).toMatch(/livenessProbe:\s+httpGet: \{ path: \{\{ index \$healthPaths /u);
    expect(deployment).toMatch(/startupProbe:\s+httpGet: \{ path: \{\{ index \$healthPaths /u);
  });

  it('ships disruption budgets and opt-in CPU autoscaling', () => {
    const pdb = read('infra/helm/agent-workspace/templates/poddisruptionbudgets.yaml');
    const hpa = read('infra/helm/agent-workspace/templates/horizontalpodautoscalers.yaml');
    const values = read('infra/helm/agent-workspace/values.yaml');
    expect(pdb).toContain('kind: PodDisruptionBudget');
    expect(hpa).toContain('kind: HorizontalPodAutoscaler');
    expect(hpa).toContain('stabilizationWindowSeconds: 300');
    expect(values).toMatch(/autoscaling:\s+enabled: false/u);
  });

  it('keeps cluster evidence fail-closed and distinct from A.12 conformance', () => {
    const verifier = read('scripts/dev-cluster/verify-chart-lifecycle.sh');
    expect(verifier).toContain('expected kind-$cluster');
    expect(verifier).toContain('@sha256:[0-9a-f]{64}$');
    expect(verifier).toContain('"a12RuntimeConformance": "not-run"');
  });

  it('verifies uninstall and namespace cleanup before publishing passed evidence', () => {
    const verifier = read('scripts/dev-cluster/verify-chart-lifecycle.sh');
    const uninstall = verifier.indexOf(
      'helm uninstall agent-workspace-validation --namespace "$namespace" --wait --timeout 10m',
    );
    const releaseVerification = verifier.indexOf(
      'helm list --namespace "$namespace" --filter',
      uninstall,
    );
    const namespaceDelete = verifier.indexOf(
      'kubectl delete namespace "$namespace" --wait=true --timeout=10m',
    );
    const namespaceVerification = verifier.indexOf(
      'kubectl get namespace "$namespace" --ignore-not-found -o name',
      namespaceDelete,
    );
    const evidenceWrite = verifier.indexOf('cat >"$artifact"');

    expect(uninstall).toBeGreaterThan(-1);
    expect(releaseVerification).toBeGreaterThan(uninstall);
    expect(namespaceDelete).toBeGreaterThan(releaseVerification);
    expect(namespaceVerification).toBeGreaterThan(namespaceDelete);
    expect(evidenceWrite).toBeGreaterThan(namespaceVerification);
    expect(verifier).toContain('"uninstall": "passed"');
    expect(verifier).toContain('"namespaceCleanup": "passed"');
    expect(verifier).not.toContain('"uninstall": "performed-by-cleanup"');
  });

  it('waits for each named deployment instead of invoking rollout status without a name', () => {
    const verifier = read('scripts/dev-cluster/verify-chart-lifecycle.sh');
    expect(verifier).toContain(
      'rollout status "deployment/agent-workspace-$workload" --timeout=10m',
    );
    expect(verifier).not.toContain('rollout status deployment --timeout=10m');
    expect(verifier.match(/wait_for_deployments/g)).toHaveLength(4);
  });

  it('does not let the autoscaling render failure hide behind a grep pipeline', () => {
    const workflow = read('.github/workflows/quality.yml');
    expect(workflow).toContain('> rendered-autoscaling.yaml');
    expect(workflow).toContain("grep -q 'kind: HorizontalPodAutoscaler' rendered-autoscaling.yaml");
    expect(workflow).not.toContain("| grep -q 'kind: HorizontalPodAutoscaler'");
  });
});
