import type { SessionRecord, SessionRepository } from '@agent-workspace/core/db';
import { describe, expect, it, vi } from 'vitest';

import { recordReportedSessionIdentity, sessionForLaunch } from './session-launch';

const SESSION_ID = '77777777-7777-4777-8777-777777777777';

function session(engineSessionId: string | null): SessionRecord {
  return {
    id: SESSION_ID,
    workspaceId: '55555555-5555-4555-8555-555555555555',
    agentId: '66666666-6666-4666-8666-666666666666',
    ownerPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: '88888888-8888-4888-8888-888888888888',
    projectId: '99999999-9999-4999-8999-999999999999',
    engineSessionId,
    engine: engineSessionId === null ? null : 'claude-agent-sdk',
    agentVersionId: null,
    title: null,
    status: 'active',
    createdAt: new Date('2026-09-16T00:00:00Z'),
    updatedAt: new Date('2026-09-16T00:00:00Z'),
  };
}

function repository(
  update: SessionRepository['update'],
): Pick<SessionRepository, 'update'> & SessionRepository {
  return {
    ensure: () => Promise.reject(new Error('unused')),
    get: () => Promise.reject(new Error('unused')),
    getByEngineSessionId: () => Promise.reject(new Error('unused')),
    list: () => Promise.reject(new Error('unused')),
    update,
    archive: () => Promise.reject(new Error('unused')),
    restore: () => Promise.reject(new Error('unused')),
    discardIfUnused: () => Promise.resolve(false),
  };
}

describe('prepareSessionForLaunch', () => {
  it('launches a pre-created project session fresh without claiming it before the runner starts', () => {
    const row = session(null);
    expect(sessionForLaunch(row)).toEqual({
      id: SESSION_ID,
      agentId: row.agentId,
      // Unpinned (ADR-0065 D8): nothing has run in this session, so any engine may.
      engine: null,
      agentVersionId: null,
    });
  });

  it('resumes a session whose engine identity was already reported', () => {
    const row = session(SESSION_ID);

    expect(sessionForLaunch(row)).toEqual({
      id: SESSION_ID,
      agentId: row.agentId,
      engine: 'claude-agent-sdk',
      agentVersionId: null,
      resume: true,
    });
  });

  it('carries the pinned agent version across, so a run composes from it (issue #612)', () => {
    const versionId = '33333333-3333-4333-8333-333333333333';
    expect(sessionForLaunch({ ...session(null), agentVersionId: versionId }).agentVersionId).toBe(
      versionId,
    );
  });

  it('carries the pinned engine across so a run route can compare it with the agent’s', () => {
    // The whole point of the field: `startRun` refuses a run whose agent names another engine, and
    // it can only do that if the launch reference states which engine the session belongs to.
    expect(sessionForLaunch(session(SESSION_ID)).engine).toBe('claude-agent-sdk');
    expect(sessionForLaunch(session(null)).engine).toBeNull();
  });

  it('records the identity only after the runner reports the expected session id', async () => {
    const row = session(null);
    const update = vi.fn(() =>
      Promise.resolve({
        kind: 'updated' as const,
        session: { ...row, engineSessionId: SESSION_ID, engine: 'claude-agent-sdk' as const },
      }),
    );

    await expect(
      recordReportedSessionIdentity(
        repository(update),
        sessionForLaunch(row),
        SESSION_ID,
        'claude-agent-sdk',
      ),
    ).resolves.toBeUndefined();
    // ADR-0065: the engine is written in the SAME update as the id it belongs to, never a later
    // one. A writer that recorded only the id would leave `sessions.engine` NULL on a row that
    // has an identity — the state the release's invariant denies.
    expect(update).toHaveBeenCalledWith(SESSION_ID, {
      engineIdentity: { engineSessionId: SESSION_ID, engine: 'claude-agent-sdk' },
    });
  });

  it('refuses a mismatched runner identity without changing the session', async () => {
    const update = vi.fn<SessionRepository['update']>();
    const row = session(null);

    await expect(
      recordReportedSessionIdentity(
        repository(update),
        sessionForLaunch(row),
        'different-session',
        'claude-agent-sdk',
      ),
    ).rejects.toThrow('differs from the platform id');
    expect(update).not.toHaveBeenCalled();
  });

  it('fails observably when the session disappears before its reported identity is stored', async () => {
    const row = session(null);
    const update = vi.fn(() => Promise.resolve({ kind: 'not-found' as const }));

    await expect(
      recordReportedSessionIdentity(
        repository(update),
        sessionForLaunch(row),
        SESSION_ID,
        'claude-agent-sdk',
      ),
    ).rejects.toThrow('session disappeared');
  });

  // #318: the engine written is the one the *run* recorded. A run that recorded none cannot be the
  // one reporting an identity, so it is refused rather than pinned to the platform's default.
  it.each([null, undefined])(
    'refuses to pin a session from a run with no engine (%s)',
    async (engine) => {
      const update = vi.fn<SessionRepository['update']>();
      const row = session(null);

      await expect(
        recordReportedSessionIdentity(
          repository(update),
          sessionForLaunch(row),
          SESSION_ID,
          engine,
        ),
      ).rejects.toThrow('recorded no engine');
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('refuses to pin a session to an engine the contracts do not publish', async () => {
    const update = vi.fn<SessionRepository['update']>();
    const row = session(null);

    await expect(
      recordReportedSessionIdentity(
        repository(update),
        sessionForLaunch(row),
        SESSION_ID,
        'telepathy',
      ),
    ).rejects.toThrow('not one this platform');
    expect(update).not.toHaveBeenCalled();
  });
});
