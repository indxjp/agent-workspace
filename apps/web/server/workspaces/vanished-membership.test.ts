/**
 * A session caller whose own membership disappears DURING a `/api/workspaces` request is refused
 * — never answered as the workspace's oldest Owner — at every place a route resolves the caller's
 * `users.id` (verification round 2, finding 4; round 3, findings 1 and 2).
 *
 * `access.test.ts` proves this for the two resolvers in isolation. This file drives the four real
 * route handlers through the RBAC harness so the proof also covers the two identity resolutions
 * the resolvers do not perform: `withIdentity` in `apps/web/app/api/workspaces/route.ts` (list
 * and create), and `GET /api/workspaces/:id`'s own SECOND `listMemberships()` read after the
 * resolver has already allowed.
 *
 * ## How the race is constructed
 *
 * The real race is a second request deleting the membership between two reads of the first. The
 * state it produces is what matters, and it is constructed deterministically: the installed RBAC
 * runtime's `DirectoryRoot` is wrapped so that the N-th `listMemberships()` read of the request
 * deletes the caller's membership first — N = 1 drops it between `identify()` and the route's
 * first resolution (every route), N = 2 drops it between the resolver's read and the item `GET`
 * handler's own re-read (the site round 3 found still on the fallback). `identify()` itself reads
 * `resolveRole` on the unwrapped directory, so the session is verified exactly as it would be a
 * moment before the deletion in production.
 *
 * ## Why each case asserts what the fallback WOULD have produced
 *
 * With `resolveActorUserId`'s `oldestOwnerUserId` fallback reinstated at any of these sites, the
 * refused caller (a Viewer of the session workspace, and of workspace A) is answered as the
 * oldest Owner: `GET :id` reports `"role":"owner"`, list includes the Owner-only workspace D,
 * create stamps the Owner as the new workspace's sole member. Each test asserts the absence of
 * exactly that artefact, in addition to the refusing status, so inverting any one site back to the
 * fallback turns a named test red.
 */
