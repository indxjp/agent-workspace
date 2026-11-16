import type { KubernetesResource, KubernetesResourceClient } from './kubernetes/model.js';
import { resource, kubernetesRuntimeResources } from './kubernetes/resources.js';
import { createHash, randomUUID } from 'node:crypto';
import type { KubeConfig, KubernetesObjectApi } from '@kubernetes/client-node';

import type {
  AgentConnection,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeDriver,
  RuntimeHandle,
} from './driver.js';
import { requireEngineImage } from './engine-images.js';
import { egressAllowlist, requireEgressProxyImage, requireProxyBypass } from './egress.js';
import type { EngineImageMap } from './engine-images.js';

const DEFAULT_TIMEOUT_SECONDS = 3600;

export const KUBERNETES_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  isolation: 'container',
  customImage: true,
  persistentFilesystem: true,
  sessionAffinity: true,
  maxSessionSeconds: null,
  networkPolicies: ['none', 'allowlist', 'open'],
  execCommands: true,
  gpu: false,
  managedByProvider: false,
  typicalStartMs: 2_000,
  fileTransfer: 'push-archive',
};

export type { KubernetesResource, KubernetesResourceClient } from './kubernetes/model.js';
export { kubernetesRuntimeResources } from './kubernetes/resources.js';
export { sessionLabelValue } from './kubernetes/session-label.js';
export interface KubernetesDriverOptions<TRequest, TEvent> {
  /** ENG-07: one image per engine; the pod is created from the one for `config.engine`. */
  readonly images: EngineImageMap;
  readonly timeoutSeconds?: number;
  readonly gatewayNamespace?: string;
  readonly gatewayService?: string;
  readonly runtimeClassName?: string;
  /**
   * The `packages/egress-proxy` image (ADR-0117). When set, `restricted` (with `allowedDomains`) and
   * `open` get one proxy Pod and Service per session, and the sandbox `NetworkPolicy` allows the
   * gateway and that proxy only. Unset keeps the earlier behaviour: `allowedDomains` is refused and
   * `open` carries no policy.
   */
  readonly egressProxyImage?: string;
  /** Hosts the sandbox reaches directly rather than through the proxy (the gateway). */
  readonly proxyBypass?: readonly string[];
  /** ENG-07 production gate: images must be pinned by digest. */
  readonly requireDigest?: boolean;
  /**
   * Run every session in this existing namespace (the release's) instead of one namespace per
   * workspace. The driver then creates no Namespace and no ServiceAccount (the chart owns the
   * `agent-runtime` account), names its policies per pod, selects them by the pod's labels so they
   * never reach a control-plane pod, and gives the sandbox a Service the runner manager reaches it
   * by. Needs only a namespaced Role. `gatewayNamespace` must be this namespace.
   */
  readonly namespace?: string;
  /** Server-side-apply field manager recorded in `managedFields` of everything this driver creates. */
  readonly fieldManager?: string;
  readonly client?: KubernetesResourceClient;
  readonly startAgent: (
    runtime: RuntimeHandle,
    request: TRequest,
  ) => AgentConnection<TEvent> | Promise<AgentConnection<TEvent>>;
}

function isKubernetesNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as {
    code?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; statusCode?: unknown };
  };
  return (
    value.code === 404 ||
    value.statusCode === 404 ||
    value.response?.status === 404 ||
    value.response?.statusCode === 404
  );
}

async function deleteResources(
  client: KubernetesResourceClient,
  resources: readonly KubernetesResource[],
): Promise<Readonly<{ remaining: KubernetesResource[]; errors: unknown[] }>> {
  const remaining: KubernetesResource[] = [];
  const errors: unknown[] = [];
  for (const item of [...resources].reverse()) {
    try {
      await client.delete(item);
    } catch (error) {
      if (isKubernetesNotFound(error)) continue;
      // Reconstruct creation order so a retry still deletes dependants before their parents.
      remaining.unshift(item);
      errors.push(error);
    }
  }
  return { remaining, errors };
}

/**
 * A client whose `@kubernetes/client-node` is loaded on its first call, not when this module is: the
 * SDK is an optional dependency, and a runtime that never selects this driver (`aw dev`'s local
 * runtime) does not install it.
 */
function clientFor(load: (config: KubeConfig) => void): KubernetesResourceClient {
  let api: Promise<KubernetesObjectApi> | undefined;
  const connect = (): Promise<KubernetesObjectApi> =>
    (api ??= import('@kubernetes/client-node').then((sdk) => {
      const config = new sdk.KubeConfig();
      load(config);
      return sdk.KubernetesObjectApi.makeApiClient(config);
    }));
  return {
    create: async (resource, fieldManager) =>
      (await connect()).create<KubernetesResource>(resource, undefined, undefined, fieldManager),
    delete: async (resource) => (await connect()).delete(resource),
    read: async (resource) => (await connect()).read<KubernetesResource>(resource),
  };
}

function defaultClient(): KubernetesResourceClient {
  return clientFor((config) => {
    config.loadFromDefault();
  });
}

