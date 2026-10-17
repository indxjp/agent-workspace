import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  RuntimeRefusalError,
  type RuntimeConfig,
  type RuntimeHandle,
} from '@agent-workspace/runtime';

import { parseRuntimeRunSpec } from './runtime-run-spec.js';
import {
  parseToolSandboxRequest,
  ToolSandboxUnavailableError,
  type ToolSandboxes,
  type ToolSandboxSession,
} from './tool-sandbox.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROXY_BODY_BYTES = 128 * 1024 * 1024;
// An allocation may carry a session's tool bundles, base64 inside JSON (ADR-0118 TS2).
const MAX_ALLOCATION_BODY_BYTES = 128 * 1024 * 1024;
// The gateway caps a tool request at 4 MiB (ADR-0118 TS3); the manager route accepts no more.
const MAX_TOOL_REQUEST_BYTES = 4 * 1024 * 1024;
/** The request headers the gateway sets for a tool sandbox, which the manager route passes on. */
const TOOL_SANDBOX_HEADERS = ['mcp-protocol-version', 'x-aw-agent', 'x-aw-run-id'];
/**
 * On the manager's tool route `authorization` carries the manager token, so the gateway sends the
 * tool host's per-run bearer here; it is passed on as the host's `authorization` (ADR-0132).
 */
const TOOL_RUN_AUTHORIZATION = 'x-aw-tool-authorization';
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export interface ManagedRuntimeDriver {
  /** `providerCredential` is the caller's provider key for this call only (ADR-0120 LC6). */
  create(
    config: RuntimeConfig,
    providerCredential?: string,
    /** Recorded with a provider-hosted sandbox so its workspace can find it; never a secret. */
    tags?: Readonly<Record<string, string>>,
  ): Promise<RuntimeHandle>;
  destroy(runtime: RuntimeHandle, providerCredential?: string): Promise<void>;
  isLive(runtime: RuntimeHandle): Promise<boolean>;
  /** Throws what `create` would refuse, so a refusal can leave an existing runtime untouched. */
  assertCreatable?(config: RuntimeConfig, providerCredential?: string): void;
  /**
   * A stateless driver (ADR-0126) has both. `find` returns the live sandbox the provider holds for
   * this session, and `recover` the handle a sealed id stands for, so this manager keeps no
   * allocation table and any instance can serve any request.
   */
  find?(config: RuntimeConfig, providerCredential?: string): Promise<RuntimeHandle | undefined>;
  recover?(id: string): RuntimeHandle | undefined;
  /** An empty `networkPolicies` refuses every run, so `/verify` refuses before reading the body. */
  capabilities?: Readonly<{ networkPolicies: readonly string[] }>;
}

export type RunnerManagerOptions = Readonly<{
  token: string;
  driver: ManagedRuntimeDriver;
  workspacesRoot: string;
  runtimeOrigin?: (handle: RuntimeHandle) => string;
  /**
   * Resolve one runtime-contract path to its complete upstream URL.
   *
   * Most drivers expose a stable origin, so the default simply appends `path` to
   * {@link runtimeOrigin}. Azure Container Apps dynamic sessions are different: the session
   * identifier is routing data and must be present on every request, including readiness and
   * verification probes. Supplying this seam keeps that provider-specific URL shape out of the
   * generic manager and, importantly, prevents a later `/run`, `/interrupt`, or `/files` proxy
   * from accidentally bypassing the identifier that `/ping` used.
   */
  runtimeRequestUrl?: (handle: RuntimeHandle, path: string) => string;
  /** The only `runSpec.driver` this manager's `driver` will accept. Defaults to `docker`. */
  expectedDriver?: string;
  /**
   * Extra headers attached to every request this manager makes to a runtime — `/healthz` and
   * `/verify/echo` during verification, and every proxied `/run`, `/interrupt`, `/files` call.
   * `docker` and `kubernetes` runtimes sit on a private network the manager already trusts and
   * need nothing here; `cloud-run-service` runtimes are private Cloud Run services and need a
   * Google-signed identity token scoped to that exact service URL (see
   * `@agent-workspace/runtime`'s `fetchCloudRunIdentityToken`).
   */
  runtimeAuthHeaders?: (handle: RuntimeHandle) => Promise<Record<string, string>>;
  /** Stable non-secret identity for the configured image/driver implementation. */
  configurationFingerprint?: string;
  fetch?: typeof globalThis.fetch;
  verificationTimeoutMs?: number;
  /**
   * The path polled during `/verify` to decide a runtime is ready. Defaults to `/healthz`, the
   * spec §14.3 liveness route every runtime image implements. `cloud-run-service` sets this to
   * `/ping` — the same handler, mounted at a second path (`apps/runner/src/server.ts`) — because
   * Google Cloud's edge intercepts the literal path `/healthz` on a `*.a.run.app` default domain
   * and answers with its own generic 404 before the request reaches any container; confirmed
   * across independent services in `docs/adr/ADR-cloud-run-service-driver.md`. `/ping` is not a
   * reserved path there, so it reaches the runtime like any other. `docker` and `kubernetes`
   * runtimes are not behind that edge and are unaffected by this option's default.
   */
  readinessPath?: string;
  /**
   * Starts a session's tool sandbox when an allocation carries `toolSandbox` (ADR-0118 TS2). Unset,
   * such an allocation is refused with `503 tool_sandbox_unavailable`: a deployment that cannot
   * isolate code tools must say so rather than run a session without them.
   */
  toolSandboxes?: ToolSandboxes;
  /** Why an allocation carrying `toolSandbox` is refused when {@link toolSandboxes} is unset. */
  toolSandboxRefusal?: string;
}>;

