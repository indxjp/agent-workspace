import { type RuntimeHandle } from '@agent-workspace/runtime/driver';
import { type KubernetesResourceClient } from '@agent-workspace/runtime/driver/kubernetes';
import { EngineImageConfigurationError } from '@agent-workspace/runtime/engine-images';
import { expect, it } from 'vitest';
import {
  KUBERNETES_FIELD_MANAGER,
  kubernetesDriverOptions,
  kubernetesRuntimeOrigin,
  managerDriverOptions,
} from './manager-start.js';

const kubernetes = {
  RUNTIME_DRIVER: 'kubernetes',
  RUNTIME_KUBERNETES_NAMESPACE: 'release',
  RUNTIME_GATEWAY_SERVICE: 'agent-workspace-gateway',
  KUBERNETES_SERVICE_HOST: '10.96.0.1',
  AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'agent-runtime:dev',
};

const client = {
  create: (item: { metadata: { name: string } }) => Promise.resolve({ ...item, spec: {} }),
  delete: () => Promise.resolve(),
  read: (item: { metadata: { name: string } }) =>
    Promise.resolve({ ...item, spec: { clusterIP: '10.96.0.9' } }),
} as unknown as KubernetesResourceClient;

it('runner manager kubernetes composition (#854) > builds the kubernetes driver for RUNTIME_DRIVER=kubernetes, not a Docker one', () => {
  const options = managerDriverOptions(kubernetes);
  expect(options.expectedDriver).toBe('kubernetes');
  expect(options.configurationFingerprint).toBe(
    'kubernetes:release:claude-agent-sdk=agent-runtime:dev',
  );
  expect(options.toolSandboxRefusal).toContain('kubernetes');
});

it('runner manager kubernetes composition (#854) > puts the egress proxy image in the fingerprint so Test Runtime approval follows it', () => {
  const options = kubernetesDriverOptions(
    { ...kubernetes, AGENT_WORKSPACE_EGRESS_PROXY_IMAGE: 'egress-proxy:dev' },
    client,
  );
  expect(options.configurationFingerprint).toContain('+proxy=egress-proxy:dev');
});

it('runner manager kubernetes composition (#854) > allocates in the release namespace under the manager field manager', async () => {
  const created: Array<{ kind: string; ns: string | undefined; manager: string | undefined }> = [];
  const options = kubernetesDriverOptions(kubernetes, {
    ...client,
    create: (item, manager) => {
      created.push({ kind: item.kind ?? '', ns: item.metadata.namespace, manager });
      return Promise.resolve(item);
    },
  });
  const handle = await options.driver.create({
    engine: 'claude-agent-sdk',
    sessionId: 'session',
    workspacePath: '/workspace/a',
  });
  expect(handle.externalId).toMatch(/^release\/runtime-/u);
  expect(created.map((item) => item.ns)).toEqual(created.map(() => 'release'));
  expect(created.map((item) => item.manager)).toEqual(created.map(() => KUBERNETES_FIELD_MANAGER));
  expect(options.runtimeOrigin?.(handle)).toBe(
    `http://${handle.externalId.split('/')[1]}.release.svc:8080`,
  );
});

it('runner manager kubernetes composition (#854) > addresses a sandbox through the Service named after its pod', () => {
  const handle: RuntimeHandle = {
    id: 'one',
    driver: 'kubernetes',
    externalId: 'ns/runtime-abc',
    workspacePath: '/workspace',
    createdAt: new Date(),
  };
  expect(kubernetesRuntimeOrigin(handle)).toBe('http://runtime-abc.ns.svc:8080');
  expect(() => kubernetesRuntimeOrigin({ ...handle, externalId: 'runtime-abc' })).toThrow(
    /namespace and a pod/u,
  );
});

it('runner manager kubernetes composition (#854) > refuses to start outside a cluster rather than fall back to a kubeconfig', () => {
  expect(() => managerDriverOptions({ ...kubernetes, KUBERNETES_SERVICE_HOST: undefined })).toThrow(
    /in-cluster ServiceAccount/u,
  );
});

it.each(['RUNTIME_KUBERNETES_NAMESPACE', 'RUNTIME_GATEWAY_SERVICE'])(
  'runner manager kubernetes composition (#854) > refuses to start without %s',
  (name) => {
    expect(() => managerDriverOptions({ ...kubernetes, [name]: ' ' })).toThrow(
      new RegExp(`${name} must be set`, 'u'),
    );
  },
);

it('runner manager kubernetes composition (#854) > requires a digest-pinned runtime image in production', () => {
  expect(() => kubernetesDriverOptions({ ...kubernetes, NODE_ENV: 'production' }, client)).toThrow(
    EngineImageConfigurationError,
  );
});
