import type { ServerResponse } from 'node:http';
import { RunRequest } from '@agent-workspace/run-protocol';
import { sendError } from './http-io.js';
import type { RunnerState } from './run-state.js';
import type { Admitted } from './run-state.js';

export function admitRun(
  res: ServerResponse,
  state: RunnerState,
  request: RunRequest,
): Admitted | undefined {
  // Admission is synchronous (ENG-04 review): from the first check below to the reservation
  // after the last one there is no `await`, so two requests cannot both pass a check that only
  // one of them may pass. The reservation is taken *before* `startAgent` is awaited and released
  // on every path out of this function.
  if (state.admitted.has(request.runId)) {
    sendError(res, 409, 'run_in_flight', `this runner is already serving run ${request.runId}.`);
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
    if (existing.sessionId === request.sessionId) {
      sendError(
        res,
        409,
        'session_in_flight',
        `session ${request.sessionId} already has run ${existing.runId} in flight on this runtime; concurrent runs of the same session are not supported.`,
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
    runId: request.runId,
    sessionId: request.sessionId,
    interruptRequested: false,
  };
  state.admitted.set(admission.runId, admission);
  return admission;
}
