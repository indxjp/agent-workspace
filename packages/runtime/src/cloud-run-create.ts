import { DEFAULT_SERVICE_TIMEOUT_SECONDS } from './cloud-run-contract.js';

import { randomBytes, randomUUID } from 'node:crypto';

import { requireValue, resolveCloudRunOptions } from './cloud-run-config.js';
import {
  type CloudRunResourceClient,
  type CloudRunServiceSpec,
  type CloudRunServiceStatus,
} from './cloud-run-contract.js';
import {
  CloudRunServiceRegistry,
  EXPIRES_LABEL,
  PROFILE_LABEL,
  labelKey,
  labelValue,
} from './cloud-run-registry.js';
import type { RuntimeConfig, RuntimeHandle, RuntimeRunSpec } from './driver.js';
import {
  egressAllowlist,
  egressProxyEnvironment,
  proxyUrlWithCredential,
  signEgressCredential,
} from './egress.js';
import { requireEngineImage } from './engine-images.js';

/** Seconds a credential outlives the service timeout, so a late request is not refused. */
const CREDENTIAL_GRACE_SECONDS = 300;

/**
 * The tool host's directory on Cloud Run, which mounts nothing: the image's default `/workspace`
 * is Docker's tmpfs mount and does not exist in the image, and its user (uid 1000) cannot create
 * it, so every upload would fail. `/tmp` is writable, and on Cloud Run it is in memory.
 */
const CLOUD_RUN_TOOL_HOST_DIR = '/tmp/tool-host';
/** A tool host serves parallel MCP calls and file intakes; Cloud Run caps an instance at 1000. */
const TOOL_HOST_CONCURRENCY = 80;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ResolvedEgressProxy = Readonly<{ url: string; key: string; bypass: readonly string[] }>;

/** Validates the run spec and returns the sandbox environment its network policy needs. */
function assertCompatibleRunSpec(
  spec: RuntimeRunSpec | undefined,
  sessionId: string,
  egressProxy: ResolvedEgressProxy | undefined,
  nowMs: number,
): { readonly env: Readonly<Record<string, string>>; readonly expSeconds: number } | undefined {
  if (spec === undefined) return undefined;
  if (spec.driver !== 'cloud-run-service') {
    throw new Error(`cloud-run runtime: run spec selects incompatible driver ${spec.driver}.`);
  }
  // Validated first: domains on the wrong policy are a spec error that sandboxInternet would not fix.
  const allowlist = egressAllowlist('cloud-run', spec.networkPolicy, spec.allowedDomains);
  const needsProxy = spec.networkPolicy === 'restricted' || spec.networkPolicy === 'open';
  if (needsProxy && egressProxy === undefined) {
    throw new Error(
      `cloud-run runtime: the ${spec.networkPolicy} network policy is refused on Cloud Run: you need gcp.sandboxInternet: true in agent-workspace.yaml, which adds the sandbox egress proxy. Without it Cloud Run sandboxes support only none.`,
    );
  }
  assertResources(spec);
  if (egressProxy === undefined) return undefined;
  if (allowlist === null) return undefined;
  const expSeconds =
    Math.floor(nowMs / 1_000) +
    (spec.timeoutSeconds ?? DEFAULT_SERVICE_TIMEOUT_SECONDS) +
    CREDENTIAL_GRACE_SECONDS;
  const token = signEgressCredential(egressProxy.key, {
    sid: sessionId,
    exp: expSeconds,
    hosts: allowlist.split(','),
  });
  return {
    env: egressProxyEnvironment(proxyUrlWithCredential(egressProxy.url, token), egressProxy.bypass),
    expSeconds,
  };
}

