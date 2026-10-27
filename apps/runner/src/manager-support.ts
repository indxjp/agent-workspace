import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  RuntimeRefusalError,
  type RuntimeConfig,
  type RuntimeHandle,
} from '@agent-workspace/runtime/driver';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';

import { parseRuntimeRunSpec } from './runtime-run-spec.js';
import type { ToolSandboxSession } from './tool-sandbox.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
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

export type Allocation = Readonly<{
  handle: RuntimeHandle;
  sessionKey: string;
}>;

/**
 * A sandbox was asked for after this manager began shutting down. Answered as `503`: the request
 * was well formed, and another manager (or this one, restarted) can serve it.
 */
export class RunnerShuttingDownError extends Error {
  public constructor() {
    super('the runner manager is shutting down and starts no new runtimes');
    this.name = 'RunnerShuttingDownError';
  }
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

export class ManagerRequestError extends Error {
  public constructor(
    public readonly code: ManagerRequestCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ManagerRequestError';
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function authorized(req: IncomingMessage, expected: Buffer): boolean {
  const match = /^Bearer\s+(.+)$/u.exec(req.headers.authorization ?? '');
  if (match === null) return false;
  const actual = Buffer.from(match[1] ?? '');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export async function body(
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
export function providerCredentialOf(req: IncomingMessage): string | undefined {
  const value = req.headers['x-provider-credential'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function segment(
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

export function configFor(
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
      { cause: error },
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
export function assertSomePolicyDeclared(
  driver: ManagedRuntimeDriver,
  expectedDriver: string,
): void {
  if (driver.capabilities?.networkPolicies.length === 0) {
    throw new RuntimeRefusalError(
      'network_policy_unsupported',
      `${expectedDriver} runtime refuses every network policy until its live lane proves egress denial (ADR-0131).`,
    );
  }
}

/** A status read of a handle a stateless manager (one that can recover handles) cannot open. */
export function isHandleProbe(
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
export function toolSessionOf(root: string, allocation: Allocation): ToolSandboxSession {
  const [workspaceId = '', sessionId = ''] = path
    .relative(root, allocation.handle.workspacePath)
    .split(path.sep);
  return { key: allocation.sessionKey, workspaceId, sessionId };
}

export function allocationBody(allocation: Allocation, requestUrl: URL): Record<string, unknown> {
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
export async function waitUntilInvocable(
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

export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  doFetch: typeof globalThis.fetch,
  extraHeaders: Record<string, string> = {},
  limit = RUN_FILES_MAX_BYTES,
): Promise<void> {
  const headers = new Headers();
  if (req.headers['content-type'] !== undefined)
    headers.set('content-type', req.headers['content-type']);
  if (req.headers.accept !== undefined) headers.set('accept', req.headers.accept);
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  // Runtime endpoints are an authenticated isolation boundary. Following a redirect could send
  // the manager's provider bearer to a different origin (or silently turn a POST into a GET), so
  // every upstream operation rejects 3xx instead.
  // A client that disconnects once its body is sent, while the upstream has not answered yet,
  // aborts the upstream request too; the request body's own end cannot tell it.
  const upstream = new AbortController();
  const abandon = (): void => {
    if (!res.writableFinished) upstream.abort();
  };
  res.once('close', abandon);
  const init: RequestInit = {
    method: req.method ?? 'GET',
    headers,
    redirect: 'error',
    signal: upstream.signal,
  };
  let refusal: ManagerRequestError | undefined;
  if (init.method !== 'GET' && init.method !== 'HEAD') {
    // The body streams so manager memory stays flat at any size up to the limit (the storage
    // design, §04). Past the limit the stream errors, which aborts the upstream request.
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength;
        if (size <= limit) return callback(null, chunk);
        refusal = new ManagerRequestError('request_too_large', 'proxied request body is too large');
        callback(refusal);
      },
    });
    req.once('error', (error) => limiter.destroy(error));
    init.body = Readable.toWeb(req.pipe(limiter)) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  try {
    const response = await doFetch(url, init);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => {
      if (name !== 'content-length' && name !== 'transfer-encoding') res.setHeader(name, value);
    });
    if (response.body === null) res.end();
    else await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    // fetch wraps the stream's error; the caller answers the refusal, not the wrapper.
    throw refusal ?? error;
  } finally {
    res.off('close', abandon);
  }
}

export function requestUrlOf(req: IncomingMessage): URL {
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
