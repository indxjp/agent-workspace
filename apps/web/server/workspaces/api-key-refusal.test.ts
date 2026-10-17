/**
 * Verification round 1, finding 1: an API-key principal must be refused on all four
 * `/api/workspaces` routes, for every one of §21's four key roles — never authorised through
 * `resolveActorUserId`'s `created_by` STAMPING fallback (issue #117), which would otherwise answer
 * as the key's workspace's oldest Owner across every workspace that Owner belongs to.
 *
 * `docs/adr/W9-WS-119-api-key-callers-are-refused.md` records the decision this file proves:
 * `apiKeyRefusal` (`access.ts`) refuses `via === 'api-key'` before any fallback identity is
 * resolved, at all four routes.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { conferredBy } from '../rbac/conferral';
import { installRbacHarness } from '../rbac/testing';
import type { Role } from '../rbac/roles';
import { clearWorkspacesRuntime, configureWorkspacesRuntime } from './runtime';
import { createMemoryWorkspaceRepository } from './testing';
import { GET as GET_COLLECTION, POST } from '../../app/api/workspaces/route';
import { GET as GET_ITEM, PATCH } from '../../app/api/workspaces/[id]/route';

const WORKSPACE_A = '7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff';
const WORKSPACE_D = '9c9a3a9a-9c1e-4a3e-8b1f-2e6c4a2b7f10';
const RANDOM_UUID = '00000000-0000-4000-8000-000000000000';
const ROLES: readonly Role[] = ['owner', 'admin', 'builder', 'viewer'];

afterEach(() => {
  clearWorkspacesRuntime();
});

/** A workspace-A key of `role`, plus the harness and Owner's own id (workspace A's sole member). */
async function seedKey(role: Role) {
  const harness = installRbacHarness([
    { email: 'owner@example.com', name: 'Owner', workspaceId: WORKSPACE_A, role: 'owner' },
  ]);
  const ownerId = (await harness.directory.findUserByEmail('owner@example.com'))?.id;
  if (ownerId === undefined) throw new Error('seed failed');
  const created = await harness.directory.forWorkspace(WORKSPACE_A).createApiKey({
    name: `${role}-key`,
    role: conferredBy('owner', role, 'test'),
    expiresAt: null,
  });
  if (created.kind !== 'created') throw new Error(created.kind);
  configureWorkspacesRuntime({
    repository: createMemoryWorkspaceRepository({
      workspaces: [
        {
          id: WORKSPACE_A,
          slug: 'alpha',
          name: 'Alpha',
          members: [{ userId: ownerId, role: 'owner' }],
        },
        {
          id: WORKSPACE_D,
          slug: 'delta',
          name: 'Delta',
          members: [{ userId: ownerId, role: 'owner' }],
        },
      ],
    }),
  });
  return { harness, ownerId, bearer: created.presented };
}

describe('API-key callers are refused on every /api/workspaces route (four-role matrix)', () => {
  for (const role of ROLES) {
    it(`refuses a ${role} API key on GET /api/workspaces (list)`, async () => {
      const { harness, bearer } = await seedKey(role);
      const response = await harness.call(GET_COLLECTION, {
        method: 'GET',
        path: '/api/workspaces',
        as: null,
        bearer,
      });
      expect(response.status, `role ${role}`).toBe(403);
      harness.teardown();
    });

    it(`refuses a ${role} API key on POST /api/workspaces (create)`, async () => {
      const { harness, bearer } = await seedKey(role);
      const response = await harness.call(POST, {
        method: 'POST',
        path: '/api/workspaces',
        as: null,
        bearer,
        body: { name: 'Pwned', slug: `pwned-${role}` },
      });
      expect(response.status, `role ${role}`).toBe(403);
      harness.teardown();
    });

    it(`refuses a ${role} API key on GET /api/workspaces/:id, even for its own workspace`, async () => {
      const { harness, bearer } = await seedKey(role);
      const response = await harness.call(GET_ITEM, {
        method: 'GET',
        path: `/api/workspaces/${WORKSPACE_A}`,
        id: WORKSPACE_A,
        as: null,
        bearer,
      });
      expect(response.status, `role ${role}`).toBe(403);
      harness.teardown();
    });

    it(`refuses a ${role} API key on PATCH /api/workspaces/:id, even for its own workspace`, async () => {
      const { harness, bearer } = await seedKey(role);
      const response = await harness.call(PATCH, {
        method: 'PATCH',
        path: `/api/workspaces/${WORKSPACE_A}`,
        id: WORKSPACE_A,
        as: null,
        bearer,
        body: { archived: true },
      });
      expect(response.status, `role ${role}`).toBe(403);
      harness.teardown();
    });
  }

  it('answers a foreign-tenant id and a random UUID identically for a bearer key (no enumeration oracle)', async () => {
    const { harness, bearer } = await seedKey('viewer');
    const foreign = await harness.call(GET_ITEM, {
      method: 'GET',
      path: `/api/workspaces/${WORKSPACE_D}`,
      id: WORKSPACE_D,
      as: null,
      bearer,
    });
    const nonexistent = await harness.call(GET_ITEM, {
      method: 'GET',
      path: `/api/workspaces/${RANDOM_UUID}`,
      id: RANDOM_UUID,
      as: null,
      bearer,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.text).toBe(nonexistent.text);

    const foreignPatch = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_D}`,
      id: WORKSPACE_D,
      as: null,
      bearer,
      body: { name: 'pwned' },
    });
    const nonexistentPatch = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${RANDOM_UUID}`,
      id: RANDOM_UUID,
      as: null,
      bearer,
      body: { name: 'pwned' },
    });
    expect(foreignPatch.status).toBe(403);
    expect(foreignPatch.status).toBe(nonexistentPatch.status);
    expect(foreignPatch.text).toBe(nonexistentPatch.text);
    harness.teardown();
  });
});
