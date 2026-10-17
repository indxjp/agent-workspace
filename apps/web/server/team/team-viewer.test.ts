/**
 * `resolveTeamViewer` — the one directory resolution both team capabilities are derived from,
 * issue #186.
 *
 * Every test here is a *refusal* path except the first. That is the point of the module: a viewer
 * this program could not establish must be `null` rather than a partially-filled value, because
 * both callers turn `null` into an all-deny capability and anything else into controls.
 */
import { describe, expect, it } from 'vitest';

import type { DirectoryRoot } from '../rbac/directory';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { ROLES, type Role } from '../rbac/roles';
import { resolveTeamViewer, type TeamViewerDirectory } from './team-viewer';

const WORKSPACE = { id: 'ws-team-viewer', slug: 'acme', name: 'Acme' };

function directoryWith(role: Role) {
  return createMemoryDirectory({
    users: [
      {
        id: `user-${role}`,
        email: `${role}@example.test`,
        name: `A ${role}`,
        workspaceId: WORKSPACE.id,
        role,
      },
    ],
    workspaces: [WORKSPACE],
  });
}

describe('resolveTeamViewer', () => {
  it.each([...ROLES])(
    'resolves a %s against the directory, not against the session token',
    async (role) => {
      expect(
        await resolveTeamViewer(directoryWith(role), {
          sub: `${role}@example.test`,
          ws: WORKSPACE.slug,
        }),
      ).toEqual({ userId: `user-${role}`, role });
    },
  );

  it('resolves nobody when the session names a user the directory does not have', async () => {
    expect(
      await resolveTeamViewer(directoryWith('owner'), {
        sub: 'nobody@example.test',
        ws: WORKSPACE.slug,
      }),
    ).toBeNull();
  });

  it('resolves nobody when the user holds no membership in the workspace the session names', async () => {
    // Issue #118's rule, enforced here rather than assumed: a membership removed since the cookie
    // was minted takes effect on this render, and every control disappears with it.
    expect(
      await resolveTeamViewer(directoryWith('owner'), {
        sub: 'owner@example.test',
        ws: 'some-other-workspace',
      }),
    ).toBeNull();
  });

  it('resolves nobody from a membership row carrying a role §21 does not name', async () => {
    // A corrupt row is exactly the value a type annotation is no evidence about — `conferRole` and
    // `decide` both re-parse their own role argument for this reason. The cast below manufactures
    // the row PostgreSQL's own check constraint would reject, which is the only way to reach the
    // branch from a unit test.
    const corrupt: TeamViewerDirectory = {
      findUserByEmail: () =>
        Promise.resolve({
          id: 'user-corrupt',
          email: 'corrupt@example.test',
          name: 'Corrupt',
          createdAt: '2026-09-12T00:00:00.000Z',
        }),
      membershipsForUser: () =>
        Promise.resolve([
          {
            principalId: '7d42c4d2-b4af-4c61-a8c8-3b2d4c93f345',
            workspaceId: WORKSPACE.id,
            workspaceSlug: WORKSPACE.slug,
            workspaceName: WORKSPACE.name,
            role: 'superuser' as Role,
          },
        ]),
    };
    expect(
      await resolveTeamViewer(corrupt, { sub: 'corrupt@example.test', ws: WORKSPACE.slug }),
    ).toBeNull();
  });

  it('reads the directory once per question, so composing two capabilities costs two reads', async () => {
    // The reason this module exists at all. Two independent resolvers would double these counts on
    // every render of `/admin/users` for an answer that cannot differ between them.
    let users = 0;
    let memberships = 0;
    const counting: TeamViewerDirectory = {
      findUserByEmail: (email) => {
        users += 1;
        return directoryWith('owner').findUserByEmail(email);
      },
      membershipsForUser: (id) => {
        memberships += 1;
        return directoryWith('owner').membershipsForUser(id);
      },
    };
    await resolveTeamViewer(counting, { sub: 'owner@example.test', ws: WORKSPACE.slug });
    expect([users, memberships]).toEqual([1, 1]);
  });

  it('accepts the real directory root, so the page passes it unchanged', () => {
    // A compile-time check: `TeamViewerDirectory` is a `Pick` of the runtime's own directory, so a
    // signature change there fails `pnpm typecheck` here rather than at the call site in the page.
    const accepts: (directory: DirectoryRoot) => TeamViewerDirectory = (directory) => directory;
    expect(typeof accepts).toBe('function');
  });
});
