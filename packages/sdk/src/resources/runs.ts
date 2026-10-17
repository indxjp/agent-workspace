import type { RunFeedbackRequest } from '@indx-workspace/contracts/feedback';
import {
  InterruptRunResponseSchema,
  RevokeRunTokensResponseSchema,
  RunListResponseSchema,
  RunResponseSchema,
  StartRunResponseSchema,
  isTerminalRunStatus,
  parseRunFailure,
  runListSearchParams,
  type RevokeRunTokensResponse,
  type RunFailure,
  type RunListQuery,
  type RunListResponse,
  type RunResource,
  type StartRunResponse,
} from '@indx-workspace/contracts/runs';
import { z } from 'zod';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { classifyRunEventFrame, type RunEventFrame } from '../events/run-events.js';
import { readSseFrames } from '../events/sse.js';
import { segment, type HttpClient, type RequestOptions } from '../http.js';

/**
 * Why a run failed, as a code a program can branch on and the safe message beside it (issue
 * #393), or `null` for a run that has not failed.
 *
 * A run refused only once it was being composed — its runtime profile or model went away between
 * the start and the launch — stores `error` as `<code>: <message>` with one of the codes
 * `runs.start` itself refuses with (`RUN_START_PROBLEM_CODES`); this reads that code back. A
 * failure from inside the sandbox carries no code, and `code` is then `null`.
 */
export function runFailure(run: RunResource): RunFailure | null {
  if (run.status !== 'failed') return null;
  return parseRunFailure(run.error) ?? { code: null, message: 'the run failed without a reason' };
}

/** What a caller supplies to start a run; the wire body is derived from it. */
export interface StartRunInput {
  readonly prompt: string;
  /** Continue an existing session, or omit to start one. */
  readonly sessionId?: string | null;
  /** Override the agent's model for this run only. A connection and a model, together. */
  readonly modelOverride?: { readonly connectionId: string; readonly model: string } | null;
  /**
   * Run a new session on this numbered version of the agent instead of the one `local` points at.
   * An unknown number is `404 agent_version_not_found`; with `sessionId` it is refused.
   */
  readonly version?: number;
}

export interface RunEventsOptions extends RequestOptions {
  /** Resume after this event id (`Last-Event-ID`); omit to replay from the beginning. */
  readonly after?: string | null;
}

export interface FollowRunOptions extends RunEventsOptions {
  /**
   * How many reconnects in a row may fail to deliver a new event before `follow` gives up; a
   * connection that delivers one resets the count. Default 5.
   */
  readonly maxReconnects?: number;
  /** Pause between reconnects, in milliseconds. Default 3000, the server's own `retry:` value. */
  readonly reconnectDelayMs?: number;
}

/** How a followed stream ended, with the last cursor seen so a caller can continue on its own. */
export interface RunStreamEnd {
  readonly lastEventId: string | null;
}

const SSE_MEDIA_TYPE = 'text/event-stream';
const NoContentSchema = z.null();

/** An abort while the follower waits to reconnect is still one of the three typed failures. */
function abortedWhileWaiting(signal: AbortSignal): TransportError {
  return new TransportError({ operation: 'runs.follow', aborted: true, cause: signal.reason });
}

/**
 * A failure `follow` reconnects from: a dropped connection, or a 5xx or 429 answer to the
 * reconnect, which is what a restarting or overloaded server gives. `aborted` on a
 * TransportError is also true for a `timeoutMs` deadline (no headers in time), which is a
 * connection that failed like any other; only the caller's own signal ends the follow.
 */
