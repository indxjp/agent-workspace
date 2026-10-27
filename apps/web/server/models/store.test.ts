import type {
  CreateModelConnectionInput as CoreCreateInput,
  CreateModelConnectionOutcome,
  DeleteModelConnectionOutcome,
  ModelConnectionRecord,
  ModelConnectionRepository,
  ModelConnectionRepositoryProvider,
  UpdateModelConnectionOutcome,
  UpdateModelConnectionPatch,
  WorkspaceScope,
} from '@agent-workspace/core/db';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createInMemorySecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import { describe, expect, it } from 'vitest';

import { createRepositoryModelsStoreProvider, modelConnectionSecretName } from './store';

const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';

type DeletedOutcome = Extract<DeleteModelConnectionOutcome, { kind: 'deleted' }>;

/**
 * A `ModelConnectionRepository` double whose `create` can be told to fail — either by throwing (an
 * unexpected database error) or by resolving `name-conflict` (an ordinary, non-throwing refusal) —
 * *after* the caller has already written the secret. This is what issue #126's verifier attack #2
 * injects, and what `store.ts`'s compensating delete exists to answer.
 */
function fakeRepositoryProvider(
  options: {
    failCreate?: 'throw' | 'name-conflict';
    referencedByOnDelete?: DeletedOutcome['referencedBy'];
  } = {},
): ModelConnectionRepositoryProvider {
  const byWorkspace = new Map<string, Map<string, ModelConnectionRecord>>();
  return {
    forScope(scope: WorkspaceScope): ModelConnectionRepository {
      let rows = byWorkspace.get(scope.workspaceId);
      if (rows === undefined) {
        rows = new Map();
        byWorkspace.set(scope.workspaceId, rows);
      }
      const current = rows;
      return {
        list: () => Promise.resolve([...current.values()]),
        get: (id) => Promise.resolve(current.get(id) ?? null),
        create(input: CoreCreateInput): Promise<CreateModelConnectionOutcome> {
          if (options.failCreate === 'throw') {
            return Promise.reject(new Error('simulated connection-insert failure'));
          }
          if (options.failCreate === 'name-conflict') {
            return Promise.resolve({ kind: 'name-conflict', name: input.name });
          }
          const now = new Date();
          const connection: ModelConnectionRecord = {
            ...input,
            workspaceId: scope.workspaceId,
            createdAt: now,
            updatedAt: now,
          };
          current.set(connection.id, connection);
          return Promise.resolve({ kind: 'created', connection });
        },
        update(
          id: string,
          patch: UpdateModelConnectionPatch,
        ): Promise<UpdateModelConnectionOutcome> {
          const existing = current.get(id);
          if (existing === undefined) return Promise.resolve({ kind: 'not-found' });
          const connection = { ...existing, ...patch, updatedAt: new Date() };
          current.set(id, connection);
          return Promise.resolve({ kind: 'updated', connection });
        },
        delete(id: string): Promise<DeleteModelConnectionOutcome> {
          const connection = current.get(id);
          if (connection === undefined) return Promise.resolve({ kind: 'not-found' });
          current.delete(id);
          return Promise.resolve({
            kind: 'deleted',
            connection,
            referencedBy: options.referencedByOnDelete ?? [],
          });
        },
      };
    },
  };
}

function harness(options: Parameters<typeof fakeRepositoryProvider>[0] = {}) {
  const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_ID, slug: 'w' }]);
  const secrets = createInMemorySecretsService();
  const repositories = fakeRepositoryProvider(options);
  const models = createRepositoryModelsStoreProvider({ repositories, scopes, secrets });
  return { store: models.forWorkspace(WORKSPACE_ID), scopes, secrets };
}

