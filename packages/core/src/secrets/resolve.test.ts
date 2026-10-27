/**
 * `resolveSecretByName` against a real PostgreSQL — the one code path in this subsystem allowed
 * to produce a plaintext value, exercised end to end: seal through `sealSecret`, persist through
 * the real repository's `create`, then decrypt through `resolveSecretByName` and check the
 * plaintext survived the round trip.
 *
 * Reaches `db/**` by relative path throughout, never through `@agent-workspace/core/db/unscoped` —
 * see `repository.test.ts`'s header for why mixing the two module-resolution paths in one file
 * mints two distinct `WorkspaceScope` classes and makes every scope look forged to the other.
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '../db/repositories/testing.js';
import { createDatabaseWorkspaceScopeResolver } from '../db/repositories/scope.js';
import { workspaces } from '../db/schema/workspaces.js';
import { sealSecret } from './envelope.js';
import { loadMasterKey, MASTER_KEY_ENV_VAR, type MasterKey } from './master-key.js';
import { createDatabaseSecretsRepositoryProvider } from './repository.js';
import { resolveSecretById, resolveSecretByName } from './resolve.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[secrets/resolve.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so secret resolution ' +
      'against a real PostgreSQL was NOT exercised.',
  );
}

describe.skipIf(!hasDatabase)('resolveSecretByName — PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const masterKey: MasterKey = loadMasterKey({
    [MASTER_KEY_ENV_VAR]: crypto.randomBytes(32).toString('hex'),
  });

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w2cp02_resolve');
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  it('decrypts exactly the plaintext that was sealed and stored', async () => {
    const workspaceId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: 'W' });
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace does not resolve');

    const plaintext = Buffer.from('sk-ant-api03-real-looking-value', 'utf8');
    const envelope = sealSecret(masterKey, plaintext);
    await createDatabaseSecretsRepositoryProvider(isolated.db)
      .forScope(scope)
      .create({ name: 'ANTHROPIC_API_KEY', envelope });

    const resolved = await resolveSecretByName(isolated.db, scope, masterKey, 'ANTHROPIC_API_KEY');
    expect(resolved).not.toBeNull();
    expect(resolved?.value.equals(plaintext)).toBe(true);
    expect(resolved?.name).toBe('ANTHROPIC_API_KEY');
  });

  it('answers null for a name this workspace has no secret under', async () => {
    const workspaceId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: 'W' });
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace does not resolve');

    const resolved = await resolveSecretByName(isolated.db, scope, masterKey, 'NO_SUCH_SECRET');
    expect(resolved).toBeNull();
  });

  it('answers null — never the value — for a name that exists only in another workspace', async () => {
    const workspaceAId = crypto.randomUUID();
    const workspaceBId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values([
      { id: workspaceAId, slug: `a-${workspaceAId}`, name: 'A' },
      { id: workspaceBId, slug: `b-${workspaceBId}`, name: 'B' },
    ]);
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const scopeA = await resolver.forWorkspaceId(workspaceAId);
    const scopeB = await resolver.forWorkspaceId(workspaceBId);
    if (scopeA === null || scopeB === null) throw new Error('fixture workspaces do not resolve');

    const envelope = sealSecret(masterKey, Buffer.from('workspace-a-only'));
    await createDatabaseSecretsRepositoryProvider(isolated.db)
      .forScope(scopeA)
      .create({ name: 'CROSS_TENANT_SECRET', envelope });

    const resolved = await resolveSecretByName(
      isolated.db,
      scopeB,
      masterKey,
      'CROSS_TENANT_SECRET',
    );
    expect(resolved).toBeNull();
  });

  it('refuses to resolve a value wrapped under a different master key', async () => {
    const workspaceId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: 'W' });
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace does not resolve');

    const otherMasterKey = loadMasterKey({
      [MASTER_KEY_ENV_VAR]: crypto.randomBytes(32).toString('hex'),
    });
    const envelope = sealSecret(otherMasterKey, Buffer.from('wrapped-under-a-different-key'));
    await createDatabaseSecretsRepositoryProvider(isolated.db)
      .forScope(scope)
      .create({ name: 'ROTATED_AWAY', envelope });

    await expect(
      resolveSecretByName(isolated.db, scope, masterKey, 'ROTATED_AWAY'),
    ).rejects.toThrow(/master key/);
  });
});

describe.skipIf(!hasDatabase)('resolveSecretById — PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const masterKey: MasterKey = loadMasterKey({
    [MASTER_KEY_ENV_VAR]: crypto.randomBytes(32).toString('hex'),
  });

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_rfc7_resolve_by_id');
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  async function workspaceScope(id: string) {
    await isolated.db.insert(workspaces).values({ id, slug: `ws-${id}`, name: 'W' });
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(id);
    if (scope === null) throw new Error('fixture workspace does not resolve');
    return scope;
  }

  async function createSecret(
    scope: Awaited<ReturnType<typeof workspaceScope>>,
    name: string,
    value: string,
    key: MasterKey = masterKey,
  ): Promise<string> {
    const outcome = await createDatabaseSecretsRepositoryProvider(isolated.db)
      .forScope(scope)
      .create({ name, envelope: sealSecret(key, Buffer.from(value)) });
    if (outcome.kind !== 'created') throw new Error(`expected created, got ${outcome.kind}`);
    return outcome.secret.id;
  }

  it('decrypts the plaintext of the secret with that id', async () => {
    const scope = await workspaceScope(crypto.randomUUID());
    await createSecret(scope, 'DECOY', 'decoy-value');
    const id = await createSecret(scope, 'BY_ID', 'value-by-id');

    const resolved = await resolveSecretById(isolated.db, scope, masterKey, id);
    expect(resolved?.value.toString('utf8')).toBe('value-by-id');
    expect(resolved?.name).toBe('BY_ID');
  });

  it('answers null — never the value — for an id that exists only in another workspace', async () => {
    const scopeA = await workspaceScope(crypto.randomUUID());
    const scopeB = await workspaceScope(crypto.randomUUID());
    const id = await createSecret(scopeA, 'CROSS_TENANT_BY_ID', 'workspace-a-only');

    await expect(resolveSecretById(isolated.db, scopeB, masterKey, id)).resolves.toBeNull();
  });

  it('answers null for an unknown id and for an id that is not a UUID, without a database error', async () => {
    const scope = await workspaceScope(crypto.randomUUID());

    await expect(
      resolveSecretById(isolated.db, scope, masterKey, crypto.randomUUID()),
    ).resolves.toBeNull();
    await expect(
      resolveSecretById(isolated.db, scope, masterKey, 'mem-secret-1'),
    ).resolves.toBeNull();
  });

  it('refuses to resolve a value wrapped under a different master key', async () => {
    const scope = await workspaceScope(crypto.randomUUID());
    const otherMasterKey = loadMasterKey({
      [MASTER_KEY_ENV_VAR]: crypto.randomBytes(32).toString('hex'),
    });
    const id = await createSecret(scope, 'ROTATED_AWAY_BY_ID', 'other-key', otherMasterKey);

    await expect(resolveSecretById(isolated.db, scope, masterKey, id)).rejects.toThrow(
      /master key/,
    );
  });
});
