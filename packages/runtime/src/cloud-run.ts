/**
 * The `cloud-run-service` runtime driver (see `driver.ts`'s union comment and
 * `docs/adr/ADR-cloud-run-service-driver.md` for why this exists instead of the spec's
 * `cloud-run-sandbox`).
 *
 * One `create()` deploys one private Cloud Run v2 service running the runtime image; one
 * `destroy()` deletes that exact service. Same one-resource-per-session shape as `docker.ts`
 * (one container) and `kubernetes.ts` (one pod) — just over the Cloud Run Admin API instead of the
 * Docker socket or the Kubernetes API.
 */
import { randomUUID } from 'node:crypto';

import type {
  AgentConnection,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeDriver,
  RuntimeHandle,
  RuntimeRunSpec,
} from './driver.js';
import { assertDigestPinnedEngineImages, requireEngineImage } from './engine-images.js';
import type { EngineImageMap } from './engine-images.js';

export type CloudRunRuntimeCapabilities = RuntimeCapabilities &
  Readonly<{ managedByProvider: true }>;

/**
 * gen2 execution environment: a microVM with full Linux compatibility, not gVisor's syscall
 * emulation — spec appendix A.7.2 calls this out explicitly as the one to use for the runner.
 * Cloud Run has no bind-mountable persistent volume, so `persistentFilesystem` is false; the
 * manager still forwards `/files` over the same §14.3 HTTP contract every other driver uses, it is
 * just this driver's `create()` that cannot promise a volume survives past `destroy()`.
 */
export const CLOUD_RUN_RUNTIME_CAPABILITIES: CloudRunRuntimeCapabilities = {
  isolation: 'microvm',
  customImage: true,
  persistentFilesystem: false,
  sessionAffinity: true,
  maxSessionSeconds: 3600,
  networkPolicies: ['none', 'open'],
  execCommands: true,
  gpu: false,
  managedByProvider: true,
  typicalStartMs: 3_000,
};

export type CloudRunServiceSpec = Readonly<{
  serviceId: string;
  image: string;
  region: string;
  project: string;
  serviceAccount: string;
  vpcConnector?: string;
  egress: 'none' | 'open';
  cpu?: number;
  memoryMb?: number;
  timeoutSeconds?: number;
  labels: Readonly<Record<string, string>>;
}>;

export type CloudRunServiceStatus = Readonly<{
  name: string;
  url: string;
  ready: boolean;
}>;

export interface CloudRunResourceClient {
  createService(spec: CloudRunServiceSpec): Promise<CloudRunServiceStatus>;
  getService(name: string): Promise<CloudRunServiceStatus | null>;
  deleteService(name: string): Promise<void>;
}

