import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakePerson, memoryStoreOf } from '@indx-workspace/app/testing';

import resource from '../resources/ticket_comment.ts';

const record = {
  ticket: '00000000-0000-4000-8000-000000000001',
  body: [{ type: 'paragraph', text: 'Example' }],
  internal: true,
};

test('a member creates a ticket_comment and lists it', async () => {
  const store = memoryStoreOf(resource);
  const member = fakePerson({ role: 'builder' });

  const created = await store.create(member, record);
  const page = await store.list(member, {});

  assert.deepEqual(
    page.items.map((row) => row.id),
    [created.id],
  );
});

test('a builder may not delete a ticket_comment: delete is role:admin', async () => {
  const store = memoryStoreOf(resource);
  const builder = fakePerson({ role: 'builder' });
  const created = await store.create(builder, record);

  await assert.rejects(store.delete(builder, created.id), { code: 'forbidden' });
});
