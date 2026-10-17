import { describe, expect, it } from 'vitest';
import {
  createKubernetesDriver,
  kubernetesRuntimeResources,
  type KubernetesResource,
} from './kubernetes.js';

function echoConnection(value: string) {
  return {
    events: (async function* () {
      await Promise.resolve();
      yield value;
    })(),
    sessionId: Promise.resolve('session'),
    interrupt: () => Promise.resolve(),
  };
}

describe('kubernetes runtime', () => {
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

  it('creates one pod and destroys every owned resource', async () => {
    const created: KubernetesResource[] = [];
    const deleted: KubernetesResource[] = [];
    const driver = createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client: {
        create: (item) => {
          created.push(item);
          return Promise.resolve(item);
        },
        delete: (item) => {
          deleted.push(item);
          return Promise.resolve();
        },
      },
      startAgent: () =>
        Promise.resolve({
          events: {
            [Symbol.asyncIterator]: () => {
              let yielded = false;
              return {
                next: () => {
                  if (yielded) return Promise.resolve({ done: true, value: undefined });
                  yielded = true;
                  return Promise.resolve({ done: false, value: 'ok' });
                },
              };
            },
          },
          sessionId: Promise.resolve('session'),
          interrupt: () => Promise.resolve(),
        }),
    });
    const handle = await driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'session',
      workspacePath: '/workspace/a',
    });
    expect(handle.driver).toBe('kubernetes');
    expect(created.filter((item) => item.kind === 'Pod')).toHaveLength(1);
    await driver.destroy(handle);
    expect(deleted).toHaveLength(created.length);
  });

  it('does not delete a pre-existing resource when the first create fails', async () => {
    const createError = Object.assign(new Error('namespace already exists'), { code: 409 });
    const deleted: KubernetesResource[] = [];
    const driver = createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client: {
        create: () => Promise.reject(createError),
        delete: (item) => {
          deleted.push(item);
          return Promise.resolve();
        },
      },
      startAgent: () => {
        throw new Error('not reached');
      },
    });

    await expect(
      driver.create({
        engine: 'claude-agent-sdk',
        sessionId: 'session',
        workspacePath: '/workspace/pre-existing',
      }),
    ).rejects.toBe(createError);
    expect(deleted).toEqual([]);
  });

  it('rolls back only successfully created resources in reverse order', async () => {
    const createError = new Error('later create failed');
    const attempted: KubernetesResource[] = [];
    const created: KubernetesResource[] = [];
    const deleted: KubernetesResource[] = [];
    const driver = createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client: {
        create: (item) => {
          attempted.push(item);
          if (attempted.length === 4) return Promise.reject(createError);
          created.push(item);
          return Promise.resolve(item);
        },
        delete: (item) => {
          deleted.push(item);
          return Promise.resolve();
        },
      },
      startAgent: () => {
        throw new Error('not reached');
      },
    });

    await expect(
      driver.create({
        engine: 'claude-agent-sdk',
        sessionId: 'session',
        workspacePath: '/workspace/partial-create',
      }),
    ).rejects.toBe(createError);
    expect(attempted).toHaveLength(4);
    expect(deleted).toEqual([...created].reverse());
    expect(deleted).not.toContain(attempted[3]);
  });

  it('retains failed deletions for a retry while forgetting deleted and absent resources', async () => {
    const created: KubernetesResource[] = [];
    const deletionAttempts: string[] = [];
    const attemptCounts = new Map<string, number>();
    const podFailure = new Error('pod deletion unavailable');
    const policyFailure = new Error('policy deletion unavailable');
    const notFound = Object.assign(new Error('Not Found'), { code: 404 });
    const driver = createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client: {
        create: (item) => {
          created.push(item);
          return Promise.resolve(item);
        },
        delete: (item) => {
          const name = item.metadata.name;
          deletionAttempts.push(name);
          const count = (attemptCounts.get(name) ?? 0) + 1;
          attemptCounts.set(name, count);
          if (count === 1 && item.kind === 'Pod') return Promise.reject(podFailure);
          if (count === 1 && name === 'default-deny-egress') return Promise.reject(policyFailure);
          if (count === 1 && name === 'allow-gateway-egress') return Promise.reject(notFound);
          return Promise.resolve();
        },
      },
      startAgent: (_runtime, request) => Promise.resolve(echoConnection(request)),
    });
    const handle = await driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'session',
      workspacePath: '/workspace/retry',
    });

    let firstError: unknown;
    try {
      await driver.destroy(handle);
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(AggregateError);
    expect((firstError as AggregateError).errors).toEqual([podFailure, policyFailure]);
    expect(deletionAttempts).toEqual(created.map((item) => item.metadata.name).reverse());

    deletionAttempts.length = 0;
    await expect(driver.startAgent(handle, 'still live')).resolves.toBeDefined();
    await expect(driver.destroy(handle)).resolves.toBeUndefined();
    expect(deletionAttempts).toEqual([
      created.find((item) => item.kind === 'Pod')?.metadata.name,
      'default-deny-egress',
    ]);
    await expect(driver.startAgent(handle, 'gone')).rejects.toThrow('handle is not live');
  });

  it('treats NotFound as an idempotent successful deletion', async () => {
    const notFound = Object.assign(new Error('Not Found'), { code: 404 });
    const driver = createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client: {
        create: (item) => Promise.resolve(item),
        delete: () => Promise.reject(notFound),
      },
      startAgent: (_runtime, request) => Promise.resolve(echoConnection(request)),
    });
    const handle = await driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'session',
      workspacePath: '/workspace/gone',
    });

    await expect(driver.destroy(handle)).resolves.toBeUndefined();
    await expect(driver.startAgent(handle, 'gone')).rejects.toThrow('handle is not live');
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

  it('refuses a selected profile when its resolved constraints are absent or for another driver', async () => {
    const driver = createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client: {
        create: (item) => Promise.resolve(item),
        delete: () => Promise.resolve(),
      },
      startAgent: () => {
        throw new Error('not reached');
      },
    });
    await expect(
      driver.create({
        sessionId: 'session',
        engine: 'claude-agent-sdk',
        workspacePath: '/workspace/a',
        runtimeProfileId: 'profile-k8s',
      }),
    ).rejects.toThrow('selected without resolved run constraints');
    await expect(
      driver.create({
        sessionId: 'session',
        engine: 'claude-agent-sdk',
        workspacePath: '/workspace/a',
        runtimeProfileId: 'profile-local',
        runSpec: {
          runtimeProfileId: 'profile-local',
          driver: 'local',
          networkPolicy: 'open',
          filesystem: 'read-write',
        },
      }),
    ).rejects.toThrow('selects local, not kubernetes');
  });
});