/** Cloud Run v2 REST client, authenticated with Application Default Credentials. */
export function createCloudRunAdminClient(options: {
  fetch?: typeof globalThis.fetch;
  accessToken: () => Promise<string>;
}): CloudRunResourceClient {
  const doFetch = options.fetch ?? globalThis.fetch;

  async function authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await options.accessToken();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.set('content-type', 'application/json');
    return await doFetch(url, { ...init, headers });
  }

  function serviceUrl(name: string): string {
    return `https://run.googleapis.com/v2/${name}`;
  }

  function stringField(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  function toStatus(body: Record<string, unknown>): CloudRunServiceStatus {
    const condition = body['terminalCondition'] as { state?: unknown } | undefined;
    return {
      name: stringField(body['name']),
      url: stringField(body['uri']),
      ready: condition?.state === 'CONDITION_SUCCEEDED',
    };
  }

  return {
    async createService(spec) {
      const parent = `projects/${spec.project}/locations/${spec.region}`;
      const response = await authorizedFetch(
        `https://run.googleapis.com/v2/${parent}/services?serviceId=${spec.serviceId}`,
        {
          method: 'POST',
          body: JSON.stringify({
            labels: spec.labels,
            ingress: 'INGRESS_TRAFFIC_ALL',
            template: {
              serviceAccount: spec.serviceAccount,
              timeout: `${String(spec.timeoutSeconds ?? 3600)}s`,
              executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
              maxInstanceRequestConcurrency: 1,
              scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
              ...(spec.vpcConnector === undefined
                ? {}
                : {
                    vpcAccess: {
                      connector: spec.vpcConnector,
                      egress: spec.egress === 'open' ? 'ALL_TRAFFIC' : 'PRIVATE_RANGES_ONLY',
                    },
                  }),
              containers: [
                {
                  image: spec.image,
                  ports: [{ containerPort: 8080 }],
                  resources: {
                    limits: {
                      cpu: String(spec.cpu ?? 1),
                      memory: `${String(spec.memoryMb ?? 1024)}Mi`,
                    },
                  },
                },
              ],
            },
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `cloud-run runtime: create service ${spec.serviceId} failed: ${String(response.status)} ${await response.text()}`,
        );
      }
      const operation = (await response.json()) as { metadata?: { name?: unknown } };
      const name =
        typeof operation.metadata?.name === 'string'
          ? operation.metadata.name
          : `${parent}/services/${spec.serviceId}`;
      return { name, url: '', ready: false };
    },

    async getService(name) {
      const response = await authorizedFetch(serviceUrl(name));
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(
          `cloud-run runtime: get service ${name} failed: ${String(response.status)} ${await response.text()}`,
        );
      }
      return toStatus((await response.json()) as Record<string, unknown>);
    },

    async deleteService(name) {
      const response = await authorizedFetch(serviceUrl(name), { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw new Error(
          `cloud-run runtime: delete service ${name} failed: ${String(response.status)} ${await response.text()}`,
        );
      }
    },
  };
}

export type CloudRunAgentStarter<TRequest, TEvent> = (
  runtime: RuntimeHandle,
  request: TRequest,
) => AgentConnection<TEvent> | Promise<AgentConnection<TEvent>>;

export type CloudRunDriverOptions<TRequest, TEvent> = Readonly<{
  /** ENG-07: one image per engine; the service is deployed from the one for `config.engine`. */
  images: EngineImageMap;
  project: string;
  region: string;
  serviceAccount: string;
  startAgent: CloudRunAgentStarter<TRequest, TEvent>;
  vpcConnector?: string;
  egress?: 'none' | 'open';
  client?: CloudRunResourceClient;
  /** Production managers set this so mutable tags cannot cross the runtime boundary. */
  requireDigest?: boolean;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
}>;

export type CloudRunDriver<TRequest, TEvent> = RuntimeDriver<TRequest, TEvent> &
  Readonly<{
    capabilities: CloudRunRuntimeCapabilities;
    isLive(runtime: RuntimeHandle): Promise<boolean>;
  }>;

function requireValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`cloud-run runtime: ${name} must be a non-empty string.`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertCompatibleRunSpec(spec: RuntimeRunSpec | undefined): void {
  if (spec === undefined) return;
  if (spec.driver !== 'cloud-run-service') {
    throw new Error(`cloud-run runtime: run spec selects incompatible driver ${spec.driver}.`);
  }
  if (spec.networkPolicy === 'restricted') {
    throw new Error(
      'cloud-run runtime: restricted network policy requires an allowlist proxy, which this driver does not run (ADR-0117 decision 7).',
    );
  }
  if (spec.allowedDomains !== undefined && spec.allowedDomains.length > 0) {
    throw new Error(
      'cloud-run runtime: allowedDomains requires restricted proxy enforcement, which this driver does not run (ADR-0117 decision 7).',
    );
  }
  if (spec.persistPaths !== undefined && spec.persistPaths.length > 0) {
    throw new Error(
      'cloud-run runtime: persistPaths cannot be enforced without a mountable volume.',
    );
  }
  if (spec.cpu !== undefined && (!Number.isFinite(spec.cpu) || spec.cpu <= 0)) {
    throw new Error('cloud-run runtime: cpu must be a positive finite number.');
  }
  if (
    spec.memoryMb !== undefined &&
    (!Number.isSafeInteger(spec.memoryMb) || spec.memoryMb < 128)
  ) {
    throw new Error('cloud-run runtime: memoryMb must be a safe integer of at least 128.');
  }
}

export function createCloudRunDriver<TRequest, TEvent>(
  options: CloudRunDriverOptions<TRequest, TEvent>,
): CloudRunDriver<TRequest, TEvent> {
  const images = options.images;
  if (options.requireDigest === true) assertDigestPinnedEngineImages(images, 'cloud-run');
  const project = requireValue(options.project, 'project');
  const region = requireValue(options.region, 'region');
  const serviceAccount = requireValue(options.serviceAccount, 'serviceAccount');
  const client =
    options.client ??
    (() => {
      throw new Error('cloud-run runtime: a CloudRunResourceClient must be supplied.');
    })();
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
  const live = new Map<string, RuntimeHandle>();

  function assertLive(runtime: RuntimeHandle, operation: string): RuntimeHandle {
    const known = live.get(runtime.id);
    if (known === undefined || known.externalId !== runtime.externalId) {
      throw new Error(
        `cloud-run runtime: cannot ${operation}; handle ${JSON.stringify(runtime.id)} was not created by this driver or is no longer live.`,
      );
    }
    return known;
  }

  return {
    id: 'cloud-run-service',
    capabilities: CLOUD_RUN_RUNTIME_CAPABILITIES,

    async create(config: RuntimeConfig): Promise<RuntimeHandle> {
      requireValue(config.sessionId, 'sessionId');
      assertCompatibleRunSpec(config.runSpec);
      // ENG-07: the service's image is the run's engine's, resolved before a service is deployed.
      const image = requireEngineImage(images, requireValue(config.engine, 'engine'), 'cloud-run');
      const spec = config.runSpec;
      const id = randomUUID();
      // Cloud Run service ids are DNS labels: lowercase, <=63 chars, start with a letter.
      const serviceId = `rt-${id}`;
      const created = await client.createService({
        serviceId,
        image,
        region,
        project,
        serviceAccount,
        egress: spec?.networkPolicy === 'open' ? 'open' : (options.egress ?? 'none'),
        ...(options.vpcConnector === undefined ? {} : { vpcConnector: options.vpcConnector }),
        ...(spec?.cpu === undefined ? {} : { cpu: spec.cpu }),
        ...(spec?.memoryMb === undefined ? {} : { memoryMb: spec.memoryMb }),
        ...(spec?.timeoutSeconds === undefined ? {} : { timeoutSeconds: spec.timeoutSeconds }),
        labels: {
          'agent-workspace-runtime': 'cloud-run-service',
          'agent-workspace-runtime-id': id,
        },
      });

      const deadline = Date.now() + readyTimeoutMs;
      let status = created;
      while (!status.ready || status.url === '') {
        if (Date.now() > deadline) {
          await client.deleteService(created.name).catch(() => undefined);
          throw new Error(
            `cloud-run runtime: service ${serviceId} did not become ready within ${String(readyTimeoutMs)}ms.`,
          );
        }
        await sleep(pollIntervalMs);
        const polled = await client.getService(created.name);
        if (polled === null) {
          throw new Error(`cloud-run runtime: service ${serviceId} disappeared while starting.`);
        }
        status = polled;
      }

      const handle: RuntimeHandle = {
        id,
        driver: 'cloud-run-service',
        externalId: status.url,
        workspacePath: config.workspacePath,
        createdAt: new Date(),
        ...(spec?.timeoutSeconds === undefined
          ? {}
          : { expiresAt: new Date(Date.now() + spec.timeoutSeconds * 1_000) }),
      };
      live.set(id, handle);
      return handle;
    },

    async startAgent(runtime, request) {
      return await options.startAgent(assertLive(runtime, 'start an agent'), request);
    },

    async destroy(runtime) {
      const known = assertLive(runtime, 'destroy');
      await client.deleteService(`projects/${project}/locations/${region}/services/rt-${known.id}`);
      live.delete(known.id);
    },

    async isLive(runtime) {
      const known = live.get(runtime.id);
      if (known === undefined || known.externalId !== runtime.externalId) return false;
      const status = await client.getService(
        `projects/${project}/locations/${region}/services/rt-${known.id}`,
      );
      return status !== null && status.ready;
    },
  };
}
