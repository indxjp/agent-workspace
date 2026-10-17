/**
 * Azure Container Apps custom-container dynamic sessions runtime driver.
 *
 * A session pool is provisioned separately. The manager sends the standard runtime HTTP contract
 * through that pool's management endpoint; ACA assigns one Hyper-V-isolated container to each
 * opaque identifier and destroys it after the pool's configured idle cooldown.
 */
import { createHmac, randomUUID } from 'node:crypto';

import type {
  AgentConnection,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeDriver,
  RuntimeHandle,
  RuntimeRunSpec,
} from './driver.js';
import { fetchAcaSessionsAccessToken } from './azure-auth.js';

export const ACA_SESSIONS_MANAGEMENT_API_VERSION = '2025-02-02-preview';

export type AcaSessionsNetworkStatus = 'EgressEnabled' | 'EgressDisabled';

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
  };
}

export type AcaSession = Readonly<{
  identifier: string;
  etag?: string;
  expiresAt: Date;
  createdAt?: Date;
  lastAccessedAt?: Date;
}>;

export interface AcaSessionsClient {
  requestUrl(identifier: string, path: string): string;
  request(identifier: string, path: string, init?: RequestInit): Promise<Response>;
  allocate(identifier: string): Promise<void>;
  getSession(identifier: string): Promise<AcaSession | null>;
  stopSession(identifier: string): Promise<void>;
}

export type AcaSessionsRestClientOptions = Readonly<{
  poolManagementEndpoint: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  apiVersion?: string;
}>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9|&^%$#(){}[\];<>-]{4,128}$/u;

function requireValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`aca-sessions runtime: ${name} must be a non-empty string.`);
  }
  return value;
}

function requireIdentifier(identifier: unknown): string {
  if (typeof identifier !== 'string' || !IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(
      'aca-sessions runtime: identifier must be 4-128 characters from the Azure-supported character set.',
    );
  }
  return identifier;
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(requireValue(value, 'poolManagementEndpoint'));
  } catch (error) {
    throw new Error('aca-sessions runtime: poolManagementEndpoint must be a valid HTTPS URL.', {
      cause: error,
    });
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw new Error(
      'aca-sessions runtime: poolManagementEndpoint must be an HTTPS URL without credentials, query, or fragment.',
    );
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, '')}/`;
  return endpoint;
}

function routeUrl(endpoint: URL, identifier: string, path: string): URL {
  requireIdentifier(identifier);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('aca-sessions runtime: routed path must start with one slash.');
  }
  const parsedPath = new URL(path, 'https://runtime.invalid');
  if (parsedPath.origin !== 'https://runtime.invalid' || parsedPath.hash !== '') {
    throw new Error('aca-sessions runtime: routed path must be relative and contain no fragment.');
  }
  const result = new URL(endpoint.href);
  result.pathname = `${endpoint.pathname}${parsedPath.pathname.replace(/^\//u, '')}`;
  result.search = parsedPath.search;
  result.searchParams.set('identifier', identifier);
  return result;
}

type AzureError = Readonly<{
  code?: string;
  message?: string;
  text: string;
}>;

async function readAzureError(response: Response): Promise<AzureError> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as Record<string, unknown>)['error'];
      if (typeof error === 'object' && error !== null) {
        const record = error as Record<string, unknown>;
        return {
          ...(typeof record['code'] === 'string' ? { code: record['code'] } : {}),
          ...(typeof record['message'] === 'string' ? { message: record['message'] } : {}),
          text: body,
        };
      }
    }
  } catch {
    // The runtime container itself and intermediary failures may return text or HTML.
  }
  return { text: body };
}

function responseFailure(operation: string, response: Response, failure: AzureError): Error {
  const detail =
    failure.code === undefined
      ? failure.text
      : `${failure.code}${failure.message === undefined ? '' : `: ${failure.message}`}`;
  return new Error(
    `aca-sessions runtime: ${operation} failed: ${String(response.status)}${detail === '' ? '' : ` ${detail}`}`,
  );
}

