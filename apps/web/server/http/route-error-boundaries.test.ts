import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PATCH as patchProject } from '../../app/api/projects/[id]/route';
import { POST as createProject } from '../../app/api/projects/route';
import { DELETE as revokeShare } from '../../app/api/shares/[id]/route';
import { GET as listShares, POST as publishShare } from '../../app/api/shares/route';
import { PATCH as patchSharingPolicy } from '../../app/api/sharing-policies/route';
import { clearProjectsRuntime, configureProjectsRuntime } from '../projects/runtime';
import {
  clearSharesRuntime,
  configureSharesRuntime,
  type WorkspaceSharing,
} from '../shares/core/runtime';

const SENTINEL = 'postgresql://admin:TOP-SECRET@internal.example/workspace';

function request(path: string, method: 'PATCH' | 'POST'): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

async function expectSafeInfrastructureFailure(response: Response): Promise<void> {
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(text).not.toContain(SENTINEL);
  expect(JSON.parse(text)).toEqual({
    error: { code: 'internal_error', message: 'The request could not be completed.' },
  });
}

describe('authenticated route error boundaries', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    clearProjectsRuntime();
    clearSharesRuntime();
    vi.restoreAllMocks();
  });

  it('does not turn project persistence failures into public 400 responses', async () => {
    configureProjectsRuntime({
      resolveActor: () =>
        Promise.resolve({
          kind: 'workspace',
          workspaceId: 'workspace-1',
          principalId: 'principal-1',
          ownerPrincipalId: 'principal-1',
          userId: 'user-1',
          userLabel: 'owner@example.test',
        }),
      forWorkspace: () => Promise.reject(new Error(SENTINEL)),
    });

    await expectSafeInfrastructureFailure(await createProject(request('/api/projects', 'POST')));
    await expectSafeInfrastructureFailure(
      await patchProject(request('/api/projects/project-1', 'PATCH'), {
        params: Promise.resolve({ id: 'project-1' }),
      }),
    );
  });

  it('does not expose sharing persistence failures from publish or policy routes', async () => {
    configureSharesRuntime({
      resolveActor: () =>
        Promise.resolve({
          kind: 'workspace',
          workspaceId: 'workspace-1',
          principalId: 'principal-1',
          ownerPrincipalId: 'principal-1',
          userId: 'user-1',
          userLabel: 'owner@example.test',
          role: 'owner',
        }),
      forWorkspace: () => Promise.reject(new Error(SENTINEL)),
      resolvePublic: () => Promise.reject(new Error('not used')),
      sharingMaterials: () => Promise.reject(new Error('not used')),
      subjectOwnership: () => Promise.reject(new Error('not used')),
      runPublic: () => Promise.reject(new Error('not used')),
    });

    await expectSafeInfrastructureFailure(await publishShare(request('/api/shares', 'POST')));
    await expectSafeInfrastructureFailure(
      await listShares(new Request('http://localhost/api/shares')),
    );
    const id = '00000000-0000-4000-8000-000000000001';
    await expectSafeInfrastructureFailure(
      await revokeShare(new Request(`http://localhost/api/shares/${id}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id }),
      }),
    );
    await expectSafeInfrastructureFailure(
      await patchSharingPolicy(request('/api/sharing-policies', 'PATCH')),
    );
  });

  it('answers a non-UUID share id with 404 share_not_found, never reaching the uuid column', async () => {
    configureSharesRuntime({
      resolveActor: () =>
        Promise.resolve({
          kind: 'workspace',
          workspaceId: 'workspace-1',
          principalId: 'principal-1',
          ownerPrincipalId: 'principal-1',
          userId: 'user-1',
          userLabel: 'owner@example.test',
          role: 'owner',
        }),
      forWorkspace: () =>
        Promise.resolve({
          shares: { get: () => Promise.reject(new Error('invalid input syntax for type uuid')) },
        } as unknown as WorkspaceSharing),
      resolvePublic: () => Promise.reject(new Error('not used')),
      sharingMaterials: () => Promise.reject(new Error('not used')),
      subjectOwnership: () => Promise.reject(new Error('not used')),
      runPublic: () => Promise.reject(new Error('not used')),
    });
    const response = await revokeShare(
      new Request('http://localhost/api/shares/not-a-uuid', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'share_not_found' } });
  });
});
