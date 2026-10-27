/**
 * The model-connection store conformance suite — **one suite, every implementation of the port**.
 *
 * Written against {@link ModelsStoreProvider}, exported as {@link describeModelsStoreConformance},
 * and run against the in-memory provider (always) and the repository-backed one over a real
 * PostgreSQL and a real database-backed secrets service (when `TEST_DATABASE_URL` names one).
 *
 * Not covered here: the agents that reference a connection on delete. The in-memory store has no
 * `agents` table to know them, so that is held only by `repositories/model-connections.test.ts`.
 */
import crypto from 'node:crypto';

import {
  createDatabaseModelConnectionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createSecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CreateModelConnectionInput } from './contract';
import { createInMemoryModelsStoreProvider } from './memory-store';
import {
  createRepositoryModelsStoreProvider,
  type ModelsStoreProvider,
  type WorkspaceModelsStore,
} from './store';

const ABSENT = '55555555-5555-4555-8555-555555555555';
const API_KEY = 'sk-conformance-plaintext-key-1';
const OTHER_KEY = 'sk-conformance-plaintext-key-2';

const BASE: CreateModelConnectionInput = {
  name: 'Primary',
  provider: 'anthropic-compatible',
  apiKey: API_KEY,
  config: { baseUrl: 'https://llm.example.test' },
};

/** One set-up for one test: a provider and two workspaces that really exist in it. */
export interface ModelsStoreFixture {
  readonly provider: ModelsStoreProvider;
  readonly workspaceA: string;
  readonly workspaceB: string;
}

export type MakeModelsStoreFixture = () => Promise<ModelsStoreFixture>;

async function made(
  store: WorkspaceModelsStore,
  overrides: Partial<CreateModelConnectionInput> = {},
): Promise<string> {
  const outcome = await store.create({ ...BASE, ...overrides });
  if (outcome.kind !== 'created') {
    throw new Error(`expected the connection to be created, but the store said "${outcome.kind}"`);
  }
  return outcome.connection.id;
}

