/**
 * `cli_sessions` (migration 0030, issue #242, SDK-10, S-22) against real PostgreSQL. ADR-0083.
 *
 * `apps/web/server/cli-auth/handlers.test.ts` drives the handlers over an in-memory fake that
 * re-implements this repository's contract; only this file proves the SQL itself — the one-shot
 * exchange under concurrent polls, the foreign-key-violation mapping in `moveToWorkspace`, the
 * cascade that ends a sign-in with its membership, and the revocation and expiry CHECKs.
 */
import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cliSessions } from '../schema/cli-sessions.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseCliSessionRepository, type CliSessionRepository } from './cli-sessions.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

const HOUR_MS = 60 * 60 * 1000;
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

/** A fresh eight-letter user code in the shape `cli_sessions_user_code_shape` accepts. */
function userCode(): string {
  let code = '';
  for (let index = 0; index < 8; index += 1) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

const tokenHash = (): string => crypto.randomBytes(32).toString('base64url');

describe.skipIf(!hasDatabase)('CliSessionRepository (migration 0030)', () => {
  let isolated: IsolatedTestDatabase;
  let repository: CliSessionRepository;
  const homeWorkspaceId = crypto.randomUUID();
  const secondWorkspaceId = crypto.randomUUID();
  const foreignWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const homeMembershipId = crypto.randomUUID();
  const secondMembershipId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_cli_sessions');
    await isolated.db.insert(workspaces).values([
      { id: homeWorkspaceId, slug: 'cli-home', name: 'Home' },
      { id: secondWorkspaceId, slug: 'cli-second', name: 'Second' },
      { id: foreignWorkspaceId, slug: 'cli-foreign', name: 'Foreign' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Ada' });
    for (const [membershipId, workspaceId] of [
      [homeMembershipId, homeWorkspaceId],
      [secondMembershipId, secondWorkspaceId],
    ] as const) {
      await isolated.db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: membershipId, workspaceId, userId, role: 'admin' });
        await tx
          .insert(workspacePrincipals)
          .values({ workspaceId, kind: 'membership', membershipId });
      });
    }
    repository = createDatabaseCliSessionRepository(isolated.db);
  }, 180_000);

  afterAll(async () => isolated.close());

  /** Approve a fresh code in `workspaceId` and exchange it; the token hash it issued. */
  async function signIn(workspaceId: string, lifetimeMs = 12 * HOUR_MS): Promise<string> {
    const code = userCode();
    const approvalExpiresAt = new Date(Date.now() + 10 * 60_000);
    await expect(
      repository.recordApproval({
        workspaceId,
        userId,
        userCode: code,
        decision: 'approved',
        approvalExpiresAt,
      }),
    ).resolves.toBe('recorded');
    const hash = tokenHash();
    const outcome = await repository.exchange(code, hash, new Date(Date.now() + lifetimeMs));
    expect(outcome).toEqual({ kind: 'issued', workspaceId, userId });
    return hash;
  }

  it('answers a user code at most once', async () => {
    const code = userCode();
    const input = {
      workspaceId: homeWorkspaceId,
      userId,
      userCode: code,
      decision: 'approved' as const,
      approvalExpiresAt: new Date(Date.now() + 60_000),
    };
    await expect(repository.recordApproval(input)).resolves.toBe('recorded');
    await expect(repository.recordApproval({ ...input, decision: 'denied' })).resolves.toBe(
      'code-taken',
    );
  });

  it('classifies an unanswered, a denied and an expired approval', async () => {
    await expect(
      repository.exchange(userCode(), tokenHash(), new Date(Date.now() + HOUR_MS)),
    ).resolves.toEqual({ kind: 'pending' });

    const denied = userCode();
    await repository.recordApproval({
      workspaceId: homeWorkspaceId,
      userId,
      userCode: denied,
      decision: 'denied',
      approvalExpiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      repository.exchange(denied, tokenHash(), new Date(Date.now() + HOUR_MS)),
    ).resolves.toEqual({ kind: 'denied' });

    const late = userCode();
    const approvalExpiresAt = new Date(Date.now() + 60_000);
    await repository.recordApproval({
      workspaceId: homeWorkspaceId,
      userId,
      userCode: late,
      decision: 'approved',
      approvalExpiresAt,
    });
    await expect(
      repository.exchange(
        late,
        tokenHash(),
        new Date(Date.now() + HOUR_MS),
        new Date(approvalExpiresAt.getTime() + 1),
      ),
    ).resolves.toEqual({ kind: 'expired' });
  });

  it('issues exactly once under two concurrent exchanges; the other answers spent', async () => {
    const code = userCode();
    await repository.recordApproval({
      workspaceId: homeWorkspaceId,
      userId,
      userCode: code,
      decision: 'approved',
      approvalExpiresAt: new Date(Date.now() + 60_000),
    });
    const expiresAt = new Date(Date.now() + HOUR_MS);
    const [first, second] = await Promise.all([
      repository.exchange(code, tokenHash(), expiresAt),
      repository.exchange(code, tokenHash(), expiresAt),
    ]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(['issued', 'spent']);
    // And every later poll of the same code, too.
    await expect(repository.exchange(code, tokenHash(), expiresAt)).resolves.toEqual({
      kind: 'spent',
    });
    const rows = await isolated.db.select().from(cliSessions).where(eq(cliSessions.userCode, code));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('active');
  });

  it('finds an active token by hash, with the workspace slug and the person’s email', async () => {
    const hash = await signIn(homeWorkspaceId);
    const found = await repository.findActiveByHash(hash);
    expect(found).toMatchObject({
      workspaceId: homeWorkspaceId,
      workspaceSlug: 'cli-home',
      userId,
      userEmail: `${userId}@example.com`,
    });
  });

  it('does not find an expired token', async () => {
    const hash = await signIn(homeWorkspaceId, 60_000);
    await expect(repository.findActiveByHash(hash)).resolves.not.toBeNull();
    await expect(
      repository.findActiveByHash(hash, new Date(Date.now() + 2 * 60_000)),
    ).resolves.toBeNull();
  });

  it('revokes once, satisfying cli_sessions_revoked_iff_status, and then finds nothing', async () => {
    const hash = await signIn(homeWorkspaceId);
    await expect(repository.revokeByHash(hash)).resolves.toBe(true);
    await expect(repository.findActiveByHash(hash)).resolves.toBeNull();
    await expect(repository.revokeByHash(hash)).resolves.toBe(false);
    const rows = await isolated.db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.tokenHash, hash));
    expect(rows[0]?.status).toBe('revoked');
    expect(rows[0]?.revokedAt).toBeInstanceOf(Date);
  });

  it('moves a token only to a workspace the person is a member of', async () => {
    const hash = await signIn(homeWorkspaceId);
    await expect(repository.moveToWorkspace(hash, secondWorkspaceId)).resolves.toBe(true);
    await expect(repository.findActiveByHash(hash)).resolves.toMatchObject({
      workspaceId: secondWorkspaceId,
      workspaceSlug: 'cli-second',
    });

    // The composite foreign key refuses a workspace with no membership (23503), mapped to false.
    await expect(repository.moveToWorkspace(hash, foreignWorkspaceId)).resolves.toBe(false);
    // A workspace that does not exist at all trips the same key.
    await expect(repository.moveToWorkspace(hash, crypto.randomUUID())).resolves.toBe(false);
    await expect(repository.findActiveByHash(hash)).resolves.toMatchObject({
      workspaceId: secondWorkspaceId,
    });

    await repository.revokeByHash(hash);
    await expect(repository.moveToWorkspace(hash, homeWorkspaceId)).resolves.toBe(false);
  });

  it('deletes the sign-in when its membership is deleted (ON DELETE CASCADE)', async () => {
    const hash = await signIn(secondWorkspaceId);
    await expect(repository.findActiveByHash(hash)).resolves.not.toBeNull();

    await isolated.db.delete(memberships).where(eq(memberships.id, secondMembershipId));

    await expect(repository.findActiveByHash(hash)).resolves.toBeNull();
    const rows = await isolated.db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.tokenHash, hash));
    expect(rows).toHaveLength(0);
  });
});
