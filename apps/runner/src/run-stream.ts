import type { ServerResponse } from 'node:http';
import { SSE_HEADERS, sseFrame, writeChunk } from './http-io.js';
import type { RunnerAgentConnection } from './runtime.js';
import type { InFlight } from './run-state.js';

/**
 * R-13's inference, restated where it is used: shorter than the smallest idle timeout on any hop.
 * nginx `proxy_read_timeout` and ALB `idle_timeout` both default to 60 s; 15 s is a 4× margin.
 * The probes bracketed it (1 s survived 620 s, 70 s of silence died at ~60 s) without running it.
 */
const KEEPALIVE_MS = 15_000;

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
export function interruptInBackground(run: InFlight): void {
  run.interrupted = true;
  run.connection.interrupt().catch((error: unknown) => {
    process.stderr.write(
      `runner: interrupting run ${run.runId} failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
}

export async function streamRun(res: ServerResponse, run: InFlight): Promise<void> {
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

  await finishRunStream(res, run, { events, id, failure });
}

async function finishRunStream(
  res: ServerResponse,
  run: InFlight,
  result: { events: number; id: number; failure: string | null },
): Promise<void> {
  const { events, failure } = result;
  const { sessionId, sessionIdError } = await settleSessionId(run.connection);
  const summary = {
    runId: run.runId,
    // Count neutral frames, each of which owns its resume cursor.
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

  // Cancellation wins even when the adapter ends cleanly; approval is queried only on success.
  // Runner terminal names remain distinct from the control plane's outward SSE controls.
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
  const id = result.id + 1;
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
export async function streamEngineRefusal(
  res: ServerResponse,
  runId: string,
  code: string,
  message: string,
): Promise<void> {
  await writeTerminalOnly(res, 'run-error', {
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
  });
}

/** Answer a run interrupted before its engine started with the same terminal frame a started one gets. */
export async function streamInterruptedBeforeStart(
  res: ServerResponse,
  runId: string,
): Promise<void> {
  await writeTerminalOnly(res, 'run-interrupted', {
    runId,
    events: 0,
    interrupted: true,
    sessionId: null,
    sessionIdError: null,
    sessionDurability: {
      durable: false,
      reason: 'the run was interrupted before it started, so no session exists to be durable.',
    },
  });
}

async function writeTerminalOnly(
  res: ServerResponse,
  name: 'run-error' | 'run-interrupted',
  summary: Record<string, unknown>,
): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
  await writeChunk(res, 'retry: 3000\n\n');
  await writeChunk(res, sseFrame(name, 1, summary));
  res.end();
}