/**
 * A client authenticated as the pod's own ServiceAccount. It never falls back to a kubeconfig, so a
 * manager that is not in a cluster fails loudly instead of acting as whoever runs it.
 */
export function inClusterKubernetesClient(): KubernetesResourceClient {
  return clientFor((config) => {
    config.loadFromCluster();
  });
}

function clusterIpOf(service: KubernetesResource, what: string): string {
  const clusterIP = (service.spec as { clusterIP?: unknown } | undefined)?.clusterIP;
  if (typeof clusterIP !== 'string' || clusterIP.length === 0 || clusterIP === 'None') {
    throw new Error(`kubernetes runtime: the ${what} Service was not given a cluster IP.`);
  }
  return clusterIP;
}

function readGatewayService(
  client: KubernetesResourceClient,
  namespace: string,
  name: string,
): Promise<KubernetesResource> {
  if (client.read === undefined) {
    return Promise.reject(new Error('kubernetes runtime: the client cannot read Services.'));
  }
  return client.read(resource('v1', 'Service', name, namespace));
}

function requireValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`kubernetes runtime: ${name} must be a non-empty string.`);
  }
  return value;
}

function workspaceNamespace(path: string): string {
  return `agent-workspace-${createHash('sha256').update(path).digest('hex').slice(0, 12)}`;
}

export type KubernetesDriver<TRequest, TEvent> = RuntimeDriver<TRequest, TEvent> &
  Readonly<{ isLive(runtime: RuntimeHandle): Promise<boolean> }>;

function assertKubernetesConfig(config: RuntimeConfig, proxyImage: string | undefined): void {
  if (config.runtimeProfileId !== undefined && config.runSpec === undefined) {
    throw new Error(
      `kubernetes runtime: profile ${config.runtimeProfileId} was selected without resolved run constraints`,
    );
  }
  if (config.runSpec !== undefined) {
    if (config.runSpec.driver !== 'kubernetes') {
      throw new Error(
        `kubernetes runtime: profile ${config.runSpec.runtimeProfileId} selects ${config.runSpec.driver}, not kubernetes`,
      );
    }
    if (
      config.runtimeProfileId !== undefined &&
      config.runtimeProfileId !== config.runSpec.runtimeProfileId
    ) {
      throw new Error('kubernetes runtime: resolved run constraints do not match the profile');
    }
    // A NetworkPolicy selects peers by namespace, pod and CIDR — never by domain name. Domain
    // names are enforced by the per-session proxy (ADR-0117); without one, a profile that names
    // allowed domains is asking for a control this driver cannot apply, and silently starting
    // the pod would report that control as enforced.
    if (
      proxyImage === undefined &&
      config.runSpec.allowedDomains !== undefined &&
      config.runSpec.allowedDomains.length > 0
    ) {
      throw new Error(
        `kubernetes runtime: profile ${config.runSpec.runtimeProfileId} restricts egress to named domains, which NetworkPolicy cannot express; configure egressProxyImage (ADR-0117)`,
      );
    }
  }
}

async function createResources(
  client: KubernetesResourceClient,
  build: (proxyHost?: string) => readonly KubernetesResource[],
  podName: string,
  fieldManager: string | undefined,
): Promise<KubernetesResource[]> {
  const created: KubernetesResource[] = [];
  try {
    let proxyHost: string | undefined;
    for (const item of build()) {
      // The sandbox has no DNS (default-deny), so it reaches the proxy by the Service's
      // ClusterIP, which exists only once the Service has been created.
      const isSandbox = item.kind === 'Pod' && item.metadata.name === podName;
      const toCreate =
        isSandbox && proxyHost !== undefined
          ? (build(proxyHost).find((candidate) => candidate.metadata.name === podName) ?? item)
          : item;
      const made = await client.create(toCreate, fieldManager);
      created.push(toCreate);
      if (item.kind === 'Service' && item.metadata.name === `egress-${podName}`) {
        proxyHost = clusterIpOf(made, 'egress proxy');
      }
    }
  } catch (error) {
    const cleanup = await deleteResources(client, created);
    if (cleanup.errors.length > 0) {
      throw new AggregateError(
        [error, ...cleanup.errors],
        'kubernetes runtime: resource creation and rollback both failed',
        { cause: error },
      );
    }
    throw error;
  }
  return created;
}

