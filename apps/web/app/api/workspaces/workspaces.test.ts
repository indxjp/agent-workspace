/**
 * `GET`/`POST /api/workspaces`, driven with real `Request` objects against the real route module —
 * issue #119's "A user lists exactly workspaces with a current membership" and "Creation
 * atomically creates an Owner membership", at the HTTP layer. The repository-level transactional
 * proof (concurrent same-slug creates, a failed membership insert leaving no orphan) lives in
 * `packages/core/src/db/repositories/workspaces.test.ts`, against real PostgreSQL; this file
 * proves the wiring above it.
 */
import { clearApplicationContext } from '../../../server/application-context';
import { installTestDomains } from '../../../server/application-context-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { installRbacHarness, TEST_WORKSPACE_ID } from '../../../server/rbac/testing';
import type { WorkspaceFeaturesRuntime } from '../../../server/workspaces/features-runtime';
import { createMemoryWorkspaceRepository } from '../../../server/workspaces/testing';
import { GET, POST } from './route';

afterEach(() => {
  clearApplicationContext();
});

/** A features runtime whose only live member is `provisionBuilder`. */
function features(
  provisionBuilder: WorkspaceFeaturesRuntime['provisionBuilder'],
): WorkspaceFeaturesRuntime {
  return {
    deployment: [],
    repositoryFor: () => Promise.resolve(null),
    recordAuditEvent: () => Promise.resolve(),
    provisionBuilder,
  };
}

