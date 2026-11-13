import { randomUUID } from 'node:crypto';

import { FEATURE_IDS } from '@indx-workspace/contracts/features';
import { type TriggerResource } from '@indx-workspace/contracts/triggers';
import { describe, expect, it } from 'vitest';

import { DELETE, GET as GET_ONE, PATCH } from '../../app/api/triggers/[id]/route';
import { POST as ROTATE } from '../../app/api/triggers/[id]/secret/route';
import { POST as CREATE, GET as LIST } from '../../app/api/triggers/route';
import { installTestDomains } from '../application-context-fixtures';
import { configureFeatureSwitches } from '../features/runtime';
import { conferredBy } from '../rbac/core/conferral';
import { TEST_WORKSPACE_ID } from '../rbac/testing';

import {
  builderCaller,
  installTriggerFixture,
  otherBuilderCaller,
  ownerCaller,
  viewerCaller,
  type Created,
} from './triggers.fixture.test-support';

const fixture = installTriggerFixture();
const { agentOf, createBody, createAs, seed, fireRaw, jsonOf } = fixture;

describe('not configured', () => {
  it('answers the named 503 on management and fire while triggers are disabled (no run runtime yet)', async () => {
    const created = await seed(builderCaller);
    installTestDomains({ triggers: { kind: 'disabled' } });
    const list = await fixture.harness.call(LIST, {
      method: 'GET',
      path: '/api/triggers',
      as: ownerCaller,
    });
    expect(list.status).toBe(503);
    expect(list.body).toMatchObject({ error: { code: 'triggers_runtime_not_configured' } });
    const fired = await fireRaw(created.trigger.id, created.secret);
    expect(fired.status).toBe(503);
    expect(jsonOf(fired.text)).toMatchObject({ error: { code: 'triggers_not_configured' } });
    expect(fixture.state.launches).toHaveLength(0);
  });
});

describe('management: the role matrix', () => {
  it('refuses a viewer', async () => {
    const response = await createAs(viewerCaller, createBody(agentOf(ownerCaller)));
    expect(response.status).toBe(403);
    expect(fixture.state.rows.size).toBe(0);
  });

  it('refuses a viewer on list and a builder on a trigger that is not theirs', async () => {
    const created = await seed(ownerCaller);
    const list = await fixture.harness.call(LIST, {
      method: 'GET',
      path: '/api/triggers',
      as: viewerCaller,
    });
    expect(list.status).toBe(403);
    const patch = await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
      body: { enabled: false },
    });
    expect(patch.status).toBe(403);
  });

  it('creates a trigger for a builder, owned by them, and shows the secret once', async () => {
    const created = await seed(builderCaller);
    expect(created.trigger.ownerPrincipalId).toBe(fixture.principalIds[builderCaller.email]);
    expect(created.trigger).toMatchObject({ hasSecret: true, hasZoomSecretToken: false });
    expect(created.secret).toMatch(/^awcs_live_/u);
    expect(created.firePath).toBe(`/api/triggers/${created.trigger.id}/fire/${created.secret}`);

    const got = await fixture.harness.call(GET_ONE, {
      method: 'GET',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
    });
    expect(got.status).toBe(200);
    expect(got.text).not.toContain(created.secret);
    const list = await fixture.harness.call(LIST, {
      method: 'GET',
      path: '/api/triggers',
      as: builderCaller,
    });
    expect(list.text).not.toContain(created.secret);
  });

  it('refuses an agent the caller may not run, and one that does not exist', async () => {
    const foreign = await createAs(builderCaller, createBody(agentOf(otherBuilderCaller)));
    expect(foreign.status).toBe(403);
    expect(foreign.body).toMatchObject({ error: { code: 'trigger_agent_not_runnable' } });
    const absent = await createAs(builderCaller, createBody(randomUUID()));
    expect(absent.status).toBe(403);
  });

  it('answers 409 to a duplicate name', async () => {
    const created = await seed(builderCaller);
    const again = await createAs(builderCaller, createBody(agentOf(builderCaller)));
    expect(again.status).toBe(409);
    expect(fixture.state.rows.size).toBe(1);
    expect(created.trigger.name).toBe('inbox');
  });
});

describe('management: schedules', () => {
  const scheduleBody = (overrides: Record<string, unknown> = {}) => ({
    kind: 'schedule',
    name: 'nightly',
    agentId: agentOf(builderCaller),
    prompt: 'go',
    cron: '0 3 * * *',
    timezone: 'Asia/Tokyo',
    ...overrides,
  });

  it('creates a schedule trigger with no secret', async () => {
    const created = await createAs(builderCaller, scheduleBody());
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      trigger: expect.objectContaining({
        kind: 'schedule',
        cron: '0 3 * * *',
        timezone: 'Asia/Tokyo',
        hasSecret: false,
        enabled: true,
      }) as unknown,
    });
    expect(fixture.state.hashes.size).toBe(0);
  });

  it.each([
    ['six fields', { cron: '0 0 3 * * *' }],
    ['an out-of-range minute', { cron: '61 * * * *' }],
    ['a date that never exists', { cron: '0 0 31 2 *' }],
    ['an unknown timezone', { timezone: 'Mars/Olympus' }],
    ['a {{body}} prompt', { prompt: 'summarise {{body}}' }],
  ])('answers 400 to a schedule with %s and stores nothing', async (_name, overrides) => {
    const response = await createAs(builderCaller, scheduleBody(overrides));
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'invalid_field' } });
    expect(fixture.state.rows.size).toBe(0);
  });

  it('answers 400 to a {{body}} prompt patched onto a schedule and keeps the old prompt', async () => {
    const created = (await createAs(builderCaller, scheduleBody())).body as {
      trigger: { id: string };
    };
    const response = await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
      body: { prompt: 'summarise {{body}}' },
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'invalid_field' } });
    expect(fixture.state.rows.get(created.trigger.id)?.promptTemplate).toBe('go');
  });

  it('refuses a schedule for an agent the member may not run', async () => {
    const response = await createAs(
      builderCaller,
      scheduleBody({ agentId: agentOf(otherBuilderCaller) }),
    );
    expect(response.status).toBe(403);
    expect(fixture.state.rows.size).toBe(0);
  });
});

