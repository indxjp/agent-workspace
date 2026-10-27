/**
 * `store.update` with a `credential` on a connector that already has one (ADR-0077 D5, issue #240
 * review round 2): the destination fields and the credential reference change in ONE row update,
 * so no partial failure can leave the connector pointing at a new destination with its old
 * credential. Runs against in-memory doubles, so every failure point can be injected.
 */
import { captureLog } from '../telemetry/capture-log';
import type {
  McpServerRecord,
  McpServerRepository,
  McpServerRepositoryProvider,
  UpdateMcpServerInput,
  UpdateMcpServerOutcome,
} from '@agent-workspace/core/db';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createInMemorySecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRepositoryConnectorsStoreProvider } from './store';

const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const CONNECTOR_ID = '55555555-5555-4555-8555-555555555555';
const OLD_URL = 'https://mcp.example.test/sse';
const NEW_URL = 'https://elsewhere.example.test/sse';
const NEW_CREDENTIAL = 'sk-NEW-CREDENTIAL-DO-NOT-LOG';

type UpdateFailure = 'throw' | 'name-conflict' | null;

/** One connector row whose `update` can be told to throw or refuse. */
function fakeRepositoryProvider(
  initial: McpServerRecord,
  failUpdate: UpdateFailure,
): McpServerRepositoryProvider & { current(): McpServerRecord } {
  let row = initial;
  const repository: McpServerRepository = {
    list: () => Promise.resolve([row]),
    get: (id) => Promise.resolve(id === row.id ? row : null),
    create: () => Promise.reject(new Error('not used')),
    delete: () => Promise.reject(new Error('not used')),
    listToolConnectors: () => Promise.reject(new Error('not used')),
    getToolConnector: () => Promise.reject(new Error('not used')),
    createToolConnector: () => Promise.reject(new Error('not used')),
    updateToolConnector: () => Promise.reject(new Error('not used')),
    getOpenApiDocument: () => Promise.reject(new Error('not used')),
    update: (id: string, input: UpdateMcpServerInput): Promise<UpdateMcpServerOutcome> => {
      if (failUpdate === 'throw') return Promise.reject(new Error('simulated row-update failure'));
      if (failUpdate === 'name-conflict') {
        return Promise.resolve({ kind: 'name-conflict', name: input.name ?? row.name });
      }
      if (id !== row.id) return Promise.resolve({ kind: 'not-found' });
      row = { ...row, ...input, updatedAt: new Date() };
      return Promise.resolve({ kind: 'updated', server: row });
    },
  };
  return { forScope: () => repository, current: () => row };
}

interface HarnessOptions {
  readonly failUpdate?: UpdateFailure;
  readonly failSecretCreate?: boolean;
  readonly failSecretDelete?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_ID, slug: 'w' }]);
  const scope = await scopes.forWorkspaceId(WORKSPACE_ID);
  if (scope === null) throw new Error('the in-memory workspace is missing');
  const inner = createInMemorySecretsService();
  const old = await inner.create(scope, { name: 'OLD_CREDENTIAL', value: Buffer.from('old') });
  if (old.kind !== 'created') throw new Error('seeding the old credential failed');
  const secrets: SecretsService = {
    ...inner,
    create: (s, input) =>
      options.failSecretCreate === true
        ? Promise.reject(new Error('simulated secrets failure'))
        : inner.create(s, input),
    delete: (s, id) =>
      options.failSecretDelete === true && id === old.secret.id
        ? Promise.reject(new Error('simulated secret-delete failure'))
        : inner.delete(s, id),
  };
  const now = new Date();
  const mcpServers = fakeRepositoryProvider(
    {
      id: CONNECTOR_ID,
      workspaceId: WORKSPACE_ID,
      name: 'docs',
      transport: 'sse',
      command: null,
      args: null,
      url: OLD_URL,
      authType: 'bearer',
      credentialSecretId: old.secret.id,
      identitySecretName: null,
      enabled: true,
      createdBy: null,
      ownerPrincipalId: '66666666-6666-4666-8666-666666666666',
      createdAt: now,
      updatedAt: now,
    },
    options.failUpdate ?? null,
  );
  const store = createRepositoryConnectorsStoreProvider({ mcpServers, secrets, scopes });
  return {
    store: store.forWorkspace(WORKSPACE_ID),
    row: () => mcpServers.current(),
    secretIds: async () => (await inner.list(scope)).map((secret) => secret.id),
    oldSecretId: old.secret.id,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('store.update — a retarget that carries a credential is failure-atomic (ADR-0077 D5)', () => {
  it('never moves the destination when sealing the new credential fails', async () => {
    const h = await harness({ failSecretCreate: true });
    await expect(
      h.store.update(CONNECTOR_ID, { url: NEW_URL, credential: NEW_CREDENTIAL }),
    ).rejects.toThrow(/simulated secrets failure/);
    expect(h.row()).toMatchObject({ url: OLD_URL, credentialSecretId: h.oldSecretId });
  });

  it('deletes the fresh secret and leaves the connector unchanged when the row update throws', async () => {
    const h = await harness({ failUpdate: 'throw' });
    await expect(
      h.store.update(CONNECTOR_ID, { url: NEW_URL, credential: NEW_CREDENTIAL }),
    ).rejects.toThrow(/simulated row-update failure/);
    expect(h.row()).toMatchObject({ url: OLD_URL, credentialSecretId: h.oldSecretId });
    expect(await h.secretIds()).toEqual([h.oldSecretId]);
  });

  it('deletes the fresh secret when the row update does not return updated', async () => {
    const h = await harness({ failUpdate: 'name-conflict' });
    const outcome = await h.store.update(CONNECTOR_ID, {
      name: 'taken',
      url: NEW_URL,
      credential: NEW_CREDENTIAL,
    });
    expect(outcome.kind).toBe('name-conflict');
    expect(h.row()).toMatchObject({ url: OLD_URL, credentialSecretId: h.oldSecretId });
    expect(await h.secretIds()).toEqual([h.oldSecretId]);
  });

  it('swaps the destination and the secret together, then deletes the old secret', async () => {
    const h = await harness();
    const outcome = await h.store.update(CONNECTOR_ID, {
      url: NEW_URL,
      credential: NEW_CREDENTIAL,
    });
    expect(outcome.kind).toBe('updated');
    const row = h.row();
    expect(row.url).toBe(NEW_URL);
    expect(row.credentialSecretId).not.toBe(h.oldSecretId);
    expect(await h.secretIds()).toEqual([row.credentialSecretId]);
  });

  it('keeps the swapped connector and logs the orphan when deleting the old secret fails', async () => {
    const logged = captureLog();
    const h = await harness({ failSecretDelete: true });
    const outcome = await h.store.update(CONNECTOR_ID, {
      url: NEW_URL,
      credential: NEW_CREDENTIAL,
    });
    expect(outcome.kind).toBe('updated');
    expect(h.row().url).toBe(NEW_URL);
    expect(h.row().credentialSecretId).not.toBe(h.oldSecretId);
    expect(logged.text()).toContain(h.oldSecretId);
    expect(logged.text()).not.toContain(NEW_CREDENTIAL);
  });
});