async function requireSuccessfulResponse(operation: string, response: Response): Promise<void> {
  if (!response.ok) {
    throw responseFailure(operation, response, await readAzureError(response));
  }
}

function parseDate(value: unknown, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`aca-sessions runtime: getSession returned an invalid ${field}.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`aca-sessions runtime: getSession returned an invalid ${field}.`);
  }
  return parsed;
}

/** Testable, dependency-free data-plane REST client. */
export function createAcaSessionsRestClient(
  options: AcaSessionsRestClientOptions,
): AcaSessionsClient {
  const endpoint = parseEndpoint(options.poolManagementEndpoint);
  const doFetch = options.fetch ?? globalThis.fetch;
  const apiVersion = requireValue(
    options.apiVersion ?? ACA_SESSIONS_MANAGEMENT_API_VERSION,
    'apiVersion',
  );

  function url(identifier: string, path: string): URL {
    return routeUrl(endpoint, identifier, path);
  }

  async function request(identifier: string, path: string, init: RequestInit = {}) {
    const token = requireValue(await options.getAccessToken(), 'access token');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    // Never follow a runtime-controlled redirect with a session-pool bearer token.
    return await doFetch(url(identifier, path), { ...init, headers, redirect: 'error' });
  }

  function managementUrl(identifier: string, operation: 'getSession' | 'stopSession'): URL {
    const result = url(identifier, `/.management/${operation}`);
    result.searchParams.set('api-version', apiVersion);
    return result;
  }

  async function managementRequest(
    identifier: string,
    operation: 'getSession' | 'stopSession',
  ): Promise<Response> {
    const token = requireValue(await options.getAccessToken(), 'access token');
    return await doFetch(managementUrl(identifier, operation), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      redirect: 'error',
    });
  }

  return {
    requestUrl(identifier, path) {
      return url(identifier, path).href;
    },

    request,

    async allocate(identifier) {
      // /ping is the runtime contract's health alias. ACA allocates before forwarding, so a 2xx
      // proves both allocation and container readiness without a second vendor-specific probe.
      const response = await request(identifier, '/ping');
      await requireSuccessfulResponse(`allocate session ${identifier}`, response);
      await response.body?.cancel();
    },

    async getSession(identifier) {
      const response = await managementRequest(identifier, 'getSession');
      if (response.status === 404 || response.status === 410) return null;
      if (!response.ok) {
        const failure = await readAzureError(response);
        if (response.status === 400 && failure.code === 'SessionWithIdentifierNotFound') {
          return null;
        }
        throw responseFailure(`get session ${identifier}`, response, failure);
      }
      const body = (await response.json()) as Record<string, unknown>;
      const returnedIdentifier = requireIdentifier(body['identifier']);
      if (returnedIdentifier !== identifier) {
        throw new Error('aca-sessions runtime: getSession returned a different identifier.');
      }
      // The custom-container documentation uses expiresAt; newer generated data-plane schemas use
      // expireAt. Accept both spellings while the API remains preview.
      const expiresAt = parseDate(body['expiresAt'] ?? body['expireAt'], 'expiresAt');
      if (expiresAt === undefined) {
        throw new Error('aca-sessions runtime: getSession returned no expiresAt timestamp.');
      }
      const createdAt = parseDate(body['createdAt'], 'createdAt');
      const lastAccessedAt = parseDate(body['lastAccessedAt'], 'lastAccessedAt');
      return {
        identifier: returnedIdentifier,
        ...(typeof body['etag'] === 'string' ? { etag: body['etag'] } : {}),
        expiresAt,
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(lastAccessedAt === undefined ? {} : { lastAccessedAt }),
      };
    },

    async stopSession(identifier) {
      const response = await managementRequest(identifier, 'stopSession');
      // Deleting an already-expired session is success for RuntimeDriver.destroy().
      if (response.ok || response.status === 404 || response.status === 410) {
        await response.body?.cancel();
        return;
      }
      const failure = await readAzureError(response);
      if (response.status === 400 && failure.code === 'SessionWithIdentifierNotFound') return;
      throw responseFailure(`stop session ${identifier}`, response, failure);
    },
  };
}

function identifierSecretBytes(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Uint8Array.from(value);
  if (bytes.byteLength < 32) {
    throw new Error('aca-sessions runtime: identifierSecret must contain at least 32 bytes.');
  }
  return bytes;
}

/**
 * Derive an opaque, allowed Azure identifier without exposing tenant, session, path, or profile
 * names. Length-prefixed JSON prevents ambiguous concatenations; hex stays inside Azure's allowed
 * identifier alphabet.
 */
export function createAcaSessionIdentifier(
  secret: string | Uint8Array,
  config: RuntimeConfig,
): string {
  const context = JSON.stringify([
    1,
    requireValue(config.sessionId, 'sessionId'),
    requireValue(config.workspacePath, 'workspacePath'),
    config.runtimeProfileId ?? config.runSpec?.runtimeProfileId ?? null,
  ]);
  return `aw-${createHmac('sha256', identifierSecretBytes(secret)).update(context).digest('hex')}`;
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

export type AcaSessionsPoolConfiguration = Readonly<{
  /** CPU cores configured on customContainerTemplate.containers[].resources. */
  cpu?: number;
  /** Memory configured on the pool, normalized to MiB. */
  memoryMb?: number;
  /** dynamicPoolConfiguration.cooldownPeriodInSeconds. */
  cooldownPeriodInSeconds?: number;
  /** Control-plane id of the registered runtime connection that owns this endpoint. */
  runtimeConnectionId?: string;
}>;

export type AcaSessionsDriver<TRequest, TEvent> = RuntimeDriver<TRequest, TEvent> &
  Readonly<{
    capabilities: AcaSessionsRuntimeCapabilities;
    requestUrl(runtime: RuntimeHandle, path: string): string;
    request(runtime: RuntimeHandle, path: string, init?: RequestInit): Promise<Response>;
    getSession(runtime: RuntimeHandle): Promise<AcaSession | null>;
    isLive(runtime: RuntimeHandle): Promise<boolean>;
  }>;

function assertCompatibleRunSpec(
  spec: RuntimeRunSpec | undefined,
  networkStatus: AcaSessionsNetworkStatus,
  pool: AcaSessionsPoolConfiguration,
): void {
  if (spec === undefined) return;
  if (spec.driver !== 'aca-sessions') {
    throw new Error(`aca-sessions runtime: run spec selects incompatible driver ${spec.driver}.`);
  }
  if (spec.networkPolicy === 'restricted') {
    throw new Error(
      'aca-sessions runtime: restricted network policy and domain allowlists are not supported by a session pool (ADR-0117 decision 7).',
    );
  }
  if (spec.allowedDomains !== undefined && spec.allowedDomains.length > 0) {
    throw new Error(
      'aca-sessions runtime: allowedDomains cannot be enforced by a session pool (ADR-0117 decision 7).',
    );
  }
  if (spec.persistPaths !== undefined && spec.persistPaths.length > 0) {
    throw new Error(
      'aca-sessions runtime: persistPaths cannot be enforced inside an ephemeral dynamic session.',
    );
  }
  if (spec.filesystem !== 'read-write') {
    throw new Error(
      'aca-sessions runtime: read-only filesystem profiles cannot be enforced by a custom session pool.',
    );
  }
  if (spec.diskMb !== undefined) {
    throw new Error(
      'aca-sessions runtime: diskMb cannot be configured or verified for a custom session pool.',
    );
  }
  if (spec.timeoutSeconds !== undefined) {
    throw new Error(
      'aca-sessions runtime: timeoutSeconds is a hard run limit, but ACA exposes only an idle cooldown.',
    );
  }
  if (spec.driverConfig !== undefined && Object.keys(spec.driverConfig).length > 0) {
    throw new Error(
      'aca-sessions runtime: driverConfig contains unsupported per-run ACA settings; pool settings are fixed at deployment.',
    );
  }
  const configuredPolicy = networkStatus === 'EgressEnabled' ? 'open' : 'none';
  if (spec.networkPolicy !== configuredPolicy) {
    throw new Error(
      `aca-sessions runtime: run spec requests ${spec.networkPolicy} network access but the pool is ${networkStatus}.`,
    );
  }
  assertFixedPoolValue('cpu', spec.cpu, pool.cpu);
  assertFixedPoolValue('memoryMb', spec.memoryMb, pool.memoryMb);
  assertFixedPoolValue('idleTimeoutSeconds', spec.idleTimeoutSeconds, pool.cooldownPeriodInSeconds);
  assertFixedPoolValue('runtimeConnectionId', spec.runtimeConnectionId, pool.runtimeConnectionId);
}

function assertFixedPoolValue(
  field: string,
  requested: number | string | undefined,
  configured: number | string | undefined,
): void {
  if (requested === undefined) return;
  if (configured === undefined) {
    throw new Error(
      `aca-sessions runtime: ${field} was requested but the registered pool's fixed value is unknown.`,
    );
  }
  if (requested !== configured) {
    throw new Error(
      `aca-sessions runtime: requested ${field} ${JSON.stringify(requested)} does not match the pool's fixed value ${JSON.stringify(configured)}.`,
    );
  }
}

