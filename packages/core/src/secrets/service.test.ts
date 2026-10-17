/**
 * `createSecretsService` — the ordering guarantee (master key before database) needs no database
 * at all to prove, so it is asserted unconditionally, first. The full round trip against a real
 * PostgreSQL follows, gated on `TEST_DATABASE_URL` like every other database suite here.
 *
 * Reaches `db/**` by relative path throughout — see `repository.test.ts`'s header for why mixing
 * that with the `@agent-workspace/core/db/unscoped` subpath mints two distinct `WorkspaceScope`
 * classes and makes every scope look forged to the other.
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { workspaces } from '../db/schema/workspaces.js';
import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '../db/repositories/testing.js';
import { MASTER_KEY_ENV_VAR } from './master-key.js';
import {
  createInMemorySecretsService,
  createSecretsService,
  type SecretsService,
} from './service.js';
import {
  createDatabaseWorkspaceScopeResolver,
  createInMemoryWorkspaceScopeResolver,
} from '../db/repositories/scope.js';

describe('createSecretsService — the master key is checked before anything else', () => {
  it('throws on a missing master key without ever attempting to reach the database', async () => {
    // A DATABASE_URL that cannot possibly be reached — a reserved-for-documentation TLD on a port
    // nothing listens on. If this test ever failed with a connection error instead of the master
    // key's own message, that would mean the ordering regressed: the database was tried first.
    await expect(
      createSecretsService({
        DATABASE_URL: 'postgres://user:pass@example.invalid:1/db',
      }),
    ).rejects.toThrow(new RegExp(MASTER_KEY_ENV_VAR));
  });

  it('throws on a malformed master key the same way, before touching the database', async () => {
    await expect(
      createSecretsService({
        [MASTER_KEY_ENV_VAR]: 'not-hex',
        DATABASE_URL: 'postgres://user:pass@example.invalid:1/db',
      }),
    ).rejects.toThrow();
  });

  it('does not let a database and local key substitute for the selected GCP provider', async () => {
    await expect(
      createSecretsService({
        MASTER_KEY_PROVIDER: 'secret-manager',
        [MASTER_KEY_ENV_VAR]: 'ab'.repeat(32),
        DATABASE_URL: 'postgres://user:pass@example.invalid:1/db',
      }),
    ).rejects.toThrow(/GCP_MASTER_KEY_SECRET/u);
  });
});

describe('createInMemorySecretsService — no database, no configured master key', () => {
  it('creates, lists, replaces and resolves, with real AES-256-GCM underneath', async () => {
    const service = createInMemorySecretsService();
    const resolver = createInMemoryWorkspaceScopeResolver([{ id: 'ws-1', slug: 'ws-1' }]);
    const scope = await resolver.forWorkspaceId('ws-1');
    if (scope === null) throw new Error('fixture workspace does not resolve');

    const created = await service.create(scope, {
      name: 'IN_MEMORY_SECRET',
      value: Buffer.from('plaintext-value', 'utf8'),
    });
    if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);

    const listed = await service.list(scope);
    expect(listed.map((s) => s.name)).toEqual(['IN_MEMORY_SECRET']);

    const resolved = await service.resolveByName(scope, 'IN_MEMORY_SECRET');
    expect(resolved?.value.toString('utf8')).toBe('plaintext-value');

    await service.replace(scope, created.secret.id, Buffer.from('rotated', 'utf8'));
    const afterReplace = await service.resolveByName(scope, 'IN_MEMORY_SECRET');
    expect(afterReplace?.value.toString('utf8')).toBe('rotated');

    await expect(service.delete(scope, created.secret.id)).resolves.toMatchObject({
      kind: 'deleted',
    });
    await expect(service.resolveByName(scope, 'IN_MEMORY_SECRET')).resolves.toBeNull();

    await service.close();
  });

  it('never leaks the plaintext into the metadata JSON.stringify produces', async () => {
    const service = createInMemorySecretsService();
    const resolver = createInMemoryWorkspaceScopeResolver([{ id: 'ws-2', slug: 'ws-2' }]);
    const scope = await resolver.forWorkspaceId('ws-2');
    if (scope === null) throw new Error('fixture workspace does not resolve');

    await service.create(scope, {
      name: 'SENSITIVE',
      value: Buffer.from('do-not-leak-me', 'utf8'),
    });
    const listed = await service.list(scope);
    expect(JSON.stringify(listed)).not.toContain('do-not-leak-me');
  });
});

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[secrets/service.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the secrets service was ' +
      'NOT exercised end to end against a real PostgreSQL.',
  );
}

describe.skipIf(!hasDatabase)('createSecretsService — end to end against PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let service: SecretsService;
  let workspaceId: string;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w2cp02_service');
    workspaceId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: 'W' });
    service = await createSecretsService({
      [MASTER_KEY_ENV_VAR]: crypto.randomBytes(32).toString('hex'),
      DATABASE_URL: isolated.url,
    });
  }, 180_000);

  afterAll(async () => {
    await service.close();
    await isolated.close();
  });

  it('creates, lists (metadata only), replaces, and resolves the current value', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace does not resolve');

    const createOutcome = await service.create(scope, {
      name: 'GITHUB_TOKEN',
      value: Buffer.from('ghp_original_value', 'utf8'),
    });
    if (createOutcome.kind !== 'created')
      throw new Error(`expected created, got ${createOutcome.kind}`);

    const listed = await service.list(scope);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('GITHUB_TOKEN');
    // Metadata carries none of JSON.stringify's usual suspects for a leaked value.
    expect(JSON.stringify(listed)).not.toContain('ghp_original_value');

    const firstResolve = await service.resolveByName(scope, 'GITHUB_TOKEN');
    expect(firstResolve?.value.toString('utf8')).toBe('ghp_original_value');

    const replaceOutcome = await service.replace(
      scope,
      createOutcome.secret.id,
      Buffer.from('ghp_rotated_value', 'utf8'),
    );
    expect(replaceOutcome.kind).toBe('replaced');

    const secondResolve = await service.resolveByName(scope, 'GITHUB_TOKEN');
    expect(secondResolve?.value.toString('utf8')).toBe('ghp_rotated_value');
  });

  it('reports a name conflict without leaking which workspace already has the name', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace does not resolve');

    await service.create(scope, { name: 'DUPLICATE_NAME', value: Buffer.from('one') });
    const outcome = await service.create(scope, {
      name: 'DUPLICATE_NAME',
      value: Buffer.from('two'),
    });
    expect(outcome).toEqual({ kind: 'name-conflict', name: 'DUPLICATE_NAME' });
  });
});
