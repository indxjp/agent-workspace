/**
 * Azure Container Apps custom-container dynamic sessions runtime driver.
 *
 * A session pool is provisioned separately. The manager sends the standard runtime HTTP contract
 * through that pool's management endpoint; ACA assigns one Hyper-V-isolated container to each
 * opaque identifier and destroys it after the pool's configured idle cooldown.
 */
import { randomUUID } from 'node:crypto';

import type {
  AgentConnection,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeDriver,
  RuntimeHandle,
} from './driver.js';
import { fetchAcaSessionsAccessToken } from './azure-auth.js';
import {
  createAcaSessionsRestClient,
  requireIdentifier,
  requireValue,
  parseEndpoint,
} from './aca-sessions-rest-client.js';
import { createAcaSessionIdentifier } from './aca-sessions-identifier.js';
import type { AcaSession, AcaSessionsClient } from './aca-sessions-rest-client.js';
import {
  assertCompatibleRunSpec,
  assertPoolEngine,
  validatePoolConfiguration,
} from './aca-sessions-run-spec.js';
import type {
  AcaSessionsNetworkStatus,
  AcaSessionsPoolConfiguration,
} from './aca-sessions-run-spec.js';

/** The subpath `@agent-workspace/runtime/driver/aca-sessions` carries its credential helpers too. */
export * from './azure-auth.js';
export {
  ACA_SESSIONS_MANAGEMENT_API_VERSION,
  createAcaSessionsRestClient,
} from './aca-sessions-rest-client.js';
export { createAcaSessionIdentifier } from './aca-sessions-identifier.js';
export type {
  AcaSession,
  AcaSessionsClient,
  AcaSessionsRestClientOptions,
} from './aca-sessions-rest-client.js';
export type {
  AcaSessionsNetworkStatus,
  AcaSessionsPoolConfiguration,
} from './aca-sessions-run-spec.js';

export type AcaSessionsRuntimeCapabilities = RuntimeCapabilities &
  Readonly<{
    isolation: 'microvm';
    managedByProvider: true;
    persistentFilesystem: false;
    gpu: false;
  }>;

/** Capabilities are pool properties, so they must be built from the registered pool's status. */
export function createAcaSessionsCapabilities(
  networkStatus: AcaSessionsNetworkStatus,
): AcaSessionsRuntimeCapabilities {
  return {
    isolation: 'microvm',
    customImage: true,
    persistentFilesystem: false,
    sessionAffinity: true,
    // Timed pools have an idle cooldown, not a documented hard maximum lifetime.
    maxSessionSeconds: null,
    networkPolicies: networkStatus === 'EgressEnabled' ? ['open'] : ['none'],
    execCommands: true,
    gpu: false,
    managedByProvider: true,
    // Pools may keep ready instances or scale from zero, so there is no honest single value.
    typicalStartMs: null,
    fileTransfer: 'push-archive',
  };
}

export type AcaSessionAccess = Readonly<{
  requestUrl(path: string): string;
  request(path: string, init?: RequestInit): Promise<Response>;
}>;

export type AcaSessionsAgentStarter<TRequest, TEvent> = (
  runtime: RuntimeHandle,
  request: TRequest,
  access: AcaSessionAccess,
) => AgentConnection<TEvent> | Promise<AgentConnection<TEvent>>;

export type AcaSessionsDriverOptions<TRequest, TEvent> = Readonly<{
  poolManagementEndpoint: string;
  networkStatus: AcaSessionsNetworkStatus;
  /**
   * The one engine this pool's container image carries (ENG-07, #306).
   *
   * **One engine per pool, and that is a provider limitation this driver reports rather than
   * designs around.** An ACA dynamic-session pool is provisioned with a single custom container
   * image; nothing in the management API lets one allocation ask for a different one. So the map
   * every other image-taking driver holds collapses here to a single value, supplied by whoever
   * provisioned the pool, and a run for any other engine is refused before an allocation is made —
   * the same `engine_not_installed` sentence, at the same point in the lifecycle. A deployment that
   * offers two engines over ACA provisions two pools and two runner managers.
   *
   * Recorded as a per-driver gap in `docs/runtime-driver-matrix.md` and ADR-0073 D6, which is what
   * the issue's stop condition asks for instead of reworking pooling.
   */
  engine: string;
  startAgent: AcaSessionsAgentStarter<TRequest, TEvent>;
  /** Recommended: stable manager secret used to make opaque, restart-stable identifiers. */
  identifierSecret?: string | Uint8Array;
  /** Alternative for managers that already derive and persist secure session identifiers. */
  identifierForConfig?: (config: RuntimeConfig) => string | Promise<string>;
  /** Fixed properties read from (or deployed with) the pre-provisioned session pool. */
  poolConfiguration?: AcaSessionsPoolConfiguration;
  getAccessToken?: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  client?: AcaSessionsClient;
}>;

export type AcaSessionsDriver<TRequest, TEvent> = RuntimeDriver<TRequest, TEvent> &
  Readonly<{
    capabilities: AcaSessionsRuntimeCapabilities;
    requestUrl(runtime: RuntimeHandle, path: string): string;
    request(runtime: RuntimeHandle, path: string, init?: RequestInit): Promise<Response>;
    getSession(runtime: RuntimeHandle): Promise<AcaSession | null>;
    isLive(runtime: RuntimeHandle): Promise<boolean>;
  }>;

