/**
 * ADR-0117 on the kubernetes driver (#784): `restricted` and `open` go through one proxy Pod and
 * Service per session, and the sandbox `NetworkPolicy` allows the gateway and that proxy only.
 * The live proof is the kind isolation lane (`infra/tests/isolation`).
 */
import { describe, expect, it } from 'vitest';

import {
  createKubernetesDriver,
  kubernetesRuntimeResources,
  type KubernetesResource,
} from './kubernetes.js';
import type { RuntimeRunSpec } from './driver.js';

const PROXY_IMAGE = 'aw-egress-proxy:ci';
const CLUSTER_IP = '10.96.7.7';

function spec(overrides: Partial<RuntimeRunSpec> = {}): RuntimeRunSpec {
  return {
    runtimeProfileId: 'profile-k8s',
    driver: 'kubernetes',
    networkPolicy: 'restricted',
    filesystem: 'read-write',
    ...overrides,
  };
}

function recordingClient(failOn?: (item: KubernetesResource) => boolean) {
  const created: KubernetesResource[] = [];
  const deleted: KubernetesResource[] = [];
  return {
    created,
    deleted,
    client: {
      create: (item: KubernetesResource) => {
        if (failOn?.(item) === true) return Promise.reject(new Error(`${item.kind} refused`));
        created.push(item);
        return Promise.resolve(
          item.kind === 'Service' ? { ...item, spec: { clusterIP: CLUSTER_IP } } : item,
        );
      },
      delete: (item: KubernetesResource) => {
        deleted.push(item);
        return Promise.resolve();
      },
    },
  };
}

function driverFor(client: ReturnType<typeof recordingClient>['client'], withProxy = true) {
  return createKubernetesDriver<string, string>({
    images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
    client,
    ...(withProxy ? { egressProxyImage: PROXY_IMAGE, proxyBypass: ['gateway.control'] } : {}),
    startAgent: () => {
      throw new Error('not used');
    },
  });
}

const config = (runSpec: RuntimeRunSpec) => ({
  engine: 'claude-agent-sdk',
  sessionId: 'session',
  workspacePath: '/workspace/a',
  runSpec,
});

type PodSpec = {
  containers: Array<{ image: string; env?: Array<{ name: string; value: string }> }>;
};
const podSpec = (item: KubernetesResource | undefined) => (item?.spec ?? {}) as PodSpec;
const named = (items: readonly KubernetesResource[], kind: string, prefix = '') =>
  items.find((item) => item.kind === kind && item.metadata.name.startsWith(prefix));

