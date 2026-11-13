import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createJsonLogger,
  parseTraceparent,
  traceHeaders,
  type Logger,
} from '@agent-workspace/core/telemetry';
import { inServerSpan, spanTraceparent } from '@agent-workspace/core/tracing';
import { RUN_FILES_MAX_BYTES, RUN_FILES_MAX_MEMBERS } from '@agent-workspace/runtime/transfer';
import { contractSummary } from './http-contract.js';
import { installedEngines, loadEngine, toEngineRunRequest } from './engines.js';
import { readJsonObject, sendError, sendJson, sendMethodNotAllowed } from './http-io.js';
import { type ResolvedRunRequest } from './resources.js';
import { handleInterrupt, handleRun, type RunnerState } from './run-handler.js';
import { startEngineAgent, type EngineStartOutcome, type RunnerAgentStarter } from './runtime.js';
import { handleFiles } from './server-files.js';

/** §14.3: *"Kubernetes / Docker / ECS — our own paths on port `8080`"*. */
const DEFAULT_PORT = 8080;
/** The highest TCP port number. */
const MAX_PORT = 65_535;

// ── The server ──────────────────────────────────────────────────────────────────────────

/**
 * Start a run on whichever engine the request named — the registry path (ENG-04).
 *
 * This is the default {@link RunnerServerOptions.startAgent}, and it is the *only* place a run
 * meets an engine adapter. Everything before it is engine-neutral, and the one decision made
 * here is a table lookup in `./engines.ts`.
 */
async function startRegisteredAgent(request: ResolvedRunRequest): Promise<EngineStartOutcome> {
  const lookup = await loadEngine(request.engine);
  if (!lookup.ok) return { ok: false, code: lookup.code, reason: lookup.reason };
  return startEngineAgent(lookup.engine, toEngineRunRequest(request));
}

/** The engines this image carries, as `/healthz` publishes them. */
async function listEngines(): Promise<readonly { id: string; version: string }[]> {
  return (await installedEngines()).map((engine) => ({
    id: engine.id,
    version: engine.version,
  }));
}

/**
 * `POST /run` inside its SERVER span (ADR-0155). The span continues the control plane's trace, the
 * engine is handed the span's own `traceparent` so the gateway's span is its child, and a run that
 * arrived without a trace logs the span's trace id. With tracing off this is `handleRun` as before.
 */
function handleRunInSpan(input: {
  route: string;
  req: IncomingMessage;
  res: ServerResponse;
  state: RunnerState;
  startAgent: RunnerAgentStarter;
  logger: Logger;
  forwardedTrace: Readonly<Record<string, string>>;
}): Promise<void> {
  const { route, req, res, state, startAgent, logger, forwardedTrace } = input;
  const attributes = { 'http.request.method': 'POST', 'http.route': route };
  return inServerSpan(`POST ${route}`, forwardedTrace['traceparent'], attributes, async (span) => {
    const own = spanTraceparent(span);
    const trace =
      own === null ? forwardedTrace : traceHeaders(own, forwardedTrace['tracestate'] ?? null);
    const traceId = parseTraceparent(trace['traceparent'])?.traceId;
    const log = traceId === undefined ? logger : logger.child({ traceId });
    await handleRun(req, res, { state, startAgent, log, forwardedTrace: trace });
    span.setAttribute('http.response.status_code', res.statusCode);
  });
}

export type RunnerServerOptions = {
  /**
   * How a run is started. Defaults to {@link startRegisteredAgent}, the registry-backed one.
   *
   * A parameter rather than a hard import so the contract can be exercised end to end — three
   * endpoints, real sockets, real SSE framing, real interrupt — without any engine SDK. It is
   * one function argument, not an injection framework (§39 rule 4).
   */
  readonly startAgent?: RunnerAgentStarter;
  /** Files are always hydrated and collected beneath this runtime workspace. */
  readonly workspacePath?: string;
  /**
   * Bounded process capacity. Run ids belonging to *different* sessions execute concurrently up
   * to this limit; two runs of the same session never do — see the `session_in_flight` refusal in
   * {@link handleRun} — because `cwd` is one directory per session, shared by every run within it.
   */
  readonly maxConcurrentRuns?: number;
  /**
   * When set, every request must carry `Authorization: Bearer <bearer>` (ADR-0120 LC3): a sandbox
   * the provider exposes at a public URL is reachable by anyone, so the server inside refuses
   * what is not the manager. Unset leaves the private-network drivers exactly as they were.
   */
  readonly bearer?: string;
  /** Size cap for `POST /files` bodies and `GET /files` collections. Defaults to 128 MiB. */
  readonly maxFileArchiveBytes?: number;
  /** Member cap for `POST /files` archives. Defaults to `RUN_FILES_MAX_MEMBERS`. */
  readonly maxFileArchiveMembers?: number;
  /** Where request logs go. Defaults to JSON lines on stdout/stderr (F-04). */
  readonly logger?: Logger;
};

