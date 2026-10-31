import type { RunFeedbackRequest } from '@indx-workspace/contracts/feedback';
import { FileListResponseSchema, type FileResource } from '@indx-workspace/contracts/files';
import {
  InterruptRunResponseSchema,
  RevokeRunTokensResponseSchema,
  RunApprovalResponseSchema,
  RunListResponseSchema,
  RunResponseSchema,
  StartRunResponseSchema,
  isStoppedRunStatus,
  parseRunFailure,
  runListSearchParams,
  type RevokeRunTokensResponse,
  type RunApprovalResponse,
  type RunFailure,
  type RunListQuery,
  type RunListResponse,
  type RunResource,
  type StartRunResponse,
} from '@indx-workspace/contracts/runs';
import { z } from 'zod';

import {
  ApiProblemError,
  ContractViolationError,
  InvalidArgumentError,
  TransportError,
} from '../errors.js';
import { classifyRunEventFrame, type RunEventFrame } from '../events/run-events.js';
import { readSseStream } from '../events/sse.js';
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

export function wireOutputSchema(
  schema: z.ZodType | Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!(schema instanceof z.ZodType)) return schema;
  try {
    return z.toJSONSchema(schema, { target: 'draft-2020-12' });
  } catch (cause) {
    throw new InvalidArgumentError({
      code: 'unconvertible_output_schema',
      message:
        'outputSchema cannot be sent as JSON Schema: it holds a Zod type with no JSON Schema form. Pass a JSON Schema object instead.',
      cause,
    });
  }
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
  /**
   * Workspace files the run receives read-only, by the `id` `files.list` returns: one to ten,
   * no repeats. An id the caller cannot read, another workspace's, or one that does not exist is
   * `404 file_not_found`, the same answer for each; an agent without the `readFiles` permission
   * is `422 run_attachments_unreadable`; over 10 MiB a file, more than 20 attachments (a folder
   * counts as one) or 50 MiB in total (the session's earlier uploads count) is
   * `422 run_attachments_too_large`. A read grant removes the shell from the run. An audio file
   * (flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm) is transcribed into the run's first turn
   * when the run's model connection is an `openai` one, and is `422 run_attachments_untranscribable`
   * on any other provider.
   */
  readonly attachments?: readonly { readonly fileId: string }[];
  /**
   * Ask for an answer that matches this schema (ADR-0143): a Zod schema, sent as JSON Schema
   * 2020-12, or a JSON Schema object as is. Its root must be an object. Refused `400 invalid_body`
   * when it is over a limit, and `422 engine_capability_unsupported` when the agent's engine
   * cannot produce structured output; neither creates a run. Read the answer with
   * {@link RunsClient.result}.
   */
  readonly outputSchema?: z.ZodType | Readonly<Record<string, unknown>>;
  /**
   * The person this run acts for (ADR-0142 D2): it becomes the `sub` of the identity assertion
   * every opted-in connector receives. Only an API-key caller may set it; any other caller is
   * `403 run_subject_forbidden`. A connector verifies the assertion with `verifyIdentity`.
   */
  readonly subject?: string;
  /**
   * Narrow the run's file grants (ADR-0147): workspace paths, files or folders, one to 100, each
   * inside what the agent is granted. Built-in `search_files` and the files the sandbox receives
   * cover only these. A path the agent is not granted, a parent of a granted file, or any path
   * when the agent has no files fails the run with `403 run_file_scope_not_granted`, read
   * through {@link runFailure}. Omit it to keep all the agent's grants; a continuation after an
   * approval keeps the scope of the run it continues.
   */
  readonly fileScope?: readonly string[];
  /**
   * Sent as the `Idempotency-Key` header (ADR-0151): a start sent again with the same key and the
   * same input answers `202` with the run the first one started, whatever its status, instead of
   * starting another. Use one key per logical start and reuse it when you retry that start. The same
   * key with a different input is `409 run_idempotency_conflict`; a blank key or one over 255
   * characters is `400 invalid_idempotency_key`. A key is scoped to the caller and never freed.
   */
  readonly idempotencyKey?: string;
}