function isDrop(error: unknown): boolean {
  if (error instanceof TransportError) return true;
  return error instanceof ApiProblemError && (error.status >= 500 || error.status === 429);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortedWhileWaiting(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      if (signal !== undefined) reject(abortedWhileWaiting(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `/api/runs/**` and `POST /api/agents/:id/runs` — spec §19 and §34. */
export class RunsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /**
   * Queue a run. The answer is a `202`: the run exists and is `queued`, and `events` is where to
   * stream it from — {@link events} and {@link follow} take the returned `run.id`.
   *
   * Throws {@link ApiProblemError}. Three of its codes are `409`s and mean different things:
   *
   * - `session_not_usable` — the `sessionId` is not one this agent may run; omit it to start a new
   *   session;
   * - `session_busy` — the session already has a `queued` or `running` run; wait for it to end or
   *   interrupt it, then send again. **No run is created**;
   * - `session_engine_mismatch` — the session is pinned to another engine than the agent's current
   *   `policy.engine` (ADR-0065 D8). **No run is created**, and the session keeps its engine: a
   *   session's history belongs to the engine that produced it, so it is never re-pinned. Omit
   *   `sessionId` to start a new session on the new engine.
   *
   * The `422`s of `RUN_START_PROBLEM_CODES` (issue #393) name the configuration a run is missing,
   * and none of them creates a run either: `agent_runtime_profile_missing`,
   * `model_connection_unresolved`, `model_connection_failed`, `model_unavailable` and
   * `model_credential_rejected`. Five more `RUN_START_PROBLEM_CODES` are judged only when the run
   * launches, so the start answers `202` and the run fails with the code, read through
   * {@link runFailure}: `network_policy_unenforceable`, `run_deadline_exceeds_host`,
   * `runtime_connection_missing`, `runtime_connection_credential_unavailable` and
   * `runtime_not_verified`. A run that fails
   * one of the first five checks after it was queued reports its code through {@link runFailure}
   * too.
   */
  public async start(
    agentId: string,
    input: StartRunInput,
    options: RequestOptions = {},
  ): Promise<StartRunResponse> {
    return this.#http.json({
      operation: 'runs.start',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/runs`,
      body: {
        prompt: input.prompt,
        sessionId: input.sessionId ?? null,
        modelConnectionId: input.modelOverride?.connectionId ?? null,
        model: input.modelOverride?.model ?? null,
        ...(input.version === undefined ? {} : { version: input.version }),
      },
      expect: [202],
      schema: StartRunResponseSchema,
      signal: options.signal,
    });
  }

  public async get(runId: string, options: RequestOptions = {}): Promise<RunResource> {
    const response = await this.#http.json({
      operation: 'runs.get',
      method: 'GET',
      path: `/api/runs/${segment(runId)}`,
      expect: [200],
      schema: RunResponseSchema,
      signal: options.signal,
    });
    return response.run;
  }

  /**
   * Stop a run this caller may run (issue #235, S-14). Answers with the run at its new terminal
   * status. `409` (`ApiProblemError` with code `run_not_interruptible`) when the run is already
   * terminal.
   */
  public async interrupt(runId: string, options: RequestOptions = {}): Promise<RunResource> {
    const response = await this.#http.json({
      operation: 'runs.interrupt',
      method: 'POST',
      path: `/api/runs/${segment(runId)}/interrupt`,
      expect: [200],
      schema: InterruptRunResponseSchema,
      signal: options.signal,
    });
    return response.run;
  }

  /**
   * Revoke this run's gateway tokens (issue #235, S-15): one, or every active token when
   * `tokenId` is omitted. The named successor of the deprecated `POST /api/runs/:id`.
   */
  public async revokeTokens(
    runId: string,
    input: { readonly tokenId?: string | null } = {},
    options: RequestOptions = {},
  ): Promise<RevokeRunTokensResponse> {
    return this.#http.json({
      operation: 'runs.revokeTokens',
      method: 'POST',
      path: `/api/runs/${segment(runId)}/revoke-tokens`,
      body: { tokenId: input.tokenId ?? null },
      expect: [200],
      schema: RevokeRunTokensResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Rate a run's answer thumbs-up or -down, with an optional comment (`POST /api/runs/:id/feedback`,
   * issue #665) — what the widget's rating buttons send. `client.agents.feedback.list` reads the
   * ratings back, and `aw eval add-case` turns a thumbs-down into an evaluation case.
   *
   * Throws {@link ApiProblemError}: `400 invalid_run_id`, `400 invalid_body` (a blank comment or one
   * over `RUN_FEEDBACK_COMMENT_MAX_LENGTH`), `404 run_not_found`, `503 run_api_not_configured`.
   */
  public async rate(
    runId: string,
    input: RunFeedbackRequest,
    options: RequestOptions = {},
  ): Promise<void> {
    await this.#http.json({
      operation: 'runs.feedback',
      method: 'POST',
      path: `/api/runs/${segment(runId)}/feedback`,
      body: input,
      expect: [204],
      schema: NoContentSchema,
      signal: options.signal,
    });
  }

  /** One page of the workspace's run history, newest first. Pass `nextCursor` back as `cursor`. */
  public list(query: RunListQuery = {}, options: RequestOptions = {}): Promise<RunListResponse> {
    return this.#http.json({
      operation: 'runs.list',
      method: 'GET',
      path: '/api/runs',
      query: runListSearchParams(query),
      expect: [200],
      schema: RunListResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * One connection to `GET /api/runs/:id/events`, yielding classified frames until the server's
   * `done` frame. If the connection ends or breaks before `done` — a clean close, a reset, an
   * abort — a {@link TransportError} is thrown; the last durable event id seen is available
   * through {@link follow}, which handles that case. A `200` that is not an event stream is a
   * {@link ContractViolationError}: the server broke its own contract, and no retry will mend it.
   */
  public async *events(
    runId: string,
    options: RunEventsOptions = {},
  ): AsyncGenerator<RunEventFrame, RunStreamEnd, void> {
    const response = await this.#http.send({
      operation: 'runs.events',
      method: 'GET',
      path: `/api/runs/${segment(runId)}/events`,
      expect: [200],
      signal: options.signal,
      headers: {
        accept: SSE_MEDIA_TYPE,
        ...(options.after === undefined || options.after === null
          ? {}
          : { 'last-event-id': options.after }),
      },
    });
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim();
    if (mediaType !== SSE_MEDIA_TYPE || response.body === null) {
      // The body is open and unwanted: release the connection before refusing the response.
      await response.body?.cancel().catch(() => undefined);
      throw new ContractViolationError({
        operation: 'runs.events',
        status: response.status,
        issues: [
          `the events endpoint answered with ${mediaType === undefined || mediaType === '' ? 'no content type' : mediaType} instead of ${SSE_MEDIA_TYPE}`,
        ],
      });
    }
    let lastEventId: string | null = options.after ?? null;
    try {
      for await (const raw of readSseFrames(response.body, options.signal)) {
        const frame = classifyRunEventFrame(raw);
        if (frame.kind === 'done') return { lastEventId };
        if ((frame.kind === 'run-status' || frame.kind === 'runtime') && frame.id !== null) {
          lastEventId = frame.id === '' ? null : frame.id;
        }
        yield frame;
      }
    } catch (cause) {
      // Drift is not a dropped connection: a ContractViolationError must not be retried.
      if (cause instanceof ContractViolationError) throw cause;
      // The body failed mid-stream — a reset, a proxy closing, `fetch` raising `terminated` —
      // which is the failure `follow` reconnects from, so it must arrive typed.
      throw new TransportError({
        operation: 'runs.events',
        aborted: options.signal?.aborted === true,
        cause,
      });
    }
    // The body ended and no `done` frame was ever seen: the server writes `done` from every exit
    // path except a mid-stream throw, so this is a connection closed from outside the contract.
    throw new TransportError({
      operation: 'runs.events',
      aborted: options.signal?.aborted === true,
      cause: new Error(
        `the event stream ended before a "done" frame arrived (last event id ${lastEventId ?? 'none'})`,
      ),
    });
  }

  /**
   * {@link events}, resuming with `Last-Event-ID` when a connection drops before `done`. A
   * `stream-reset` frame is yielded as-is: the server could not serve the cursor, and a consumer
   * that renders a transcript must discard what it has. Aborting `signal` ends the stream with a
   * {@link TransportError} whose `aborted` is `true`, like every other operation; catch it, or
   * return early yourself — stopping iteration early closes the connection either way.
   */
  public async *follow(
    runId: string,
    options: FollowRunOptions = {},
  ): AsyncGenerator<RunEventFrame, RunStreamEnd, void> {
    const maxReconnects = options.maxReconnects ?? 5;
    const reconnectDelayMs = options.reconnectDelayMs ?? 3000;
    let after = options.after ?? null;
    let reconnects = 0;
    for (;;) {
      let lastSeen = after;
      try {
        const stream = this.events(runId, { ...options, after });
        try {
          for (;;) {
            const next = await stream.next();
            if (next.done) return next.value;
            const frame = next.value;
            if ((frame.kind === 'run-status' || frame.kind === 'runtime') && frame.id !== null) {
              lastSeen = frame.id === '' ? null : frame.id;
            }
            yield frame;
          }
        } finally {
          // A consumer that stops iterating this generator early resumes it here with a return
          // completion; closing the inner one is what cancels the response body.
          await stream.return({ lastEventId: lastSeen });
        }
      } catch (error) {
        if (options.signal?.aborted === true || !isDrop(error)) throw error;
        // The budget is for consecutive failures: a connection that moved the cursor resets it.
        if (lastSeen !== after) reconnects = 0;
        if (reconnects >= maxReconnects) throw error;
        reconnects += 1;
        after = lastSeen;
        const retryAfterSeconds = error instanceof ApiProblemError ? error.retryAfterSeconds : null;
        await delay(
          retryAfterSeconds === null ? reconnectDelayMs : retryAfterSeconds * 1000,
          options.signal,
        );
      }
    }
  }

  /**
   * Follow the stream to its end, then read the run's settled record. The convenience a backend
   * wants when it does not render events: start, wait, read the outcome.
   */
  public async waitForOutcome(runId: string, options: FollowRunOptions = {}): Promise<RunResource> {
    const stream = this.follow(runId, options);
    for (;;) {
      const next = await stream.next();
      if (next.done) break;
    }
    const run = await this.get(runId, options);
    if (!isTerminalRunStatus(run.status)) {
      // The store writes the terminal status before the stream's last frame, so a live status
      // after `done` is the platform contradicting its own contract, not a network condition.
      throw new ContractViolationError({
        operation: 'runs.waitForOutcome',
        status: 200,
        issues: [`the stream ended but run ${runId} still reports ${run.status}`],
      });
    }
    return run;
  }
}
