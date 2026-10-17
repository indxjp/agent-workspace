/**
 * `apps/runner/src/server.ts` — the runtime container's HTTP contract (spec §14.3).
 *
 * ```text
 * GET  /healthz            liveness / readiness
 * POST /run                start a run, respond with an SSE stream of SDK events
 * POST /interrupt          cancel the current run
 * POST /files              hydrate the workspace from a tar stream
 * GET  /files              collect persistent files as a tar stream
 * ```
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
 * Keep-alive comments every {@link KEEPALIVE_MS} are not decoration: R-13 finding 4 probed a
 * silent stream being killed at ~60 s by stock nginx's `proxy_read_timeout`, and an AWS ALB's
 * `idle_timeout` defaults to the same 60 s. A runtime container sits behind at least one of those
 * on every driver except this one.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { RunRequest } from '@agent-workspace/core';

import { contractSummary } from './http-contract.js';
import { installedEngines, loadEngine, toEngineRunRequest } from './engines.js';
import { collectWorkspace, hydrateWorkspace } from './files.js';
import {
  startEngineAgent,
  type EngineStartOutcome,
  type RunnerAgentConnection,
  type RunnerAgentStarter,
} from './runtime.js';

/** The parsed private-contract body. Named so the starter signature reads at a glance. */
type RunRequestValue = ReturnType<typeof RunRequest.parse>;

/** §14.3: *"Kubernetes / Docker / ECS — our own paths on port `8080`"*. */
const DEFAULT_PORT = 8080;

/**
 * R-13's inference, restated where it is used: shorter than the smallest idle timeout on any hop.
 * nginx `proxy_read_timeout` and ALB `idle_timeout` both default to 60 s; 15 s is a 4× margin.
 * The probes bracketed it (1 s survived 620 s, 70 s of silence died at ~60 s) without running it.
 */
const KEEPALIVE_MS = 15_000;

/** A run request is a JSON object of bounded size. 1 MiB is far more than `RunRequest` can need. */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FILE_ARCHIVE_BYTES = 128 * 1024 * 1024;

/**
 * R-13's three headers, and only three. `Content-Encoding: none`, `Connection: keep-alive` and
 * `X-Content-Type-Options: nosniff` were each removed from that note's contract for a stated
 * reason; do not add them back here without reading the omitted-headers table.
 */
const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};

const JSON_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

// ── Small HTTP helpers ──────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': String(payload.byteLength) });
  res.end(payload);
}

/** A refusal that names itself: a stable machine code, and a sentence a human can act on. */
function sendError(res: ServerResponse, status: number, error: string, message: string): void {
  sendJson(res, status, { error, message });
}

function sendMethodNotAllowed(res: ServerResponse, path: string, allow: string): void {
  if (res.headersSent) return;
  const payload = Buffer.from(
    JSON.stringify({
      error: 'method_not_allowed',
      message: `${path} accepts ${allow} only (spec §14.3).`,
    }),
    'utf8',
  );
  res.writeHead(405, {
    ...JSON_HEADERS,
    Allow: allow,
    'Content-Length': String(payload.byteLength),
  });
  res.end(payload);
}

type BodyResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly message: string;
    };

/**
 * Read a bounded request body and parse it as a JSON object.
 *
 * Every failure arm is explicit and none of them falls through to "assume `{}`": an empty body, a
 * body that is not JSON, and a body that is JSON but not an object are three different mistakes
 * and are reported as three different messages. A `RunRequest` built from a silently defaulted
 * body is exactly the run this platform must not start.
 */