/** What {@link RunsClient.result} returns: the settled run, its prose and its structured answer. */
export interface RunResult<Output> {
  readonly run: RunResource;
  /** The run's answer as text; `null` unless the run `completed`. */
  readonly text: string | null;
  /** The structured answer; `null` unless the run `completed` with one. */
  readonly output: Output | null;
}

export interface RunResultOptions<Schema extends z.ZodType | undefined> extends FollowRunOptions {
  /** Validate the structured answer against this and return it typed. */
  readonly schema?: Schema;
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
  /**
   * The base pause before a reconnect, in milliseconds, until the stream sends a `retry:` value;
   * from then on that value is the base (issue #250, K-3). Default 3000, the server's own `retry:`.
   * The n-th reconnect in a row waits a uniform random time between half and all of
   * `min(maxReconnectDelayMs, base × 2^(n−1))`. A non-negative finite number no larger than
   * `maxReconnectDelayMs`; anything else throws a `TypeError` before the first request.
   */
  readonly reconnectDelayMs?: number;
  /**
   * The ceiling of the reconnect backoff, in milliseconds; a `retry:` above it is capped. Default
   * 30000. A non-negative finite number at least `reconnectDelayMs`, so a ceiling under 3000 needs
   * a `reconnectDelayMs` too; anything else throws a `TypeError` before the first request. A
   * `429` or `5xx` that names `Retry-After` is waited exactly, past this ceiling.
   */
  readonly maxReconnectDelayMs?: number;
}

/** How a followed stream ended, with the last cursor seen so a caller can continue on its own. */
export interface RunStreamEnd {
  readonly lastEventId: string | null;
}

const SSE_MEDIA_TYPE = 'text/event-stream';

/** A file a run left behind: the files resource, plus its name relative to the run's outputs. */
export type RunOutputFile = FileResource & {
  /** The path under the run's `outputs/` directory, for example `BRK-1101.dxf`. */
  readonly name: string;
};

// Where the server collects a run's files: `OUTPUTS_PREFIX` in
// apps/web/server/compose/workspace-lifecycle.ts.
const outputsPath = (runId: string): string => `runs/${segment(runId)}/outputs`;
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

const DEFAULT_RECONNECT_DELAY_MS = 3000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

/** The reconnect schedule's two bounds, checked before `follow` sends anything (§5.12, K-3). */
function reconnectBounds(options: FollowRunOptions): {
  readonly base: number;
  readonly cap: number;
} {
  const base = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const cap = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
  for (const [name, ms] of [
    ['reconnectDelayMs', base],
    ['maxReconnectDelayMs', cap],
  ] as const) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new TypeError(
        `follow ${name} must be a non-negative finite number (got ${String(ms)})`,
      );
    }
  }
  if (base > cap) {
    throw new TypeError(
      `follow reconnectDelayMs (${String(base)}) must not exceed maxReconnectDelayMs (${String(cap)})`,
    );
  }
  return { base, cap };
}

/**
 * The pause before the `attempt`-th consecutive reconnect (§5.12, K-3): `d = min(cap, base ×
 * 2^(attempt−1))`, then uniform in `[d / 2, d]` so followers dropped together do not return
 * together.
 */
