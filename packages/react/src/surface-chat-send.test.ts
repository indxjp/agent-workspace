import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '@indx-workspace/sdk';
import type { SurfaceSessionResponse } from '@indx-workspace/contracts/surfaces';
import { ENGINE_IDS } from '@indx-workspace/contracts/engines';
import {
  eventStreamResponse,
  fetchDouble,
  fixtures,
  jsonResponse,
  type FetchDouble,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';

import type { Run } from './run-model.js';
import {
  readSurfaceHistory,
  selectSurfaceAgent,
  surfaceEntryOf,
  surfaceHistoryStorage,
  writeSurfaceEntry,
  type SurfaceHistoryStorage,
} from './history.js';
import { surfaceStrings } from './locale.js';
import { openSurfaceSession, postRunFeedback, uploadSurfaceAttachment } from './session.js';
import { messageParagraphs, surfaceAgentSpeaker, type SurfaceTurn } from './surface-chat-model.js';
import {
  browserSurfaceChatTransport,
  restoreSurfaceConversation,
  sendSurfaceFeedback,
  sendSurfaceMessage,
  type SurfaceChatDriver,
} from './surface-chat-send.js';

/**
 * The surface chat's send path end to end over the real SDK client and the real bootstrap reader,
 * with `fetch` injected: what `surface-chat.tsx` does on Send, without a DOM (this repository has
 * no jsdom, see `../team/invitation-reveal.test.tsx`).
 */
const ORIGIN = 'http://127.0.0.1:4310';
const RUN = fixtures.run({ status: 'running' });
const OWN = 'Support triage';
const OFFERED = [OWN, 'Billing'];
const SESSION_A = RUN.sessionId ?? '';
const SESSION_B = '44444444-4444-4444-8444-444444444444';
const KEY_A = 'A'.repeat(43);
const KEY_B = 'B'.repeat(43);
const PLACEHOLDER = '(an earlier message)';

/** A browser token in the contract's shape, told apart by `mark`. */
function token(mark: string): string {
  return `awt_live_${mark.repeat(22)}_${'b'.repeat(43)}`;
}
const FIRST = token('a');
const OLD = token('c');
const NEW = token('d');

function session(
  value: string,
  extra: { readonly sessionId?: string; readonly resumeKey?: string } = {},
): SurfaceSessionResponse {
  return {
    token: value,
    sessionId: extra.sessionId ?? SESSION_A,
    agentId: RUN.agentId,
    expiresAt: '2026-10-02T13:00:00.000Z',
    ...(extra.resumeKey === undefined ? {} : { resumeKey: extra.resumeKey }),
  };
}

function agentMessage(id: string, messageId: string, text: string): string {
  const data = {
    frame: 'agent.message',
    engine: ENGINE_IDS[0],
    raw: { type: 'assistant' },
    messageId,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
  };
  return `event: agent.message\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

function toolCall(id: string): string {
  const data = {
    frame: 'agent.tool.call',
    engine: ENGINE_IDS[0],
    raw: null,
    toolCallId: 'call_1',
    name: 'lookup_order',
    kind: 'other',
    input: { order: 42 },
  };
  return `event: agent.tool.call\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

const STREAM =
  'event: run.status\nid: 1\ndata: {"status":"running","error":null}\n\n' +
  agentMessage('2', 'msg_1', 'Looking') +
  agentMessage('3', 'msg_1', 'Looking it up: it ships today.') +
  'event: run.status\nid: 4\ndata: {"status":"completed","error":null}\n\n' +
  'event: done\ndata: null\n\n';

type Route = Parameters<typeof fetchDouble>[0];

/** The page's three origins of answers: the bootstrap, the API, and the feedback route. */
interface Network {
  readonly sessions: FetchDouble;
  readonly api: FetchDouble;
  readonly feedback: FetchDouble;
}

function network(sessions: Route, api: Route, feedback: Route = () => jsonResponse(204, null)) {
  return {
    sessions: fetchDouble(sessions),
    api: fetchDouble(api),
    feedback: fetchDouble(feedback),
  } satisfies Network;
}

interface Chat {
  readonly driver: SurfaceChatDriver;
  readonly shown: (Run | null)[];
  readonly turns: SurfaceTurn[];
}

const relative =
  (double: FetchDouble): typeof fetch =>
  (input, init) =>
    double.fetch(input instanceof Request ? input : new URL(input, ORIGIN), init);

/** A chat with `agentName` over `net`, keeping its history in `history`. */
function chat(
  net: Network,
  agentName: string = OWN,
  history: SurfaceHistoryStorage = memoryHistory(),
): Chat {
  const shown: (Run | null)[] = [];
  const turns: SurfaceTurn[] = [];
  let current: Run | null = null;
  const driver: SurfaceChatDriver = {
    surfaceName: 'main',
    agentName,
    ownAgentName: OWN,
    assistant: surfaceAgentSpeaker(agentName),
    transport: {
      openSession: (name, request) => openSurfaceSession(name, relative(net.sessions), request),
      postFeedback: (bearer, runId, request) =>
        postRunFeedback(runId, bearer, request, relative(net.feedback)),
      uploadAttachment: (opened, file) =>
        uploadSurfaceAttachment(opened.sessionId, opened.token, file, relative(net.api)),
      clientFor: (opened) =>
        createClient({
          baseUrl: ORIGIN,
          auth: { kind: 'browser-token', token: opened.token },
          fetch: net.api.fetch,
        }),
    },
    history,
    session: { current: null },
    current: () => current,
    show: (run) => {
      current = run;
      shown.push(run);
    },
    showTurn: (turn) => {
      turns.push(turn);
    },
    dropTurn: (runId) => {
      turns.splice(0, turns.length, ...turns.filter((each) => each.runId !== runId));
    },
    feedbackSent: new Set(),
    strings: surfaceStrings('en'),
  };
  return { driver, shown, turns };
}

function memoryHistory(): SurfaceHistoryStorage {
  return surfaceHistoryStorage(false, () => {
    throw new Error('not reached');
  });
}

interface Harness {
  readonly driver: SurfaceChatDriver;
  readonly network: FetchDouble;
  readonly shown: (Run | null)[];
  readonly bootstraps: () => number;
}

/** A chat whose bootstrap answers with `tokens` in turn, and whose API answers `route`. */
function harness(tokens: readonly string[], route: Route): Harness {
  const net = network((request) => {
    const next = tokens[net.sessions.calls.length - 1];
    expect(request.url.pathname).toBe('/p/s/main/sessions');
    return next === undefined
      ? jsonResponse(404, { error: { code: 'surface_not_found', message: 'gone' } })
      : jsonResponse(201, session(next));
  }, route);
  const { driver, shown } = chat(net);
  return { driver, network: net.api, shown, bootstraps: () => net.sessions.calls.length };
}

function startAnswer(): Response {
  return jsonResponse(202, { run: RUN, events: `/api/runs/${RUN.id}/events` });
}

const runs: Route = (request) =>
  request.method === 'POST' ? startAnswer() : eventStreamResponse(STREAM);

function resumeOf(request: RecordedRequest): unknown {
  return typeof request.json === 'object' && request.json !== null
    ? Reflect.get(request.json, 'resume')
    : undefined;
}

describe('sendSurfaceMessage (S1-17, #455)', () => {
  it('opens a session, starts a run in it and renders the streamed assistant text', async () => {
    const { driver, network, shown, bootstraps } = harness([FIRST], runs);

    await sendSurfaceMessage(driver, 'visitor-1', 'Where is my order?');

    expect(bootstraps()).toBe(1);
    const start = network.calls[0];
    expect(start?.url.pathname).toBe(`/api/agents/${RUN.agentId}/runs`);
    expect(start?.headers.get('authorization')).toBe(`Bearer ${FIRST}`);
    expect(start?.json).toMatchObject({ prompt: 'Where is my order?', sessionId: RUN.sessionId });
    expect(network.calls[1]?.url.pathname).toBe(`/api/runs/${RUN.id}/events`);

    const last = shown.at(-1);
    expect(last?.messages.map(messageParagraphs)).toEqual([
      ['Where is my order?'],
      ['Looking it up: it ships today.'],
    ]);
    expect(last?.heading.status?.label).toBe('Completed');
    expect(last?.failure).toBeNull();
    // The answer was shown while it streamed, not only once the stream ended.
    const streamed = shown.map((run) => run?.messages.slice(1).map(messageParagraphs));
    expect(streamed).toContainEqual([['Looking']]);
  });

  it('stops following, and shows no failure, once its chat is gone', async () => {
    const gone = new AbortController();
    const { driver, shown } = harness([FIRST], (request) => {
      if (request.method === 'POST') return startAnswer();
      gone.abort();
      return eventStreamResponse(STREAM);
    });

    await sendSurfaceMessage({ ...driver, signal: gone.signal }, 'visitor-1', 'Hi');

    const last = shown.at(-1);
    expect(last?.messages.map(messageParagraphs)).toEqual([['Hi']]);
    expect(last?.failure).toBeNull();
  });

  it('reuses the session for the next message', async () => {
    const { driver, bootstraps } = harness([FIRST], runs);
    await sendSurfaceMessage(driver, 'visitor-1', 'Where is my order?');
    await sendSurfaceMessage(driver, 'visitor-2', 'And the invoice?');
    expect(bootstraps()).toBe(1);
  });

  it('opens exactly one new session when the start answers 401, and sends there', async () => {
    const { driver, network, shown, bootstraps } = harness([OLD, NEW], (request) => {
      if (request.method !== 'POST') return eventStreamResponse(STREAM);
      return request.headers.get('authorization') === `Bearer ${OLD}`
        ? jsonResponse(401, { error: { code: 'unauthenticated', message: 'Token expired.' } })
        : startAnswer();
    });

    await sendSurfaceMessage(driver, 'visitor-1', 'Where is my order?');

    expect(bootstraps()).toBe(2);
    expect(network.calls.map((call) => call.headers.get('authorization'))).toEqual([
      `Bearer ${OLD}`,
      `Bearer ${NEW}`,
      `Bearer ${NEW}`,
    ]);
    expect(driver.session.current?.token).toBe(NEW);
    expect(shown.at(-1)?.failure).toBeNull();
  });

  describe('with attachments (ADR-0146, #1308)', () => {
    const SCAN = new File(['scan bytes'], 'scan 1.pdf', { type: 'application/pdf' });
    const NOTE = new File(['note'], 'note.txt');
    const stored = (name: string) => ({
      fileId: `file-${name}`,
      path: `.attachments/${SESSION_A}/u/${name}`,
      size: 4,
    });
    const isUpload = (request: RecordedRequest): boolean =>
      request.url.pathname.endsWith('/attachments');

    it('uploads each file with the session token, then starts the run with their fileIds', async () => {
      const { driver, network, shown } = harness([FIRST], (request) => {
        if (isUpload(request)) {
          return jsonResponse(201, stored(request.url.searchParams.get('name') ?? ''));
        }
        return request.method === 'POST' ? startAnswer() : eventStreamResponse(STREAM);
      });

      await sendSurfaceMessage(driver, 'visitor-1', 'Read these', [SCAN, NOTE]);

      const [first, second, start] = network.calls;
      expect(first?.url.pathname).toBe(`/api/sessions/${SESSION_A}/attachments`);
      expect(first?.url.searchParams.get('name')).toBe('scan 1.pdf');
      expect(first?.headers.get('authorization')).toBe(`Bearer ${FIRST}`);
      expect(first?.headers.get('content-type')).toBe('application/pdf');
      expect(first?.init.body).toBe(SCAN);
      expect(second?.headers.get('content-type')).toBe('application/octet-stream');
      expect(start?.json).toMatchObject({
        prompt: 'Read these',
        attachments: [{ fileId: 'file-scan 1.pdf' }, { fileId: 'file-note.txt' }],
      });
      expect(shown.at(-1)?.messages.map(messageParagraphs)[0]).toEqual([
        'Read these\n\nscan 1.pdf\nnote.txt',
      ]);
    });

    it('uploads a large photo downscaled on the send path (#1422 review)', async () => {
      vi.stubGlobal('createImageBitmap', () =>
        Promise.resolve({ width: 4096, height: 3072, close: () => undefined }),
      );
      vi.stubGlobal('document', {
        createElement: () => ({
          getContext: () => ({ drawImage: () => undefined }),
          toBlob: (done: (blob: Blob) => void, type: string) => {
            done(new Blob(['s'], { type }));
          },
        }),
      });
      const photo = new File(['large photo bytes'], 'photo.jpg', { type: 'image/jpeg' });
      const { driver, network } = harness([FIRST], (request) => {
        if (isUpload(request)) return jsonResponse(201, stored('photo.jpg'));
        return request.method === 'POST' ? startAnswer() : eventStreamResponse(STREAM);
      });

      try {
        await sendSurfaceMessage(driver, 'visitor-1', 'Look', [photo]);
      } finally {
        vi.unstubAllGlobals();
      }

      const body = network.calls[0]?.init.body;
      expect(body).not.toBe(photo);
      expect(body instanceof File && body.size).toBe(1);
      expect(network.calls[0]?.headers.get('content-type')).toBe('image/jpeg');
    });

    it('sends no attachments field when there are no files', async () => {
      const { driver, network } = harness([FIRST], runs);
      await sendSurfaceMessage(driver, 'visitor-1', 'Hi');
      expect(network.calls[0]?.json).not.toHaveProperty('attachments');
    });

    it('opens one new session when an upload answers 401, and uploads again there', async () => {
      const { driver, network, bootstraps } = harness([OLD, NEW], (request) => {
        if (isUpload(request)) {
          return request.headers.get('authorization') === `Bearer ${OLD}`
            ? jsonResponse(401, { error: { code: 'unauthenticated', message: 'Token expired.' } })
            : jsonResponse(201, stored('note.txt'));
        }
        return request.method === 'POST' ? startAnswer() : eventStreamResponse(STREAM);
      });

      await sendSurfaceMessage(driver, 'visitor-1', 'Read', [NOTE]);

      expect(bootstraps()).toBe(2);
      expect(network.calls.map((call) => call.headers.get('authorization'))).toEqual([
        `Bearer ${OLD}`,
        `Bearer ${NEW}`,
        `Bearer ${NEW}`,
        `Bearer ${NEW}`,
      ]);
    });

    it('does not upload a file twice when the start, not the upload, answers 401', async () => {
      const { driver, network } = harness([OLD, NEW], (request) => {
        if (isUpload(request)) return jsonResponse(201, stored('note.txt'));
        if (request.method !== 'POST') return eventStreamResponse(STREAM);
        return request.headers.get('authorization') === `Bearer ${OLD}`
          ? jsonResponse(401, { error: { code: 'unauthenticated', message: 'Token expired.' } })
          : startAnswer();
      });

      await sendSurfaceMessage(driver, 'visitor-1', 'Read', [NOTE]);

      expect(network.calls.filter(isUpload)).toHaveLength(1);
    });

    it('shows an upload refusal with its code and starts no run', async () => {
      const { driver, network, shown } = harness([FIRST], () =>
        jsonResponse(413, {
          error: { code: 'attachments_quota_exceeded', message: 'A session stores at most 20.' },
        }),
      );

      await sendSurfaceMessage(driver, 'visitor-1', 'Read', [NOTE]);

      expect(network.calls).toHaveLength(1);
      expect(shown.at(-1)?.failure).toEqual({
        code: 'attachments_quota_exceeded',
        message: 'A session stores at most 20.',
      });
    });
  });

  it('shows the refusal when the renewed session is refused too, and retries no further', async () => {
    const { driver, network, shown, bootstraps } = harness([OLD, NEW], () =>
      jsonResponse(401, { error: { code: 'unauthenticated', message: 'Token expired.' } }),
    );

    await sendSurfaceMessage(driver, 'visitor-1', 'Where is my order?');

    expect(bootstraps()).toBe(2);
    expect(network.calls).toHaveLength(2);
    expect(shown.at(-1)?.failure).toEqual({ code: 'unauthenticated', message: 'Token expired.' });
  });

  it('shows a bootstrap refusal with its code and starts nothing', async () => {
    const { driver, network, shown } = harness([], () => startAnswer());

    await sendSurfaceMessage(driver, 'visitor-1', 'Where is my order?');

    expect(network.calls).toEqual([]);
    expect(shown.at(-1)?.failure).toEqual({ code: 'surface_not_found', message: 'gone' });
  });

  it('shows an unreadable bootstrap plainly and logs the origin hint (BH061-016)', async () => {
    // A browser reports a CORS refusal exactly like this: fetch rejects with no answer.
    const net = network(() => Promise.reject(new TypeError('Failed to fetch')), runs);
    const { driver, shown } = chat(net);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await sendSurfaceMessage(driver, 'visitor-1', 'Hi');

    expect(net.api.calls).toEqual([]);
    expect(shown.at(-1)?.failure).toEqual({
      code: null,
      message: 'The assistant could not be reached. Please try again later.',
    });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('allowedOrigins'));
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch'));
    logged.mockRestore();
  });

  it("shows each tool call in the run's turn", async () => {
    const net = network(
      () => jsonResponse(201, session(FIRST)),
      (request) =>
        request.method === 'POST'
          ? startAnswer()
          : eventStreamResponse(
              toolCall('2') + agentMessage('3', 'msg_1', 'Done.') + 'event: done\ndata: null\n\n',
            ),
    );
    const { driver, turns } = chat(net);

    await sendSurfaceMessage(driver, 'visitor-1', 'Where is my order?');

    expect(turns.at(-1)).toMatchObject({
      runId: RUN.id,
      answerIds: ['assistant-msg_1'],
      tools: [{ id: 'call_1', name: 'lookup_order', input: { order: 42 }, output: null }],
    });
  });
});

describe('the visitor limits, in the surface language (#622)', () => {
  const limited = (code: string, retryAfter?: string): Response =>
    new Response(JSON.stringify({ error: { code, message: 'Refused by the server.' } }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
      },
    });

  it('shows a rate-limited start with its Retry-After wait', async () => {
    const { driver, shown } = harness([FIRST], () => limited('surface_rate_limited', '12'));
    await sendSurfaceMessage(driver, 'visitor-1', 'Hi');
    expect(shown.at(-1)?.failure).toEqual({
      code: 'surface_rate_limited',
      message: 'Too many messages. Try again in 12 s.',
    });
  });

  it('shows a rate-limited bootstrap, and starts nothing', async () => {
    const net = network(() => limited('surface_rate_limited', '30'), runs);
    const { driver, shown } = chat(net);
    await sendSurfaceMessage(driver, 'visitor-1', 'Hi');
    expect(net.api.calls).toEqual([]);
    expect(shown.at(-1)?.failure?.message).toBe('Too many messages. Try again in 30 s.');
  });

  it('shows the turn limit in Japanese', async () => {
    const { driver, shown } = harness([FIRST], () => limited('surface_turn_limit_reached'));
    await sendSurfaceMessage({ ...driver, strings: surfaceStrings('ja') }, 'visitor-1', 'やあ');
    expect(shown.at(-1)?.failure).toEqual({
      code: 'surface_turn_limit_reached',
      message: 'この会話はメッセージの上限に達しました。',
    });
  });

  it('forgets a conversation at its turn limit, so the next load opens a fresh one', async () => {
    const history = memoryHistory();
    writeSurfaceEntry(history, 'main', OWN, {
      sessionId: SESSION_A,
      resumeKey: KEY_A,
      runIds: [RUN.id],
    });
    const net = network(
      () => jsonResponse(201, session(FIRST)),
      () => limited('surface_turn_limit_reached'),
    );
    const { driver } = chat(net, OWN, history);

    await sendSurfaceMessage(driver, 'visitor-1', 'Hi');

    expect(net.sessions.calls.map((call) => call.json)).toEqual([
      { resume: { sessionId: SESSION_A, resumeKey: KEY_A } },
    ]);
    expect(surfaceEntryOf(readSurfaceHistory(history, 'main', OFFERED), OWN)).toBeNull();
    expect(driver.session.current).toBeNull();
  });
});

