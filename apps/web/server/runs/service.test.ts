/**
 * `startRunOnSession` and the session it opens: a start whose run insert fails must not leave an
 * empty new session behind, and must never remove a session the client brought (issue #1263).
 * The admission refusals are in `service.admission.test.ts`, the team child runs in
 * `service.children.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

import { parseStartRunBody } from './api';
import type { RunApiEnvironment } from './environment';
import { startRunOnSession } from './service';
import {
  AGENT,
  EXISTING_SESSION,
  PRINCIPAL,
  START,
  harness,
  sessionIds,
} from './service.test-support';
import { SessionBusyError } from './store';
import { log as webLogger } from '../telemetry/logger';

describe('startRunOnSession: a failed run insert', () => {
  it('discards the new session and rethrows the failure', async () => {
    const { env, sessions, store } = harness();
    vi.spyOn(store, 'create').mockRejectedValue(new Error('insert failed'));

    await expect(startRunOnSession(env, PRINCIPAL, AGENT, START)).rejects.toThrow('insert failed');
    expect(sessionIds(sessions)).toEqual([EXISTING_SESSION]);
  });

  it('discards the new session and answers 409 session_busy', async () => {
    const { env, sessions, store } = harness();
    vi.spyOn(store, 'create').mockRejectedValue(new SessionBusyError(EXISTING_SESSION));

    await expect(startRunOnSession(env, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'refused',
      status: 409,
      code: 'session_busy',
    });
    expect(sessionIds(sessions)).toEqual([EXISTING_SESSION]);
  });

  it('keeps the session of a follow-up, which the client opened', async () => {
    const { env, sessions, store } = harness();
    vi.spyOn(store, 'create').mockRejectedValue(new Error('insert failed'));

    await expect(
      startRunOnSession(env, PRINCIPAL, AGENT, { ...START, sessionId: EXISTING_SESSION }),
    ).rejects.toThrow('insert failed');
    expect(sessions.has(EXISTING_SESSION)).toBe(true);
  });

  it('still surfaces the insert failure when the discard itself fails', async () => {
    const logged = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    try {
      const { env, store } = harness(() => Promise.reject(new Error('discard failed')));
      vi.spyOn(store, 'create').mockRejectedValue(new Error('insert failed'));

      await expect(startRunOnSession(env, PRINCIPAL, AGENT, START)).rejects.toThrow(
        'insert failed',
      );
      expect(logged).toHaveBeenCalledWith(
        '[runs] could not discard the session opened for a failed start',
        { error: new Error('discard failed') },
      );
    } finally {
      logged.mockRestore();
    }
  });
});

describe('startRunOnSession: a refusal after the session was opened', () => {
  it('discards the new session when its pinned version runs another engine than the agent', async () => {
    const { env, sessions } = harness();
    // The new session is pinned to a version of another engine than the agent row names.
    const opening = env.openSession.bind(env);
    env.openSession = async (...args) => {
      const opened = await opening(...args);
      return opened === null ? null : { ...opened, engine: 'openai-agents' };
    };

    await expect(startRunOnSession(env, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'refused',
      status: 409,
      code: 'session_engine_mismatch',
    });
    expect(sessionIds(sessions)).toEqual([EXISTING_SESSION]);
  });
});

describe('startRunOnSession: the lower-only limits override', () => {
  function launching() {
    const { env, sessions, store } = harness();
    const launched: unknown[] = [];
    return {
      env: { ...env, launch: (context: unknown) => void launched.push(context) },
      sessions,
      store,
      launched,
    };
  }

  it('hands the override to the launch, and nothing when there is none', async () => {
    const { env, launched } = launching();
    await startRunOnSession(env, PRINCIPAL, AGENT, { ...START, limits: { maxBudgetUsd: 0.3 } });
    await startRunOnSession(env, PRINCIPAL, AGENT, START);
    expect(launched[0]).toMatchObject({ limits: { maxBudgetUsd: 0.3 } });
    expect(launched[1]).not.toHaveProperty('limits');
  });

  it('stores the override on the run row, so a run built from the row alone can keep it (#1963, SPD-01)', async () => {
    const { env, store } = launching();
    const capped = await startRunOnSession(env, PRINCIPAL, AGENT, {
      ...START,
      limits: { maxBudgetUsd: 0.3, maxTurns: 4 },
    });
    const uncapped = await startRunOnSession(env, PRINCIPAL, AGENT, START);
    if (capped.kind !== 'started' || uncapped.kind !== 'started') throw new Error('start refused');
    expect((await store.get(capped.run.id))?.limitsOverride).toEqual({
      maxBudgetUsd: 0.3,
      maxTurns: 4,
    });
    expect((await store.get(uncapped.run.id))?.limitsOverride).toBeNull();
  });

  it.each([
    { maxBudgetUsd: 0 },
    { maxBudgetUsd: -1 },
    { maxBudgetUsd: Number.NaN },
    { maxBudgetUsd: Number.POSITIVE_INFINITY },
    { maxTurns: 0 },
    { maxTurns: -3 },
    { maxTurns: 2.5 },
    { maxTurns: Number.POSITIVE_INFINITY },
  ])('refuses %o before it opens a session or creates a run', async (limits) => {
    const { env, sessions, launched } = launching();
    await expect(
      startRunOnSession(env, PRINCIPAL, AGENT, { ...START, limits }),
    ).resolves.toMatchObject({ kind: 'refused', status: 422, code: 'invalid_run_limits' });
    expect(sessionIds(sessions)).toEqual([EXISTING_SESSION]);
    expect(launched).toEqual([]);
  });
});

/** A run environment that answers the agent's spend limit, and records the sessions it was asked about. */
function withSpendLimit(limit: number | null) {
  const { env, sessions, store } = harness();
  const asked: (string | null)[] = [];
  const spendLimitFor: NonNullable<RunApiEnvironment['spendLimitFor']> = (
    _principal,
    _agent,
    sessionId,
  ) => {
    asked.push(sessionId);
    return Promise.resolve(limit);
  };
  return { env: { ...env, spendLimitFor }, sessions, store, asked };
}

