/**
 * The runner's client of the engine-scoped session store (ENG-06, #305).
 *
 * Three things are being checked and the first is the one that matters most.
 *
 *  1. **It is a store an engine will accept, proved by the compiler.** Assigning it into
 *     `EngineStartContext.sessionStore` — as {@link acceptedByTheEnginePort} does below — is a
 *     compile-time proof that what this file builds satisfies the port's own interface, obtained
 *     without importing any engine SDK. That is spec §42 exercised rather than asserted, and it is
 *     one half of a chain: `packages/engine-claude-agent-sdk/src/engine.ts`'s `toTranscriptMirror`
 *     is declared `(store: EngineSessionStore) => TranscriptMirror`, and `boundary.ts`'s
 *     `instrumentSessionStore(store: SameShapeAs<TranscriptMirror, SessionStore>, …)` collapses to
 *     `never` unless `TranscriptMirror` and the SDK's own `SessionStore` stay mutually assignable.
 *
 *  2. **Every write that failed is recorded**, because that is what makes the durability verdict
 *     engine-neutral (`packages/engine/src/session-state.ts`'s `withStoreWriteFailures`).
 *
 *  3. **Nothing is half-understood.** A 200 whose body this client only partly recognises is an
 *     error, never a shorter stream: an engine resumes from what `load()` returns.
 */
import { describe, expect, it } from 'vitest';

import type { EngineStartContext } from '@agent-workspace/engine';

import { createHttpEngineSessionStore } from './session-state.js';

const TOKEN = 'runner-state-secret';
const PROJECT = 'c8b1f0de-6a2e-4a1f-9d3b-000000000001';
const SESSION = '11111111-2222-4333-8444-555555555555';
const ENGINE = 'claude-agent-sdk';
const KEY = { projectKey: PROJECT, sessionId: SESSION };
const BASE = 'https://control.example';

/**
 * The §42 proof described in this file's header. A *declaration*, not a call: what is asserted is
 * that this program type-checks, and it does not unless the store satisfies `EngineSessionStore`.
 */
const acceptedByTheEnginePort: EngineStartContext = {
  sessionStore: createHttpEngineSessionStore({ baseUrl: BASE, token: TOKEN, engine: ENGINE }),
};

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly authorization: string | undefined;
}

function storeAnswering(answer: (url: string, init: RequestInit) => Response): {
  store: ReturnType<typeof createHttpEngineSessionStore>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      authorization: headers.get('authorization') ?? undefined,
    });
    return Promise.resolve(answer(url, init ?? {}));
  };
  return {
    store: createHttpEngineSessionStore({
      baseUrl: BASE,
      token: TOKEN,
      engine: ENGINE,
      fetch: fetchImpl,
    }),
    calls,
  };
}

function page(entries: readonly unknown[], nextCursor: number | null): Response {
  return new Response(JSON.stringify({ entries, nextCursor }), { status: 200 });
}

