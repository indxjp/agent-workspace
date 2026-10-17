/**
 * Verification round 1, finding 4: `access.ts`'s `isUuid(id)` guard is load-bearing against REAL
 * PostgreSQL, not just against the in-memory fixture. `workspaces.id` is a `uuid` column
 * (`packages/core/src/db/schema/workspaces.ts`); a non-UUID path segment reaching
 * `WorkspaceRepository.getForMember`/`.get` makes PostgreSQL throw
 * `invalid input syntax for type uuid`, which neither resolver catches — so without the guard the
 * route would 500 instead of answering the same concealment `404` a foreign or absent id gets.
 * `createMemoryWorkspaceRepository` (a `Map` keyed by string) cannot reproduce that failure, so
 * this needs the real repository — this file drives `memberOwnershipResolver`/
 * `ownerOwnershipResolver` directly against one opened over an isolated PostgreSQL 17.
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { mintSessionToken, newSessionClaims, verifySessionToken } from '../auth/session';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { memberOwnershipResolver, ownerOwnershipResolver } from './access';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[workspaces/isuuid-guard.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the isUuid ' +
      'guard was NOT proven against real PostgreSQL. A green result without it says nothing ' +
      'about whether the guard is load-bearing.',
  );
}

const TEST_SESSION_SECRET = 'isuuid-guard-test-secret-at-least-32-characters';
const NOT_A_UUID = 'not-a-uuid';

describe.skipIf(!hasDatabase)(
  'the isUuid guard in access.ts, proved against real PostgreSQL (finding 4)',
  () => {
    let isolated: IsolatedTestDatabase;
    let root: DatabaseRoot;
    let principal: Principal;
    let scopedDirectory: ReturnType<ReturnType<typeof createMemoryDirectory>['forWorkspace']>;
    const workspace = { id: crypto.randomUUID(), slug: 'isuuid-guard-it', name: 'IsUuid Guard IT' };
    const owner = { email: 'owner@isuuid-guard-it.test', name: 'Owner' };

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_isuuid_guard');
      root = await openDatabaseRoot({ DATABASE_URL: isolated.url });

      // A real UUID user id, resolved from the in-memory RBAC directory (which
      // `resolveActorUserId` — called inside both resolvers — reads), and then written into real
      // PostgreSQL under that same id so the two agree on who the caller is.
      const memoryDirectory = createMemoryDirectory({
        users: [{ email: owner.email, name: owner.name, workspaceId: workspace.id, role: 'owner' }],
        newId: () => crypto.randomUUID(),
      });
      const ownerId = (await memoryDirectory.findUserByEmail(owner.email))?.id;
      if (ownerId === undefined) throw new Error('seed failed');
      scopedDirectory = memoryDirectory.forWorkspace(workspace.id);
      const ownerMembership = (await scopedDirectory.listMemberships()).find(
        (membership) => membership.userId === ownerId,
      );
      if (ownerMembership === undefined) throw new Error('membership seed failed');

      await isolated.db.insert(workspaces).values(workspace);
      await isolated.db.insert(users).values({ id: ownerId, email: owner.email, name: owner.name });
      await isolated.db.transaction(async (tx) => {
        await tx.insert(memberships).values({
          id: 'b144b396-9b7f-421d-a17c-5a4eb1146521',
          workspaceId: workspace.id,
          userId: ownerId,
          role: 'owner',
        });
        await tx.insert(workspacePrincipals).values({
          id: 'a3d764f7-fab6-492a-9707-4969cf49e0ef',
          workspaceId: workspace.id,
          kind: 'membership',
          membershipId: 'b144b396-9b7f-421d-a17c-5a4eb1146521',
        });
      });

      const claims = await mintSessionToken(
        newSessionClaims(owner.email, workspace.slug),
        TEST_SESSION_SECRET,
      );
      const verified = await verifySessionToken(claims, TEST_SESSION_SECRET);
      if (!verified.ok)
        throw new Error(`the test could not verify its own token: ${verified.reason}`);
      const built = Principal.fromSession(
        verified.claims,
        { id: workspace.id, slug: workspace.slug },
        'owner',
        {
          principalId: ownerMembership.principalId,
          userId: ownerId,
          label: owner.name,
        },
      );
      if (!built.ok) throw new Error(built.because);
      principal = built.principal;
    }, 180_000);

    afterAll(async () => {
      await closeIsolatedTestResources(isolated, root);
    });

    it('sanity: the real workspace id resolves ownership for both resolvers', async () => {
      const memberOutcome = await memberOwnershipResolver(root.workspaces, workspace.id)(
        principal,
        scopedDirectory,
      );
      expect(memberOutcome).toEqual({ kind: 'ownership', ownership: 'own' });

      const ownerOutcome = await ownerOwnershipResolver(root.workspaces, workspace.id)(
        principal,
        scopedDirectory,
      );
      expect(ownerOutcome).toEqual({ kind: 'ownership', ownership: 'own' });
    });

    it('memberOwnershipResolver answers the concealment 404 for a non-UUID id, not a 500', async () => {
      const outcome = await memberOwnershipResolver(root.workspaces, NOT_A_UUID)(
        principal,
        scopedDirectory,
      );
      expect(outcome.kind).toBe('refuse');
      if (outcome.kind === 'refuse') expect(outcome.result.status).toBe(404);
    });

    it('ownerOwnershipResolver answers the concealment 404 for a non-UUID id, not a 500', async () => {
      const outcome = await ownerOwnershipResolver(root.workspaces, NOT_A_UUID)(
        principal,
        scopedDirectory,
      );
      expect(outcome.kind).toBe('refuse');
      if (outcome.kind === 'refuse') expect(outcome.result.status).toBe(404);
    });
  },
);
