/**
 * `GET`/`PATCH /api/workspaces/:id`, driven with real `Request` objects — the concealment half of
 * issue #119's "Cross-workspace enumeration is prevented" and the "An Owner can rename/update/
 * archive; unauthorized users cannot" half of the acceptance criteria, both at the HTTP layer.
 *
 * The verifier's own attack #1: with workspaces A, B, C and a user in A and B only, `GET
 * /api/workspaces/<C-id>` and `PATCH` it must answer identically to the same requests against a
 * random UUID. That is proved here by comparing the two responses' status and body directly,
 * rather than by asserting each is "some 404" independently — two 404s with different bodies
 * would still be an oracle.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { installRbacHarness, TEST_WORKSPACE_ID } from '../../../../server/rbac/testing';
import {
  clearWorkspacesRuntime,
  configureWorkspacesRuntime,
} from '../../../../server/workspaces/runtime';
import { createMemoryWorkspaceRepository } from '../../../../server/workspaces/testing';
import { GET, PATCH } from './route';

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000';
const WORKSPACE_A = '7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff';
const WORKSPACE_B = 'c75a16a5-ab05-4309-9cbb-449baf33c4c1';
const WORKSPACE_C = '6b41fd4a-7bcb-4068-8a76-a59530ec35a6';

afterEach(() => {
  clearWorkspacesRuntime();
});

async function seed() {
  const harness = installRbacHarness([
    { email: 'member@example.com', name: 'Member', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
    {
      email: 'other-role@example.com',
      name: 'Other Role',
      workspaceId: TEST_WORKSPACE_ID,
      role: 'viewer',
    },
  ]);
  const memberId = (await harness.directory.findUserByEmail('member@example.com'))?.id;
  const otherRoleId = (await harness.directory.findUserByEmail('other-role@example.com'))?.id;
  if (memberId === undefined || otherRoleId === undefined) throw new Error('seed failed');

  configureWorkspacesRuntime({
    repository: createMemoryWorkspaceRepository({
      workspaces: [
        {
          id: WORKSPACE_A,
          slug: WORKSPACE_A,
          name: 'Alpha',
          members: [
            { userId: memberId, role: 'owner' },
            { userId: otherRoleId, role: 'builder' },
          ],
        },
        {
          id: WORKSPACE_B,
          slug: WORKSPACE_B,
          name: 'Beta',
          members: [{ userId: memberId, role: 'viewer' }],
        },
        { id: WORKSPACE_C, slug: WORKSPACE_C, name: 'Gamma', members: [] },
      ],
    }),
  });
  return { harness, memberId, otherRoleId };
}

describe('GET /api/workspaces/:id', () => {
  it('reads a workspace the caller belongs to', async () => {
    const { harness } = await seed();
    const response = await harness.call(GET, {
      method: 'GET',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'member@example.com' },
    });
    expect(response.status).toBe(200);
    const body = response.body as { workspace: { id: string; role: string } };
    expect(body.workspace.id).toBe(WORKSPACE_A);
    expect(body.workspace.role).toBe('owner');
    harness.teardown();
  });

  it('answers identically for a foreign workspace and a random UUID (no enumeration oracle)', async () => {
    const { harness } = await seed();
    const foreign = await harness.call(GET, {
      method: 'GET',
      path: `/api/workspaces/${WORKSPACE_C}`,
      id: WORKSPACE_C,
      as: { email: 'member@example.com' },
    });
    const nonexistent = await harness.call(GET, {
      method: 'GET',
      path: `/api/workspaces/${RANDOM_UUID}`,
      id: RANDOM_UUID,
      as: { email: 'member@example.com' },
    });
    expect(foreign.status).toBe(404);
    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.text).toBe(nonexistent.text);
    harness.teardown();
  });
});

describe('PATCH /api/workspaces/:id', () => {
  it('lets the workspace’s Owner rename it', async () => {
    const { harness } = await seed();
    const response = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'member@example.com' },
      body: { name: 'Renamed' },
    });
    expect(response.status).toBe(200);
    const body = response.body as { workspace: { name: string } };
    expect(body.workspace.name).toBe('Renamed');
    harness.teardown();
  });

  it('refuses a slug field: slug changes are a separate operation this route does not build', async () => {
    const { harness } = await seed();
    const response = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'member@example.com' },
      body: { slug: 'new-slug' },
    });
    expect(response.status).toBe(400);
    harness.teardown();
  });

  it(
    'refuses "slug" alongside a valid "name" as 400 invalid_field, not a silent rename ' +
      '(verification round 2, finding 3 — distinguishes this from empty_patch, which "name" ' +
      'alone would never trigger)',
    async () => {
      const { harness } = await seed();
      const response = await harness.call(PATCH, {
        method: 'PATCH',
        path: `/api/workspaces/${WORKSPACE_A}`,
        id: WORKSPACE_A,
        as: { email: 'member@example.com' },
        body: { name: 'Renamed With Slug', slug: 'sneaky' },
      });
      expect(response.status).toBe(400);
      const body = response.body as { error: { code: string } };
      expect(body.error.code).toBe('invalid_field');

      // The name must be unchanged: a route that dropped the unrecognised "slug" and renamed
      // anyway would still answer 400 here under a naive assertion, so read the row back.
      const read = await harness.call(GET, {
        method: 'GET',
        path: `/api/workspaces/${WORKSPACE_A}`,
        id: WORKSPACE_A,
        as: { email: 'member@example.com' },
      });
      const readBody = read.body as { workspace: { name: string } };
      expect(readBody.workspace.name).toBe('Alpha');
      harness.teardown();
    },
  );

  it('lets the Owner archive it, and GET still reads it afterwards (non-destructive)', async () => {
    const { harness } = await seed();
    const archived = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'member@example.com' },
      body: { archived: true },
    });
    expect(archived.status).toBe(200);
    expect(
      (archived.body as { workspace: { archivedAt: string | null } }).workspace.archivedAt,
    ).not.toBeNull();

    const stillReadable = await harness.call(GET, {
      method: 'GET',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'member@example.com' },
    });
    expect(stillReadable.status).toBe(200);
    harness.teardown();
  });

  it('rejects a non-object body as 400 malformed_body (verification round 1, finding 4)', async () => {
    const { harness } = await seed();
    const response = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'member@example.com' },
      body: 'just a string',
    });
    expect(response.status).toBe(400);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('malformed_body');
    harness.teardown();
  });

  it('rejects an empty patch as 400 empty_patch (verification round 1, finding 4)', async () => {
    const { harness } = await seed();
    const response = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'member@example.com' },
      body: {},
    });
    expect(response.status).toBe(400);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('empty_patch');
    harness.teardown();
  });

  it('rejects "archived" that is not a boolean (verification round 1, finding 4)', async () => {
    const { harness } = await seed();
    const response = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'member@example.com' },
      body: { archived: 'true' },
    });
    expect(response.status).toBe(400);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('invalid_field');
    harness.teardown();
  });

  it('rejects a blank or non-string "name" (verification round 1, finding 4)', async () => {
    const { harness } = await seed();
    const blank = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'member@example.com' },
      body: { name: '   ' },
    });
    expect(blank.status).toBe(400);
    const nonString = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'member@example.com' },
      body: { name: 42 },
    });
    expect(nonString.status).toBe(400);
    harness.teardown();
  });

  it('restores an archived workspace via {"archived": false} (verification round 1, finding 4)', async () => {
    const { harness } = await seed();
    const archived = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'member@example.com' },
      body: { archived: true },
    });
    expect(archived.status).toBe(200);
    const restored = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'member@example.com' },
      body: { archived: false },
    });
    expect(restored.status).toBe(200);
    const body = restored.body as { workspace: { archivedAt: string | null } };
    expect(body.workspace.archivedAt).toBeNull();
    harness.teardown();
  });

  it('refuses a real member who is not this workspace’s Owner — 403, not 404', async () => {
    const { harness } = await seed();
    const response = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: 'other-role@example.com' },
      body: { name: 'Should not happen' },
    });
    expect(response.status).toBe(403);
    harness.teardown();
  });

  it('answers identically for a foreign workspace and a random UUID (no enumeration oracle)', async () => {
    const { harness } = await seed();
    const foreign = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_C}`,
      id: WORKSPACE_C,
      as: { email: 'member@example.com' },
      body: { name: 'X' },
    });
    const nonexistent = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${RANDOM_UUID}`,
      id: RANDOM_UUID,
      as: { email: 'member@example.com' },
      body: { name: 'X' },
    });
    expect(foreign.status).toBe(404);
    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.text).toBe(nonexistent.text);
    harness.teardown();
  });
});