async function readJsonObject(req: IncomingMessage): Promise<BodyResult> {
  const raw = await new Promise<Buffer | 'too-large'>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(overflowed ? 'too-large' : Buffer.concat(chunks));
    });
    req.on('error', (error: Error) => {
      reject(error);
    });
  });

  if (raw === 'too-large') {
    return {
      ok: false,
      status: 413,
      error: 'body_too_large',
      message: `the request body exceeds ${String(MAX_BODY_BYTES)} bytes.`,
    };
  }
  if (raw.byteLength === 0) {
    return {
      ok: false,
      status: 400,
      error: 'empty_body',
      message: 'the request body is empty; a JSON RunRequest object is required.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_json',
      message: `the request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_body',
      message: 'the request body must be a JSON object.',
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

// ── SSE framing ─────────────────────────────────────────────────────────────────────────

/**
 * One frame. `id` is monotonic within the stream and is the resume cursor a relay seeks to;
 * `JSON.stringify` is what guarantees `data` contains no raw newline, which HTML §9.2 would
 * otherwise read as a second `data:` line.
 */
function sseFrame(name: string, id: number, data: unknown): string {
  return `event: ${name}\nid: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Write one chunk, respecting backpressure.
 *
 * Resolves on `drain` when the socket buffer is full, and on `close` when it will never drain
 * because the client went away — without the second listener a disconnected slow consumer parks
 * this run forever on a promise nothing will settle.
 */
function writeChunk(res: ServerResponse, chunk: string): Promise<void> {
  if (res.writableEnded || res.destroyed) return Promise.resolve();
  if (res.write(chunk)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

// ── The three endpoints ─────────────────────────────────────────────────────────────────

/** One run this runner process is serving. */
type InFlight = {
  readonly runId: string;
  readonly sessionId: string;
  readonly connection: RunnerAgentConnection;
  interrupted: boolean;
};

/**
 * A run this runner has admitted: the admission checks passed and the slot is held, whether or
 * not its engine has started yet. Kept apart from {@link InFlight} because a run is admitted
 * before it has a connection to interrupt — `startAgent` is asynchronous (the registry's dynamic
 * `import()`), and the slot must be held across that `await`.
 */
type Admitted = {
  readonly runId: string;
  readonly sessionId: string;
  /** `/interrupt` arrived while the engine was still starting; applied once it has started. */
  interruptRequested: boolean;
};

type RunnerState = {
  /** Every admitted run — starting or streaming. The admission checks read this map only. */
  readonly admitted: Map<string, Admitted>;
  /** The admitted runs whose engine has started, which are the ones an interrupt can reach. */
  readonly runs: Map<string, InFlight>;
  readonly maxConcurrentRuns: number;
};

/** What the caller learns about the Claude session id, without the promise being able to hang. */
async function settleSessionId(
  connection: RunnerAgentConnection,
): Promise<{ sessionId: string | null; sessionIdError: string | null }> {
  try {
    return { sessionId: await connection.sessionId, sessionIdError: null };
  } catch (error) {
    return {
      sessionId: null,
      sessionIdError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Raise the cancellation without awaiting it; a rejection is logged, never left unhandled. */
function interruptInBackground(run: InFlight): void {
  run.interrupted = true;
  run.connection.interrupt().catch((error: unknown) => {
    process.stderr.write(
      `runner: interrupting run ${run.runId} failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
}

async function streamRun(res: ServerResponse, run: InFlight): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
  let id = 0;
  // R-13: pin the client's reconnection delay rather than inheriting a user-agent default.
  await writeChunk(res, 'retry: 3000\n\n');

  const keepalive = setInterval(() => {
    // A ':' line is a comment to the client (HTML §9.2) and real body bytes to every proxy on
    // the path, which is the only thing that resets an idle timer.
    void writeChunk(res, ': keepalive\n\n');
  }, KEEPALIVE_MS);
  // Node keeps a process alive for a pending interval; this one must never be the reason.
  keepalive.unref();

  // The client going away must stop the run. Without this the agent keeps running — and keeps
  // spending — with nobody reading a single event of it.
  const onClose = (): void => {
    if (!run.interrupted) interruptInBackground(run);
  };
  res.once('close', onClose);

  let events = 0;
  let failure: string | null = null;
  try {
    // ENG-04: the frames arrive from the engine adapter already neutral. This loop no longer
    // maps anything — the mapping moved behind `@agent-workspace/engine`'s port, so this server
    // cannot put an engine-native event name on the wire because it never receives one.
    //
    // Three properties of the adapter's stream are relied on and not re-checked here, each one
    // asserted by the conformance kit instead (`@agent-workspace/engine/testing`): every name is
    // an `agent.*` name, so none can collide with a control-frame name and none is `error`
    // (R-13 finding 7, HTML §9.2); `engine` names the adapter that produced it; and `raw`
    // carries the engine-native message, capped, so a client that wants the original still has
    // it. One engine message may become several frames — an assistant turn with two tool calls
    // is three — and each gets its own monotonic `id`, because `id` is the resume cursor and a
    // cursor that named a message rather than a frame could not resume in the middle of one.
    for await (const frame of run.connection.frames) {
      events += 1;
      id += 1;
      await writeChunk(res, sseFrame(frame.frame, id, frame));
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    clearInterval(keepalive);
    res.off('close', onClose);
  }

  const { sessionId, sessionIdError } = await settleSessionId(run.connection);
  const summary = {
    runId: run.runId,
    // How many frames this run produced. Before ENG-04 this counted *engine messages*, because
    // the mapping from one message to its frames happened here; now it happens in the adapter,
    // and what this server can honestly count is what it wrote. The field keeps its name, and
    // the change in what it counts is stated on ENG-04's PR rather than left for a consumer to
    // notice: a run that made two tool calls now reports more events than it used to.
    events,
    interrupted: run.interrupted,
    sessionId,
    sessionIdError,
    /** ENG-04: which adapter version produced this run, for support and for the catalogue. */
    engineVersion: run.connection.engineVersion,
    // §14.9 calls a session that lives only inside the sandbox a release blocker, so the verdict
    // travels with the run rather than being inferred later from its absence.
    sessionDurability: run.connection.sessionDurability(),
    ...(failure === null ? {} : { message: failure }),
  };

  // Three terminal names, none of them `error` and none of them a name
  // `apps/web/server/runs/sse.ts` reserves for its own outward control frames (see the header).
  // `run-interrupted` is kept apart from `run-error` because a cancelled run is not a broken one,
  // and a relay that cannot tell them apart shows the user a failure they caused on purpose.
  //
  // `run.interrupted` is checked FIRST and unconditionally (ADR-0015): it is decided from the
  // positive fact this run already holds, not inferred from the shape `failure` happens to take.
  // A conformant `AgentConnection` (`packages/runtime/src/driver.ts`) is free to end its `events`
  // iterable cleanly on cancellation — no throw required — so nesting the interrupted check under
  // `failure === null ? … : …` reached it only when the connection *also* threw, and a clean-ending
  // one reported `run-done` for a run the caller had cancelled. See
  // `docs/adr/W1-RN-03-terminal-frame-name-is-decided-from-interrupted-first.md`.
  const name = run.interrupted ? 'run-interrupted' : failure === null ? 'run-done' : 'run-error';
  id += 1;
  await writeChunk(res, sseFrame(name, id, summary));
  res.end();
}

/**
 * Answer a run the engine refused, **before any output frame** (ENG-04's T2 invariant).
 *
 * A 200 SSE stream carrying exactly one `run-error`, and not a 4xx JSON body, for the reason
 * `docs/adr/W1-COMP-01-…` gives about this contract's terminal names: the control plane's relay
 * (`apps/web/server/runs/relay.ts`) reads a run's outcome off the stream's terminal frame, and a
 * refusal delivered as a status code is an outcome it has to learn about a second way. One
 * shape for "this run is over and here is why" is the whole reason the three terminal names
 * exist.
 *
 * `code` is on the frame beside `message` so a consumer branches on `engine_not_installed`
 * rather than pattern-matching a sentence. `events: 0` is stated rather than omitted: it is the
 * positive assertion that nothing was streamed before this, which is the invariant itself.
 */
async function streamEngineRefusal(
  res: ServerResponse,
  runId: string,
  code: string,
  message: string,
): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
  await writeChunk(res, 'retry: 3000\n\n');
  await writeChunk(
    res,
    sseFrame('run-error', 1, {
      runId,
      code,
      message,
      events: 0,
      interrupted: false,
      sessionId: null,
      sessionIdError: null,
      sessionDurability: {
        durable: false,
        reason: 'the run was refused before it started, so no session exists to be durable.',
      },
    }),
  );
  res.end();
}

async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  state: RunnerState,
  startAgent: RunnerAgentStarter,
): Promise<void> {
  const body = await readJsonObject(req);
  if (!body.ok) {
    sendError(res, body.status, body.error, body.message);
    return;
  }

  // Parse before you compare (ADR-0015). `startLocalAgent` parses again inside the SDK boundary;
  // doing it here as well is what turns a `ZodError` into a 400 with issues instead of a 500.
  const parsed = RunRequest.safeParse(body.value);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: 'invalid_run_request',
      message: 'the request body is not a valid RunRequest.',
      issues: parsed.error.issues,
    });
    return;
  }

  // Admission is synchronous (ENG-04 review): from the first check below to the reservation
  // after the last one there is no `await`, so two requests cannot both pass a check that only
  // one of them may pass. The reservation is taken *before* `startAgent` is awaited and released
  // on every path out of this function.
  if (state.admitted.has(parsed.data.runId)) {
    sendError(
      res,
      409,
      'run_in_flight',
      `this runner is already serving run ${parsed.data.runId}.`,
    );
    return;
  }
  // A container's workspace is provisioned per session — `cwd` is fixed to the session's own
  // directory (`apps/web/server/compose/run-request.ts`) precisely so a session's files persist
  // turn over turn. Two runs of the *same* session sharing that one directory concurrently is
  // never safe, no matter how much spare capacity `maxConcurrentRuns` reports: their hydrate,
  // run, and collect phases (`apps/web/server/runs/launcher.ts`) would race on identical paths.
  // `maxConcurrentRuns` bounds concurrency *across* sessions; same-session overlap is refused
  // outright rather than left to a filesystem race. See W1-RN-02's "one runtime per run" decision.
  for (const existing of state.admitted.values()) {
    if (existing.sessionId === parsed.data.sessionId) {
      sendError(
        res,
        409,
        'session_in_flight',
        `session ${parsed.data.sessionId} already has run ${existing.runId} in flight on this runtime; concurrent runs of the same session are not supported.`,
      );
      return;
    }
  }
  if (state.admitted.size >= state.maxConcurrentRuns) {
    sendError(
      res,
      429,
      'runner_capacity_exhausted',
      `this runner is serving its configured maximum of ${String(state.maxConcurrentRuns)} concurrent runs; retry when capacity is available.`,
    );
    return;
  }

  const admission: Admitted = {
    runId: parsed.data.runId,
    sessionId: parsed.data.sessionId,
    interruptRequested: false,
  };
  state.admitted.set(admission.runId, admission);
  try {
    let outcome: EngineStartOutcome;
    try {
      outcome = await startAgent(parsed.data);
    } catch (error) {
      // A throw out of `startAgent` is a programming fault, not a request this engine will not
      // run: every refusal the port can express arrives as `outcome.ok === false` below.
      // Answering 422 keeps the pre-ENG-04 behaviour for the one caller that still throws — the
      // Claude boundary's own translation refusals, which reach here through `start`.
      sendError(res, 422, 'run_rejected', error instanceof Error ? error.message : String(error));
      return;
    }
    if (!outcome.ok) {
      await streamEngineRefusal(res, parsed.data.runId, outcome.code, outcome.reason);
      return;
    }

    const run: InFlight = {
      runId: parsed.data.runId,
      sessionId: parsed.data.sessionId,
      connection: outcome.connection,
      interrupted: false,
    };
    state.runs.set(run.runId, run);
    // Cancelled while the engine was starting — by `/interrupt`, or by the client leaving, whose
    // `close` fired before `streamRun` could listen for it. Either way the run must not go on
    // spending with nobody reading it.
    if (admission.interruptRequested || res.destroyed) interruptInBackground(run);
    try {
      await streamRun(res, run);
    } finally {
      // A duplicate id is refused above, so identity still guards against a future refactor
      // that replaces an entry while an older stream is winding down.
      if (state.runs.get(run.runId) === run) state.runs.delete(run.runId);
    }
  } finally {
    if (state.admitted.get(admission.runId) === admission) state.admitted.delete(admission.runId);
  }
}

async function handleInterrupt(
  req: IncomingMessage,
  res: ServerResponse,
  state: RunnerState,
): Promise<void> {
  const body = await readJsonObject(req);
  if (!body.ok) {
    sendError(res, body.status, body.error, body.message);
    return;
  }
  const expectedRunId = body.value['runId'];
  if (typeof expectedRunId !== 'string' || expectedRunId.length === 0) {
    sendError(res, 400, 'invalid_interrupt_request', 'runId must be a non-empty string.');
    return;
  }
  const admission = state.admitted.get(expectedRunId);
  if (admission === undefined && state.admitted.size === 0) {
    // Not 200. Reporting success for an interrupt that interrupted nothing is the same shape of
    // lie as a gate that passes because it could not run.
    sendError(
      res,
      409,
      'no_run_in_flight',
      'there is no current run to interrupt on this runtime.',
    );
    return;
  }
  if (admission === undefined) {
    const active = [...state.admitted.keys()].sort();
    sendError(
      res,
      409,
      'run_mismatch',
      `the requested run ${expectedRunId} is not active; refusing to interrupt ${String(active.length)} unrelated active run(s).`,
    );
    return;
  }
  const run = state.runs.get(expectedRunId);
  if (run === undefined) {
    // Admitted, engine still starting: there is no connection to signal yet, so the request is
    // recorded and `handleRun` applies it the moment the connection exists.
    admission.interruptRequested = true;
  } else {
    run.interrupted = true;
    await run.connection.interrupt();
  }
  // The run's own SSE stream is where the cancellation becomes observable: it ends with a
  // `run-interrupted` frame. This response says only that the signal was raised.
  sendJson(res, 202, { interrupted: true, runId: expectedRunId });
}

// ── The server ──────────────────────────────────────────────────────────────────────────

/**
 * Start a run on whichever engine the request named — the registry path (ENG-04).
 *
 * This is the default {@link RunnerServerOptions.startAgent}, and it is the *only* place a run
 * meets an engine adapter. Everything before it is engine-neutral, and the one decision made
 * here is a table lookup in `./engines.ts`.
 */
async function startRegisteredAgent(request: RunRequestValue): Promise<EngineStartOutcome> {
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
};

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
  if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
    throw new Error('maxConcurrentRuns must be a positive safe integer.');
  }
  const state: RunnerState = { admitted: new Map(), runs: new Map(), maxConcurrentRuns };

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
        await handleRun(req, res, state, startAgent);
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
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const incoming of req) {
            const chunk: unknown = incoming;
            if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
              const bytes = Buffer.from(chunk);
              size += bytes.byteLength;
              if (size > MAX_FILE_ARCHIVE_BYTES) {
                sendError(
                  res,
                  413,
                  'archive_too_large',
                  `the workspace archive exceeds ${String(MAX_FILE_ARCHIVE_BYTES)} bytes.`,
                );
                return;
              }
              chunks.push(bytes);
            } else {
              throw new Error('request body produced a non-byte chunk');
            }
          }
          try {
            const files = await hydrateWorkspace(workspacePath, Buffer.concat(chunks));
            sendJson(res, 200, { hydrated: files });
          } catch (error) {
            sendError(
              res,
              400,
              'invalid_archive',
              error instanceof Error ? error.message : String(error),
            );
          }
          return;
        }
        if (method === 'GET') {
          try {
            const archive = await collectWorkspace(
              workspacePath,
              requestUrl.searchParams.getAll('path'),
            );
            res.writeHead(200, {
              'Content-Type': 'application/x-tar',
              'Cache-Control': 'no-store',
              'Content-Length': String(archive.byteLength),
            });
            res.end(Buffer.from(archive));
          } catch (error) {
            sendError(
              res,
              400,
              'invalid_file_request',
              error instanceof Error ? error.message : String(error),
            );
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
