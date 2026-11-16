/**
 * `agentPanelClient`: the browser's way to the agent panel's routes (issue #1509), so the panel
 * never calls `fetch` itself. Every answer is parsed with the wire's schemas; a failure is one
 * {@link ResourceProblemError}, its code the route's own.
 *
 * {@link AgentPanelClient.follow} reads a run's events with the SDK's `readSseFrames` and
 * `classifyRunEventFrame`, and reconnects with `Last-Event-ID` when a connection drops before
 * `done`, as `runs.follow` does: at most {@link MAX_RECONNECTS} reconnects in a row that deliver
 * nothing new. A `run-failed` whose status is `unknown` and that no `done` follows is the route
 * saying its connection broke, not that the run failed, so it is held back unless the panel gives
 * up.
 */
import { ApiProblemSchema } from '@indx-workspace/contracts';
import type { RunApprovalDecision } from '@indx-workspace/contracts/runs';
import {
  classifyRunEventFrame,
  readSseFrames,
  type RunEventFrame,
} from '@indx-workspace/sdk/events';
import type { z } from 'zod';

import {
  agentPanelPath,
  AgentPanelRunResponseSchema,
  AgentPanelStartResponseSchema,
  type AgentPanelRun,
  type AgentPanelStartResponse,
} from '../agent-panel-wire.js';
import { MAX_RECONNECTS, nextReconnect } from './agent-panel-model.js';
import { ResourceProblemError } from './client.js';

/** Where the routes are and how to reach them. */
export interface AgentPanelClientOptions {
  /** The app's origin and path prefix; `''` (the page's own origin) when not given. */
  readonly baseUrl?: string;
  /** Injected for tests; the global `fetch` when not given. */
  readonly fetch?: typeof fetch;
  /** The pause between reconnects, in milliseconds; 3000, the route's `retry:`, when not given. */
  readonly reconnectDelayMs?: number;
}

/** What {@link AgentPanelClient.follow} is told. */
export interface FollowOptions {
  /** Resume after this event id; from the beginning when `null`. */
  readonly after: string | null;
  readonly signal: AbortSignal;
  readonly onFrame: (frame: RunEventFrame) => void;
}

/** The panel routes of one record. */
export interface AgentPanelClient {
  start(agent: string, prompt: string): Promise<AgentPanelStartResponse>;
  get(runId: string): Promise<AgentPanelRun>;
  decide(
    runId: string,
    decision: RunApprovalDecision,
    comment: string | undefined,
  ): Promise<AgentPanelStartResponse>;
  /** Resolves when the stream says `done`; rejects with `stream_lost` once reconnects are spent. */
  follow(runId: string, options: FollowOptions): Promise<void>;
}

const RECONNECT_DELAY_MS = 3000;

function transportFailed(): ResourceProblemError {
  return new ResourceProblemError({
    code: 'transport_failed',
    status: 0,
    message: 'the app could not be reached',
  });
}

async function problemOf(response: Response): Promise<ResourceProblemError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = ApiProblemSchema.safeParse(body);
  if (!parsed.success) {
    return new ResourceProblemError({
      code: 'unrecognised_error_body',
      status: response.status,
      message: `the app answered ${String(response.status)} without the problem envelope`,
    });
  }
  return new ResourceProblemError({
    code: parsed.data.error.code,
    status: response.status,
    message: parsed.data.error.message,
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** One connection: `'done'`, or how far it got before it dropped. */
type Connection =
  | { readonly kind: 'done' }
  | {
      readonly kind: 'dropped';
      readonly lastEventId: string | null;
      readonly held: RunEventFrame | null;
    };

/** Builds the client of the panel of `recordId` of the resource named `resource`. */
export function agentPanelClient(
  resource: string,
  recordId: string,
  options: AgentPanelClientOptions = {},
): AgentPanelClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/u, '');
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const delayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
  const url = (...rest: readonly string[]): string =>
    `${baseUrl}${agentPanelPath(resource, recordId, 'runs', ...rest)}`;

  async function call<S extends z.ZodType>(
    path: string,
    init: RequestInit,
    expect: number,
    schema: S,
  ): Promise<z.infer<S>> {
    let response: Response;
    try {
      response = await send(path, { credentials: 'same-origin', ...init });
    } catch {
      throw transportFailed();
    }
    if (response.status !== expect) throw await problemOf(response);
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new ResourceProblemError({
        code: 'contract_violation',
        status: response.status,
        message: 'the app answered with a body the panel does not read',
      });
    }
    return parsed.data;
  }

  const post = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function connect(
    runId: string,
    after: string | null,
    { signal, onFrame }: FollowOptions,
  ): Promise<Connection> {
    let lastEventId = after;
    let held: RunEventFrame | null = null;
    const response = await send(url(runId, 'events'), {
      credentials: 'same-origin',
      headers: {
        accept: 'text/event-stream',
        ...(after === null ? {} : { 'last-event-id': after }),
      },
      signal,
    }).catch(() => null);
    if (response === null || response.body === null) return { kind: 'dropped', lastEventId, held };
    if (response.status !== 200) throw await problemOf(response);
    try {
      for await (const raw of readSseFrames(response.body, signal)) {
        const frame = classifyRunEventFrame(raw);
        if (frame.kind === 'done') {
          if (held !== null) onFrame(held);
          return { kind: 'done' };
        }
        if (frame.kind === 'run-failed' && frame.data.status === 'unknown') {
          held = frame;
          continue;
        }
        if (
          frame.kind === 'run-status' ||
          frame.kind === 'run-warning' ||
          frame.kind === 'runtime'
        ) {
          lastEventId = frame.id ?? lastEventId;
        }
        onFrame(frame);
      }
    } catch {
      // A body that broke mid-stream is a drop like a clean close before `done`.
    }
    return { kind: 'dropped', lastEventId, held };
  }

  return {
    start: (agent, prompt) =>
      call(url(), post({ agent, prompt }), 202, AgentPanelStartResponseSchema),
    get: async (runId) =>
      (await call(url(runId), { method: 'GET' }, 200, AgentPanelRunResponseSchema)).run,
    decide: (runId, decision, comment) =>
      call(
        url(runId, 'approval'),
        post(comment === undefined ? { decision } : { decision, comment }),
        202,
        AgentPanelStartResponseSchema,
      ),
    async follow(runId, followOptions) {
      let after = followOptions.after;
      let failures = 0;
      for (;;) {
        const connection = await connect(runId, after, followOptions);
        if (connection.kind === 'done' || followOptions.signal.aborted) return;
        const next = nextReconnect(failures, connection.lastEventId !== after);
        if (next === null) {
          if (connection.held !== null) followOptions.onFrame(connection.held);
          throw new ResourceProblemError({
            code: 'stream_lost',
            status: 0,
            message: `the run's events dropped ${String(MAX_RECONNECTS)} times in a row`,
          });
        }
        failures = next;
        after = connection.lastEventId;
        await wait(delayMs, followOptions.signal);
        if (followOptions.signal.aborted) return;
      }
    },
  };
}
