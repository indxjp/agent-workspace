/** Fixtures for the share service tests: a public share record, in-memory sharing ports and a publisher. */
import type { ShareRecord } from '@agent-workspace/core/db';
import { vi } from 'vitest';

import type { PublishShareInput } from './service';
import type { WorkspaceSharing } from './runtime';

export const TOKEN = 'pub_secret';

export const baseShare: ShareRecord = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  tokenHash: 'not-checked-here',
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

export function sharing(found: ShareRecord) {
  const recordView = vi.fn();
  const getPublicSharingEnabled = vi.fn().mockResolvedValue(true);
  const createShare = vi.fn();
  const repositories: WorkspaceSharing = {
    shares: {
      list: vi.fn(),
      get: vi.fn(),
      findByTokenHash: vi.fn().mockResolvedValue(found),
      create: createShare,
      getPublicSharingEnabled,
      setPublicSharingEnabled: vi.fn(),
      revoke: vi.fn(),
      stop: vi.fn(),
      reserveVisitorMessage: vi.fn(),
    },
    views: {
      record: recordView,
      count: vi.fn(),
    },
    audit: { write: vi.fn() },
  };
  return { repositories, recordView, getPublicSharingEnabled, createShare };
}

/** A public session share to publish. */
export const publicSessionInput: PublishShareInput = {
  subjectType: 'session',
  subjectId: 'session-1',
  subjectLabel: 'Session',
  visibility: 'public',
};

/** The workspace owner publishing it. */
export const ownerActor = {
  principalId: '00000000-0000-4000-8000-000000000004',
  ownerPrincipalId: '00000000-0000-4000-8000-000000000004',
  userId: 'user-1',
  userLabel: 'user@example.test',
  role: 'owner',
} as const;