describe('create — issue #126 "cannot leave an untracked credential"', () => {
  it('compensates by deleting the just-written secret when the connection insert throws', async () => {
    const { store, scopes, secrets } = harness({ failCreate: 'throw' });
    await expect(
      store.create({ name: 'x', provider: 'anthropic', apiKey: 'sk-x', config: {} }),
    ).rejects.toThrow(/simulated connection-insert failure/);

    const reconciled = await store.reconcileOrphanedCredentials();
    expect(reconciled.orphanedSecretNames).toEqual([]);
    const scope = await scopes.forWorkspaceId(WORKSPACE_ID);
    expect(scope).not.toBeNull();
    expect(await secrets.list(scope!)).toEqual([]);
  });

  it('compensates the same way when the connection insert resolves name-conflict', async () => {
    const { store, scopes, secrets } = harness({ failCreate: 'name-conflict' });
    const outcome = await store.create({
      name: 'x',
      provider: 'anthropic',
      apiKey: 'sk-x',
      config: {},
    });
    expect(outcome.kind).toBe('name-conflict');

    const reconciled = await store.reconcileOrphanedCredentials();
    expect(reconciled.orphanedSecretNames).toEqual([]);
    const scope = await scopes.forWorkspaceId(WORKSPACE_ID);
    expect(await secrets.list(scope!)).toEqual([]);
  });

  it('never inserts a connection row when the secret write itself fails', async () => {
    // A `SecretsService` that always reports the sort of refusal `SecretsService.create` can
    // legitimately return without throwing: a name conflict. `store.ts` treats any non-`created`
    // outcome the same way — it never calls the repository at all.
    const failingSecrets: SecretsService = {
      list: () => Promise.resolve([]),
      create: (_scope, input) => Promise.resolve({ kind: 'name-conflict', name: input.name }),
      replace: () => Promise.reject(new Error('not used')),
      delete: () => Promise.reject(new Error('not used')),
      resolveByName: () => Promise.resolve(null),
      resolveById: () => Promise.resolve(null),
      close: () => Promise.resolve(),
    };
    const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_ID, slug: 'w' }]);
    const repositories = fakeRepositoryProvider();
    const models = createRepositoryModelsStoreProvider({
      repositories,
      scopes,
      secrets: failingSecrets,
    });
    const brokenStore = models.forWorkspace(WORKSPACE_ID);
    await expect(
      brokenStore.create({ name: 'x', provider: 'anthropic', apiKey: 'sk-x', config: {} }),
    ).rejects.toThrow(/refused/);
    const stillEmpty = await brokenStore.list();
    expect(stillEmpty).toEqual([]);
  });
});

describe('delete — removes the owned secret and passes referencedBy through unchanged', () => {
  it("removes the connection's secret and leaves reconciliation clean", async () => {
    const { store } = harness();
    const created = await store.create({
      name: 'x',
      provider: 'anthropic',
      apiKey: 'sk-x',
      config: {},
    });
    if (created.kind !== 'created') throw new Error('fixture setup failed');
    const id = created.connection.id;

    const deleted = await store.delete(id);
    expect(deleted).toEqual({ kind: 'deleted', referencedBy: [] });
    expect(await store.resolve(id)).toBeNull();
    expect((await store.reconcileOrphanedCredentials()).orphanedSecretNames).toEqual([]);
  });

  it('reports the agents the repository found referencing the connection', async () => {
    const { store } = harness({
      referencedByOnDelete: [{ agentId: 'a1', agentName: 'Support Agent' }],
    });
    const created = await store.create({
      name: 'x',
      provider: 'anthropic',
      apiKey: 'sk-x',
      config: {},
    });
    if (created.kind !== 'created') throw new Error('fixture setup failed');
    const deleted = await store.delete(created.connection.id);
    expect(deleted).toEqual({
      kind: 'deleted',
      referencedBy: [{ agentId: 'a1', agentName: 'Support Agent' }],
    });
  });

  it('is a no-op reporting not-found for an id that was already deleted', async () => {
    const { store } = harness();
    const created = await store.create({
      name: 'x',
      provider: 'anthropic',
      apiKey: 'sk-x',
      config: {},
    });
    if (created.kind !== 'created') throw new Error('fixture setup failed');
    await store.delete(created.connection.id);
    await expect(store.delete(created.connection.id)).resolves.toEqual({ kind: 'not-found' });
  });
});