describe('management: validation and secrets', () => {
  it('rejects a malformed body with 400', async () => {
    const response = await createAs(builderCaller, { kind: 'webhook', name: '' });
    expect(response.status).toBe(400);
  });

  it.each(['owner', 'admin', 'builder'] as const)(
    'refuses a %s API key on create',
    async (role) => {
      const key = await fixture.harness.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
        name: `${role}-key`,
        role: conferredBy('owner', role, 'test'),
        expiresAt: null,
      });
      if (key.kind !== 'created') throw new Error(key.kind);
      const response = await fixture.harness.call(CREATE, {
        method: 'POST',
        path: '/api/triggers',
        as: null,
        bearer: key.presented,
        body: createBody(agentOf(ownerCaller)),
      });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'api_key_not_permitted' } });
      expect(fixture.state.rows.size).toBe(0);
    },
  );

  it('stores a Zoom secret token write-only and clears it with null', async () => {
    const created = await seed(builderCaller, { zoomSecretToken: 'zoom-app-secret' });
    expect(created.trigger.hasZoomSecretToken).toBe(true);
    expect(JSON.stringify(created)).not.toContain('zoom-app-secret');
    const cleared = await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
      body: { zoomSecretToken: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ trigger: { hasZoomSecretToken: false } });
    expect(fixture.state.zoomTokens.size).toBe(0);
  });

  it('answers the same 404 for an id that is absent and one that is not an id', async () => {
    for (const id of [randomUUID(), 'not-an-id']) {
      const response = await fixture.harness.call(GET_ONE, {
        method: 'GET',
        path: `/api/triggers/${id}`,
        as: ownerCaller,
        id,
      });
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: { code: 'trigger_not_found' } });
    }
  });

  it('removes a trigger, its Zoom token, and answers 404 afterwards', async () => {
    const created = await seed(builderCaller, { zoomSecretToken: 'zoom-app-secret' });
    const removed = await fixture.harness.call(DELETE, {
      method: 'DELETE',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
    });
    expect(removed.status).toBe(200);
    expect(fixture.state.rows.size).toBe(0);
    expect(fixture.state.zoomTokens.size).toBe(0);
    expect((await fireRaw(created.trigger.id, created.secret)).status).toBe(404);
  });

  it('rotates the secret: the old one stops working at once', async () => {
    const created = await seed(builderCaller);
    const rotated = await fixture.harness.call(ROTATE, {
      method: 'POST',
      path: `/api/triggers/${created.trigger.id}/secret`,
      as: builderCaller,
      id: created.trigger.id,
    });
    expect(rotated.status).toBe(201);
    const next = rotated.body as Created;
    expect(next.secret).not.toBe(created.secret);
    expect((await fireRaw(created.trigger.id, created.secret)).status).toBe(404);
    expect((await fireRaw(created.trigger.id, next.secret, { body: 'x' })).status).toBe(202);
  });
});

describe('the fire route and a workspace with triggers switched off (ADR-0160 D7)', () => {
  const triggersOff = (): void =>
    configureFeatureSwitches({
      enabledFor: () => Promise.resolve(FEATURE_IDS.filter((id) => id !== 'triggers')),
    });

  it('answers 404 feature_disabled once the secret matches, and starts nothing', async () => {
    const created = await seed(builderCaller);
    triggersOff();
    const fired = await fireRaw(created.trigger.id, created.secret, {
      body: 'hello',
      headers: { 'idempotency-key': 'off-1' },
    });
    expect(fired.status).toBe(404);
    expect(jsonOf(fired.text)).toMatchObject({
      error: { code: 'feature_disabled', details: ['triggers'] },
    });
    expect(fixture.state.deliveries.size).toBe(0);
    expect(fixture.state.launches).toHaveLength(0);
  });

  it('keeps the uniform trigger_not_found for a wrong secret, an unknown id and a disabled trigger', async () => {
    const created = await seed(builderCaller);
    await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
      body: { enabled: false },
    });
    triggersOff();
    const answers = [
      await fireRaw(created.trigger.id, 'awcs_live_wrong'),
      await fireRaw(randomUUID(), created.secret),
      await fireRaw(created.trigger.id, created.secret),
    ];
    for (const miss of answers) {
      expect(miss.status).toBe(404);
      expect(jsonOf(miss.text)).toMatchObject({ error: { code: 'trigger_not_found' } });
    }
  });

  it('keeps trigger_not_found for a schedule trigger, which has no fire route', async () => {
    const created = await createAs(builderCaller, {
      kind: 'schedule',
      name: 'nightly',
      agentId: agentOf(builderCaller),
      prompt: 'Run the nightly report',
      cron: '0 3 * * *',
      timezone: 'UTC',
    });
    expect(created.status).toBe(201);
    const { trigger } = created.body as { trigger: TriggerResource };
    triggersOff();
    const fired = await fireRaw(trigger.id, 'awcs_live_whatever');
    expect(fired.status).toBe(404);
    expect(jsonOf(fired.text)).toMatchObject({ error: { code: 'trigger_not_found' } });
  });
});