describe('the surface history, resume and replay (C18, #540)', () => {
  it('resumes a stored session on reload and replays its runs into the transcript', async () => {
    const history = memoryHistory();
    writeSurfaceEntry(history, 'main', OWN, {
      sessionId: SESSION_A,
      resumeKey: KEY_A,
      runIds: [RUN.id],
    });
    const net = network(() => jsonResponse(201, session(FIRST)), runs);
    const { driver, shown } = chat(net, OWN, history);

    await restoreSurfaceConversation(driver, PLACEHOLDER);

    expect(net.sessions.calls.map((call) => call.json)).toEqual([
      { resume: { sessionId: SESSION_A, resumeKey: KEY_A } },
    ]);
    expect(net.api.calls.map((call) => call.url.pathname)).toEqual([`/api/runs/${RUN.id}/events`]);
    expect(shown.at(-1)?.messages.map(messageParagraphs)).toEqual([
      [PLACEHOLDER],
      ['Looking it up: it ships today.'],
    ]);
    expect(driver.session.current?.token).toBe(FIRST);
    expect(surfaceEntryOf(readSurfaceHistory(history, 'main', OFFERED), OWN)?.runIds).toEqual([
      RUN.id,
    ]);
  });

  it('switching A → B → A and reloading resumes A with its history and keeps B', async () => {
    const history = memoryHistory();
    const net = network((request) => {
      if (resumeOf(request) !== undefined) return jsonResponse(201, session(NEW));
      const billing = typeof request.json === 'object';
      return jsonResponse(
        201,
        billing
          ? session(FIRST, { sessionId: SESSION_B, resumeKey: KEY_B })
          : session(FIRST, { resumeKey: KEY_A }),
      );
    }, runs);

    await sendSurfaceMessage(chat(net, OWN, history).driver, 'visitor-1', 'Hi A');
    selectSurfaceAgent(history, 'main', 'Billing');
    await sendSurfaceMessage(chat(net, 'Billing', history).driver, 'visitor-1', 'Hi B');
    selectSurfaceAgent(history, 'main', OWN);
    await restoreSurfaceConversation(chat(net, OWN, history).driver, PLACEHOLDER);

    // The reload: a new page reads the same storage.
    const stored = readSurfaceHistory(history, 'main', OFFERED);
    expect(stored.agent).toBe(OWN);
    const reloaded = chat(net, stored.agent ?? 'Billing', history);
    await restoreSurfaceConversation(reloaded.driver, PLACEHOLDER);

    expect(net.sessions.calls.map((call) => call.json)).toEqual([
      undefined,
      { agent: 'Billing' },
      { resume: { sessionId: SESSION_A, resumeKey: KEY_A } },
      { resume: { sessionId: SESSION_A, resumeKey: KEY_A } },
    ]);
    expect(reloaded.driver.session.current?.sessionId).toBe(SESSION_A);
    expect(reloaded.shown.at(-1)?.messages.map(messageParagraphs)).toEqual([
      [PLACEHOLDER],
      ['Looking it up: it ships today.'],
    ]);
    expect(surfaceEntryOf(readSurfaceHistory(history, 'main', OFFERED), 'Billing')).toEqual({
      sessionId: SESSION_B,
      resumeKey: KEY_B,
      runIds: [RUN.id],
    });
  });

  it('stores nothing when the surface does not keep history', async () => {
    let writes = 0;
    let reads = 0;
    const spy: SurfaceHistoryStorage = {
      getItem: () => {
        reads += 1;
        return null;
      },
      setItem: () => {
        writes += 1;
      },
    };
    const net = network(() => jsonResponse(201, session(FIRST, { resumeKey: KEY_A })), runs);
    const { driver } = chat(
      net,
      OWN,
      surfaceHistoryStorage(false, () => spy),
    );

    await sendSurfaceMessage(driver, 'visitor-1', 'Hi');

    expect(writes).toBe(0);
    expect(reads).toBe(0);
  });

  it('forgets a session the server will not resume, and opens a fresh one once', async () => {
    const history = memoryHistory();
    writeSurfaceEntry(history, 'main', OWN, {
      sessionId: SESSION_A,
      resumeKey: KEY_A,
      runIds: [RUN.id],
    });
    const net = network(
      (request) =>
        resumeOf(request) === undefined
          ? jsonResponse(201, session(FIRST, { sessionId: SESSION_B, resumeKey: KEY_B }))
          : jsonResponse(404, {
              error: { code: 'surface_session_not_resumable', message: 'No such session.' },
            }),
      runs,
    );
    const { driver } = chat(net, OWN, history);

    await restoreSurfaceConversation(driver, PLACEHOLDER);

    expect(net.sessions.calls.map((call) => call.json)).toEqual([
      { resume: { sessionId: SESSION_A, resumeKey: KEY_A } },
      undefined,
    ]);
    expect(net.api.calls).toEqual([]);
    expect(surfaceEntryOf(readSurfaceHistory(history, 'main', OFFERED), OWN)).toEqual({
      sessionId: SESSION_B,
      resumeKey: KEY_B,
      runIds: [],
    });
  });

  it('leaves the transcript as it was when a stored run cannot be replayed (#628)', async () => {
    const history = memoryHistory();
    writeSurfaceEntry(history, 'main', OWN, {
      sessionId: SESSION_A,
      resumeKey: KEY_A,
      runIds: ['gone', RUN.id],
    });
    const net = network(
      () => jsonResponse(201, session(FIRST)),
      (request) =>
        request.url.pathname.includes('/gone/')
          ? jsonResponse(404, { error: { code: 'run_not_found', message: 'gone' } })
          : eventStreamResponse(STREAM),
    );
    const { driver, shown } = chat(net, OWN, history);

    await restoreSurfaceConversation(driver, PLACEHOLDER);

    expect(shown).toContain(null);
    expect(shown.at(-1)?.messages.map(messageParagraphs)).toEqual([
      [PLACEHOLDER],
      ['Looking it up: it ships today.'],
    ]);
  });

  it("drops a failed replay's turn when its stream errors after a tool frame (#628)", async () => {
    const history = memoryHistory();
    writeSurfaceEntry(history, 'main', OWN, {
      sessionId: SESSION_A,
      resumeKey: KEY_A,
      runIds: [RUN.id, 'broken'],
    });
    const net = network(
      () => jsonResponse(201, session(FIRST)),
      (request) =>
        request.url.pathname.includes('/broken/')
          ? // A tool frame, then a frame the SDK refuses (a reconnect would only wait and retry).
            eventStreamResponse(toolCall('1') + 'event: run.status\nid: 2\ndata: {}\n\n')
          : eventStreamResponse(STREAM),
    );
    const { driver, shown, turns } = chat(net, OWN, history);

    await restoreSurfaceConversation(driver, PLACEHOLDER);

    expect(turns.map((turn) => turn.runId)).not.toContain('broken');
    expect(shown.at(-1)?.messages.map(messageParagraphs)).toEqual([
      [PLACEHOLDER],
      ['Looking it up: it ships today.'],
    ]);
  });

  it('resumes the same session when a start answers 401 and the key is held', async () => {
    const net = network(
      (request) =>
        jsonResponse(
          201,
          resumeOf(request) === undefined ? session(OLD, { resumeKey: KEY_A }) : session(NEW),
        ),
      (request) => {
        if (request.method !== 'POST') return eventStreamResponse(STREAM);
        return request.headers.get('authorization') === `Bearer ${OLD}`
          ? jsonResponse(401, { error: { code: 'unauthenticated', message: 'Token expired.' } })
          : startAnswer();
      },
    );
    const { driver, shown } = chat(net);

    await sendSurfaceMessage(driver, 'visitor-1', 'Where is my order?');

    expect(net.sessions.calls.map((call) => call.json)).toEqual([
      undefined,
      { resume: { sessionId: SESSION_A, resumeKey: KEY_A } },
    ]);
    expect(driver.session.current?.token).toBe(NEW);
    expect(shown.at(-1)?.failure).toBeNull();
  });
});