type Allocation = Readonly<{
  handle: RuntimeHandle;
  sessionKey: string;
}>;

/**
 * A sandbox was asked for after this manager began shutting down. Answered as `503`: the request
 * was well formed, and another manager (or this one, restarted) can serve it.
 */
class RunnerShuttingDownError extends Error {
  public constructor() {
    super('the runner manager is shutting down and starts no new runtimes');
    this.name = 'RunnerShuttingDownError';
  }
}

/** A driver that refuses new creates once {@link ShutdownGate.close} is called. */
export type ShutdownGate = Readonly<{
  driver: ManagedRuntimeDriver;
  /**
   * Refuse every later `create`, then wait at most `timeoutMs` for the creates already in flight
   * to settle. Resolves `true` when every one settled in time, `false` otherwise.
   */
  close(timeoutMs: number): Promise<boolean>;
}>;

/**
 * Close the race between a shutdown's reap and a `create` already in flight (#406 follow-up).
 *
 * A reap lists the sandboxes that exist when it runs. A `create` that started before the shutdown
 * and finishes after that listing would start a sandbox nothing removes, and it would keep the
 * project's runtime-control network alive after `docker compose down`. Through this gate, a create
 * asked for after `close` never reaches the driver, and `close` waits for the creates already in
 * flight. A create that finishes after the gate closed destroys its sandbox at once and fails
 * with {@link RunnerShuttingDownError}; if that destroy fails, it names the container on stderr.
 * The reap that follows `close` covers only the creates that settled before it ran: one that
 * outlasts `close`'s wait may still start a sandbox after the reap, or after the process has
 * exited, which is why the shutdown then reports `sandboxes-left`.
 */
