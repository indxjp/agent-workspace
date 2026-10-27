/**
 * A2A v0.3 JSON-RPC methods over the run API (ADR-0135): `message/send`, `message/stream`,
 * `tasks/get` and `tasks/cancel`. The caller is already authenticated, scoped and authorised for
 * this agent (`../dispatch.ts`); a task is a run, a context is a session.
 */
import {
  A2A_ERROR_CODES,
  A2aJsonRpcRequestSchema,
  A2aMessageSendParamsSchema,
  A2aTaskIdParamsSchema,
  A2aTaskQueryParamsSchema,
  type A2aArtifactUpdateEvent,
  type A2aMessageSendParams,
  type A2aPart,
  type A2aStatusUpdateEvent,
  type A2aTextPart,
} from '@indx-workspace/contracts/a2a';

import { upgradeEventStream } from '../../runs/agent-frames';
import { findRunForPrincipal, interruptRunFor } from '../../runs/api';
import type { AgentRef, RunPrincipal, RunApiEnvironment, SessionRef } from '../../runs/environment';
import { publicRunFailure } from '../../runs/failures';
import { apiError, isUuid, json } from '../../runs/http';
import { MAX_PROMPT_CHARS, startRunOnSession } from '../../runs/service';
import {
  isStoppedRunStatus,
  isTerminalRunStatus,
  type RunRecord,
  type RunStore,
} from '../../runs/store';
import type { PublishedAgent } from '../env';
import { admitA2aMessage } from '../limits';
import {
  agentMessage,
  assistantText,
  buildTask,
  chunkText,
  failureText,
  runTimestamp,
  taskState,
  textArtifact,
} from './map';

/** How long a blocking `message/send` follows its run before it answers with the task as it is. */
export const A2A_BLOCKING_WAIT_MS = 120_000;

const UNKNOWN_CONTEXT = 'unknown contextId';
const KEEPALIVE_MS = 15_000;

/** Everything a method handler needs about one authorised call. */
export interface A2aCall {
  readonly request: Request;
  readonly runs: RunApiEnvironment;
  readonly principal: RunPrincipal;
  readonly credentialId: string;
  readonly agent: PublishedAgent;
  readonly agentRef: AgentRef;
  readonly now: () => number;
  readonly blockingWaitMs: number;
}

type RpcId = string | number | null;

