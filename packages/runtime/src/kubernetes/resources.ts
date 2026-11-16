import type { RuntimeRunSpec } from '../driver.js';
import type { KubernetesResource } from './model.js';
import { EGRESS_PROXY_PORT, egressProxyEnvironment } from '../egress.js';
import { sessionLabelValue } from './session-label.js';

function resourceContext(input: ResourceInput) {
  const runSpec = input.runSpec;
  const timeoutSeconds = runSpec?.timeoutSeconds ?? input.timeoutSeconds;
  const shared = input.shared;
  const labels = {
    'app.kubernetes.io/name': 'agent-runtime',
    'agent-workspace/runtime': input.podName,
    ...(shared === undefined
      ? {}
      : { 'agent-workspace/session': sessionLabelValue(shared.sessionId) }),
  };
  return { runSpec, timeoutSeconds, shared, labels, serviceAccount: 'agent-runtime' };
}

function proxyLabelsFor(input: ResourceInput) {
  return {
    'app.kubernetes.io/name': 'agent-egress-proxy',
    'agent-workspace/egress': input.podName,
  };
}

type ResourceInput = Readonly<{
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
}>;

export function resource(
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

export function kubernetesRuntimeResources(input: ResourceInput): readonly KubernetesResource[] {
  const { runSpec, shared } = resourceContext(input);
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
  const deny = denyResource(input);
  const gateway = gatewayResource(input);
  const egress = input.egress;
  const allowProxy = allowProxyResource(input);
  // The proxy is the one pod that may leave the cluster. It refuses private, loopback and
  // link-local addresses itself; the policy keeps the same ranges closed in case it is misconfigured.
  const proxyPolicy = proxyPolicyResource(input);
  const proxyPod = proxyPodResource(input);
  const proxyService = proxyServiceResource(input);
  const runtimeService = runtimeServiceResource(input);
  const pod = podResource(input);
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

function denyResource(input: ResourceInput): KubernetesResource {
  const { shared, labels } = resourceContext(input);
  const policyName = (base: string) => (shared === undefined ? base : `${base}-${input.podName}`);
  return {
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
}

function gatewayResource(input: ResourceInput): KubernetesResource {
  const { shared, labels } = resourceContext(input);
  const policyName = (base: string) => (shared === undefined ? base : `${base}-${input.podName}`);
  return {
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
}

function allowProxyResource(input: ResourceInput): KubernetesResource {
  const { labels } = resourceContext(input);
  const proxyLabels = proxyLabelsFor(input);
  const proxyPort = [{ protocol: 'TCP', port: EGRESS_PROXY_PORT }];
  return {
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
}

function proxyPolicyResource(input: ResourceInput): KubernetesResource {
  const { labels } = resourceContext(input);
  const proxyLabels = proxyLabelsFor(input);
  const proxyPort = [{ protocol: 'TCP', port: EGRESS_PROXY_PORT }];
  return {
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
}

function proxyPodResource(input: ResourceInput): KubernetesResource {
  const { timeoutSeconds, serviceAccount } = resourceContext(input);
  const egress = input.egress;
  const proxyName = `egress-${input.podName}`;
  const proxyLabels = proxyLabelsFor(input);
  return {
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
}

function proxyServiceResource(input: ResourceInput): KubernetesResource {
  resourceContext(input);
  const proxyName = `egress-${input.podName}`;
  const proxyLabels = proxyLabelsFor(input);
  return {
    ...resource('v1', 'Service', proxyName, input.namespace),
    spec: {
      type: 'ClusterIP',
      selector: proxyLabels,
      ports: [{ protocol: 'TCP', port: EGRESS_PROXY_PORT, targetPort: EGRESS_PROXY_PORT }],
    },
  };
}

function runtimeServiceResource(input: ResourceInput): KubernetesResource {
  const { labels } = resourceContext(input);
  return {
    ...resource('v1', 'Service', input.podName, input.namespace),
    spec: {
      type: 'ClusterIP',
      selector: labels,
      ports: [{ protocol: 'TCP', port: 8080, targetPort: 8080 }],
    },
  };
}

function podResource(input: ResourceInput): KubernetesResource {
  const { runSpec, timeoutSeconds, shared, labels, serviceAccount } = resourceContext(input);
  const { resourceLimits, resourceRequests } = podResources(runSpec);
  const egress = input.egress;
  const sandboxEnv =
    egress?.proxyHost === undefined
      ? []
      : Object.entries(
          egressProxyEnvironment(
            `http://${egress.proxyHost}:${String(EGRESS_PROXY_PORT)}`,
            egress.bypass,
          ),
        ).map(([name, value]) => ({ name, value }));
  const gatewayNames = [
    input.gatewayService,
    `${input.gatewayService}.${input.gatewayNamespace}.svc`,
    `${input.gatewayService}.${input.gatewayNamespace}.svc.cluster.local`,
  ];
  return {
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
}
