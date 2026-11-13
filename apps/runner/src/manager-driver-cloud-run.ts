import {
  createCloudRunAdminClient,
  createCloudRunDriver,
  fetchCloudRunAccessToken,
  fetchCloudRunIdentityToken,
} from '@agent-workspace/runtime/driver/cloud-run';
import { createToolSandboxes, TOOL_SANDBOX_ENGINE } from './tool-sandbox.js';
import type { DriverOptions } from './manager-driver-settings.js';
import { engineImagesFor } from './manager-driver-settings.js';
import { proxyBypassFor } from './manager-driver-settings.js';
import { noAgentStart, requiredDriverSetting } from './manager-driver-settings.js';
import { toolSandboxTimeoutSeconds } from './manager-driver-settings.js';
import { imagesFingerprint } from './manager-driver-settings.js';

function cloudRunNetworkFor(env: Readonly<Record<string, string | undefined>>) {
  const network = (env['RUNTIME_NETWORK'] ?? '').trim();
  const subnetwork = (env['RUNTIME_SUBNETWORK'] ?? '').trim();
  if (network === '' || subnetwork === '') {
    throw new Error(
      'RUNTIME_DRIVER=cloud-run-service needs RUNTIME_NETWORK and RUNTIME_SUBNETWORK: every sandbox joins that VPC network, whose firewall denies its egress.',
    );
  }
  for (const [legacy, replacement] of [
    ['RUNTIME_VPC_CONNECTOR', 'RUNTIME_NETWORK and RUNTIME_SUBNETWORK'],
    [
      'RUNTIME_EGRESS',
      'RUNTIME_NETWORK and RUNTIME_SUBNETWORK (a Cloud Run sandbox reaches the internet through the egress proxy that gcp.sandboxInternet: true adds; it is set with RUNTIME_EGRESS_PROXY_URL and RUNTIME_EGRESS_PROXY_KEY)',
    ],
  ] as const) {
    if ((env[legacy] ?? '').trim() !== '') {
      throw new Error(
        `${legacy} is no longer supported for cloud-run-service; use ${replacement} instead.`,
      );
    }
  }
  const egressProxyUrl = (env['RUNTIME_EGRESS_PROXY_URL'] ?? '').trim();
  const egressProxyKey = (env['RUNTIME_EGRESS_PROXY_KEY'] ?? '').trim();
  if ((egressProxyUrl === '') !== (egressProxyKey === '')) {
    throw new Error(
      'RUNTIME_EGRESS_PROXY_URL and RUNTIME_EGRESS_PROXY_KEY must be set together: the key signs the credential a sandbox presents to the egress proxy at that URL.',
    );
  }
  return { network, subnetwork, egressProxyUrl, egressProxyKey };
}

function runAppOrigin(serviceUrl: string, prefix: string): string | undefined {
  const url = URL.canParse(serviceUrl) ? new URL(serviceUrl) : undefined;
  return url?.protocol === 'https:' &&
    url.hostname.startsWith(prefix) &&
    url.hostname.endsWith('.run.app')
    ? url.origin
    : undefined;
}

/**
 * The origin the gateway calls for a Cloud Run tool sandbox: the service's URL, which must be
 * `https://rt-tool-….run.app`. The gateway's only invoke grant is conditioned on that host
 * (`gateway_invokes_tool_sandboxes` in infra/terraform/gcp-cloudrun/main.tf), because Cloud Run
 * gives the invoke check `request.host` but not the service's name. A sandbox at any other URL
 * would be refused by Cloud Run on every call, so it is refused here, by name, instead.
 */
export function cloudRunToolSandboxOrigin(serviceUrl: string): string {
  const origin = runAppOrigin(serviceUrl, 'rt-tool-');
  if (origin === undefined) {
    throw new Error(
      `cloud-run tool sandbox: its URL ${serviceUrl} is not https://rt-tool-….run.app, the only host the gateway's invoke grant (request.host) matches.`,
    );
  }
  return origin;
}

/**
 * The origin the runner manager calls for a Cloud Run agent sandbox: the service's URL, which must
 * be `https://rt-….run.app`. The manager's invoke grant is conditioned on that host
 * (`runner_manager_run_invoker` in infra/terraform/gcp-cloudrun/main.tf), for the same reason as
 * {@link cloudRunToolSandboxOrigin}, so a sandbox at any other URL is refused here, by name.
 */
export function cloudRunSandboxOrigin(serviceUrl: string): string {
  const origin = runAppOrigin(serviceUrl, 'rt-');
  if (origin === undefined) {
    throw new Error(
      `cloud-run sandbox: its URL ${serviceUrl} is not https://rt-….run.app, the only host the runner manager's invoke grant (request.host) matches.`,
    );
  }
  return origin;
}