interface Failure {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const fail = (code: number, message: string, data?: unknown): Outcome<never> => ({
  ok: false,
  failure: { code, message, ...(data === undefined ? {} : { data }) },
});

const envelope = (id: RpcId, body: { result: unknown } | { error: Failure }) => ({
  jsonrpc: '2.0' as const,
  id,
  ...body,
});
const rpcResponse = (id: RpcId, outcome: Outcome<unknown>): Response =>
  json(envelope(id, outcome.ok ? { result: outcome.value } : { error: outcome.failure }), 200);

const isText = (part: A2aPart): part is A2aTextPart => part.kind === 'text';

interface Prepared {
  readonly prompt: string;
  readonly contextId: string | null;
  readonly blocking: boolean;
  readonly historyLength: number;
}

function prepareMessage(params: A2aMessageSendParams): Outcome<Prepared> {
  const { message, configuration } = params;
  if (message.role !== 'user') {
    return fail(A2A_ERROR_CODES.invalid_params, 'only user messages are accepted');
  }
  if (message.taskId !== undefined) {
    return fail(
      A2A_ERROR_CODES.unsupported_operation,
      'a task cannot be continued; send a new message with the same contextId',
    );
  }
  if (configuration?.pushNotificationConfig !== undefined) {
    return fail(
      A2A_ERROR_CODES.push_notification_not_supported,
      'push notifications are not supported',
    );
  }
  const modes = configuration?.acceptedOutputModes;
  if (
    modes !== undefined &&
    modes.length > 0 &&
    !modes.some((m) => m === 'text/plain' || m === 'text')
  ) {
    return fail(A2A_ERROR_CODES.content_type_not_supported, 'this agent answers in text/plain');
  }
  if (!message.parts.every(isText)) {
    return fail(A2A_ERROR_CODES.content_type_not_supported, 'only text parts are accepted');
  }
  const prompt = message.parts
    .filter(isText)
    .map((part) => part.text)
    .join('\n\n');
  if (prompt.trim() === '') {
    return fail(A2A_ERROR_CODES.invalid_params, 'the message has no text');
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return fail(A2A_ERROR_CODES.invalid_params, 'the message text is too long');
  }
  if (message.contextId !== undefined && !isUuid(message.contextId)) {
    return fail(A2A_ERROR_CODES.invalid_params, UNKNOWN_CONTEXT);
  }
  return ok({
    prompt,
    contextId: message.contextId ?? null,
    blocking: configuration?.blocking !== false,
    historyLength: configuration?.historyLength ?? 0,
  });
}

async function startTask(
  call: A2aCall,
  prepared: Prepared,
): Promise<Outcome<{ readonly run: RunRecord; readonly session: SessionRef }>> {
  const { runs, principal, agent } = call;
  let agentRef = call.agentRef;
  if (prepared.contextId !== null) {
    // A follow-up runs on the conversation's pinned version, which `findAgent` reads.
    const followUp = await runs.findAgent(principal, agent.agentId, prepared.contextId);
    if (followUp === null) return fail(A2A_ERROR_CODES.invalid_params, UNKNOWN_CONTEXT);
    agentRef = followUp;
  }
  const started = await startRunOnSession(runs, principal, agentRef, {
    prompt: prepared.prompt,
    sessionId: prepared.contextId,
    modelOverride: null,
    ...(prepared.contextId === null ? { agentVersionId: agent.productionVersionId } : {}),
  });
  if (started.kind === 'refused') {
    // One answer for every reason a context cannot be used, so it cannot be probed.
    return started.code === 'session_not_usable'
      ? fail(A2A_ERROR_CODES.invalid_params, UNKNOWN_CONTEXT)
      : fail(A2A_ERROR_CODES.internal_error, started.message, { code: started.code });
  }
  return ok({ run: started.run, session: started.session });
}

/** The whole reply of a finished run: its assistant prose, in order. */
async function readAnswer(store: RunStore, runId: string): Promise<string> {
  const handle = await store.openStream(runId, null);
  if (handle === null) return '';
  const texts: string[] = [];
  try {
    for await (const event of upgradeEventStream(handle.events, null)) {
      const text = assistantText(event.type, event.data);
      if (text !== '') texts.push(text);
    }
  } finally {
    handle.close();
  }
  return texts.map((text, index) => chunkText(index, text)).join('');
}

/** Follow `runId` until it ends, `waitMs` pass or `signal` aborts. The run itself is never touched. */
async function awaitEnd(
  store: RunStore,
  runId: string,
  signal: AbortSignal,
  waitMs: number,
): Promise<void> {
  const handle = await store.openStream(runId, null);
  if (handle === null) return;
  const stop = (): void => handle.close();
  const timer = setTimeout(stop, waitMs);
  signal.addEventListener('abort', stop, { once: true });
  try {
    for await (const event of handle.events) void event;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    handle.close();
  }
}

async function messageSend(call: A2aCall, prepared: Prepared): Promise<Outcome<unknown>> {
  const started = await startTask(call, prepared);
  if (!started.ok) return started;
  const { run } = started.value;
  if (!prepared.blocking) return ok(buildTask(run, null, 0));
  const { store } = call.runs;
  await awaitEnd(store, run.id, call.request.signal, call.blockingWaitMs);
  const latest = (await store.get(run.id)) ?? run;
  const answer = isTerminalRunStatus(latest.status) ? await readAnswer(store, run.id) : null;
  return ok(buildTask(latest, answer, prepared.historyLength));
}

function statusUpdate(run: RunRecord, final: boolean, unfinished: boolean): A2aStatusUpdateEvent {
  const state = unfinished ? 'unknown' : taskState(run.status);
  return {
    kind: 'status-update',
    taskId: run.id,
    contextId: run.sessionId,
    status: {
      state,
      ...(state === 'failed'
        ? { message: agentMessage(run.sessionId, run.id, failureText(run)) }
        : {}),
      timestamp: runTimestamp(run),
    },
    final,
  };
}

async function* streamFrames(
  call: A2aCall,
  id: RpcId,
  run: RunRecord,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const frame = (result: unknown) => envelope(id, { result });
  yield frame(buildTask(run, null, 0));
  const { store } = call.runs;
  const handle = await store.openStream(run.id, null);
  let chunks = 0;
  let working = false;
  if (handle !== null) {
    const stop = (): void => handle.close();
    signal.addEventListener('abort', stop, { once: true });
    try {
      for await (const event of upgradeEventStream(handle.events, null)) {
        // `working` is announced on the first agent frame, not while the run may still be queued.
        if (!working) {
          working = true;
          yield frame(statusUpdate({ ...run, status: 'running' }, false, false));
        }
        const text = assistantText(event.type, event.data);
        if (text === '') continue;
        const update: A2aArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId: run.id,
          contextId: run.sessionId,
          artifact: textArtifact(chunkText(chunks, text)),
          append: chunks > 0,
        };
        chunks += 1;
        yield frame(update);
      }
    } finally {
      signal.removeEventListener('abort', stop);
      handle.close();
    }
  }
  // A client that left cancelled nothing: the run carries on and `tasks/get` still answers.
  if (signal.aborted) return;
  const latest = (await store.get(run.id)) ?? run;
  yield frame(statusUpdate(latest, true, !isStoppedRunStatus(latest.status)));
}