import { clearApplicationContext, applicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import type { DirectoryRoot, WorkspaceDirectory } from '../rbac/directory';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from '../rbac/testing';
import { createMemoryWorkspaceRepository } from './testing';
import { GET as GET_COLLECTION, POST } from '../../app/api/workspaces/route';
import { GET as GET_ITEM, PATCH } from '../../app/api/workspaces/[id]/route';

const WORKSPACE_A = '7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff';
const WORKSPACE_D = '9c9a3a9a-9c1e-4a3e-8b1f-2e6c4a2b7f10';
const OWNER = 'owner@example.com';
const VIEWER = 'viewer@example.com';

afterEach(() => {
  clearApplicationContext();
});

interface Seeded {
  readonly harness: RbacHarness;
  readonly ownerId: string;
  readonly viewerId: string;
  readonly repository: ReturnType<typeof createMemoryWorkspaceRepository>;
  /** Every `listMemberships()` read the wrapped directory served, in order, as member emails. */
  readonly reads: string[][];
}

/**
 * Seed an Owner and a Viewer in the session workspace, both members of workspace A (Owner and
 * Viewer respectively) and only the Owner a member of workspace D; then wrap the installed
 * runtime's directory so the `dropBeforeRead`-th `listMemberships()` read deletes the Viewer's
 * session-workspace membership before answering.
 */
async function seed(dropBeforeRead: number): Promise<Seeded> {
  const harness = installRbacHarness([
    { email: OWNER, name: 'Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
    { email: VIEWER, name: 'Viewer', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
  ]);
  const ownerId = (await harness.directory.findUserByEmail(OWNER))?.id;
  const viewerId = (await harness.directory.findUserByEmail(VIEWER))?.id;
  if (ownerId === undefined || viewerId === undefined) throw new Error('seed failed');

  const repository = createMemoryWorkspaceRepository({
    workspaces: [
      {
        id: WORKSPACE_A,
        slug: 'alpha',
        name: 'Alpha',
        members: [
          { userId: ownerId, role: 'owner' },
          { userId: viewerId, role: 'viewer' },
        ],
      },
      {
        id: WORKSPACE_D,
        slug: 'delta',
        name: 'Delta',
        members: [{ userId: ownerId, role: 'owner' }],
      },
    ],
  });
  installTestDomains({ workspaces: { repository } });

  const installed = applicationContext()?.rbac ?? null;
  if (installed === null) throw new Error('the harness installed no runtime');
  const reads: string[][] = [];
  let readCount = 0;
  const wrapScoped = (scoped: WorkspaceDirectory): WorkspaceDirectory => ({
    ...scoped,
    listMemberships: async () => {
      readCount += 1;
      if (readCount === dropBeforeRead) {
        const viewer = (await scoped.listMemberships()).find((m) => m.email === VIEWER);
        if (viewer === undefined) throw new Error('the viewer membership was already gone');
        const deleted = await scoped.deleteMembership(viewer.id);
        if (deleted.kind !== 'deleted') throw new Error(deleted.kind);
      }
      const memberships = await scoped.listMemberships();
      reads.push(memberships.map((m) => m.email).sort());
      return memberships;
    },
  });
  const root: DirectoryRoot = {
    ...installed.directory,
    forWorkspace: (workspaceId) => wrapScoped(installed.directory.forWorkspace(workspaceId)),
  };
  installTestDomains({
    rbac: { identify: (request) => installed.identify(request), directory: root },
  });

  return { harness, ownerId, viewerId, repository, reads };
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

describe('a session caller whose membership vanished mid-request is refused at every /api/workspaces identity resolution, never answered as the oldest Owner', () => {
  it('GET /api/workspaces/:id — membership dropped AFTER the resolver’s read and BEFORE the handler’s own re-read (verification round 3, finding 1)', async () => {
    const { harness, reads } = await seed(2);
    const response = await harness.call(GET_ITEM, {
      method: 'GET',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: VIEWER },
    });
    // The state the test claims to construct: the first read still lists the viewer, the second
    // does not — i.e. the resolver allowed and only the handler's re-read saw the deletion.
    expect(reads).toEqual([[OWNER, VIEWER], [OWNER]]);
    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe('workspace_not_found');
    // The fallback's artefact: the Owner's view of A, reported to the (former) Viewer.
    expect(response.text).not.toContain('"role":"owner"');
    expect(response.text).not.toContain('"workspace"');
    harness.teardown();
  });

  it('GET /api/workspaces/:id — membership dropped before the resolver’s read', async () => {
    const { harness, reads } = await seed(1);
    const response = await harness.call(GET_ITEM, {
      method: 'GET',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: VIEWER },
    });
    expect(reads).toEqual([[OWNER]]);
    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe('workspace_not_found');
    expect(response.text).not.toContain('"role":"owner"');
    harness.teardown();
  });

  it('PATCH /api/workspaces/:id — refused, and the workspace is untouched', async () => {
    const { harness, repository, reads } = await seed(1);
    const response = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/workspaces/${WORKSPACE_A}`,
      id: WORKSPACE_A,
      as: { email: VIEWER },
      body: { name: 'Renamed by a vanished member', archived: true },
    });
    expect(reads).toEqual([[OWNER]]);
    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe('workspace_not_found');
    const row = await repository.get(WORKSPACE_A);
    expect(row?.name).toBe('Alpha');
    expect(row?.archivedAt).toBeNull();
    harness.teardown();
  });

  it('GET /api/workspaces — refused as undecidable, never the Owner’s list (verification round 3, finding 2)', async () => {
    const { harness, reads } = await seed(1);
    const response = await harness.call(GET_COLLECTION, {
      method: 'GET',
      path: '/api/workspaces',
      as: { email: VIEWER },
    });
    expect(reads).toEqual([[OWNER]]);
    expect(response.status).toBe(500);
    expect(errorCode(response.body)).toBe('authorisation_undecidable');
    // The fallback's artefact: workspace D, which only the Owner belongs to.
    expect(response.text).not.toContain(WORKSPACE_D);
    expect(response.text).not.toContain('"workspaces"');
    harness.teardown();
  });

  it('POST /api/workspaces — refused as undecidable, and nothing is created for the Owner (verification round 3, finding 2)', async () => {
    const { harness, ownerId, viewerId, repository, reads } = await seed(1);
    const response = await harness.call(POST, {
      method: 'POST',
      path: '/api/workspaces',
      as: { email: VIEWER },
      body: { slug: 'vanished', name: 'Vanished' },
    });
    expect(reads).toEqual([[OWNER]]);
    expect(response.status).toBe(500);
    expect(errorCode(response.body)).toBe('authorisation_undecidable');
    // The fallback's artefact: a new workspace whose sole Owner is the oldest Owner, created on a
    // request they never made.
    const ownersWorkspaces = (await repository.listForUser(ownerId)).map((w) => w.slug).sort();
    expect(ownersWorkspaces).toEqual(['alpha', 'delta']);
    const viewersWorkspaces = (await repository.listForUser(viewerId)).map((w) => w.slug);
    expect(viewersWorkspaces).toEqual(['alpha']);
    harness.teardown();
  });
});
