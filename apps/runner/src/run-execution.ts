import { RunRequest, type RunFileReference } from '@agent-workspace/run-protocol';
import { skillInboxReferences, withoutSkills } from './resources.js';
import { resolveRunResources } from './run-resource-verification.js';
import { streamInterruptedBeforeStart } from './run-stream.js';
import type { Admitted } from './run-state.js';
import type { ServerResponse } from 'node:http';
import type { Logger } from '@agent-workspace/core/telemetry';
import { EngineRefusalError } from '@agent-workspace/engine';
import { sendError } from './http-io.js';
import { type ResolvedRunRequest } from './resources.js';
import type { EngineStartOutcome, RunnerAgentStarter } from './runtime.js';
import type { RunnerState } from './run-state.js';
import { streamEngineRefusal } from './run-stream.js';
import type { InFlight } from './run-state.js';
import { interruptInBackground } from './run-stream.js';
import { streamRun } from './run-stream.js';

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

type RunExecutionContext = {
  res: ServerResponse;
  state: RunnerState;
  admission: Admitted;
  startAgent: RunnerAgentStarter;
  log: Logger;
  forwardedTrace: Readonly<Record<string, string>>;
};

async function startAdmittedRun(
  input: RunExecutionContext & { request: ResolvedRunRequest },
): Promise<void> {
  const { res, state, admission, request, startAgent, log, forwardedTrace } = input;
  let outcome: EngineStartOutcome;
  try {
    outcome = await startAgent(withTraceHeaders(request, forwardedTrace));
  } catch (error) {
    // An adapter that can only refuse while translating its compiled options in `start` (the
    // Claude boundary) throws a typed refusal before any frame: it is answered like a compile
    // refusal, with its own code and message.
    if (error instanceof EngineRefusalError) {
      await streamEngineRefusal(res, request.runId, error.code, error.message);
      return;
    }
    // Anything else is a fault, not a request this engine will not run. Materializing the run's
    // resources throws here too, and its messages name absolute host paths, so the message is
    // logged, never answered.
    log.error('run start failed', { runId: admission.runId, error: String(error) });
    sendError(res, 422, 'run_rejected', 'the runtime could not start this run');
    return;
  }
  if (!outcome.ok) {
    await streamEngineRefusal(res, request.runId, outcome.code, outcome.reason);
    return;
  }

  const run: InFlight = {
    runId: request.runId,
    sessionId: request.sessionId,
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
}

export async function continueAdmittedRun(
  input: RunExecutionContext & { request: RunRequest },
): Promise<void> {
  const { res, admission, request: wireRequest, log } = input;
  // Hashing and hydration hold the admission slot until they finish.
  const references = [
    ...(wireRequest.resources?.files ?? []).filter(
      (file): file is RunFileReference => 'sha256' in file,
    ),
    ...skillInboxReferences(wireRequest.resources?.skills ?? []),
  ];
  const resolvedRequest =
    references.length === 0
      ? withoutSkills(wireRequest)
      : await resolveRunResources(res, wireRequest, log, references);
  if (resolvedRequest === undefined) return;
  // Cancelled while hashing: starting an engine only to interrupt it at once spends for nothing.
  if (res.destroyed) return;
  if (admission.interruptRequested) {
    await streamInterruptedBeforeStart(res, wireRequest.runId);
    return;
  }
  await startAdmittedRun({ ...input, request: resolvedRequest });
}
