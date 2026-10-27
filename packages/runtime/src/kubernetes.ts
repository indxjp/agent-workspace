import { createHash, randomUUID } from 'node:crypto';
import type { KubeConfig, KubernetesObject, KubernetesObjectApi } from '@kubernetes/client-node';

import type {
  AgentConnection,
  RuntimeCapabilities,
  RuntimeDriver,
  RuntimeHandle,
  RuntimeRunSpec,
} from './driver.js';
import { requireEngineImage } from './engine-images.js';
import {
  EGRESS_PROXY_PORT,
  egressAllowlist,
  egressProxyEnvironment,
  requireEgressProxyImage,
  requireProxyBypass,
} from './egress.js';
import type { EngineImageMap } from './engine-images.js';

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

export type KubernetesResource = KubernetesObject & {
  readonly metadata: {
    readonly name: string;
    readonly namespace?: string;
    readonly labels?: Readonly<Record<string, string>>;
  };
  readonly spec?: unknown;
  readonly status?: unknown;
};

export interface KubernetesResourceClient {
  create(resource: KubernetesResource, fieldManager?: string): Promise<KubernetesResource>;
  delete(resource: KubernetesResource): Promise<unknown>;
  /** Needed only by shared-namespace mode, to learn the gateway Service's ClusterIP. */
  read?(resource: KubernetesResource): Promise<KubernetesResource>;
}

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

/** A label value is at most 63 characters of `[A-Za-z0-9_.-]`, beginning and ending alphanumeric. */
export function sessionLabelValue(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_.-]/gu, '-').slice(0, 63);
  return cleaned.replace(/^[^A-Za-z0-9]+/u, '').replace(/[^A-Za-z0-9]+$/u, '') || 'session';
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

function resource(
  apiVersion: string,
  kind: string,
  name: string,
  namespace?: string,
): KubernetesResource {
  return {
    apiVersion,
    kind,
    metadata: { name, ...(namespace === undefined ? {} : { namespace }) },
  };
}

function podResources(runSpec: RuntimeRunSpec | undefined): {
  resourceLimits: Record<string, string>;
  resourceRequests: Record<string, string>;
} {
  const cpu = runSpec?.cpu === undefined ? '1' : String(runSpec.cpu);
  const memory = runSpec?.memoryMb === undefined ? '1Gi' : `${String(runSpec.memoryMb)}Mi`;
  const ephemeralStorage =
    runSpec?.diskMb === undefined ? {} : { 'ephemeral-storage': `${String(runSpec.diskMb)}Mi` };
  const resourceLimits = { cpu, memory, ...ephemeralStorage };
  // A value the profile *names* is a reservation the operator asked for, so the request matches
  // the limit and the pod schedules with Guaranteed QoS at the size it was promised. A value the
  // profile leaves unset is this driver's own ceiling rather than anyone's reservation —
  // requesting it too would make every unconfigured pod hold a whole core and a gibibyte, and
  // small clusters would leave runs `Pending` — so those fall back to the floor this driver used
  // before profiles existed.
  const resourceRequests = {
    cpu: runSpec?.cpu === undefined ? '100m' : cpu,
    memory: runSpec?.memoryMb === undefined ? '128Mi' : memory,
    ...ephemeralStorage,
  };
  return { resourceLimits, resourceRequests };
}