/**
 * `RUNTIME_DRIVER=cloud-run-service` deploys one private Cloud Run v2 service per session instead
 * of one Docker container. See `docs/adr/ADR-cloud-run-service-driver.md` and
 * `packages/runtime/src/cloud-run.ts` for why this exists in place of the spec's aspirational
 * `cloud-run-sandbox` driver.
 */
export function cloudRunDriverOptions(
  env: Readonly<Record<string, string | undefined>>,
): DriverOptions {
  const images = engineImagesFor(env);
  const { network, subnetwork, egressProxyUrl, egressProxyKey } = cloudRunNetworkFor(env);
  const project = requiredDriverSetting(env, 'GCP_PROJECT', 'cloud-run-service');
  const region = requiredDriverSetting(env, 'GCP_REGION', 'cloud-run-service');
  const serviceAccount = requiredDriverSetting(env, 'RUNTIME_SERVICE_ACCOUNT', 'cloud-run-service');
  const client = createCloudRunAdminClient({ accessToken: fetchCloudRunAccessToken });
  const toolHostImage = (env['AGENT_WORKSPACE_TOOL_HOST_IMAGE'] ?? '').trim();
  const requireDigest = env['NODE_ENV'] === 'production';
  // TS5: the egress proxy is the tool host's only way out. `requireProxyBypass` accepts an empty
  // list, so the tool driver gets none: unlike the agent, it has no gateway it must reach direct.
  const egressProxy =
    egressProxyUrl === ''
      ? undefined
      : { url: egressProxyUrl, key: egressProxyKey, bypass: proxyBypassFor(env) };
  const shared = {
    project,
    region,
    serviceAccount,
    requireDigest,
    network,
    subnetwork,
    client,
    startAgent: noAgentStart,
  };
  const toolDriver =
    toolHostImage === ''
      ? undefined
      : createCloudRunDriver<never, never>({
          images: new Map([[TOOL_SANDBOX_ENGINE, toolHostImage]]),
          ...shared,
          serviceIdPrefix: 'rt-tool-',
          fileIntake: { identityToken: fetchCloudRunIdentityToken },
          ...(egressProxy === undefined ? {} : { egressProxy: { ...egressProxy, bypass: [] } }),
        });
  return {
    ...cloudRunTools(toolDriver, env),
    driver: createCloudRunDriver<never, never>({
      images,
      ...shared,
      ...(egressProxy === undefined ? {} : { egressProxy }),
    }),
    expectedDriver: 'cloud-run-service',
    runtimeOrigin: (handle) => cloudRunSandboxOrigin(handle.externalId),
    runtimeAuthHeaders: async (handle) => ({
      authorization: `Bearer ${await fetchCloudRunIdentityToken(cloudRunSandboxOrigin(handle.externalId))}`,
    }),
    configurationFingerprint: `cloud-run-service:${imagesFingerprint(images)}:${network}:${subnetwork}${
      egressProxyUrl === '' ? '' : `+proxy=${egressProxyUrl}`
    }${toolHostImage === '' ? '' : `+tools=${toolHostImage}`}`,
    // Google Cloud's edge intercepts the literal path `/healthz` on a *.a.run.app default domain
    // and never reaches the container — see `readinessPath` on `RunnerManagerOptions` and
    // docs/adr/ADR-cloud-run-service-driver.md. `/ping` is the same liveness handler, mounted at a
    // second path the edge does not reserve.
    readinessPath: '/ping',
  };
}

function cloudRunTools(
  toolDriver: ReturnType<typeof createCloudRunDriver<never, never>> | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Pick<DriverOptions, 'toolSandboxes' | 'toolSandboxRefusal'> {
  return toolDriver === undefined
    ? {
        toolSandboxRefusal:
          'a tool sandbox is not started on cloud-run-service: set AGENT_WORKSPACE_TOOL_HOST_IMAGE to the tool-host image',
      }
    : {
        toolSandboxes: createToolSandboxes({
          driver: toolDriver,
          driverId: 'cloud-run-service',
          origin: (handle) => cloudRunToolSandboxOrigin(handle.externalId),
          fetch: async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            const headers = new Headers(init?.headers);
            headers.set(
              'x-serverless-authorization',
              `Bearer ${await fetchCloudRunIdentityToken(new URL(url).origin)}`,
            );
            return await globalThis.fetch(input, { ...init, headers });
          },
          servingWhen: (status) => status < 500,
          timeoutSeconds: toolSandboxTimeoutSeconds(env),
        }),
      };
}
