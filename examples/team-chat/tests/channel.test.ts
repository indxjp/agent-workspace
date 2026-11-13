import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakePerson, memoryStoreOf } from '@indx-workspace/app/testing';

import resource from '../resources/channel.ts';

const record = {
  name: 'example',
  kind: 'public',
};

test('a member creates a channel and lists it', async () => {
  const store = memoryStoreOf(resource);
  const member = fakePerson({ role: 'builder' });

  const created = await store.create(member, record);
  const page = await store.list(member, {});

  assert.deepEqual(
    page.items.map((row) => row.id),
    [created.id],
  );
});

test('a builder may not delete a channel: delete is role:admin', async () => {
  const store = memoryStoreOf(resource);
  const builder = fakePerson({ role: 'builder' });
  const created = await store.create(builder, record);

  await assert.rejects(store.delete(builder, created.id), { code: 'forbidden' });
});
