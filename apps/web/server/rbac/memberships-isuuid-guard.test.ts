/**
 * Issue #203: the `isUuid` guard in `changeMembershipRole`/`deleteMembership` is load-bearing
 * against REAL PostgreSQL, and this file is the regression that proves it.
 *
 * `memberships.id` is a `uuid` column (`packages/core/src/db/schema/memberships.ts` →
 * `primaryKeyId()`); a non-UUID path segment reaching `eq(memberships.id, id)` makes PostgreSQL
 * raise `22P02 invalid input syntax for type uuid`, and nothing above the handlers catches it —
 * `authorise` calls them with no `try`/`catch` — so without the guard `PATCH`/`DELETE
 * /api/memberships/not-a-uuid` escaped as an unhandled error instead of answering the `404` a
 * UUID naming no membership gets.
 *
 * `createMemoryDirectory` (a `Map` keyed by string) cannot reproduce that failure: it answers
 * `no-such-membership` for `'not-a-uuid'` with or without the guard. So the harness-driven cases
 * in `routes.test.ts` pin the contract through the real route modules but are green before the
 * fix, and this file — the real repository over an isolated PostgreSQL 17, the same shape as
 * `apps/web/server/workspaces/isuuid-guard.test.ts` and `postgres-directory.test.ts` — is the one
 * that fails for the old behaviour.
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import type { WorkspaceDirectory } from './directory';
import { changeMembershipRole, deleteMembership } from './handlers';
import type { ApiResult } from '../http/result';
import { createPostgresDirectory } from './postgres-directory';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[rbac/memberships-isuuid-guard.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the ' +
      'isUuid guard on PATCH/DELETE /api/memberships/:id was NOT proven against real PostgreSQL. ' +
      'A green run without it says nothing about whether the guard is load-bearing.',
  );
}

/** Well formed, and no membership has it: the control every malformed case is compared against. */
const ABSENT_UUID = '3f1c0b4e-9a2d-4c77-8b61-0e5d2a7c4f90';
const NOT_A_UUID = 'not-a-uuid';

/**
 * The response, with the id substituted out. The `no_such_membership` detail echoes the id the
 * caller sent, so that substring is the one thing the two answers may legitimately differ in —
 * everything else has to be equal for "the same refusal" to mean anything.
 */
function withoutId(result: ApiResult, id: string): { status: number; body: string } {
  return { status: result.status, body: JSON.stringify(result.body).replaceAll(id, '<id>') };
}

describe.skipIf(!hasDatabase)(
  'a malformed membership id is concealed rather than handed to a uuid column (issue #203)',
  () => {
    let isolated: IsolatedTestDatabase;
    let root: DatabaseRoot;
    let directory: WorkspaceDirectory;
    const workspace = {
      id: crypto.randomUUID(),
      slug: 'memberships-isuuid-guard',
      name: 'Memberships isUuid guard',
    };
    const owner = {
      id: crypto.randomUUID(),
      email: 'owner@memberships-isuuid-guard.test',
      name: 'The Owner',
    };

    /**
     * A member this workspace can lose: the last-Owner rule protects `owner` above, and both
     * sanity cases below mutate or remove the row they are given, so each takes its own.
     */
    async function seedMember(): Promise<string> {
      const user = {
        id: crypto.randomUUID(),
        email: `member-${crypto.randomUUID()}@memberships-isuuid-guard.test`,
        name: 'A Member',
      };
      await isolated.db.insert(users).values(user);
      const membershipId = crypto.randomUUID();
      await isolated.db.transaction(async (tx) => {
        await tx.insert(memberships).values({
          id: membershipId,
          workspaceId: workspace.id,
          userId: user.id,
          role: 'viewer',
        });
        await tx.insert(workspacePrincipals).values({
          id: crypto.randomUUID(),
          workspaceId: workspace.id,
          kind: 'membership',
          membershipId,
        });
      });
      return membershipId;
    }

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_memberships_isuuid_guard');
      await isolated.db.insert(workspaces).values(workspace);
      await isolated.db.insert(users).values(owner);
      const ownerMembershipId = crypto.randomUUID();
      await isolated.db.transaction(async (tx) => {
        await tx.insert(memberships).values({
          id: ownerMembershipId,
          workspaceId: workspace.id,
          userId: owner.id,
          role: 'owner',
        });
        await tx.insert(workspacePrincipals).values({
          id: crypto.randomUUID(),
          workspaceId: workspace.id,
          kind: 'membership',
          membershipId: ownerMembershipId,
        });
      });
      root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
      directory = createPostgresDirectory(root.directory).forWorkspace(workspace.id);
    }, 180_000);

    afterAll(async () => {
      await root.close();
      await isolated.close();
    });

    it('sanity: a real membership id still changes a role and removes a member', async () => {
      const changeable = await seedMember();
      const changed = await changeMembershipRole(directory, 'owner', changeable, {
        role: 'builder',
      });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);

      const removable = await seedMember();
      const removed = await deleteMembership(directory, 'owner', removable);
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    });

    it('PATCH answers a non-UUID id exactly as it answers an absent UUID', async () => {
      const body = { role: 'builder' };
      const absent = await changeMembershipRole(directory, 'owner', ABSENT_UUID, body);
      // Positively first: two 500s would satisfy equality on their own.
      expect(absent.status, JSON.stringify(absent.body)).toBe(404);

      // Without the guard this call rejects with `22P02 invalid input syntax for type uuid`
      // instead of returning, which fails the test by an unhandled rejection rather than an
      // inequality — that is the old behaviour this regression exists to catch.
      const malformed = await changeMembershipRole(directory, 'owner', NOT_A_UUID, body);
      expect(withoutId(malformed, NOT_A_UUID)).toEqual(withoutId(absent, ABSENT_UUID));
    });

    it('DELETE answers a non-UUID id exactly as it answers an absent UUID', async () => {
      const absent = await deleteMembership(directory, 'owner', ABSENT_UUID);
      expect(absent.status, JSON.stringify(absent.body)).toBe(404);

      const malformed = await deleteMembership(directory, 'owner', NOT_A_UUID);
      expect(withoutId(malformed, NOT_A_UUID)).toEqual(withoutId(absent, ABSENT_UUID));
    });
  },
);
