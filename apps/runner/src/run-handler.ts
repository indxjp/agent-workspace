import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Logger } from '@agent-workspace/core/telemetry';
import { RunRequest, type RunFileReference } from '@agent-workspace/run-protocol';

import { loadEngine } from './engines.js';
import {
  readJsonObject,
  SSE_HEADERS,
  sendError,
  sendJson,
  sseFrame,
  writeChunk,
} from './http-io.js';
import {
  readSkillInbox,
  removeSkillInbox,
  skillInboxReferences,
  withoutSkills,
  type ResolvedRunRequest,
} from './resources.js';
import type { EngineStartOutcome, RunnerAgentConnection, RunnerAgentStarter } from './runtime.js';
import { verifyReferencedFiles } from './verify-files.js';

/**
 * R-13's inference, restated where it is used: shorter than the smallest idle timeout on any hop.
 * nginx `proxy_read_timeout` and ALB `idle_timeout` both default to 60 s; 15 s is a 4× margin.
 * The probes bracketed it (1 s survived 620 s, 70 s of silence died at ~60 s) without running it.
 */
const KEEPALIVE_MS = 15_000;

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

export type RunnerState = {
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
  //
  // A run that stopped for want of approval (ADR-0145 D5) travels as `run-error`, the one terminal
  // name the relay reads as "this run did not finish", with `code`/`outcome` saying why. The
  // message is fixed and never repeats the call's arguments; they are only in `approvalRequest`.
  // The control plane's relay turns it into the public `agent.approval.requested` frame.
  const approval =
    run.interrupted || failure !== null ? null : (run.connection.approvalRequest?.() ?? null);
  const name =
    approval !== null
      ? 'run-error'
      : run.interrupted
        ? 'run-interrupted'
        : failure === null
          ? 'run-done'
          : 'run-error';
  id += 1;
  await writeChunk(
    res,
    sseFrame(
      name,
      id,
      approval === null
        ? summary
        : {
            ...summary,
            code: 'awaiting_approval',
            outcome: 'awaiting_approval',
            approvalRequest: approval,
            message: 'awaiting_approval: the run stopped for a person to approve a tool call.',
          },
    ),
  );
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

/** Answer a run interrupted before its engine started with the same terminal frame a started one gets. */
async function streamInterruptedBeforeStart(res: ServerResponse, runId: string): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
  await writeChunk(res, 'retry: 3000\n\n');
  await writeChunk(
    res,
    sseFrame('run-interrupted', 1, {
      runId,
      events: 0,
      interrupted: true,
      sessionId: null,
      sessionIdError: null,
      sessionDurability: {
        durable: false,
        reason: 'the run was interrupted before it started, so no session exists to be durable.',
      },
    }),
  );
  res.end();
}

/**
 * The Claude CLI's extra-request-headers variable: newline-separated `Name: value` lines it adds
 * to every model call, which go to the run's gateway (`ANTHROPIC_BASE_URL`).
 */
const CUSTOM_HEADERS_ENV = 'ANTHROPIC_CUSTOM_HEADERS';

/**
 * `request` with the caller's validated W3C trace headers added to the engine's model calls, so
 * the gateway joins the run's trace (F-04). `forwardedTrace` comes from `traceHeaders`, which
 * admits no CR/LF, so it cannot add a header line of its own. Headers the run already sets are kept.
 * ponytail: only the Claude CLI reads this variable; another engine's model client needs its own
 * header hook before its gateway calls join the trace.
 */
function withTraceHeaders(
  request: ResolvedRunRequest,
  forwardedTrace: Readonly<Record<string, string>>,
): ResolvedRunRequest {
  const lines = Object.entries(forwardedTrace).map(([name, value]) => `${name}: ${value}`);
  if (lines.length === 0) return request;
  // `RunEnvironment` refuses two names that differ only in case, so a run that already set the
  // variable under another spelling has its own key extended rather than a second one added.
  const key =
    Object.keys(request.env).find((name) => name.toUpperCase() === CUSTOM_HEADERS_ENV) ??
    CUSTOM_HEADERS_ENV;
  const existing = request.env[key];
  if (existing !== undefined && existing !== '') lines.unshift(existing);
  return { ...request, env: { ...request.env, [key]: lines.join('\n') } };
}

export async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  state: RunnerState,
  startAgent: RunnerAgentStarter,
  log: Logger,
  forwardedTrace: Readonly<Record<string, string>> = {},
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
  log.info('run admitted', {
    runId: admission.runId,
    sessionId: admission.sessionId,
    engine: parsed.data.engine,
  });
  try {
    // Inside the admission window, so hashing a large grant counts against `maxConcurrentRuns`.
    let request: ResolvedRunRequest | undefined;
    const skillReferences = parsed.data.resources?.skills ?? [];
    const references = [
      ...(parsed.data.resources?.files ?? []).filter(
        (file): file is RunFileReference => 'sha256' in file,
      ),
      ...skillInboxReferences(skillReferences),
    ];
    if (references.length > 0) {
      // The engine's protected configuration directory is the writer's guard too; without the
      // engine there is no guard to apply, and the run would be refused at start anyway.
      const lookup = await loadEngine(parsed.data.engine);
      if (!lookup.ok) {
        await streamEngineRefusal(res, parsed.data.runId, lookup.code, lookup.reason);
        return;
      }
      const guard = lookup.engine.protectedConfigDirectory;
      let inboxLeft = false;
      try {
        const verification = await verifyReferencedFiles(parsed.data.cwd, guard, references);
        if (!verification.ok) {
          sendError(
            res,
            422,
            verification.code,
            `granted file "${verification.path}" did not arrive intact`,
          );
          return;
        }
        try {
          request = await readSkillInbox(parsed.data, guard);
        } catch (error) {
          // The message can name an absolute host path; it is logged, never answered.
          log.error('skill inbox read failed after verification', { error: String(error) });
          sendError(res, 422, 'run_file_missing', 'a granted skill file did not arrive intact');
          return;
        }
      } finally {
        if (skillReferences.length > 0) {
          try {
            removeSkillInbox(parsed.data.cwd, guard);
          } catch (error) {
            // The message can name an absolute host path; it is logged, never answered.
            log.error('skill inbox removal failed', { error: String(error) });
            inboxLeft = true;
          }
        }
      }
      // Reached only when nothing was answered above: an agent must never see a leftover inbox.
      if (inboxLeft) {
        sendError(res, 500, 'internal_error', 'the granted skill files could not be cleared');
        return;
      }
    }
    // Every skill reference names a file, so a request that grants skills has read the inbox above.
    request ??= withoutSkills(parsed.data);
    // Cancelled while hashing: starting an engine only to interrupt it at once spends for nothing.
    if (res.destroyed) return;
    if (admission.interruptRequested) {
      await streamInterruptedBeforeStart(res, parsed.data.runId);
      return;
    }
    let outcome: EngineStartOutcome;
    try {
      outcome = await startAgent(withTraceHeaders(request, forwardedTrace));
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

export async function handleInterrupt(
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