export function createShutdownGate(driver: ManagedRuntimeDriver): ShutdownGate {
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();

  async function create(config: RuntimeConfig, credential?: string): Promise<RuntimeHandle> {
    const handle = await driver.create(config, credential);
    if (!closed) return handle;
    await driver.destroy(handle, credential).catch((error: unknown) => {
      process.stderr.write(
        `runner manager: could not remove ${handle.externalId}, started during shutdown: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    throw new RunnerShuttingDownError();
  }

  return {
    driver: {
      create(config, credential) {
        if (closed) return Promise.reject(new RunnerShuttingDownError());
        const pending = create(config, credential);
        const tracked = pending.then(
          () => undefined,
          () => undefined,
        );
        inFlight.add(tracked);
        void tracked.then(() => inFlight.delete(tracked));
        return pending;
      },
      destroy: (runtime, credential) => driver.destroy(runtime, credential),
      isLive: (runtime) => driver.isLive(runtime),
      ...(driver.assertCreatable === undefined
        ? {}
        : { assertCreatable: driver.assertCreatable.bind(driver) }),
      ...(driver.find === undefined ? {} : { find: driver.find.bind(driver) }),
      ...(driver.recover === undefined ? {} : { recover: driver.recover.bind(driver) }),
      ...(driver.capabilities === undefined ? {} : { capabilities: driver.capabilities }),
    },
    async close(timeoutMs) {
      closed = true;
      if (inFlight.size === 0) return true;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      });
      const settled = Promise.all([...inFlight]).then(() => true as const);
      try {
        return await Promise.race([settled, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * A body field the caller got wrong. `code` is the stable public token the 400 answers with; it
 * names the field and never a value, so the control plane can show it without leaking anything.
 */
type ManagerRequestCode =
  | 'invalid_workspace_id'
  | 'invalid_session_id'
  | 'invalid_run_id'
  | 'invalid_engine'
  | 'invalid_run_spec'
  | 'invalid_tool_sandbox'
  | 'invalid_body'
  | 'request_too_large';

class ManagerRequestError extends Error {
  public constructor(
    public readonly code: ManagerRequestCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManagerRequestError';
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function authorized(req: IncomingMessage, expected: Buffer): boolean {
  const match = /^Bearer\s+(.+)$/u.exec(req.headers.authorization ?? '');
  if (match === null) return false;
  const actual = Buffer.from(match[1] ?? '');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

async function body(
  req: IncomingMessage,
  limit = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.byteLength;
    if (size > limit)
      throw new ManagerRequestError('request_too_large', 'request body is too large');
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ManagerRequestError('invalid_body', 'request body must contain valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ManagerRequestError('invalid_body', 'request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** The provider key a caller sends for one call (LC6); it is passed on and never stored or logged. */
function providerCredentialOf(req: IncomingMessage): string | undefined {
  const value = req.headers['x-provider-credential'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function segment(
  value: unknown,
  name: string,
  code: Extract<
    ManagerRequestCode,
    'invalid_workspace_id' | 'invalid_session_id' | 'invalid_run_id' | 'invalid_engine'
  >,
): string {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value)) {
    throw new ManagerRequestError(code, `${name} must be a safe path segment`);
  }
  return value;
}

function configFor(
  value: Record<string, unknown>,
  root: string,
  expectedDriver: string,
): RuntimeConfig {
  const workspaceId = segment(value['workspaceId'], 'workspaceId', 'invalid_workspace_id');
  const sessionId = segment(value['sessionId'], 'sessionId', 'invalid_session_id');
  // ENG-07 (#306): which engine this run is for, so the driver can pick its image. Validated here
  // like every other body field rather than defaulted — a body that omits it is a caller this
  // manager does not understand, and guessing `claude-agent-sdk` would start the run in whatever
  // image happened to be first. The manager does not decide *whether* the engine is installed; the
  // driver answers that from the map, with the same sentence the control plane already gave.
  const engine = segment(value['engine'], 'engine', 'invalid_engine');
  let spec: ReturnType<typeof parseRuntimeRunSpec>;
  try {
    spec = parseRuntimeRunSpec(value['runSpec'], expectedDriver);
  } catch (error) {
    throw new ManagerRequestError(
      'invalid_run_spec',
      error instanceof Error ? error.message : 'invalid runSpec',
    );
  }
  return {
    sessionId,
    engine,
    workspacePath: path.join(root, workspaceId, sessionId),
    runtimeProfileId: spec.runtimeProfileId,
    runSpec: spec,
  };
}

/**
 * ADR-0131: a driver that declares no network policy refuses every run, so its `/verify` is that
 * typed refusal whatever the probe body says; no body field can change the answer.
 */
function assertSomePolicyDeclared(driver: ManagedRuntimeDriver, expectedDriver: string): void {
  if (driver.capabilities?.networkPolicies.length === 0) {
    throw new RuntimeRefusalError(
      'network_policy_unsupported',
      `${expectedDriver} runtime refuses every network policy until its live lane proves egress denial (ADR-0131).`,
    );
  }
}

/** A status read of a handle a stateless manager (one that can recover handles) cannot open. */
function isHandleProbe(
  method: string | undefined,
  operation: string | undefined,
  stateless: boolean,
): boolean {
  return operation === undefined && method === 'GET' && stateless;
}

/**
 * The tool sandbox session of an allocation. The handle's workspace path is
 * `<root>/<workspaceId>/<sessionId>` (`configFor`), and a stateless manager's handle seals it, so
 * the session is known even when the run profile is not.
 */
function toolSessionOf(root: string, allocation: Allocation): ToolSandboxSession {
  const [workspaceId = '', sessionId = ''] = path
    .relative(root, allocation.handle.workspacePath)
    .split(path.sep);
  return { key: allocation.sessionKey, workspaceId, sessionId };
}

function allocationBody(allocation: Allocation, requestUrl: URL): Record<string, unknown> {
  return {
    handle: allocation.handle,
    runnerUrl: `${requestUrl.protocol}//${requestUrl.host}/runtimes/${allocation.handle.id}`,
  };
}

/**
 * Block until a runtime answers `readinessPath` with an authenticated 2xx, or throw once
 * `deadlineMs` passes.
 *
 * `docker`/`kubernetes` runtimes sit on a private network the manager already trusts, so this
 * settles on the first poll once the container is live. `cloud-run-service` runtimes are private
 * Cloud Run services: the deploy can report `ready` before the IAM invoker binding this driver
 * just granted has propagated (a documented GCP eventual-consistency window, up to roughly a
 * minute), during which even a request carrying a valid identity token is refused with 401. Both
 * `/verify` and `POST /runtimes` call this before handing a runtime to a caller, so the first real
 * `/run` a client sends — which gets no retry of its own — never races that window.
 */
async function waitUntilInvocable(
  handle: RuntimeHandle,
  isLive: (handle: RuntimeHandle) => Promise<boolean>,
  runtimeRequestUrl: (handle: RuntimeHandle, path: string) => string,
  readinessPath: string,
  authHeaders: (handle: RuntimeHandle) => Promise<Record<string, string>>,
  doFetch: typeof globalThis.fetch,
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let loggedFailureOnce = false;
  while (Date.now() < deadline) {
    if (await isLive(handle)) {
      try {
        const healthUrl = runtimeRequestUrl(handle, readinessPath);
        const health = await doFetch(healthUrl, {
          headers: await authHeaders(handle),
          redirect: 'error',
        });
        if (health.ok) return;
        if (!loggedFailureOnce) {
          loggedFailureOnce = true;
          process.stderr.write(
            `readiness: ${readinessPath} returned ${String(health.status)} for ${healthUrl}\n`,
          );
        }
      } catch (error) {
        if (!loggedFailureOnce) {
          loggedFailureOnce = true;
          process.stderr.write(
            `readiness: ${readinessPath} probe failed for ${runtimeRequestUrl(handle, readinessPath)}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('runtime did not become invocable before the readiness timeout');
}

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  doFetch: typeof globalThis.fetch,
  extraHeaders: Record<string, string> = {},
  limit = MAX_PROXY_BODY_BYTES,
): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.byteLength;
    if (size > limit)
      throw new ManagerRequestError('request_too_large', 'proxied request body is too large');
    chunks.push(chunk);
  }
  const headers = new Headers();
  if (req.headers['content-type'] !== undefined)
    headers.set('content-type', req.headers['content-type']);
  if (req.headers.accept !== undefined) headers.set('accept', req.headers.accept);
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  // Runtime endpoints are an authenticated isolation boundary. Following a redirect could send
  // the manager's provider bearer to a different origin (or silently turn a POST into a GET), so
  // every upstream operation rejects 3xx instead.
  const init: RequestInit = { method: req.method ?? 'GET', headers, redirect: 'error' };
  if (chunks.length > 0) init.body = Buffer.concat(chunks);
  const response = await doFetch(url, init);
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== 'content-length' && name !== 'transfer-encoding') res.setHeader(name, value);
  });
  if (response.body === null) res.end();
  else await pipeline(Readable.fromWeb(response.body), res);
}

function requestUrlOf(req: IncomingMessage): URL {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = (
    typeof forwardedProto === 'string' ? forwardedProto : (forwardedProto?.[0] ?? '')
  )
    .split(',')[0]
    ?.trim();
  return new URL(
    req.url ?? '/',
    `${protocol !== undefined && protocol.length > 0 ? protocol : 'http'}://${req.headers.host ?? 'runner-manager'}`,
  );
}

/** `POST /tool-sandboxes/<id>/mcp`: true when the path was this route's, whatever the answer. */
async function serveToolSandbox(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  toolSandboxes: ToolSandboxes | undefined,
  doFetch: typeof globalThis.fetch,
): Promise<boolean> {
  const route = /^\/tool-sandboxes\/([^/]+)\/mcp$/u.exec(requestUrl.pathname);
  if (route === null) return false;
  const runAuthorization = req.headers[TOOL_RUN_AUTHORIZATION];
  if (typeof runAuthorization !== 'string' || !/^Bearer\s+\S/u.test(runAuthorization)) {
    json(res, 401, { error: 'unauthorized' });
    return true;
  }
  const upstream = req.method === 'POST' ? toolSandboxes?.upstream?.(route[1] ?? '') : undefined;
  if (upstream === undefined) {
    json(res, 404, { error: 'tool_sandbox_not_found' });
    return true;
  }
  const passed: Record<string, string> = {};
  for (const name of TOOL_SANDBOX_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') passed[name] = value;
  }
  await forward(
    req,
    res,
    upstream.url,
    doFetch,
    { ...passed, authorization: runAuthorization, ...upstream.headers },
    MAX_TOOL_REQUEST_BYTES,
  );
  return true;
}

/**
 * `POST /tool-sandboxes` (ADR-0134 part 2): starts (or reuses) the tool sandbox of a project
 * endpoint client with no agent runtime beside it. The client id is the session, so two clients
 * never share a sandbox, and the answer is the origin the control plane signs into a grant.
 */
async function openEndpointToolSandbox(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly requestUrl: URL;
  readonly options: RunnerManagerOptions;
}): Promise<void> {
  const { toolSandboxes } = input.options;
  if (toolSandboxes === undefined) {
    throw new ToolSandboxUnavailableError(
      input.options.toolSandboxRefusal ??
        'this runner manager has no tool sandbox configured (set AGENT_WORKSPACE_TOOL_HOST_IMAGE)',
    );
  }
  const raw = await body(input.req, MAX_ALLOCATION_BODY_BYTES);
  let request: ReturnType<typeof parseToolSandboxRequest>;
  try {
    request = parseToolSandboxRequest(raw['toolSandbox']);
  } catch (error) {
    throw new ManagerRequestError(
      'invalid_tool_sandbox',
      error instanceof Error ? error.message : 'invalid toolSandbox',
    );
  }
  const clientId = segment(raw['clientId'], 'clientId', 'invalid_session_id');
  const credential = providerCredentialOf(input.req);
  const origin = await toolSandboxes.open(
    {
      key: `endpoint:${clientId}`,
      workspaceId: segment(raw['workspaceId'], 'workspaceId', 'invalid_workspace_id'),
      sessionId: clientId,
      workspacesRoot: input.options.workspacesRoot,
      publicBase: `${input.requestUrl.protocol}//${input.requestUrl.host}`,
      ...(credential === undefined ? {} : { providerCredential: credential }),
    },
    request,
  );
  json(input.res, 200, { toolSandbox: { origin } });
}

/**
 * `DELETE /tool-sandboxes/sessions/<clientId>?workspaceId=<id>`: closes the endpoint sandbox that
 * `POST /tool-sandboxes` opened. The key is rebuilt here from the client id, so a caller can never
 * name another sandbox's key. With no tool sandboxes configured nothing can be open: 204.
 */
async function closeEndpointToolSandbox(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly requestUrl: URL;
  readonly clientId: string;
  readonly options: RunnerManagerOptions;
}): Promise<void> {
  const clientId = segment(input.clientId, 'clientId', 'invalid_session_id');
  const workspaceId = segment(
    input.requestUrl.searchParams.get('workspaceId'),
    'workspaceId',
    'invalid_workspace_id',
  );
  await input.options.toolSandboxes?.close(
    { key: `endpoint:${clientId}`, workspaceId, sessionId: clientId },
    providerCredentialOf(input.req),
  );
  input.res.writeHead(204).end();
}

/**
 * `DELETE /tool-sandboxes/runs/<runId>?workspaceId=<id>` (issue #832): removes the tool sandboxes
 * that run started, and nothing else. The session's agent runtime, and a tool sandbox the run only
 * reused, stay up for the session's other runs. With no tool sandboxes configured: 204. True when
 * the request was this route's.
 */
async function releaseRunToolSandboxes(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly requestUrl: URL;
  readonly options: RunnerManagerOptions;
}): Promise<boolean> {
  const route = /^\/tool-sandboxes\/runs\/([^/]+)$/u.exec(input.requestUrl.pathname);
  if (input.req.method !== 'DELETE' || route === null) return false;
  await input.options.toolSandboxes?.release?.(
    {
      workspaceId: segment(
        input.requestUrl.searchParams.get('workspaceId'),
        'workspaceId',
        'invalid_workspace_id',
      ),
      runId: segment(route[1], 'runId', 'invalid_run_id'),
    },
    providerCredentialOf(input.req),
  );
  input.res.writeHead(204).end();
  return true;
}

/** The session's allocation: this process's table, else (stateless) the provider's sandbox. */
async function existingAllocation(
  input: {
    readonly options: RunnerManagerOptions;
    readonly allocations: Map<string, Allocation>;
    readonly bySession: Map<string, string>;
  },
  config: RuntimeConfig,
  sessionKey: string,
  credential: string | undefined,
): Promise<Allocation | undefined> {
  if (input.options.driver.find !== undefined) {
    const handle = await input.options.driver.find(config, credential);
    return handle === undefined ? undefined : { handle, sessionKey };
  }
  const existingId = input.bySession.get(sessionKey);
  return existingId === undefined ? undefined : input.allocations.get(existingId);
}

/**
 * Run `work` once every earlier call for the same `key` has settled, so two requests for one session
 * cannot both find no runtime and both create one.
 */
async function serialised<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}

async function allocateRuntime(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly requestUrl: URL;
  readonly options: RunnerManagerOptions;
  readonly allocations: Map<string, Allocation>;
  readonly bySession: Map<string, string>;
  /** One in-flight allocation per session key; see {@link serialised}. */
  readonly sessionLocks: Map<string, Promise<unknown>>;
  readonly expectedDriver: string;
  readonly runtimeRequestUrl: (handle: RuntimeHandle, path: string) => string;
  readonly readinessPath: string;
  readonly authHeaders: (handle: RuntimeHandle) => Promise<Record<string, string>>;
  readonly doFetch: typeof globalThis.fetch;
}): Promise<void> {
  const credential = providerCredentialOf(input.req);
  const raw = await body(input.req, MAX_ALLOCATION_BODY_BYTES);
  const config = configFor(raw, input.options.workspacesRoot, input.expectedDriver);
  let toolRequest: ReturnType<typeof parseToolSandboxRequest> | undefined;
  if (raw['toolSandbox'] !== undefined) {
    try {
      toolRequest = parseToolSandboxRequest(raw['toolSandbox']);
    } catch (error) {
      throw new ManagerRequestError(
        'invalid_tool_sandbox',
        error instanceof Error ? error.message : 'invalid toolSandbox',
      );
    }
    if (input.options.toolSandboxes === undefined) {
      throw new ToolSandboxUnavailableError(
        input.options.toolSandboxRefusal ??
          'this runner manager has no tool sandbox configured (set AGENT_WORKSPACE_TOOL_HOST_IMAGE)',
      );
    }
  }
  const sessionKey = `${config.runSpec?.runtimeProfileId ?? ''}:${config.sessionId}`;
  /** The session's tool sandbox origin, registering this run's token; nothing without a request. */
  const openTools = async (): Promise<Record<string, unknown>> =>
    toolRequest === undefined || input.options.toolSandboxes === undefined
      ? {}
      : {
          toolSandbox: {
            origin: await input.options.toolSandboxes.open(
              {
                key: sessionKey,
                workspaceId: segment(raw['workspaceId'], 'workspaceId', 'invalid_workspace_id'),
                sessionId: config.sessionId,
                workspacesRoot: input.options.workspacesRoot,
                publicBase: `${input.requestUrl.protocol}//${input.requestUrl.host}`,
                ...(credential === undefined ? {} : { providerCredential: credential }),
                ...(config.runSpec?.timeoutSeconds === undefined
                  ? {}
                  : { timeoutSeconds: config.runSpec.timeoutSeconds }),
              },
              toolRequest,
            ),
          },
        };
  // From the lookup to the table write below there are several awaits (liveness, create, a
  // readiness wait of up to 30 s); a client retry in that window would otherwise create a second
  // runtime on the same workspace and orphan the first.
  await serialised(input.sessionLocks, sessionKey, async () => {
    const existing = await existingAllocation(input, config, sessionKey, credential);
    if (existing !== undefined && (await input.options.driver.isLive(existing.handle))) {
      json(input.res, 200, {
        ...allocationBody(existing, input.requestUrl),
        ...(await openTools()),
      });
      return;
    }
    input.options.driver.assertCreatable?.(config, credential);
    if (existing !== undefined) {
      input.allocations.delete(existing.handle.id);
      input.bySession.delete(sessionKey);
      await input.options.driver.destroy(existing.handle, credential);
    }
    const handle = await input.options.driver.create(config, credential, {
      awWorkspace: segment(raw['workspaceId'], 'workspaceId', 'invalid_workspace_id'),
    });
    try {
      await waitUntilInvocable(
        handle,
        (candidate) => input.options.driver.isLive(candidate),
        input.runtimeRequestUrl,
        input.readinessPath,
        input.authHeaders,
        input.doFetch,
        input.options.verificationTimeoutMs ?? 30_000,
      );
    } catch (error) {
      await input.options.driver.destroy(handle, credential).catch(() => undefined);
      throw error;
    }
    let tools: Record<string, unknown>;
    try {
      tools = await openTools();
    } catch (error) {
      await input.options.driver.destroy(handle, credential).catch(() => undefined);
      throw error;
    }
    const allocation = { handle, sessionKey };
    if (input.options.driver.recover === undefined) {
      input.allocations.set(handle.id, allocation);
      input.bySession.set(sessionKey, handle.id);
    }
    json(input.res, 201, { ...allocationBody(allocation, input.requestUrl), ...tools });
  });
}

/** Runner-owned Docker lifecycle and private reverse proxy. */
export function createRunnerManagerServer(options: RunnerManagerOptions): Server {
  return createServer(createRunnerManagerListener(options));
}

/**
 * The manager's request handler, for a host that owns the listener: `createRunnerManagerServer`
 * serves it from a Node server, and a Vercel Function exports it as its `(req, res)` handler.
 */
export function createRunnerManagerListener(
  options: RunnerManagerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  if (options.token.length < 32) throw new Error('runner manager token must contain 32 characters');
  const expectedToken = Buffer.from(options.token);
  const allocations = new Map<string, Allocation>();
  const bySession = new Map<string, string>();
  const sessionLocks = new Map<string, Promise<unknown>>();
  const doFetch = options.fetch ?? globalThis.fetch;
  const runtimeOrigin = options.runtimeOrigin ?? ((handle) => `http://${handle.externalId}:8080`);
  const runtimeRequestUrl =
    options.runtimeRequestUrl ??
    ((handle, requestPath) => `${runtimeOrigin(handle)}${requestPath}`);
  const expectedDriver = options.expectedDriver ?? 'docker';
  const authHeaders =
    options.runtimeAuthHeaders ?? ((): Promise<Record<string, string>> => Promise.resolve({}));
  const readinessPath = options.readinessPath ?? '/healthz';
  const allocationOf = (id: string): Allocation | undefined => {
    if (options.driver.recover === undefined) return allocations.get(id);
    const handle = options.driver.recover(id);
    return handle === undefined ? undefined : { handle, sessionKey: '' };
  };

  return (req, res) => {
    void (async () => {
      // Cloud Run (and any reverse proxy in front of this manager) terminates TLS at the edge and
      // forwards plain HTTP to the container, so `req.url` alone never carries `https:`. Trusting a
      // hardcoded `http:` base here baked that scheme into `allocationBody()`'s `runnerUrl` — a
      // caller's next request to it hit Cloud Run's own http→https redirect, which drops the
      // `Authorization` header across the scheme change and turned every proxied `/run` into a 401
      // this manager issued against itself. `X-Forwarded-Proto` is the standard signal for the
      // scheme the client actually used; only its first, closest-hop value is trusted.
      const requestUrl = requestUrlOf(req);
      if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
        json(res, 200, { status: 'ok', allocations: allocations.size });
        return;
      }
      if (!authorized(req, expectedToken)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      // The gateway reaches a provider-hosted tool sandbox here, with the manager token and the
      // tool host's per-run token (ADR-0132): the provider's access headers are added here so they
      // never leave the manager, and the tool host refuses any other run token.
      if (await serveToolSandbox(req, res, requestUrl, options.toolSandboxes, doFetch)) return;
      if (req.method === 'POST' && requestUrl.pathname === '/tool-sandboxes') {
        await openEndpointToolSandbox({ req, res, requestUrl, options });
        return;
      }
      const closing = /^\/tool-sandboxes\/sessions\/([^/]+)$/u.exec(requestUrl.pathname);
      if (req.method === 'DELETE' && closing !== null) {
        await closeEndpointToolSandbox({
          req,
          res,
          requestUrl,
          clientId: closing[1] ?? '',
          options,
        });
        return;
      }
      if (await releaseRunToolSandboxes({ req, res, requestUrl, options })) return;
      if (req.method === 'POST' && requestUrl.pathname === '/runtimes') {
        await allocateRuntime({
          req,
          res,
          requestUrl,
          options,
          allocations,
          bySession,
          sessionLocks,
          expectedDriver,
          runtimeRequestUrl,
          readinessPath,
          authHeaders,
          doFetch,
        });
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/verify') {
        assertSomePolicyDeclared(options.driver, expectedDriver);
        const config = configFor(await body(req), options.workspacesRoot, expectedDriver);
        const fingerprint = runtimeVerificationFingerprint(
          config,
          options.configurationFingerprint ?? 'unspecified',
        );
        const credential = providerCredentialOf(req);
        const handle = await options.driver.create(config, credential);
        const nonce = randomUUID();
        try {
          await waitUntilInvocable(
            handle,
            (h) => options.driver.isLive(h),
            runtimeRequestUrl,
            readinessPath,
            authHeaders,
            doFetch,
            options.verificationTimeoutMs ?? 30_000,
          );
          const echoed = await doFetch(runtimeRequestUrl(handle, '/verify/echo'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(await authHeaders(handle)) },
            body: JSON.stringify({ nonce }),
            redirect: 'error',
          });
          const value = (await echoed.json()) as { nonce?: unknown };
          if (!echoed.ok || value.nonce !== nonce)
            throw new Error('runtime echo verification failed');
          json(res, 200, {
            fingerprint,
            verifiedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
          });
        } finally {
          await options.driver.destroy(handle, credential);
        }
        return;
      }

      const match = /^\/runtimes\/([^/]+)(?:\/(run|interrupt|files))?$/u.exec(requestUrl.pathname);
      if (match !== null) {
        const id = match[1] ?? '';
        const operation = match[2];
        const allocation = allocationOf(id);
        if (allocation === undefined) {
          // A stateless manager keeps no table, so an expired id and one it never sealed look
          // alike; both answer the contract's `live: false`, which tells nothing about which ids
          // ever existed. Everything else on the id stays a 404.
          if (isHandleProbe(req.method, operation, options.driver.recover !== undefined)) {
            json(res, 200, { live: false });
            return;
          }
          json(res, 404, { error: 'runtime_not_found' });
          return;
        }
        if (operation === undefined && req.method === 'GET') {
          json(res, 200, {
            ...allocationBody(allocation, requestUrl),
            live: await options.driver.isLive(allocation.handle),
          });
          return;
        }
        if (operation === undefined && req.method === 'DELETE') {
          // A runtime that fails to stop must not leak its tool sandbox and the secrets in it.
          const [runtime, tools] = await Promise.allSettled([
            options.driver.destroy(allocation.handle, providerCredentialOf(req)),
            options.toolSandboxes?.close(
              toolSessionOf(options.workspacesRoot, allocation),
              providerCredentialOf(req),
            ),
          ]);
          if (runtime.status === 'rejected') throw runtime.reason;
          // The runtime is gone: drop the allocation before surfacing a tool close error, so the
          // session is not stuck on a dead runtime.
          allocations.delete(id);
          if (bySession.get(allocation.sessionKey) === id) bySession.delete(allocation.sessionKey);
          if (tools.status === 'rejected') throw tools.reason;
          res.writeHead(204).end();
          return;
        }
        if (operation !== undefined) {
          await forward(
            req,
            res,
            runtimeRequestUrl(allocation.handle, `/${operation}${requestUrl.search}`),
            doFetch,
            await authHeaders(allocation.handle),
          );
          return;
        }
      }
      json(res, 404, { error: 'not_found' });
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof ManagerRequestError) {
        json(res, 400, { error: error.code, message: error.message });
        return;
      }
      if (error instanceof RuntimeRefusalError) {
        json(res, 422, { error: error.code, message: error.message });
        return;
      }
      if (error instanceof ToolSandboxUnavailableError) {
        json(res, 503, { error: 'tool_sandbox_unavailable', message: error.message });
        return;
      }
      if (error instanceof RunnerShuttingDownError) {
        res.setHeader('retry-after', '5');
        json(res, 503, { error: 'runner_shutting_down', message: error.message });
        return;
      }
      process.stderr.write(
        `runner manager request failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      json(res, 500, { error: 'internal_error' });
    });
  };
}

function runtimeVerificationFingerprint(
  config: RuntimeConfig,
  configurationFingerprint = 'unspecified',
): string {
  // Session/workspace identifiers prove isolation during the live probe but must not make the
  // verification identity random. The release decision is tied to enforceable policy plus the
  // exact image/driver configuration.
  return createHash('sha256')
    .update(JSON.stringify({ configurationFingerprint, runSpec: config.runSpec }))
    .digest('hex');
}