// ENG-07 (#306, ADR-0073 D3): the image is the run's engine's, from a map of two engines.
const TWO_ENGINE_IMAGES = new Map([
  ['claude-agent-sdk', `registry.example/runtime-claude-agent-sdk@sha256:${'a'.repeat(64)}`],
  ['pi', `registry.example/runtime-pi@sha256:${'b'.repeat(64)}`],
]);

describe('kubernetes runtime: one image per engine (ENG-07)', () => {
  function recordingDriver(created: KubernetesResource[]) {
    return createKubernetesDriver<string, string>({
      images: TWO_ENGINE_IMAGES,
      client: {
        create: (item) => {
          created.push(item);
          return Promise.resolve(item);
        },
        delete: () => Promise.resolve(),
      },
      startAgent: () => {
        throw new Error('not used');
      },
    });
  }

  it("creates each run's pod from its own engine's image", async () => {
    for (const engine of ['claude-agent-sdk', 'pi']) {
      const created: KubernetesResource[] = [];
      await recordingDriver(created).create({
        engine,
        sessionId: 'session',
        workspacePath: `/workspace/${engine}`,
      });
      const pod = created.find((item) => item.kind === 'Pod') as unknown as {
        spec: { containers: Array<{ image: string }> };
      };
      expect(pod.spec.containers[0]?.image).toBe(TWO_ENGINE_IMAGES.get(engine));
    }
  });

  it('refuses an engine with no image before any resource is created', async () => {
    const created: KubernetesResource[] = [];
    await expect(
      recordingDriver(created).create({
        engine: 'openai-agents',
        sessionId: 'session',
        workspacePath: '/workspace/none',
      }),
    ).rejects.toThrow(/no runtime image for engine "openai-agents"/u);
    expect(created).toHaveLength(0);
  });

  it('refuses a config without an engine as the driver, not as an image-map error', async () => {
    const created: KubernetesResource[] = [];
    // A caller outside TypeScript can omit the engine; the published driver must still refuse it.
    const config = { sessionId: 'session', workspacePath: '/workspace/none' } as unknown as {
      engine: string;
      sessionId: string;
      workspacePath: string;
    };
    await expect(recordingDriver(created).create(config)).rejects.toThrow(
      'kubernetes runtime: engine must be a non-empty string.',
    );
    expect(created).toHaveLength(0);
  });
});

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