/** Run `stopSession` after a failed start; a failed rollback is reported with the original failure. */
async function stopAfterFailure(
  client: AcaSessionsClient,
  identifier: string,
  failure: unknown,
): Promise<never> {
  try {
    await client.stopSession(identifier);
  } catch (rollbackError) {
    const describe = (value: unknown): string =>
      value instanceof Error ? value.message : String(value);
    throw new AggregateError(
      [failure, rollbackError],
      `${describe(failure)} Stopping session ${identifier} also failed (${describe(rollbackError)}); it may still be running and billed.`,
      { cause: rollbackError },
    );
  }
  throw failure;
}

/** Allocate the session and read it back; any failure stops the session so it is not billed. */
async function allocateAndObserve(
  client: AcaSessionsClient,
  identifier: string,
): Promise<AcaSession> {
  await client.allocate(identifier);
  try {
    const observed = await client.getSession(identifier);
    if (observed === null) {
      throw new Error(
        `aca-sessions runtime: session ${identifier} disappeared after its readiness probe.`,
      );
    }
    return observed;
  } catch (error) {
    return await stopAfterFailure(client, identifier, error);
  }
}

function resolveClient<TRequest, TEvent>(
  options: AcaSessionsDriverOptions<TRequest, TEvent>,
): AcaSessionsClient {
  return (
    options.client ??
    createAcaSessionsRestClient({
      poolManagementEndpoint: options.poolManagementEndpoint,
      getAccessToken: options.getAccessToken ?? fetchAcaSessionsAccessToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
  );
}

function identifierResolver<TRequest, TEvent>(
  options: AcaSessionsDriverOptions<TRequest, TEvent>,
): (config: RuntimeConfig) => Promise<string> {
  return async (config) => {
    if (options.identifierForConfig !== undefined) {
      return requireIdentifier(await options.identifierForConfig(config));
    }
    if (options.identifierSecret !== undefined) {
      return createAcaSessionIdentifier(options.identifierSecret, config);
    }
    // Safe and opaque, but not deterministic if a caller discards the returned handle. Production
    // managers should configure identifierSecret or persist externalId with the runtime handle.
    return `aw-${randomUUID().replaceAll('-', '')}`;
  };
}

function assertHandle(runtime: RuntimeHandle): string {
  if (runtime.driver !== 'aca-sessions') {
    throw new Error(
      `aca-sessions runtime: handle ${JSON.stringify(runtime.id)} belongs to ${runtime.driver}.`,
    );
  }
  return requireIdentifier(runtime.externalId);
}

function sessionAccess(client: AcaSessionsClient, runtime: RuntimeHandle): AcaSessionAccess {
  const identifier = assertHandle(runtime);
  return {
    requestUrl: (path) => client.requestUrl(identifier, path),
    request: (path, init) => client.request(identifier, path, init),
  };
}

/** Validate eagerly, even when a fake client is injected; requestUrl remains part of the driver. */
function validateDriverOptions<TRequest, TEvent>(
  options: AcaSessionsDriverOptions<TRequest, TEvent>,
): Readonly<{ poolEngine: string; poolConfiguration: AcaSessionsPoolConfiguration }> {
  if (options.identifierSecret !== undefined && options.identifierForConfig !== undefined) {
    throw new Error(
      'aca-sessions runtime: supply identifierSecret or identifierForConfig, not both.',
    );
  }
  parseEndpoint(options.poolManagementEndpoint);
  const poolEngine = requireValue(options.engine, 'engine');
  const poolConfiguration = options.poolConfiguration ?? {};
  validatePoolConfiguration(poolConfiguration);
  return { poolEngine, poolConfiguration };
}

/** Construct a driver for one already-provisioned custom-container dynamic session pool. */
export function createAcaSessionsDriver<TRequest, TEvent>(
  options: AcaSessionsDriverOptions<TRequest, TEvent>,
): AcaSessionsDriver<TRequest, TEvent> {
  const { poolEngine, poolConfiguration } = validateDriverOptions(options);
  const client = resolveClient(options);
  const identifierFor = identifierResolver(options);

  return {
    id: 'aca-sessions',
    capabilities: createAcaSessionsCapabilities(options.networkStatus),

    async create(config) {
      requireValue(config.sessionId, 'sessionId');
      requireValue(config.workspacePath, 'workspacePath');
      assertPoolEngine(poolEngine, requireValue(config.engine, 'engine'));
      assertCompatibleRunSpec(config.runSpec, options.networkStatus, poolConfiguration);
      const identifier = await identifierFor(config);
      const session = await allocateAndObserve(client, identifier);
      return {
        id: randomUUID(),
        driver: 'aca-sessions',
        externalId: identifier,
        workspacePath: config.workspacePath,
        createdAt: session.createdAt ?? new Date(),
        expiresAt: session.expiresAt,
      };
    },

    async startAgent(runtime, request) {
      return await options.startAgent(runtime, request, sessionAccess(client, runtime));
    },

    async destroy(runtime) {
      await client.stopSession(assertHandle(runtime));
    },

    requestUrl(runtime, path) {
      return sessionAccess(client, runtime).requestUrl(path);
    },

    async request(runtime, path, init) {
      return await sessionAccess(client, runtime).request(path, init);
    },

    async getSession(runtime) {
      return await client.getSession(assertHandle(runtime));
    },

    async isLive(runtime) {
      return (await client.getSession(assertHandle(runtime))) !== null;
    },
  };
}