function backoffPause(base: number, cap: number, attempt: number): number {
  const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/** The resume cursor a frame moves to, or `undefined` for a frame that does not move it. */
function cursorOf(frame: RunEventFrame): string | null | undefined {
  if (
    (frame.kind === 'run-status' || frame.kind === 'run-warning' || frame.kind === 'runtime') &&
    frame.id !== null
  ) {
    return frame.id === '' ? null : frame.id;
  }
  return undefined;
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
   * `model_connection_unresolved`, `model_connection_failed`, `model_unavailable`,
   * `model_credential_rejected` and `run_files_too_large` (the run's granted files, skill files and
   * attachments total more than 128 MiB; the message names the total and the limit). Seven more
   * `RUN_START_PROBLEM_CODES` are judged only when the run launches, so the start answers `202` and
   * the run fails with the code, read through {@link runFailure}: `network_policy_unenforceable`,
   * `run_deadline_exceeds_host`, `runtime_connection_missing`,
   * `runtime_connection_credential_unavailable`, `runtime_not_verified`,
   * `run_file_scope_not_granted` and `run_storage_grant_unavailable` (a granted storage
   * connection's folder cannot be delivered). A run whose granted file's stored bytes do not match their
   * checksum fails with `run_file_corrupt` the same way. A run that fails one of the first six
   * checks after it was queued (its configuration changed in between) reports its code through
   * {@link runFailure} too.
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
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.fileScope === undefined ? {} : { fileScope: [...input.fileScope] }),
        ...(input.attachments === undefined
          ? {}
          : { attachments: input.attachments.map(({ fileId }) => ({ fileId })) }),
        ...(input.outputSchema === undefined
          ? {}
          : { outputSchema: wireOutputSchema(input.outputSchema) }),
      },
      ...(input.idempotencyKey === undefined
        ? {}
        : { headers: { 'idempotency-key': input.idempotencyKey } }),
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
   * Approve the tool call a run paused on (`POST /api/runs/:id/approval`, ADR-0145). The decision
   * starts a continuation run in the same session, which may make exactly that call; follow it
   * with `client.runs.follow(response.run.id)`. `comment` reaches the continuation's prompt.
   *
   * Throws {@link ApiProblemError}: `409 run_not_awaiting_approval`, `409 approval_already_decided`,
   * `409 approval_expired` (the pause is older than 24 hours), `404 run_not_found`.
   */
  public async approve(
    runId: string,
    input: { readonly comment?: string } = {},
    options: RequestOptions = {},
  ): Promise<RunApprovalResponse> {
    return this.#decide(runId, 'approve', input.comment, options);
  }

  /**
   * Reject the tool call a run paused on (`POST /api/runs/:id/approval`, ADR-0145). The
   * continuation run starts without permission to make the call and is told it was refused.
   * Refuses like `approve`.
   */
  public async reject(
    runId: string,
    input: { readonly comment?: string } = {},
    options: RequestOptions = {},
  ): Promise<RunApprovalResponse> {
    return this.#decide(runId, 'reject', input.comment, options);
  }

  async #decide(
    runId: string,
    decision: 'approve' | 'reject',
    comment: string | undefined,
    options: RequestOptions,
  ): Promise<RunApprovalResponse> {
    return this.#http.json({
      operation: 'runs.approval',
      method: 'POST',
      path: `/api/runs/${segment(runId)}/approval`,
      body: comment === undefined ? { decision } : { decision, comment },
      expect: [202],
      schema: RunApprovalResponseSchema,
      signal: options.signal,
    });
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

  /**
   * The files a run wrote, found under the run's outputs in the workspace files (the `files` list,
   * no route of its own): every file below `outputs/`, folders walked, each with its `name`
   * relative to that directory and the `path` `files.download` takes.
   *
   * A run has outputs only once it is `completed` and its agent has `writeFiles` on; any other run
   * answers with an empty list. Throws {@link ApiProblemError} and {@link ContractViolationError}
   * like the files list does.
   */
  public async outputs(
    runId: string,
    options: RequestOptions = {},
  ): Promise<readonly RunOutputFile[]> {
    const root = outputsPath(runId);
    const found: RunOutputFile[] = [];
    const pending = [root];
    for (let dir = pending.shift(); dir !== undefined; dir = pending.shift()) {
      const { files } = await this.#http.json({
        operation: 'runs.outputs',
        method: 'GET',
        path: '/api/files',
        query: new URLSearchParams({ path: dir }),
        expect: [200],
        schema: FileListResponseSchema,
        signal: options.signal,
      });
      for (const file of files) {
        if (file.kind === 'folder') pending.push(file.path);
        else found.push({ ...file, name: file.path.slice(root.length + 1) });
      }
    }
    return found;
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
    return yield* this.#events(runId, options, undefined);
  }

  /** {@link events}, reporting each `retry:` the stream sends to `onRetry` (K-3, for follow). */
  async *#events(
    runId: string,
    options: RunEventsOptions,
    onRetry: ((ms: number) => void) | undefined,
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
      for await (const raw of readSseStream(response.body, options.signal, onRetry)) {
        const frame = classifyRunEventFrame(raw);
        if (frame.kind === 'done') return { lastEventId };
        const cursor = cursorOf(frame);
        if (cursor !== undefined) lastEventId = cursor;
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
   *
   * Reconnects back off (issue #250, K-3): the base is the last `retry:` the stream sent, else
   * `reconnectDelayMs`; the n-th failed reconnect in a row waits between half and all of
   * `min(maxReconnectDelayMs, base × 2^(n−1))`; a connection that delivers a new event starts the
   * count again; a `429` or `5xx` naming `Retry-After` is waited exactly that long.
   */
  public async *follow(
    runId: string,
    options: FollowRunOptions = {},
  ): AsyncGenerator<RunEventFrame, RunStreamEnd, void> {
    const maxReconnects = options.maxReconnects ?? 5;
    const { base, cap } = reconnectBounds(options);
    let retryHint: number | null = null;
    const onRetry = (ms: number): void => {
      retryHint = ms;
    };
    let after = options.after ?? null;
    let reconnects = 0;
    for (;;) {
      let lastSeen = after;
      try {
        const stream = this.#events(runId, { ...options, after }, onRetry);
        try {
          for (;;) {
            const next = await stream.next();
            if (next.done) return next.value;
            const frame = next.value;
            const cursor = cursorOf(frame);
            if (cursor !== undefined) lastSeen = cursor;
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
        // The server's instruction wins over the client's schedule: exact, uncapped, unjittered.
        const retryAfterSeconds = error instanceof ApiProblemError ? error.retryAfterSeconds : null;
        await delay(
          retryAfterSeconds === null
            ? backoffPause(retryHint ?? base, cap, reconnects)
            : retryAfterSeconds * 1000,
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
    if (!isStoppedRunStatus(run.status)) {
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

  /**
   * Wait for the run to end, then read its answer (ADR-0143): `text` is the prose and `output` the
   * structured value. With `schema`, `output` is that schema's parse of the value and a mismatch
   * is a {@link ContractViolationError}: the run asked for this shape and the platform handed
   * back another. A run that did not `completed` — failed, cancelled — has no answer: `text` and
   * `output` are `null`, and the reason is `run.error`, read with {@link runFailure}.
   */
  public async result<Schema extends z.ZodType>(
    runId: string,
    options: RunResultOptions<Schema> & { readonly schema: Schema },
  ): Promise<RunResult<z.output<Schema>>>;
  public async result(
    runId: string,
    options?: RunResultOptions<undefined>,
  ): Promise<RunResult<unknown>>;
  public async result(
    runId: string,
    options: RunResultOptions<z.ZodType | undefined> = {},
  ): Promise<RunResult<unknown>> {
    const run = await this.waitForOutcome(runId, options);
    const answer = run.output;
    if (answer === null) return { run, text: null, output: null };
    if (options.schema === undefined || answer.structured === null) {
      return { run, text: answer.text, output: answer.structured };
    }
    const parsed = options.schema.safeParse(answer.structured);
    if (!parsed.success) {
      throw new ContractViolationError({
        operation: 'runs.result',
        status: 200,
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
    }
    return { run, text: answer.text, output: parsed.data };
  }
}
