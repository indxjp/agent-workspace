/**
 * The browser side of `POST /api/agents/:id/runs` and `GET /api/runs/:id/events` — spec §19, §34.
 *
 * This is what `home-chat.tsx` calls after **Send** to make W1-UI-05's run path real: start a run,
 * then read its event stream until the server's own `done` frame. Everything here is transport —
 * turning a `fetch` response into the primitives `@indx-workspace/react/run-model`'s pure functions turn into a
 * `Run` update. Nothing here decides what a frame *means*; that is the run model's job, so it stays
 * testable without a network.
 *
 * ## The wire-format parser is the SDK's
 *
 * Splitting the byte stream into frames and reading `event:`/`id:`/`data:` is
 * `@indx-workspace/sdk/events`' job now — the same parser an external consumer of this stream
 * uses — and it is re-exported here under the names this module has always had, so the
 * application is the SDK's first consumer rather than a second implementation of its format. The
 * reasoning for a hand-written parser over `EventSource` (every platform frame is named; there is
 * no wildcard listener; `Authorization` cannot travel) lives with that module.
 *
 * What stays here is the screen's own transport policy: how `home-chat.tsx` learns about a
 * dropped connection, and the project-session ordering a first run in a project has to respect.
 */
import { parseSseFrame, splitSseFrames, type SseFrame } from '@indx-workspace/sdk/events';

export { parseSseFrame, splitSseFrames };

/** One parsed SSE frame: the `event:` name, its `id:` when the server sent one, and its payload. */
type LiveFrame = SseFrame;

/** What this screen does with a live run's event stream. Called for every frame this module reads. */
export interface RunEventStreamHandlers {
  /** A frame that is not the stream's own `done` — a relayed event, or a control frame. */
  onFrame(frame: LiveFrame): void;
  /** The server's `done` frame arrived: nothing further will be delivered. Read `sse.ts`'s own words
   *  for what `done` does and does not say about whether the run succeeded. */
  onDone(): void;
  /** The connection itself failed, or ended without a `done` frame — reported, never guessed past. */
  onTransportError(message: string): void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read `eventsUrl` (same-origin, so the session cookie travels with it exactly as it does for any
 * other `fetch` in this application) until `done` arrives or the connection fails.
 *
 * Returns a function that aborts the read — call it on unmount so a screen nobody is looking at
 * stops holding a connection open.
 */
export function followRunEvents(eventsUrl: string, handlers: RunEventStreamHandlers): () => void {
  const controller = new AbortController();

  void (async (): Promise<void> => {
    let response: Response;
    try {
      response = await fetch(eventsUrl, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      handlers.onTransportError(
        `the request for this run's events failed: ${describeError(error)}`,
      );
      return;
    }

    if (!response.ok || response.body === null) {
      handlers.onTransportError(
        `the events endpoint answered ${String(response.status)} instead of opening a stream`,
      );
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const split = splitSseFrames(buffer);
        buffer = split.rest;
        for (const raw of split.frames) {
          const frame = parseSseFrame(raw);
          if (frame === null) continue;
          if (frame.event === 'done') {
            handlers.onDone();
            return;
          }
          handlers.onFrame(frame);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      handlers.onTransportError(
        `this run's event stream ended unexpectedly: ${describeError(error)}`,
      );
      return;
    }

    // The body ended and no `done` frame was ever seen. `sse.ts` writes `done` from every exit
    // path except a mid-stream throw — which the catch above already reports — so a clean end with
    // no `done` is a connection closed from outside that contract (a proxy, a restart) and is
    // reported rather than read as a quiet success.
    handlers.onTransportError('this run\'s event stream ended before a "done" frame arrived');
  })();

  return () => {
    controller.abort();
  };
}

/** What `POST /api/agents/:id/runs` answered, once the network and the JSON parse are both done. */
export type StartRunOutcome =
  | {
      readonly kind: 'started';
      readonly status: unknown;
      readonly eventsUrl: string;
      readonly sessionId: string | null;
    }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: 'transport-error'; readonly message: string };

type StartProjectSessionOutcome =
  | { readonly kind: 'started'; readonly sessionId: string }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: 'transport-error'; readonly message: string };

/** The `{ code, message }` inside this platform's one error envelope (`server/runs/http.ts`'s `ApiErrorBody`), read defensively — a body that does not match it is named as such, not guessed at. */
function describeApiError(body: unknown): { readonly code: string; readonly message: string } {
  if (typeof body === 'object' && body !== null) {
    const error = (body as Record<string, unknown>)['error'];
    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string, unknown>;
      const code = record['code'];
      const message = record['message'];
      if (typeof code === 'string' && typeof message === 'string') return { code, message };
    }
  }
  return {
    code: 'unrecognised_error_body',
    message: 'the server did not explain why in the usual shape.',
  };
}