describe('kubernetes driver egress proxy (ADR-0117, #784)', () => {
  it('starts a proxy Pod and Service and points the sandbox at the ClusterIP for restricted', async () => {
    const { client, created } = recordingClient();
    await driverFor(client).create(
      config(spec({ allowedDomains: ['api.example.com', '*.example.org'] })),
    );

    expect(created.map((item) => item.kind)).toEqual([
      'Namespace',
      'ServiceAccount',
      'NetworkPolicy',
      'NetworkPolicy',
      'NetworkPolicy',
      'NetworkPolicy',
      'Pod',
      'Service',
      'Pod',
    ]);
    const proxy = podSpec(named(created, 'Pod', 'egress-')).containers[0];
    expect(proxy?.image).toBe(PROXY_IMAGE);
    expect(proxy?.env).toContainEqual({
      name: 'EGRESS_ALLOWLIST',
      value: 'api.example.com,*.example.org',
    });
    const sandbox = podSpec(named(created, 'Pod', 'runtime-')).containers[0];
    const env = Object.fromEntries(sandbox?.env?.map((entry) => [entry.name, entry.value]) ?? []);
    expect(env['HTTPS_PROXY']).toBe(`http://${CLUSTER_IP}:3128`);
    expect(env['HTTP_PROXY']).toBe(`http://${CLUSTER_IP}:3128`);
    expect(env['NO_PROXY']).toBe(
      'localhost,127.0.0.1,gateway.control,gateway.agent-workspace.svc,gateway.agent-workspace.svc.cluster.local',
    );
  });

  it('bypasses the proxy for the gateway Service when no proxyBypass is given', async () => {
    const { client, created } = recordingClient();
    await createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client,
      egressProxyImage: PROXY_IMAGE,
      gatewayNamespace: 'aw',
      gatewayService: 'gw',
      startAgent: () => {
        throw new Error('not used');
      },
    }).create(config(spec({ networkPolicy: 'open' })));
    const sandbox = podSpec(named(created, 'Pod', 'runtime-')).containers[0];
    const noProxy = sandbox?.env?.find((entry) => entry.name === 'NO_PROXY')?.value.split(',');
    expect(noProxy).toEqual(expect.arrayContaining(['gw.aw.svc', 'gw.aw.svc.cluster.local']));
  });

  it('allows the sandbox to reach the gateway and the proxy only, and the proxy to leave', () => {
    const resources = kubernetesRuntimeResources({
      namespace: 'ws',
      podName: 'run',
      image: 'runtime@sha256:abc',
      timeoutSeconds: 47,
      gatewayNamespace: 'control',
      gatewayService: 'gateway',
      runSpec: spec(),
      egress: { image: PROXY_IMAGE, allowlist: 'api.example.com', bypass: [] },
    });
    const policies = resources.filter((item) => item.kind === 'NetworkPolicy');
    expect(policies.map((item) => item.metadata.name)).toEqual([
      'default-deny-egress',
      'allow-gateway-egress',
      'allow-proxy-egress-run',
      'egress-proxy-run',
    ]);
    expect(named(policies, 'NetworkPolicy', 'allow-proxy')?.spec).toMatchObject({
      policyTypes: ['Egress'],
      egress: [{ ports: [{ protocol: 'TCP', port: 3128 }] }],
    });
    const proxyPolicy = JSON.stringify(named(policies, 'NetworkPolicy', 'egress-proxy')?.spec);
    for (const range of ['169.254.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
      expect(proxyPolicy).toContain(range);
    }
    const service = named(resources, 'Service')?.spec as { type: string; selector: object };
    expect(service.type).toBe('ClusterIP');
    expect(service.selector).toEqual({
      'app.kubernetes.io/name': 'agent-egress-proxy',
      'agent-workspace/egress': 'run',
    });
    const proxy = named(resources, 'Pod', 'egress-run');
    expect(JSON.stringify(proxy)).toContain('"readOnlyRootFilesystem":true');
    expect(JSON.stringify(proxy)).toContain('"automountServiceAccountToken":false');
  });

  it('proxies open with the allowlist * instead of leaving the pod unrestricted', async () => {
    const { client, created } = recordingClient();
    await driverFor(client).create(config(spec({ networkPolicy: 'open' })));
    expect(podSpec(named(created, 'Pod', 'egress-')).containers[0]?.env).toContainEqual({
      name: 'EGRESS_ALLOWLIST',
      value: '*',
    });
    expect(created.filter((item) => item.kind === 'NetworkPolicy')).toHaveLength(4);
  });

  it('starts no proxy for none, or for restricted with nothing allowed', async () => {
    for (const runSpec of [spec({ networkPolicy: 'none' }), spec({ allowedDomains: [] })]) {
      const { client, created } = recordingClient();
      await driverFor(client).create(config(runSpec));
      expect(created.some((item) => item.kind === 'Service')).toBe(false);
      expect(created.filter((item) => item.kind === 'Pod')).toHaveLength(1);
    }
  });

  it('keeps refusing allowedDomains, and open stays unrestricted, without a proxy image', async () => {
    const refused = recordingClient();
    await expect(
      driverFor(refused.client, false).create(
        config(spec({ allowedDomains: ['api.example.com'] })),
      ),
    ).rejects.toThrow(/egressProxyImage/u);
    expect(refused.created).toEqual([]);

    const open = recordingClient();
    await driverFor(open.client, false).create(config(spec({ networkPolicy: 'open' })));
    expect(open.created.map((item) => item.kind)).toEqual(['Namespace', 'ServiceAccount', 'Pod']);
  });

  it('refuses a malformed allowlist before creating anything', async () => {
    const { client, created } = recordingClient();
    await expect(driverFor(client).create(config(spec({ allowedDomains: ['*'] })))).rejects.toThrow(
      /allowedDomains/u,
    );
    expect(created).toEqual([]);
  });

  it('rolls back everything created when the proxy Service cannot be created', async () => {
    const { client, created, deleted } = recordingClient((item) => item.kind === 'Service');
    await expect(driverFor(client).create(config(spec({ networkPolicy: 'open' })))).rejects.toThrow(
      /Service refused/u,
    );
    expect(deleted.map((item) => item.metadata.name)).toEqual(
      created.map((item) => item.metadata.name).reverse(),
    );
    expect(created.some((item) => item.metadata.name.startsWith('runtime-'))).toBe(false);
  });

  it('destroy deletes the proxy resources with the sandbox', async () => {
    const { client, created, deleted } = recordingClient();
    const driver = driverFor(client);
    const handle = await driver.create(config(spec({ networkPolicy: 'open' })));
    await driver.destroy(handle);
    expect(deleted).toHaveLength(created.length);
    expect(deleted.some((item) => item.kind === 'Service')).toBe(true);
  });

  it('requires the proxy image to be pinned by digest in production', () => {
    expect(() =>
      createKubernetesDriver<string, string>({
        images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
        client: recordingClient().client,
        egressProxyImage: 'aw-egress-proxy:latest',
        requireDigest: true,
        startAgent: () => {
          throw new Error('not used');
        },
      }),
    ).toThrow(/egressProxyImage is not/u);
  });
});
