import type { ShareRecord } from '@agent-workspace/core/db';
import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceSharing } from '../core/runtime';
import { publicPermissions, RunnableShareService, visitorSessionId } from './service';

const share: ShareRecord = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  token: 'pub_runnable',
  subjectType: 'agent',
  subjectId: 'agent-1',
  subjectLabel: 'Agent',
  visibility: 'public',
  mode: 'runnable',
  snapshot: null,
  include: {},
  budgetCapUsd: '20.0000',
  spentUsd: '0.000000',
  stopped: false,
  expiresAt: null,
  passphraseHash: null,
  createdBy: '00000000-0000-4000-8000-000000000003',
  publisherPrincipalId: '00000000-0000-4000-8000-000000000004',
  revokedAt: null,
  suspendedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function sharing() {
  const reserveVisitorMessage = vi.fn().mockResolvedValue({ kind: 'reserved', share });
  const auditWrite = vi.fn();
  const repositories = {
    shares: {
      list: vi.fn(),
      get: vi.fn(),
      findByToken: vi.fn(),
      create: vi.fn(),
      getPublicSharingEnabled: vi.fn(),
      setPublicSharingEnabled: vi.fn(),
      revoke: vi.fn(),
      stop: vi.fn(),
      reserveVisitorMessage,
    },
    views: { record: vi.fn(), count: vi.fn() },
    audit: { write: auditWrite },
  } satisfies WorkspaceSharing;
  return { ...repositories, reserveVisitorMessage, auditWrite };
}

describe('runnable public links', () => {
  it('always removes command execution and file writes', () => {
    expect(
      publicPermissions({
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: true,
      }),
    ).toEqual({
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: true,
    });
  });
  it('keeps one isolated ephemeral session per visitor', () => {
    expect(visitorSessionId('share-a', 'visitor-a')).toBe(visitorSessionId('share-a', 'visitor-a'));
    expect(visitorSessionId('share-a', 'visitor-a')).not.toBe(
      visitorSessionId('share-a', 'visitor-b'),
    );
  });

  it('uses the atomic reservation and returns the durably linked run identity', async () => {
    const repositories = sharing();
    const run = vi.fn().mockResolvedValue({ output: { ok: true }, runId: 'run-1' });
    const now = new Date('2026-09-12T00:00:00Z');

    await expect(
      new RunnableShareService(repositories, run, () => now).message(share, 'Hello', 'v1_visitor'),
    ).resolves.toEqual({ output: { ok: true }, runId: 'run-1' });

    expect(repositories.reserveVisitorMessage).toHaveBeenCalledWith({
      id: share.id,
      visitorKey: 'v1_visitor',
      windowStartedAt: new Date('2026-09-11T23:00:00Z'),
      now,
      limit: 5,
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ share, prompt: 'Hello', visitorKey: 'v1_visitor' }),
    );
  });

  it.each([
    ['rate-limited', 'rate_limited'],
    ['busy', 'share_busy'],
    ['unavailable', 'share_unavailable'],
    ['budget-exhausted', 'budget_exhausted'],
  ] as const)('returns a typed refusal for a %s reservation', async (kind, code) => {
    const repositories = sharing();
    repositories.reserveVisitorMessage.mockResolvedValue(
      kind === 'budget-exhausted' ? { kind, stoppedNow: false } : { kind },
    );
    const run = vi.fn();

    const promise = new RunnableShareService(repositories, run).message(
      share,
      'Hello',
      'v1_visitor',
    );
    await expect(promise).rejects.toMatchObject({ code });
    expect(run).not.toHaveBeenCalled();
  });

  it('writes the automatic-stop audit when reservation discovers the budget transition', async () => {
    const repositories = sharing();
    repositories.reserveVisitorMessage.mockResolvedValue({
      kind: 'budget-exhausted',
      stoppedNow: true,
    });

    await expect(
      new RunnableShareService(repositories, () =>
        Promise.resolve({ output: null, runId: 'never' }),
      ).message(share, 'Hello', 'v1_visitor'),
    ).rejects.toMatchObject({ code: 'budget_exhausted' });

    expect(repositories.auditWrite).toHaveBeenCalledTimes(1);
    expect(repositories.auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'runnable-link-stopped', subjectId: share.id }),
    );
  });
});
