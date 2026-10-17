import { describe, expect, it } from 'vitest';

import { listDiscoveredModels, updateModelConnection } from './handlers';
import { createInMemoryModelsStoreProvider } from './memory-store';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

describe('listDiscoveredModels', () => {
  it('names why a connection is unavailable, so a client picks the hint by kind (#690)', async () => {
    const store = createInMemoryModelsStoreProvider([WORKSPACE_ID]).forWorkspace(WORKSPACE_ID);
    const outcome = await store.create({
      name: 'default',
      provider: 'anthropic',
      apiKey: 'sk-ant-never-returned',
      config: {},
    });
    expect(outcome.kind).toBe('created');
    const kinds = [
      { kind: 'credential-rejected', status: 401 },
      { kind: 'connection-failed' },
    ] as const;
    for (const failure of kinds) {
      const result = await listDiscoveredModels(store, () =>
        Promise.resolve({ ok: false, reason: 'down', failure }),
      );
      expect(result.body).toMatchObject({
        models: [],
        unavailable: [{ connectionName: 'default', reason: 'down', ...failure }],
      });
      expect(JSON.stringify(result.body)).not.toContain('sk-ant-never-returned');
    }
  });
});

describe('updateModelConnection', () => {
  it('refuses to send the saved key to a new baseUrl unless a new apiKey comes with it (ADR-0077 D5)', async () => {
    const store = createInMemoryModelsStoreProvider([WORKSPACE_ID]).forWorkspace(WORKSPACE_ID);
    const outcome = await store.create({
      name: 'gateway',
      provider: 'openai-compatible',
      apiKey: 'sk-owner',
      config: { baseUrl: 'http://127.0.0.1:9/v1' },
    });
    if (outcome.kind !== 'created') throw new Error('fixture connection was not created');
    const id = outcome.connection.id;
    const retarget = { config: { baseUrl: 'http://127.0.0.2:9/v1' } };

    const refused = await updateModelConnection(store, id, retarget);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: 'credential_required_on_retarget' } });
    expect((await store.resolve(id))?.connection.config.baseUrl).toBe('http://127.0.0.1:9/v1');

    const renamed = await updateModelConnection(store, id, { name: 'renamed' });
    expect(renamed.status).toBe(200);

    const moved = await updateModelConnection(store, id, { ...retarget, apiKey: 'sk-new' });
    expect(moved.status).toBe(200);
    const resolved = await store.resolve(id);
    expect(resolved?.connection.config.baseUrl).toBe('http://127.0.0.2:9/v1');
    expect(resolved?.credential).toBe('sk-new');
  });
});