describe('sendSurfaceFeedback (C19, #540)', () => {
  it('posts a rating once with the session token, however often it is pressed', async () => {
    const net = network(() => jsonResponse(201, session(FIRST)), runs);
    const { driver } = chat(net);
    driver.session.current = session(FIRST);

    const outcomes = await Promise.all([
      sendSurfaceFeedback(driver, RUN.id, 'up'),
      sendSurfaceFeedback(driver, RUN.id, 'down'),
    ]);

    expect(outcomes).toEqual(['sent', 'already']);
    expect(net.feedback.calls).toHaveLength(1);
    expect(net.feedback.calls[0]?.url.pathname).toBe(`/api/runs/${RUN.id}/feedback`);
    expect(net.feedback.calls[0]?.headers.get('authorization')).toBe(`Bearer ${FIRST}`);
    expect(net.feedback.calls[0]?.json).toEqual({ rating: 'up' });
  });

  const expiredOld: Route = (request) =>
    request.headers.get('authorization') === `Bearer ${OLD}`
      ? jsonResponse(401, { error: { code: 'unauthenticated', message: 'Token expired.' } })
      : jsonResponse(204, null);
  const storedA = { sessionId: SESSION_A, resumeKey: KEY_A, runIds: [RUN.id] };

  it('resumes the same session on a 401 and rates there (#628)', async () => {
    const history = memoryHistory();
    writeSurfaceEntry(history, 'main', OWN, storedA);
    const net = network(() => jsonResponse(201, session(NEW)), runs, expiredOld);
    const { driver } = chat(net, OWN, history);
    driver.session.current = session(OLD);

    await expect(sendSurfaceFeedback(driver, RUN.id, 'up')).resolves.toBe('sent');

    expect(net.sessions.calls.map((call) => call.json)).toEqual([
      { resume: { sessionId: SESSION_A, resumeKey: KEY_A } },
    ]);
    expect(net.feedback.calls.map((call) => call.headers.get('authorization'))).toEqual([
      `Bearer ${OLD}`,
      `Bearer ${NEW}`,
    ]);
    await expect(sendSurfaceFeedback(driver, RUN.id, 'up')).resolves.toBe('already');
  });

  it('opens no session on a 401 when no key for this session is held (#628)', async () => {
    const net = network(
      () => jsonResponse(201, session(NEW, { resumeKey: KEY_B })),
      runs,
      expiredOld,
    );
    const { driver } = chat(net);
    const old = session(OLD);
    driver.session.current = old;

    await expect(sendSurfaceFeedback(driver, RUN.id, 'up')).resolves.toBe('failed');

    expect(net.sessions.calls).toEqual([]);
    expect(driver.session.current).toBe(old);
  });

  it('opens no fresh session on a 401 when the resume is refused (#628)', async () => {
    const history = memoryHistory();
    writeSurfaceEntry(history, 'main', OWN, storedA);
    const net = network(
      () =>
        jsonResponse(404, {
          error: { code: 'surface_session_not_resumable', message: 'No such session.' },
        }),
      runs,
      expiredOld,
    );
    const { driver } = chat(net, OWN, history);
    const old = session(OLD);
    driver.session.current = old;

    await expect(sendSurfaceFeedback(driver, RUN.id, 'up')).resolves.toBe('failed');

    expect(net.sessions.calls).toHaveLength(1);
    expect(driver.session.current).toBe(old);
    expect(surfaceEntryOf(readSurfaceHistory(history, 'main', OFFERED), OWN)).toEqual(storedA);
    expect(net.feedback.calls).toHaveLength(1);
  });

  it('lets a rating that was not sent be pressed again (#628)', async () => {
    let answers = 0;
    const net = network(
      () => jsonResponse(201, session(FIRST)),
      runs,
      () => {
        answers += 1;
        return answers === 1
          ? jsonResponse(503, { error: { code: 'unavailable', message: 'Try later.' } })
          : jsonResponse(204, null);
      },
    );
    const { driver } = chat(net);
    driver.session.current = session(FIRST);

    await expect(sendSurfaceFeedback(driver, RUN.id, 'up')).resolves.toBe('problem');
    await expect(sendSurfaceFeedback(driver, RUN.id, 'up')).resolves.toBe('sent');
    expect(net.feedback.calls).toHaveLength(2);
  });

  it('posts nothing without a session', async () => {
    const net = network(() => jsonResponse(201, session(FIRST)), runs);
    await expect(sendSurfaceFeedback(chat(net).driver, RUN.id, 'up')).resolves.toBe('failed');
    expect(net.feedback.calls).toEqual([]);
  });
});

describe('the browser transport’s Agent Workspace (#623)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The URL the transport's SDK client asks for one run on. */
  async function runUrlOf(baseUrl?: string): Promise<string> {
    const urls: string[] = [];
    vi.stubGlobal('window', { location: { origin: ORIGIN } });
    vi.stubGlobal('fetch', (input: RequestInfo | URL): Promise<Response> => {
      urls.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(jsonResponse(200, { run: RUN }));
    });
    await browserSurfaceChatTransport(undefined, baseUrl)
      .clientFor(session(FIRST))
      .runs.get(RUN.id);
    return urls[0] ?? '';
  }

  it('runs on the page’s own origin by default, and on a baseUrl, prefix kept, when given', async () => {
    expect(await runUrlOf()).toBe(`${ORIGIN}/api/runs/${RUN.id}`);
    expect(await runUrlOf('https://shop.example.com/agents')).toBe(
      `https://shop.example.com/agents/api/runs/${RUN.id}`,
    );
  });
});