function assertResources(spec: RuntimeRunSpec): void {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForService(options: {
  readonly client: CloudRunResourceClient;
  readonly created: CloudRunServiceStatus;
  readonly serviceId: string;
  readonly readyTimeoutMs: number;
  readonly pollIntervalMs: number;
}): Promise<CloudRunServiceStatus> {
  const { client, created, serviceId, readyTimeoutMs, pollIntervalMs } = options;
  const deadline = Date.now() + readyTimeoutMs;
  let status = created;
  while (!status.ready || status.url === '') {
    if (Date.now() > deadline) {
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
  return status;
}

function runtimeServiceSpec(
  config: RuntimeConfig,
  environment: ReturnType<typeof resolveCloudRunOptions>,
  deployment: {
    readonly id: string;
    readonly image: string;
    readonly env: Readonly<Record<string, string>> | undefined;
    readonly intakeKey: string | undefined;
    readonly tags: Readonly<Record<string, string>>;
  },
): CloudRunServiceSpec {
  const { project, region, network, subnetwork, serviceAccount, serviceIdPrefix, fileIntake, now } =
    environment;
  const { id, image, env, intakeKey, tags } = deployment;
  const spec = config.runSpec;
  const serviceId = `${serviceIdPrefix}${id}`;
  const timeoutSeconds = spec?.timeoutSeconds ?? DEFAULT_SERVICE_TIMEOUT_SECONDS;
  const serviceEnv =
    intakeKey === undefined
      ? env
      : { ...env, AW_TOOL_INTAKE_KEY: intakeKey, TOOL_HOST_DIR: CLOUD_RUN_TOOL_HOST_DIR };
  return {
    serviceId,
    image,
    region,
    project,
    serviceAccount,
    network,
    subnetwork,
    ...(spec?.cpu === undefined ? {} : { cpu: spec.cpu }),
    ...(spec?.memoryMb === undefined ? {} : { memoryMb: spec.memoryMb }),
    ...(spec?.timeoutSeconds === undefined ? {} : { timeoutSeconds: spec.timeoutSeconds }),
    ...(serviceEnv === undefined ? {} : { env: serviceEnv }),
    // The intake keeps manifest and tokens in this instance's memory: never scale to zero.
    ...(fileIntake === undefined
      ? {}
      : { minInstances: 1, maxRequestConcurrency: TOOL_HOST_CONCURRENCY }),
    labels: {
      'agent-workspace-runtime': 'cloud-run-service',
      'agent-workspace-runtime-id': id,
      ...(config.runtimeProfileId === undefined
        ? {}
        : { [PROFILE_LABEL]: labelValue(config.runtimeProfileId) }),
      // Cloud Run's timeout is per request: this is the service's own lifetime bound.
      ...(fileIntake === undefined
        ? {}
        : { [EXPIRES_LABEL]: String(Math.floor(now() / 1_000) + timeoutSeconds) }),
      ...Object.fromEntries(
        Object.entries(tags).map(([tag, value]) => [labelKey(tag), labelValue(value)]),
      ),
    },
  };
}

type CloudRunCreationContext = {
  readonly environment: ReturnType<typeof resolveCloudRunOptions>;
  readonly registry: CloudRunServiceRegistry;
};

export async function createRuntimeService(
  config: RuntimeConfig,
  context: CloudRunCreationContext,
  tags: Readonly<Record<string, string>>,
): Promise<RuntimeHandle> {
  const { environment, registry } = context;
  const {
    images,
    egressProxy,
    now,
    serviceIdPrefix,
    fileIntake,
    client,
    pollIntervalMs,
    readyTimeoutMs,
  } = environment;
  requireValue(config.sessionId, 'sessionId');
  const proxied = assertCompatibleRunSpec(config.runSpec, config.sessionId, egressProxy, now());
  const env = proxied?.env;
  // ENG-07: the service's image is the run's engine's, resolved before a service is deployed.
  const image = requireEngineImage(images, requireValue(config.engine, 'engine'), 'cloud-run');
  const id = randomUUID();
  // Cloud Run service ids are DNS labels: lowercase, <=63 chars, start with a letter.
  const serviceId = `${serviceIdPrefix}${id}`;
  if (fileIntake !== undefined) await registry.sweepExpired();
  const intakeKey = fileIntake === undefined ? undefined : randomBytes(32).toString('base64url');
  const created = await client.createService(
    runtimeServiceSpec(config, environment, {
      id,
      image,
      env,
      intakeKey,
      tags,
    }),
  );

  let status: CloudRunServiceStatus;
  try {
    status = await waitForService({ client, created, serviceId, readyTimeoutMs, pollIntervalMs });
  } catch (error) {
    // A service that never became usable still bills; roll it back and never hide a failed rollback.
    try {
      await client.deleteService(created.name);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `${errorMessage(error)} Rolling back service ${serviceId} also failed (${errorMessage(rollbackError)}); it may still be running and billed.`,
        { cause: rollbackError },
      );
    }
    throw error;
  }

  return registry.remember(config, {
    id,
    url: status.url,
    proxyExpirationSeconds: proxied?.expSeconds,
    intakeKey,
  });
}
