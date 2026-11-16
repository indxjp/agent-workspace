/**
 * The runtime interrupt signal's deadline (issue #235, S-14).
 *
 * `POST /api/runs/:id/interrupt` awaits this signal, so an unreachable-but-connected runtime must
 * not be able to hold that request open after the durable half of the interrupt — terminal status
 * and token revocation — has already been committed. See `./interrupt.ts`'s own header.
 */
import { log as webLogger } from '../telemetry/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { interruptRunFor } from './api';
import type { RunApiEnvironment, RunPrincipal } from './environment';
import { registerLiveRun, resetLiveRuns, signalLiveRun, signalRuntimeInterrupt } from './interrupt';
import { InMemoryRunStore } from './memory-store';
import type { RunRecord } from './store';

const RUN = '11111111-1111-4111-8111-111111111111';
const BASE = 'http://runner:8080';

afterEach(() => {
  resetLiveRuns();
  vi.restoreAllMocks();
});

describe('signalRuntimeInterrupt', () => {
  it('gives up on a runtime that accepts the connection and never answers', async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    // Nothing settles this request but its deadline: a blackholed container, in one fixture.
    const attached: { signal?: AbortSignal | null } = {};
    const doFetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal ?? null;
        attached.signal = signal;
        signal?.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        });
      });

    await expect(
      signalRuntimeInterrupt(BASE, RUN, { authorization: 'Bearer runner' }, doFetch, 20),
    ).resolves.toBeUndefined();

    expect(attached.signal?.aborted).toBe(true);
    // The deadline is an upstream failure, reported rather than swallowed.
    expect(log).toHaveBeenCalledWith('[runs] interrupt-runtime failed', expect.anything());
  });

  it('reports a runner that refuses the signal, so a 409 is not logged like a delivered one', async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    // §14.3: the runner answers `409 no_run_in_flight` when it is not holding the run — reachable
    // while the launcher has registered the run but has not yet posted it to the runtime.
    const doFetch: typeof globalThis.fetch = () =>
      Promise.resolve(Response.json({ error: 'no_run_in_flight' }, { status: 409 }));

    await expect(
      signalRuntimeInterrupt(BASE, RUN, { authorization: 'Bearer runner' }, doFetch),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith('[runs] interrupt-runtime failed', expect.anything());
  });

  it('carries the deadline on the registry path a served interrupt takes', async () => {
    registerLiveRun(RUN, { base: BASE, headers: { authorization: 'Bearer runner' } });
    const attached: { signal?: AbortSignal | null } = {};

    await signalLiveRun(RUN, (_input, init) => {
      attached.signal = init?.signal ?? null;
      return Promise.resolve(Response.json({}, { status: 202 }));
    });

    expect(attached.signal).toBeInstanceOf(AbortSignal);
    // A runtime that answers is not aborted by its own deadline.
    expect(attached.signal?.aborted).toBe(false);
  });
});

describe('interruptRunFor: a team lead run cascades to its live children (ADR-0104 decision 8)', () => {
  const WORKSPACE = '22222222-2222-4222-8222-222222222222';
  const PRINCIPAL: RunPrincipal = {
    principalId: '77777777-7777-4777-8777-777777777777',
    ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
    userId: null,
    workspaceId: WORKSPACE,
    scope: null,
  };

  async function tree() {
    const store = new InMemoryRunStore();
    const create = (id: string, parent?: string) =>
      store.create({
        id,
        workspaceId: WORKSPACE,
        agentId: 'agent',
        sessionId: `session-${id}`,
        engine: 'claude-agent-sdk',
        ...(parent === undefined ? {} : { parent: { runId: parent, maxChildren: 16 } }),
      });
    const root = await create('root');
    await store.markRunning('root');
    await create('queued', 'root');
    await create('running', 'root');
    await store.markRunning('running');
    await create('paused', 'root');
    await store.markRunning('paused');
    await store.awaitApproval('paused', { toolName: 'Bash', canonicalCall: '{}' });
    await create('done', 'root');
    await store.markRunning('done');
    await store.finish('done', 'completed', null);
    const interrupted: string[] = [];
    const env: RunApiEnvironment = {
      authenticate: () => Promise.resolve(PRINCIPAL),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      launch: () => undefined,
      store,
      interruptRun: async (_principal: RunPrincipal, run: RunRecord) => {
        interrupted.push(run.id);
        await store.finish(run.id, 'cancelled', 'the run was interrupted by request', true);
      },
    };
    return { store, env, root, interrupted };
  }

  it('interrupts the root and every queued, running or paused child, and no stopped one', async () => {
    const { store, env, root, interrupted } = await tree();
    expect(await interruptRunFor(env, PRINCIPAL, root)).toBe('stopped');
    expect(interrupted.sort()).toEqual(['paused', 'queued', 'root', 'running']);
    const children = await store.listChildren(WORKSPACE, 'root', 16);
    expect(
      children.filter((child) => child.status === 'queued' || child.status === 'running'),
    ).toEqual([]);
    expect(children.find((child) => child.id === 'done')?.status).toBe('completed');
  });

  it('still stops the live children of a root that already ended', async () => {
    const { store, env, interrupted } = await tree();
    await store.finish('root', 'failed', 'the lead failed');
    const ended = await store.get('root');
    if (ended === null) throw new Error('the root vanished');
    expect(await interruptRunFor(env, PRINCIPAL, ended)).toBe('terminal');
    expect(interrupted.sort()).toEqual(['paused', 'queued', 'running']);
  });

  it('never cascades from a child, which has no children of its own', async () => {
    const { store, env, interrupted } = await tree();
    const child = await store.get('running');
    if (child === null) throw new Error('the child vanished');
    await interruptRunFor(env, PRINCIPAL, child);
    expect(interrupted).toEqual(['running']);
  });
});