function validatePoolConfiguration(pool: AcaSessionsPoolConfiguration): void {
  if (pool.cpu !== undefined && (!Number.isFinite(pool.cpu) || pool.cpu <= 0)) {
    throw new Error('aca-sessions runtime: pool cpu must be a positive finite number.');
  }
  if (pool.memoryMb !== undefined && (!Number.isSafeInteger(pool.memoryMb) || pool.memoryMb <= 0)) {
    throw new Error('aca-sessions runtime: pool memoryMb must be a positive safe integer.');
  }
  if (
    pool.cooldownPeriodInSeconds !== undefined &&
    (!Number.isSafeInteger(pool.cooldownPeriodInSeconds) || pool.cooldownPeriodInSeconds <= 0)
  ) {
    throw new Error(
      'aca-sessions runtime: pool cooldownPeriodInSeconds must be a positive safe integer.',
    );
  }
  if (pool.runtimeConnectionId !== undefined) {
    requireValue(pool.runtimeConnectionId, 'pool runtimeConnectionId');
  }
}

/** Construct a driver for one already-provisioned custom-container dynamic session pool. */
/**
 * Refuse a run whose engine this pool's image does not carry, before an allocation is made.
 *
 * ENG-07's dispatch invariant, in the shape a pool-fixed provider can hold it: the other drivers
 * pick an image from the map, and this one has exactly one image, so the same invariant is the
 * equality below. The sentence names the run's engine and the pool's, and no image reference —
 * this driver has none to name.
 */
