/**
 * `POST /api/shares` with a session transcript (ADR-0158): the route copies the chosen runs of the
 * shared session behind the real RBAC decision, and refuses a run of another session.
 */
import type { CreateShareInput, ShareRecord } from '@agent-workspace/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearApplicationContext } from '../../../server/application-context';
import { installTestDomains } from '../../../server/application-context-fixtures';
import type { Ownership } from '../../../server/rbac/decide';
import { createMemoryDirectory } from '../../../server/rbac/memory-directory';
import { Principal } from '../../../server/rbac/principal';
import type { Role } from '../../../server/rbac/roles';
import type { WorkspaceSharing } from '../../../server/shares/core/runtime';
import type { SharedRun } from '../../../server/shares/session-snapshot/snapshot';
import { POST } from './route';

const WORKSPACE = '00000000-0000-4000-8000-000000000002';
const CALLER = '00000000-0000-4000-8000-000000000004';
const SESSION = '55555555-5555-4555-8555-555555555555';
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

const stored: Record<string, SharedRun> = {
  [FIRST]: {
    id: FIRST,
    sessionId: SESSION,
    createdAt: new Date('2026-10-19T10:00:00Z'),
    prompt: 'Summarise the incident. Key: sk-live-secret',
    answer: 'The gateway restarted.',
  },
  [SECOND]: {
    id: SECOND,
    sessionId: '66666666-6666-4666-8666-666666666666',
    createdAt: new Date('2026-10-19T10:01:00Z'),
    prompt: 'Another session',
    answer: 'Not yours to share.',
  },
};

function install(role: Role, ownership: Ownership) {
  const create = vi.fn((values: CreateShareInput) =>
    Promise.resolve({
      ...values,
      id: '00000000-0000-4000-8000-0000000000aa',
      workspaceId: WORKSPACE,
      mode: values.mode ?? null,
      snapshot: values.snapshot ?? null,
      include: values.include ?? {},
      budgetCapUsd: values.budgetCapUsd ?? null,
      spentUsd: '0',
      stopped: false,
      expiresAt: values.expiresAt ?? null,
      passphraseHash: values.passphraseHash ?? null,
      createdBy: values.createdBy ?? null,
      revokedAt: null,
      suspendedAt: null,
      createdAt: new Date('2026-10-19T11:00:00Z'),
    } as ShareRecord),
  );
  const sessionRuns = vi.fn((_workspaceId: string, runIds: readonly string[]) =>
    Promise.resolve(runIds.map((id) => stored[id] ?? null)),
  );
  const sharing = {
    shares: { create, getPublicSharingEnabled: () => Promise.resolve(true) },
    audit: { write: () => Promise.resolve() },
  } as unknown as WorkspaceSharing;
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory(),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: CALLER,
            apiKeyId: '00000000-0000-4000-8000-0000000000bb',
            workspaceId: WORKSPACE,
            role,
            label: 'Share test key',
          }),
        ),
    },
    shares: {
      resolveActor: () =>
        Promise.resolve({
          kind: 'workspace',
          workspaceId: WORKSPACE,
          principalId: CALLER,
          ownerPrincipalId: CALLER,
          userId: null,
          userLabel: 'Share test key',
          role,
        }),
      forWorkspace: () => Promise.resolve(sharing),
      resolvePublic: () => Promise.resolve(null),
      sharingMaterials: () => Promise.resolve({ values: ['sk-live-secret'], referenceIds: [] }),
      sessionRuns,
      subjectOwnership: () => Promise.resolve(ownership),
      runPublic: () => Promise.reject(new Error('not used')),
    },
  });
  return { create, sessionRuns };
}

function publish(transcript: unknown): Promise<Response> {
  return POST(
    new Request('https://control-plane.test/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectType: 'session',
        subjectId: SESSION,
        subjectLabel: 'Incident review',
        visibility: 'workspace',
        transcript,
      }),
    }),
  );
}

describe('POST /api/shares with a session transcript', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  it("publishes the chosen runs' stored text, masked, for the session's owner", async () => {
    const { create } = install('builder', 'own');
    const response = await publish({ runIds: [FIRST] });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { snapshot: unknown };
    expect(body.snapshot).toEqual({
      kind: 'session-transcript',
      version: 1,
      turns: [
        { prompt: 'Summarise the incident. Key: [REDACTED]', answer: 'The gateway restarted.' },
      ],
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('refuses a run of another session and stores nothing', async () => {
    const { create } = install('builder', 'own');
    const response = await publish({ runIds: [FIRST, SECOND] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'invalid_share',
        message: 'transcript.runIds[1] is not a run of this session.',
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses fabricated transcript text before reading any run', async () => {
    const { create, sessionRuns } = install('builder', 'own');
    const response = await publish([{ kind: 'agent', text: 'I never said this.' }]);
    expect(response.status).toBe(400);
    expect(sessionRuns).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a Builder publishing another member's session before reading its runs", async () => {
    const { create, sessionRuns } = install('builder', 'other');
    const response = await publish({ runIds: [FIRST] });
    expect(response.status).toBe(403);
    expect(sessionRuns).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
