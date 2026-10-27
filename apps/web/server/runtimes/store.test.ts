/**
 * The runtime-profile store conformance suite — **one suite, every implementation of the port**.
 *
 * Written against {@link RuntimeProfileStoreProvider}, exported as
 * {@link describeRuntimeProfileStoreConformance}, and run against the in-memory provider (always)
 * and the repository-backed one over a real PostgreSQL (when `TEST_DATABASE_URL` names one).
 *
 * Not covered here: a runtime connection that exists but belongs to another workspace. PostgreSQL
 * refuses it (tenant-paired foreign key); the in-memory store has no connection registry to know
 * that, so it is held only by `packages/core/.../runtime-profiles.test.ts`.
 */
import crypto from 'node:crypto';

import {
  createDatabaseRuntimeProfileRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  secrets,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { UnknownWorkspaceError } from '@agent-workspace/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInMemoryRuntimeProfileStoreProvider } from './memory-store';
import {
  createRepositoryRuntimeProfileStoreProvider,
  type CreateRuntimeProfileInput,
  type RuntimeProfileRecord,
  type RuntimeProfileStoreProvider,
  type WorkspaceRuntimeProfileStore,
} from './store';

const ABSENT = '55555555-5555-4555-8555-555555555555';

const BASE: CreateRuntimeProfileInput = {
  name: 'Standard',
  driver: 'docker',
  runtimeConnectionId: null,
  cpu: 1,
  memoryMb: 1024,
  diskMb: 5120,
  networkPolicy: 'restricted',
  allowedDomains: ['api.anthropic.com'],
  filesystem: 'read-write',
  persistPaths: ['/workspace/output'],
  timeoutSeconds: 3600,
  idleTimeoutSeconds: 600,
  driverConfig: { note: 'default' },
};

/** One set-up for one test: a provider and two workspaces that really exist in it. */
export interface RuntimeProfileStoreFixture {
  readonly provider: RuntimeProfileStoreProvider;
  readonly workspaceA: string;
  readonly workspaceB: string;
  /** A runtime connection id no workspace has. */
  readonly unknownConnectionId: string;
  /** A runtime connection that exists in `workspaceId`. */
  readonly connectionIn: (workspaceId: string) => Promise<string>;
}

export type MakeRuntimeProfileStoreFixture = () => Promise<RuntimeProfileStoreFixture>;

async function made(
  store: WorkspaceRuntimeProfileStore,
  overrides: Partial<CreateRuntimeProfileInput> = {},
): Promise<RuntimeProfileRecord> {
  const outcome = await store.create({ ...BASE, ...overrides });
  if (outcome.kind !== 'created') {
    throw new Error(`expected the profile to be created, but the store said "${outcome.kind}"`);
  }
  return outcome.profile;
}

export function describeRuntimeProfileStoreConformance(
  label: string,
  makeFixture: MakeRuntimeProfileStoreFixture,
): void {
  describe(label, () => {
    it('creates a profile, stamped with the workspace, and reads every field back', async () => {
      const { provider, workspaceA } = await makeFixture();
      const store = provider.forWorkspace(workspaceA);
      const profile = await made(store);
      expect(profile).toMatchObject({ ...BASE, workspaceId: workspaceA });
      expect(await store.get(profile.id)).toMatchObject({ ...BASE, workspaceId: workspaceA });
    });

    it('refuses a duplicate name in a workspace but allows it in another', async () => {
      const { provider, workspaceA, workspaceB } = await makeFixture();
      const a = provider.forWorkspace(workspaceA);
      await made(a);
      expect(await a.create(BASE)).toEqual({ kind: 'name-conflict', name: BASE.name });
      expect((await provider.forWorkspace(workspaceB).create(BASE)).kind).toBe('created');
    });

    it('refuses an unknown runtime connection on create and on update', async () => {
      const { provider, workspaceA, unknownConnectionId } = await makeFixture();
      const store = provider.forWorkspace(workspaceA);
      expect(await store.create({ ...BASE, runtimeConnectionId: unknownConnectionId })).toEqual({
        kind: 'unknown-runtime-connection',
        runtimeConnectionId: unknownConnectionId,
      });
      const profile = await made(store);
      expect(await store.update(profile.id, { runtimeConnectionId: unknownConnectionId })).toEqual({
        kind: 'unknown-runtime-connection',
        runtimeConnectionId: unknownConnectionId,
      });
      expect((await store.get(profile.id))?.runtimeConnectionId).toBeNull();
    });

    it('accepts a runtime connection that exists in the workspace', async () => {
      const { provider, workspaceA, connectionIn } = await makeFixture();
      const connectionId = await connectionIn(workspaceA);
      const profile = await made(provider.forWorkspace(workspaceA), {
        runtimeConnectionId: connectionId,
      });
      expect(profile.runtimeConnectionId).toBe(connectionId);
    });

    it('updates only the given fields', async () => {
      const { provider, workspaceA } = await makeFixture();
      const store = provider.forWorkspace(workspaceA);
      const profile = await made(store);
      const outcome = await store.update(profile.id, { cpu: 2, allowedDomains: null });
      expect(outcome.kind).toBe('updated');
      if (outcome.kind !== 'updated') return;
      expect(outcome.profile).toMatchObject({ ...BASE, cpu: 2, allowedDomains: null });
      expect(await store.get(profile.id)).toEqual(outcome.profile);
    });

    it('refuses to rename onto a name another profile holds, but not onto its own', async () => {
      const { provider, workspaceA } = await makeFixture();
      const store = provider.forWorkspace(workspaceA);
      await made(store, { name: 'One' });
      const two = await made(store, { name: 'Two' });
      expect(await store.update(two.id, { name: 'One' })).toEqual({
        kind: 'name-conflict',
        name: 'One',
      });
      expect((await store.update(two.id, { name: 'Two' })).kind).toBe('updated');
    });

    it('lists only its own workspace, oldest first', async () => {
      const { provider, workspaceA, workspaceB } = await makeFixture();
      const a = provider.forWorkspace(workspaceA);
      const first = await made(a, { name: 'First' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await made(a, { name: 'Second' });
      await made(provider.forWorkspace(workspaceB), { name: 'Other' });
      expect((await a.list()).map((p) => p.id)).toEqual([first.id, second.id]);
    });

    it('deletes once, then reports not-found', async () => {
      const { provider, workspaceA } = await makeFixture();
      const store = provider.forWorkspace(workspaceA);
      const profile = await made(store);
      expect(await store.delete(profile.id)).toEqual({ kind: 'deleted' });
      expect(await store.delete(profile.id)).toEqual({ kind: 'not-found' });
      expect(await store.get(profile.id)).toBeNull();
    });

    it('reports an absent id as absent on get, update and delete', async () => {
      const { provider, workspaceA } = await makeFixture();
      const store = provider.forWorkspace(workspaceA);
      expect(await store.get(ABSENT)).toBeNull();
      expect(await store.update(ABSENT, { cpu: 9 })).toEqual({ kind: 'not-found' });
      expect(await store.delete(ABSENT)).toEqual({ kind: 'not-found' });
    });

    it("never lets one workspace see, change or delete another's profile", async () => {
      const { provider, workspaceA, workspaceB } = await makeFixture();
      const profile = await made(provider.forWorkspace(workspaceA));
      const b = provider.forWorkspace(workspaceB);
      expect(await b.get(profile.id)).toBeNull();
      expect(await b.update(profile.id, { cpu: 9 })).toEqual({ kind: 'not-found' });
      expect(await b.delete(profile.id)).toEqual({ kind: 'not-found' });
      expect((await provider.forWorkspace(workspaceA).get(profile.id))?.cpu).toBe(BASE.cpu);
    });
  });
}

// ── Implementation 1: in memory ─────────────────────────────────────────────────────────────

describeRuntimeProfileStoreConformance('the in-memory runtime-profile store', () =>
  Promise.resolve({
    provider: createInMemoryRuntimeProfileStoreProvider(),
    workspaceA: crypto.randomUUID(),
    workspaceB: crypto.randomUUID(),
    // The in-memory store stands in for the connection check by this prefix.
    unknownConnectionId: 'unknown-connection',
    connectionIn: () => Promise.resolve(crypto.randomUUID()),
  }),
);

// ── Implementation 2: PostgreSQL ────────────────────────────────────────────────────────────

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[runtimes/store.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half of ' +
      'this conformance suite did NOT run. A green result without it says nothing about whether ' +
      'the database-backed runtime-profile store satisfies the same contract as the in-memory one.',
  );
}

describe.skipIf(!hasDatabase)('the PostgreSQL runtime-profile store', () => {
  let isolated: IsolatedTestDatabase;
  let provider: RuntimeProfileStoreProvider;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w34_runtime_profile_store');
    provider = createRepositoryRuntimeProfileStoreProvider({
      repositories: createDatabaseRuntimeProfileRepositoryProvider(isolated.db),
      scopes: createDatabaseWorkspaceScopeResolver(isolated.db),
    });
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  /** A runtime connection is a secret; fixed-size dummy envelope bytes satisfy its CHECKs. */
  async function connectionIn(workspaceId: string): Promise<string> {
    const bytes = (length: number): Buffer => Buffer.alloc(length, 1);
    const rows = await isolated.db
      .insert(secrets)
      .values({
        workspaceId,
        name: `RUNTIME_${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
        algorithm: 'aes-256-gcm',
        masterKeyId: 'test',
        wrappedDataKey: bytes(32),
        wrappedDataKeyNonce: bytes(12),
        wrappedDataKeyTag: bytes(16),
        ciphertext: bytes(8),
        ciphertextNonce: bytes(12),
        ciphertextTag: bytes(16),
      })
      .returning({ id: secrets.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('the secret insert returned no row');
    return id;
  }

  describeRuntimeProfileStoreConformance(
    'over a real PostgreSQL, against the same suite',
    async () => {
      const workspaceA = crypto.randomUUID();
      const workspaceB = crypto.randomUUID();
      await isolated.db.insert(workspaces).values([
        { id: workspaceA, slug: workspaceA, name: 'Workspace A' },
        { id: workspaceB, slug: workspaceB, name: 'Workspace B' },
      ]);
      return {
        provider,
        workspaceA,
        workspaceB,
        unknownConnectionId: crypto.randomUUID(),
        connectionIn,
      };
    },
  );

  it('refuses by name when the workspace it was scoped to does not exist', async () => {
    await expect(provider.forWorkspace(ABSENT).list()).rejects.toThrow(UnknownWorkspaceError);
  });
});