async function handleVerificationEcho(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonObject(req);
  if (!body.ok) {
    sendError(res, body.status, body.error, body.message);
    return;
  }
  const nonce = body.value['nonce'];
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 256) {
    sendError(res, 400, 'invalid_nonce', 'nonce must contain 16 through 256 characters.');
    return;
  }
  sendJson(res, 200, { nonce });
}

const DEFAULT_MAX_CONCURRENT_RUNS = 8;

function bearerMatches(header: string | undefined, bearer: string): boolean {
  const expected = createHash('sha256').update(`Bearer ${bearer}`).digest();
  const presented = createHash('sha256')
    .update(header ?? '')
    .digest();
  return timingSafeEqual(expected, presented);
}

export function parseMaxConcurrentRuns(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_MAX_CONCURRENT_RUNS;
  const text = raw.trim();
  if (!/^\d{1,4}$/u.test(text)) {
    throw new Error(`MAX_CONCURRENT_RUNS must be a positive integer; got ${JSON.stringify(raw)}.`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_024) {
    throw new Error(`MAX_CONCURRENT_RUNS must be between 1 and 1024; got ${JSON.stringify(raw)}.`);
  }
  return value;
}

/**
 * The §14.3 server. Nothing is listening until {@link listen} is called.
 *
 * The router below is a total classifier: every path this contract names has an arm, and the
 * final `else` rejects and says what it serves.
 */
type RuntimeContext = ReturnType<typeof createRuntimeContext>;

function createRuntimeContext(options: RunnerServerOptions) {
  const startAgent = options.startAgent ?? startRegisteredAgent;
  const workspacePath = options.workspacePath ?? '/workspace';
  const maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  const maxFileArchiveBytes = options.maxFileArchiveBytes ?? RUN_FILES_MAX_BYTES;
  const maxFileArchiveMembers = options.maxFileArchiveMembers ?? RUN_FILES_MAX_MEMBERS;
  if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
    throw new Error('maxConcurrentRuns must be a positive safe integer.');
  }
  const state: RunnerState = { admitted: new Map(), runs: new Map(), maxConcurrentRuns };
  const logger = options.logger ?? createJsonLogger({ service: 'runner' });

  return {
    options,
    startAgent,
    workspacePath,
    maxFileArchiveBytes,
    maxFileArchiveMembers,
    state,
    logger,
  };
}

export function createRunnerServer(options: RunnerServerOptions = {}): Server {
  const context = createRuntimeContext(options);
  return createServer((req, res) => handleRuntimeRequest(context, req, res));
}

function handleRuntimeRequest(
  context: RuntimeContext,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const { options, logger } = context;
  req.socket.setNoDelay(true);
  const requestUrl = runtimeRequestUrl(req, res);
  if (requestUrl === undefined) return;
  const pathname = requestUrl.pathname;
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (options.bearer !== undefined && !bearerMatches(req.headers.authorization, options.bearer)) {
    sendError(res, 401, 'unauthorized', 'a valid bearer token is required.');
    return;
  }
  const traceHeader = req.headers['traceparent'];
  const stateHeader = req.headers['tracestate'];
  const forwardedTrace = traceHeaders(
    typeof traceHeader === 'string' ? traceHeader : null,
    typeof stateHeader === 'string' ? stateHeader : null,
  );
  const trace = parseTraceparent(forwardedTrace['traceparent']);
  const log = trace === null ? logger : logger.child({ traceId: trace.traceId });
  void routeRuntimeRequest({ context, req, res, requestUrl, path, log, forwardedTrace }).catch(
    (error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, 500, 'internal_error', error instanceof Error ? error.message : String(error));
    },
  );
}

