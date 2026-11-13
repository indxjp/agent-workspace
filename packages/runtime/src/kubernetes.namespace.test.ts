import { describe, expect, it } from 'vitest';
import {
  createKubernetesDriver,
  kubernetesRuntimeResources,
  type KubernetesResource,
} from './kubernetes.js';

describe('kubernetes runtime: sessions in the release namespace', () => {
  const GATEWAY_IP = '10.96.0.40';
  const IMAGES = new Map([['claude-agent-sdk', 'runtime@sha256:abc']]);

  function sharedDriver() {
    const created: KubernetesResource[] = [];
    const deleted: KubernetesResource[] = [];
    const fieldManagers: Array<string | undefined> = [];
    const driver = createKubernetesDriver<string, string>({
      images: IMAGES,
      namespace: 'release',
      gatewayService: 'agent-workspace-gateway',
      fieldManager: 'manager',
      client: {
        create: (item, fieldManager) => {
          created.push(item);
          fieldManagers.push(fieldManager);
          return Promise.resolve(item);
        },
        delete: (item) => {
          deleted.push(item);
          return Promise.resolve();
        },
        read: (item) => Promise.resolve({ ...item, spec: { clusterIP: GATEWAY_IP } }),
      },
      startAgent: () => {
        throw new Error('not used');
      },
    });
    return { driver, created, deleted, fieldManagers };
  }

  const config = (sessionId: string) => ({
    engine: 'claude-agent-sdk',
    sessionId,
    workspacePath: '/workspace/a',
  });

  it('creates no Namespace or ServiceAccount and selects every policy by the pod', async () => {
    const { driver, created, fieldManagers } = sharedDriver();
    const handle = await driver.create(config('Session/One'));
    expect(created.map((item) => item.kind)).toEqual([
      'NetworkPolicy',
      'NetworkPolicy',
      'Pod',
      'Service',
    ]);
    const podName = handle.externalId.split('/')[1];
    expect(handle.externalId).toBe(`release/${String(podName)}`);
    for (const item of created) {
      expect(item.metadata.namespace).toBe('release');
      if (item.kind !== 'NetworkPolicy') continue;
      expect(item.metadata.name).toContain(String(podName));
      expect((item.spec as { podSelector: unknown }).podSelector).toMatchObject({
        matchLabels: { 'agent-workspace/runtime': podName },
      });
    }
    expect(new Set(fieldManagers)).toEqual(new Set(['manager']));
    const pod = created.find((item) => item.kind === 'Pod');
    expect(pod?.metadata.labels).toMatchObject({
      'app.kubernetes.io/name': 'agent-runtime',
      'agent-workspace/session': 'Session-One',
    });
  });

  it('renders an unproxied open profile as gateway-only, not as no policy', async () => {
    const { driver, created } = sharedDriver();
    await driver.create({
      ...config('s'),
      runSpec: {
        runtimeProfileId: 'profile-k8s',
        driver: 'kubernetes',
        networkPolicy: 'open',
        filesystem: 'read-write',
      },
    });
    const policies = created.filter((item) => item.kind === 'NetworkPolicy');
    expect(policies.map((item) => item.metadata.name)).toEqual([
      expect.stringMatching(/default-deny-egress/u),
      expect.stringMatching(/allow-gateway-egress/u),
    ]);
  });

  it('resolves the gateway by hosts file because the sandbox has no DNS', async () => {
    const { driver, created } = sharedDriver();
    await driver.create(config('s'));
    const pod = created.find((item) => item.kind === 'Pod');
    expect((pod?.spec as { hostAliases: unknown }).hostAliases).toEqual([
      {
        ip: GATEWAY_IP,
        hostnames: [
          'agent-workspace-gateway',
          'agent-workspace-gateway.release.svc',
          'agent-workspace-gateway.release.svc.cluster.local',
        ],
      },
    ]);
  });

  it('lets two sessions share the namespace without colliding on a name', async () => {
    const { driver, created } = sharedDriver();
    await driver.create(config('one'));
    await driver.create(config('two'));
    const names = created.map((item) => `${item.kind}/${item.metadata.name}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it('deletes the runtime Service with the rest on destroy', async () => {
    const { driver, created, deleted } = sharedDriver();
    const handle = await driver.create(config('s'));
    await driver.destroy(handle);
    expect(deleted.map((item) => item.kind).sort()).toEqual(
      created.map((item) => item.kind).sort(),
    );
    expect(deleted.some((item) => item.kind === 'Service')).toBe(true);
  });

  it('rolls back the pod and policies when the runtime Service is refused', async () => {
    const rollback: KubernetesResource[] = [];
    const failing = createKubernetesDriver<string, string>({
      images: IMAGES,
      namespace: 'release',
      gatewayService: 'agent-workspace-gateway',
      client: {
        create: (item) =>
          item.kind === 'Service' ? Promise.reject(new Error('refused')) : Promise.resolve(item),
        delete: (item) => {
          rollback.push(item);
          return Promise.resolve();
        },
        read: (item) => Promise.resolve({ ...item, spec: { clusterIP: GATEWAY_IP } }),
      },
      startAgent: () => {
        throw new Error('not used');
      },
    });
    await expect(failing.create(config('s'))).rejects.toThrow('refused');
    expect(rollback.map((item) => item.kind)).toEqual(['Pod', 'NetworkPolicy', 'NetworkPolicy']);
  });

  it('refuses to start a sandbox when the gateway Service has no cluster IP', async () => {
    const driver = createKubernetesDriver<string, string>({
      images: IMAGES,
      namespace: 'release',
      client: {
        create: (item) => Promise.resolve(item),
        delete: () => Promise.resolve(),
        read: (item) => Promise.resolve({ ...item, spec: { clusterIP: 'None' } }),
      },
      startAgent: () => {
        throw new Error('not used');
      },
    });
    await expect(driver.create(config('s'))).rejects.toThrow(/gateway Service was not given/u);
  });

  it('reports a sandbox live only while its pod is Pending or Running', async () => {
    let phase: unknown = 'Running';
    let missing = false;
    const driver = createKubernetesDriver<string, string>({
      images: IMAGES,
      namespace: 'release',
      gatewayService: 'agent-workspace-gateway',
      client: {
        create: (item) => Promise.resolve(item),
        delete: () => Promise.resolve(),
        read: (item) => {
          if (missing) return Promise.reject(Object.assign(new Error('gone'), { code: 404 }));
          return Promise.resolve({ ...item, spec: { clusterIP: GATEWAY_IP }, status: { phase } });
        },
      },
      startAgent: () => {
        throw new Error('not used');
      },
    });
    const handle = await driver.create(config('s'));
    expect(await driver.isLive(handle)).toBe(true);
    phase = 'Failed';
    expect(await driver.isLive(handle)).toBe(false);
    phase = 'Running';
    missing = true;
    expect(await driver.isLive(handle)).toBe(false);
    expect(await driver.isLive({ ...handle, externalId: 'release/other' })).toBe(false);
  });

  it('keeps one namespace, one ServiceAccount and fixed policy names when no namespace is set', () => {
    const resources = kubernetesRuntimeResources({
      namespace: 'ws',
      podName: 'run',
      image: 'runtime@sha256:abc',
      timeoutSeconds: 47,
      gatewayNamespace: 'control',
      gatewayService: 'gateway',
    });
    expect(resources.map((item) => `${item.kind}/${item.metadata.name}`)).toEqual([
      'Namespace/ws',
      'ServiceAccount/agent-runtime',
      'NetworkPolicy/default-deny-egress',
      'NetworkPolicy/allow-gateway-egress',
      'Pod/run',
    ]);
  });
});
