import { type RuntimeHandle } from '@agent-workspace/runtime/driver';
import {
  createKubernetesDriver,
  inClusterKubernetesClient,
  type KubernetesResourceClient,
} from '@agent-workspace/runtime/driver/kubernetes';
import type { DriverOptions } from './manager-driver-settings.js';
import { engineImagesFor } from './manager-driver-settings.js';
import { proxyBypassFor } from './manager-driver-settings.js';
import { noAgentStart } from './manager-driver-settings.js';
import { imagesFingerprint } from './manager-driver-settings.js';

/** The field manager every object the kubernetes driver creates is recorded under. */
export const KUBERNETES_FIELD_MANAGER = 'agent-workspace-runner-manager';

/**
 * `RUNTIME_DRIVER=kubernetes`: one sandbox Pod per session, created in the manager's own namespace
 * with the ServiceAccount credentials the cluster mounts into this pod (never a kubeconfig). The
 * chart gives the manager a namespaced Role, so the driver runs in shared-namespace mode: it creates
 * no Namespace and each session gets a Service the manager reaches it by.
 *
 * The manager's allocation registry is process-local, so the chart runs exactly one replica. `client`
 * is for the suite; production leaves it unset.
 */
export function kubernetesDriverOptions(
  env: Readonly<Record<string, string | undefined>>,
  client?: KubernetesResourceClient,
): DriverOptions {
  const required = (name: string): string => {
    const value = env[name]?.trim() ?? '';
    if (value === '') {
      throw new Error(`runner manager: ${name} must be set when RUNTIME_DRIVER is kubernetes.`);
    }
    return value;
  };
  const namespace = required('RUNTIME_KUBERNETES_NAMESPACE');
  const gatewayService = required('RUNTIME_GATEWAY_SERVICE');
  if (client === undefined && (env['KUBERNETES_SERVICE_HOST']?.trim() ?? '') === '') {
    throw new Error(
      'runner manager: RUNTIME_DRIVER=kubernetes needs the in-cluster ServiceAccount; run it in a pod.',
    );
  }
  const images = engineImagesFor(env);
  const egressProxyImage = env['AGENT_WORKSPACE_EGRESS_PROXY_IMAGE']?.trim() ?? '';
  const runtimeClassName = env['RUNTIME_CLASS_NAME']?.trim() ?? '';
  const proxyBypass = proxyBypassFor(env);
  const driver = createKubernetesDriver<never, never>({
    images,
    namespace,
    gatewayService,
    fieldManager: KUBERNETES_FIELD_MANAGER,
    requireDigest: env['NODE_ENV'] === 'production',
    client: client ?? inClusterKubernetesClient(),
    startAgent: noAgentStart,
    ...(egressProxyImage === '' ? {} : { egressProxyImage, proxyBypass }),
    ...(runtimeClassName === '' ? {} : { runtimeClassName }),
  });
  return {
    driver,
    expectedDriver: 'kubernetes',
    runtimeOrigin: kubernetesRuntimeOrigin,
    configurationFingerprint: `kubernetes:${namespace}:${imagesFingerprint(images)}${
      egressProxyImage === '' ? '' : `+proxy=${egressProxyImage}`
    }`,
    toolSandboxRefusal:
      'a tool sandbox is not started on the kubernetes runtime: its placement is a follow-up of #854',
  };
}

/** `externalId` is `<namespace>/<pod>`; the Service the driver creates carries the pod's name. */
export function kubernetesRuntimeOrigin(handle: RuntimeHandle): string {
  const [namespace, pod] = handle.externalId.split('/');
  if (namespace === undefined || pod === undefined || pod === '') {
    throw new Error('runner manager: a kubernetes handle names a namespace and a pod.');
  }
  return `http://${pod}.${namespace}.svc:8080`;
}