describe('startRunOnSession: the spend ceiling (ADR-0162)', () => {
  it('refuses 403 policy_cannot_widen at spendCeilingUsd above the agent limit, before a session opens', async () => {
    const { env, sessions, store } = withSpendLimit(1);
    const create = vi.spyOn(store, 'create');
    await expect(
      startRunOnSession(env, PRINCIPAL, AGENT, { ...START, spendCeilingUsd: 1.5 }),
    ).resolves.toMatchObject({
      kind: 'refused',
      status: 403,
      code: 'policy_cannot_widen',
      details: ['spendCeilingUsd'],
    });
    expect(sessionIds(sessions)).toEqual([EXISTING_SESSION]);
    expect(create).not.toHaveBeenCalled();
  });

  it('stores a lower spendCeilingUsd on the run', async () => {
    const started = await startRunOnSession(withSpendLimit(1).env, PRINCIPAL, AGENT, {
      ...START,
      spendCeilingUsd: 0.25,
    });
    expect(started).toMatchObject({ kind: 'started', run: { spendCeilingUsd: '0.250000' } });
  });

  it("stores the agent's limit when the start names none, asked with the follow-up's session", async () => {
    const { env, asked } = withSpendLimit(2);
    const started = await startRunOnSession(env, PRINCIPAL, AGENT, {
      ...START,
      sessionId: EXISTING_SESSION,
    });
    expect(started).toMatchObject({ kind: 'started', run: { spendCeilingUsd: '2.000000' } });
    expect(asked).toEqual([EXISTING_SESSION]);
  });
});

describe('startRunOnSession: where the spend ceiling comes from', () => {
  it('lets a trusted override lower it further, and stores none when nothing sets one', async () => {
    const lowered = await startRunOnSession(withSpendLimit(2).env, PRINCIPAL, AGENT, {
      ...START,
      spendCeilingUsd: 1,
      limits: { maxBudgetUsd: 0.5 },
    });
    expect(lowered).toMatchObject({ kind: 'started', run: { spendCeilingUsd: '0.500000' } });
    const none = await startRunOnSession(withSpendLimit(null).env, PRINCIPAL, AGENT, START);
    expect(none).toMatchObject({ kind: 'started', run: { spendCeilingUsd: null } });
  });

  it('reads spendCeilingUsd from the body and refuses a malformed one', () => {
    expect(parseStartRunBody({ prompt: 'hi', spendCeilingUsd: 0.5 })).toMatchObject({
      kind: 'ok',
      body: { spendCeilingUsd: 0.5 },
    });
    for (const spendCeilingUsd of [0, -1, '1', 0.0000001]) {
      expect(parseStartRunBody({ prompt: 'hi', spendCeilingUsd })).toMatchObject({
        kind: 'rejected',
      });
    }
  });
});
