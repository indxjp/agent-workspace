import { describe, expect, it } from 'vitest';

import { text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import { describeResourceStoreConformance } from './conformance.js';
import { fakePerson, FAKE_WORKSPACE_ID } from './fake-person.js';
import { memoryStoreOf } from './memory-store.js';

describeResourceStoreConformance(
  'memoryStoreOf conforms to the ResourceStore port',
  (resource, options) => {
    const store = memoryStoreOf(resource, {
      now: options.now,
      ...(options.afterWrite === undefined ? {} : { afterWrite: options.afterWrite }),
      ...(options.onCommitted === undefined ? {} : { onCommitted: options.onCommitted }),
    });
    return { store, auditEvents: () => Promise.resolve(store.auditEvents()) };
  },
  { describe, it },
);

const notes = defineResource({
  name: 'note',
  fields: { title: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
});

describe('memoryStoreOf', () => {
  it('counts every call, refused ones included', async () => {
    const store = memoryStoreOf(notes);
    const someone = fakePerson();
    const record = await store.create(someone, { title: 'one' });
    await store.list(someone);
    await expect(store.get(someone, crypto.randomUUID())).rejects.toMatchObject({
      code: 'resource_not_found',
    });
    await store.update(someone, record.id, { title: 'two' });
    await store.delete(someone, record.id);
    expect(store.calls).toEqual({ list: 1, get: 1, search: 0, create: 1, update: 1, delete: 1 });
  });

  it('returns copies, so changing a result does not change the store', async () => {
    const store = memoryStoreOf(notes);
    const someone = fakePerson();
    const record = await store.create(someone, { title: 'kept' });
    (record as { title: string }).title = 'changed';
    expect((await store.get(someone, record.id)).title).toBe('kept');
  });
});

describe('fakePerson', () => {
  it('is a builder of the fake workspace, in person, unless told otherwise', () => {
    const someone = fakePerson();
    expect(someone).toMatchObject({
      workspaceId: FAKE_WORKSPACE_ID,
      role: 'builder',
      via: 'person',
    });
    expect(someone.runId).toBeUndefined();
    expect(fakePerson({ role: null }).role).toBeNull();
    expect(fakePerson({ via: 'agent' }).runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fakePerson({ via: 'agent', runId: 'run-1' }).runId).toBe('run-1');
  });
});
