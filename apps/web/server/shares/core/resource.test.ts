import type { ShareRecord } from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';

import { publishedSnapshot, toShareResource } from '../../../app/api/shares/route';
import { parsePublishShareRequest } from './input';

function share(visibility: ShareRecord['visibility']): ShareRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    token: 'pub_do-not-leak-for-non-public',
    subjectType: 'project',
    subjectId: 'project-1',
    subjectLabel: 'Project',
    visibility,
    mode: null,
    snapshot: null,
    include: {},
    budgetCapUsd: null,
    spentUsd: '0',
    stopped: false,
    expiresAt: null,
    passphraseHash: 'sensitive-hash',
    createdBy: '00000000-0000-4000-8000-000000000003',
    publisherPrincipalId: '00000000-0000-4000-8000-000000000004',
    revokedAt: null,
    suspendedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('share wire resource', () => {
  it.each(['private', 'workspace'] as const)(
    'omits secrets and public URL for %s shares',
    (visibility) => {
      const resource = toShareResource(share(visibility), 2);
      expect(resource).not.toHaveProperty('passphraseHash');
      expect(resource).not.toHaveProperty('token');
      expect(resource).not.toHaveProperty('workspaceId');
      expect(resource).not.toHaveProperty('createdBy');
      expect(resource).not.toHaveProperty('url');
      expect(resource).toHaveProperty('viewCount', 2);
    },
  );

  it('emits a /p URL only for public shares without exposing the raw token field', () => {
    const resource = toShareResource(share('public'));
    expect(resource).toHaveProperty('url', '/p/pub_do-not-leak-for-non-public');
    expect(resource).not.toHaveProperty('token');
    expect(resource).not.toHaveProperty('passphraseHash');
  });
});

describe('published share content', () => {
  const materials = { values: ['sk-live-secret'], referenceIds: [] };
  const base = { subjectId: 's-1', subjectLabel: 'S', visibility: 'public' } as const;

  it('never stores a caller-authored raw snapshot, which would skip secret masking', () => {
    for (const subjectType of ['session', 'agent', 'project', 'skill'] as const) {
      const body = parsePublishShareRequest({
        ...base,
        subjectType,
        snapshot: { messages: ['sk-live-secret'] },
      });
      expect(publishedSnapshot(body, materials)).toBeUndefined();
    }
  });

  it('masks a session transcript with the workspace secrets', () => {
    const body = parsePublishShareRequest({
      ...base,
      subjectType: 'session',
      transcript: [{ role: 'user', content: 'my key is sk-live-secret' }],
    });
    expect(JSON.stringify(publishedSnapshot(body, materials))).not.toContain('sk-live-secret');
  });
});
