import type { ShareRecord } from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';

import { publishedSnapshot, toShareResource, visibleShares } from './resource';
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

  const runId = '11111111-1111-4111-8111-111111111111';
  const sessionRuns = () =>
    Promise.resolve([
      {
        id: runId,
        sessionId: base.subjectId,
        createdAt: new Date('2026-10-19T10:00:00Z'),
        prompt: 'my key is sk-live-secret',
        answer: 'ok',
      },
    ]);

  it('never stores a caller-authored raw snapshot, which would skip secret masking', async () => {
    for (const subjectType of ['session', 'agent', 'project', 'skill'] as const) {
      const body = parsePublishShareRequest({
        ...base,
        subjectType,
        snapshot: { messages: ['sk-live-secret'] },
      });
      expect(await publishedSnapshot(body, materials, sessionRuns)).toBeUndefined();
    }
  });

  it('copies the chosen runs of the session and masks them with the workspace secrets', async () => {
    const body = parsePublishShareRequest({
      ...base,
      subjectType: 'session',
      transcript: { runIds: [runId] },
    });
    const snapshot = await publishedSnapshot(body, materials, sessionRuns);
    expect(snapshot).toMatchObject({ kind: 'session-transcript', turns: [{ answer: 'ok' }] });
    expect(JSON.stringify(snapshot)).not.toContain('sk-live-secret');
  });
});

describe('share list visibility', () => {
  const mine = { id: 'mine', publisherPrincipalId: 'me' };
  const theirs = { id: 'theirs', publisherPrincipalId: 'someone-else' };

  it.each(['owner', 'admin'] as const)('shows a %s every share in the workspace', (role) => {
    expect(visibleShares([mine, theirs], { role, ownerPrincipalId: 'me' })).toStrictEqual([
      mine,
      theirs,
    ]);
  });

  it.each(['builder', 'viewer'] as const)('shows a %s only their own shares', (role) => {
    expect(visibleShares([mine, theirs], { role, ownerPrincipalId: 'me' })).toStrictEqual([mine]);
  });
});
