/**
 * `apps/runner/src/server.ts` — the runtime container's HTTP contract (spec §14.3).
 * The HTTP plumbing is in `./http-io.ts` and the run lifecycle (`/run`, `/interrupt`, the SSE
 * stream) in `./run-handler.ts`; this file keeps routing, `/files` and the listener.
 *
 * ```text
 * GET  /healthz            liveness / readiness
 * POST /run                start a run, respond with an SSE stream of SDK events
 * POST /interrupt          cancel the current run
 * POST /files              hydrate the workspace from a tar stream
 * GET  /files              collect persistent files as a tar stream
 * ```
 *
 * `/files` answers a refused archive or path with 400, a missing path with 404, an archive over
 * the size cap with 413 and any other fault with a 500 whose message is fixed (the detail goes to
 * stderr), so no response carries a host path.
 *
 * Provider-required aliases live in the same server (§14.3): `POST /invocations` and `GET /ping`
 * are Amazon Bedrock AgentCore's required paths on port 8080, and W3-RT-05 wires each to the same
 * handler as the §14.3 endpoint it aliases — `/invocations` behaves exactly as `/run`, `/ping`
 * exactly as `/healthz` — rather than a second, parallel implementation that could drift from the
 * first. See `docs/adr/W3-RT-05-agentcore-aliases-share-their-handlers.md`.
 *
 * All seven declared routes are implemented. `/files` hydrates and collects POSIX ustar archives
 * beneath one configured workspace root; path containment is checked before any filesystem write
 * or read. The declared/implemented split remains data in `./http-contract.ts`.
 *
 * *"Defining one HTTP contract is what makes managed sandbox services usable without per-vendor
 * agent code, because every managed sandbox product in this space is fundamentally 'send an HTTP
 * request into an isolated container.'"* — §14.3. So this file has no vendor in it, and the port
 * is §14.3's `8080`.
 *
 * ## The stream
 *
 * The SSE shape is the R-13 research note's contract summary, and the two rules that note
 * establishes the hard way are obeyed here:
 *
 *  * **A failure inside an established stream is a named frame in a 200, never a status code.**
 *    R-13 finding 7 probed this: one non-200 puts a conformant client in `CLOSED` permanently,
 *    with no retry and no way to tell a transient drop from a fatal one. By the time the first
 *    byte is written the status is already 200 and the only honest way to report a failure is a
 *    named frame.
 *  * **No frame is named `error`.** HTML §9.2 dispatches an event whose type is the `event:`
 *    field, so `event: error` collides with `EventSource`'s own transport-error event and is
 *    swallowed. Every relayed name now comes from `@agent-workspace/core`'s `toAgentFrames`,
 *    whose output is the closed `agent.*` set of `@indx-workspace/contracts`' `AGENT_FRAME_NAMES`
 *    — so the names on this wire are a vocabulary, not a passthrough, and `error` is not in it.
 *
 * ## The event vocabulary
 *
 * ENG-03 (#302): this server streams **one engine-neutral `agent.*` vocabulary**, produced once by
 * the engine's adapter, instead of a Claude-shaped classification that each client re-maps. The
 * mapping is `toAgentFrames` in `packages/core` — the Claude boundary's own function, which ENG-04
 * moves into the Claude adapter package — and `ClassifiedSdkEvent` is now that function's input
 * type and nothing else: it no longer names anything on the wire.
 *
 * **The three terminal names are `run-done`, `run-error` and `run-interrupted` — not R-13's own
 * `done` / `run-failed`.** R-13 is titled *"Streaming from Next.js App Router to the browser"*
 * and blocks W1-CP-04 and W1-UI-03: it is the contract for the control plane's *outward* stream,
 * to a browser. This server speaks a different, inward stream — §14.3's runner-to-control-plane
 * contract — and `apps/web/server/runs/sse.ts` reserves `done` and `run-failed` for its *own*
 * outward control frames, on `docs/adr/W1-CP-04-event-names-are-validated-at-ingestion.md`'s own
 * explicit condition that *"W1-RN-02 must not emit any reserved name from `POST /run`."* This
 * file did, for every run, because R-13's example frame names were reused here without noticing
 * the two contracts were not the same one. W1-COMP-01 found it by running a real run through the
 * real relay for the first time: every terminal frame was rejected as a reserved name, so every
 * run — success or failure alike — reached the control plane as `failed`, carrying that rejection
 * message instead of the SDK's own outcome. See
 * `docs/adr/W1-COMP-01-the-runners-own-terminal-frame-collided-with-the-relays-reserved-names.md`.
 *
 * ## What this server trusts, stated because §14.3 does not
 *
 * There is no authentication on any endpoint here, and none is invented: §14.3 prints the
 * contract without one, and a scheme this file made up would be a security boundary no driver
 * knows how to satisfy. What follows from that is worth naming rather than leaving to be
 * discovered.
 *
 * A `RunRequest` body chooses the run's `cwd` and its **entire** subprocess environment.
 * `compileRunRequest` builds `env` as `{ ...request.env, <session scope> }` and `claude.ts`
 * passes it to the SDK as `options.env`, which R-01 §3 records as *replacing* the subprocess
 * environment rather than merging with it — so the body, not the runner's own `process.env`,
 * decides `PATH`, `ANTHROPIC_BASE_URL` and everything else the agent's shell inherits. Combined
 * with `local`'s `isolation: 'none'` and its `execCommands` capability, anyone who can reach
 * this socket can run a command as the runner's user, on the runner's host.
 *
 * That is the intended shape for a runtime container reachable only by its own driver over a
 * private network, and it is why {@link startRunnerServer}'s `HOST` default matters. It is not a
 * shape that survives exposure. The spec prints no authentication for this contract and this
 * file adds none; the trust assumption is a declared gap on the task's PR rather than an
 * oversight, and whoever exposes this socket beyond a driver-private network owes it one.
 *
 * Keep-alive comments every `KEEPALIVE_MS` are not decoration: R-13 finding 4 probed a
 * silent stream being killed at ~60 s by stock nginx's `proxy_read_timeout`, and an AWS ALB's
 * `idle_timeout` defaults to the same 60 s. A runtime container sits behind at least one of those
 * on every driver except this one.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import {
  createJsonLogger,
  parseTraceparent,
  traceHeaders,
  type Logger,
} from '@agent-workspace/core/telemetry';
import { inServerSpan, spanTraceparent } from '@agent-workspace/core/tracing';
import {
  ArchiveTooLargeError,
  ArchiveValidationError,
  extractUstarStream,
  RUN_FILES_MAX_BYTES,
  RUN_FILES_MAX_MEMBERS,
} from '@agent-workspace/runtime/transfer';

import { contractSummary } from './http-contract.js';
import { installedEngines, loadEngine, toEngineRunRequest } from './engines.js';
import { collectWorkspace } from './files.js';
import { readJsonObject, sendError, sendJson, sendMethodNotAllowed } from './http-io.js';
import { type ResolvedRunRequest } from './resources.js';
import { handleInterrupt, handleRun, type RunnerState } from './run-handler.js';
import { startEngineAgent, type EngineStartOutcome, type RunnerAgentStarter } from './runtime.js';

/** §14.3: *"Kubernetes / Docker / ECS — our own paths on port `8080`"*. */
const DEFAULT_PORT = 8080;

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
function handleRunInSpan(
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  state: RunnerState,
  startAgent: RunnerAgentStarter,
  logger: Logger,
  forwardedTrace: Readonly<Record<string, string>>,
): Promise<void> {
  const attributes = { 'http.request.method': 'POST', 'http.route': route };
  return inServerSpan(`POST ${route}`, forwardedTrace['traceparent'], attributes, async (span) => {
    const own = spanTraceparent(span);
    const trace =
      own === null ? forwardedTrace : traceHeaders(own, forwardedTrace['tracestate'] ?? null);
    const traceId = parseTraceparent(trace['traceparent'])?.traceId;
    const log = traceId === undefined ? logger : logger.child({ traceId });
    await handleRun(req, res, state, startAgent, log, trace);
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

const FILES_NOT_FOUND = 'the requested workspace path does not exist.';
const FILES_FAILED = 'the workspace files could not be processed.';

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Typed `/files` failures: only the codec's own validation messages (relative paths) are sent. */
function sendFilesFailure(
  res: ServerResponse,
  log: Logger,
  error: unknown,
  invalidCode: string,
): void {
  if (error instanceof ArchiveTooLargeError) {
    sendError(res, 413, 'archive_too_large', error.message);
  } else if (error instanceof ArchiveValidationError) {
    sendError(res, 400, invalidCode, error.message);
  } else {
    log.error('/files failed', { error });
    sendError(res, 500, 'internal_error', FILES_FAILED);
  }
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
export function createRunnerServer(options: RunnerServerOptions = {}): Server {
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

  return createServer((req, res) => {
    // Frames are small and latency matters more than packet count on a streaming response.
    req.socket.setNoDelay(true);

    const method = req.method ?? '';
    const target = req.url;
    if (target === undefined || target.length === 0) {
      sendError(res, 400, 'invalid_request', 'the request has no request target.');
      return;
    }

    let requestUrl: URL;
    try {
      requestUrl = new URL(target, 'http://runtime.invalid');
    } catch {
      sendError(
        res,
        400,
        'invalid_request',
        `the request target ${JSON.stringify(target)} is not a valid URL path.`,
      );
      return;
    }
    // `/run/` and `/run` are the same endpoint; nothing else about the path is normalised.
    const pathname = requestUrl.pathname;
    const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

    if (options.bearer !== undefined && !bearerMatches(req.headers.authorization, options.bearer)) {
      sendError(res, 401, 'unauthorized', 'a valid bearer token is required.');
      return;
    }

    // W3C trace context from the control plane joins this request's log lines to its trace. An
    // absent, repeated or malformed header is no context — never an error, and never echoed.
    const traceHeader = req.headers['traceparent'];
    const stateHeader = req.headers['tracestate'];
    const forwardedTrace = traceHeaders(
      typeof traceHeader === 'string' ? traceHeader : null,
      typeof stateHeader === 'string' ? stateHeader : null,
    );
    const trace = parseTraceparent(forwardedTrace['traceparent']);
    const log = trace === null ? logger : logger.child({ traceId: trace.traceId });

    const handle = async (): Promise<void> => {
      // `GET /ping` is Amazon Bedrock AgentCore's required liveness path (§14.3) and behaves
      // exactly as `GET /healthz` — one handler, not a second implementation that could drift
      // from the first (docs/adr/W3-RT-05-agentcore-aliases-share-their-handlers.md).
      if (path === '/healthz' || path === '/ping') {
        if (method !== 'GET') {
          sendMethodNotAllowed(res, path, 'GET');
          return;
        }
        // ENG-04: `engines` is how the control plane fills `EngineDescriptor.installed` and
        // `version` (ENG-02). It is the result of *loading* each adapter, not a reading of the
        // registry's table, so an engine this image declares and cannot load is absent here —
        // which is the honest answer and the one `installed: false` is for.
        sendJson(res, 200, {
          status: 'ok',
          // Admitted, not merely streaming: a run whose engine is still loading holds its slot.
          runInFlight: state.admitted.size > 0,
          activeRuns: state.admitted.size,
          capacity: state.maxConcurrentRuns,
          available: state.maxConcurrentRuns - state.admitted.size,
          engines: await listEngines(),
        });
        return;
      }

      // Private runner-manager conformance probe. It exercises real request routing inside the
      // freshly-created container without starting a billable model operation.
      if (path === '/verify/echo') {
        if (method !== 'POST') {
          sendMethodNotAllowed(res, '/verify/echo', 'POST');
          return;
        }
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
        return;
      }

      // `POST /invocations` is AgentCore's required invoke path (§14.3) and behaves exactly as
      // `POST /run` — same body schema, same SSE stream, same terminal-frame contract.
      if (path === '/run' || path === '/invocations') {
        if (method !== 'POST') {
          sendMethodNotAllowed(res, path, 'POST');
          return;
        }
        await handleRunInSpan(path, req, res, state, startAgent, logger, forwardedTrace);
        return;
      }

      if (path === '/interrupt') {
        if (method !== 'POST') {
          sendMethodNotAllowed(res, '/interrupt', 'POST');
          return;
        }
        await handleInterrupt(req, res, state);
        return;
      }

      if (path === '/files') {
        if (method === 'POST') {
          try {
            const files = await extractUstarStream(
              Readable.toWeb(req) as ReadableStream<Uint8Array>,
              workspacePath,
              { maxBytes: maxFileArchiveBytes, maxMembers: maxFileArchiveMembers },
            );
            sendJson(res, 200, { hydrated: files });
          } catch (error) {
            sendFilesFailure(res, log, error, 'invalid_archive');
          }
          return;
        }
        if (method === 'GET') {
          try {
            const archive = await collectWorkspace(
              workspacePath,
              requestUrl.searchParams.getAll('path'),
              maxFileArchiveBytes,
            );
            res.writeHead(200, {
              'Content-Type': 'application/x-tar',
              'Cache-Control': 'no-store',
              'Content-Length': String(archive.byteLength),
            });
            res.end(Buffer.from(archive));
          } catch (error) {
            if (isMissingPath(error)) sendError(res, 404, 'file_not_found', FILES_NOT_FOUND);
            else sendFilesFailure(res, log, error, 'invalid_file_request');
          }
          return;
        }
        sendMethodNotAllowed(res, '/files', 'GET, POST');
        return;
      }

      sendError(res, 404, 'not_found', `no such endpoint. ${contractSummary()}`);
    };

    void handle().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (res.headersSent) {
        // The stream is already established, so the status is already 200 and changing it is not
        // an option R-13 finding 7 leaves open. End the connection; the relay sees a truncated
        // stream and reconnects.
        res.end();
        return;
      }
      sendError(res, 500, 'internal_error', message);
    });
  });
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
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
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
