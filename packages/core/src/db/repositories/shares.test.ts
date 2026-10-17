import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { memberships, users, workspacePrincipals, workspaces } from '../schema/index.js';
import {
  createDatabaseShareRepositoryProvider,
  createDatabaseShareViewRepositoryProvider,
} from './shares.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('ShareRepository workspace policy against PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let scope: WorkspaceScope;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_share_policy');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: 'share-policy', name: 'Share policy' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: 'owner@share-policy.test', name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    const resolved = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (resolved === null) throw new Error('share policy scope did not resolve');
    scope = resolved;
  }, 180_000);

  afterAll(async () => isolated.close());

  async function createRunnableShare(token: string, budgetCapUsd = '20.0000') {
    return createDatabaseShareRepositoryProvider(isolated.db).forScope(scope).create({
      token,
      subjectType: 'agent',
      subjectId: 'agent-1',
      subjectLabel: 'Runnable agent',
      visibility: 'public',
      include: {},
      mode: 'runnable',
      snapshot: null,
      budgetCapUsd,
      expiresAt: null,
      passphraseHash: null,
      publisherPrincipalId: principalId,
      createdBy: userId,
    });
  }

  it('persists policy changes and atomically suspends or resumes active shares', async () => {
    const provider = createDatabaseShareRepositoryProvider(isolated.db);
    const repository = provider.forScope(scope);
    const share = await repository.create({
      token: 'pub_policy_test',
      subjectType: 'session',
      subjectId: 'session-1',
      subjectLabel: 'Session',
      visibility: 'public',
      include: {},
      mode: null,
      snapshot: null,
      budgetCapUsd: null,
      expiresAt: null,
      passphraseHash: null,
      publisherPrincipalId: principalId,
      createdBy: userId,
    });

    await expect(repository.getPublicSharingEnabled()).resolves.toBe(true);
    await repository.setPublicSharingEnabled(false);
    await expect(provider.forScope(scope).getPublicSharingEnabled()).resolves.toBe(false);
    expect((await repository.get(share.id))?.suspendedAt).toBeInstanceOf(Date);

    await repository.setPublicSharingEnabled(true);
    await expect(provider.forScope(scope).getPublicSharingEnabled()).resolves.toBe(true);
    expect((await repository.get(share.id))?.suspendedAt).toBeNull();
  });

  it('atomically limits concurrent visitor reservations across repository instances', async () => {
    const share = await createRunnableShare('pub_atomic_visitor');
    const provider = createDatabaseShareRepositoryProvider(isolated.db);
    const now = new Date('2026-09-12T12:00:00Z');
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        provider.forScope(scope).reserveVisitorMessage({
          id: share.id,
          visitorKey: 'v1_same_visitor',
          windowStartedAt: new Date(now.getTime() - 3_600_000),
          now: new Date(now.getTime() + index),
          limit: 5,
        }),
      ),
    );

    expect(attempts.filter((result) => result.kind === 'reserved')).toHaveLength(5);
    expect(attempts.filter((result) => result.kind === 'rate-limited')).toHaveLength(15);
    await expect(
      createDatabaseShareViewRepositoryProvider(isolated.db).forScope(scope).count(share.id),
    ).resolves.toBe(5);
    await expect(
      createDatabaseShareRepositoryProvider(isolated.db).forScope(scope).get(share.id),
    ).resolves.toMatchObject({ stopped: false });
  });

  it('stops a share idempotently', async () => {
    const share = await createRunnableShare('pub_idempotent_stop');
    const repository = createDatabaseShareRepositoryProvider(isolated.db).forScope(scope);

    await expect(repository.stop(share.id)).resolves.toBe(true);
    await expect(repository.stop(share.id)).resolves.toBe(false);
  });
});