export function describeModelsStoreConformance(
  label: string,
  makeFixture: MakeModelsStoreFixture,
): void {
  describe(label, () => {
    it('creates a connection and reads it back with a credential and no key', async () => {
      const { provider, workspaceA } = await makeFixture();
      const store = provider.forWorkspace(workspaceA);
      const id = await made(store);
      expect(await store.get(id)).toMatchObject({
        id,
        name: BASE.name,
        provider: BASE.provider,
        config: BASE.config,
        hasCredential: true,
        ready: true,
      });
      expect((await store.list()).map((row) => row.id)).toEqual([id]);
    });

    it('never returns the plaintext key from create, get, list, update or delete', async () => {
      const { provider, workspaceA } = await makeFixture();
      const store = provider.forWorkspace(workspaceA);
      const created = await store.create(BASE);
      if (created.kind !== 'created') throw new Error('expected created');
      const id = created.connection.id;
      const seen = [
        created,
        await store.get(id),
        await store.list(),
        await store.update(id, { name: 'Renamed' }),
        await store.reconcileOrphanedCredentials(),
        await store.delete(id),
      ];
      expect(JSON.stringify(seen)).not.toContain(API_KEY);
    });

    it('hands the key out only through resolve, and rotates it with replaceCredential', async () => {
      const { provider, workspaceA } = await makeFixture();
      const store = provider.forWorkspace(workspaceA);
      const id = await made(store);
      expect((await store.resolve(id))?.credential).toBe(API_KEY);
      expect(await store.replaceCredential(id, OTHER_KEY)).toBe(true);
      expect((await store.resolve(id))?.credential).toBe(OTHER_KEY);
      expect(await store.list()).toHaveLength(1);
    });

    it('refuses a duplicate name, leaves no orphan secret, and allows the name elsewhere', async () => {
      const { provider, workspaceA, workspaceB } = await makeFixture();
      const a = provider.forWorkspace(workspaceA);
      await made(a);
      expect(await a.create(BASE)).toEqual({ kind: 'name-conflict', name: BASE.name });
      expect(await a.reconcileOrphanedCredentials()).toEqual({ orphanedSecretNames: [] });
      expect((await provider.forWorkspace(workspaceB).create(BASE)).kind).toBe('created');
    });

    it('updates the name and config, and refuses a name another connection holds', async () => {
      const { provider, workspaceA } = await makeFixture();
      const store = provider.forWorkspace(workspaceA);
      const id = await made(store);
      await made(store, { name: 'Second' });
      expect(await store.update(id, { name: 'Second' })).toEqual({
        kind: 'name-conflict',
        name: 'Second',
      });
      const updated = await store.update(id, {
        name: 'Renamed',
        config: { baseUrl: 'https://other.example.test' },
      });
      expect(updated.kind).toBe('updated');
      expect(await store.get(id)).toMatchObject({
        name: 'Renamed',
        config: { baseUrl: 'https://other.example.test' },
        hasCredential: true,
      });
    });

    it('reports not-found for an unknown id on every operation', async () => {
      const { provider, workspaceA } = await makeFixture();
      const store = provider.forWorkspace(workspaceA);
      expect(await store.get(ABSENT)).toBeNull();
      expect(await store.update(ABSENT, { name: 'x' })).toEqual({ kind: 'not-found' });
      expect(await store.delete(ABSENT)).toEqual({ kind: 'not-found' });
      expect(await store.resolve(ABSENT)).toBeNull();
      expect(await store.replaceCredential(ABSENT, OTHER_KEY)).toBe(false);
      expect(await store.writeCredential(ABSENT, OTHER_KEY)).toBe(false);
    });

    it('refuses a workspace that does not exist', async () => {
      const { provider } = await makeFixture();
      await expect(provider.forWorkspace(ABSENT).list()).rejects.toThrow(
        `unknown workspace ${ABSENT}`,
      );
    });

    it('deletes the connection together with its secret', async () => {
      const { provider, workspaceA } = await makeFixture();
      const store = provider.forWorkspace(workspaceA);
      const id = await made(store);
      expect(await store.delete(id)).toEqual({ kind: 'deleted', referencedBy: [] });
      expect(await store.get(id)).toBeNull();
      expect(await store.resolve(id)).toBeNull();
      expect(await store.list()).toEqual([]);
      expect(await store.reconcileOrphanedCredentials()).toEqual({ orphanedSecretNames: [] });
      expect(await store.delete(id)).toEqual({ kind: 'not-found' });
    });

    it("keeps one workspace's connections, keys and names invisible to another", async () => {
      const { provider, workspaceA, workspaceB } = await makeFixture();
      const a = provider.forWorkspace(workspaceA);
      const b = provider.forWorkspace(workspaceB);
      const id = await made(a);
      expect(await b.list()).toEqual([]);
      expect(await b.get(id)).toBeNull();
      expect(await b.resolve(id)).toBeNull();
      expect(await b.update(id, { name: 'Hijacked' })).toEqual({ kind: 'not-found' });
      expect(await b.delete(id)).toEqual({ kind: 'not-found' });
      expect(await b.replaceCredential(id, OTHER_KEY)).toBe(false);
      expect(await b.writeCredential(id, OTHER_KEY)).toBe(false);
      expect(await b.reconcileOrphanedCredentials()).toEqual({ orphanedSecretNames: [] });
      expect(await a.get(id)).toMatchObject({ name: BASE.name });
      expect((await a.resolve(id))?.credential).toBe(API_KEY);
    });
  });
}

// ── Implementation 1: in memory ─────────────────────────────────────────────────────────────

describeModelsStoreConformance('the in-memory models store', () => {
  const workspaceA = crypto.randomUUID();
  const workspaceB = crypto.randomUUID();
  return Promise.resolve({
    provider: createInMemoryModelsStoreProvider([workspaceA, workspaceB]),
    workspaceA,
    workspaceB,
  });
});

// ── Implementation 2: PostgreSQL ────────────────────────────────────────────────────────────

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[models/conformance.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half ' +
      'of this conformance suite did NOT run. A green result without it says nothing about whether ' +
      'the database-backed models store satisfies the same contract as the in-memory one.',
  );
}

describe.skipIf(!hasDatabase)('the PostgreSQL models store', () => {
  let isolated: IsolatedTestDatabase;
  let secrets: SecretsService;
  let provider: ModelsStoreProvider;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w34_models_store');
    secrets = await createSecretsService({
      MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      DATABASE_URL: isolated.url,
    });
    provider = createRepositoryModelsStoreProvider({
      repositories: createDatabaseModelConnectionRepositoryProvider(isolated.db),
      scopes: createDatabaseWorkspaceScopeResolver(isolated.db),
      secrets,
    });
  }, 180_000);

  afterAll(async () => {
    await secrets.close();
    await isolated.close();
  });

  describeModelsStoreConformance('over a real PostgreSQL, against the same suite', async () => {
    const workspaceA = crypto.randomUUID();
    const workspaceB = crypto.randomUUID();
    await isolated.db.insert(workspaces).values([
      { id: workspaceA, slug: workspaceA, name: 'Workspace A' },
      { id: workspaceB, slug: workspaceB, name: 'Workspace B' },
    ]);
    return { provider, workspaceA, workspaceB };
  });
});
