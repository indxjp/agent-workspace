import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@agent-workspace/core/telemetry';
import { RunRequest } from '@agent-workspace/run-protocol';
import { readJsonObject, sendError, sendJson } from './http-io.js';
import type { RunnerAgentStarter } from './runtime.js';
import type { RunnerState } from './run-state.js';
import { admitRun } from './run-admission.js';
import { continueAdmittedRun } from './run-execution.js';

export type { RunnerState } from './run-state.js';

export { handleInterrupt } from './run-interrupt.js';

/** Admit a validated request, hold its slot through execution, and release it on every exit. */
export async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  context: Readonly<{
    state: RunnerState;
    startAgent: RunnerAgentStarter;
    log: Logger;
    forwardedTrace?: Readonly<Record<string, string>>;
  }>,
): Promise<void> {
  const { state, startAgent, log, forwardedTrace = {} } = context;
  const request = await readRunRequest(req, res);
  if (request === undefined) return;
  const admission = admitRun(res, state, request);
  if (admission === undefined) return;
  log.info('run admitted', {
    runId: admission.runId,
    sessionId: admission.sessionId,
    engine: request.engine,
  });
  try {
    await continueAdmittedRun({ res, state, admission, request, startAgent, log, forwardedTrace });
  } finally {
    if (state.admitted.get(admission.runId) === admission) state.admitted.delete(admission.runId);
  }
}

async function readRunRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RunRequest | undefined> {
  const body = await readJsonObject(req);
  if (!body.ok) {
    sendError(res, body.status, body.error, body.message);
    return;
  }

  // Boundary validation answers malformed requests with structured issues before admission.
  const parsed = RunRequest.safeParse(body.value);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: 'invalid_run_request',
      message: 'the request body is not a valid RunRequest.',
      issues: parsed.error.issues,
    });
    return;
  }

  return parsed.data;
}
