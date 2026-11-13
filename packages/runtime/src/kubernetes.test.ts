import { describe, expect, it } from 'vitest';
import { kubernetesRuntimeResources, type KubernetesResource } from './kubernetes.js';

describe('kubernetes resource manifests', () => {
  it('renders the complete A.5 pod security and egress boundary', () => {
    const resources = kubernetesRuntimeResources({
      namespace: 'ws',
      podName: 'run',
      image: 'runtime@sha256:abc',
      timeoutSeconds: 47,
      gatewayNamespace: 'control',
      gatewayService: 'gateway',
    });
    const pod = resources.find((item) => item.kind === 'Pod') as KubernetesResource & {
      spec: Record<string, unknown>;
    };
    expect(pod.spec).toMatchObject({
      serviceAccountName: 'agent-runtime',
      automountServiceAccountToken: false,
      restartPolicy: 'Never',
      activeDeadlineSeconds: 47,
    });
    expect(JSON.stringify(pod)).toContain('allowPrivilegeEscalation');
    expect(JSON.stringify(pod)).toContain('readOnlyRootFilesystem');
    expect(resources.filter((item) => item.kind === 'NetworkPolicy')).toHaveLength(2);
  });

  it('requests only a schedulable floor for resources no profile named', () => {
    const resources = kubernetesRuntimeResources({
      namespace: 'ws',
      podName: 'run',
      image: 'runtime@sha256:abc',
      timeoutSeconds: 47,
      gatewayNamespace: 'control',
      gatewayService: 'gateway',
      runSpec: {
        runtimeProfileId: 'profile-k8s',
        driver: 'kubernetes',
        memoryMb: 512,
        networkPolicy: 'restricted',
        filesystem: 'read-write',
      },
    });
    const pod = resources.find((item) => item.kind === 'Pod') as KubernetesResource & {
      spec: { containers: Array<Record<string, unknown>> };
    };
    // `memoryMb` was named, so it is reserved; `cpu` was not, so the pod does not hold the whole
    // core this driver would otherwise cap it at.
    expect(pod.spec.containers[0]?.['resources']).toEqual({
      requests: { cpu: '100m', memory: '512Mi' },
      limits: { cpu: '1', memory: '512Mi' },
    });
  });

  it('applies selected profile limits, filesystem mode, network policy, and timeout', () => {
    const resources = kubernetesRuntimeResources({
      namespace: 'ws',
      podName: 'run',
      image: 'runtime@sha256:abc',
      timeoutSeconds: 3_600,
      gatewayNamespace: 'control',
      gatewayService: 'gateway',
      runSpec: {
        runtimeProfileId: 'profile-k8s',
        driver: 'kubernetes',
        cpu: 2,
        memoryMb: 768,
        diskMb: 2048,
        networkPolicy: 'open',
        filesystem: 'read-only',
        timeoutSeconds: 47,
      },
    });
    const pod = resources.find((item) => item.kind === 'Pod') as KubernetesResource & {
      spec: {
        activeDeadlineSeconds: number;
        containers: Array<Record<string, unknown>>;
        volumes: Array<Record<string, unknown>>;
      };
    };
    expect(pod.spec.activeDeadlineSeconds).toBe(47);
    expect(pod.spec.containers[0]).toMatchObject({
      resources: {
        requests: { cpu: '2', memory: '768Mi', 'ephemeral-storage': '2048Mi' },
        limits: { cpu: '2', memory: '768Mi', 'ephemeral-storage': '2048Mi' },
      },
    });
    expect(pod.spec.containers[0]?.['volumeMounts']).toEqual(
      expect.arrayContaining([{ name: 'workspace', mountPath: '/workspace', readOnly: true }]),
    );
    expect(pod.spec.volumes[0]).toMatchObject({
      name: 'workspace',
      emptyDir: { sizeLimit: '2048Mi' },
    });
    expect(resources.filter((item) => item.kind === 'NetworkPolicy')).toHaveLength(0);
  });
});