export function kubernetesRuntimeResources(
  input: Readonly<{
    namespace: string;
    podName: string;
    image: string;
    timeoutSeconds: number;
    gatewayNamespace: string;
    gatewayService: string;
    runtimeClassName?: string;
    runSpec?: RuntimeRunSpec;
    /**
     * Shared-namespace mode (see `KubernetesDriverOptions.namespace`). `gatewayAddress` is the
     * gateway Service's ClusterIP, written into the pod's hosts file because the sandbox has no DNS.
     */
    shared?: Readonly<{ sessionId: string; gatewayAddress: string }>;
    /** The per-session proxy (ADR-0117). `proxyHost` is the Service address, known once it exists. */
    egress?: Readonly<{
      image: string;
      allowlist: string;
      proxyHost?: string;
      bypass: readonly string[];
    }>;
  }>,
): readonly KubernetesResource[] {
  const runSpec = input.runSpec;
  const timeoutSeconds = runSpec?.timeoutSeconds ?? input.timeoutSeconds;
  const { resourceLimits, resourceRequests } = podResources(runSpec);
  const shared = input.shared;
  const labels = {
    'app.kubernetes.io/name': 'agent-runtime',
    'agent-workspace/runtime': input.podName,
    ...(shared === undefined
      ? {}
      : { 'agent-workspace/session': sessionLabelValue(shared.sessionId) }),
  };
  const serviceAccount = 'agent-runtime';
  const namespace = resource('v1', 'Namespace', input.namespace);
  const account: KubernetesResource = resource(
    'v1',
    'ServiceAccount',
    serviceAccount,
    input.namespace,
  );
  // Own namespace: `{}` selects every pod there, all of them sandboxes. Shared namespace: the
  // control plane lives beside the sandbox, so each policy selects this pod and carries its name.
  const policyName = (base: string) => (shared === undefined ? base : `${base}-${input.podName}`);
  const deny: KubernetesResource = {
    ...resource(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      policyName('default-deny-egress'),
      input.namespace,
    ),
    spec: {
      podSelector: shared === undefined ? {} : { matchLabels: labels },
      policyTypes: ['Egress'],
      egress: [],
    },
  };
  const gateway: KubernetesResource = {
    ...resource(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      policyName('allow-gateway-egress'),
      input.namespace,
    ),
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': input.gatewayNamespace },
              },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': input.gatewayService } },
            },
          ],
        },
      ],
    },
  };
  const egress = input.egress;
  const proxyName = `egress-${input.podName}`;
  const proxyLabels = {
    'app.kubernetes.io/name': 'agent-egress-proxy',
    'agent-workspace/egress': input.podName,
  };
  const sandboxEnv =
    egress?.proxyHost === undefined
      ? []
      : Object.entries(
          egressProxyEnvironment(
            `http://${egress.proxyHost}:${String(EGRESS_PROXY_PORT)}`,
            egress.bypass,
          ),
        ).map(([name, value]) => ({ name, value }));
  const proxyPort = [{ protocol: 'TCP', port: EGRESS_PROXY_PORT }];
  const allowProxy: KubernetesResource = {
    ...resource(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      `allow-proxy-egress-${input.podName}`,
      input.namespace,
    ),
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ['Egress'],
      egress: [{ to: [{ podSelector: { matchLabels: proxyLabels } }], ports: proxyPort }],
    },
  };
  // The proxy is the one pod that may leave the cluster. It refuses private, loopback and
  // link-local addresses itself; the policy keeps the same ranges closed in case it is misconfigured.
  const proxyPolicy: KubernetesResource = {
    ...resource(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      `egress-proxy-${input.podName}`,
      input.namespace,
    ),
    spec: {
      podSelector: { matchLabels: proxyLabels },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [{ podSelector: { matchLabels: labels } }], ports: proxyPort }],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            },
          ],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
        {
          to: [
            {
              ipBlock: {
                cidr: '0.0.0.0/0',
                except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'],
              },
            },
          ],
        },
      ],
    },
  };
  const proxyPod: KubernetesResource = {
    ...resource('v1', 'Pod', proxyName, input.namespace),
    metadata: { name: proxyName, namespace: input.namespace, labels: proxyLabels },
    spec: {
      serviceAccountName: serviceAccount,
      automountServiceAccountToken: false,
      restartPolicy: 'Never',
      activeDeadlineSeconds: timeoutSeconds,
      ...(input.runtimeClassName === undefined ? {} : { runtimeClassName: input.runtimeClassName }),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'egress-proxy',
          image: egress?.image ?? '',
          env: [
            { name: 'EGRESS_SESSION_ID', value: input.podName },
            { name: 'EGRESS_ALLOWLIST', value: egress?.allowlist ?? '' },
          ],
          ports: [{ containerPort: EGRESS_PROXY_PORT }],
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            capabilities: { drop: ['ALL'] },
          },
          resources: {
            requests: { cpu: '50m', memory: '64Mi' },
            limits: { cpu: '500m', memory: '256Mi' },
          },
        },
      ],
    },
  };
  const proxyService: KubernetesResource = {
    ...resource('v1', 'Service', proxyName, input.namespace),
    spec: {
      type: 'ClusterIP',
      selector: proxyLabels,
      ports: [{ protocol: 'TCP', port: EGRESS_PROXY_PORT, targetPort: EGRESS_PROXY_PORT }],
    },
  };
  const gatewayNames = [
    input.gatewayService,
    `${input.gatewayService}.${input.gatewayNamespace}.svc`,
    `${input.gatewayService}.${input.gatewayNamespace}.svc.cluster.local`,
  ];
  const runtimeService: KubernetesResource = {
    ...resource('v1', 'Service', input.podName, input.namespace),
    spec: {
      type: 'ClusterIP',
      selector: labels,
      ports: [{ protocol: 'TCP', port: 8080, targetPort: 8080 }],
    },
  };
  const pod: KubernetesResource = {
    ...resource('v1', 'Pod', input.podName, input.namespace),
    metadata: { name: input.podName, namespace: input.namespace, labels },
    spec: {
      serviceAccountName: serviceAccount,
      automountServiceAccountToken: false,
      restartPolicy: 'Never',
      activeDeadlineSeconds: timeoutSeconds,
      ...(input.runtimeClassName === undefined ? {} : { runtimeClassName: input.runtimeClassName }),
      ...(shared === undefined
        ? {}
        : { hostAliases: [{ ip: shared.gatewayAddress, hostnames: gatewayNames }] }),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'runtime',
          image: input.image,
          workingDir: '/workspace',
          ...(sandboxEnv.length === 0 ? {} : { env: sandboxEnv }),
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            capabilities: { drop: ['ALL'] },
          },
          resources: { requests: resourceRequests, limits: resourceLimits },
          volumeMounts: [
            {
              name: 'workspace',
              mountPath: '/workspace',
              ...(runSpec?.filesystem === 'read-only' ? { readOnly: true } : {}),
            },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      volumes: [
        {
          name: 'workspace',
          emptyDir:
            runSpec?.diskMb === undefined ? {} : { sizeLimit: `${String(runSpec.diskMb)}Mi` },
        },
        { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } },
      ],
    },
  };
  // Without a proxy, `open` carries no policy at all; `none` is default-deny *without* the gateway
  // exception, or the profile's own "no network" promise would still leave one egress route open.
  // With a proxy (ADR-0117) `open` is default-deny too: the only way out is the proxy. In the
  // release namespace the chart's default-deny already applies, so an unproxied `open` would lose
  // the gateway too; it fails closed to gateway-only — no proxy, no internet (ADR-0117).
  const own = shared === undefined ? [namespace, account] : [];
  const tail = shared === undefined ? [pod] : [pod, runtimeService];
  if (egress !== undefined) {
    return [...own, deny, gateway, allowProxy, proxyPolicy, proxyPod, proxyService, ...tail];
  }
  const policies =
    runSpec?.networkPolicy === 'open' && shared === undefined
      ? []
      : runSpec?.networkPolicy === 'none'
        ? [deny]
        : [deny, gateway];
  return [...own, ...policies, ...tail];
}

export type KubernetesDriver<TRequest, TEvent> = RuntimeDriver<TRequest, TEvent> &
  Readonly<{ isLive(runtime: RuntimeHandle): Promise<boolean> }>;

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
          timeoutSeconds: options.timeoutSeconds ?? 3600,
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
          const made = await client.create(toCreate, options.fieldManager);
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
      const handle: RuntimeHandle = {
        id,
        driver: 'kubernetes',
        externalId: `${namespace}/${podName}`,
        workspacePath: config.workspacePath,
        createdAt: new Date(),
        expiresAt: new Date(
          Date.now() + (config.runSpec?.timeoutSeconds ?? options.timeoutSeconds ?? 3600) * 1000,
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