function sseResponse(
  frames: AsyncGenerator<unknown>,
  id: RpcId,
  abort: AbortController,
  sanitise: (cause: unknown) => string,
): Response {
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          // closed by another exit path
        }
      }, KEEPALIVE_MS);
      (keepalive as { unref?: () => void }).unref?.();
    },
    async pull(controller) {
      try {
        const next = await frames.next();
        if (next.done === true) {
          clearInterval(keepalive);
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
      } catch (cause) {
        clearInterval(keepalive);
        const error = envelope(id, {
          error: { code: A2A_ERROR_CODES.internal_error, message: sanitise(cause) },
        });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(error)}\n\n`));
        controller.close();
      }
    },
    cancel() {
      clearInterval(keepalive);
      abort.abort();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

async function messageStream(
  call: A2aCall,
  id: RpcId,
  prepared: Prepared,
  sanitise: (cause: unknown) => string,
): Promise<Response> {
  const started = await startTask(call, prepared);
  if (!started.ok) return rpcResponse(id, started);
  const abort = new AbortController();
  const { signal } = call.request;
  if (signal.aborted) abort.abort();
  else signal.addEventListener('abort', () => abort.abort(), { once: true });
  return sseResponse(streamFrames(call, id, started.value.run, abort.signal), id, abort, sanitise);
}

/**
 * The run behind task `taskId`, or `null`. Unknown, malformed, another workspace's, another
 * agent's and another caller's all answer the same, so a task id cannot be probed.
 */
async function findTask(call: A2aCall, taskId: string): Promise<RunRecord | null> {
  if (!isUuid(taskId)) return null;
  const run = await findRunForPrincipal(call.runs.store, call.principal, taskId);
  if (run === null || run.agentId !== call.agent.agentId) return null;
  return (await call.runs.ownsRun(call.principal, run)) ? run : null;
}

const TASK_NOT_FOUND = 'task not found';

async function tasksGet(call: A2aCall, taskId: string, historyLength: number) {
  const run = await findTask(call, taskId);
  if (run === null) return fail(A2A_ERROR_CODES.task_not_found, TASK_NOT_FOUND);
  const answer = isTerminalRunStatus(run.status) ? await readAnswer(call.runs.store, run.id) : null;
  return ok(buildTask(run, answer, historyLength));
}

async function tasksCancel(call: A2aCall, taskId: string): Promise<Outcome<unknown>> {
  const run = await findTask(call, taskId);
  if (run === null) return fail(A2A_ERROR_CODES.task_not_found, TASK_NOT_FOUND);
  if ((await interruptRunFor(call.runs, call.principal, run)) === 'terminal') {
    return fail(A2A_ERROR_CODES.task_not_cancelable, 'the task has already finished');
  }
  // Re-read: the answer reports the status the store holds, not the one that was asked for.
  const latest = (await findTask(call, taskId)) ?? run;
  return ok(buildTask(latest, null, 0));
}

/** Handle one JSON-RPC request body for an authorised caller. Never throws. */
export async function handleV03(call: A2aCall, bodyText: string): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcResponse(null, fail(A2A_ERROR_CODES.parse_error, 'parse error'));
  }
  if (Array.isArray(parsed)) {
    return rpcResponse(
      null,
      fail(A2A_ERROR_CODES.invalid_request, 'batch requests are not supported'),
    );
  }
  const request = A2aJsonRpcRequestSchema.safeParse(parsed);
  if (!request.success) {
    return rpcResponse(null, fail(A2A_ERROR_CODES.invalid_request, 'invalid request'));
  }
  const { id, method, params } = request.data;
  const badParams = rpcResponse(id, fail(A2A_ERROR_CODES.invalid_params, 'invalid params'));
  const sanitise = (cause: unknown): string =>
    publicRunFailure(cause, {
      operation: 'a2a-rpc',
      publicMessage: 'The agent endpoint could not complete the request.',
    });

  try {
    switch (method) {
      case 'message/send':
      case 'message/stream': {
        const parsedParams = A2aMessageSendParamsSchema.safeParse(params);
        if (!parsedParams.success) return badParams;
        const admission = admitA2aMessage(call.credentialId, call.now());
        if (!admission.admitted) return rateLimited(admission.retryAfterSeconds);
        const prepared = prepareMessage(parsedParams.data);
        if (!prepared.ok) return rpcResponse(id, prepared);
        return method === 'message/send'
          ? rpcResponse(id, await messageSend(call, prepared.value))
          : await messageStream(call, id, prepared.value, sanitise);
      }
      case 'tasks/get': {
        const query = A2aTaskQueryParamsSchema.safeParse(params);
        if (!query.success) return badParams;
        return rpcResponse(id, await tasksGet(call, query.data.id, query.data.historyLength ?? 0));
      }
      case 'tasks/cancel': {
        const target = A2aTaskIdParamsSchema.safeParse(params);
        if (!target.success) return badParams;
        return rpcResponse(id, await tasksCancel(call, target.data.id));
      }
      case 'tasks/pushNotificationConfig/set':
      case 'tasks/pushNotificationConfig/get':
      case 'tasks/pushNotificationConfig/list':
      case 'tasks/pushNotificationConfig/delete':
        return rpcResponse(
          id,
          fail(
            A2A_ERROR_CODES.push_notification_not_supported,
            'push notifications are not supported',
          ),
        );
      case 'tasks/resubscribe':
      case 'agent/getAuthenticatedExtendedCard':
        return rpcResponse(id, fail(A2A_ERROR_CODES.unsupported_operation, 'not supported'));
      default:
        return rpcResponse(id, fail(A2A_ERROR_CODES.method_not_found, 'method not found'));
    }
  } catch (cause) {
    return rpcResponse(id, fail(A2A_ERROR_CODES.internal_error, sanitise(cause)));
  }
}

export function rateLimited(retryAfterSeconds: number): Response {
  const response = apiError(429, 'a2a_rate_limited', 'too many requests; retry later.');
  response.headers.set('Retry-After', String(retryAfterSeconds));
  return response;
}
