import { type TriggerResource } from '@indx-workspace/contracts/triggers';
import { describe, expect, it } from 'vitest';

import { GET as GET_ONE, PATCH } from '../../app/api/triggers/[id]/route';
import { GET as LIST } from '../../app/api/triggers/route';

import {
  adminCaller,
  builderCaller,
  installTriggerFixture,
  ownerCaller,
  viewerCaller,
} from './triggers.fixture.test-support';

const fixture = installTriggerFixture();
const { agentOf, createBody, createAs, seed } = fixture;

const sheet = { type: 'object', properties: { verdict: { type: 'string' } } };
const patchSchema = (id: string, body: unknown) =>
  fixture.harness.call(PATCH, {
    method: 'PATCH',
    path: `/api/triggers/${id}`,
    as: builderCaller,
    id,
    body,
  });

const patchSubject = (caller: { email: string }, id: string, body: unknown) =>
  fixture.harness.call(PATCH, {
    method: 'PATCH',
    path: `/api/triggers/${id}`,
    as: caller,
    id,
    body,
  });

/** A Builder's own trigger that an Admin gave a subject. */
async function builderTriggerWithSubject(): Promise<TriggerResource> {
  const { trigger } = await seed(builderCaller, { name: 'planned' });
  expect((await patchSubject(adminCaller, trigger.id, { subject: 'planner' })).status).toBe(200);
  return trigger;
}

const refusedForSubject = (response: { status: number; body: unknown }) => {
  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ error: { code: 'trigger_subject_not_allowed' } });
};

describe('output schema (ADR-0154)', () => {
  it('stores the schema on create and shows it on create, get and list', async () => {
    const created = await seed(builderCaller, { outputSchema: sheet });
    expect(created.trigger.outputSchema).toEqual(sheet);
    const one = await fixture.harness.call(GET_ONE, {
      method: 'GET',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
    });
    expect(one.body).toMatchObject({ trigger: { outputSchema: sheet } });
    const list = await fixture.harness.call(LIST, {
      method: 'GET',
      path: '/api/triggers',
      as: builderCaller,
    });
    expect(list.body).toMatchObject({ triggers: [{ outputSchema: sheet }] });
    expect((await seed(builderCaller, { name: 'plain' })).trigger.outputSchema).toBeNull();
  });

  it.each([
    ['root_type', { type: 'array' }],
    ['ref', { type: 'object', properties: { a: { $ref: 'https://example.com/a.json' } } }],
  ])('answers 400 invalid_field naming the %s limit on create and patch', async (limit, schema) => {
    const created = await createAs(
      builderCaller,
      createBody(agentOf(builderCaller), { outputSchema: schema }),
    );
    expect(created.status).toBe(400);
    expect(created.body).toMatchObject({ error: { code: 'invalid_field' } });
    expect(JSON.stringify(created.body)).toContain(limit);
    expect(fixture.state.rows.size).toBe(0);

    const seeded = await seed(builderCaller, { outputSchema: sheet });
    const patched = await patchSchema(seeded.trigger.id, { outputSchema: schema });
    expect(patched.status).toBe(400);
    expect(patched.body).toMatchObject({ error: { code: 'invalid_field' } });
    expect(fixture.state.rows.get(seeded.trigger.id)?.outputSchema).toEqual(sheet);
  });

  it('replaces the schema on patch, keeps it when omitted and clears it with null', async () => {
    const { trigger } = await seed(builderCaller, { outputSchema: sheet });
    const next = { type: 'object', properties: { score: { type: 'number' } } };
    expect((await patchSchema(trigger.id, { outputSchema: next })).body).toMatchObject({
      trigger: { outputSchema: next },
    });
    expect((await patchSchema(trigger.id, { enabled: true })).body).toMatchObject({
      trigger: { outputSchema: next },
    });
    expect((await patchSchema(trigger.id, { outputSchema: null })).body).toMatchObject({
      trigger: { outputSchema: null },
    });
  });
});

