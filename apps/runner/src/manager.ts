import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { withCleanup, withCompensation } from '@agent-workspace/core';
import {
  RuntimeRefusalError,
  type RuntimeConfig,
  type RuntimeHandle,
} from '@agent-workspace/runtime/driver';
import {
  RUN_FILES_MAX_ARCHIVE_BYTES,
  RUN_FILES_MAX_BYTES,
} from '@agent-workspace/runtime/transfer';

import {
  allocationBody,
  assertSomePolicyDeclared,
  authorized,
  body,
  configFor,
  forward,
  isHandleProbe,
  json,
  ManagerRequestError,
  providerCredentialOf,
  requestUrlOf,
  RunnerShuttingDownError,
  segment,
  toolSessionOf,
  waitUntilInvocable,
  type Allocation,
  type ManagedRuntimeDriver,
} from './manager-support.js';
import {
  parseToolSandboxRequest,
  ToolSandboxUnavailableError,
  type ToolSandboxes,
} from './tool-sandbox.js';

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
      { cause: error },
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
        { cause: error },
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
    const tools = await withCompensation(
      async () => {
        await waitUntilInvocable(
          handle,
          (candidate) => input.options.driver.isLive(candidate),
          input.runtimeRequestUrl,
          input.readinessPath,
          input.authHeaders,
          input.doFetch,
          input.options.verificationTimeoutMs ?? 30_000,
        );
        return openTools();
      },
      () => input.options.driver.destroy(handle, credential),
    );
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
        await withCleanup(
          async () => {
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
          },
          () => options.driver.destroy(handle, credential),
        );
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
            // A `/files` body is a tar archive: its framing is on top of the payload limit.
            operation === 'files' ? RUN_FILES_MAX_ARCHIVE_BYTES : RUN_FILES_MAX_BYTES,
          );
          return;
        }
      }
      json(res, 404, { error: 'not_found' });
    })().catch((thrown: unknown) => {
      // A cleanup that failed too is logged here; the status is the operation's own failure's.
      const error = thrown instanceof AggregateError ? (thrown.errors[0] as unknown) : thrown;
      if (thrown instanceof AggregateError) {
        process.stderr.write(`runner manager request failed: ${messagesOf(thrown)}\n`);
      }
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
      if (!(thrown instanceof AggregateError)) {
        process.stderr.write(`runner manager request failed: ${messagesOf(error)}\n`);
      }
      json(res, 500, { error: 'internal_error' });
    });
  };
}

/** Every message an error carries, an `AggregateError`'s own and each of its errors'. */
function messagesOf(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...(error.errors as unknown[]).map(messagesOf)].join('; ');
  }
  return error instanceof Error ? error.message : String(error);
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
