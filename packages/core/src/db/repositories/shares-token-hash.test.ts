// Part 06 step 3: a public link is looked up by the SHA-256 of its token, never by the token itself.
// Phase 2 (0105): only the hash is stored. Every link made before keeps working, and a web process
// from the previous release, which still writes `token`, gets its hash from 0105's trigger.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { packagedMigrationsDir } from '../migrate.js';
import { memberships, shares, users, workspacePrincipals, workspaces } from '../schema/index.js';
import { rootQueries } from './root-queries.js';
import { createDatabaseShareRepositoryProvider } from './shares.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

/** What `hashApiKeySecret` (apps/web/server/rbac/api-key.ts) gives: SHA-256 of UTF-8, lower-case hex. */
const hashOf = (token: string): string =>
  crypto.createHash('sha256').update(token, 'utf8').digest('hex');

describe.skipIf(!hasDatabase)('share link tokens are hashed at rest (PostgreSQL)', () => {
  let isolated: IsolatedTestDatabase;
  let scope: WorkspaceScope;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_share_token_hash');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: 'share-hash', name: 'Share hash' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: 'owner@share-hash.test', name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    const resolved = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (resolved === null) throw new Error('share hash scope did not resolve');
    scope = resolved;
  }, 180_000);

  afterAll(async () => isolated.close());

  const createShare = (token: string, visibility: 'public' | 'workspace' = 'public') =>
    createDatabaseShareRepositoryProvider(isolated.db)
      .forScope(scope)
      .create({
        tokenHash: hashOf(token),
        subjectType: 'session',
        subjectId: `session-${token}`,
        subjectLabel: 'Session',
        visibility,
        include: {},
        mode: null,
        snapshot: null,
        budgetCapUsd: null,
        expiresAt: null,
        passphraseHash: null,
        publisherPrincipalId: principalId,
        createdBy: userId,
      });

  /** The plain `token` column of one share, read past the repository, which never selects it. */
  const storedToken = async (id: string): Promise<string | null> =>
    (
      await isolated.db
        .select({ token: shares.token })
        .from(shares)
        .where(sql`${shares.id} = ${id}`)
    )[0]!.token;

  it('stores only the hash of a new link, never the token', async () => {
    const token = `pub_${crypto.randomBytes(18).toString('base64url')}`;
    const share = await createShare(token);
    expect(share.tokenHash).toBe(hashOf(token));
    expect(share).not.toHaveProperty('token', token);
    expect(await storedToken(share.id)).toBeNull();
  });

  it('finds a link by the hash of its token, and never by the token itself', async () => {
    const token = 'pub_lookup-by-hash';
    const created = await createShare(token);
    const repository = createDatabaseShareRepositoryProvider(isolated.db).forScope(scope);
    expect((await repository.findByTokenHash(hashOf(token)))?.id).toBe(created.id);
    expect(await repository.findByTokenHash(token)).toBeNull();
    expect(await repository.findByTokenHash(hashOf('pub_some-other-token'))).toBeNull();
  });

  it('resolves only a public link to its workspace, by hash', async () => {
    const root = rootQueries(isolated.db);
    await createShare('pub_root-public');
    await createShare('pub_root-workspace', 'workspace');
    expect(await root.findShareWorkspace(hashOf('pub_root-public'))).toBe(workspaceId);
    expect(await root.findShareWorkspace('pub_root-public')).toBeNull();
    expect(await root.findShareWorkspace(hashOf('pub_root-workspace'))).toBeNull();
  });

  it('hashes a row the previous release writes during a rolling update', async () => {
    const token = 'pub_written-by-the-previous-release';
    // The insert the previous release sends: `token`, and no token_hash (it was generated then).
    await isolated.db.execute(sql`
      insert into shares (workspace_id, token, subject_type, subject_id, subject_label, visibility,
                          publisher_principal_id)
      values (${workspaceId}, ${token}, 'session', 'session-old', 'Session', 'public',
              ${principalId})`);
    const repository = createDatabaseShareRepositoryProvider(isolated.db).forScope(scope);
    expect((await repository.findByTokenHash(hashOf(token)))?.subjectId).toBe('session-old');
  });

  it('clears every stored token and keeps each link working by its hash (0105)', async () => {
    const run = async (file: string) => {
      const migration = readFileSync(path.join(packagedMigrationsDir(), file), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) {
        await isolated.db.execute(sql.raw(statement));
      }
    };
    // Back to the table as 0104 left it: a NOT NULL token and a generated hash.
    await isolated.db.execute(sql`delete from shares where token is null`);
    await isolated.db.execute(sql`drop trigger shares_token_hash_from_token on shares`);
    await isolated.db.execute(sql`drop function shares_token_hash_from_token()`);
    await isolated.db.execute(sql`alter table shares drop column token_hash`);
    await isolated.db.execute(sql`alter table shares alter column token set not null`);
    await run('0104_share_token_hash.sql');
    const token = 'pub_made-before-phase-2';
    await isolated.db.execute(sql`
      insert into shares (workspace_id, token, subject_type, subject_id, subject_label, visibility,
                          publisher_principal_id)
      values (${workspaceId}, ${token}, 'session', 'session-before', 'Session', 'public',
              ${principalId})`);
    const before = await isolated.db
      .select({ id: shares.id, tokenHash: shares.tokenHash })
      .from(shares);
    expect(before.length).toBeGreaterThan(1);

    await run('0105_share_token_shown_once.sql');

    const after = await isolated.db
      .select({ id: shares.id, token: shares.token, tokenHash: shares.tokenHash })
      .from(shares);
    expect(after.map((row) => row.token)).toEqual(after.map(() => null));
    expect(new Map(after.map((row) => [row.id, row.tokenHash]))).toEqual(
      new Map(before.map((row) => [row.id, row.tokenHash])),
    );
    const repository = createDatabaseShareRepositoryProvider(isolated.db).forScope(scope);
    expect((await repository.findByTokenHash(hashOf(token)))?.subjectId).toBe('session-before');
    // A share the web process now writes still needs its hash: the column is NOT NULL.
    await expect(
      isolated.db.execute(sql`
        insert into shares (workspace_id, subject_type, subject_id, subject_label, visibility,
                            publisher_principal_id)
        values (${workspaceId}, 'session', 'session-no-hash', 'Session', 'public', ${principalId})`),
    ).rejects.toThrow();
  });

  it('keeps a unique index on the hash, which every lookup uses', async () => {
    const indexes = await isolated.db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where tablename = 'shares' and indexname = 'shares_token_hash_key'`,
    );
    expect(indexes.rows.map((row) => row.indexdef)).toEqual([
      expect.stringMatching(
        /CREATE UNIQUE INDEX shares_token_hash_key ON public\.shares USING btree \(token_hash\)/u,
      ),
    ]);
  });
});