function assertPoolEngine(poolEngine: string, requestedEngine: string): void {
  if (requestedEngine !== poolEngine) {
    throw new Error(
      `aca-sessions runtime: this session pool carries engine ${JSON.stringify(poolEngine)} and a run for ${JSON.stringify(requestedEngine)} cannot be served by it. An ACA dynamic-session pool is provisioned with one container image, so one pool offers one engine; provision a second pool for the other engine (ADR-0073 D6).`,
    );
  }
}

export function createAcaSessionsDriver<TRequest, TEvent>(
  options: AcaSessionsDriverOptions<TRequest, TEvent>,
): AcaSessionsDriver<TRequest, TEvent> {
  if (options.identifierSecret !== undefined && options.identifierForConfig !== undefined) {
    throw new Error(
      'aca-sessions runtime: supply identifierSecret or identifierForConfig, not both.',
    );
  }
  // Validate eagerly even when a fake client is injected; requestUrl remains part of the driver.
  parseEndpoint(options.poolManagementEndpoint);
  const poolEngine = requireValue(options.engine, 'engine');
  const poolConfiguration = options.poolConfiguration ?? {};
  validatePoolConfiguration(poolConfiguration);
  const client =
    options.client ??
    createAcaSessionsRestClient({
      poolManagementEndpoint: options.poolManagementEndpoint,
      getAccessToken: options.getAccessToken ?? fetchAcaSessionsAccessToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const capabilities = createAcaSessionsCapabilities(options.networkStatus);

  async function identifierFor(config: RuntimeConfig): Promise<string> {
    if (options.identifierForConfig !== undefined) {
      return requireIdentifier(await options.identifierForConfig(config));
    }
    if (options.identifierSecret !== undefined) {
      return createAcaSessionIdentifier(options.identifierSecret, config);
    }
    // Safe and opaque, but not deterministic if a caller discards the returned handle. Production
    // managers should configure identifierSecret or persist externalId with the runtime handle.
    return `aw-${randomUUID().replaceAll('-', '')}`;
  }

  function assertHandle(runtime: RuntimeHandle): string {
    if (runtime.driver !== 'aca-sessions') {
      throw new Error(
        `aca-sessions runtime: handle ${JSON.stringify(runtime.id)} belongs to ${runtime.driver}.`,
      );
    }
    return requireIdentifier(runtime.externalId);
  }

  function access(runtime: RuntimeHandle): AcaSessionAccess {
    const identifier = assertHandle(runtime);
    return {
      requestUrl: (path) => client.requestUrl(identifier, path),
      request: (path, init) => client.request(identifier, path, init),
    };
  }

  return {
    id: 'aca-sessions',
    capabilities,

    async create(config) {
      requireValue(config.sessionId, 'sessionId');
      requireValue(config.workspacePath, 'workspacePath');
      assertPoolEngine(poolEngine, requireValue(config.engine, 'engine'));
      assertCompatibleRunSpec(config.runSpec, options.networkStatus, poolConfiguration);
      const identifier = await identifierFor(config);
      await client.allocate(identifier);
      let session: AcaSession;
      try {
        const observed = await client.getSession(identifier);
        if (observed === null) {
          throw new Error(
            `aca-sessions runtime: session ${identifier} disappeared after its readiness probe.`,
          );
        }
        session = observed;
      } catch (error) {
        await client.stopSession(identifier).catch(() => undefined);
        throw error;
      }
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
      return await options.startAgent(runtime, request, access(runtime));
    },

    async destroy(runtime) {
      await client.stopSession(assertHandle(runtime));
    },

    requestUrl(runtime, path) {
      return access(runtime).requestUrl(path);
    },

    async request(runtime, path, init) {
      return await access(runtime).request(path, init);
    },

    async getSession(runtime) {
      return await client.getSession(assertHandle(runtime));
    },

    async isLive(runtime) {
      return (await client.getSession(assertHandle(runtime))) !== null;
    },

    async putFiles(runtime, archive) {
      const response = await access(runtime).request('/files', {
        method: 'POST',
        headers: { 'content-type': 'application/x-tar' },
        body: archive,
        // Required by Node's fetch for a streaming request body; browsers ignore the extra field.
        ...({ duplex: 'half' } as Record<string, unknown>),
      });
      await requireSuccessfulResponse('hydrate workspace', response);
      await response.body?.cancel();
    },

    async getFiles(runtime, paths) {
      const path = new URL('/files', 'https://runtime.invalid');
      for (const requestedPath of paths) path.searchParams.append('path', requestedPath);
      const response = await access(runtime).request(`${path.pathname}${path.search}`);
      await requireSuccessfulResponse('collect workspace files', response);
      if (response.body === null) {
        throw new Error('aca-sessions runtime: collect workspace files returned no response body.');
      }
      return response.body;
    },
  };
}