function runtimeRequestUrl(req: IncomingMessage, res: ServerResponse): URL | undefined {
  const target = req.url;
  if (target === undefined || target.length === 0) {
    sendError(res, 400, 'invalid_request', 'the request has no request target.');
    return;
  }
  try {
    return new URL(target, 'http://runtime.invalid');
  } catch {
    sendError(
      res,
      400,
      'invalid_request',
      `the request target ${JSON.stringify(target)} is not a valid URL path.`,
    );
    return;
  }
}

async function routeRuntimeRequest(input: {
  context: RuntimeContext;
  req: IncomingMessage;
  res: ServerResponse;
  requestUrl: URL;
  path: string;
  log: Logger;
  forwardedTrace: Readonly<Record<string, string>>;
}): Promise<void> {
  const { context, req, res, requestUrl, path, log, forwardedTrace } = input;
  const { state, startAgent, logger, workspacePath, maxFileArchiveBytes, maxFileArchiveMembers } =
    context;
  const method = req.method ?? '';
  if (path === '/files') {
    await handleFiles({
      req,
      res,
      method,
      requestUrl,
      workspacePath,
      maxFileArchiveBytes,
      maxFileArchiveMembers,
      log,
    });
    return;
  }
  const isHealth = path === '/healthz' || path === '/ping';
  const isRun = path === '/run' || path === '/invocations';
  const isPost = isRun || path === '/verify/echo' || path === '/interrupt';
  const expectedMethod = isHealth ? 'GET' : isPost ? 'POST' : undefined;
  if (expectedMethod !== undefined && method !== expectedMethod) {
    sendMethodNotAllowed(res, path, expectedMethod);
    return;
  }
  if (isHealth) {
    sendJson(res, 200, {
      status: 'ok',
      runInFlight: state.admitted.size > 0,
      activeRuns: state.admitted.size,
      capacity: state.maxConcurrentRuns,
      available: state.maxConcurrentRuns - state.admitted.size,
      engines: await listEngines(),
    });
    return;
  }
  if (path === '/verify/echo') return handleVerificationEcho(req, res);
  if (isRun)
    return handleRunInSpan({ route: path, req, res, state, startAgent, logger, forwardedTrace });
  if (path === '/interrupt') return handleInterrupt(req, res, state);
  sendError(res, 404, 'not_found', `no such endpoint. ${contractSummary()}`);
}

/** Bind the server, and answer with the address it actually got. */
export function listen(server: Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error(`the server bound to ${String(address)}, which is not a TCP address.`));
        return;
      }
      resolve(address);
    });
  });
}

/**
 * Read a port out of the environment, or fail.
 *
 * `Number('8o80')` is `NaN` and `NaN < 65536` is `false`, which is the exact shape ADR-0015 was
 * written about: a malformed value sails through a range check and the process binds to
 * something nobody chose. So the string is validated before it is converted, and an unusable
 * value throws rather than quietly becoming the default.
 */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_PORT;
  const text = raw.trim();
  if (!/^\d{1,5}$/.test(text)) {
    throw new Error(`PORT must be a decimal port number; got ${JSON.stringify(raw)}.`);
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`PORT must be between 1 and 65535; got ${JSON.stringify(raw)}.`);
  }
  return port;
}

/**
 * Start the §14.3 server from the process environment.
 *
 * `HOST` defaults to `0.0.0.0` because the whole point of this server is to be reached from
 * outside its container; a driver that port-forwards to a loopback-only listener gets a
 * connection refused with nothing to read. Override it for a laptop.
 */
export async function startRunnerServer(
  env: NodeJS.ProcessEnv = process.env,
  options: RunnerServerOptions = {},
): Promise<{ server: Server; address: AddressInfo }> {
  const bearer = env['RUNTIME_SANDBOX_BEARER'];
  const server = createRunnerServer({
    ...options,
    ...(options.bearer === undefined && bearer !== undefined && bearer.length > 0
      ? { bearer }
      : {}),
    maxConcurrentRuns:
      options.maxConcurrentRuns ?? parseMaxConcurrentRuns(env['MAX_CONCURRENT_RUNS']),
  });
  const host = env['HOST'] !== undefined && env['HOST'].length > 0 ? env['HOST'] : '0.0.0.0';
  const address = await listen(server, parsePort(env['PORT']), host);
  return { server, address };
}
