/**
 * The secrets store conformance suite — **one suite, every implementation of the port**.
 *
 * Written against {@link SecretsStoreProvider} (the port the secrets routes hold), not against an
 * implementation, and exported as {@link describeSecretsStoreConformance}. It runs against:
 *
 *   1. `createInMemorySecretsStoreProvider()` — no database, always;
 *   2. `createRepositorySecretsStoreProvider()` over `createSecretsService` and a **real
 *      PostgreSQL**, whenever `TEST_DATABASE_URL` names one.
 *
 * `packages/core/src/secrets/repository.test.ts` holds the two *repositories* to one contract; this
 * suite holds the two things a route handler can actually be given to the same one, including the
 * in-memory store's stand-in for the reference check `delete` makes against `mcp_servers`.
 *
 * Secret values never reach test output: every "the value is not in this" check compares a boolean,
 * so a failure prints `true`/`false`, not the value.
 */
import crypto from 'node:crypto';

import {
  createDatabaseStorageConnectionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  mcpServers,
  memberships,
  storageConnections,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { UnknownWorkspaceError } from '@agent-workspace/core/db';
import { createSecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInMemorySecretsStoreProvider } from './memory-store';
import {
  createRepositorySecretsStoreProvider,
  type CreateSecretOutcome,
  type SecretRecord,
  type SecretReferrers,
  type SecretsStoreProvider,
} from './store';

/** A synthetic value. Never printed: see this file's header. */
const VALUE = 'conformance-value-7f3a';
const ABSENT = '55555555-5555-4555-8555-555555555555';

function value(text: string = VALUE): Buffer {
  return Buffer.from(text, 'utf8');
}

function leaks(subject: unknown, text: string = VALUE): boolean {
  return JSON.stringify(subject).includes(text);
}

function created(outcome: CreateSecretOutcome): SecretRecord {
  if (outcome.kind !== 'created') {
    throw new Error(`expected the secret to be created, but the store said "${outcome.kind}"`);
  }
  return outcome.secret;
}

/** One set-up for one test: a provider and two workspaces that really exist in it. */
export interface SecretsStoreFixture {
  readonly provider: SecretsStoreProvider;
  readonly workspaceA: string;
  readonly workspaceB: string;
  /** Make a connector in `workspaceId` authenticate with `secretId`; returns the connector id. */
  referenceFromConnector(workspaceId: string, secretId: string): Promise<string>;
}

export type MakeSecretsStoreFixture = () => Promise<SecretsStoreFixture>;

/** Run the conformance suite against a fixture factory, called once per test. */
export function describeSecretsStoreConformance(
  label: string,
  makeFixture: MakeSecretsStoreFixture,
): void {
  describe(label, () => {
    describe('create', () => {
      it('returns metadata only, stamped with the workspace, with equal timestamps', async () => {
        const fixture = await makeFixture();
        const store = fixture.provider.forWorkspace(fixture.workspaceA);
        const outcome = await store.create({ name: 'ANTHROPIC_API_KEY', value: value() });
        const secret = created(outcome);
        expect(Object.keys(secret).sort()).toEqual([
          'algorithm',
          'createdAt',
          'id',
          'masterKeyId',
          'name',
          'updatedAt',
          'workspaceId',
        ]);
        expect(secret.id).toMatch(/^[0-9a-f-]{36}$/u);
        expect(secret.workspaceId).toBe(fixture.workspaceA);
        expect(secret.name).toBe('ANTHROPIC_API_KEY');
        expect(secret.algorithm).toBe('aes-256-gcm');
        expect(secret.masterKeyId).not.toBe('');
        expect(secret.createdAt.getTime()).toBe(secret.updatedAt.getTime());
        expect(leaks(outcome)).toBe(false);
      });

      it('answers name-conflict for a duplicate name in the same workspace', async () => {
        const fixture = await makeFixture();
        const store = fixture.provider.forWorkspace(fixture.workspaceA);
        created(await store.create({ name: 'GITHUB_TOKEN', value: value() }));
        await expect(
          store.create({ name: 'GITHUB_TOKEN', value: value('other') }),
        ).resolves.toEqual({ kind: 'name-conflict', name: 'GITHUB_TOKEN' });
        expect((await store.list()).map((secret) => secret.name)).toEqual(['GITHUB_TOKEN']);
      });

      it('lets a second workspace reuse the name (uniqueness is per workspace)', async () => {
        const fixture = await makeFixture();
        const a = created(
          await fixture.provider.forWorkspace(fixture.workspaceA).create({
            name: 'SHARED',
            value: value(),
          }),
        );
        const b = created(
          await fixture.provider.forWorkspace(fixture.workspaceB).create({
            name: 'SHARED',
            value: value(),
          }),
        );
        expect(a.id).not.toBe(b.id);
      });

      // Regression: the in-memory store accepted any name, while PostgreSQL's `secrets_name_shape`
      // CHECK refuses one outside `^[A-Z][A-Z0-9_]{0,127}$`, so a fake-backed test could store a
      // secret production never could.
      it.each(['lower_case', '1LEADING_DIGIT', 'HAS-DASH', '', `A${'B'.repeat(128)}`])(
        'refuses a name outside the secrets_name_shape (%j) and stores nothing',
        async (name) => {
          const fixture = await makeFixture();
          const store = fixture.provider.forWorkspace(fixture.workspaceA);
          await expect(store.create({ name, value: value() })).rejects.toThrow();
          expect(await store.list()).toEqual([]);
        },
      );
    });

    describe('list', () => {
      it("lists only the workspace's own secrets, oldest first", async () => {
        const fixture = await makeFixture();
        const a = fixture.provider.forWorkspace(fixture.workspaceA);
        const b = fixture.provider.forWorkspace(fixture.workspaceB);
        created(await a.create({ name: 'FIRST', value: value() }));
        created(await b.create({ name: 'OTHER', value: value() }));
        created(await a.create({ name: 'SECOND', value: value() }));
        const listed = await a.list();
        expect(listed.map((secret) => secret.name)).toEqual(['FIRST', 'SECOND']);
        expect(listed.every((secret) => secret.workspaceId === fixture.workspaceA)).toBe(true);
        expect((await b.list()).map((secret) => secret.name)).toEqual(['OTHER']);
        expect(leaks(listed)).toBe(false);
      });
    });

    describe('replace', () => {
      it('rotates the value by id, keeping id, name and createdAt', async () => {
        const fixture = await makeFixture();
        const store = fixture.provider.forWorkspace(fixture.workspaceA);
        const before = created(await store.create({ name: 'ROTATE_ME', value: value() }));
        const outcome = await store.replace(before.id, value('rotated-value-91c2'));
        expect(outcome.kind).toBe('replaced');
        if (outcome.kind !== 'replaced') return;
        expect(outcome.secret.id).toBe(before.id);
        expect(outcome.secret.name).toBe('ROTATE_ME');
        expect(outcome.secret.workspaceId).toBe(fixture.workspaceA);
        expect(outcome.secret.createdAt.getTime()).toBe(before.createdAt.getTime());
        expect(outcome.secret.updatedAt.getTime()).toBeGreaterThanOrEqual(
          before.updatedAt.getTime(),
        );
        expect(leaks(outcome, 'rotated-value-91c2')).toBe(false);
        expect((await store.list()).map((secret) => secret.id)).toEqual([before.id]);
      });

      it('answers not-found for an id that names nothing', async () => {
        const fixture = await makeFixture();
        const store = fixture.provider.forWorkspace(fixture.workspaceA);
        await expect(store.replace(ABSENT, value())).resolves.toEqual({ kind: 'not-found' });
      });
    });

    describe('remove', () => {
      it('deletes an unreferenced secret once, then answers not-found', async () => {
        const fixture = await makeFixture();
        const store = fixture.provider.forWorkspace(fixture.workspaceA);
        const secret = created(await store.create({ name: 'DELETE_ME', value: value() }));
        const outcome = await store.remove(secret.id);
        expect(outcome).toEqual({ kind: 'deleted', secret });
        expect(leaks(outcome)).toBe(false);
        expect(await store.list()).toEqual([]);
        await expect(store.remove(secret.id)).resolves.toEqual({ kind: 'not-found' });
        await expect(store.remove(ABSENT)).resolves.toEqual({ kind: 'not-found' });
      });

      it('refuses a secret a connector authenticates with, naming the connector', async () => {
        const fixture = await makeFixture();
        const store = fixture.provider.forWorkspace(fixture.workspaceA);
        const secret = created(await store.create({ name: 'CONNECTOR_TOKEN', value: value() }));
        const connectorId = await fixture.referenceFromConnector(fixture.workspaceA, secret.id);
        await expect(store.remove(secret.id)).resolves.toEqual({
          kind: 'in-use',
          referrers: {
            connectorIds: [connectorId],
            modelConnectionIds: [],
            storageConnectionIds: [],
          },
        });
        expect((await store.list()).map((row) => row.id)).toEqual([secret.id]);
      });
    });

    describe('cross-workspace isolation (spec §25)', () => {
      it("cannot replace another workspace's secret, and leaves it unchanged", async () => {
        const fixture = await makeFixture();
        const a = fixture.provider.forWorkspace(fixture.workspaceA);
        const secret = created(await a.create({ name: 'ONLY_A', value: value() }));
        await expect(
          fixture.provider.forWorkspace(fixture.workspaceB).replace(secret.id, value('hijack')),
        ).resolves.toEqual({ kind: 'not-found' });
        expect(await a.list()).toEqual([secret]);
      });

      it("cannot delete another workspace's secret, referenced or not, nor learn its referrers", async () => {
        const fixture = await makeFixture();
        const a = fixture.provider.forWorkspace(fixture.workspaceA);
        const b = fixture.provider.forWorkspace(fixture.workspaceB);
        const plain = created(await a.create({ name: 'PLAIN', value: value() }));
        const used = created(await a.create({ name: 'USED', value: value() }));
        await fixture.referenceFromConnector(fixture.workspaceA, used.id);
        await expect(b.remove(plain.id)).resolves.toEqual({ kind: 'not-found' });
        await expect(b.remove(used.id)).resolves.toEqual({ kind: 'not-found' });
        expect((await a.list()).map((secret) => secret.id)).toEqual([plain.id, used.id]);
      });
    });
  });
}

// ── Implementation 1: in memory ─────────────────────────────────────────────────────────────

describeSecretsStoreConformance('the in-memory secrets store', () => {
  const references = new Map<string, string[]>();
  const key = (workspaceId: string, secretId: string): string => `${workspaceId}/${secretId}`;
  const provider = createInMemorySecretsStoreProvider(
    (workspaceId, secretId): SecretReferrers | null => {
      const connectorIds = references.get(key(workspaceId, secretId));
      return connectorIds === undefined
        ? null
        : { connectorIds, modelConnectionIds: [], storageConnectionIds: [] };
    },
  );
  return Promise.resolve({
    provider,
    workspaceA: crypto.randomUUID(),
    workspaceB: crypto.randomUUID(),
    referenceFromConnector(workspaceId: string, secretId: string): Promise<string> {
      const connectorId = crypto.randomUUID();
      references.set(key(workspaceId, secretId), [connectorId]);
      return Promise.resolve(connectorId);
    },
  });
});

// ── Implementation 2: PostgreSQL ────────────────────────────────────────────────────────────

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[secrets/store.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half of ' +
      'this conformance suite did NOT run. A green result without it says nothing about whether ' +
      'the database-backed secrets store satisfies the same contract as the in-memory one.',
  );
}

