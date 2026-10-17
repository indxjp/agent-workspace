/**
 * The `session-state` vectors, replayed against the **runner's client** (ENG-06, #305).
 *
 * Decision D-012: a suite that imports application code lives with the application. This one drives
 * `apps/runner/src/session-state.ts` — the store an engine adapter is actually handed — and
 * `apps/runner/src/runtime.ts`'s durability fold, and compares them to what
 * `formal/AgentWorkspace/Behaviour/SessionState.lean` says they must do. A disagreement is a failing
 * test, and the fix is never to edit a vector (`docs/formal/00-orchestrator-prompt.md` §10).
 *
 * Two of the family's six files are replayed here — the two that are about the client rather than
 * the control plane:
 *
 *   * `stream-keys.json` — a Claude `SessionKey` as the one opaque stream key the store is keyed by;
 *   * `durability.json` — the engine-neutral verdict, driven through the **scripted** engine, which
 *     has no way of its own to notice a failed write. That is what makes the answer a statement
 *     about the store rather than about one adapter.
 *
 * The other four are about the routes and are replayed by `apps/web/formal/session-state.test.ts`.
 */
import type { EngineRunRequest } from '@agent-workspace/engine';
import { engineStreamKey, withStoreWriteFailures } from '@agent-workspace/engine';
import { createScriptedEngine, SCRIPTED_ENGINE_ID } from '@agent-workspace/engine/testing';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors.js';
import { createHttpEngineSessionStore } from '../src/session-state.js';
import { startEngineAgent } from '../src/runtime.js';

const FAMILY = 'session-state';
const SESSION = '11111111-2222-4333-8444-555555555555';

describe('session-state: a Claude session key becomes one opaque stream key', () => {
  const vectors = loadVectors(FAMILY, 'stream-keys.json');

  it.each(vectors)('$id', ({ id, input, expected }) => {
    const request = asRecord(input, id);
    const subpath = asString(request['subpath'], `${id}.subpath`);
    const key = {
      projectKey: asString(request['projectKey'], `${id}.projectKey`),
      sessionId: SESSION,
      // The model's empty subpath is the *main* transcript, which the port spells as an absent
      // field rather than as `''` — R-01 §7 records the empty string as invalid, and collapsing the
      // two would make one stream out of two keys.
      ...(subpath === '' ? {} : { subpath }),
    };
    expect(engineStreamKey(key)).toBe(asRecord(expected, id)['streamKey']);
  });

  it('is the key the client actually sends, not only the one the helper renders', async () => {
    // The helper agreeing with the model proves nothing if the client builds its key some other
    // way. This drives a real `append()` and reads the key off the request body.
    let body = '';
    const store = createHttpEngineSessionStore({
      baseUrl: 'https://control.example',
      token: 'run-token',
      engine: 'claude-agent-sdk',
      fetch: (_input: unknown, init?: RequestInit) => {
        body = typeof init?.body === 'string' ? init.body : '';
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    await store.append({ projectKey: 'w1', sessionId: SESSION }, [{ type: 'user' }]);
    expect(JSON.parse(body)).toMatchObject({ streamKey: 'w1/' });
  });
});

describe('session-state: the durability verdict is the store’s as much as the adapter’s', () => {
  const vectors = loadVectors(FAMILY, 'durability.json');

  /** A run that produced frames and reached a terminal one, so the adapter's own answer is `true`. */
  const request: EngineRunRequest = {
    runId: '33333333-4444-4555-8666-777777777777',
    sessionId: SESSION,
    projectKey: 'tenant-a',
    cwd: '/workspace/session',
    prompt: 'hello',
    engine: SCRIPTED_ENGINE_ID,
    portable: {
      name: 'Scripted',
      instructions: '',
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: true,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: { kind: 'scripted' },
    session: { mode: 'fresh' },
    gateway: {
      baseUrl: 'https://gateway.example',
      token: 'run-token',
      protocol: 'anthropic-messages',
    },
    resources: { files: [], skills: [] },
    env: { PATH: '/usr/bin' },
  };

  it.each(vectors)('$id', ({ id, input, expected }) => {
    const request_ = asRecord(input, id);
    const adapterSaysDurable = request_['adapterSaysDurable'];
    const failures = request_['storeWriteFailures'];
    if (typeof adapterSaysDurable !== 'boolean' || typeof failures !== 'number') {
      throw new Error(`${id}: the vector does not carry the two inputs of the verdict`);
    }
    const adapterVerdict = adapterSaysDurable
      ? ({ durable: true, mirroredBatches: 1 } as const)
      : ({ durable: false, reason: 'the adapter observed no store' } as const);
    const folded = withStoreWriteFailures(
      adapterVerdict,
      Array.from({ length: failures }, (_, index) => `write ${String(index)} failed`),
    );
    expect(folded.durable).toBe(asRecord(expected, id)['durable']);
  });

  it('holds for an engine that cannot notice a failed write itself', async () => {
    // The scripted adapter has no `mirror_error` concept. If the verdict is still `false`, it is
    // `false` because the STORE said so — which is the only way the claim can hold for an engine
    // nobody has written yet.
    const failing = {
      append: () => Promise.reject(new Error('the control plane refused this batch')),
      load: () => Promise.resolve(null),
      writeFailures: () => ['the control plane refused this batch'],
    };
    const outcome = startEngineAgent(createScriptedEngine(), request, { sessionStore: failing });
    if (!outcome.ok) throw new Error(`the scripted engine refused the request: ${outcome.reason}`);
    for await (const frame of outcome.connection.frames) void frame;
    expect(outcome.connection.sessionDurability().durable).toBe(false);
  });
});