describe('createHttpEngineSessionStore', () => {
  it('appends with the per-run signed token, naming its engine and its stream', async () => {
    const { store, calls } = storeAnswering(() => new Response(null, { status: 204 }));
    await store.append(KEY, [{ type: 'user', uuid: 'a' }]);
    expect(calls).toEqual([
      {
        url: `${BASE}/api/sessions/${SESSION}/state-entries`,
        method: 'POST',
        body: JSON.stringify({
          engine: ENGINE,
          // `projectKey` + `/` + `subpath`, with the empty suffix for the main transcript.
          streamKey: `${PROJECT}/`,
          entries: [{ entryKey: 'a', entry: { type: 'user', uuid: 'a' } }],
        }),
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
  });

  it('derives the idempotency key from the engine, and omits it when the entry has none', async () => {
    const { store, calls } = storeAnswering(() => new Response(null, { status: 204 }));
    await store.append(KEY, [{ type: 'summary' }]);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      engine: ENGINE,
      streamKey: `${PROJECT}/`,
      entries: [{ entry: { type: 'summary' } }],
    });

    const unknownEngine = createHttpEngineSessionStore({
      baseUrl: BASE,
      token: TOKEN,
      engine: 'not-an-engine-this-table-knows',
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });
    // No declared field means append-only semantics rather than a guessed key: inventing one would
    // claim an idempotency the engine never promised.
    await expect(unknownEngine.append(KEY, [{ type: 'user', uuid: 'a' }])).resolves.toBeUndefined();
  });

  it('keys a pi line by its own id, so a retried append stores it once (ENG-08, #307)', async () => {
    const calls: string[] = [];
    const pi = createHttpEngineSessionStore({
      baseUrl: BASE,
      token: TOKEN,
      engine: 'pi',
      fetch: (_url, init) => {
        calls.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    await pi.append(KEY, [
      { type: 'session', id: SESSION, version: 3 },
      { type: 'message', id: 'a1b2c3d4', parentId: null },
    ]);
    expect(JSON.parse(calls[0] ?? '{}')).toMatchObject({
      engine: 'pi',
      entries: [
        { entryKey: SESSION, entry: { type: 'session', id: SESSION, version: 3 } },
        { entryKey: 'a1b2c3d4', entry: { type: 'message', id: 'a1b2c3d4', parentId: null } },
      ],
    });
  });

  it('keys a Mastra memory entry by its key, so an updated message replaces itself (ENG-10, #309)', async () => {
    const calls: string[] = [];
    const mastra = createHttpEngineSessionStore({
      baseUrl: BASE,
      token: TOKEN,
      engine: 'mastra',
      fetch: (_url, init) => {
        calls.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    await mastra.append(KEY, [
      { type: 'mastra.thread', key: 'thread', thread: { id: SESSION } },
      { type: 'mastra.message', key: 'message:m1', message: { id: 'm1' } },
    ]);
    expect(JSON.parse(calls[0] ?? '{}')).toMatchObject({
      engine: 'mastra',
      entries: [
        { entryKey: 'thread', entry: { type: 'mastra.thread' } },
        { entryKey: 'message:m1', entry: { type: 'mastra.message' } },
      ],
    });
  });

  it('puts a subagent stream under its own key', async () => {
    const { store, calls } = storeAnswering(() => new Response(null, { status: 204 }));
    await store.append({ ...KEY, subpath: 'subagents/agent-7' }, []);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
      streamKey: `${PROJECT}/subagents/agent-7`,
    });
  });

  it('rejects when the control plane refuses a batch, naming the status and §14.9', async () => {
    const { store } = storeAnswering(
      () => new Response('{"error":{"code":"session_engine_mismatch"}}', { status: 409 }),
    );
    await expect(store.append(KEY, [{ type: 'user' }])).rejects.toThrow(/answered 409/);
    await expect(store.append(KEY, [{ type: 'user' }])).rejects.toThrow(/§14\.9/);
  });

  it('records every failed write, which is what makes the durability verdict engine-neutral', async () => {
    const { store } = storeAnswering(() => new Response('nope', { status: 500 }));
    expect(store.writeFailures?.()).toEqual([]);
    await expect(store.append(KEY, [{ type: 'user' }])).rejects.toThrow();
    await expect(store.delete?.(KEY)).rejects.toThrow();
    expect(store.writeFailures?.()).toHaveLength(2);
    expect(store.writeFailures?.()[0]).toMatch(/answered 500/);
  });

  it('rejects when the control plane cannot be reached at all', async () => {
    const store = createHttpEngineSessionStore({
      baseUrl: BASE,
      token: TOKEN,
      engine: ENGINE,
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(store.append(KEY, [])).rejects.toThrow(/could not be reached: ECONNREFUSED/);
    expect(store.writeFailures?.()).toHaveLength(1);
  });

  it('follows the cursor until the control plane stops giving one', async () => {
    let call = 0;
    const { store, calls } = storeAnswering(() => {
      call += 1;
      return call === 1
        ? page([{ sequence: 1, entryKey: 'a', entry: { type: 'user', uuid: 'a' } }], 1)
        : page([{ sequence: 2, entryKey: null, entry: { type: 'summary' } }], null);
    });
    await expect(store.load(KEY)).resolves.toEqual([
      { type: 'user', uuid: 'a' },
      { type: 'summary' },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('after=1');
    expect(calls[0]?.url).toContain(`streamKey=${encodeURIComponent(`${PROJECT}/`)}`);
  });

  it('turns a 404 into null, because that is the store saying "never written"', async () => {
    const { store } = storeAnswering(() => new Response('{}', { status: 404 }));
    await expect(store.load(KEY)).resolves.toBeNull();
  });

  it('rejects a 200 whose body is not a stream rather than resuming from part of one', async () => {
    const { store } = storeAnswering(
      () => new Response('{"entries":[{"sequence":1,"entry":{"no":"type"}}],"nextCursor":null}'),
    );
    await expect(store.load(KEY)).rejects.toThrow(/cannot be trusted to be complete/);
  });

  it('replaces, deletes the last entry and deletes the stream', async () => {
    const { store, calls } = storeAnswering(() => new Response(null, { status: 204 }));
    await store.replaceAll?.(KEY, [{ type: 'user', uuid: 'b' }]);
    await store.deleteLast?.(KEY);
    await store.delete?.(KEY);
    expect(calls.map((one) => one.method)).toEqual(['PUT', 'DELETE', 'DELETE']);
    expect(calls[1]?.url).toContain('last=1');
    expect(calls[2]?.url).not.toContain('last=');
  });

  it('lists this engine’s subagent streams, and refuses a body it only half understands', async () => {
    const listed = storeAnswering(
      () =>
        new Response(
          JSON.stringify({
            streams: [
              { engine: ENGINE, streamKey: `${PROJECT}/`, updatedAt: 5 },
              { engine: ENGINE, streamKey: `${PROJECT}/subagents/a-1`, updatedAt: 6 },
              { engine: 'another-engine', streamKey: `${PROJECT}/subagents/a-2`, updatedAt: 7 },
            ],
          }),
          { status: 200 },
        ),
    );
    // The main stream is not a subkey, and another engine's stream is not this engine's business.
    await expect(listed.store.listSubkeys?.(KEY)).resolves.toEqual(['subagents/a-1']);
    expect(listed.calls[0]?.url).toBe(`${BASE}/api/sessions/${SESSION}/state-streams`);

    const broken = storeAnswering(
      () => new Response(JSON.stringify({ streams: [{ streamKey: 7 }] }), { status: 200 }),
    );
    await expect(broken.store.listSubkeys?.(KEY)).rejects.toThrow(/not \{ streams/);
  });

  it('refuses an over-cap blob before it sends one, and round-trips one under the cap', async () => {
    const { store, calls } = storeAnswering((url) =>
      url.includes('state-blobs') && calls.at(-1)?.method === 'GET'
        ? new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        : new Response(null, { status: 204 }),
    );
    await store.putBlob?.(KEY, 'state.tar', new Uint8Array([1, 2, 3]));
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe(
      `${BASE}/api/sessions/${SESSION}/state-blobs?engine=${ENGINE}&blobKey=state.tar`,
    );
    await expect(store.getBlob?.(KEY, 'state.tar')).resolves.toEqual(new Uint8Array([1, 2, 3]));

    const huge = new Uint8Array(0);
    Object.defineProperty(huge, 'byteLength', { value: 33 * 1024 * 1024 });
    await expect(store.putBlob?.(KEY, 'state.tar', huge)).rejects.toThrow(
      /exceeds the store's cap/,
    );
  });

  it('implements every member of the port that this store can serve', () => {
    const store = acceptedByTheEnginePort.sessionStore;
    expect(store).toBeDefined();
    // An EQUALITY, so an added member is a decision rather than a quiet widening.
    // `listSessions` and `listSessionSummaries` are the two deliberate absences: listing a
    // workspace's sessions is a control-plane read (`GET /api/sessions`), not session state, and
    // the summary sidecar needs the Agent SDK's own `foldSessionSummary`, which only
    // `packages/engine-claude-agent-sdk/src/boundary.ts` may import (spec §42).
    expect(new Set(Object.keys(store ?? {}))).toEqual(
      new Set([
        'append',
        'replaceAll',
        'load',
        'delete',
        'deleteLast',
        'listSubkeys',
        'putBlob',
        'getBlob',
        'writeFailures',
      ]),
    );
  });
});
