/** Data-plane REST client for one Azure Container Apps session pool, with its input validation. */

export const ACA_SESSIONS_MANAGEMENT_API_VERSION = '2025-02-02-preview';

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

export function requireValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`aca-sessions runtime: ${name} must be a non-empty string.`);
  }
  return value;
}

export function requireIdentifier(identifier: unknown): string {
  if (typeof identifier !== 'string' || !IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(
      'aca-sessions runtime: identifier must be 4-128 characters from the Azure-supported character set.',
    );
  }
  return identifier;
}

export function parseEndpoint(value: string): URL {
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // The runtime container itself and intermediary failures may return text or HTML.
    return undefined;
  }
}

async function readAzureError(response: Response): Promise<AzureError> {
  const body = await response.text();
  const error = asRecord(asRecord(parseJson(body))?.['error']);
  if (error === undefined) return { text: body };
  return {
    ...(typeof error['code'] === 'string' ? { code: error['code'] } : {}),
    ...(typeof error['message'] === 'string' ? { message: error['message'] } : {}),
    text: body,
  };
}

/** A session that is already gone: expired, never allocated, or reported as such by Azure. */
function isSessionGone(response: Response, failure?: AzureError): boolean {
  if (response.status === 404 || response.status === 410) return true;
  return response.status === 400 && failure?.code === 'SessionWithIdentifierNotFound';
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

/** Validate a getSession body for `identifier` into an AcaSession. */
function parseSession(identifier: string, json: unknown): AcaSession {
  const body = asRecord(json) ?? {};
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
}

/** What every data-plane call needs: where the pool is, how to sign in, and how to send. */
type PoolTransport = Readonly<{
  endpoint: URL;
  apiVersion: string;
  doFetch: typeof globalThis.fetch;
  getAccessToken: () => Promise<string>;
}>;

type ManagementOperation = 'getSession' | 'stopSession';

async function bearerToken(transport: PoolTransport): Promise<string> {
  return requireValue(await transport.getAccessToken(), 'access token');
}

async function routedRequest(
  transport: PoolTransport,
  identifier: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await bearerToken(transport);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  // Never follow a runtime-controlled redirect with a session-pool bearer token.
  return await transport.doFetch(routeUrl(transport.endpoint, identifier, path), {
    ...init,
    headers,
    redirect: 'error',
  });
}

async function managementRequest(
  transport: PoolTransport,
  identifier: string,
  operation: ManagementOperation,
): Promise<Response> {
  const token = await bearerToken(transport);
  const url = routeUrl(transport.endpoint, identifier, `/.management/${operation}`);
  url.searchParams.set('api-version', transport.apiVersion);
  return await transport.doFetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    redirect: 'error',
  });
}

async function allocateSession(transport: PoolTransport, identifier: string): Promise<void> {
  // /ping is the runtime contract's health alias. ACA allocates before forwarding, so a 2xx
  // proves both allocation and container readiness without a second vendor-specific probe.
  const response = await routedRequest(transport, identifier, '/ping');
  await requireSuccessfulResponse(`allocate session ${identifier}`, response);
  await response.body?.cancel();
}

async function fetchSession(
  transport: PoolTransport,
  identifier: string,
): Promise<AcaSession | null> {
  const response = await managementRequest(transport, identifier, 'getSession');
  if (isSessionGone(response)) return null;
  if (!response.ok) {
    const failure = await readAzureError(response);
    if (isSessionGone(response, failure)) return null;
    throw responseFailure(`get session ${identifier}`, response, failure);
  }
  return parseSession(identifier, await response.json());
}

async function stopPoolSession(transport: PoolTransport, identifier: string): Promise<void> {
  const response = await managementRequest(transport, identifier, 'stopSession');
  // Deleting an already-expired session is success for RuntimeDriver.destroy().
  if (response.ok || isSessionGone(response)) {
    await response.body?.cancel();
    return;
  }
  const failure = await readAzureError(response);
  if (isSessionGone(response, failure)) return;
  throw responseFailure(`stop session ${identifier}`, response, failure);
}

/** Testable, dependency-free data-plane REST client. */
export function createAcaSessionsRestClient(
  options: AcaSessionsRestClientOptions,
): AcaSessionsClient {
  const transport: PoolTransport = {
    endpoint: parseEndpoint(options.poolManagementEndpoint),
    apiVersion: requireValue(
      options.apiVersion ?? ACA_SESSIONS_MANAGEMENT_API_VERSION,
      'apiVersion',
    ),
    doFetch: options.fetch ?? globalThis.fetch,
    getAccessToken: options.getAccessToken,
  };
  return {
    requestUrl: (identifier, path) => routeUrl(transport.endpoint, identifier, path).href,
    request: (identifier, path, init) => routedRequest(transport, identifier, path, init),
    allocate: (identifier) => allocateSession(transport, identifier),
    getSession: (identifier) => fetchSession(transport, identifier),
    stopSession: (identifier) => stopPoolSession(transport, identifier),
  };
}