describe("reconcileOrphanedCredentials — issue #126's migration/reconciliation path", () => {
  it('reports a secret named MODEL_CONNECTION_* with no connection row, and nothing else', async () => {
    const { store, scopes, secrets } = harness();
    const scope = await scopes.forWorkspaceId(WORKSPACE_ID);
    expect(scope).not.toBeNull();
    await secrets.create(scope!, {
      name: modelConnectionSecretName('44444444-4444-4444-8444-444444444444'),
      value: Buffer.from('orphan', 'utf8'),
    });
    await secrets.create(scope!, { name: 'UNRELATED_SECRET', value: Buffer.from('x', 'utf8') });

    const reconciled = await store.reconcileOrphanedCredentials();
    expect(reconciled.orphanedSecretNames).toEqual([
      modelConnectionSecretName('44444444-4444-4444-8444-444444444444'),
    ]);
  });

  it('reports nothing once every MODEL_CONNECTION_* secret is owned by a connection row', async () => {
    const { store } = harness();
    const created = await store.create({
      name: 'x',
      provider: 'anthropic',
      apiKey: 'sk-x',
      config: {},
    });
    if (created.kind !== 'created') throw new Error('fixture setup failed');
    expect((await store.reconcileOrphanedCredentials()).orphanedSecretNames).toEqual([]);
  });
});

describe('replaceCredential — rotation is idempotent under the same value', () => {
  it('rotating twice with the identical key never creates a second secret', async () => {
    const { store, scopes, secrets } = harness();
    const created = await store.create({
      name: 'x',
      provider: 'anthropic',
      apiKey: 'sk-original',
      config: {},
    });
    if (created.kind !== 'created') throw new Error('fixture setup failed');
    const id = created.connection.id;
    const scope = await scopes.forWorkspaceId(WORKSPACE_ID);
    expect(scope).not.toBeNull();

    expect(await store.replaceCredential(id, 'sk-rotated')).toBe(true);
    expect(await store.replaceCredential(id, 'sk-rotated')).toBe(true);

    const secretRows = await secrets.list(scope!);
    expect(secretRows).toHaveLength(1);
    const resolved = await store.resolve(id);
    expect(resolved?.credential).toBe('sk-rotated');
  });

  it('reports false, never throwing, for a connection that does not exist', async () => {
    const { store } = harness();
    expect(await store.replaceCredential('99999999-9999-4999-8999-999999999999', 'sk-x')).toBe(
      false,
    );
  });
});

describe('writeCredential — repairs a connection whose secret is gone (issue #415)', () => {
  it('writes a fresh secret under the same connection id, then rotates it like replaceCredential', async () => {
    const { store, scopes, secrets } = harness();
    const created = await store.create({
      name: 'x',
      provider: 'anthropic',
      apiKey: 'sk-original',
      config: {},
    });
    if (created.kind !== 'created') throw new Error('fixture setup failed');
    const id = created.connection.id;
    const scope = await scopes.forWorkspaceId(WORKSPACE_ID);
    if (scope === null) throw new Error('fixture scope');
    const [secret] = await secrets.list(scope);
    if (secret === undefined) throw new Error('fixture secret');
    await secrets.delete(scope, secret.id);
    expect(await store.resolve(id)).toBeNull();
    expect(await store.replaceCredential(id, 'sk-repaired')).toBe(false);

    expect(await store.writeCredential(id, 'sk-repaired')).toBe(true);
    expect((await store.resolve(id))?.credential).toBe('sk-repaired');
    expect(await store.writeCredential(id, 'sk-rotated')).toBe(true);
    expect((await store.resolve(id))?.credential).toBe('sk-rotated');
    expect(await secrets.list(scope)).toHaveLength(1);
    expect(await store.writeCredential('99999999-9999-4999-8999-999999999999', 'sk-x')).toBe(false);
  });
});