describe('GET /api/workspaces', () => {
  it('lists exactly the caller’s current memberships, across every one of §21’s four roles', async () => {
    const harness = installRbacHarness([
      { email: 'a@example.com', name: 'A', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
    ]);
    const userId = (await harness.directory.findUserByEmail('a@example.com'))?.id;
    if (userId === undefined) throw new Error('seed failed');
    installTestDomains({
      workspaces: {
        repository: createMemoryWorkspaceRepository({
          workspaces: [
            { id: 'ws-a', slug: 'ws-a', name: 'Alpha', members: [{ userId, role: 'owner' }] },
            { id: 'ws-b', slug: 'ws-b', name: 'Beta', members: [{ userId, role: 'viewer' }] },
            { id: 'ws-c', slug: 'ws-c', name: 'Gamma', members: [] },
          ],
        }),
      },
    });

    const response = await harness.call(GET, {
      method: 'GET',
      path: '/api/workspaces',
      as: { email: 'a@example.com' },
    });
    expect(response.status).toBe(200);
    const body = response.body as { workspaces: { id: string }[] };
    const ids = body.workspaces.map((w) => w.id).sort();
    expect(ids).toEqual(['ws-a', 'ws-b']);
    harness.teardown();
  });

  it('answers 401 with no session', async () => {
    const harness = installRbacHarness([]);
    installTestDomains({ workspaces: { repository: createMemoryWorkspaceRepository() } });
    const response = await harness.call(GET, { method: 'GET', path: '/api/workspaces', as: null });
    expect(response.status).toBe(401);
    harness.teardown();
  });

  it('answers 503 when no application context is installed', async () => {
    // The workspaces domain and the RBAC gate live in one context, so the gate answers first.
    const harness = installRbacHarness([
      { email: 'a@example.com', name: 'A', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
    ]);
    clearApplicationContext();
    const response = await harness.call(GET, {
      method: 'GET',
      path: '/api/workspaces',
      as: { email: 'a@example.com' },
    });
    expect(response.status).toBe(503);
    harness.teardown();
  });
});

describe('POST /api/workspaces', () => {
  it('creates a workspace with the caller as Owner, for every one of §21’s four roles', async () => {
    for (const role of ['owner', 'admin', 'builder', 'viewer'] as const) {
      const harness = installRbacHarness([
        { email: 'creator@example.com', name: 'Creator', workspaceId: TEST_WORKSPACE_ID, role },
      ]);
      installTestDomains({ workspaces: { repository: createMemoryWorkspaceRepository() } });
      const response = await harness.call(POST, {
        method: 'POST',
        path: '/api/workspaces',
        as: { email: 'creator@example.com' },
        body: { name: 'New Co', slug: `new-co-${role}` },
      });
      expect(response.status, `role ${role}`).toBe(201);
      const body = response.body as { workspace: { role: string; slug: string } };
      expect(body.workspace.role).toBe('owner');
      expect(body.workspace.slug).toBe(`new-co-${role}`);
      harness.teardown();
      clearApplicationContext();
    }
  });

  it('ensures the new workspace’s Builder once after a create, and not for a refused one (#1848)', async () => {
    const harness = installRbacHarness([
      {
        email: 'creator@example.com',
        name: 'Creator',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'owner',
      },
    ]);
    const provisioned: string[] = [];
    installTestDomains({
      workspaces: { repository: createMemoryWorkspaceRepository() },
      workspaceFeatures: features((id) => {
        provisioned.push(id);
        return Promise.resolve();
      }),
    });
    const created = await harness.call(POST, {
      method: 'POST',
      path: '/api/workspaces',
      as: { email: 'creator@example.com' },
      body: { name: 'New Co', slug: 'new-co' },
    });
    expect(created.status).toBe(201);
    const { workspace } = created.body as { workspace: { id: string } };
    expect(provisioned).toEqual([workspace.id]);

    const taken = await harness.call(POST, {
      method: 'POST',
      path: '/api/workspaces',
      as: { email: 'creator@example.com' },
      body: { name: 'New Co', slug: 'new-co' },
    });
    expect(taken.status).toBe(409);
    expect(provisioned).toEqual([workspace.id]);
    harness.teardown();
  });

  it('still answers 201 when ensuring the Builder fails (#1848)', async () => {
    const harness = installRbacHarness([
      {
        email: 'creator@example.com',
        name: 'Creator',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'owner',
      },
    ]);
    installTestDomains({
      workspaces: { repository: createMemoryWorkspaceRepository() },
      workspaceFeatures: features(() => Promise.reject(new Error('relation "agents" is locked'))),
    });
    const response = await harness.call(POST, {
      method: 'POST',
      path: '/api/workspaces',
      as: { email: 'creator@example.com' },
      body: { name: 'New Co', slug: 'new-co' },
    });
    expect(response.status).toBe(201);
    harness.teardown();
  });

  it('rejects a blank name and a missing slug as 400s', async () => {
    const harness = installRbacHarness([
      {
        email: 'creator@example.com',
        name: 'Creator',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'owner',
      },
    ]);
    installTestDomains({ workspaces: { repository: createMemoryWorkspaceRepository() } });
    const blankName = await harness.call(POST, {
      method: 'POST',
      path: '/api/workspaces',
      as: { email: 'creator@example.com' },
      body: { name: '  ', slug: 'ok-slug' },
    });
    expect(blankName.status).toBe(400);
    const missingSlug = await harness.call(POST, {
      method: 'POST',
      path: '/api/workspaces',
      as: { email: 'creator@example.com' },
      body: { name: 'OK Name' },
    });
    expect(missingSlug.status).toBe(400);
    harness.teardown();
  });

  it('rejects an invalid slug as 400 invalid_field (verification round 1, finding 4)', async () => {
    const harness = installRbacHarness([
      {
        email: 'creator@example.com',
        name: 'Creator',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'owner',
      },
    ]);
    installTestDomains({ workspaces: { repository: createMemoryWorkspaceRepository() } });
    const response = await harness.call(POST, {
      method: 'POST',
      path: '/api/workspaces',
      as: { email: 'creator@example.com' },
      body: { name: 'OK Name', slug: 'Not Valid Slug!' },
    });
    expect(response.status).toBe(400);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('invalid_field');
    harness.teardown();
  });

  it('rejects a non-object body as 400 malformed_body (verification round 1, finding 4)', async () => {
    const harness = installRbacHarness([
      {
        email: 'creator@example.com',
        name: 'Creator',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'owner',
      },
    ]);
    installTestDomains({ workspaces: { repository: createMemoryWorkspaceRepository() } });
    const response = await harness.call(POST, {
      method: 'POST',
      path: '/api/workspaces',
      as: { email: 'creator@example.com' },
      body: ['name', 'slug'],
    });
    expect(response.status).toBe(400);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('malformed_body');
    harness.teardown();
  });

  it('answers 409 slug_taken for a duplicate slug, not a duplicate row (verification round 1, finding 4)', async () => {
    const harness = installRbacHarness([
      {
        email: 'creator@example.com',
        name: 'Creator',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'owner',
      },
    ]);
    installTestDomains({ workspaces: { repository: createMemoryWorkspaceRepository() } });
    const first = await harness.call(POST, {
      method: 'POST',
      path: '/api/workspaces',
      as: { email: 'creator@example.com' },
      body: { name: 'First', slug: 'dup-slug' },
    });
    expect(first.status).toBe(201);
    const second = await harness.call(POST, {
      method: 'POST',
      path: '/api/workspaces',
      as: { email: 'creator@example.com' },
      body: { name: 'Second', slug: 'DUP-SLUG' },
    });
    expect(second.status).toBe(409);
    const body = second.body as { error: { code: string } };
    expect(body.error.code).toBe('slug_taken');
    harness.teardown();
  });

  it(
    'a failed membership insert leaves no orphan workspace, at the route layer ' +
      '(verification round 1, finding 7)',
    async () => {
      const harness = installRbacHarness([
        {
          email: 'creator@example.com',
          name: 'Creator',
          workspaceId: TEST_WORKSPACE_ID,
          role: 'owner',
        },
      ]);
      // `beforeMembershipInsert` is `createMemoryWorkspaceRepository`'s own documented seam for
      // exactly this: its header says a route-level test uses it to prove #119's "failed creation
      // leaves no orphan workspace" the way `packages/core/src/db/repositories/workspaces.test.ts`
      // proves it against real PostgreSQL — verification round 1, finding 7, found that no test
      // in the PR actually did.
      let failNextInsert = true;
      const repository = createMemoryWorkspaceRepository({
        beforeMembershipInsert: () => {
          if (failNextInsert) {
            failNextInsert = false;
            throw new Error('simulated membership insert failure');
          }
        },
      });
      installTestDomains({ workspaces: { repository } });

      let threw: unknown = null;
      try {
        await harness.call(POST, {
          method: 'POST',
          path: '/api/workspaces',
          as: { email: 'creator@example.com' },
          body: { name: 'Orphan Check', slug: 'orphan-check' },
        });
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeInstanceOf(Error);
      expect((threw as Error).message).toBe('simulated membership insert failure');

      // No orphan: the same slug is free to use again. A leftover row from the failed attempt
      // would answer 409 slug_taken here instead of creating cleanly.
      const retry = await harness.call(POST, {
        method: 'POST',
        path: '/api/workspaces',
        as: { email: 'creator@example.com' },
        body: { name: 'Orphan Check', slug: 'orphan-check' },
      });
      expect(retry.status).toBe(201);
      harness.teardown();
    },
  );
});
