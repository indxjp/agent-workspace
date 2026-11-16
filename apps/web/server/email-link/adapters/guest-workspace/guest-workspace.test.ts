/**
 * `GuestWorkspaceBinder`, run against the memory directory always and against a real PostgreSQL
 * whenever `TEST_DATABASE_URL` names one.
 */
import crypto from 'node:crypto';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { counterIds, randomIds } from '../../../ids';
import type { Role } from '../../../rbac/core/roles';
import { asOwner } from '../../../rbac/directory.test-support';
import { createPostgresDirectory } from '../../../rbac/postgres-directory';
import { describeGuestWorkspaceConformance } from './guest-workspace.contract';
import { createMemoryGuestWorkspaceBinder } from './memory';
import { createGuestWorkspaceBinder, demoWorkspaceSlug } from './production';

describeGuestWorkspaceConformance('the memory adapter', () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const { binder, directory } = createMemoryGuestWorkspaceBinder({ ids: counterIds() });
  return Promise.resolve({
    binder,
    directory,
    seedMember: (email: string, role: Role) => {
      // A seeded directory has no setter, so a real membership is made through the first-class
      // route a workspace owner uses; the binder's tests then read it like any other.
      const workspaceId = crypto.randomUUID();
      const seeded = directory.forWorkspace(workspaceId);
      return seeded
        .createUser({ email, name: 'Seeded', role: asOwner(role) })
        .then(() => undefined);
    },
    demoExpiresAt: (workspaceId: string) => Promise.resolve(directory.demoExpiresAt(workspaceId)),
    email: (local: string) => `${local}-${tag}@example.test`,
  });
});

describe('demoWorkspaceSlug', () => {
  it('is a valid workspace slug made of the last 12 hex digits of the id', () => {
    expect(demoWorkspaceSlug('00000000-0000-4000-8000-0000000000ab')).toBe('demo-0000000000ab');
    expect(demoWorkspaceSlug(randomIds.newId())).toMatch(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/u);
  });
});

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('GuestWorkspaceBinder over a real PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let database: DatabaseRoot;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_guest_workspace');
    database = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    await database.close();
    await isolated.close();
  });

  describeGuestWorkspaceConformance('the PostgreSQL adapter', () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const directory = createPostgresDirectory(database.directory);
    return Promise.resolve({
      binder: createGuestWorkspaceBinder({ directory, ids: randomIds }),
      directory,
      seedMember: async (email: string, role: Role) => {
        const workspaceId = crypto.randomUUID();
        const userId = crypto.randomUUID();
        const membershipId = crypto.randomUUID();
        await isolated.db
          .insert(workspaces)
          .values({ id: workspaceId, slug: `seed-${workspaceId.slice(0, 8)}`, name: 'Seeded' });
        await isolated.db.insert(users).values({ id: userId, email, name: 'Seeded' });
        // One transaction, as the directory suite seeds: the principal row must exist by commit.
        await isolated.db.transaction(async (tx) => {
          await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role });
          await tx
            .insert(workspacePrincipals)
            .values({ workspaceId, kind: 'membership', membershipId });
        });
      },
      demoExpiresAt: async (workspaceId: string) => {
        const rows = await isolated.db
          .select({ ends: workspaces.demoExpiresAt })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        return rows[0]?.ends ?? null;
      },
      email: (local: string) => `${local}-${tag}@example.test`,
    });
  });

  it('is one transaction: a second workspace id colliding on slug leaves no user residue', async () => {
    const directory = createPostgresDirectory(database.directory);
    const email = `rollback-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const id = crypto.randomUUID();
    const input = {
      email,
      now: new Date(),
      workspaceId: id,
      slug: 'demo-collision',
      lifetimeSeconds: 60,
    };
    await directory.bindGuestWorkspace(input);
    const other = `rollback-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await expect(
      directory.bindGuestWorkspace({
        ...input,
        email: other,
        workspaceId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await directory.findUserByEmail(other)).toBeNull();
  });
});