export function createKubernetesDriver<TRequest, TEvent>(
  options: KubernetesDriverOptions<TRequest, TEvent>,
): KubernetesDriver<TRequest, TEvent> {
  const client = options.client ?? defaultClient();
  const proxyImage =
    options.egressProxyImage === undefined
      ? undefined
      : requireEgressProxyImage(
          'kubernetes',
          options.egressProxyImage,
          options.requireDigest === true,
        );
  const sharedNamespace = options.namespace;
  if (sharedNamespace !== undefined) {
    requireValue(sharedNamespace, 'namespace');
    if (client.read === undefined) {
      throw new Error('kubernetes runtime: namespace mode needs a client that can read Services.');
    }
  }
  const gatewayNamespace = options.gatewayNamespace ?? sharedNamespace ?? 'agent-workspace';
  const gatewayService = options.gatewayService ?? 'gateway';
  if (sharedNamespace !== undefined && gatewayNamespace !== sharedNamespace) {
    throw new Error('kubernetes runtime: namespace mode needs the gateway in the same namespace.');
  }
  // The sandbox reaches the gateway by a cluster address the proxy refuses as private, so a
  // proxied sandbox always bypasses the proxy for the gateway Service's names.
  const proxyBypass = requireProxyBypass('kubernetes', [
    ...(options.proxyBypass ?? []),
    ...(proxyImage === undefined
      ? []
      : [
          ...(sharedNamespace === undefined ? [] : [gatewayService]),
          `${gatewayService}.${gatewayNamespace}.svc`,
          `${gatewayService}.${gatewayNamespace}.svc.cluster.local`,
        ]),
  ]);
  const live = new Map<string, { handle: RuntimeHandle; resources: KubernetesResource[] }>();
  return {
    id: 'kubernetes',
    capabilities: KUBERNETES_RUNTIME_CAPABILITIES,
    async create(config) {
      assertKubernetesConfig(config, proxyImage);
      // ENG-07: the pod's image is the run's engine's, resolved before a namespace exists.
      const image = requireEngineImage(
        options.images,
        requireValue(config.engine, 'engine'),
        'kubernetes',
      );
      const id = randomUUID();
      const namespace = sharedNamespace ?? workspaceNamespace(config.workspacePath);
      const podName = `runtime-${id}`;
      const allowlist =
        proxyImage === undefined || config.runSpec === undefined
          ? null
          : egressAllowlist(
              'kubernetes',
              config.runSpec.networkPolicy,
              config.runSpec.allowedDomains,
            );
      const shared =
        sharedNamespace === undefined
          ? undefined
          : {
              sessionId: config.sessionId,
              gatewayAddress: clusterIpOf(
                await readGatewayService(client, sharedNamespace, gatewayService),
                'gateway',
              ),
            };
      const build = (proxyHost?: string) =>
        kubernetesRuntimeResources({
          namespace,
          podName,
          image,
          timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
          gatewayNamespace,
          gatewayService,
          ...(options.runtimeClassName === undefined
            ? {}
            : { runtimeClassName: options.runtimeClassName }),
          ...(config.runSpec === undefined ? {} : { runSpec: config.runSpec }),
          ...(shared === undefined ? {} : { shared }),
          ...(proxyImage === undefined || allowlist === null
            ? {}
            : {
                egress: {
                  image: proxyImage,
                  allowlist,
                  bypass: proxyBypass,
                  ...(proxyHost === undefined ? {} : { proxyHost }),
                },
              }),
        });
      const created = await createResources(client, build, podName, options.fieldManager);
      const handle: RuntimeHandle = {
        id,
        driver: 'kubernetes',
        externalId: `${namespace}/${podName}`,
        workspacePath: config.workspacePath,
        createdAt: new Date(),
        expiresAt: new Date(
          Date.now() +
            (config.runSpec?.timeoutSeconds ?? options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) *
              1000,
        ),
      };
      live.set(id, { handle, resources: created });
      return handle;
    },
    async isLive(runtime) {
      const known = live.get(runtime.id);
      if (known === undefined || known.handle.externalId !== runtime.externalId) return false;
      if (client.read === undefined) return true;
      // A pod past its `activeDeadlineSeconds`, or evicted, is `Failed`: the manager must allocate
      // a new one rather than hand the caller an address nothing answers on.
      const [podNamespace, podName] = runtime.externalId.split('/');
      try {
        const pod = await client.read(
          resource('v1', 'Pod', requireValue(podName, 'pod'), podNamespace),
        );
        const phase = (pod.status as { phase?: unknown } | undefined)?.phase;
        return phase === 'Pending' || phase === 'Running';
      } catch (error) {
        if (isKubernetesNotFound(error)) return false;
        throw error;
      }
    },
    async startAgent(runtime, request) {
      const known = live.get(runtime.id);
      if (known === undefined || known.handle.externalId !== runtime.externalId)
        throw new Error('kubernetes runtime: handle is not live');
      return await options.startAgent(runtime, request);
    },
    async destroy(runtime) {
      const known = live.get(runtime.id);
      if (known === undefined || known.handle.externalId !== runtime.externalId)
        throw new Error('kubernetes runtime: handle is not live');
      const cleanup = await deleteResources(client, known.resources);
      if (cleanup.errors.length === 0) {
        live.delete(runtime.id);
        return;
      }
      // Successful and already-absent resources must not be retried, but failed deletions remain
      // live so the caller can safely retry cleanup after a transient control-plane failure.
      known.resources = cleanup.remaining;
      if (cleanup.errors.length === 1) throw cleanup.errors[0];
      throw new AggregateError(
        cleanup.errors,
        `kubernetes runtime: failed to delete ${String(cleanup.errors.length)} resources`,
      );
    },
  };
}