/**
 * `POST /api/agents/:id/runs`, spec §34. Always starts a new session — §19.5.1 rule 4 is
 * `selectAgent`'s rule for the picker; this is its counterpart for the network call, and the two
 * agree by both never carrying a prior session id.
 *
 * `modelOverride` is issue #130's own out-of-glob addition to this pre-#129 signature (see
 * `docs/adr/W9-MODEL-130-composer-run-client-sends-the-connection-model-pair.md`): the body
 * `server/runs/api.ts`'s `parseStartRunBody` actually accepts is `modelConnectionId` and `model`
 * together or neither — sending a bare `modelConnectionId` with no `model` (this function's
 * pre-#130 shape) is a `400`. `null` means "no run override; resolution falls through to the
 * agent's own default, then the project's, then the workspace's."
 */
export async function startAgentRun(
  agentId: string,
  prompt: string,
  modelOverride: { readonly connectionId: string; readonly model: string } | null = null,
  sessionId: string | null = null,
): Promise<StartRunOutcome> {
  let response: Response;
  try {
    response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        prompt,
        sessionId,
        modelConnectionId: modelOverride?.connectionId ?? null,
        model: modelOverride?.model ?? null,
      }),
    });
  } catch (error) {
    return {
      kind: 'transport-error',
      message: `the request to start this run failed: ${describeError(error)}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const problem = describeApiError(body);
    return {
      kind: 'rejected',
      status: response.status,
      code: problem.code,
      message: problem.message,
    };
  }

  if (typeof body !== 'object' || body === null) {
    return {
      kind: 'transport-error',
      message: 'the server accepted the run but its response body is not an object.',
    };
  }
  const record = body as Record<string, unknown>;
  const events = record['events'];
  if (typeof events !== 'string' || events === '') {
    return {
      kind: 'transport-error',
      message: 'the server accepted the run but named no events URL.',
    };
  }
  const run = record['run'];
  const status =
    typeof run === 'object' && run !== null
      ? (run as Record<string, unknown>)['status']
      : undefined;
  const returnedSessionId =
    typeof run === 'object' &&
    run !== null &&
    typeof (run as Record<string, unknown>)['sessionId'] === 'string'
      ? ((run as Record<string, unknown>)['sessionId'] as string)
      : null;
  return { kind: 'started', status, eventsUrl: events, sessionId: returnedSessionId };
}

/**
 * Create the project-owned session before starting its first run. The ordering is an invariant:
 * once a session has a run, the project API intentionally refuses to move it because doing so
 * would rewrite historical attribution.
 */
async function startProjectSession(
  projectId: string,
  agentId: string,
): Promise<StartProjectSessionOutcome> {
  let response: Response;
  try {
    response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ agentId }),
    });
  } catch (error) {
    return {
      kind: 'transport-error',
      message: `the request to start a session in this project failed: ${describeError(error)}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const problem = describeApiError(body);
    return { kind: 'rejected', status: response.status, ...problem };
  }
  if (typeof body !== 'object' || body === null) {
    return {
      kind: 'transport-error',
      message: 'the server created a project session but its response body is not an object.',
    };
  }
  const sessionId = (body as Record<string, unknown>)['id'];
  if (typeof sessionId !== 'string' || sessionId === '') {
    return {
      kind: 'transport-error',
      message: 'the server created a project session but returned no session id.',
    };
  }
  return { kind: 'started', sessionId };
}

/** Start a first run, atomically preserving project attribution by opening its session first. */
export async function startAgentRunInProject(
  agentId: string,
  prompt: string,
  modelOverride: { readonly connectionId: string; readonly model: string } | null,
  projectId: string | null,
): Promise<StartRunOutcome> {
  if (projectId === null) return startAgentRun(agentId, prompt, modelOverride, null);
  const session = await startProjectSession(projectId, agentId);
  if (session.kind !== 'started') return session;
  return startAgentRun(agentId, prompt, modelOverride, session.sessionId);
}

/** Resume an existing session, or preserve project attribution while starting a replacement. */
export function startAgentRunForSession(
  agentId: string,
  prompt: string,
  modelOverride: { readonly connectionId: string; readonly model: string } | null,
  sessionId: string | null,
  projectId: string | null,
): Promise<StartRunOutcome> {
  return sessionId === null
    ? startAgentRunInProject(agentId, prompt, modelOverride, projectId)
    : startAgentRun(agentId, prompt, modelOverride, sessionId);
}