describe('run subject (ADR-0156)', () => {
  it('stores the subject on create and shows it on create, get and list', async () => {
    const created = await seed(adminCaller, { subject: 'planner' });
    expect(created.trigger.subject).toBe('planner');
    const one = await fixture.harness.call(GET_ONE, {
      method: 'GET',
      path: `/api/triggers/${created.trigger.id}`,
      as: adminCaller,
      id: created.trigger.id,
    });
    expect(one.body).toMatchObject({ trigger: { subject: 'planner' } });
    const list = await fixture.harness.call(LIST, {
      method: 'GET',
      path: '/api/triggers',
      as: adminCaller,
    });
    expect(list.body).toMatchObject({ triggers: [{ subject: 'planner' }] });
    expect((await seed(adminCaller, { name: 'plain' })).trigger.subject).toBeNull();
  });

  it('lets an admin and an owner replace the subject, keep it when omitted, and clear it with null', async () => {
    const { trigger } = await seed(adminCaller, { subject: 'planner' });
    expect(
      (await patchSubject(adminCaller, trigger.id, { subject: 'organiser' })).body,
    ).toMatchObject({
      trigger: { subject: 'organiser' },
    });
    expect((await patchSubject(ownerCaller, trigger.id, { enabled: true })).body).toMatchObject({
      trigger: { subject: 'organiser' },
    });
    expect((await patchSubject(adminCaller, trigger.id, { subject: null })).body).toMatchObject({
      trigger: { subject: null },
    });
  });
});

describe('run subject: restricted changes (ADR-0156)', () => {
  it('refuses a builder creating a trigger with a subject, storing nothing', async () => {
    refusedForSubject(
      await createAs(builderCaller, createBody(agentOf(builderCaller), { subject: 'admin' })),
    );
    expect(fixture.state.rows.size).toBe(0);
  });

  it('refuses a builder setting or changing the subject of their own trigger', async () => {
    const plain = await seed(builderCaller);
    refusedForSubject(await patchSubject(builderCaller, plain.trigger.id, { subject: 'admin' }));
    expect(fixture.state.rows.get(plain.trigger.id)?.subject).toBeNull();

    const trigger = await builderTriggerWithSubject();
    refusedForSubject(await patchSubject(builderCaller, trigger.id, { subject: 'colleague' }));
    expect(fixture.state.rows.get(trigger.id)?.subject).toBe('planner');
  });

  it('refuses a builder any other change to their trigger while it has a subject', async () => {
    const trigger = await builderTriggerWithSubject();
    for (const body of [
      { prompt: 'Do something else: {{body}}' },
      { name: 'renamed' },
      { enabled: false },
      { outputSchema: { type: 'object' } },
    ]) {
      refusedForSubject(await patchSubject(builderCaller, trigger.id, body));
    }
    expect(fixture.state.rows.get(trigger.id)).toMatchObject({
      name: trigger.name,
      promptTemplate: 'Handle this: {{body}}',
      enabled: true,
      subject: 'planner',
    });
  });
});

describe('run subject: clearing and validation (ADR-0156)', () => {
  it('lets a builder clear the subject, and then edit the trigger as before', async () => {
    const trigger = await builderTriggerWithSubject();
    expect(
      (await patchSubject(builderCaller, trigger.id, { subject: null, prompt: 'Next: {{body}}' }))
        .body,
    ).toMatchObject({ trigger: { subject: null, prompt: 'Next: {{body}}' } });
    expect((await patchSubject(builderCaller, trigger.id, { enabled: false })).status).toBe(200);
  });

  it('answers 400 to an empty or oversized subject on create and patch, changing nothing', async () => {
    for (const subject of ['', 'a'.repeat(257)]) {
      const created = await createAs(adminCaller, createBody(agentOf(adminCaller), { subject }));
      expect(created.status).toBe(400);
    }
    expect(fixture.state.rows.size).toBe(0);
    const seeded = await seed(adminCaller, { subject: 'planner' });
    expect((await patchSubject(adminCaller, seeded.trigger.id, { subject: '' })).status).toBe(400);
    expect(fixture.state.rows.get(seeded.trigger.id)?.subject).toBe('planner');
  });

  it('refuses a viewer setting a subject on a trigger they cannot manage', async () => {
    const created = await createAs(
      viewerCaller,
      createBody(agentOf(builderCaller), { subject: 'planner' }),
    );
    expect(created.status).toBe(403);
    expect(fixture.state.rows.size).toBe(0);
  });
});
