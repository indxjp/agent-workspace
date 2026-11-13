import { describe, expect, it } from 'vitest';

import { createInMemoryModelsStoreProvider } from './store';

const WORKSPACE = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';

/** What the in-memory models store does, pinned before it moves (refactoring part 08 step 2). */
describe('createInMemoryModelsStoreProvider', () => {
  it('creates, lists, resolves, renames and deletes a connection in one workspace', async () => {
    const store = createInMemoryModelsStoreProvider([WORKSPACE, OTHER]).forWorkspace(WORKSPACE);

    const created = await store.create({
      name: 'main',
      provider: 'anthropic',
      apiKey: 'sk-test',
      config: {},
    });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error('unreachable');
    const { id } = created.connection;

    expect((await store.list()).map((row) => row.name)).toEqual(['main']);
    expect((await store.resolve(id))?.credential).toBe('sk-test');

    const renamed = await store.update(id, { name: 'renamed' });
    expect(renamed.kind).toBe('updated');
    expect((await store.get(id))?.name).toBe('renamed');

    expect(await store.delete(id)).toEqual({ kind: 'deleted', referencedBy: [] });
    expect(await store.list()).toEqual([]);
    expect(await store.delete(id)).toEqual({ kind: 'not-found' });
  });

  it('refuses a duplicate name on create and on rename', async () => {
    const store = createInMemoryModelsStoreProvider([WORKSPACE]).forWorkspace(WORKSPACE);
    await store.create({ name: 'a', provider: 'anthropic', apiKey: 'k1', config: {} });
    const second = await store.create({
      name: 'b',
      provider: 'anthropic',
      apiKey: 'k2',
      config: {},
    });
    if (second.kind !== 'created') throw new Error('unreachable');

    expect(
      await store.create({ name: 'a', provider: 'anthropic', apiKey: 'k3', config: {} }),
    ).toEqual({ kind: 'name-conflict', name: 'a' });
    expect((await store.update(second.connection.id, { name: 'b' })).kind).toBe('updated');
    expect(await store.update(second.connection.id, { name: 'a' })).toEqual({
      kind: 'name-conflict',
      name: 'a',
    });
    expect(await store.update('00000000-0000-4000-8000-000000000000', { name: 'z' })).toEqual({
      kind: 'not-found',
    });
  });

  it('keeps each workspace separate and refuses an unknown workspace', async () => {
    const provider = createInMemoryModelsStoreProvider([WORKSPACE, OTHER]);
    await provider
      .forWorkspace(WORKSPACE)
      .create({ name: 'mine', provider: 'anthropic', apiKey: 'k', config: {} });

    expect(await provider.forWorkspace(OTHER).list()).toEqual([]);
    await expect(
      provider.forWorkspace('66666666-6666-4666-8666-666666666666').list(),
    ).rejects.toThrow('unknown workspace');
  });
});