describe.skipIf(!hasDatabase)('the PostgreSQL secrets store', () => {
  let isolated: IsolatedTestDatabase;
  let service: SecretsService;
  let provider: SecretsStoreProvider;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w34_secrets_store');
    service = await createSecretsService({
      DATABASE_URL: isolated.url,
      MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    });
    provider = createRepositorySecretsStoreProvider({
      service,
      scopes: createDatabaseWorkspaceScopeResolver(isolated.db),
      storageConnections: createDatabaseStorageConnectionRepositoryProvider(isolated.db),
    });
  }, 180_000);

  afterAll(async () => {
    await service.close();
    await isolated.close();
  });

  /** A connector needs a member principal to own it; made only when a test asks for one. */
  async function referenceFromConnector(workspaceId: string, secretId: string): Promise<string> {
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const connectorId = crypto.randomUUID();
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    await isolated.db.insert(mcpServers).values({
      id: connectorId,
      workspaceId,
      name: `connector-${connectorId}`,
      transport: 'http',
      url: 'https://connector.example.test/mcp',
      authType: 'bearer',
      credentialSecretId: secretId,
      createdBy: userId,
      ownerPrincipalId: principalId,
    });
    return connectorId;
  }

  describeSecretsStoreConformance('over a real PostgreSQL, against the same suite', async () => {
    const workspaceA = crypto.randomUUID();
    const workspaceB = crypto.randomUUID();
    await isolated.db.insert(workspaces).values([
      { id: workspaceA, slug: workspaceA, name: 'Workspace A' },
      { id: workspaceB, slug: workspaceB, name: 'Workspace B' },
    ]);
    return { provider, workspaceA, workspaceB, referenceFromConnector };
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] refuses to replace the credential of a connection that exists, not of an orphan', async () => {
    const workspaceId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Storage credential' });
    const store = provider.forWorkspace(workspaceId);
    const connectionId = crypto.randomUUID();
    const orphanId = crypto.randomUUID();
    const named = (id: string): string =>
      `STORAGE_CONNECTION_${id.replace(/-/g, '').toUpperCase()}`;
    const credential = created(await store.create({ name: named(connectionId), value: value() }));
    const orphan = created(await store.create({ name: named(orphanId), value: value() }));
    await isolated.db.insert(storageConnections).values({
      id: connectionId,
      workspaceId,
      name: 'Storage connection',
      provider: 's3',
      url: 's3://bucket/exports',
      allowedPrefixes: [],
    });

    await expect(store.replace(credential.id, value())).resolves.toEqual({
      kind: 'in-use',
      referrers: { connectorIds: [], modelConnectionIds: [], storageConnectionIds: [connectionId] },
    });
    await expect(store.replace(orphan.id, value())).resolves.toMatchObject({ kind: 'replaced' });
  });

  it('refuses by name when the workspace it was scoped to does not exist', async () => {
    // Not an empty list: "no secrets" and "no such workspace" are different facts (ADR-0015).
    await expect(provider.forWorkspace(ABSENT).list()).rejects.toThrow(UnknownWorkspaceError);
  });
});
