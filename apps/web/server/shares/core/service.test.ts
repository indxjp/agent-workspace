import type { ShareRecord } from '@agent-workspace/core/db';
import { describe, expect, it, vi } from 'vitest';

import { ShareService } from './service';
import type { WorkspaceSharing } from './runtime';

const baseShare: ShareRecord = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  token: 'pub_secret',
  subjectType: 'session',
  subjectId: 'session-1',
  subjectLabel: 'Session',
  visibility: 'public',
  mode: null,
  snapshot: { safe: true },
  include: {},
  budgetCapUsd: null,
  spentUsd: '0',
  stopped: false,
  expiresAt: null,
  passphraseHash: null,
  createdBy: '00000000-0000-4000-8000-000000000003',
  publisherPrincipalId: '00000000-0000-4000-8000-000000000004',
  revokedAt: null,
  suspendedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function sharing(found: ShareRecord) {
  const recordView = vi.fn();
  const getPublicSharingEnabled = vi.fn().mockResolvedValue(true);
  const createShare = vi.fn();
  const repositories: WorkspaceSharing = {
    shares: {
      list: vi.fn(),
      get: vi.fn(),
      findByToken: vi.fn().mockResolvedValue(found),
      create: createShare,
      getPublicSharingEnabled,
      setPublicSharingEnabled: vi.fn(),
      revoke: vi.fn(),
      setSuspended: vi.fn(),
      stop: vi.fn(),
      reserveVisitorMessage: vi.fn(),
      linkRun: vi.fn(),
    },
    views: {
      record: recordView,
      count: vi.fn(),
      countVisitorSince: vi.fn(),
    },
    audit: { write: vi.fn(), count: vi.fn(), list: vi.fn() },
  };
  return { repositories, recordView, getPublicSharingEnabled, createShare };
}

describe('anonymous share resolution', () => {
  it.each(['private', 'workspace'] as const)('fails closed for %s tokens', async (visibility) => {
    const { repositories, recordView } = sharing({ ...baseShare, visibility });

    await expect(new ShareService(repositories).resolve(baseShare.token)).rejects.toThrow(
      'Public link is unavailable.',
    );
    expect(recordView).not.toHaveBeenCalled();
  });

  it('resolves and records a view only for a public share', async () => {
    const { repositories, recordView } = sharing(baseShare);
    await expect(new ShareService(repositories).resolve(baseShare.token)).resolves.toEqual(
      baseShare,
    );
    expect(recordView).toHaveBeenCalledWith(baseShare.id, undefined);
  });
});

describe('share publishing policy', () => {
  it('rejects public publishing when the durable workspace policy is disabled', async () => {
    const { repositories, getPublicSharingEnabled, createShare } = sharing(baseShare);
    getPublicSharingEnabled.mockResolvedValue(false);

    await expect(
      new ShareService(repositories).publish(
        {
          subjectType: 'session',
          subjectId: 'session-1',
          subjectLabel: 'Session',
          visibility: 'public',
        },
        {
          principalId: '00000000-0000-4000-8000-000000000004',
          ownerPrincipalId: '00000000-0000-4000-8000-000000000004',
          userId: 'user-1',
          userLabel: 'user@example.test',
          role: 'owner',
        },
      ),
    ).rejects.toThrow('Public sharing is disabled');
    expect(createShare).not.toHaveBeenCalled();
  });
});
