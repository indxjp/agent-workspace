import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonObject, sendError, sendJson } from './http-io.js';
import type { RunnerState } from './run-state.js';

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
